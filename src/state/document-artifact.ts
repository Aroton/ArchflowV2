import { sha256Bytes, parseGitOid } from "../contracts/canonical.js";
import {
  parseDocumentArtifact,
  type AdditionalDocumentArtifactV1,
  type DocumentArtifactV1,
} from "../contracts/durable-document.js";
import type { OutputEntry } from "../contracts/durable-primitives.js";
import { createProjectError, type ProjectError, type ProjectResult } from "../contracts/errors.js";
import type { SafeId, Sha256Digest } from "../contracts/evidence.js";
import { parseSafeInteger } from "../contracts/evidence.js";
import {
  parseTaskPathClaim,
  toRepositoryPathClaim,
  type RepositoryPathClaim,
  type TaskPathClaim,
} from "../contracts/path-claims.js";
import type { PhaseInstanceId } from "../contracts/phase-instance.js";
import { assertPlainJson } from "../contracts/plain-json.js";
import type { PipelineStep } from "../contracts/vocabulary.js";
import {
  GitInvocationError,
  hashGitBlobIdentity,
  projectErrorForGitFailure,
} from "../repository/git.js";
import type { RootBoundGitRunner } from "../repository/identity.js";
import {
  openResolved,
  resolveRepositoryPath,
  resolveTaskPath,
  type ResolvedPath,
} from "../repository/paths.js";
import { assertInternalTransactionAuthority, type TransactionAuthority } from "./authority.js";
import { deriveDeclaredSnapshotDigest } from "./snapshots.js";

export type DocumentArtifactInput = Readonly<{
  phase_instance: PhaseInstanceId;
  step: PipelineStep;
  document_path: TaskPathClaim;
  /** Additional task documents co-produced with the primary document. */
  additional_document_paths?: readonly TaskPathClaim[];
  declared_inputs: readonly Readonly<{
    input_id: SafeId;
    path: RepositoryPathClaim;
  }>[];
  input_fingerprint: Sha256Digest;
}>;

const ok = <T>(value: T): ProjectResult<T> =>
  Object.freeze({ schema_version: "1", ok: true, value });
const fail = <T>(error: ProjectError): ProjectResult<T> =>
  Object.freeze({ schema_version: "1", ok: false, error });

function ioFailure(authority: TransactionAuthority): ProjectResult<never> {
  return fail(createProjectError("IO_ERROR", {
    operation: authority.context.operation,
    attempt: authority.context.attempt,
  }));
}

async function readResolvedBytes(
  target: ResolvedPath,
  authority: TransactionAuthority,
): Promise<ProjectResult<Uint8Array>> {
  try {
    const handle = await openResolved(target.absolute, 0);
    try {
      return ok(new Uint8Array(await handle.readFile()));
    } finally {
      await handle.close();
    }
  } catch {
    return ioFailure(authority);
  }
}

async function resolveDeclaredInput(
  runner: RootBoundGitRunner,
  authority: TransactionAuthority,
  path: RepositoryPathClaim,
): Promise<ProjectResult<ResolvedPath>> {
  const prefix = `.archflow/tasks/${authority.task_id}/`;
  if (path.startsWith(prefix)) {
    let taskPath: TaskPathClaim;
    try {
      taskPath = parseTaskPathClaim(path.slice(prefix.length));
    } catch {
      return fail(createProjectError("PATH_INVALID", {
        task_id: authority.task_id,
        path_class: "repository-source",
      }));
    }
    return resolveTaskPath({
      runner,
      taskId: authority.task_id,
      claim: taskPath,
      context: authority.context,
    });
  }
  return resolveRepositoryPath({ runner, claim: path, context: authority.context });
}

/** Observes a canonical task document and constructs the exact artifact accepted by produce. */
export async function buildDocumentArtifact(
  runner: RootBoundGitRunner,
  authority: TransactionAuthority,
  input: DocumentArtifactInput,
): Promise<ProjectResult<DocumentArtifactV1>> {
  assertInternalTransactionAuthority(authority);
  assertPlainJson(input, "document artifact builder input");
  const materialized = structuredClone(input) as DocumentArtifactInput;

  const additionalPaths = [...(materialized.additional_document_paths ?? [])]
    .sort((left, right) => left < right ? -1 : left > right ? 1 : 0);
  if (
    new Set(additionalPaths).size !== additionalPaths.length ||
    additionalPaths.includes(materialized.document_path)
  ) {
    throw new TypeError("additional document paths must be unique and must not repeat the primary document");
  }

  const observeDocument = async (documentPath: TaskPathClaim): Promise<ProjectResult<Readonly<{
    document_path: TaskPathClaim;
    projection_target: RepositoryPathClaim;
    bytes: Uint8Array;
    byte_count: ReturnType<typeof parseSafeInteger>;
    content_digest: Sha256Digest;
    output: OutputEntry;
  }>>> => {
    const resolved = await resolveTaskPath({
      runner,
      taskId: authority.task_id,
      claim: documentPath,
      expectedClass: "document",
      context: authority.context,
    });
    if (!resolved.ok) return resolved;
    const read = await readResolvedBytes(resolved.value, authority);
    if (!read.ok) return read;
    const byteCount = parseSafeInteger(read.value.byteLength);
    const contentDigest = sha256Bytes(read.value);
    let identity: Awaited<ReturnType<typeof hashGitBlobIdentity>>;
    try {
      identity = await hashGitBlobIdentity(runner, read.value, resolved.value.repositoryRelative);
    } catch (error) {
      if (error instanceof GitInvocationError) {
        return fail(projectErrorForGitFailure(error, runner, authority.context));
      }
      throw error;
    }
    return ok(Object.freeze({
      document_path: documentPath,
      projection_target: resolved.value.repositoryRelative,
      bytes: read.value,
      byte_count: byteCount,
      content_digest: contentDigest,
      output: Object.freeze({
        path: resolved.value.repositoryRelative,
        path_class: "document",
        operation: "add",
        storage: "raw-payload",
        payload_bytes: byteCount,
        payload_digest: contentDigest,
        file_type: "regular",
        after: Object.freeze({
          oid: parseGitOid(identity.oid),
          mode: "100644",
          size_bytes: parseSafeInteger(identity.size_bytes),
        }),
      }),
    }));
  };

  const observedPrimary = await observeDocument(materialized.document_path);
  if (!observedPrimary.ok) return observedPrimary;
  const observedAdditional = [];
  for (const path of additionalPaths) {
    const observed = await observeDocument(path);
    if (!observed.ok) return observed;
    observedAdditional.push(observed.value);
  }

  const declaredInputs = [];
  for (const declared of materialized.declared_inputs) {
    const target = await resolveDeclaredInput(runner, authority, declared.path);
    if (!target.ok) return target;
    const bytes = await readResolvedBytes(target.value, authority);
    if (!bytes.ok) return bytes;
    declaredInputs.push(Object.freeze({
      input_id: declared.input_id,
      digest: sha256Bytes(bytes.value),
    }));
  }
  declaredInputs.sort((left, right) =>
    left.input_id < right.input_id ? -1 : left.input_id > right.input_id ? 1 : 0);

  const observations = [observedPrimary.value, ...observedAdditional]
    .sort((left, right) => left.projection_target < right.projection_target ? -1 : left.projection_target > right.projection_target ? 1 : 0);
  const outputs = Object.freeze(observations.map((observed) => observed.output));
  const projections = Object.freeze(observations.map((observed) => Object.freeze({
    path: observed.projection_target,
    content_digest: observed.content_digest,
  })));
  const additionalDocuments: readonly AdditionalDocumentArtifactV1[] = Object.freeze(
    observedAdditional.map((observed) => Object.freeze({
      document_path: observed.document_path,
      byte_count: observed.byte_count,
      content_digest: observed.content_digest,
      projection_target: observed.projection_target,
    })),
  );

  return ok(parseDocumentArtifact({
    schema_version: "1",
    artifact_kind: "document",
    task_id: authority.task_id,
    phase_instance: materialized.phase_instance,
    step: materialized.step,
    document_path: materialized.document_path,
    path_class: "document",
    byte_count: observedPrimary.value.byte_count,
    content_digest: observedPrimary.value.content_digest,
    declared_inputs: Object.freeze(declaredInputs),
    input_fingerprint: materialized.input_fingerprint,
    snapshot_digest: deriveDeclaredSnapshotDigest(outputs, projections),
    projection_target: toRepositoryPathClaim(authority.task_id, materialized.document_path),
    ...(additionalDocuments.length === 0 ? {} : { additional_documents: additionalDocuments }),
  }));
}

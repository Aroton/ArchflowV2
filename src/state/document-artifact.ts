import { sha256Bytes, parseGitOid } from "../contracts/canonical.js";
import { parseDocumentArtifact, type DocumentArtifactV1 } from "../contracts/durable-document.js";
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

  const documentTarget = await resolveTaskPath({
    runner,
    taskId: authority.task_id,
    claim: materialized.document_path,
    expectedClass: "document",
    context: authority.context,
  });
  if (!documentTarget.ok) return documentTarget;
  const documentBytes = await readResolvedBytes(documentTarget.value, authority);
  if (!documentBytes.ok) return documentBytes;

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

  const byteCount = parseSafeInteger(documentBytes.value.byteLength);
  const contentDigest = sha256Bytes(documentBytes.value);
  let identity: Awaited<ReturnType<typeof hashGitBlobIdentity>>;
  try {
    identity = await hashGitBlobIdentity(
      runner,
      documentBytes.value,
      documentTarget.value.repositoryRelative,
    );
  } catch (error) {
    if (error instanceof GitInvocationError) {
      return fail(projectErrorForGitFailure(error, runner, authority.context));
    }
    throw error;
  }
  const output: OutputEntry = Object.freeze({
    path: documentTarget.value.repositoryRelative,
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
  });
  const projections = Object.freeze([
    Object.freeze({ path: output.path, content_digest: contentDigest }),
  ]);

  return ok(parseDocumentArtifact({
    schema_version: "1",
    artifact_kind: "document",
    task_id: authority.task_id,
    phase_instance: materialized.phase_instance,
    step: materialized.step,
    document_path: materialized.document_path,
    path_class: "document",
    byte_count: byteCount,
    content_digest: contentDigest,
    declared_inputs: Object.freeze(declaredInputs),
    input_fingerprint: materialized.input_fingerprint,
    snapshot_digest: deriveDeclaredSnapshotDigest([output], projections),
    projection_target: toRepositoryPathClaim(authority.task_id, materialized.document_path),
  }));
}

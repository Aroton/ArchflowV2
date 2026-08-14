import { readFile } from "node:fs/promises";

import { canonicalJsonDigest, sha256Bytes } from "../contracts/canonical.js";
import type { DocumentArtifactV1 } from "../contracts/durable-document.js";
import type { ImplementationOutputV1 } from "../contracts/durable-implementation-output.js";
import type { TaskStateV1 } from "../contracts/durable-state.js";
import { createProjectError, type ProjectResult } from "../contracts/errors.js";
import type { Sha256Digest } from "../contracts/evidence.js";
import { parseTaskPathClaim, type TaskPathClaim } from "../contracts/path-claims.js";
import { decodePhaseInstance, encodePhaseInstance, type PhaseInstanceId } from "../contracts/phase-instance.js";
import type { RootBoundGitRunner } from "../repository/identity.js";
import { resolveTaskPath } from "../repository/paths.js";
import type { TransactionAuthority } from "./authority.js";
import type { TransactionDependencies, RetainedResultInstallation } from "./transaction.js";
import { loadLegacyImportInitialization } from "./legacy-import-resume.js";

/** Throwing decoder for document projections, which must be UTF-8 text — no base64 fallback. */
const fatalUtf8 = new TextDecoder("utf-8", { fatal: true });

type ProduceArtifact = DocumentArtifactV1 | ImplementationOutputV1;

export type CurrentProduceSubject = Readonly<{
  artifact_digest: Sha256Digest;
  artifact: ProduceArtifact;
  retained: RetainedResultInstallation;
}>;

export type ProduceUpstreamSubject = CurrentProduceSubject | Readonly<{
  artifact_digest: Sha256Digest;
  artifact: DocumentArtifactV1;
  imported_projection: Readonly<{ path: TaskPathClaim; content_digest: Sha256Digest }>;
}>;

export type ProduceUpstreamBinding = Readonly<{
  phase_instance: PhaseInstanceId;
  path: TaskPathClaim;
  artifact_kind: "prd" | "design" | "phase-design";
}>;

/** The exact workflow upstreams for a phase, in caller-facing path order. */
export function expectedProduceUpstreamBindings(state: TaskStateV1): readonly ProduceUpstreamBinding[] {
  const phase = decodePhaseInstance(state.phase_instance);
  if (phase.kind === "prd") return Object.freeze([]);
  if (phase.kind === "design") return Object.freeze([
    Object.freeze({ phase_instance: encodePhaseInstance({ kind: "prd" }), path: parseTaskPathClaim("prd.md"), artifact_kind: "prd" }),
  ]);
  if (phase.kind === "phase-design") return Object.freeze([
    Object.freeze({ phase_instance: encodePhaseInstance({ kind: "design" }), path: parseTaskPathClaim("design.md"), artifact_kind: "design" }),
    Object.freeze({ phase_instance: encodePhaseInstance({ kind: "prd" }), path: parseTaskPathClaim("prd.md"), artifact_kind: "prd" }),
  ]);
  return Object.freeze([
    Object.freeze({
      phase_instance: encodePhaseInstance({ kind: "phase-design", phase: phase.phase }),
      path: parseTaskPathClaim(`phases/${String(phase.phase)}/design.md`),
      artifact_kind: "phase-design",
    }),
    Object.freeze({ phase_instance: encodePhaseInstance({ kind: "design" }), path: parseTaskPathClaim("design.md"), artifact_kind: "design" }),
  ]);
}

/** Resolves a declared upstream only when it is one of the current phase's exact canonical paths. */
export function resolveProduceUpstreamBinding(
  state: TaskStateV1,
  path: TaskPathClaim,
): ProduceUpstreamBinding | undefined {
  return expectedProduceUpstreamBindings(state).find((binding) => binding.path === path);
}

/** Loads and authenticates the retained document artifact that currently owns an upstream path. */
export async function loadProduceUpstreamSubject(
  dependencies: Pick<TransactionDependencies, "load_retained_result" | "runner">,
  authority: TransactionAuthority,
  state: TaskStateV1,
  binding: ProduceUpstreamBinding,
): Promise<ProjectResult<ProduceUpstreamSubject>> {
  const approvedOwners: Array<Readonly<{ subject: CurrentProduceSubject; measured_at_revision: number }>> = [];
  let retainedOwnerExists = false;
  if (dependencies.load_retained_result !== undefined) {
    for (const reference of [...state.authoritative_results].reverse()) {
      if (reference.step !== "produce") continue;
      const retained = await dependencies.load_retained_result(reference);
      if (!retained.ok) return retained;
      const manifest = retained.value.prepared.manifest.value;
      const artifact = manifest.source_artifact;
      const ownsPath = artifact.artifact_kind === "document" &&
        documentProjectionDescriptors(artifact).some((entry) => entry.document_path === binding.path);
      if (ownsPath) retainedOwnerExists = true;
      if (
        artifact.artifact_kind !== "document" ||
        canonicalJsonDigest(artifact) !== manifest.artifact_digest ||
        !ownsPath ||
        !state.approvals.some((approval) =>
          (approval.gate_kind === "artifact-approval" || approval.gate_kind === "design-approval") &&
          approval.subject_digest === manifest.artifact_digest)
      ) continue;
      approvedOwners.push(Object.freeze({
        measured_at_revision: manifest.accounting.measured_at_revision,
        subject: Object.freeze({
          artifact_digest: manifest.artifact_digest,
          artifact,
          retained: retained.value,
        }),
      }));
    }
  }
  approvedOwners.sort((left, right) => right.measured_at_revision - left.measured_at_revision);
  if (approvedOwners[0] !== undefined) {
    return Object.freeze({ schema_version: "1", ok: true, value: approvedOwners[0].subject });
  }
  if (retainedOwnerExists) return fail(state.phase_instance, "upstream-approval-missing");
  const initialization = await loadLegacyImportInitialization(
    dependencies, authority, state,
  );
  if (!initialization.ok || initialization.value === undefined) {
    return fail(state.phase_instance, "current-upstream-produce-result-missing");
  }
  const destination = `.archflow/tasks/${state.task_id}/${binding.path}`;
  const mapping = initialization.value.mapping.find((entry) => entry.destination_path === destination);
  const staged = mapping === undefined ? undefined : initialization.value.staged_payload_refs.find((entry) => entry.legacy_path === mapping.legacy_path);
  if (mapping === undefined || staged === undefined) return fail(state.phase_instance, "current-upstream-import-missing");
  const target = await resolveTaskPath({ runner: dependencies.runner, taskId: authority.task_id, claim: binding.path, context: authority.context });
  if (!target.ok) return target;
  let bytes: Uint8Array;
  try { bytes = new Uint8Array(await readFile(target.value.absolute)); }
  catch { return fail(state.phase_instance, "current-upstream-import-unavailable"); }
  if (sha256Bytes(bytes) !== staged.digest) return fail(state.phase_instance, "current-upstream-import-changed");
  const artifact: DocumentArtifactV1 = Object.freeze({
    schema_version: "1", artifact_kind: "document", task_id: state.task_id,
    phase_instance: binding.phase_instance, step: "produce", document_path: binding.path,
    path_class: "document", byte_count: staged.byte_count, content_digest: staged.digest,
    declared_inputs: Object.freeze([]), input_fingerprint: state.input_fingerprint,
    snapshot_digest: canonicalJsonDigest({ schema_version: "1", imported_document: binding.path, content_digest: staged.digest }),
    projection_target: target.value.repositoryRelative,
  });
  return Object.freeze({
    schema_version: "1", ok: true,
    value: Object.freeze({
      artifact_digest: canonicalJsonDigest({ schema_version: "1", initialization_digest: state.initialization_digest, imported_document: binding.path, content_digest: staged.digest }),
      artifact,
      imported_projection: Object.freeze({ path: binding.path, content_digest: staged.digest }),
    }),
  });
}

const fail = <T>(phase: TaskStateV1["phase_instance"], issue_code: string): ProjectResult<T> =>
  Object.freeze({
    schema_version: "1",
    ok: false,
    error: createProjectError("STATE_INVALID", { phase_instance: phase, issue_code }),
  });

/** Loads the current phase's retained produce result and authenticates its canonical artifact. */
export async function loadCurrentProduceSubject(
  dependencies: Pick<TransactionDependencies, "load_retained_result">,
  state: TaskStateV1,
): Promise<ProjectResult<CurrentProduceSubject>> {
  const reference = [...state.authoritative_results].reverse().find((candidate) =>
    candidate.phase_instance === state.phase_instance && candidate.step === "produce");
  if (reference === undefined || dependencies.load_retained_result === undefined) {
    return fail(state.phase_instance, "current-produce-result-missing");
  }
  const retained = await dependencies.load_retained_result(reference);
  if (!retained.ok) return retained;
  const manifest = retained.value.prepared.manifest.value;
  const artifact = manifest.source_artifact;
  if (artifact.artifact_kind !== "document" && artifact.artifact_kind !== "implementation-output") {
    return fail(state.phase_instance, "current-produce-artifact-invalid");
  }
  if (canonicalJsonDigest(artifact) !== manifest.artifact_digest) {
    return fail(state.phase_instance, "current-produce-artifact-digest-mismatch");
  }
  return Object.freeze({
    schema_version: "1",
    ok: true,
    value: Object.freeze({ artifact_digest: manifest.artifact_digest, artifact, retained: retained.value }),
  });
}

export type ProduceProjection = Readonly<{
  path: TaskPathClaim;
  bytes: Uint8Array;
  digest: Sha256Digest;
}>;

type DocumentProjectionDescriptor = Readonly<{
  document_path: TaskPathClaim;
  content_digest: Sha256Digest;
  projection_target: DocumentArtifactV1["projection_target"];
}>;

/** Every document projection whose bytes are owned by one document artifact. */
export function documentProjectionDescriptors(
  artifact: DocumentArtifactV1,
): readonly DocumentProjectionDescriptor[] {
  return Object.freeze([
    Object.freeze({
      document_path: artifact.document_path,
      content_digest: artifact.content_digest,
      projection_target: artifact.projection_target,
    }),
    ...(artifact.additional_documents ?? []),
  ]);
}

/** Canonical upstream bindings exclude parent documents co-produced by the current subject. */
export function produceUpstreamBindingsForSubject(
  state: TaskStateV1,
  artifact: ProduceArtifact,
): readonly ProduceUpstreamBinding[] {
  if (artifact.artifact_kind !== "document") return expectedProduceUpstreamBindings(state);
  const owned = new Set(documentProjectionDescriptors(artifact).map((entry) => entry.document_path));
  return Object.freeze(expectedProduceUpstreamBindings(state).filter((binding) => !owned.has(binding.path)));
}

/**
 * Authenticates the caller-selected human-readable subject against retained produce authority.
 *
 * Document results retain that file as a result projection. Implementation results instead bind
 * the implementation log as a parent document while their projections enumerate the declared
 * repository changes. Looking for the log in the latter list strands otherwise-valid retained
 * implementation results before dispatch.
 */
export async function readProduceProjection(
  runner: RootBoundGitRunner,
  authority: TransactionAuthority,
  subject: ProduceUpstreamSubject,
  artifactPath: TaskPathClaim,
): Promise<ProjectResult<ProduceProjection>> {
  const target = await resolveTaskPath({
    runner,
    taskId: authority.task_id,
    claim: artifactPath,
    context: authority.context,
  });
  if (!target.ok) return target;
  const retainedDigest = "imported_projection" in subject
    ? subject.imported_projection.path === artifactPath ? subject.imported_projection.content_digest : undefined
    : subject.artifact.artifact_kind === "implementation-output"
    ? subject.artifact.parent_documents.find((candidate) => candidate.document_path === artifactPath)?.content_digest
    : documentProjectionDescriptors(subject.artifact)
      .find((candidate) => candidate.document_path === artifactPath)?.content_digest;
  if (retainedDigest === undefined) return fail(authority.context.phase_instance, "produce-projection-not-retained");
  let bytes: Uint8Array;
  try {
    bytes = new Uint8Array(await readFile(target.value.absolute));
  } catch {
    return fail(authority.context.phase_instance, "produce-projection-unavailable");
  }
  const digest = sha256Bytes(bytes);
  if (digest !== retainedDigest) {
    return fail(authority.context.phase_instance, "produce-projection-not-current");
  }
  return Object.freeze({ schema_version: "1", ok: true, value: Object.freeze({ path: artifactPath, bytes, digest }) });
}

/** Re-hashes every retained document projection (or the selected implementation log). */
export async function readProduceProjectionSet(
  runner: RootBoundGitRunner,
  authority: TransactionAuthority,
  subject: ProduceUpstreamSubject,
  selectedPath: TaskPathClaim,
): Promise<ProjectResult<readonly ProduceProjection[]>> {
  const paths = "imported_projection" in subject || subject.artifact.artifact_kind === "implementation-output"
    ? [selectedPath]
    : documentProjectionDescriptors(subject.artifact).map((entry) => entry.document_path);
  const projections: ProduceProjection[] = [];
  for (const path of paths) {
    const projection = await readProduceProjection(runner, authority, subject, path);
    if (!projection.ok) return projection;
    projections.push(projection.value);
  }
  return Object.freeze({ schema_version: "1", ok: true, value: Object.freeze(projections) });
}

/** One digest used only as the post-dispatch staleness pin for the complete projection set. */
export function produceProjectionSetDigest(projections: readonly ProduceProjection[]): Sha256Digest {
  if (projections.length === 1) return projections[0]!.digest;
  return canonicalJsonDigest({
    schema_version: "1",
    projections: projections.map((projection) => ({ path: projection.path, content_digest: projection.digest })),
  });
}

/** Builds child-visible review material exclusively from authenticated retained authority. */
export function renderProduceReviewMaterial(
  subject: CurrentProduceSubject,
  selectedProjection: ProduceProjection,
  projections: readonly ProduceProjection[] = [selectedProjection],
): string {
  if (subject.artifact.artifact_kind === "document") {
    if (projections.length === 1) return fatalUtf8.decode(selectedProjection.bytes);
    return projections.map((projection) =>
      `## Document: ${projection.path}\n\n${fatalUtf8.decode(projection.bytes)}`,
    ).join("\n\n");
  }
  return `${JSON.stringify({
    schema_version: "1",
    subject_kind: "retained-implementation-output",
    artifact_digest: subject.artifact_digest,
    implementation_output: subject.artifact,
  }, null, 2)}\n`;
}

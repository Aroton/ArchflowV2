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
import type { TransactionDependencies, RetainedManifest } from "./transaction.js";
import { loadLegacyImportInitialization } from "./legacy-import-resume.js";
import {
  approvalIsEligibleAfterLatestRestart,
  acceptedNoWaitSettlement,
} from "./restart-authority.js";
import {
  authenticateRuleAcceptancePolicy,
  resolvePinnedConstitution,
} from "./constitution.js";

/** Throwing decoder for document projections, which must be UTF-8 text — no base64 fallback. */
const fatalUtf8 = new TextDecoder("utf-8", { fatal: true });

type ProduceArtifact = DocumentArtifactV1 | ImplementationOutputV1;

/**
 * A produce subject carries only the retained *manifest*, never the full installation.
 *
 * Every status, gate, and evidence reader consumes manifest fields (`projections`, `outputs`,
 * `artifact_digest`). Only review dispatch needs the projection plan, and reconstructing that plan
 * means re-reading every payload and re-running the secret scan — work that writes nothing and, on
 * an implementation result with a few hundred outputs, dominates a read. Those two consumers load
 * the full installation themselves from `reference`; nobody else pays for it.
 */
export type CurrentProduceSubject = Readonly<{
  artifact_digest: Sha256Digest;
  artifact: ProduceArtifact;
  /** Addresses the retained result, so a consumer that needs the projection plan can load it. */
  reference: TaskStateV1["authoritative_results"][number];
  retained: RetainedManifest;
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

/**
 * Loads and authenticates the retained document artifact that currently owns an upstream path.
 * Ownership authority is either an eligible artifact/design approval or an exact authenticated
 * no-wait settlement bound to the owning artifact's producer phase. Imported projections keep
 * their separate migration-audit authority and are handled below.
 */
export async function loadProduceUpstreamSubject(
  dependencies: Pick<TransactionDependencies, "load_retained_manifest" | "runner">,
  authority: TransactionAuthority,
  state: TaskStateV1,
  binding: ProduceUpstreamBinding,
): Promise<ProjectResult<ProduceUpstreamSubject>> {
  // Ownership is decided entirely from manifests, and no caller reads an upstream subject's
  // retained installation — upstream pinning re-hashes the projected file on disk against the
  // manifest's content digest instead. So the winner is never loaded in full either.
  const candidateOwners: Array<Readonly<{
    reference: TaskStateV1["authoritative_results"][number];
    artifact: DocumentArtifactV1;
    artifact_digest: Sha256Digest;
    measured_at_revision: number;
    retained: RetainedManifest;
    human_approved: boolean;
  }>> = [];
  let retainedOwnerExists = false;
  const loadManifest = dependencies.load_retained_manifest;
  if (loadManifest !== undefined) {
    for (const reference of [...state.authoritative_results].reverse()) {
      if (reference.step !== "produce") continue;
      const retained = await loadManifest(reference);
      if (!retained.ok) return retained;
      const manifest = retained.value.manifest.value;
      const artifact = manifest.source_artifact;
      const ownsPath = artifact.artifact_kind === "document" &&
        documentProjectionDescriptors(artifact).some((entry) => entry.document_path === binding.path);
      if (ownsPath) retainedOwnerExists = true;
      if (
        artifact.artifact_kind !== "document" ||
        canonicalJsonDigest(artifact) !== manifest.artifact_digest ||
        !ownsPath
      ) continue;
      candidateOwners.push(Object.freeze({
        reference,
        artifact,
        artifact_digest: manifest.artifact_digest,
        measured_at_revision: manifest.accounting.measured_at_revision,
        retained: retained.value,
        human_approved: state.approvals.some((approval) =>
          (approval.gate_kind === "artifact-approval" || approval.gate_kind === "design-approval") &&
          approval.subject_digest === manifest.artifact_digest &&
          approvalIsEligibleAfterLatestRestart(state, approval, artifact.phase_instance)),
      }));
    }
  }
  let settlementPolicy: ReturnType<typeof authenticateRuleAcceptancePolicy>;
  if (candidateOwners.some((candidate) => !candidate.human_approved) &&
      state.policy_base_commit !== undefined && state.constitution_digest !== undefined) {
    const constitution = await resolvePinnedConstitution(
      dependencies.runner, state.policy_base_commit, authority.context,
    );
    settlementPolicy = constitution.ok
      ? authenticateRuleAcceptancePolicy(state, constitution.value)
      : undefined;
  }
  const approvedOwners = candidateOwners.filter((candidate) =>
    candidate.human_approved ||
    (settlementPolicy !== undefined && acceptedNoWaitSettlement(
      settlementPolicy, state, candidate.artifact_digest, candidate.artifact.phase_instance,
    ) !== undefined));
  approvedOwners.sort((left, right) => right.measured_at_revision - left.measured_at_revision);
  const owner = approvedOwners[0];
  if (owner !== undefined) {
    return Object.freeze({
      schema_version: "1",
      ok: true,
      value: Object.freeze({
        artifact_digest: owner.artifact_digest,
        artifact: owner.artifact,
        reference: owner.reference,
        retained: owner.retained,
      }),
    });
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
  dependencies: Pick<TransactionDependencies, "load_retained_manifest">,
  state: TaskStateV1,
): Promise<ProjectResult<CurrentProduceSubject>> {
  const reference = [...state.authoritative_results].reverse().find((candidate) =>
    candidate.phase_instance === state.phase_instance && candidate.step === "produce");
  if (reference === undefined || dependencies.load_retained_manifest === undefined) {
    return fail(state.phase_instance, "current-produce-result-missing");
  }
  const retained = await dependencies.load_retained_manifest(reference);
  if (!retained.ok) return retained;
  const manifest = retained.value.manifest.value;
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
    value: Object.freeze({ artifact_digest: manifest.artifact_digest, artifact, reference, retained: retained.value }),
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

/** Task-document paths whose current bytes are owned by one produce subject. */
export function produceOwnedTaskDocumentPaths(
  artifact: ProduceArtifact,
): readonly TaskPathClaim[] {
  if (artifact.artifact_kind === "document") {
    return Object.freeze(documentProjectionDescriptors(artifact)
      .map((entry) => entry.document_path));
  }
  const prefix = `.archflow/tasks/${artifact.task_id}/`;
  return Object.freeze([...new Set(artifact.outputs
    .map((entry) => String(entry.path))
    .filter((path) => path.startsWith(prefix))
    .map((path) => parseTaskPathClaim(path.slice(prefix.length))))]
    .sort((left, right) => left.localeCompare(right)));
}

/** Canonical upstream bindings exclude parent documents co-produced by the current subject. */
export function produceUpstreamBindingsForSubject(
  state: TaskStateV1,
  artifact: ProduceArtifact,
): readonly ProduceUpstreamBinding[] {
  const bindings = expectedProduceUpstreamBindings(state);
  const owned = new Set(produceOwnedTaskDocumentPaths(artifact));
  return Object.freeze(bindings.filter((binding) => !owned.has(binding.path)));
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

/**
 * Re-hashes every applicable retained document projection (or the selected implementation log).
 *
 * A compound upstream owner may also retain a path that the current subject co-produces. Callers
 * pass those paths in `excludedPaths` so a surviving sibling binding cannot pull superseded bytes
 * back into upstream authentication. The selected path remains mandatory.
 */
export async function readProduceProjectionSet(
  runner: RootBoundGitRunner,
  authority: TransactionAuthority,
  subject: ProduceUpstreamSubject,
  selectedPath: TaskPathClaim,
  excludedPaths: readonly TaskPathClaim[] = [],
): Promise<ProjectResult<readonly ProduceProjection[]>> {
  let paths: readonly TaskPathClaim[];
  if ("imported_projection" in subject) {
    paths = [selectedPath];
  } else if (subject.artifact.artifact_kind === "implementation-output") {
    const prefix = `.archflow/tasks/${subject.artifact.task_id}/`;
    const outputPaths = new Set(subject.artifact.outputs.map((entry) => String(entry.path)));
    paths = Object.freeze([...new Set([
      selectedPath,
      ...subject.artifact.parent_documents
        .filter((parent) => outputPaths.has(`${prefix}${parent.document_path}`))
        .map((parent) => parent.document_path),
    ])]);
  } else {
    const excluded = new Set(excludedPaths);
    paths = documentProjectionDescriptors(subject.artifact)
      .map((entry) => entry.document_path)
      .filter((path) => path === selectedPath || !excluded.has(path));
  }
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
  const prefix = `.archflow/tasks/${subject.artifact.task_id}/`;
  const outputPaths = new Set(subject.artifact.outputs.map((entry) => String(entry.path)));
  const coProducedDocuments = projections
    .filter((projection) => outputPaths.has(`${prefix}${projection.path}`))
    .map((projection) => ({
      path: projection.path,
      content_digest: projection.digest,
      content: fatalUtf8.decode(projection.bytes),
    }));
  return `${JSON.stringify({
    schema_version: "1",
    subject_kind: "retained-implementation-output",
    artifact_digest: subject.artifact_digest,
    implementation_output: subject.artifact,
    ...(coProducedDocuments.length === 0 ? {} : {
      co_produced_documents: coProducedDocuments,
    }),
  }, null, 2)}\n`;
}

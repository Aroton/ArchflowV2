import { readFile } from "node:fs/promises";

import { canonicalJsonDigest, sha256Bytes } from "../contracts/canonical.js";
import { decodeUtf8Strict, visibleContent } from "../contracts/utf8.js";
import type { DocumentArtifactV1 } from "../contracts/durable-document.js";
import type { ImplementationOutputV1 } from "../contracts/durable-implementation-output.js";
import type { TaskStateV1 } from "../contracts/durable-state.js";
import { createProjectError, type ProjectResult } from "../contracts/errors.js";
import type { Sha256Digest } from "../contracts/evidence.js";
import { parseTaskPathClaim, type RepositoryPathClaim, type TaskPathClaim } from "../contracts/path-claims.js";
import { decodePhaseInstance, encodePhaseInstance, type PhaseInstanceId } from "../contracts/phase-instance.js";
import { checkGeneratedAttributes, REVIEW_EXCLUDED_BASENAMES } from "../repository/attributes.js";
import { DIFF_CONTEXT_LINES, formatUnifiedHunks } from "../review/line-diff.js";
import type { RepositoryOperationContext } from "../repository/git.js";
import type { RootBoundGitRunner } from "../repository/identity.js";
import { resolveTaskPath } from "../repository/paths.js";
import type { TransactionAuthority } from "./authority.js";
import type { ProjectionDesired } from "./snapshots.js";
import type { TransactionDependencies, RetainedResultInstallation } from "./transaction.js";

/** Throwing decoder for document projections, which must be UTF-8 text — no base64 fallback. */
const fatalUtf8 = new TextDecoder("utf-8", { fatal: true });

type ProduceArtifact = DocumentArtifactV1 | ImplementationOutputV1;

export type CurrentProduceSubject = Readonly<{
  artifact_digest: Sha256Digest;
  artifact: ProduceArtifact;
  retained: RetainedResultInstallation;
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
  dependencies: Pick<TransactionDependencies, "load_retained_result">,
  state: TaskStateV1,
  binding: ProduceUpstreamBinding,
): Promise<ProjectResult<CurrentProduceSubject>> {
  const reference = [...state.authoritative_results].reverse().find((candidate) =>
    candidate.phase_instance === binding.phase_instance && candidate.step === "produce");
  if (reference === undefined || dependencies.load_retained_result === undefined) {
    return fail(state.phase_instance, "current-upstream-produce-result-missing");
  }
  const retained = await dependencies.load_retained_result(reference);
  if (!retained.ok) return retained;
  const manifest = retained.value.prepared.manifest.value;
  const artifact = manifest.source_artifact;
  if (artifact.artifact_kind !== "document" || artifact.document_path !== binding.path) {
    return fail(state.phase_instance, "current-upstream-produce-artifact-invalid");
  }
  if (canonicalJsonDigest(artifact) !== manifest.artifact_digest) {
    return fail(state.phase_instance, "current-upstream-produce-artifact-digest-mismatch");
  }
  return Object.freeze({
    schema_version: "1",
    ok: true,
    value: Object.freeze({ artifact_digest: manifest.artifact_digest, artifact, retained: retained.value }),
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
  const reference = state.authoritative_results.find((candidate) =>
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
  bytes: Uint8Array;
  digest: Sha256Digest;
}>;

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
  subject: CurrentProduceSubject,
  artifactPath: TaskPathClaim,
): Promise<ProjectResult<ProduceProjection>> {
  const target = await resolveTaskPath({
    runner,
    taskId: authority.task_id,
    claim: artifactPath,
    context: authority.context,
  });
  if (!target.ok) return target;
  const retainedDigest = subject.artifact.artifact_kind === "implementation-output"
    ? subject.artifact.parent_documents.find((candidate) => candidate.document_path === artifactPath)?.content_digest
    : subject.retained.prepared.manifest.value.projections.find((candidate) =>
      candidate.path === target.value.repositoryRelative)?.content_digest;
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
  return Object.freeze({ schema_version: "1", ok: true, value: Object.freeze({ bytes, digest }) });
}

export type ReviewExclusionReason = "generated-attribute" | "excluded-basename";

export type ReviewChangeRendering = "embedded" | "unified-diff" | "digest-only";

export type ReviewChangeReason = ReviewExclusionReason | "exceeds-embed-ceiling" | "binary-content";

/**
 * One side of a changed file. Every present side names its exact bytes by digest and count; only
 * the `embedded` rendering also carries the bytes themselves, so an elided side stays verifiable
 * against the retained result without being shipped.
 */
export type ReviewChangeSide =
  | Readonly<{ state: "absent" }>
  | Readonly<{
      state: "present";
      content_digest: Sha256Digest;
      byte_count: number;
      encoding: "utf8" | "base64";
      content: string;
    }>
  | Readonly<{ state: "present"; content_digest: Sha256Digest; byte_count: number }>;

export type ReviewChangeEntry = Readonly<{
  path: string;
  rendering: ReviewChangeRendering;
  /** Present exactly when `rendering !== "embedded"` — every elision declares itself in place. */
  reason?: ReviewChangeReason;
  after: ReviewChangeSide;
  before?: ReviewChangeSide;
  diff?: Readonly<{ format: "unified"; context_lines: number; content: string }>;
}>;

function reviewChangeSide(desired: ProjectionDesired, embed: boolean): ReviewChangeSide {
  if (desired.state === "absent") return Object.freeze({ state: "absent" as const });
  const identity = {
    state: "present" as const,
    content_digest: sha256Bytes(desired.bytes),
    byte_count: desired.bytes.byteLength,
  };
  return embed
    ? Object.freeze({ ...identity, ...visibleContent(desired.bytes) })
    : Object.freeze(identity);
}

/**
 * Resolves which changed paths the review renders digest-only: universal lockfile basenames plus
 * paths the repository marks `linguist-generated` in `.gitattributes`. An attribute-check failure
 * degrades to the basename defaults rather than failing closed — exclusion is a byte-budget
 * optimization, not authority, and rendering more is always safe: an oversized envelope still
 * fails on the byte cap.
 */
export async function resolveReviewExclusions(
  runner: RootBoundGitRunner,
  subject: CurrentProduceSubject,
  context: RepositoryOperationContext,
): Promise<ReadonlyMap<string, ReviewExclusionReason>> {
  const exclusions = new Map<string, ReviewExclusionReason>();
  if (subject.artifact.artifact_kind === "document") return exclusions;
  const attributeCandidates: RepositoryPathClaim[] = [];
  for (const entry of subject.retained.projection_plan.entries) {
    if (REVIEW_EXCLUDED_BASENAMES.has(entry.path.split("/").at(-1) ?? entry.path)) {
      exclusions.set(entry.path, "excluded-basename");
    } else {
      attributeCandidates.push(entry.path);
    }
  }
  const generated = await checkGeneratedAttributes(runner, attributeCandidates, context);
  if (generated.ok) {
    for (const path of generated.value) exclusions.set(path, "generated-attribute");
  }
  return exclusions;
}

/** Whole-file embedding ceiling per side; larger text renders as a wide-context unified diff. */
export const EMBED_WHOLE_BYTE_CEILING = 32_768;

/** Builds the tiered change entries the implementation review material embeds. */
export function reviewChangeEntries(
  subject: CurrentProduceSubject,
  exclusions: ReadonlyMap<string, ReviewExclusionReason>,
): readonly ReviewChangeEntry[] {
  return subject.retained.projection_plan.entries.map((entry) => {
    const named = (reason: ReviewChangeReason, rendering: "digest-only" | "unified-diff") => ({
      path: entry.path,
      rendering,
      reason,
      after: reviewChangeSide(entry.desired, false),
      ...(entry.rollback === undefined ? {} : { before: reviewChangeSide(entry.rollback, false) }),
    });

    const exclusionReason = exclusions.get(entry.path);
    if (exclusionReason !== undefined) return Object.freeze(named(exclusionReason, "digest-only"));

    const afterBytes = entry.desired.state === "present" ? entry.desired.bytes : undefined;
    const beforeBytes = entry.rollback?.state === "present" ? entry.rollback.bytes : undefined;
    const oversized = (afterBytes?.byteLength ?? 0) > EMBED_WHOLE_BYTE_CEILING
      || (beforeBytes?.byteLength ?? 0) > EMBED_WHOLE_BYTE_CEILING;
    if (!oversized) {
      return Object.freeze({
        path: entry.path,
        rendering: "embedded" as const,
        after: reviewChangeSide(entry.desired, true),
        ...(entry.rollback === undefined ? {} : { before: reviewChangeSide(entry.rollback, true) }),
      });
    }

    const afterText = afterBytes === undefined ? "" : decodeUtf8Strict(afterBytes);
    const beforeText = beforeBytes === undefined ? "" : decodeUtf8Strict(beforeBytes);
    if (afterText === undefined || beforeText === undefined) {
      return Object.freeze(named("binary-content", "digest-only"));
    }
    return Object.freeze({
      ...named("exceeds-embed-ceiling", "unified-diff"),
      diff: Object.freeze({
        format: "unified" as const,
        context_lines: DIFF_CONTEXT_LINES,
        content: formatUnifiedHunks(beforeText, afterText),
      }),
    });
  });
}

/** Builds child-visible review material exclusively from authenticated retained authority. */
export function renderProduceReviewMaterial(
  subject: CurrentProduceSubject,
  selectedProjection: ProduceProjection,
  exclusions: ReadonlyMap<string, ReviewExclusionReason>,
): string {
  if (subject.artifact.artifact_kind === "document") {
    return fatalUtf8.decode(selectedProjection.bytes);
  }
  return `${JSON.stringify({
    schema_version: "1",
    subject_kind: "retained-implementation-output",
    artifact_digest: subject.artifact_digest,
    implementation_output: subject.artifact,
    changes: reviewChangeEntries(subject, exclusions),
  }, null, 2)}\n`;
}

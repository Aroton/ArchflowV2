import { canonicalJsonDigest, type CanonicalDocument } from "../contracts/canonical.js";
import { createCommittedIntentSubject, createPreparedIntentSubject, validateDurableSemantics } from "../contracts/durable.js";
import { intentOutcomeDigest, intentReceiptDigest, parseIntentReceipt, type IntentReceiptV1 } from "../contracts/durable-intent.js";
import type { ProjectionDigestRef } from "../contracts/durable-primitives.js";
import type { TaskStateV1 } from "../contracts/durable-state.js";
import type { ActiveGateV1, GateRequestV1 } from "../contracts/durable-gate.js";
import { parsePathSafeId, type PathSafeId, type Sha256Digest } from "../contracts/evidence.js";
import { assertPlainJson } from "../contracts/plain-json.js";
import { baselineAdoptionDriftDigest, computeGateContextDigest } from "../contracts/fingerprints.js";

export type ActiveAuthorityHeads = Readonly<{
  gate?: Readonly<{ gate_id: PathSafeId; subject_digest: Sha256Digest; context_digest: Sha256Digest }>;
}>;

/** Produces the gate reconciliation head only from the mutable projection and its immutable request. */
export function activeGateHead(
  active: ActiveGateV1,
  request: GateRequestV1,
): NonNullable<ActiveAuthorityHeads["gate"]> {
  if (
    active.gate_id !== request.gate_id || active.task_id !== request.task_id ||
    active.phase_instance !== request.phase_instance || active.kind !== request.kind ||
    active.subject_digest !== request.subject_digest || active.context_digest !== request.context_digest
  ) throw new TypeError("active gate projection does not bind its archived request");
  return Object.freeze({
    gate_id: parsePathSafeId(request.gate_id),
    subject_digest: request.subject_digest,
    context_digest: request.context_digest,
  });
}

export type ReconciliationIntent = Readonly<{
  request_digest: Sha256Digest;
  receipt?: CanonicalDocument<IntentReceiptV1>;
}>;

export type ReconciliationInput = Readonly<{
  state: CanonicalDocument<TaskStateV1>;
  recorded_projections: readonly ProjectionDigestRef[];
  current_projections: readonly ProjectionDigestRef[];
  active_heads: ActiveAuthorityHeads;
  intent?: ReconciliationIntent;
  /** Discovery-only blockers consumed by status; they do not alter reconciliation classification. */
  blocking_reasons?: readonly string[];
  /**
   * Paths whose newest recorded projection has no retained payload to restore from — a
   * baseline adoption records digests only. Discovery-only, like blocking_reasons: it annotates
   * findings so routing can distinguish an unrecoverable-by-restore mismatch from a restorable one.
   */
  unrestorable_paths?: readonly (ProjectionIdentity | ProjectionDigestRef["path"])[];
  /**
   * Unrestorable paths that are also absent from git HEAD: the deletion is already committed
   * (typically by an authorized milestone commit), so the produce window cannot re-declare it
   * either — there is no before-image in the base. Discovery-only, like unrestorable_paths: it
   * annotates findings so routing can offer the human the deletion-adoption decision.
   */
  committed_absent_paths?: readonly (ProjectionIdentity | ProjectionDigestRef["path"])[];
}>;

/** A projection is identified by repository and path; omission denotes primary. */
export type ProjectionIdentity = Readonly<Pick<ProjectionDigestRef, "repository" | "path">>;

export type ReconciliationFinding =
  | Readonly<{ kind: "projection-mismatch"; repository?: ProjectionDigestRef["repository"]; path: ProjectionDigestRef["path"]; recorded_digest: Sha256Digest; observed_digest?: Sha256Digest; restore_unavailable?: true; committed_absent?: true; next_action: "open-baseline-adoption-gate" }>
  | Readonly<{ kind: "receipt-only"; request_digest: Sha256Digest; receipt_digest: Sha256Digest; next_action: "resume-exact-intent" }>
  | Readonly<{ kind: "receipt-invalid"; receipt_digest: Sha256Digest; next_action: "inspect-retained-receipt" }>
  | Readonly<{ kind: "intent-mismatch"; requested_digest: Sha256Digest; receipt_request_digest: Sha256Digest; next_action: "create-fresh-intent" }>
  | Readonly<{ kind: "active-gate-mismatch"; head?: ActiveAuthorityHeads["gate"]; next_action: "resolve-current-authority" }>;

export type ReconciliationResult = Readonly<{
  classification: "consistent" | "reconciliation-required";
  findings: readonly ReconciliationFinding[];
}>;

export type BaselineSubjectFreshness = Readonly<{
  classification: "current" | "stale";
  reason?: "target-history-replaced" | "drift-subject-changed";
  live_subject_digest: Sha256Digest;
  live_context_digest: Sha256Digest;
}>;

export type BaselinePresentedTarget = Readonly<{
  repository: "primary" | NonNullable<ProjectionDigestRef["repository"]>;
  target_head: NonNullable<Extract<GateRequestV1, { readonly kind: "baseline-adoption" }>["context"]["target_head"]>;
}>;

/** Lists every repository whose authenticated presented head must retain first-parent continuity. */
export function baselinePresentedTargets(
  context: Extract<GateRequestV1, { readonly kind: "baseline-adoption" }>["context"],
): readonly BaselinePresentedTarget[] {
  return Object.freeze([
    ...(context.target_head === undefined ? [] : [Object.freeze({ repository: "primary" as const, target_head: context.target_head })]),
    ...(context.secondary_targets ?? []).map((target) => Object.freeze({
      repository: target.repository,
      target_head: target.target_head,
    })),
  ]);
}

/**
 * Revalidates the complete baseline subject without making ordinary descendant movement stale.
 * The presented head remains the digest/disclosure anchor when it is still on the current target's
 * first-parent history; callers supply that independently proved continuity fact. A rewritten
 * target fails before byte equality can accidentally preserve the interface.
 */
export function assessBaselineSubjectFreshness(
  request: Extract<GateRequestV1, { readonly kind: "baseline-adoption" }>,
  liveContext: Extract<GateRequestV1, { readonly kind: "baseline-adoption" }>["context"],
  presentedHeadOnCurrentFirstParent: boolean,
): BaselineSubjectFreshness {
  assertPlainJson(request, "baseline adoption request");
  assertPlainJson(liveContext, "live baseline adoption context");
  const live = structuredClone(liveContext);
  const presented = new Map((request.context.secondary_targets ?? []).map((target) => [target.repository, target.target_head]));
  const context = presentedHeadOnCurrentFirstParent
    ? {
        ...live,
        ...(request.context.target_head === undefined ? {} : { target_head: request.context.target_head }),
        ...(live.secondary_targets === undefined ? {} : {
          secondary_targets: live.secondary_targets.map((target) => {
            const targetHead = presented.get(target.repository);
            return targetHead === undefined ? target : { ...target, target_head: targetHead };
          }),
        }),
      }
    : live;
  const liveSubjectDigest = baselineAdoptionDriftDigest(context);
  const liveContextDigest = computeGateContextDigest("baseline-adoption", context);
  if (!presentedHeadOnCurrentFirstParent) {
    return Object.freeze({ classification: "stale", reason: "target-history-replaced", live_subject_digest: liveSubjectDigest, live_context_digest: liveContextDigest });
  }
  if (liveSubjectDigest !== request.subject_digest || liveContextDigest !== request.context_digest) {
    return Object.freeze({ classification: "stale", reason: "drift-subject-changed", live_subject_digest: liveSubjectDigest, live_context_digest: liveContextDigest });
  }
  return Object.freeze({ classification: "current", live_subject_digest: liveSubjectDigest, live_context_digest: liveContextDigest });
}

function materialize(input: ReconciliationInput): ReconciliationInput {
  const stateValue = ownData(input.state, "value", "reconciliation state");
  const stateDigest = ownData(input.state, "digest", "reconciliation state");
  assertPlainJson(stateValue, "reconciliation state value");
  assertPlainJson({
    recorded_projections: input.recorded_projections,
    current_projections: input.current_projections,
    active_heads: input.active_heads,
    ...(input.blocking_reasons === undefined ? {} : { blocking_reasons: input.blocking_reasons }),
    ...(input.unrestorable_paths === undefined ? {} : { unrestorable_paths: input.unrestorable_paths }),
    ...(input.committed_absent_paths === undefined ? {} : { committed_absent_paths: input.committed_absent_paths }),
  }, "reconciliation working set");
  let intent: ReconciliationIntent | undefined;
  if (input.intent !== undefined) {
    assertPlainJson({ request_digest: input.intent.request_digest }, "reconciliation intent");
    if (input.intent.receipt === undefined) {
      intent = { request_digest: input.intent.request_digest };
    } else {
      const receiptValue = ownData(input.intent.receipt, "value", "reconciliation receipt");
      const receiptDigest = ownData(input.intent.receipt, "digest", "reconciliation receipt");
      assertPlainJson(receiptValue, "reconciliation receipt value");
      intent = {
        request_digest: input.intent.request_digest,
        receipt: { bytes: input.intent.receipt.bytes, value: structuredClone(receiptValue) as IntentReceiptV1, digest: receiptDigest as Sha256Digest },
      };
    }
  }
  return {
    state: { bytes: input.state.bytes, value: structuredClone(stateValue) as TaskStateV1, digest: stateDigest as Sha256Digest },
    recorded_projections: structuredClone(input.recorded_projections),
    current_projections: structuredClone(input.current_projections),
    active_heads: structuredClone(input.active_heads),
    ...(intent === undefined ? {} : { intent }),
    ...(input.blocking_reasons === undefined
      ? {}
      : { blocking_reasons: Object.freeze([...input.blocking_reasons]) }),
    ...(input.unrestorable_paths === undefined
      ? {}
      : { unrestorable_paths: Object.freeze([...input.unrestorable_paths]) }),
    ...(input.committed_absent_paths === undefined
      ? {}
      : { committed_absent_paths: Object.freeze([...input.committed_absent_paths]) }),
  };
}

function ownData(value: object, field: string, label: string): unknown {
  const descriptor = Object.getOwnPropertyDescriptor(value, field);
  if (descriptor === undefined || !("value" in descriptor) || !descriptor.enumerable) {
    throw new TypeError(`${label}.${field} must be an own enumerable data property`);
  }
  return descriptor.value;
}

function repositoryOf(value: ProjectionIdentity): string {
  return value.repository ?? "primary";
}

function indexProjectionDigests(
  projections: readonly ProjectionDigestRef[],
): ReadonlyMap<string, ReadonlyMap<ProjectionDigestRef["path"], Sha256Digest>> {
  const repositories = new Map<string, Map<ProjectionDigestRef["path"], Sha256Digest>>();
  for (const projection of projections) {
    const repository = repositoryOf(projection);
    let paths = repositories.get(repository);
    if (paths === undefined) {
      paths = new Map();
      repositories.set(repository, paths);
    }
    paths.set(projection.path, projection.content_digest);
  }
  return repositories;
}

function indexProjectionIdentities(
  projections: readonly (ProjectionIdentity | ProjectionDigestRef["path"])[],
): ReadonlyMap<string, ReadonlySet<ProjectionDigestRef["path"]>> {
  const repositories = new Map<string, Set<ProjectionDigestRef["path"]>>();
  for (const candidate of projections) {
    const projection: ProjectionIdentity = typeof candidate === "string" ? { path: candidate } : candidate;
    const repository = repositoryOf(projection);
    let paths = repositories.get(repository);
    if (paths === undefined) {
      paths = new Set();
      repositories.set(repository, paths);
    }
    paths.add(projection.path);
  }
  return repositories;
}

function indexedDigest(
  index: ReadonlyMap<string, ReadonlyMap<ProjectionDigestRef["path"], Sha256Digest>>,
  projection: ProjectionIdentity,
): Sha256Digest | undefined {
  return index.get(repositoryOf(projection))?.get(projection.path);
}

function indexedIdentity(
  index: ReadonlyMap<string, ReadonlySet<ProjectionDigestRef["path"]>>,
  projection: ProjectionIdentity,
): boolean {
  return index.get(repositoryOf(projection))?.has(projection.path) ?? false;
}

/** Classifies only the supplied current working set. It performs no discovery or promotion. */
export function reconcileCurrentAuthority(value: ReconciliationInput): ReconciliationResult {
  const input = materialize(value);
  const findings: ReconciliationFinding[] = [];
  const observed = indexProjectionDigests(input.current_projections);
  const unrestorable = indexProjectionIdentities(input.unrestorable_paths ?? []);
  const committedAbsent = indexProjectionIdentities(input.committed_absent_paths ?? []);
  for (const recorded of input.recorded_projections) {
    const digest = indexedDigest(observed, recorded);
    if (digest !== recorded.content_digest) {
      findings.push(Object.freeze({
        kind: "projection-mismatch",
        ...(recorded.repository === undefined ? {} : { repository: recorded.repository }),
        path: recorded.path,
        recorded_digest: recorded.content_digest,
        ...(digest === undefined ? {} : { observed_digest: digest }),
        ...(digest === undefined && indexedIdentity(unrestorable, recorded) ? { restore_unavailable: true } : {}),
        ...(digest === undefined && indexedIdentity(unrestorable, recorded) && indexedIdentity(committedAbsent, recorded) ? { committed_absent: true } : {}),
        next_action: "open-baseline-adoption-gate",
      }));
    }
  }

  const receipt = input.intent?.receipt;
  if (receipt !== undefined) {
    const transition = input.state.value.last_transition;
    const isCommitted = transition !== undefined &&
      transition.intent_id === receipt.value.intent_id &&
      transition.request_digest === receipt.value.request_digest &&
      transition.input_fingerprint === receipt.value.input_fingerprint &&
      transition.result_id === receipt.value.result_id &&
      transition.outcome_digest === receipt.value.outcome_digest &&
      transition.prior_revision === receipt.value.prior_revision &&
      transition.resulting_revision === receipt.value.resulting_revision;
    let valid = false;
    try {
      const parsed = parseIntentReceipt(receipt.value);
      valid = receipt.digest === canonicalJsonDigest(parsed) &&
        receipt.digest === intentReceiptDigest(parsed) &&
        parsed.prepared_state_digest === canonicalJsonDigest(parsed.prepared_state) &&
        parsed.outcome_digest === intentOutcomeDigest(parsed.outcome) &&
        validateDurableSemantics(isCommitted
          ? createCommittedIntentSubject(input.state, receipt)
          : createPreparedIntentSubject(input.state, receipt)).ok;
    } catch {
      valid = false;
    }
    if (!valid) {
      findings.push(Object.freeze({
        kind: "receipt-invalid",
        receipt_digest: receipt.digest,
        next_action: "inspect-retained-receipt",
      }));
    } else if (receipt.value.request_digest !== input.intent!.request_digest) {
      findings.push(Object.freeze({
        kind: "intent-mismatch",
        requested_digest: input.intent!.request_digest,
        receipt_request_digest: receipt.value.request_digest,
        next_action: "create-fresh-intent",
      }));
    } else if (!isCommitted) {
      findings.push(Object.freeze({
        kind: "receipt-only",
        request_digest: receipt.value.request_digest,
        receipt_digest: receipt.digest,
        next_action: "resume-exact-intent",
      }));
    }
  }

  const heads = input.active_heads;
  const state = input.state.value;
  const gateMatches = heads.gate === undefined
    ? state.open_gate === undefined
    : state.open_gate?.gate_id === heads.gate.gate_id &&
      state.open_gate.subject_digest === heads.gate.subject_digest &&
      state.open_gate.context_digest === heads.gate.context_digest;
  if (!gateMatches) {
    findings.push(Object.freeze({ kind: "active-gate-mismatch", ...(heads.gate === undefined ? {} : { head: heads.gate }), next_action: "resolve-current-authority" }));
  }
  return Object.freeze({
    classification: findings.length === 0 ? "consistent" : "reconciliation-required",
    findings: Object.freeze(findings),
  });
}

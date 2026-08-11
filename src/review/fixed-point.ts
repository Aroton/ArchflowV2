import type { AdjudicationEvidence } from "../contracts/adjudication.js";
import type { ResultManifestV1 } from "../contracts/durable-result-manifest.js";
import type {
  ApprovalRef,
  TaskStateV1,
  WaiverRef,
} from "../contracts/durable-state.js";
import type { Sha256Digest } from "../contracts/evidence.js";
import type { WaiverScope } from "../contracts/gates.js";
import type { ReviewEvidence } from "../contracts/review.js";
import type { TriageCandidate } from "../contracts/triage.js";
import type { PipelineStep } from "../contracts/vocabulary.js";
import { computeGateContextDigest } from "../contracts/fingerprints.js";
import {
  deriveCurrentEvidenceSet,
  type DerivedCurrentEvidenceSet,
  type RetainedEvidenceSet,
} from "../state/evidence-results.js";
import {
  assertAuthenticatedGateApproval,
  type AuthenticatedGateApproval,
} from "../state/gates.js";
import {
  assertResolvedConstitution,
  type ResolvedConstitution,
} from "../state/constitution.js";
import {
  selectAdjudicationGate,
  selectAdjudicationGates,
} from "./adjudication.js";

export const DEFAULT_MAX_ATTEMPTS = 3;

const EVIDENCE_STEPS = Object.freeze([
  "counter_review",
  "triage",
  "adjudicate",
] as const);

/** The one-hop pair the current produce artifact may declare as its editorial predecessor. */
export type EditorialPredecessorPair = Readonly<{
  subject_digest: Sha256Digest;
  input_fingerprint: Sha256Digest;
}>;

export type EvidenceSubject = Readonly<{
  subject_digest: Sha256Digest;
  input_fingerprint: Sha256Digest;
  constitution: ResolvedConstitution;
  /**
   * Present only when the current produce artifact declares an editorial predecessor. Review,
   * triage, and constitution evidence bound to this pair counts as current for the subject —
   * exactly one hop, no chaining: the pair always comes from the current artifact's own
   * declaration, so evidence two revisions back never matches. An editorial revision therefore
   * re-runs nothing; the gate summary discloses that the evidence evaluated the predecessor bytes.
   */
  editorial_predecessor?: EditorialPredecessorPair;
  approved_upstream_digests?: readonly Sha256Digest[];
  authenticated_gate_approvals?: readonly AuthenticatedGateApproval[];
  max_attempts?: number;
}>;

export type EvidenceAssessment = Readonly<{
  current: readonly PipelineStep[];
  stale: readonly PipelineStep[];
  every_finding_dispositioned: boolean;
  blocker_remains: boolean;
  reentry_required: boolean;
  /**
   * Triage succeeded with only `accepted-editorial` findings and the produce artifact does not
   * yet declare that triage as its authorizer: the next produce applies exactly the editorial
   * revision intents without invalidating review evidence or requiring a full re-entry.
   */
  editorial_revision_required: boolean;
  exhausted: boolean;
  adjudication_gate_pending: boolean;
  next:
    | "counter_review"
    | "triage"
    | "produce"
    | "attempts-exhausted"
    | "adjudication-gate"
    | "advance";
}>;

function evidencePayload(manifest: ResultManifestV1):
  | ReviewEvidence
  | TriageCandidate
  | AdjudicationEvidence
  | undefined {
  const source = manifest.source_artifact;
  if (
    source.artifact_kind === "review-evidence" ||
    source.artifact_kind === "triage" ||
    source.artifact_kind === "adjudication-evidence"
  ) return source.evidence;
  return undefined;
}

function boundToSubjectExactly(
  bound: Readonly<{ subject_digest: Sha256Digest; input_fingerprint: Sha256Digest }>,
  subject: EvidenceSubject,
): boolean {
  return bound.subject_digest === subject.subject_digest &&
    bound.input_fingerprint === subject.input_fingerprint;
}

function boundToDeclaredPredecessor(
  bound: Readonly<{ subject_digest: Sha256Digest; input_fingerprint: Sha256Digest }>,
  subject: EvidenceSubject,
): boolean {
  const predecessor = subject.editorial_predecessor;
  return predecessor !== undefined &&
    bound.subject_digest === predecessor.subject_digest &&
    bound.input_fingerprint === predecessor.input_fingerprint;
}

function subjectCurrent(
  evidence: ReviewEvidence | TriageCandidate | AdjudicationEvidence | undefined,
  subject: EvidenceSubject,
  allowPredecessor: boolean,
): boolean {
  if (evidence === undefined) return false;
  return boundToSubjectExactly(evidence, subject) ||
    (allowPredecessor && boundToDeclaredPredecessor(evidence, subject));
}

function currentReviewSet(
  retained: RetainedEvidenceSet,
  subject: EvidenceSubject,
): DerivedCurrentEvidenceSet | undefined {
  try {
    const derived = deriveCurrentEvidenceSet(retained);
    return boundToSubjectExactly(derived, subject) ||
      boundToDeclaredPredecessor(derived, subject)
      ? derived
      : undefined;
  } catch {
    return undefined;
  }
}

function currentFor(
  retained: RetainedEvidenceSet,
  step: PipelineStep,
  subject: EvidenceSubject,
  reviews: DerivedCurrentEvidenceSet | undefined,
): boolean {
  if (step === "counter_review") return reviews !== undefined;
  const entry = retained.get(step);
  const evidence = entry === undefined ? undefined : evidencePayload(entry.manifest);
  // Triage and constitution evidence may be bound to the declared editorial predecessor (one
  // hop): the constitution review is dispatched with the counter-review, so both stay bound to
  // the same bytes and an editorial revision re-runs neither.
  if (!subjectCurrent(evidence, subject, true) || reviews === undefined) return false;
  if (step === "triage") {
    const triage = evidence as TriageCandidate;
    return triage.current_evidence_set_digest === reviews.current_evidence_set.set_digest &&
      triage.source_evidence_digests.length === reviews.current_evidence_set.slots.length &&
      triage.source_evidence_digests.every((digest, index) =>
        digest === reviews.current_evidence_set.slots[index]!.evidence_digest);
  }
  if (step === "adjudicate") {
    const adjudication = evidence as AdjudicationEvidence;
    return adjudication.source_evidence_set_digest === reviews.current_evidence_set.set_digest &&
      adjudication.approved_upstream_digests.length ===
        (subject.approved_upstream_digests ?? []).length &&
      adjudication.approved_upstream_digests.every((digest, index) =>
        digest === (subject.approved_upstream_digests ?? [])[index]);
  }
  return false;
}

function triageAt(retained: RetainedEvidenceSet): TriageCandidate | undefined {
  const source = retained.get("triage")?.manifest.source_artifact;
  return source?.artifact_kind === "triage" ? source.evidence : undefined;
}

function adjudicationAt(retained: RetainedEvidenceSet): AdjudicationEvidence | undefined {
  const source = retained.get("adjudicate")?.manifest.source_artifact;
  return source?.artifact_kind === "adjudication-evidence"
    ? source.evidence
    : undefined;
}

function adjudicationGateSatisfied(
  state: TaskStateV1,
  retained: RetainedEvidenceSet,
  subject: EvidenceSubject,
  gate: NonNullable<ReturnType<typeof selectAdjudicationGate>>,
): boolean {
  const contextDigest = computeGateContextDigest(gate.kind, gate.context);
  const counterDigest = retained.get("counter_review")?.manifest.artifact_digest;
  const triage = triageAt(retained);
  const adjudication = adjudicationAt(retained);
  for (const authenticated of subject.authenticated_gate_approvals ?? []) {
    assertAuthenticatedGateApproval(authenticated);
    const { approval, request, decision } = authenticated;
    if (
      approval.gate_kind !== gate.kind ||
      approval.subject_digest !== gate.subject_digest ||
      request.kind !== gate.kind ||
      request.subject_digest !== gate.subject_digest ||
      request.context_digest !== contextDigest ||
      request.phase_instance !== state.phase_instance ||
      decision.context_digest !== contextDigest ||
      decision.envelope.context_digest !== contextDigest ||
      counterDigest === undefined ||
      triage === undefined ||
      adjudication === undefined ||
      // Both bindings relax to the declared editorial predecessor (one hop): the constitution
      // review is dispatched with the counter-review, so an editorial revision re-runs neither
      // and the gate summary discloses that the evidence evaluated the predecessor bytes.
      !(boundToSubjectExactly(triage, subject) || boundToDeclaredPredecessor(triage, subject)) ||
      !(boundToSubjectExactly(adjudication, subject) || boundToDeclaredPredecessor(adjudication, subject)) ||
      adjudication.source_evidence_set_digest !== request.current_evidence.set_digest ||
      request.current_evidence.set_digest !== triage.current_evidence_set_digest ||
      request.current_evidence.slots[0].evidence_digest !== counterDigest
    ) continue;
    return true;
  }
  if (
    (gate.kind !== "review-trigger" && gate.kind !== "adjudication-failure") ||
    !("eligible_waiver_rules" in gate.context) ||
    !("waiver_scope" in gate.context)
  ) return false;
  const required = gate.context.eligible_waiver_rules;
  const scope = gate.context.waiver_scope;
  return required.length > 0 && required.every((rule) =>
    waiverInForce(
      state,
      rule,
      gate.subject_digest,
      scope,
    ) !== undefined);
}

function adjudicationGatePending(
  state: TaskStateV1,
  gate: NonNullable<ReturnType<typeof selectAdjudicationGate>>,
): boolean {
  const open = state.open_gate;
  return open !== undefined &&
    open.gate_kind === gate.kind &&
    open.subject_digest === gate.subject_digest &&
    open.context_digest === computeGateContextDigest(gate.kind, gate.context);
}

function dispositionState(
  retained: RetainedEvidenceSet,
  reviews: DerivedCurrentEvidenceSet | undefined,
  triage: TriageCandidate | undefined,
): Readonly<{
  complete: boolean;
  blocker: boolean;
  accepted: boolean;
}> {
  const counter = reviews?.reviews[0]?.evidence;
  if (reviews === undefined || counter === undefined || triage === undefined) {
    return Object.freeze({ complete: false, blocker: false, accepted: false });
  }
  const counterDigest = reviews.current_evidence_set.slots[0].evidence_digest;
  const expected = new Map<string, boolean>();
  for (const finding of counter.findings) {
    expected.set(`${counterDigest}:${finding.finding_id}`, finding.blocking);
  }
  const actual = new Map(triage.dispositions.map((item) => [
    `${item.review_evidence_digest}:${item.finding_id}`,
    item.disposition,
  ]));
  const complete = actual.size === expected.size &&
    [...expected.keys()].every((key) => actual.has(key));
  const blocker = [...expected].some(([key, blocking]) =>
    blocking && actual.get(key) !== "rejected");
  return Object.freeze({
    complete,
    blocker,
    accepted: triage.accepted_count > 0,
  });
}

/**
 * Computes review currency and the next fixed-point action from durable state and retained
 * manifests only. Attempt exhaustion is deliberately evaluated only when re-entry is required.
 */
export function assessCurrentEvidence(
  state: TaskStateV1,
  retained: RetainedEvidenceSet,
  subject: EvidenceSubject,
): EvidenceAssessment {
  assertResolvedConstitution(subject.constitution);
  if (subject.constitution.digest !== state.constitution_digest) {
    throw new TypeError("fixed-point constitution does not match durable state");
  }
  const retainedAdjudication = adjudicationAt(retained);
  if (
    retainedAdjudication !== undefined &&
    retainedAdjudication.pinned_constitution_digest !== subject.constitution.digest
  ) {
    throw new TypeError("retained adjudication does not match the pinned constitution");
  }
  const maximum = subject.max_attempts ?? DEFAULT_MAX_ATTEMPTS;
  if (!Number.isSafeInteger(maximum) || maximum < 1) {
    throw new TypeError("max_attempts must be a positive safe integer");
  }
  const constitutionRequired = [...subject.constitution.rules.values()]
    .some((rule) => rule.status === "active");
  const reviews = currentReviewSet(retained, subject);
  const candidateTriage = triageAt(retained);
  const triageCurrent = currentFor(
    retained, "triage", subject, reviews,
  ) ? candidateTriage : undefined;
  const current = EVIDENCE_STEPS.filter((step) =>
    currentFor(retained, step, subject, reviews));
  const stale = EVIDENCE_STEPS.filter((step) =>
    retained.has(step) && !current.includes(step));
  const disposition = dispositionState(retained, reviews, triageCurrent);

  let next: EvidenceAssessment["next"];
  let reentry = false;
  let editorialRevision = false;
  let gatePending = false;
  const acceptedReentry = disposition.accepted &&
    state.step === "triage" &&
    state.status === "succeeded";
  // Editorial-only acceptance authorizes a produce re-entry that keeps review evidence current.
  // The flag clears as soon as the produce artifact declares this triage as its authorizer —
  // at that point the triage is bound to the declared predecessor, not to the subject itself.
  const editorialPending = triageCurrent !== undefined &&
    disposition.complete &&
    triageCurrent.accepted_count === 0 &&
    (triageCurrent.accepted_editorial_count ?? 0) > 0 &&
    boundToSubjectExactly(triageCurrent, subject);
  if (acceptedReentry) {
    reentry = true;
    next = "produce";
  } else if (!current.includes("counter_review")) next = "counter_review";
  else if (constitutionRequired && !current.includes("adjudicate")) {
    // The merged counter-review call installs review and constitution evidence atomically, so a
    // current review set without current constitution evidence is reachable only through repair
    // or an upstream re-approval. The backward-to-produce door is the recovery path.
    reentry = true;
    next = "produce";
  } else if (!current.includes("triage") || !disposition.complete) next = "triage";
  else if (disposition.accepted) {
    next = "triage";
  } else if (editorialPending) {
    // Not a re-entry: the attempt budget and the retained review evidence both survive.
    editorialRevision = true;
    next = "produce";
  } else {
    const adjudication = adjudicationAt(retained);
    const gates = adjudication === undefined
      ? []
      : selectAdjudicationGates(subject.constitution.rules, adjudication);
    const gate = gates.find((candidate) =>
      !adjudicationGateSatisfied(state, retained, subject, candidate));
    if (gate === undefined) {
      next = "advance";
    } else {
      // The same action covers both halves of the commit/publication crash window:
      // recreate the deterministic gate when absent, or resume the exact open gate.
      gatePending = adjudicationGatePending(state, gate);
      next = "adjudication-gate";
    }
  }

  const exhausted = reentry && state.attempt >= maximum;
  return Object.freeze({
    current: Object.freeze([...current]),
    stale: Object.freeze([...stale]),
    every_finding_dispositioned: disposition.complete,
    blocker_remains: disposition.blocker,
    reentry_required: reentry,
    editorial_revision_required: editorialRevision,
    exhausted,
    adjudication_gate_pending: gatePending,
    next: exhausted ? "attempts-exhausted" : next,
  });
}

/** Refuses an upstream unless durable human approval binds its exact current digest. */
export function requireApprovedUpstreamDigests(
  approvals: readonly ApprovalRef[],
  upstreamDigests: readonly Sha256Digest[],
): readonly Sha256Digest[] {
  const sorted = [...upstreamDigests].sort();
  if (new Set(sorted).size !== sorted.length) {
    throw new TypeError("approved upstream digests must be unique");
  }
  for (const digest of sorted) {
    if (!approvals.some((approval) =>
      approval.gate_kind === "artifact-approval" &&
      approval.subject_digest === digest)) {
      throw new TypeError(`upstream ${digest} lacks current artifact approval`);
    }
  }
  return Object.freeze(sorted);
}

/** A waiver is live only for the exact task-local rule, subject, scope, and task lifetime tuple. */
export function waiverInForce(
  state: TaskStateV1,
  rule: Readonly<{ rule_id: string; rule_version: number }>,
  subjectDigest: Sha256Digest,
  scope: WaiverScope,
): WaiverRef | undefined {
  if (state.terminal !== undefined) return undefined;
  return state.waivers.find((waiver) =>
    waiver.granted &&
    waiver.expires === "task-complete" &&
    waiver.rule_id === rule.rule_id &&
    waiver.rule_version === rule.rule_version &&
    waiver.subject_digest === subjectDigest &&
    waiver.scope.operation === scope.operation &&
    waiver.scope.boundary === scope.boundary);
}

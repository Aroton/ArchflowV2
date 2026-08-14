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
} from "../state/gate-approvals.js";
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
  /**
   * One-hop predecessor selected by durable revision authority. A simple human revision uses the
   * same evidence-preservation rule for documents and implementation outputs; significant
   * revisions never carry this pair.
   */
  review_predecessor?: EditorialPredecessorPair;
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
  const predecessor = subject.review_predecessor ?? subject.editorial_predecessor;
  return predecessor !== undefined &&
    bound.subject_digest === predecessor.subject_digest &&
    bound.input_fingerprint === predecessor.input_fingerprint;
}

function boundToSubjectOrDeclaredPredecessor(
  bound: Readonly<{ subject_digest: Sha256Digest; input_fingerprint: Sha256Digest }>,
  subject: EvidenceSubject,
): boolean {
  return boundToSubjectExactly(bound, subject) || boundToDeclaredPredecessor(bound, subject);
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
    return boundToSubjectOrDeclaredPredecessor(derived, subject) ? derived : undefined;
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
  // Triage and constitution evidence may be bound to the authenticated one-hop predecessor. The
  // constitution review is dispatched with the counter-review, so an editorial or simple human
  // revision re-runs neither; a significant revision supplies no predecessor and resets both.
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

/** The deterministic gate shape an adjudication rule outcome selects. */
type AdjudicationGate = NonNullable<ReturnType<typeof selectAdjudicationGate>>;

/** The retained evidence trio an authenticated approval must bind to satisfy a gate. */
export type RetainedGateEvidence = Readonly<{
  counter_review_digest: Sha256Digest | undefined;
  triage: TriageCandidate | undefined;
  adjudication: AdjudicationEvidence | undefined;
}>;

/**
 * The first binding an authenticated gate approval fails to hold, named after the exact clause
 * so a caller can surface why an approval did not satisfy the gate instead of a bare boolean.
 */
export type GateApprovalBindingFailure =
  | "approval-gate-kind"
  | "approval-subject-digest"
  | "request-gate-kind"
  | "request-subject-digest"
  | "request-context-digest"
  | "request-phase-instance"
  | "decision-context-digest"
  | "decision-envelope-context-digest"
  | "counter-review-evidence-missing"
  | "triage-evidence-missing"
  | "adjudication-evidence-missing"
  | "triage-not-bound-to-subject"
  | "adjudication-not-bound-to-subject"
  | "adjudication-evidence-set-digest"
  | "triage-evidence-set-digest"
  | "counter-review-slot-digest";

/** The durable ApprovalRef must name this exact gate. */
function approvalBindingFailure(
  approval: AuthenticatedGateApproval["approval"],
  gate: AdjudicationGate,
): GateApprovalBindingFailure | undefined {
  if (approval.gate_kind !== gate.kind) return "approval-gate-kind";
  if (approval.subject_digest !== gate.subject_digest) return "approval-subject-digest";
  return undefined;
}

/** The archived request must be the one this gate, context, and phase instance would mint. */
function requestBindingFailure(
  request: AuthenticatedGateApproval["request"],
  gate: AdjudicationGate,
  contextDigest: Sha256Digest,
  phaseInstance: TaskStateV1["phase_instance"],
): GateApprovalBindingFailure | undefined {
  if (request.kind !== gate.kind) return "request-gate-kind";
  if (request.subject_digest !== gate.subject_digest) return "request-subject-digest";
  if (request.context_digest !== contextDigest) return "request-context-digest";
  if (request.phase_instance !== phaseInstance) return "request-phase-instance";
  return undefined;
}

/** The archived decision and its signed envelope must both cite this gate's context. */
function decisionBindingFailure(
  decision: AuthenticatedGateApproval["decision"],
  contextDigest: Sha256Digest,
): GateApprovalBindingFailure | undefined {
  if (decision.context_digest !== contextDigest) return "decision-context-digest";
  if (decision.envelope.context_digest !== contextDigest) return "decision-envelope-context-digest";
  return undefined;
}

/** The retained evidence chain must exist, bind to the subject, and match the request's set. */
function evidenceBindingFailure(
  request: AuthenticatedGateApproval["request"],
  evidence: RetainedGateEvidence,
  subject: EvidenceSubject,
): GateApprovalBindingFailure | undefined {
  const { counter_review_digest: counterDigest, triage, adjudication } = evidence;
  if (counterDigest === undefined) return "counter-review-evidence-missing";
  if (triage === undefined) return "triage-evidence-missing";
  if (adjudication === undefined) return "adjudication-evidence-missing";
  // Both bindings relax to the declared editorial predecessor (one hop): the constitution
  // review is dispatched with the counter-review, so an editorial revision re-runs neither
  // and the gate summary discloses that the evidence evaluated the predecessor bytes.
  if (!boundToSubjectOrDeclaredPredecessor(triage, subject)) return "triage-not-bound-to-subject";
  if (!boundToSubjectOrDeclaredPredecessor(adjudication, subject)) {
    return "adjudication-not-bound-to-subject";
  }
  if (adjudication.source_evidence_set_digest !== request.current_evidence.set_digest) {
    return "adjudication-evidence-set-digest";
  }
  if (request.current_evidence.set_digest !== triage.current_evidence_set_digest) {
    return "triage-evidence-set-digest";
  }
  if (request.current_evidence.slots[0].evidence_digest !== counterDigest) {
    return "counter-review-slot-digest";
  }
  return undefined;
}

/**
 * Evaluates every binding an authenticated approval must hold to satisfy an adjudication gate,
 * returning the first failed binding or undefined when the approval satisfies the gate. Clause
 * order matches the historical single-expression check exactly.
 */
export function gateApprovalBindingFailure(
  authenticated: AuthenticatedGateApproval,
  gate: AdjudicationGate,
  contextDigest: Sha256Digest,
  state: TaskStateV1,
  subject: EvidenceSubject,
  evidence: RetainedGateEvidence,
): GateApprovalBindingFailure | undefined {
  assertAuthenticatedGateApproval(authenticated);
  const { approval, request, decision } = authenticated;
  return approvalBindingFailure(approval, gate) ??
    requestBindingFailure(request, gate, contextDigest, state.phase_instance) ??
    decisionBindingFailure(decision, contextDigest) ??
    evidenceBindingFailure(request, evidence, subject);
}

/**
 * The waiver escape path: a waiverable gate whose every eligible (rule, axis) pair is durably
 * waived. Both axes must be covered — waiving a rule's compliance says nothing about whether its
 * review trigger still applies.
 */
function waiverPathSatisfiesGate(state: TaskStateV1, gate: AdjudicationGate): boolean {
  if (gate.kind !== "constitution-review" || !("eligible_waivers" in gate.context)) return false;
  const required = gate.context.eligible_waivers;
  return required.length > 0 && required.every((eligible) =>
    waiverInForce(
      state,
      eligible.rule,
      gate.subject_digest,
      eligible.scope,
    ) !== undefined);
}

function adjudicationGateSatisfied(
  state: TaskStateV1,
  retained: RetainedEvidenceSet,
  subject: EvidenceSubject,
  gate: AdjudicationGate,
): boolean {
  const phaseKind = state.phase_instance === "design" || state.phase_instance.startsWith("phase-design-");
  if (phaseKind && gate.kind === "constitution-review") {
    const designApproval = (subject.authenticated_gate_approvals ?? []).some((authenticated) => {
      assertAuthenticatedGateApproval(authenticated);
      return authenticated.approval.gate_kind === "design-approval" &&
        authenticated.approval.subject_digest === subject.subject_digest &&
        authenticated.request.kind === "design-approval" &&
        authenticated.request.phase_instance === state.phase_instance &&
        authenticated.request.subject_digest === subject.subject_digest &&
        authenticated.request.current_evidence.set_digest === deriveCurrentEvidenceSet(retained).current_evidence_set.set_digest &&
        authenticated.decision.envelope.payload.decision === "approve";
    });
    if (designApproval) return true;
  }
  const contextDigest = computeGateContextDigest(gate.kind, gate.context);
  const evidence: RetainedGateEvidence = Object.freeze({
    counter_review_digest: retained.get("counter_review")?.manifest.artifact_digest,
    triage: triageAt(retained),
    adjudication: adjudicationAt(retained),
  });
  const approvalSatisfies = (subject.authenticated_gate_approvals ?? []).some((authenticated) =>
    gateApprovalBindingFailure(
      authenticated, gate, contextDigest, state, subject, evidence,
    ) === undefined);
  return approvalSatisfies || waiverPathSatisfiesGate(state, gate);
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

type TriageDispositionState = Readonly<{
  complete: boolean;
  blocker: boolean;
  accepted: boolean;
}>;

function dispositionState(
  retained: RetainedEvidenceSet,
  reviews: DerivedCurrentEvidenceSet | undefined,
  triage: TriageCandidate | undefined,
): TriageDispositionState {
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

/** The pinned constitution and any retained adjudication must match durable state's digests. */
function assertSubjectMatchesDurableState(
  state: TaskStateV1,
  retained: RetainedEvidenceSet,
  subject: EvidenceSubject,
): void {
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
}

function resolveMaxAttempts(subject: EvidenceSubject): number {
  const maximum = subject.max_attempts ?? DEFAULT_MAX_ATTEMPTS;
  if (!Number.isSafeInteger(maximum) || maximum < 1) {
    throw new TypeError("max_attempts must be a positive safe integer");
  }
  return maximum;
}

function constitutionReviewRequired(constitution: ResolvedConstitution): boolean {
  return [...constitution.rules.values()].some((rule) => rule.status === "active");
}

/** Accepted findings after the triage step itself succeeded force a full produce re-entry. */
function acceptedFindingsForceReentry(
  state: TaskStateV1,
  disposition: TriageDispositionState,
): boolean {
  return disposition.accepted &&
    state.step === "triage" &&
    state.status === "succeeded";
}

/**
 * Editorial-only acceptance authorizes a produce re-entry that keeps review evidence current.
 * The flag clears as soon as the produce artifact declares this triage as its authorizer —
 * at that point the triage is bound to the declared predecessor, not to the subject itself.
 */
function editorialRevisionPending(
  triageCurrent: TriageCandidate | undefined,
  disposition: TriageDispositionState,
  subject: EvidenceSubject,
): boolean {
  return triageCurrent !== undefined &&
    disposition.complete &&
    triageCurrent.accepted_count === 0 &&
    (triageCurrent.accepted_editorial_count ?? 0) > 0 &&
    boundToSubjectExactly(triageCurrent, subject);
}

/** The chain's outcome before attempt exhaustion is applied on top. */
type NextActionDecision = Readonly<{
  next: Exclude<EvidenceAssessment["next"], "attempts-exhausted">;
  reentry_required: boolean;
  editorial_revision_required: boolean;
  adjudication_gate_pending: boolean;
}>;

function decision(
  next: NextActionDecision["next"],
  flags?: Partial<Omit<NextActionDecision, "next">>,
): NextActionDecision {
  return Object.freeze({
    next,
    reentry_required: flags?.reentry_required ?? false,
    editorial_revision_required: flags?.editorial_revision_required ?? false,
    adjudication_gate_pending: flags?.adjudication_gate_pending ?? false,
  });
}

/** Every adjudication gate satisfied advances; otherwise surface the first unmet gate. */
function resolveAdjudicationGateStep(
  state: TaskStateV1,
  retained: RetainedEvidenceSet,
  subject: EvidenceSubject,
): NextActionDecision {
  const adjudication = adjudicationAt(retained);
  const gates = adjudication === undefined
    ? []
    : selectAdjudicationGates(subject.constitution.rules, adjudication);
  const gate = gates.find((candidate) =>
    !adjudicationGateSatisfied(state, retained, subject, candidate));
  if (gate === undefined) return decision("advance");
  // The same action covers both halves of the commit/publication crash window:
  // recreate the deterministic gate when absent, or resume the exact open gate.
  return decision("adjudication-gate", {
    adjudication_gate_pending: adjudicationGatePending(state, gate),
  });
}

/** Walks the fixed-point decision chain in priority order; each step is named above. */
function decideNextAction(
  state: TaskStateV1,
  retained: RetainedEvidenceSet,
  subject: EvidenceSubject,
  current: readonly PipelineStep[],
  disposition: TriageDispositionState,
  triageCurrent: TriageCandidate | undefined,
): NextActionDecision {
  if (acceptedFindingsForceReentry(state, disposition)) {
    return decision("produce", { reentry_required: true });
  }
  if (!current.includes("counter_review")) return decision("counter_review");
  if (constitutionReviewRequired(subject.constitution) && !current.includes("adjudicate")) {
    // The merged counter-review call installs review and constitution evidence atomically, so a
    // current review set without current constitution evidence is reachable only through repair
    // or an upstream re-approval. The backward-to-produce door is the recovery path.
    return decision("produce", { reentry_required: true });
  }
  if (!current.includes("triage") || !disposition.complete) return decision("triage");
  if (disposition.accepted) return decision("triage");
  if (editorialRevisionPending(triageCurrent, disposition, subject)) {
    // Not a re-entry: the attempt budget and the retained review evidence both survive.
    return decision("produce", { editorial_revision_required: true });
  }
  return resolveAdjudicationGateStep(state, retained, subject);
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
  assertSubjectMatchesDurableState(state, retained, subject);
  const maximum = resolveMaxAttempts(subject);
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
  const action = decideNextAction(state, retained, subject, current, disposition, triageCurrent);
  const exhausted = action.reentry_required && state.attempt >= maximum;
  return Object.freeze({
    current: Object.freeze([...current]),
    stale: Object.freeze([...stale]),
    every_finding_dispositioned: disposition.complete,
    blocker_remains: disposition.blocker,
    reentry_required: action.reentry_required,
    editorial_revision_required: action.editorial_revision_required,
    exhausted,
    adjudication_gate_pending: action.adjudication_gate_pending,
    next: exhausted ? "attempts-exhausted" : action.next,
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
      (approval.gate_kind === "artifact-approval" || approval.gate_kind === "design-approval") &&
      approval.subject_digest === digest)) {
      throw new TypeError(`upstream ${digest} lacks current document approval`);
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

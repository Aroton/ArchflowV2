import type { AdjudicationEvidence } from "../contracts/adjudication.js";
import type { ResultManifestV1 } from "../contracts/durable-result-manifest.js";
import type {
  TaskStateV1,
  WaiverRef,
} from "../contracts/durable-state.js";
import { parseSafeInteger, type SafeInteger, type Sha256Digest } from "../contracts/evidence.js";
import {
  REVIEW_PUSH_THROUGH_MIN_ATTEMPT,
  type ReviewAcceptedOccurrenceV1,
  type ReviewPushThroughContextV1,
  type WaiverScope,
} from "../contracts/gates.js";
import { isSubstantiveClaim, type ReviewEvidence } from "../contracts/review.js";
import type { TriageCandidate } from "../contracts/triage.js";
import type { PipelineStep } from "../contracts/vocabulary.js";
import { computeGateContextDigest } from "../contracts/fingerprints.js";
import {
  deriveCurrentEvidenceSet,
  retainedReviewEnvelopeDigest,
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
  gateDeclaredByReviewTrigger,
} from "./adjudication.js";
import { decodePhaseInstance } from "../contracts/phase-instance.js";

export const DEFAULT_MAX_ATTEMPTS = 3;
export { REVIEW_PUSH_THROUGH_MIN_ATTEMPT };

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
  /**
   * Opaque values minted by the durable review-push-through loader. The fixed point never reads a
   * plain state record: the loader-owned callback must authenticate and project each value before
   * it can participate in the exact-current match below.
   */
  review_push_through_authority?: ReviewPushThroughAuthoritySource;
  max_attempts?: number;
}>;

/** Exact authority facts exposed only after a dedicated loader authenticates state and archive. */
export type AuthenticatedReviewPushThroughFacts = Readonly<{
  task_id: TaskStateV1["task_id"];
  phase_instance: TaskStateV1["phase_instance"];
  attempt: SafeInteger;
  subject_digest: Sha256Digest;
  current_evidence_set_digest: Sha256Digest;
  triage_result_digest: Sha256Digest;
  accepted_occurrences: readonly ReviewAcceptedOccurrenceV1[];
}>;

/** Adapter implemented by the future branded loader; opaque values are unusable without it. */
export type ReviewPushThroughAuthoritySource = Readonly<{
  values: readonly unknown[];
  authenticate: (value: unknown) => AuthenticatedReviewPushThroughFacts;
}>;

/** Exact live review/triage tuple a gate request may bind after exhaustion is established. */
export type ReviewPushThroughCandidate = Readonly<{
  attempt: SafeInteger;
  review_round_count: SafeInteger;
  subject_digest: Sha256Digest;
  context: ReviewPushThroughContextV1;
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
  escalated_human_findings?: boolean;
  /**
   * The retained constitution review left agent-resolvable findings — a rule the artifact does
   * not demonstrably meet, or material drift from an approved upstream — and attempts remain:
   * the next produce re-entry resolves them. Their gates open only once attempts run out, or at
   * once when a rule's own `review_trigger` matched (the repository asked for a human).
   */
  policy_reentry_required?: boolean;
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
  state: TaskStateV1,
  retained: RetainedEvidenceSet,
  subject: EvidenceSubject,
): DerivedCurrentEvidenceSet | undefined {
  try {
    const derived = deriveCurrentEvidenceSet(retained);
    // Phase designs never inherit review currency across an editorial or simple-human revision:
    // effort assessment belongs to the complete component set on the exact current bytes. Other
    // phase kinds retain the established one-hop predecessor behavior.
    const phaseDesign = state.phase_instance.startsWith("phase-design-");
    const current = phaseDesign
      ? boundToSubjectExactly(derived, subject)
      : boundToSubjectOrDeclaredPredecessor(derived, subject);
    if (!current) return undefined;
    if (phaseDesign) {
      const counter = derived.reviews[0]?.evidence;
      const effort = counter?.assurance === "server-attested"
        ? counter.effort_review
        : undefined;
      // Absence is the explicit legacy classification for exact unchanged archived evidence.
      // Every fresh mint is required to carry effort; a present record that disagrees on any
      // round binding is invalid rather than being downgraded to legacy.
      if (effort !== undefined && (
        effort.task_id !== state.task_id ||
        effort.phase_instance !== state.phase_instance ||
        effort.attempt !== state.attempt ||
        !boundToSubjectExactly(effort, subject)
      )) return undefined;
    }
    return derived;
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
    // The constitution review binds to the round by the review envelope it was commissioned
    // with: the digest is stamped before either child dispatches, and the retained
    // server-attested review evidence carries it as envelope_input_digest — the same currency
    // proof a payload-derived set digest gave, computable before dispatch.
    const currentReview = reviews.reviews[0]?.evidence;
    const currentEnvelopeDigest = currentReview !== undefined && currentReview.assurance === "server-attested"
      ? currentReview.envelope_input_digest
      : undefined;
    return currentEnvelopeDigest !== undefined &&
      adjudication.source_review_envelope_digest === currentEnvelopeDigest &&
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
  /** Envelope digest of the retained server-attested counter review; undefined when it is absent or degraded. */
  counter_review_envelope_digest: Sha256Digest | undefined;
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
  // A baseline-adoption approval cites the drift observation, not a review set; it can never
  // satisfy an adjudication gate's evidence binding.
  if (request.kind === "baseline-adoption" || request.kind === "validation-override") {
    return "request-gate-kind";
  }
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
  // Round binding: the adjudication must belong to the exact retained review round the
  // request's evidence set was derived from (its slots bind that set to the review digest).
  if (adjudication.source_review_envelope_digest !== evidence.counter_review_envelope_digest) {
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
  const designPhase = state.phase_instance === "design" || state.phase_instance.startsWith("phase-design-");
  if (gate.kind === "constitution-review") {
    const hasActivePolicyIssues = !("policy_findings" in gate.context) ||
      (gate.context as Record<string, unknown>).constitution !== "pass" ||
      ((gate.context as Record<string, unknown>).policy_findings as readonly any[]).some((f) => f.compliance !== "pass" || f.trigger !== "not-matched");
    if (hasActivePolicyIssues) {
      const ordinaryKind = state.phase_instance === "prd"
        ? "artifact-approval"
        : designPhase
          ? "design-approval"
          : state.phase_instance.startsWith("phase-impl-")
            ? "commit-authorization"
            : undefined;
      let evidenceSetDigest: string;
      try {
        evidenceSetDigest = deriveCurrentEvidenceSet(retained).current_evidence_set.set_digest;
      } catch {
        evidenceSetDigest = "";
      }
      const ordinaryApproval = ordinaryKind !== undefined && evidenceSetDigest !== "" &&
        (subject.authenticated_gate_approvals ?? []).some((authenticated) => {
        assertAuthenticatedGateApproval(authenticated);
        const decision = authenticated.decision.envelope.payload.decision;
        return authenticated.approval.gate_kind === ordinaryKind &&
          authenticated.approval.subject_digest === subject.subject_digest &&
          authenticated.request.kind === ordinaryKind &&
          authenticated.request.phase_instance === state.phase_instance &&
          authenticated.request.subject_digest === subject.subject_digest &&
          authenticated.request.current_evidence.set_digest === evidenceSetDigest &&
          (decision === "approve" || decision === "authorize-commit");
      });
      // A migration-audit acceptance is the combined approval for imported design phases:
      // it replaces the separate PRD and design-approval gates and satisfies this gate alike.
      const migrationApproval = designPhase && evidenceSetDigest !== "" && (subject.authenticated_gate_approvals ?? []).some((authenticated) => {
        assertAuthenticatedGateApproval(authenticated);
        return authenticated.approval.gate_kind === "migration-audit" &&
          authenticated.approval.subject_digest === subject.subject_digest &&
          authenticated.request.kind === "migration-audit" &&
          authenticated.request.phase_instance === state.phase_instance &&
          authenticated.request.subject_digest === subject.subject_digest &&
          authenticated.request.current_evidence.set_digest === evidenceSetDigest &&
          authenticated.decision.envelope.payload.decision === "accept-import-audit";
      });
      if (ordinaryApproval || migrationApproval) return true;
    }
  }
  const contextDigest = computeGateContextDigest(gate.kind, gate.context);
  const evidence: RetainedGateEvidence = Object.freeze({
    counter_review_digest: retained.get("counter_review")?.manifest.artifact_digest,
    counter_review_envelope_digest: retainedReviewEnvelopeDigest(retained),
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

function escalationSettled(
  state: TaskStateV1,
  retained: RetainedEvidenceSet,
  subject: EvidenceSubject,
): boolean {
  const phase = decodePhaseInstance(state.phase_instance);
  const ordinaryKind = phase.kind === "prd"
    ? "artifact-approval"
    : phase.kind === "design" || phase.kind === "phase-design"
      ? "design-approval"
      : phase.kind === "phase-impl"
        ? "commit-authorization"
        : undefined;
  if (ordinaryKind === undefined) return false;
  let evidenceSetDigest: string;
  try {
    evidenceSetDigest = deriveCurrentEvidenceSet(retained).current_evidence_set.set_digest;
  } catch {
    return false;
  }

  return (subject.authenticated_gate_approvals ?? []).some((authenticated) => {
    assertAuthenticatedGateApproval(authenticated);
    const decision = authenticated.decision.envelope.payload.decision;
    const isMatchingDecision = decision === "approve" || decision === "authorize-commit";
    const isMatchingScope = authenticated.approval.gate_kind === ordinaryKind &&
      authenticated.approval.subject_digest === subject.subject_digest &&
      authenticated.request.kind === ordinaryKind &&
      authenticated.request.phase_instance === state.phase_instance &&
      authenticated.request.subject_digest === subject.subject_digest &&
      authenticated.request.current_evidence.set_digest === evidenceSetDigest;
    return isMatchingDecision && isMatchingScope;
  });
}

type TriageDispositionState = Readonly<{
  complete: boolean;
  blocker: boolean;
  accepted: boolean;
  escalated_human: boolean;
  deferred: boolean;
}>;

function dispositionState(
  retained: RetainedEvidenceSet,
  reviews: DerivedCurrentEvidenceSet | undefined,
  triage: TriageCandidate | undefined,
): TriageDispositionState {
  if (reviews === undefined || triage === undefined) {
    return Object.freeze({ complete: false, blocker: false, accepted: false, escalated_human: false, deferred: false });
  }
  const expected = new Map<string, boolean>();
  for (const review of reviews.reviews) {
    for (const finding of review.evidence.findings) {
      expected.set(`${review.evidence_digest}:${finding.finding_id}`, isSubstantiveClaim(finding));
    }
  }
  if (expected.size === 0) {
    return Object.freeze({ complete: true, blocker: false, accepted: false, escalated_human: false, deferred: false });
  }
  const actual = new Map(triage.dispositions.map((item) => [
    `${item.review_evidence_digest}:${item.finding_id}`,
    item.disposition,
  ]));
  const complete = actual.size === expected.size &&
    [...expected.keys()].every((key) => actual.has(key));
  const blocker = [...expected].some(([key, substantive]) => {
    const disp = actual.get(key);
    return substantive && disp !== "rejected" && disp !== "deferred";
  });
  const accepted = (triage.accepted_count ?? 0) > 0;
  const escalatedHuman = (triage.escalated_human_count ?? 0) > 0 ||
    [...actual.values()].some((disp) => disp === "escalated-human");
  const deferred = (triage.deferred_count ?? 0) > 0 ||
    [...actual.values()].some((disp) => disp === "deferred");
  return Object.freeze({
    complete,
    blocker,
    accepted,
    escalated_human: escalatedHuman,
    deferred,
  });
}

const acceptedOccurrenceKey = (occurrence: ReviewAcceptedOccurrenceV1): string =>
  `${occurrence.review_evidence_digest}:${occurrence.finding_id}`;

const compareAcceptedOccurrencesForGate = (
  left: ReviewAcceptedOccurrenceV1,
  right: ReviewAcceptedOccurrenceV1,
): number => left.review_evidence_digest.localeCompare(right.review_evidence_digest) ||
  left.finding_id.localeCompare(right.finding_id);

/**
 * Derives the exact current accepted-finding tuple independently of the durable attempt counter.
 * The caller still establishes that the attempts-exhausted boundary was reached; this helper owns
 * the stronger eligibility facts that only completed server-recorded review rounds can supply.
 */
export function deriveReviewPushThroughCandidate(
  state: TaskStateV1,
  retained: RetainedEvidenceSet,
  subject: EvidenceSubject,
): ReviewPushThroughCandidate | undefined {
  assertSubjectMatchesDurableState(state, retained, subject);
  if (state.step !== "triage" || state.status !== "succeeded") return undefined;
  const reviews = currentReviewSet(state, retained, subject);
  const triage = triageAt(retained);
  if (reviews === undefined || triage === undefined ||
      !currentFor(retained, "triage", subject, reviews)) return undefined;
  const disposition = dispositionState(retained, reviews, triage);
  if (!disposition.complete || !disposition.accepted) return undefined;

  const currentOccurrences = new Set<string>();
  for (const review of reviews.reviews) {
    for (const finding of review.evidence.findings) {
      currentOccurrences.add(acceptedOccurrenceKey({
        review_evidence_digest: review.evidence_digest,
        finding_id: finding.finding_id,
      }));
    }
  }
  const accepted = triage.dispositions
    .filter((item) => item.disposition === "accepted")
    .map((item) => Object.freeze({
      review_evidence_digest: item.review_evidence_digest,
      finding_id: item.finding_id,
    }));
  if (accepted.length === 0 || accepted.some((item) =>
    !currentOccurrences.has(acceptedOccurrenceKey(item)))) return undefined;
  accepted.sort(compareAcceptedOccurrencesForGate);

  const history = triage.review_round_history;
  const currentReviewDigest = reviews.reviews[0]?.evidence_digest;
  if (history === undefined || currentReviewDigest === undefined ||
      history.length < REVIEW_PUSH_THROUGH_MIN_ATTEMPT ||
      history.some((entry, index) =>
        entry.attempt > state.attempt ||
        (index > 0 && history[index - 1]!.attempt >= entry.attempt)) ||
      !history.some((entry) =>
        entry.attempt === state.attempt && entry.review_evidence_digest === currentReviewDigest)) {
    return undefined;
  }

  return Object.freeze({
    attempt: state.attempt,
    review_round_count: parseSafeInteger(history.length),
    subject_digest: subject.subject_digest,
    context: Object.freeze({
      minimum_attempt: REVIEW_PUSH_THROUGH_MIN_ATTEMPT,
      current_evidence_set_digest: reviews.current_evidence_set.set_digest,
      triage_result_digest: retained.get("triage")!.reference.result_digest,
      accepted_occurrences: Object.freeze(accepted),
    }),
  });
}

function exactOccurrenceSet(
  left: readonly ReviewAcceptedOccurrenceV1[],
  right: readonly ReviewAcceptedOccurrenceV1[],
): boolean {
  if (left.length !== right.length) return false;
  const leftKeys = new Set(left.map(acceptedOccurrenceKey));
  if (leftKeys.size !== left.length) return false;
  const rightKeys = new Set(right.map(acceptedOccurrenceKey));
  return rightKeys.size === right.length && [...leftKeys].every((key) => rightKeys.has(key));
}

/** Exact current-tuple match used after, and only after, the caller authenticates durable authority. */
export function reviewPushThroughAuthorityMatchesCandidate(
  state: TaskStateV1,
  candidate: ReviewPushThroughCandidate,
  authority: AuthenticatedReviewPushThroughFacts,
): boolean {
  return authority.task_id === state.task_id &&
    authority.phase_instance === state.phase_instance &&
    authority.attempt === candidate.attempt &&
    authority.subject_digest === candidate.subject_digest &&
    authority.current_evidence_set_digest === candidate.context.current_evidence_set_digest &&
    authority.triage_result_digest === candidate.context.triage_result_digest &&
    exactOccurrenceSet(authority.accepted_occurrences, candidate.context.accepted_occurrences);
}

/** Plain state records are intentionally insufficient; every value crosses the loader's assert. */
export function authenticatedReviewPushThroughSettlesCandidate(
  state: TaskStateV1,
  candidate: ReviewPushThroughCandidate,
  source: ReviewPushThroughAuthoritySource | undefined,
): boolean {
  if (source === undefined) return false;
  return source.values.some((value) =>
    reviewPushThroughAuthorityMatchesCandidate(state, candidate, source.authenticate(value)));
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
  acceptedSettled: boolean,
): boolean {
  return triageCurrent !== undefined &&
    disposition.complete &&
    (triageCurrent.accepted_count === 0 || acceptedSettled) &&
    (triageCurrent.accepted_editorial_count ?? 0) > 0 &&
    (triageCurrent.escalated_human_count ?? 0) === 0 &&
    boundToSubjectExactly(triageCurrent, subject);
}

/** The chain's outcome before attempt exhaustion is applied on top. */
type NextActionDecision = Readonly<{
  next: Exclude<EvidenceAssessment["next"], "attempts-exhausted">;
  reentry_required: boolean;
  editorial_revision_required: boolean;
  escalated_human_findings?: boolean;
  policy_reentry_required?: boolean;
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
    ...(flags?.escalated_human_findings === true ? { escalated_human_findings: true } : {}),
    ...(flags?.policy_reentry_required === true ? { policy_reentry_required: true } : {}),
    adjudication_gate_pending: flags?.adjudication_gate_pending ?? false,
  });
}

/**
 * Every adjudication gate satisfied advances. An unmet gate is a human decision only when the
 * repository asked for one — a rule's own `review_trigger` matched — or when the agent's attempt
 * budget is spent; otherwise the findings (a rule the artifact does not meet, material drift from
 * an approved upstream) are producer work and the fixed point re-enters production with them.
 */
function resolveAdjudicationGateStep(
  state: TaskStateV1,
  retained: RetainedEvidenceSet,
  subject: EvidenceSubject,
  maximum: number,
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
  const pending = adjudicationGatePending(state, gate);
  if (!pending && !gateDeclaredByReviewTrigger(gate) && state.attempt < maximum) {
    return decision("produce", { reentry_required: true, policy_reentry_required: true });
  }
  return decision("adjudication-gate", { adjudication_gate_pending: pending });
}

/** Walks the fixed-point decision chain in priority order; each step is named above. */
function decideNextAction(
  state: TaskStateV1,
  retained: RetainedEvidenceSet,
  subject: EvidenceSubject,
  current: readonly PipelineStep[],
  disposition: TriageDispositionState,
  triageCurrent: TriageCandidate | undefined,
  maximum: number,
  acceptedSettled: boolean,
): NextActionDecision {
  let currentEvidenceSetDigest: string | undefined;
  try {
    currentEvidenceSetDigest = deriveCurrentEvidenceSet(retained).current_evidence_set.set_digest;
  } catch {
    currentEvidenceSetDigest = undefined;
  }
  const isTriageFreshForRound =
    current.includes("triage") &&
    triageCurrent !== undefined &&
    boundToSubjectExactly(triageCurrent, subject) &&
    currentEvidenceSetDigest !== undefined &&
    triageCurrent.current_evidence_set_digest === currentEvidenceSetDigest;

  if (isTriageFreshForRound && disposition.escalated_human && !escalationSettled(state, retained, subject)) {
    const adjudicationStep = resolveAdjudicationGateStep(state, retained, subject, maximum);
    if (adjudicationStep.next !== "advance") {
      return decision("adjudication-gate", {
        escalated_human_findings: true,
        adjudication_gate_pending: true,
      });
    }
    return decision("advance", { escalated_human_findings: true });
  }

  if (
    isTriageFreshForRound &&
    ((acceptedFindingsForceReentry(state, disposition) && !acceptedSettled) ||
     (escalationSettled(state, retained, subject) && (triageCurrent.accepted_editorial_count ?? 0) > 0))
  ) {
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
  // A simple human revision is wording/formatting-only by definition. It cannot satisfy or
  // erase an accepted material finding from the retained review, even when its one-hop
  // predecessor proof is exact. Material findings require a significant revision and fresh
  // review; otherwise triage remains the fail-closed action.
  if (disposition.accepted && !acceptedSettled) return decision("triage");
  if (editorialRevisionPending(triageCurrent, disposition, subject, acceptedSettled)) {
    if (state.phase_instance !== "prd" && state.phase_instance !== "design") {
      // Non-document positions stay bound to exact bytes and force full re-entry.
      return decision("produce", { reentry_required: true });
    }
    // Not a re-entry: the attempt budget and the retained review evidence both survive.
    return decision("produce", { editorial_revision_required: true });
  }
  return resolveAdjudicationGateStep(state, retained, subject, maximum);
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
  const reviews = currentReviewSet(state, retained, subject);
  const candidateTriage = triageAt(retained);
  const triageCurrent = currentFor(
    retained, "triage", subject, reviews,
  ) ? candidateTriage : undefined;
  const current = EVIDENCE_STEPS.filter((step) =>
    currentFor(retained, step, subject, reviews));
  const stale = EVIDENCE_STEPS.filter((step) =>
    retained.has(step) && !current.includes(step));
  const disposition = dispositionState(retained, reviews, triageCurrent);
  const pushThroughCandidate = deriveReviewPushThroughCandidate(state, retained, subject);
  const acceptedSettled = pushThroughCandidate !== undefined &&
    authenticatedReviewPushThroughSettlesCandidate(
      state,
      pushThroughCandidate,
      subject.review_push_through_authority,
    );
  const action = decideNextAction(
    state, retained, subject, current, disposition, triageCurrent, maximum, acceptedSettled,
  );
  const exhausted = action.reentry_required && state.attempt >= maximum;
  return Object.freeze({
    current: Object.freeze([...current]),
    stale: Object.freeze([...stale]),
    every_finding_dispositioned: disposition.complete,
    blocker_remains: disposition.blocker && (!acceptedSettled || disposition.escalated_human),
    reentry_required: action.reentry_required,
    editorial_revision_required: action.editorial_revision_required,
    ...(action.escalated_human_findings === true ? { escalated_human_findings: true } : {}),
    ...(action.policy_reentry_required === true ? { policy_reentry_required: true } : {}),
    exhausted,
    adjudication_gate_pending: action.adjudication_gate_pending,
    next: exhausted ? "attempts-exhausted" : action.next,
  });
}

/**
 * Normalizes the digests of upstreams whose authority was already authenticated with their exact
 * producer phases by the shared loader/caller. The two-argument form remains for legacy callers
 * that have only approval references; new settlement-aware callers must not discard the producer
 * phase and then repeat this digest-only human scan.
 */
export function requireApprovedUpstreamDigests(
  authenticatedUpstreams: readonly Readonly<{
    subject_digest: Sha256Digest;
    producer_phase: TaskStateV1["phase_instance"];
  }>[],
): readonly Sha256Digest[];
export function requireApprovedUpstreamDigests(
  state: TaskStateV1,
  upstreamDigests: readonly Sha256Digest[],
): readonly Sha256Digest[];
export function requireApprovedUpstreamDigests(
  stateOrDigests: TaskStateV1 | readonly Readonly<{
    subject_digest: Sha256Digest;
    producer_phase: TaskStateV1["phase_instance"];
  }>[],
  legacyDigests?: readonly Sha256Digest[],
): readonly Sha256Digest[] {
  const upstreamDigests = legacyDigests ??
    (stateOrDigests as readonly Readonly<{ subject_digest: Sha256Digest }>[])
      .map((authority) => authority.subject_digest);
  const sorted = [...upstreamDigests].sort();
  if (new Set(sorted).size !== sorted.length) {
    throw new TypeError("approved upstream digests must be unique");
  }
  if (legacyDigests === undefined) return Object.freeze(sorted);
  const state = stateOrDigests as TaskStateV1;
  for (const digest of sorted) {
    const approved = state.approvals.some((approval) =>
      (approval.gate_kind === "artifact-approval" || approval.gate_kind === "design-approval") &&
      approval.subject_digest === digest);
    if (!approved) {
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

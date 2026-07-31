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
  "self_review",
  "counter_review",
  "triage",
  "adjudicate",
] as const);

export type EvidenceSubject = Readonly<{
  subject_digest: Sha256Digest;
  input_fingerprint: Sha256Digest;
  constitution: ResolvedConstitution;
  authenticated_gate_approvals?: readonly AuthenticatedGateApproval[];
  max_attempts?: number;
}>;

export type EvidenceAssessment = Readonly<{
  current: readonly PipelineStep[];
  stale: readonly PipelineStep[];
  every_finding_dispositioned: boolean;
  blocker_remains: boolean;
  reentry_required: boolean;
  exhausted: boolean;
  adjudication_gate_pending: boolean;
  next:
    | "self_review"
    | "counter_review"
    | "triage"
    | "adjudicate"
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

function subjectCurrent(
  evidence: ReviewEvidence | TriageCandidate | AdjudicationEvidence | undefined,
  subject: EvidenceSubject,
): boolean {
  return evidence !== undefined &&
    evidence.subject_digest === subject.subject_digest &&
    evidence.input_fingerprint === subject.input_fingerprint;
}

function currentReviewSet(
  retained: RetainedEvidenceSet,
  subject: EvidenceSubject,
): DerivedCurrentEvidenceSet | undefined {
  try {
    const derived = deriveCurrentEvidenceSet(retained);
    return derived.subject_digest === subject.subject_digest &&
      derived.input_fingerprint === subject.input_fingerprint
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
  currentTriage: TriageCandidate | undefined,
): boolean {
  if (step === "self_review" || step === "counter_review") return reviews !== undefined;
  const entry = retained.get(step);
  const evidence = entry === undefined ? undefined : evidencePayload(entry.manifest);
  if (!subjectCurrent(evidence, subject) || reviews === undefined) return false;
  if (step === "triage") {
    const triage = evidence as TriageCandidate;
    return triage.current_evidence_set_digest === reviews.current_evidence_set.set_digest &&
      triage.source_evidence_digests.length === reviews.current_evidence_set.slots.length &&
      triage.source_evidence_digests.every((digest, index) =>
        digest === reviews.current_evidence_set.slots[index]!.evidence_digest);
  }
  if (step === "adjudicate") {
    const adjudication = evidence as AdjudicationEvidence;
    return currentTriage !== undefined &&
      adjudication.source_evidence_set_digest === reviews.current_evidence_set.set_digest;
  }
  return false;
}

function reviewAt(retained: RetainedEvidenceSet, step: "self_review" | "counter_review"):
  ReviewEvidence | undefined {
  const source = retained.get(step)?.manifest.source_artifact;
  return source?.artifact_kind === "review-evidence" ? source.evidence : undefined;
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
  const selfDigest = retained.get("self_review")?.manifest.artifact_digest;
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
      selfDigest === undefined ||
      counterDigest === undefined ||
      triage === undefined ||
      adjudication === undefined ||
      triage.subject_digest !== subject.subject_digest ||
      triage.input_fingerprint !== subject.input_fingerprint ||
      adjudication.subject_digest !== subject.subject_digest ||
      adjudication.input_fingerprint !== subject.input_fingerprint ||
      adjudication.source_evidence_set_digest !== request.current_evidence.set_digest ||
      request.current_evidence.set_digest !== triage.current_evidence_set_digest ||
      request.current_evidence.slots[0].evidence_digest !== selfDigest ||
      request.current_evidence.slots[1].evidence_digest !== counterDigest
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
  const self = reviews?.reviews[0]?.evidence;
  const counter = reviews?.reviews[1]?.evidence;
  if (
    reviews === undefined ||
    self === undefined ||
    counter === undefined ||
    triage === undefined
  ) {
    return Object.freeze({ complete: false, blocker: false, accepted: false });
  }
  const reviewSet = reviews;
  const expected = new Map<string, boolean>();
  for (const review of [self, counter]) {
    for (const finding of review.findings) {
      const digest = review === self
        ? reviewSet.current_evidence_set.slots[0].evidence_digest
        : reviewSet.current_evidence_set.slots[1].evidence_digest;
      expected.set(`${digest}:${finding.finding_id}`, finding.blocking);
    }
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
  const reviews = currentReviewSet(retained, subject);
  const candidateTriage = triageAt(retained);
  const triageCurrent = currentFor(
    retained, "triage", subject, reviews, undefined,
  ) ? candidateTriage : undefined;
  const current = EVIDENCE_STEPS.filter((step) =>
    currentFor(retained, step, subject, reviews, triageCurrent));
  const stale = EVIDENCE_STEPS.filter((step) =>
    retained.has(step) && !current.includes(step));
  const disposition = dispositionState(retained, reviews, triageCurrent);

  let next: EvidenceAssessment["next"];
  let reentry = false;
  let gatePending = false;
  const acceptedReentry = disposition.accepted &&
    state.step === "triage" &&
    state.status === "succeeded";
  const staleAdjudicationReentry =
    retained.has("adjudicate") &&
    !current.includes("adjudicate") &&
    state.step === "adjudicate" &&
    state.status === "succeeded";
  if (acceptedReentry || staleAdjudicationReentry) {
    reentry = true;
    next = "produce";
  } else if (!current.includes("self_review")) next = "self_review";
  else if (!current.includes("counter_review")) next = "counter_review";
  else if (!current.includes("triage") || !disposition.complete) next = "triage";
  else if (disposition.accepted) {
    next = "triage";
  } else if (!current.includes("adjudicate")) {
    next = "adjudicate";
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

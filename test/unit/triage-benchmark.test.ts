import { arch, cpus, platform } from "node:os";
import { performance } from "node:perf_hooks";

import { describe, expect, it } from "vitest";

import { parseActiveGate, type ActiveGateV1 } from "../../src/contracts/durable-gate.js";
import { parseSha256Digest, parseTaskSlug } from "../../src/contracts/evidence.js";
import { computeGateContextDigest } from "../../src/contracts/fingerprints.js";
import {
  createTestAuthorityLink,
  createTestCurrentReviewSetAuthority,
  createTestVerifiedReferencedEvidence,
} from "../../src/contracts/internal/test-capabilities.js";
import { encodePhaseInstance } from "../../src/contracts/phase-instance.js";
import {
  CLAIM_TYPES,
  CONFIDENCE_LEVELS,
  computeFindingPartitionCounts,
  type ReviewFindingV2,
} from "../../src/contracts/review.js";
import { authorityQualifier, currentEvidenceSetRef, type QualifiedReviewEvidence } from "../../src/contracts/trust.js";
import { validateTriage, type TriageDisposition } from "../../src/contracts/triage.js";
import { buildHumanGatePresentation } from "../../src/state/gates.js";

const LATENCY_LIMIT_MS = 100;
const WARMUP_ITERATIONS = 10;
const MEASURED_SAMPLES = 40;
const PERCENTILE = 0.95;
const VALIDATION_OVERRIDE_ITEM_COUNT = 32;
const PUSH_THROUGH_ACCEPTED_OCCURRENCE_COUNT = 120;
const P95_INDEX = Math.ceil(PERCENTILE * MEASURED_SAMPLES) - 1;

const D = (character: string) => parseSha256Digest(character.repeat(64));
const TASK = parseTaskSlug("triage-benchmark");
const PHASE = encodePhaseInstance({ kind: "design" });
const REVIEW_DIGEST = D("1");
const SUBJECT_DIGEST = D("a");
const INPUT_FINGERPRINT = D("b");

const findings = CLAIM_TYPES.flatMap((claimType) =>
  CONFIDENCE_LEVELS.flatMap((confidence) =>
    Array.from({ length: 10 }, (_, index): ReviewFindingV2 => ({
      finding_id: `${claimType}-${confidence}-${String(index).padStart(2, "0")}`,
      claim_type: claimType,
      confidence,
      falsifier: `A focused check disproves ${claimType} ${confidence} ${index}.`,
      summary: `${claimType} ${confidence} finding ${index}`,
      evidence: `Authenticated evidence for ${claimType} ${confidence} finding ${index}.`,
      suggested_resolution: `Resolve ${claimType} ${confidence} finding ${index}.`,
    })),
  ),
);

function dispositionFor(finding: ReviewFindingV2, index: number): TriageDisposition {
  const findingRef = { review_evidence_digest: REVIEW_DIGEST, finding_id: finding.finding_id };
  const cellIndex = index % 10;
  if (finding.claim_type === "preference" && cellIndex < 2) {
    return { ...findingRef, disposition: "accepted-editorial", rationale: "Preference-only wording cleanup.", revision_intent: "Polish wording without changing meaning." };
  }
  if ((finding.claim_type === "risk" || finding.claim_type === "gap") && cellIndex < 2) {
    return { ...findingRef, disposition: "deferred", rationale: "Measured as non-material for this boundary.", evidence: "The bounded benchmark demonstrates no material consequence at the current scale." };
  }
  switch (cellIndex % 3) {
    case 0:
      return { ...findingRef, disposition: "accepted", rationale: "The finding is material.", revision_intent: "Apply the focused correction." };
    case 1:
      return { ...findingRef, disposition: "rejected", rationale: "The claim is falsified.", evidence: "The cited implementation path demonstrates the claimed behavior is absent." };
    default:
      return { ...findingRef, disposition: "escalated-human", rationale: "The remaining tradeoff requires human judgment." };
  }
}

const dispositions = findings.map(dispositionFor);
const dispositionCount = (kind: TriageDisposition["disposition"]): number =>
  dispositions.filter((disposition) => disposition.disposition === kind).length;

function qualifiedReview(): QualifiedReviewEvidence {
  const evidence = {
    schema_version: "2",
    task_id: TASK,
    phase_instance: PHASE,
    step: "counter_review",
    role: "counter-review",
    subject_digest: SUBJECT_DIGEST,
    input_fingerprint: INPUT_FINGERPRINT,
    rubric_digest: D("c"),
    producer_family: "claude",
    findings,
    matched_rule_versions: [],
    verdict: "review-raised",
    total_findings: findings.length,
    partition_counts: computeFindingPartitionCounts(findings),
    assurance: "degraded",
    model_family: "codex",
    model: "benchmark-fixture",
    effort: "unknown",
    reason: "Deterministic unit benchmark fixture.",
  } as const;
  const verified = createTestVerifiedReferencedEvidence<"review", "degraded">("review", {
    evidence_digest: REVIEW_DIGEST,
    evidence,
  } as never);
  const link = createTestAuthorityLink({
    schema_version: "1",
    evidence_kind: "review",
    assurance: "degraded",
    role: "counter-review",
    task_id: TASK,
    phase_instance: PHASE,
    subject_digest: SUBJECT_DIGEST,
    input_fingerprint: INPUT_FINGERPRINT,
    evidence_digest: REVIEW_DIGEST,
    authority: { kind: "degraded", checkpoint_digest: D("d"), checkpoint_revision: 1 },
  } as never);
  return authorityQualifier.qualifyReview(link as never, verified as never);
}

const slots = [{
  role: "counter-review",
  evidence_digest: REVIEW_DIGEST,
  assurance: "degraded",
  producer_family: "claude",
  reviewer_family: "codex",
}] as const;
const currentReview = authorityQualifier.currentReviews(
  createTestCurrentReviewSetAuthority({
    task_id: TASK,
    phase_instance: PHASE,
    subject_digest: SUBJECT_DIGEST,
    input_fingerprint: INPUT_FINGERPRINT,
    slots,
  }),
  [qualifiedReview()],
);
const triageCandidate = {
  schema_version: "1",
  task_id: TASK,
  phase_instance: PHASE,
  step: "triage",
  subject_digest: SUBJECT_DIGEST,
  input_fingerprint: INPUT_FINGERPRINT,
  current_evidence_set_digest: currentReview.current_evidence_set.set_digest,
  source_evidence_digests: [REVIEW_DIGEST],
  dispositions,
  accepted_count: dispositionCount("accepted"),
  accepted_editorial_count: dispositionCount("accepted-editorial"),
  rejected_count: dispositionCount("rejected"),
  escalated_human_count: dispositionCount("escalated-human"),
  deferred_count: dispositionCount("deferred"),
} as const;

function activeGate(
  kind: "validation-override" | "attempts-exhausted",
  context: Record<string, unknown>,
  currentEvidence: Record<string, unknown>,
  allowedDecisions: readonly string[],
): ActiveGateV1 {
  const contextDigest = computeGateContextDigest(kind, context as never);
  return parseActiveGate({
    schema_version: "1",
    gate_id: `gate-benchmark-${kind}`,
    intent_id: `intent-benchmark-${kind}`,
    request_digest: D("e"),
    task_id: TASK,
    phase_instance: "phase-impl-5",
    summary: "Benchmark the maximum supported human decision shape.",
    subject_digest: SUBJECT_DIGEST,
    context_digest: contextDigest,
    current_evidence: currentEvidence,
    kind,
    context,
    allowed_decisions: allowedDecisions,
    opened_at_revision: 5,
    status: "awaiting-human",
    decision_template: {
      schema_version: "1",
      gate_id: `gate-benchmark-${kind}`,
      task_id: TASK,
      phase_instance: "phase-impl-5",
      kind,
      subject_digest: SUBJECT_DIGEST,
      context_digest: contextDigest,
      required_fields: ["payload", "human_provenance"],
      cancellation_fields: ["cancelled", "reason", "human_provenance"],
    },
  });
}

const displacedValidations = Array.from(
  { length: VALIDATION_OVERRIDE_ITEM_COUNT },
  (_, index) => `Validation ${String(index).padStart(2, "0")}`,
).sort((left, right) => left.localeCompare(right));
const validationSubjectDigest = SUBJECT_DIGEST;
const validationContext = {
  request_revision: 5,
  input_fingerprint: INPUT_FINGERPRINT,
  governing_phase_design_digest: D("f"),
  displaced_validations: displacedValidations,
  producer_reason: "The maximum supported validation set could not run.",
};
const validationOverrideGate = activeGate(
  "validation-override",
  validationContext,
  {
    schema_version: "1",
    evidence_kind: "validation-override-request",
    task_id: TASK,
    phase_instance: "phase-impl-5",
    input_fingerprint: INPUT_FINGERPRINT,
    governing_phase_design_digest: D("f"),
    request_revision: 5,
    validation_request_subject_digest: validationSubjectDigest,
  },
  ["grant-validation-override", "deny-validation-override", "cancel"],
);

const acceptedOccurrences = Array.from(
  { length: PUSH_THROUGH_ACCEPTED_OCCURRENCE_COUNT },
  (_, index) => ({
    review_evidence_digest: REVIEW_DIGEST,
    finding_id: `accepted-occurrence-${String(index).padStart(3, "0")}`,
  }),
);
const findingDetailLines = acceptedOccurrences.map((occurrence) =>
  `${occurrence.finding_id}: accepted material finding with authenticated evidence.`,
);
const pushThroughEvidence = currentEvidenceSetRef([{
  role: "counter-review",
  evidence_digest: REVIEW_DIGEST,
  assurance: "server-attested",
  producer_family: "claude",
  reviewer_family: "codex",
}]);
const pushThroughGate = activeGate(
  "attempts-exhausted",
  {
    step: "triage",
    attempts: 2,
    maximum_attempts: 2,
    review_push_through: {
      minimum_attempt: 2,
      current_evidence_set_digest: pushThroughEvidence.set_digest,
      triage_result_digest: D("2"),
      accepted_occurrences: acceptedOccurrences,
    },
  },
  pushThroughEvidence,
  ["retry-once", "revise", "abort", "push-through-review", "cancel"],
);

type BenchmarkStats = Readonly<{ median: number; p95: number; max: number }>;

function benchmark(invoke: () => unknown): BenchmarkStats {
  for (let iteration = 0; iteration < WARMUP_ITERATIONS; iteration += 1) invoke();
  const samples: number[] = [];
  for (let sample = 0; sample < MEASURED_SAMPLES; sample += 1) {
    const started = performance.now();
    invoke();
    samples.push(performance.now() - started);
  }
  const sorted = samples.toSorted((left, right) => left - right);
  return {
    median: sorted[Math.floor(MEASURED_SAMPLES / 2)]!,
    p95: sorted[P95_INDEX]!,
    max: sorted[MEASURED_SAMPLES - 1]!,
  };
}

function report(shape: string, stats: BenchmarkStats): void {
  console.info(`TRIAGE_LATENCY ${JSON.stringify({
    shape,
    sample_count: MEASURED_SAMPLES,
    median_ms: Number(stats.median.toFixed(3)),
    p95_ms: Number(stats.p95.toFixed(3)),
    max_ms: Number(stats.max.toFixed(3)),
    node: process.version,
    platform: platform(),
    arch: arch(),
    cpu: cpus()[0]?.model ?? "unknown",
  })}`);
}

describe("triage and human-gate latency", () => {
  it("keeps worst-case supported shapes below the p95 budget", () => {
    expect(findings).toHaveLength(120);
    expect(new Set(findings.map((finding) => `${finding.claim_type}:${finding.confidence}`))).toHaveLength(12);
    expect(dispositions.map((disposition) => disposition.disposition)).toEqual(expect.arrayContaining([
      "accepted", "accepted-editorial", "rejected", "escalated-human", "deferred",
    ]));
    expect(displacedValidations).toHaveLength(VALIDATION_OVERRIDE_ITEM_COUNT);
    if (validationOverrideGate.kind !== "validation-override" || pushThroughGate.kind !== "attempts-exhausted") {
      throw new TypeError("benchmark gates were not preserved by active-gate parsing");
    }
    expect(validationOverrideGate.context.displaced_validations).toHaveLength(VALIDATION_OVERRIDE_ITEM_COUNT);
    expect(pushThroughGate.context.review_push_through?.accepted_occurrences)
      .toHaveLength(PUSH_THROUGH_ACCEPTED_OCCURRENCE_COUNT);
    expect(findingDetailLines).toHaveLength(PUSH_THROUGH_ACCEPTED_OCCURRENCE_COUNT);
    const pushThroughPresentation = buildHumanGatePresentation(pushThroughGate, {
      review_push_through_findings: findingDetailLines,
    });
    const renderedFindingDetails = (pushThroughPresentation.details ?? []).filter((detail) =>
      findingDetailLines.includes(detail),
    );
    expect(renderedFindingDetails).toEqual(findingDetailLines);

    const measurements = [
      { shape: "triage-120-findings", stats: benchmark(() => validateTriage(currentReview, triageCandidate)) },
      { shape: "validation-override-32-items", stats: benchmark(() => buildHumanGatePresentation(validationOverrideGate)) },
      { shape: "push-through-120-occurrences", stats: benchmark(() => buildHumanGatePresentation(pushThroughGate, { review_push_through_findings: findingDetailLines })) },
    ];
    for (const measurement of measurements) report(measurement.shape, measurement.stats);

    for (const measurement of measurements) {
      expect(measurement.stats.p95, `${measurement.shape} p95`).toBeLessThan(LATENCY_LIMIT_MS);
    }
  });
});

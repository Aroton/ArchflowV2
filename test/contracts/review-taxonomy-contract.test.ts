import { describe, expect, it } from "vitest";

import {
  CLAIM_TYPES,
  childReviewOutputV2Schema,
  computeFindingPartitionCounts,
  CONFIDENCE_LEVELS,
  expectedReviewSummaryV2,
  findingPartitionCountsSchema,
  isSubstantiveClaim,
  rawReviewSchema,
  reviewFindingV2Schema,
  type ReviewFindingV2,
} from "../../src/contracts/review.js";

const digest = (character: string) => character.repeat(64);
const finding = (claim_type: ReviewFindingV2["claim_type"], confidence: ReviewFindingV2["confidence"]): ReviewFindingV2 => ({
  finding_id: `${claim_type}-${confidence}`,
  claim_type,
  confidence,
  falsifier: "Run the focused test and inspect the asserted boundary.",
  summary: "A falsifiable review claim.",
  evidence: "The changed boundary demonstrates the claim.",
  suggested_resolution: "Correct the changed boundary.",
});
const child = (findings: readonly ReviewFindingV2[] = []) => ({
  task_id: "review-taxonomy",
  phase_instance: "phase-impl-1",
  step: "counter_review",
  role: "counter-review",
  subject_digest: digest("a"),
  input_fingerprint: digest("b"),
  rubric_digest: digest("c"),
  producer_family: "claude",
  findings,
  matched_rule_versions: [],
});

describe("review taxonomy V2 contract", () => {
  it("counts every taxonomy cell and derives the canonical verdict", () => {
    const findings = CLAIM_TYPES.flatMap((claimType) =>
      CONFIDENCE_LEVELS.map((confidence) => finding(claimType, confidence)));
    const counts = computeFindingPartitionCounts(findings);
    expect(Object.keys(counts)).toHaveLength(12);
    for (const claimType of CLAIM_TYPES) for (const confidence of CONFIDENCE_LEVELS) {
      expect(counts[`${claimType}:${confidence}`]).toBe(1);
    }
    expect(expectedReviewSummaryV2(findings)).toEqual({
      verdict: "review-raised", total_findings: 12, partition_counts: counts,
    });
    expect(expectedReviewSummaryV2([finding("preference", "suspicion")]).verdict).toBe("advisory");
    expect(expectedReviewSummaryV2([]).verdict).toBe("pass");
    expect(isSubstantiveClaim(finding("gap", "suspicion"))).toBe(true);
    expect(isSubstantiveClaim(finding("preference", "certain"))).toBe(false);
    expect(isSubstantiveClaim({ finding_id: "legacy", severity: "blocker", blocking: true, summary: "Legacy.", evidence: "Archive.", suggested_resolution: "Fix." })).toBe(true);
  });

  it("keeps fresh child output summary-free and strictly bounded", () => {
    const valid = child([finding("risk", "likely")]);
    expect(childReviewOutputV2Schema.parse(valid)).toEqual(valid);
    for (const extra of [
      { schema_version: "2" }, { verdict: "review-raised" }, { total_findings: 1 },
      { partition_counts: computeFindingPartitionCounts(valid.findings) }, { blocking_count: 1 },
    ]) expect(childReviewOutputV2Schema.safeParse({ ...valid, ...extra }).success).toBe(false);
    expect(reviewFindingV2Schema.safeParse({ ...valid.findings[0], falsifier: "x".repeat(4097) }).success).toBe(false);
    expect(reviewFindingV2Schema.safeParse({ ...valid.findings[0], severity: "blocker" }).success).toBe(false);
  });

  it("requires exact derived V2 summaries and an exact 12-cell partition", () => {
    const findings = [finding("preference", "certain")];
    const summary = expectedReviewSummaryV2(findings);
    const raw = { schema_version: "2", ...child(findings), ...summary };
    expect(rawReviewSchema.parse(raw)).toEqual(raw);
    expect(rawReviewSchema.safeParse({ ...raw, verdict: "pass" }).success).toBe(false);
    expect(rawReviewSchema.safeParse({ ...raw, total_findings: 2 }).success).toBe(false);
    const { "preference:certain": _removed, ...shortCounts } = summary.partition_counts;
    expect(findingPartitionCountsSchema.safeParse(shortCounts).success).toBe(false);
  });
});

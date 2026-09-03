import { describe, expect, it } from "vitest";

import type { LegacyReviewFinding, ReviewFindingV2 } from "../../src/contracts/review.js";
import { aggregateActiveReviewerFindings } from "../../src/review/counter-review.js";

const finding = (
  finding_id: string,
  claim_type: ReviewFindingV2["claim_type"],
  confidence: ReviewFindingV2["confidence"],
): ReviewFindingV2 => ({
  finding_id,
  claim_type,
  confidence,
  falsifier: `Inspect ${finding_id} and disprove the stated consequence.`,
  summary: `Summary for ${finding_id}`,
  evidence: `Evidence for ${finding_id}`,
  suggested_resolution: `Resolve ${finding_id}`,
});

describe("counter-review V2 aggregation", () => {
  it("preserves reviewer/finding order, disambiguates IDs, and derives all summary arithmetic", () => {
    const result = aggregateActiveReviewerFindings([
      { tag: "general", schema_version: "2", findings: [
        finding("same", "preference", "suspicion"),
        finding("defect", "defect", "certain"),
      ] },
      { tag: "test", schema_version: "2", findings: [
        finding("same", "risk", "likely"),
        finding("same", "gap", "suspicion"),
      ] },
    ]);

    expect(result.findings.map((item) => item.finding_id)).toEqual([
      "general-same", "general-defect", "test-same", "test-same-2",
    ]);
    expect(result.finding_ids_by_reviewer).toEqual([
      ["general-same", "general-defect"], ["test-same", "test-same-2"],
    ]);
    expect(result.summary.verdict).toBe("review-raised");
    expect(result.summary.total_findings).toBe(4);
    expect(Object.values(result.summary.partition_counts).reduce((sum, count) => sum + count, 0)).toBe(4);
    expect(result.summary.partition_counts).toMatchObject({
      "preference:suspicion": 1,
      "defect:certain": 1,
      "risk:likely": 1,
      "gap:suspicion": 1,
    });
  });

  it("derives pass and preference-only advisory without trusting reviewer rollups", () => {
    expect(aggregateActiveReviewerFindings([
      { tag: "general", schema_version: "2", findings: [] },
    ]).summary).toMatchObject({ verdict: "pass", total_findings: 0 });
    expect(aggregateActiveReviewerFindings([
      { tag: "general", schema_version: "2", findings: [finding("note", "preference", "likely")] },
    ]).summary).toMatchObject({ verdict: "advisory", total_findings: 1 });
  });

  it("rejects a legacy or mixed active round instead of normalizing it", () => {
    const legacy: LegacyReviewFinding = {
      finding_id: "legacy",
      severity: "major",
      blocking: true,
      summary: "Legacy summary",
      evidence: "Legacy evidence",
      suggested_resolution: "Legacy resolution",
    };
    expect(() => aggregateActiveReviewerFindings([
      { tag: "general", schema_version: "2", findings: [finding("fresh", "defect", "likely")] },
      { tag: "test", schema_version: "1", findings: [legacy] },
    ])).toThrow(/active review schema version 2/iu);
  });
});

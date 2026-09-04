import { describe, expect, it } from "vitest";

import { parseSha256Digest, parseTaskSlug } from "../../src/contracts/evidence.js";
import { parseTriageCandidate } from "../../src/contracts/triage.js";

const digest = (character: string) => parseSha256Digest(character.repeat(64));
const base = {
  schema_version: "1" as const, task_id: parseTaskSlug("ledger-test"), phase_instance: "phase-impl-1",
  step: "triage" as const, subject_digest: digest("a"), input_fingerprint: digest("b"),
  current_evidence_set_digest: digest("c"), source_evidence_digests: [digest("d")],
  dispositions: [], accepted_count: 0, rejected_count: 0, accepted_editorial_count: 0,
};
const common = { disposition: "rejected" as const, attempt: 1 };

describe("triage disposition ledger contract", () => {
  it("retains V2, detailed V1, and detail-less legacy occurrences", () => {
    const parsed = parseTriageCandidate({ ...base, disposition_ledger: [
      { ...common, review_evidence_digest: digest("1"), finding_id: "reused", claim_type: "defect", confidence: "certain", falsifier: "Run the failing case." },
      { ...common, review_evidence_digest: digest("2"), finding_id: "reused", severity: "blocker", blocking: true },
      { ...common, review_evidence_digest: digest("3"), finding_id: "historical" },
    ] });
    expect(parsed.disposition_ledger).toHaveLength(3);
  });

  it("uses review digest plus finding id as occurrence identity", () => {
    expect(() => parseTriageCandidate({ ...base, disposition_ledger: [
      { ...common, review_evidence_digest: digest("1"), finding_id: "same" },
      { ...common, review_evidence_digest: digest("1"), finding_id: "same" },
    ] })).toThrow(/duplicate ledger finding occurrence/u);
  });

  it("rejects partial or mixed classification families", () => {
    for (const entry of [
      { ...common, review_evidence_digest: digest("1"), finding_id: "partial", claim_type: "gap" },
      { ...common, review_evidence_digest: digest("2"), finding_id: "mixed", claim_type: "risk", confidence: "likely", falsifier: "Inspect the boundary.", severity: "major", blocking: false },
      { ...common, review_evidence_digest: digest("3"), finding_id: "partial-v1", blocking: true },
    ]) expect(() => parseTriageCandidate({ ...base, disposition_ledger: [entry] })).toThrow();
  });

  it("retains V3 attribution and native test detail without flattening it", () => {
    const entry = {
      ...common, review_evidence_digest: digest("4"), finding_id: "test-missing-oracle",
      claim_type: "gap", confidence: "likely", falsifier: "Show an assertion that detects the bad result.",
      reviewer_id: "test", reviewer_focus: "tests", routing_role: "test-reviewer", criterion_id: "test-quality",
      required_behavior_or_risk_boundary: "Reject traversal.",
      coverage_or_oracle_problem: "The test has no rejection assertion.",
      consequence: "Traversal can regress silently.",
      proposed_verification_change: "Assert rejection and an unchanged filesystem.",
      disposition_evidence: "The existing assertion checks only process exit.",
    } as const;
    const parsed = parseTriageCandidate({ ...base, disposition_ledger: [entry] });
    expect(parsed.disposition_ledger?.[0]).toEqual(entry);
    expect(parsed.disposition_ledger?.[0]).not.toHaveProperty("summary");
    expect(parsed.disposition_ledger?.[0]).not.toHaveProperty("suggested_resolution");
  });
});

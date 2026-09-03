import { describe, expect, it } from "vitest";

import { CLAIM_TYPES, CONFIDENCE_LEVELS } from "../../src/contracts/review.js";
import { parseSha256Digest } from "../../src/contracts/evidence.js";
import type { TriageDispositionLedgerEntry } from "../../src/contracts/triage.js";
import { computeTaxonomyDenialRates } from "../../src/state/semantic-status.js";
import {
  computeSemanticStatusSnapshot,
} from "../../src/state/semantic-status.js";
import { unavailableImplementationRecommendation } from "../../src/contracts/semantic-workflow.js";
import type { TaskStatusV1 } from "../../src/state/status.js";

const digest = (character: string) => parseSha256Digest(character.repeat(64));

function v2Entry(
  evidence: string,
  finding_id: string,
  claim_type: (typeof CLAIM_TYPES)[number],
  confidence: (typeof CONFIDENCE_LEVELS)[number],
  disposition: "accepted" | "rejected",
): TriageDispositionLedgerEntry {
  return {
    review_evidence_digest: digest(evidence),
    finding_id,
    disposition,
    attempt: 1 as never,
    claim_type,
    confidence,
    falsifier: "A focused check would disprove this claim.",
  } as TriageDispositionLedgerEntry;
}

describe("semantic status review taxonomy", () => {
  it("computes all twelve denial-rate cells over distinct authenticated occurrences", () => {
    const rates = computeTaxonomyDenialRates([
      v2Entry("a", "same-id", "defect", "certain", "rejected"),
      v2Entry("b", "same-id", "defect", "certain", "accepted"),
      v2Entry("c", "risk-id", "risk", "likely", "rejected"),
      // An exact occurrence replay replaces rather than double-counting its predecessor.
      v2Entry("c", "risk-id", "risk", "likely", "accepted"),
      {
        review_evidence_digest: digest("d"), finding_id: "legacy", disposition: "rejected",
        attempt: 1 as never, severity: "blocker", blocking: true,
      },
      {
        review_evidence_digest: digest("e"), finding_id: "detail-less", disposition: "rejected",
        attempt: 1 as never,
      },
    ]);

    expect(Object.keys(rates)).toHaveLength(12);
    expect(rates["defect:certain"]).toBe(0.5);
    expect(rates["risk:likely"]).toBe(0);
    for (const claimType of CLAIM_TYPES) {
      for (const confidence of CONFIDENCE_LEVELS) {
        const key = `${claimType}:${confidence}` as keyof typeof rates;
        if (key !== "defect:certain" && key !== "risk:likely") expect(rates[key]).toBe(0);
      }
    }
  });

  it("copies every cell unchanged from authoritative enrichment into the snapshot", () => {
    const rates = {
      ...computeTaxonomyDenialRates([]),
      "defect:certain": 0.25,
      "preference:suspicion": 1,
    };
    const status = {
      task_id: "ledger-test", state: "missing", config: { verified: true }, blocking_reasons: [],
      next_action: { code: "create-task", detail: "Create task.", human_required: false },
    } as unknown as TaskStatusV1;
    const snapshot = computeSemanticStatusSnapshot(status, {
      repository_identity_digest: digest("f"),
      full_findings: [],
      taxonomy_denial_rates: rates,
      implementation_recommendation: unavailableImplementationRecommendation(
        "not-applicable", "No implementation recommendation applies.",
      ),
    });
    expect(snapshot.taxonomy_denial_rates).toEqual(rates);
    expect(snapshot.taxonomy_denial_rates).not.toBe(rates);
  });

  it("computes denial rates correctly across all 5 dispositions", () => {
    const rates = computeTaxonomyDenialRates([
      v2Entry("a", "f1", "defect", "certain", "rejected"),
      {
        review_evidence_digest: digest("b"), finding_id: "f2", disposition: "escalated-human" as never,
        attempt: 1 as never, claim_type: "defect", confidence: "certain", falsifier: "falsifier",
      },
      {
        review_evidence_digest: digest("c"), finding_id: "f3", disposition: "deferred" as never,
        attempt: 1 as never, claim_type: "defect", confidence: "certain", falsifier: "falsifier",
      },
      {
        review_evidence_digest: digest("d"), finding_id: "f4", disposition: "accepted-editorial" as never,
        attempt: 1 as never, claim_type: "defect", confidence: "certain", falsifier: "falsifier",
      },
      v2Entry("e", "f5", "defect", "certain", "accepted"),
    ]);
    // 5 occurrences in defect:certain, 1 rejected -> 1/5 = 0.2
    expect(rates["defect:certain"]).toBe(0.2);
  });
});

import { describe, expect, it } from "vitest";

import { canonicalJsonDigest } from "../../src/contracts/canonical.js";
import { parseSupplementalReviewRecord } from "../../src/contracts/supplemental-record.js";

const digest = (character: string): `${string}` => character.repeat(64);

function record() {
  const review = {
    schema_version: "1", task_id: "task-1", phase_instance: "phase-impl-15",
    step: "counter_review", role: "gate-counter-review", subject_digest: digest("a"),
    input_fingerprint: digest("b"), rubric_digest: digest("c"), producer_family: "claude",
    findings: [{ finding_id: "finding-1", severity: "major", blocking: false, summary: "A real issue", evidence: "Observed in the implementation", suggested_resolution: "Revise the implementation" }],
    matched_rule_versions: [], verdict: "advisory", blocking_count: 0,
    assurance: "degraded", model_family: "codex", model: "unknown", effort: "unknown",
    reason: "Produced by the offline supplemental route",
  } as const;
  const evidenceDigest = canonicalJsonDigest(review);
  const triage = {
    schema_version: "1", task_id: "task-1", phase_instance: "phase-impl-15", step: "triage",
    subject_digest: digest("a"), input_fingerprint: digest("b"), current_evidence_set_digest: digest("d"),
    source_evidence_digests: [evidenceDigest],
    dispositions: [{ review_evidence_digest: evidenceDigest, finding_id: "finding-1", disposition: "rejected", rationale: "The finding does not require a subject change", evidence: "The current bytes already satisfy it" }],
    accepted_count: 0, rejected_count: 1,
  } as const;
  return {
    schema_version: "1", gate_id: "gate-1", request_digest: digest("e"), task_id: "task-1",
    phase_instance: "phase-impl-15", kind: "artifact-approval", subject_digest: digest("a"),
    context_digest: digest("f"), input_fingerprint: digest("b"), current_evidence_set_digest: digest("d"),
    evidence_digest: evidenceDigest, projection_digest: digest("1"), review,
    triage_digest: canonicalJsonDigest(triage), triage, outcome: "no-change",
  } as const;
}

describe("supplemental review record", () => {
  it("accepts a degraded opposite-family review with exact-cover no-change triage", () => {
    expect(parseSupplementalReviewRecord(record())).toEqual(record());
  });

  it("rejects forged assurance, incomplete triage, digest substitution, and contradictory outcome", () => {
    const valid = record();
    const mutations = [
      { ...valid, review: { ...valid.review, assurance: "server-attested" } },
      { ...valid, triage: { ...valid.triage, dispositions: [], rejected_count: 0 } },
      { ...valid, triage_digest: digest("9") },
      { ...valid, outcome: "accepted-change" },
    ];
    for (const value of mutations) expect(() => parseSupplementalReviewRecord(value)).toThrow();
  });
});

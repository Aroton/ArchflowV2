import { describe, expect, it } from "vitest";
import { parseSupplementalReviewOutcome } from "../../src/contracts/supplemental.js";

const digest = (character: string) => character.repeat(64);
const review = { prior_gate_id: "gate-1", task_id: "task", phase_instance: "phase-impl-2", subject_digest: digest("a"), input_fingerprint: digest("b"), evidence_slot: { role: "gate-counter-review", evidence_digest: digest("c"), assurance: "degraded", producer_family: "claude", reviewer_family: "codex", independence: "opposite-family", gate_id: "gate-1" } };
describe("supplemental review outcomes", () => {
  it("keeps decline gate-only and enforces gate-bound evidence", () => {
    expect(parseSupplementalReviewOutcome({ action: "decline", gate: { prior_gate_id: "gate-1", task_id: "task", phase_instance: "phase-impl-2", subject_digest: digest("a"), input_fingerprint: digest("b") }, reason: "declined" }).action).toBe("decline");
    expect(() => parseSupplementalReviewOutcome({ action: "ingest", review: { ...review, evidence_slot: { ...review.evidence_slot, gate_id: "gate-2" } }, reason: "late evidence" })).toThrow(/prior_gate_id/);
  });
  it("requires supersession to change the bound subject", () => {
    expect(parseSupplementalReviewOutcome({ action: "supersede", review, accepted_triage_digest: digest("d"), old_subject_digest: digest("a"), new_subject_digest: digest("e"), reason: "revision required" }).action).toBe("supersede");
    expect(() => parseSupplementalReviewOutcome({ action: "supersede", review, accepted_triage_digest: digest("d"), old_subject_digest: digest("a"), new_subject_digest: digest("a"), reason: "revision required" })).toThrow(/new subject/);
  });
  it("rejects the previously permitted broad safe-identifier grammar for gate and task IDs", () => {
    // Before the boundary retightening every one of these round-tripped: `safeId` permits `:`,
    // `_`, and uppercase, none of which can appear in a path segment or a task slug.
    const broad = [
      { ...review, prior_gate_id: "Gate:1", evidence_slot: { ...review.evidence_slot, gate_id: "Gate:1" } },
      { ...review, evidence_slot: { ...review.evidence_slot, gate_id: "gate:1" } },
      { ...review, task_id: "Task_1" },
      { ...review, task_id: "Task-1" },
      { ...review, task_id: "task:1" }
    ];
    for (const value of broad) expect(() => parseSupplementalReviewOutcome({ action: "ingest", review: value, reason: "late evidence" })).toThrow();
  });
});

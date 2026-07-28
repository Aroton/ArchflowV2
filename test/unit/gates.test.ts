import { describe, expect, it } from "vitest";

import { GATE_KINDS, gateDecisionEffect, parseGateContext, parseGateContract, parseGateDecisionEnvelope, validateGateDecision } from "../../src/contracts/gates.js";

const D = "a".repeat(64);
const RULE = { rule_id: "trust-boundary", rule_version: 1 };

describe("gate catalogue", () => {
  it("contains exactly the nine independent kinds", () => {
    expect(GATE_KINDS).toEqual(["artifact-approval", "review-trigger", "material-drift", "adjudication-failure", "attempts-exhausted", "constitution-edit", "commit-authorization", "restore-collision", "migration-audit"]);
  });

  it("keeps cancellation and supplemental outcomes outside decisions", () => {
    expect(() => validateGateDecision("artifact-approval", { artifact_kind: "prd" }, { decision: "approve", reason: "Ready" })).not.toThrow();
    expect(() => validateGateDecision("artifact-approval", { artifact_kind: "prd" }, { decision: "cancelled", reason: "No" } as never)).toThrow();
    expect(() => validateGateDecision("artifact-approval", { artifact_kind: "prd" }, { action: "decline", reason: "No" } as never)).toThrow();
  });

  it("enforces waiver, attempt, adjudication, and restore sequencing", () => {
    const trigger = parseGateContext("review-trigger", { matched_rules: [RULE], uncertain_rules: [], eligible_waiver_rules: [RULE], waiver_scope: { operation: "review-trigger", boundary: "subject" } });
    expect(validateGateDecision("review-trigger", trigger, { decision: "waiver-requested", reason: "Exception", rule: RULE, rationale: "Temporary" })).toBeTruthy();
    expect(() => parseGateContext("attempts-exhausted", { step: "produce", attempts: 1, maximum_attempts: 2 })).toThrow();

    const adjudication = parseGateContext("adjudication-failure", { constitution: "fail", failed_rules: [RULE], uncertain_rules: [], eligible_waiver_rules: [], waiver_scope: { operation: "adjudication-failure", boundary: "phase" } });
    expect(() => validateGateDecision("adjudication-failure", adjudication, { decision: "approve", reason: "Handled", resolutions: [] })).toThrow();
    expect(validateGateDecision("adjudication-failure", adjudication, { decision: "approve", reason: "Handled", resolutions: [{ rule: RULE, resolution: "Accepted mitigation" }] })).toBeTruthy();

    const authority = { link_digest: D, purpose: "restore-adoption" as const, proposed_generation_digest: D, changed_input_fingerprint: D };
    const restore = parseGateContext("restore-collision", { path: "task/file.md", recorded_generation_digest: D, current_generation_digest: D, adoption_candidate: authority });
    expect(validateGateDecision("restore-collision", restore, { decision: "adopt-as-new-generation", reason: "Keep edits", adoption_authority: restore.adoption_candidate!, rationale: "Reviewed" })).toBeTruthy();
    expect(() => validateGateDecision("restore-collision", restore, { decision: "adopt-as-new-generation", reason: "Keep edits", adoption_authority: { ...authority, link_digest: "b".repeat(64) }, rationale: "Reviewed" } as never)).toThrow();
  });

  it("makes semantic decision correlation mandatory in the public gate parser", () => {
    const context = { matched_rules: [RULE], uncertain_rules: [], eligible_waiver_rules: [], waiver_scope: { operation: "review-trigger", boundary: "subject" } } as const;
    expect(() => parseGateContract({ kind: "review-trigger", context, payload: { decision: "waiver-requested", reason: "Exception", rule: RULE, rationale: "Temporary" } })).toThrow(/eligible/);
    expect(() => parseGateContract({ kind: "attempts-exhausted", context: { step: "produce", attempts: 1, maximum_attempts: 2 }, payload: { decision: "abort", reason: "Stop" } })).toThrow(/attempts/);
  });

  it("parses kind-correlated envelopes and exposes effects", () => {
    const envelope = parseGateDecisionEnvelope({ schema_version: "1", gate_id: "gate-1", task_id: "task-1", phase_instance: "phase-impl-2", subject_digest: D, context_digest: D, human_provenance: { schema_version: "1", actor_class: "human", assurance: "declared-local-trace", channel: "archflow-local", decision_event_id: "decision-1", helper_invocation_id: "helper-1", recorded_at: "2026-07-27T12:00:00.000Z" }, kind: "commit-authorization", payload: { decision: "authorize-commit", reason: "Approved" } });
    expect(envelope.kind).toBe("commit-authorization");
    expect(gateDecisionEffect(envelope.payload)).toBe("advance");
    expect(gateDecisionEffect({ decision: "waiver-requested", reason: "x", rule: RULE, rationale: "x" })).toBe("redirect-waiver");
    expect(() => parseGateDecisionEnvelope({ ...envelope, human_provenance: { ...envelope.human_provenance, recorded_at: "2026-07-27T12:00:00Z" } })).toThrow();
    expect(() => parseGateDecisionEnvelope({ ...envelope, human_provenance: { ...envelope.human_provenance, recorded_at: "2026-07-27T07:00:00.000-05:00" } })).toThrow();
  });

  it("rejects the previously legal broad gate and task identifiers on the decision envelope", () => {
    const envelope = { schema_version: "1", gate_id: "gate-1", task_id: "task-1", phase_instance: "phase-impl-2", subject_digest: D, context_digest: D, human_provenance: { schema_version: "1", actor_class: "human", assurance: "declared-local-trace", channel: "archflow-local", decision_event_id: "decision-1", helper_invocation_id: "helper-1", recorded_at: "2026-07-27T12:00:00.000Z" }, kind: "artifact-approval", payload: { decision: "approve", reason: "Approved" } };
    expect(parseGateDecisionEnvelope(envelope).gate_id).toBe("gate-1");
    for (const gateId of ["Gate:1", "gate:1"]) expect(() => parseGateDecisionEnvelope({ ...envelope, gate_id: gateId })).toThrow();
    for (const taskId of ["Task_1", "Task:1", "TASK-1"]) expect(() => parseGateDecisionEnvelope({ ...envelope, task_id: taskId })).toThrow();
    // decision_event_id and helper_invocation_id are deliberately unchanged.
    expect(parseGateDecisionEnvelope({ ...envelope, human_provenance: { ...envelope.human_provenance, decision_event_id: "Decision:1", helper_invocation_id: "Helper:1" } }).human_provenance.decision_event_id).toBe("Decision:1");
  });
});

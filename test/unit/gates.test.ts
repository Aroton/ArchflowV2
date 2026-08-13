import { describe, expect, it } from "vitest";

import { GATE_KINDS, gateDecisionEffect, parseGateContext, parseGateContract, parseGateDecisionEnvelope, validateGateDecision } from "../../src/contracts/gates.js";

const D = "a".repeat(64);
const RULE = { rule_id: "trust-boundary", rule_version: 1 };

describe("gate catalogue", () => {
  it("contains exactly the eight independent kinds", () => {
    expect(GATE_KINDS).toEqual(["artifact-approval", "constitution-review", "material-drift", "attempts-exhausted", "constitution-edit", "commit-authorization", "restore-collision", "migration-audit"]);
  });

  it("keeps cancellation outside decisions", () => {
    expect(() => validateGateDecision("artifact-approval", { artifact_kind: "prd" }, { decision: "approve", reason: "Ready" })).not.toThrow();
    expect(() => validateGateDecision("artifact-approval", { artifact_kind: "prd" }, { decision: "cancelled", reason: "No" } as never)).toThrow();
    expect(() => validateGateDecision("artifact-approval", { artifact_kind: "prd" }, { action: "decline", reason: "No" } as never)).toThrow();
  });

  it("enforces waiver, attempt, adjudication, and restore sequencing", () => {
    // Both axes at one gate: a waiver must name the rule AND the axis the gate offered it on.
    const review = parseGateContext("constitution-review", { constitution: "fail", failed_rules: [RULE], uncertain_rules: [], matched_trigger_rules: [RULE], uncertain_trigger_rules: [], eligible_waivers: [{ rule: RULE, scope: { operation: "adjudication-failure", boundary: "subject" } }, { rule: RULE, scope: { operation: "review-trigger", boundary: "subject" } }] });
    expect(validateGateDecision("constitution-review", review, { decision: "waiver-requested", reason: "Exception", rule: RULE, operation: "review-trigger", rationale: "Temporary" })).toBeTruthy();
    expect(validateGateDecision("constitution-review", review, { decision: "waiver-requested", reason: "Exception", rule: RULE, operation: "adjudication-failure", rationale: "Temporary" })).toBeTruthy();
    expect(() => parseGateContext("attempts-exhausted", { step: "produce", attempts: 1, maximum_attempts: 2 })).toThrow();

    // A rule offered on only one axis cannot be waived on the other.
    const complianceOnly = parseGateContext("constitution-review", { constitution: "fail", failed_rules: [RULE], uncertain_rules: [], matched_trigger_rules: [], uncertain_trigger_rules: [], eligible_waivers: [{ rule: RULE, scope: { operation: "adjudication-failure", boundary: "subject" } }] });
    expect(() => validateGateDecision("constitution-review", complianceOnly, { decision: "waiver-requested", reason: "Exception", rule: RULE, operation: "review-trigger", rationale: "Temporary" })).toThrow(/eligible/);
    expect(validateGateDecision("constitution-review", complianceOnly, { decision: "approve", reason: "Handled" })).toBeTruthy();
    // An eligible waiver must sit on the axis its operation covers, and a gate must carry a question.
    expect(() => parseGateContext("constitution-review", { constitution: "fail", failed_rules: [RULE], uncertain_rules: [], matched_trigger_rules: [], uncertain_trigger_rules: [], eligible_waivers: [{ rule: RULE, scope: { operation: "review-trigger", boundary: "subject" } }] })).toThrow();
    expect(() => parseGateContext("constitution-review", { constitution: "pass", failed_rules: [], uncertain_rules: [], matched_trigger_rules: [], uncertain_trigger_rules: [], eligible_waivers: [] })).toThrow();
    expect(() => parseGateContext("constitution-review", { constitution: "pass", failed_rules: [RULE], uncertain_rules: [], matched_trigger_rules: [], uncertain_trigger_rules: [], eligible_waivers: [] })).toThrow();

    const authority = { link_digest: D, purpose: "restore-adoption" as const, proposed_generation_digest: D, changed_input_fingerprint: D };
    const restore = parseGateContext("restore-collision", { path: "task/file.md", recorded_generation_digest: D, current_generation_digest: D, adoption_candidate: authority });
    expect(validateGateDecision("restore-collision", restore, { decision: "adopt-as-new-generation", reason: "Keep edits", adoption_authority: restore.adoption_candidate!, rationale: "Reviewed" })).toBeTruthy();
    expect(() => validateGateDecision("restore-collision", restore, { decision: "adopt-as-new-generation", reason: "Keep edits", adoption_authority: { ...authority, link_digest: "b".repeat(64) }, rationale: "Reviewed" } as never)).toThrow();
  });

  it("makes semantic decision correlation mandatory in the public gate parser", () => {
    const context = { constitution: "pass", failed_rules: [], uncertain_rules: [], matched_trigger_rules: [RULE], uncertain_trigger_rules: [], eligible_waivers: [] } as const;
    expect(() => parseGateContract({ kind: "constitution-review", context, payload: { decision: "waiver-requested", reason: "Exception", rule: RULE, operation: "review-trigger", rationale: "Temporary" } })).toThrow(/eligible/);
    expect(() => parseGateContract({ kind: "attempts-exhausted", context: { step: "produce", attempts: 1, maximum_attempts: 2 }, payload: { decision: "abort", reason: "Stop" } })).toThrow(/attempts/);
  });

  it("parses kind-correlated envelopes and exposes effects", () => {
    const envelope = parseGateDecisionEnvelope({ schema_version: "1", gate_id: "gate-1", task_id: "task-1", phase_instance: "phase-impl-2", subject_digest: D, context_digest: D, human_provenance: { schema_version: "1", actor_class: "human", assurance: "declared-local-trace", channel: "archflow-local", decision_event_id: "decision-1", helper_invocation_id: "helper-1", recorded_at: "2026-07-27T12:00:00.000Z" }, kind: "commit-authorization", payload: { decision: "authorize-commit", reason: "Approved" } });
    expect(envelope.kind).toBe("commit-authorization");
    expect(gateDecisionEffect(envelope.payload)).toBe("advance");
    expect(gateDecisionEffect({ decision: "waiver-requested", reason: "x", rule: RULE, operation: "review-trigger", rationale: "x" })).toBe("redirect-waiver");
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

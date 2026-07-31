import { describe, expect, it } from "vitest";

import { canonicalDocument } from "../../src/contracts/canonical.js";
import { authenticWaiverOriginArchive } from "../../src/mcp/handlers/waiver.js";

const D = (character: string) => character.repeat(64);

describe("phase 15 handler authority checks", () => {
  it("rejects a forged waiver origin decision digest and rule before opening a waiver gate", () => {
    const rule = { rule_id: "human-review", rule_version: 1 } as const;
    const scope = { operation: "review-trigger", boundary: "subject" } as const;
    const request = canonicalDocument({
      schema_version: "1", gate_id: "origin-gate", intent_id: "origin-intent", request_digest: D("1"),
      task_id: "task-1", phase_instance: "phase-impl-15", summary: "Review required", subject_digest: D("2"),
      context_digest: D("3"), current_evidence: { set_digest: D("4"), slots: [] }, kind: "review-trigger",
      context: { matched_rules: [rule], uncertain_rules: [], eligible_waiver_rules: [rule], waiver_scope: scope },
      allowed_decisions: ["approve", "revise", "reject", "waiver-requested", "cancel"], opened_at_revision: 4,
    } as never);
    const decision = canonicalDocument({
      schema_version: "1", gate_id: "origin-gate", task_id: "task-1", phase_instance: "phase-impl-15",
      kind: "review-trigger", subject_digest: D("2"), context_digest: D("3"), supplemental: [], outcome: "decided",
      envelope: { schema_version: "1", gate_id: "origin-gate", task_id: "task-1", phase_instance: "phase-impl-15",
        kind: "review-trigger", subject_digest: D("2"), context_digest: D("3"),
        payload: { decision: "waiver-requested", rule, reason: "Request narrow waiver" },
        human_provenance: { source: "archflow-local", actor: "human", recorded_at: "2026-07-31T00:00:00.000Z" } },
    } as never);
    const origin = {
      origin_gate_id: "origin-gate", origin_decision_digest: decision.digest, origin_context_digest: D("3"),
      task_id: "task-1", phase_instance: "phase-impl-15", subject_digest: D("2"),
      current_evidence_set_digest: D("4"), rule, scope,
    };
    expect(authenticWaiverOriginArchive(request as never, decision as never, {
      ...origin, origin_decision_digest: D("9"),
    } as never)).toBe(false);
    expect(authenticWaiverOriginArchive(request as never, decision as never, {
      ...origin, rule: { rule_id: "different-rule", rule_version: 1 },
    } as never)).toBe(false);
  });
});

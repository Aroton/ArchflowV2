import { describe, expect, it } from "vitest";

import { taskStateV1Schema, type TaskStateV1 } from "../../src/contracts/durable-state.js";
import { parsePathSafeId, parseSafeId, parseSafeInteger, parseSha256Digest, parseTaskSlug } from "../../src/contracts/evidence.js";
import { gateDecisionEffect } from "../../src/contracts/gates.js";
import { encodePhaseInstance, parsePositiveSafePhaseNumber } from "../../src/contracts/phase-instance.js";
import { deriveNextAction } from "../../src/state/next-action.js";
import { planStateTransition } from "../../src/state/transitions.js";
import { assertAuthenticatedValidationOverride } from "../../src/state/validation-overrides.js";

const D = (value: string) => parseSha256Digest(value.repeat(64));
const implementation = encodePhaseInstance({ kind: "phase-impl", phase: parsePositiveSafePhaseNumber(2) });
const phaseDesign = encodePhaseInstance({ kind: "phase-design", phase: parsePositiveSafePhaseNumber(2) });

function state(overrides: Partial<TaskStateV1> = {}): TaskStateV1 {
  return {
    schema_version: "1",
    task_id: parseTaskSlug("validation-isolation"),
    repository_identity_digest: D("1"),
    revision: parseSafeInteger(7),
    phase_instance: implementation,
    step: "produce",
    status: "running",
    attempt: parseSafeInteger(3),
    input_fingerprint: D("2"),
    initialization_digest: D("3"),
    config_digest: D("4"),
    workflow_digest: D("5"),
    constitution_digest: D("6"),
    policy_base_commit: "abcdef0123456789abcdef0123456789abcdef01" as TaskStateV1["policy_base_commit"],
    authoritative_results: [],
    approvals: [{
      gate_id: parsePathSafeId("design-approval"),
      gate_kind: "design-approval",
      subject_digest: D("7"),
      decision_digest: D("8"),
      resolved_at_revision: parseSafeInteger(4),
    }],
    waivers: [{
      gate_id: parsePathSafeId("policy-waiver"),
      rule_id: parseSafeId("policy-rule"),
      rule_version: parseSafeInteger(1),
      scope: { operation: "review-trigger", boundary: "subject" },
      subject_digest: D("7"),
      granted: true,
      expires: "task-complete",
      granted_at_revision: parseSafeInteger(5),
    }],
    validation_overrides: [],
    review_push_throughs: [],
    ...overrides,
  };
}

const pending = (current: TaskStateV1) => ({
  phase_instance: current.phase_instance,
  input_fingerprint: current.input_fingerprint,
  governing_phase_design_digest: D("9"),
  displaced_validations: ["hardware suite"],
  producer_reason: "device lab unavailable",
  request_digest: D("a"),
  request_revision: parseSafeInteger(current.revision + 1),
} as const);

describe("validation override authority isolation", () => {
  it("uses a dedicated resumption effect rather than approval, waiver, or phase advancement", () => {
    expect(gateDecisionEffect({
      decision: "grant-validation-override", reason: "Grant the named exception.",
    })).toBe("validation-resume");
    expect(gateDecisionEffect({
      decision: "deny-validation-override", reason: "Run the named checks.",
    })).toBe("validation-resume");
  });

  it("requires a loader-minted branded grant", () => {
    expect(() => assertAuthenticatedValidationOverride({} as never))
      .toThrow(/authenticated validation override/u);
  });

  it("installs pending state only on running phase implementation failure and preserves approval and waiver sets", () => {
    const current = state();
    const plan = planStateTransition({
      current,
      target: {
        phase_instance: current.phase_instance,
        step: "produce",
        status: "failed",
        attempt: current.attempt,
        input_fingerprint: current.input_fingerprint,
      },
      recomputed_input_fingerprint: current.input_fingerprint,
      pending_validation_override: pending(current),
    });
    expect(plan.ok).toBe(true);
    if (!plan.ok) return;
    expect(plan.value.approvals).toEqual(current.approvals);
    expect(plan.value.waivers).toEqual(current.waivers);
    expect(plan.value.validation_overrides).toEqual([]);
    expect(plan.value.pending_validation_override).toEqual(pending(current));
    expect(plan.value.attempt).toBe(current.attempt);

    for (const invalid of [
      state({ phase_instance: phaseDesign }),
      state({ status: "failed" }),
      state({ step: "triage" }),
    ]) {
      expect(planStateTransition({
        current: invalid,
        target: {
          phase_instance: invalid.phase_instance,
          step: "produce",
          status: "failed",
          attempt: invalid.attempt,
          input_fingerprint: invalid.input_fingerprint,
        },
        recomputed_input_fingerprint: invalid.input_fingerprint,
        pending_validation_override: pending(invalid),
      })).toMatchObject({ ok: false, error: { code: "TRANSITION_INVALID" } });
    }
  });

  it("blocks ordinary retry while pending, then routes status to the human exception gate", () => {
    const current = state();
    const waiting = taskStateV1Schema.parse({
      ...current,
      revision: current.revision + 1,
      status: "failed",
      pending_validation_override: pending(current),
    });
    expect(planStateTransition({
      current: waiting,
      target: {
        phase_instance: waiting.phase_instance,
        step: "produce",
        status: "running",
        attempt: parseSafeInteger(waiting.attempt + 1),
        input_fingerprint: waiting.input_fingerprint,
      },
      recomputed_input_fingerprint: waiting.input_fingerprint,
    })).toMatchObject({ ok: false, error: { code: "TRANSITION_INVALID" } });
    expect(deriveNextAction({
      repository_initialized: true,
      state: waiting,
      config_verified: true,
      reconciliation_findings: [],
      reconciliation_blocking_reasons: [],
      pending_validation_override: true,
      evidence_available: false,
    })).toMatchObject({
      code: "open-gate", gate_kind: "validation-override", human_required: true,
    });
  });
});

import { describe, expect, it } from "vitest";

import { taskStateV1Schema, type RuleSettlementV1, type TaskStateV1 } from "../../src/contracts/durable-state.js";
import { parsePathSafeId, parseSafeId, parseSafeInteger, parseSha256Digest, parseTaskSlug } from "../../src/contracts/evidence.js";
import { encodePhaseInstance, parsePhaseInstanceId, parsePositiveSafePhaseNumber } from "../../src/contracts/phase-instance.js";
import { parseRepositoryPathClaim } from "../../src/contracts/path-claims.js";
import { legalRunStepStatus, planApprovalTriggerAuthorityRecovery, planMilestoneRecovery, planPlanningRestart, planStateTransition } from "../../src/state/transitions.js";
import { isExactMilestoneRecoveryDraft } from "../../src/state/restart-authority.js";

const D = (value: string) => parseSha256Digest(value.repeat(64));
const phase = (kind: "phase-design" | "phase-impl", number: number) => encodePhaseInstance({ kind, phase: parsePositiveSafePhaseNumber(number) });
const receipt = (phaseInstance: TaskStateV1["phase_instance"], subjectDigest: ReturnType<typeof D>, settledAt: number): RuleSettlementV1 => ({
  task_id: parseTaskSlug("task-1"),
  phase_instance: phaseInstance,
  step: "triage",
  subject_digest: subjectDigest,
  conclusion: { wait: false, match: null },
  config_digest: D("3"),
  settled_at_revision: parseSafeInteger(settledAt),
});

function state(overrides: Partial<TaskStateV1> = {}): TaskStateV1 {
  return {
    schema_version: "1",
    task_id: parseTaskSlug("task-1"),
    repository_identity_digest: D("1"),
    revision: parseSafeInteger(4),
    phase_instance: phase("phase-design", 2),
    step: "produce",
    status: "running",
    attempt: parseSafeInteger(1),
    input_fingerprint: D("2"),
    initialization_digest: D("3"),
    config_digest: D("4"),
    workflow_digest: D("5"),
    constitution_digest: D("6"),
    policy_base_commit: "abcdef0123456789abcdef0123456789abcdef01" as TaskStateV1["policy_base_commit"],
    authoritative_results: [], approvals: [], waivers: [],
    ...overrides,
  };
}

describe("planStateTransition", () => {
  it("re-enters unchanged production once when a legacy fixed point lacks approval-trigger authority", () => {
    const currentPhase = phase("phase-design", 2);
    const upstreamPhase = encodePhaseInstance({ kind: "design" });
    const upstream = {
      phase_instance: upstreamPhase, step: "produce" as const, result_digest: D("7"),
      result_id: parseSafeId("upstream-produce"), input_fingerprint: D("7"),
    };
    const produce = {
      phase_instance: currentPhase, step: "produce" as const, result_digest: D("8"),
      result_id: parseSafeId("current-produce"), input_fingerprint: D("8"),
    };
    const review = {
      phase_instance: currentPhase, step: "counter_review" as const, result_digest: D("9"),
      result_id: parseSafeId("current-review"), input_fingerprint: D("8"),
    };
    const triage = {
      phase_instance: currentPhase, step: "triage" as const, result_digest: D("a"),
      result_id: parseSafeId("current-triage"), input_fingerprint: D("8"),
    };
    const approval = {
      gate_id: parsePathSafeId("prior-approval"), gate_kind: "design-approval" as const,
      subject_digest: D("7"), decision_digest: D("c"), resolved_at_revision: parseSafeInteger(3),
    };
    const waiver = {
      gate_id: parsePathSafeId("prior-waiver"), rule_id: parseSafeId("Rule-1"), rule_version: parseSafeInteger(1),
      scope: { operation: "review-trigger" as const, boundary: "subject" as const },
      subject_digest: D("7"), granted: true, expires: "task-complete" as const,
      granted_at_revision: parseSafeInteger(3),
    };
    const current = state({
      phase_instance: currentPhase, step: "triage", status: "succeeded", attempt: parseSafeInteger(3),
      authoritative_results: [upstream, produce, review, triage], approvals: [approval], waivers: [waiver],
    });

    const result = planApprovalTriggerAuthorityRecovery({ current, recomputed_input_fingerprint: D("8") });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value).toMatchObject({
      phase_instance: currentPhase, step: "produce", status: "running", attempt: 1,
      input_fingerprint: D("8"), approvals: [approval], waivers: [waiver],
    });
    expect(result.value.authoritative_results).toEqual([upstream, produce]);
    expect(planApprovalTriggerAuthorityRecovery({
      current: taskStateV1Schema.parse({ ...result.value, revision: 5 }),
      recomputed_input_fingerprint: D("8"),
    })).toMatchObject({ ok: false, error: { code: "TRANSITION_INVALID" } });
  });

  it("recovers missing milestone authority at the same position and archives the retired graph", () => {
    const current = state({
      step: "triage", status: "succeeded", attempt: parseSafeInteger(3),
      authoritative_results: [{
        phase_instance: phase("phase-design", 2), step: "produce", result_digest: D("7"),
        result_id: parseSafeId("produce-result"), input_fingerprint: D("2"),
      }],
    });
    const result = planMilestoneRecovery({
      current,
      recovery_id: parsePathSafeId("milestone-recovery-test"),
      cause: "milestone-proof-missing",
      target_ref: "refs/heads/main",
      target_head: "abcdef0123456789abcdef0123456789abcdef02" as TaskStateV1["policy_base_commit"],
      subject_digest: D("7"),
      recomputed_input_fingerprint: D("2"),
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value).toMatchObject({
        phase_instance: current.phase_instance, step: "produce", status: "running", attempt: 1,
        authoritative_results: [], waivers: [],
      });
      expect(result.value.milestone_recovery_history?.[0]).toMatchObject({
        cause: "milestone-proof-missing", recovered_at_revision: 5,
        superseded_results: current.authoritative_results,
      });
    }
  });

  it("supports multiple distinct milestone recoveries in the same phase instance", () => {
    const current = state({
      step: "triage", status: "succeeded", attempt: parseSafeInteger(3),
      authoritative_results: [{
        phase_instance: phase("phase-design", 2), step: "produce", result_digest: D("7"),
        result_id: parseSafeId("produce-result"), input_fingerprint: D("2"),
      }],
    });
    const recovery1 = planMilestoneRecovery({
      current,
      recovery_id: parsePathSafeId("milestone-recovery-1"),
      cause: "milestone-proof-missing",
      target_ref: "refs/heads/main",
      target_head: "abcdef0123456789abcdef0123456789abcdef02" as TaskStateV1["policy_base_commit"],
      subject_digest: D("7"),
      recomputed_input_fingerprint: D("2"),
    });
    expect(recovery1.ok).toBe(true);
    if (!recovery1.ok) return;

    const stateAfterRecovery1 = taskStateV1Schema.parse({
      ...recovery1.value,
      revision: parseSafeInteger(current.revision + 1),
    });
    expect(isExactMilestoneRecoveryDraft(current, recovery1.value)).toBe(true);

    // Second recovery with the same recovery_id is rejected
    const colliding = planMilestoneRecovery({
      current: stateAfterRecovery1,
      recovery_id: parsePathSafeId("milestone-recovery-1"),
      cause: "milestone-proof-missing",
      target_ref: "refs/heads/main",
      target_head: "abcdef0123456789abcdef0123456789abcdef02" as TaskStateV1["policy_base_commit"],
      subject_digest: D("7"),
      recomputed_input_fingerprint: D("2"),
    });
    expect(colliding.ok).toBe(false);
    expect(colliding).toMatchObject({ ok: false, error: { code: "TRANSITION_INVALID" } });

    // Second recovery with a distinct recovery_id succeeds
    const recovery2 = planMilestoneRecovery({
      current: stateAfterRecovery1,
      recovery_id: parsePathSafeId("milestone-recovery-2"),
      cause: "milestone-proof-missing",
      target_ref: "refs/heads/main",
      target_head: "abcdef0123456789abcdef0123456789abcdef02" as TaskStateV1["policy_base_commit"],
      subject_digest: D("7"),
      recomputed_input_fingerprint: D("2"),
    });
    expect(recovery2.ok).toBe(true);
    if (!recovery2.ok) return;

    expect(recovery2.value.milestone_recovery_history).toHaveLength(2);
    expect(recovery2.value.milestone_recovery_history?.map((r) => r.recovery_id)).toEqual([
      "milestone-recovery-1",
      "milestone-recovery-2",
    ]);
    expect(isExactMilestoneRecoveryDraft(stateAfterRecovery1, recovery2.value)).toBe(true);
  });

  it("plans the exact running-to-succeeded lifecycle move", () => {
    const current = state({ step: "counter_review" });
    const reference = {
      phase_instance: current.phase_instance,
      step: "counter_review" as const,
      result_digest: D("9"),
      result_id: parseSafeId("counter-review-result"),
      input_fingerprint: D("8"),
    };
    const result = planStateTransition({
      current,
      target: { phase_instance: current.phase_instance, step: "counter_review", status: "succeeded", attempt: parseSafeInteger(1), input_fingerprint: D("8") },
      recomputed_input_fingerprint: D("8"),
      result_reference: reference,
    });
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value).toMatchObject({ status: "succeeded", input_fingerprint: D("8") });
  });

  it("requires durable evidence only for a successful produce boundary", () => {
    const current = state();
    const result = planStateTransition({
      current,
      target: { phase_instance: current.phase_instance, step: "produce", status: "succeeded", attempt: parseSafeInteger(1), input_fingerprint: D("8") },
      recomputed_input_fingerprint: D("8"),
    });
    expect(result.ok ? undefined : result.error.code).toBe("TRANSITION_INVALID");
  });

  it("inserts or replaces only the matching producing result reference", () => {
    const current = state();
    const artifact = {
      artifact_kind: "document",
      task_id: current.task_id,
      phase_instance: current.phase_instance,
      step: "produce",
      input_fingerprint: D("8"),
    } as never;
    const reference = {
      phase_instance: current.phase_instance,
      step: "produce" as const,
      result_digest: D("9"),
      result_id: parseSafeId("result-1"),
      input_fingerprint: D("8"),
    };
    const result = planStateTransition({
      current,
      target: { phase_instance: current.phase_instance, step: "produce", status: "succeeded", attempt: parseSafeInteger(1), input_fingerprint: D("8") },
      recomputed_input_fingerprint: D("8"), artifact, result_reference: reference,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.authoritative_results).toEqual([reference]);

    const replacement = { ...reference, result_digest: D("a"), result_id: parseSafeId("result-2") };
    const replaced = planStateTransition({
      current: state({ authoritative_results: [reference] }),
      target: { phase_instance: current.phase_instance, step: "produce", status: "succeeded", attempt: parseSafeInteger(1), input_fingerprint: D("8") },
      recomputed_input_fingerprint: D("8"), artifact, result_reference: replacement,
    });
    expect(replaced.ok && replaced.value.authoritative_results).toEqual([replacement]);
  });

  it("requires authenticated artifact approval before moving to the fixed phase successor", () => {
    const current = state({ status: "succeeded", step: "triage", attempt: parseSafeInteger(3) });
    const result = planStateTransition({
      current,
      target: { phase_instance: phase("phase-impl", 2), step: "produce", status: "running", attempt: parseSafeInteger(1), input_fingerprint: D("8") },
      recomputed_input_fingerprint: D("8"),
    });
    expect(result).toMatchObject({ ok: false, error: { code: "TRANSITION_INVALID" } });

    const skipped = planStateTransition({
      current,
      target: { phase_instance: phase("phase-design", 3), step: "produce", status: "running", attempt: parseSafeInteger(1), input_fingerprint: D("8") },
      recomputed_input_fingerprint: D("8"),
    });
    expect(skipped.ok ? undefined : skipped.error.code).toBe("TRANSITION_INVALID");
  });

  it("does not let legacy resume metadata bypass ordinary design approval", () => {
    const current = state({
      phase_instance: parsePhaseInstanceId("design"),
      status: "succeeded",
      step: "triage",
      attempt: parseSafeInteger(1),
    });
    const result = planStateTransition({
      current,
      target: {
        phase_instance: phase("phase-design", 1),
        step: "produce",
        status: "running",
        attempt: parseSafeInteger(1),
        input_fingerprint: D("8"),
      },
      recomputed_input_fingerprint: D("8"),
      legacy_resume_phase: phase("phase-design", 4),
    });
    expect(result).toMatchObject({ ok: false, error: { code: "TRANSITION_INVALID" } });
  });

  it("does not advance an implementation phase until its authorized commit is observed", () => {
    const current = state({
      phase_instance: phase("phase-impl", 2),
      status: "succeeded",
      step: "triage",
      attempt: parseSafeInteger(3),
    });
    const target = {
      phase_instance: phase("phase-design", 3), step: "produce" as const,
      status: "running" as const, attempt: parseSafeInteger(1), input_fingerprint: D("8"),
    };
    const unobserved = planStateTransition({
      current, target, recomputed_input_fingerprint: D("8"),
    });
    expect(unobserved).toMatchObject({ ok: false, error: { code: "TRANSITION_INVALID" } });
  });

  it("carries the phase-instance attempt across steps and increments retries and re-entry", () => {
    const across = state({
      step: "counter_review",
      status: "succeeded",
      attempt: parseSafeInteger(3),
    });
    const next = planStateTransition({
      current: across,
      target: {
        phase_instance: across.phase_instance,
        step: "triage",
        status: "running",
        attempt: parseSafeInteger(3),
        input_fingerprint: D("8"),
      },
      recomputed_input_fingerprint: D("8"),
    });
    expect(next.ok).toBe(true);

    const retry = planStateTransition({
      current: state({ status: "failed", attempt: parseSafeInteger(3) }),
      target: {
        phase_instance: across.phase_instance,
        step: "produce",
        status: "running",
        attempt: parseSafeInteger(4),
        input_fingerprint: D("8"),
      },
      recomputed_input_fingerprint: D("8"),
    });
    expect(retry.ok).toBe(true);

    for (const step of ["triage"] as const) {
      const current = state({ step, status: "succeeded", attempt: parseSafeInteger(4) });
      const reentry = planStateTransition({
        current,
        target: {
          phase_instance: current.phase_instance,
          step: "produce",
          status: "running",
          attempt: parseSafeInteger(5),
          input_fingerprint: D("9"),
        },
        recomputed_input_fingerprint: D("9"),
      });
      expect(reentry.ok, step).toBe(true);
    }
  });

  it("preserves one-hop review evidence and the attempt for a simple human revision", () => {
    const phaseInstance = phase("phase-design", 2);
    const evidence = (["adjudicate", "counter_review", "triage"] as const).map((step, index) => ({
      phase_instance: phaseInstance,
      step,
      result_digest: D(String(index + 3)),
      result_id: parseSafeId(`old-${step}`),
      input_fingerprint: D("7"),
    }));
    const oldProduce = {
      phase_instance: phaseInstance,
      step: "produce" as const,
      result_digest: D("2"),
      result_id: parseSafeId("old-produce"),
      input_fingerprint: D("7"),
    };
    const current = state({
      phase_instance: phaseInstance,
      attempt: parseSafeInteger(3),
      authoritative_results: [...evidence, oldProduce].sort((a, b) => a.step.localeCompare(b.step)),
      pending_human_revision: {
        gate_id: parsePathSafeId("human-revise"),
        gate_kind: "artifact-approval",
        predecessor_subject_digest: D("a"),
        predecessor_input_fingerprint: D("7"),
        requested_at_revision: parseSafeInteger(4),
        attempt: parseSafeInteger(3),
        evidence,
      },
    });
    const artifact = {
      artifact_kind: "document", task_id: current.task_id, phase_instance: phaseInstance,
      step: "produce", input_fingerprint: D("8"),
    } as never;
    const replacement = {
      ...oldProduce,
      result_digest: D("b"),
      result_id: parseSafeId("new-produce"),
      input_fingerprint: D("8"),
    };
    const result = planStateTransition({
      current,
      target: { phase_instance: phaseInstance, step: "produce", status: "succeeded", attempt: parseSafeInteger(3), input_fingerprint: D("8") },
      recomputed_input_fingerprint: D("8"), artifact, result_reference: replacement,
      resulting_subject_digest: D("c"),
      human_revision: { classification: "simple", rationale: "Wording only." },
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.attempt).toBe(3);
    expect(result.value.pending_human_revision).toBeUndefined();
    expect(result.value.authoritative_results).toEqual([...evidence, replacement].sort((a, b) => a.step.localeCompare(b.step)));
    expect(result.value.human_revision_history?.at(-1)).toMatchObject({
      classification: "simple", previous_attempt: 3, resulting_attempt: 3, evidence,
    });

    const settlementCarrier = planStateTransition({
      current,
      target: { phase_instance: phaseInstance, step: "produce", status: "succeeded", attempt: parseSafeInteger(3), input_fingerprint: D("8") },
      recomputed_input_fingerprint: D("8"), artifact, result_reference: replacement,
      resulting_subject_digest: D("c"),
      human_revision: { classification: "simple", rationale: "Wording only." },
      rule_settlement: { ...receipt(phaseInstance, D("c"), 5), step: "produce" },
    });
    expect(settlementCarrier).toMatchObject({ ok: false, error: { code: "TRANSITION_INVALID" } });
  });

  it("archives old evidence and resets to attempt 1 for a significant human revision", () => {
    const phaseInstance = phase("phase-design", 2);
    const evidence = (["adjudicate", "counter_review", "triage"] as const).map((step, index) => ({
      phase_instance: phaseInstance,
      step,
      result_digest: D(String(index + 3)),
      result_id: parseSafeId(`old-${step}`),
      input_fingerprint: D("7"),
    }));
    const oldProduce = {
      phase_instance: phaseInstance, step: "produce" as const, result_digest: D("2"),
      result_id: parseSafeId("old-produce"), input_fingerprint: D("7"),
    };
    const current = state({
      phase_instance: phaseInstance, attempt: parseSafeInteger(3),
      authoritative_results: [...evidence, oldProduce].sort((a, b) => a.step.localeCompare(b.step)),
      pending_human_revision: {
        gate_id: parsePathSafeId("human-revise"), gate_kind: "attempts-exhausted",
        predecessor_subject_digest: D("a"), requested_at_revision: parseSafeInteger(4),
        predecessor_input_fingerprint: D("7"),
        attempt: parseSafeInteger(3), evidence,
      },
    });
    const artifact = {
      artifact_kind: "document", task_id: current.task_id, phase_instance: phaseInstance,
      step: "produce", input_fingerprint: D("8"),
    } as never;
    const replacement = {
      ...oldProduce, result_digest: D("b"), result_id: parseSafeId("new-produce"), input_fingerprint: D("8"),
    };
    const result = planStateTransition({
      current,
      target: { phase_instance: phaseInstance, step: "produce", status: "succeeded", attempt: parseSafeInteger(3), input_fingerprint: D("8") },
      recomputed_input_fingerprint: D("8"), artifact, result_reference: replacement,
      resulting_subject_digest: D("c"),
      human_revision: {
        classification: "significant", rationale: "The scope changed.",
        user_override: { agent_classification: "simple", rationale: "Require a fresh review." },
      },
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.attempt).toBe(1);
    expect(result.value.authoritative_results).toEqual([replacement]);
    expect(result.value.human_revision_history?.at(-1)).toMatchObject({
      classification: "significant", previous_attempt: 3, resulting_attempt: 1,
      user_override: { agent_classification: "simple" }, evidence,
    });
  });

  it("requires the classification when pending human revision bytes are recorded", () => {
    const current = state({
      attempt: parseSafeInteger(2),
      pending_human_revision: {
        gate_id: parsePathSafeId("human-revise"), gate_kind: "constitution-review",
        predecessor_subject_digest: D("a"), requested_at_revision: parseSafeInteger(4),
        predecessor_input_fingerprint: D("7"),
        attempt: parseSafeInteger(2), evidence: [],
      },
    });
    const artifact = {
      artifact_kind: "document", task_id: current.task_id, phase_instance: current.phase_instance,
      step: "produce", input_fingerprint: D("8"),
    } as never;
    const reference = {
      phase_instance: current.phase_instance, step: "produce" as const, result_digest: D("b"),
      result_id: parseSafeId("new-produce"), input_fingerprint: D("8"),
    };
    const result = planStateTransition({
      current,
      target: { phase_instance: current.phase_instance, step: "produce", status: "succeeded", attempt: parseSafeInteger(2), input_fingerprint: D("8") },
      recomputed_input_fingerprint: D("8"), artifact, result_reference: reference,
    });
    expect(result).toMatchObject({ ok: false, error: { code: "TRANSITION_INVALID" } });
  });

  it("rejects any movement into the retired adjudicate position", () => {
    const current = state({ status: "succeeded", attempt: parseSafeInteger(2) });
    const entry = planStateTransition({
      current,
      target: { phase_instance: current.phase_instance, step: "adjudicate", status: "running", attempt: parseSafeInteger(2), input_fingerprint: D("8") },
      recomputed_input_fingerprint: D("8"),
    });
    expect(entry.ok ? undefined : entry.error.code).toBe("TRANSITION_INVALID");
    expect(legalRunStepStatus(current, "adjudicate")).toBeUndefined();

    const fromTriage = state({ step: "triage", status: "succeeded", attempt: parseSafeInteger(2) });
    const forward = planStateTransition({
      current: fromTriage,
      target: { phase_instance: fromTriage.phase_instance, step: "adjudicate", status: "running", attempt: parseSafeInteger(2), input_fingerprint: D("8") },
      recomputed_input_fingerprint: D("8"),
    });
    expect(forward.ok ? undefined : forward.error.code).toBe("TRANSITION_INVALID");
    expect(legalRunStepStatus(fromTriage, "adjudicate")).toBeUndefined();
  });

  it("installs the constitution reference only beside a succeeded counter-review", () => {
    const current = state({ step: "counter_review" });
    const reviewReference = {
      phase_instance: current.phase_instance,
      step: "counter_review" as const,
      result_digest: D("9"),
      result_id: parseSafeId("counter-review-result"),
      input_fingerprint: D("8"),
    };
    const constitutionReference = {
      phase_instance: current.phase_instance,
      step: "adjudicate" as const,
      result_digest: D("a"),
      result_id: parseSafeId("adjudication-result"),
      input_fingerprint: D("8"),
    };
    const both = planStateTransition({
      current,
      target: { phase_instance: current.phase_instance, step: "counter_review", status: "succeeded", attempt: parseSafeInteger(1), input_fingerprint: D("8") },
      recomputed_input_fingerprint: D("8"),
      result_reference: reviewReference,
      constitution_result_reference: constitutionReference,
    });
    expect(both.ok).toBe(true);
    if (both.ok) {
      expect(both.value.authoritative_results).toEqual([constitutionReference, reviewReference]);
    }

    // The constitution reference is refused anywhere else — here, on a triage boundary.
    const triageCurrent = state({ step: "triage" });
    const triageReference = { ...reviewReference, step: "triage" as const, result_id: parseSafeId("triage-result") };
    const misplaced = planStateTransition({
      current: triageCurrent,
      target: { phase_instance: triageCurrent.phase_instance, step: "triage", status: "succeeded", attempt: parseSafeInteger(1), input_fingerprint: D("8") },
      recomputed_input_fingerprint: D("8"),
      result_reference: triageReference,
      constitution_result_reference: constitutionReference,
    });
    expect(misplaced.ok ? undefined : misplaced.error.code).toBe("TRANSITION_INVALID");
  });

  it("admits the author-initiated produce re-entry from any succeeded step at attempt + 1", () => {
    for (const step of ["produce", "counter_review"] as const) {
      const current = state({ step, status: "succeeded", attempt: parseSafeInteger(1) });
      const reentry = planStateTransition({
        current,
        target: { phase_instance: current.phase_instance, step: "produce", status: "running", attempt: parseSafeInteger(2), input_fingerprint: D("8") },
        recomputed_input_fingerprint: D("8"),
      });
      expect(reentry.ok, step).toBe(true);
      expect(legalRunStepStatus(current, "produce")).toBe("running");

      const sameAttempt = planStateTransition({
        current,
        target: { phase_instance: current.phase_instance, step: "produce", status: "running", attempt: parseSafeInteger(1), input_fingerprint: D("8") },
        recomputed_input_fingerprint: D("8"),
      });
      expect(sameAttempt.ok ? undefined : sameAttempt.error.code, step).toBe("TRANSITION_INVALID");
    }
  });

  it("re-opens the produce window from a step that is still running or already failed", () => {
    // The escape door out of a step whose terminal result cannot be recorded — a review that
    // cannot be dispatched over documents that changed under it has no forward edge otherwise.
    for (const status of ["running", "failed"] as const) {
      const current = state({ step: "counter_review", status, attempt: parseSafeInteger(1) });
      const reentry = planStateTransition({
        current,
        target: { phase_instance: current.phase_instance, step: "produce", status: "running", attempt: parseSafeInteger(2), input_fingerprint: D("8") },
        recomputed_input_fingerprint: D("8"),
      });
      expect(reentry.ok, status).toBe(true);
      expect(legalRunStepStatus(current, "produce"), status).toBe("running");

      const sameAttempt = planStateTransition({
        current,
        target: { phase_instance: current.phase_instance, step: "produce", status: "running", attempt: parseSafeInteger(1), input_fingerprint: D("8") },
        recomputed_input_fingerprint: D("8"),
      });
      expect(sameAttempt.ok ? undefined : sameAttempt.error.code, status).toBe("TRANSITION_INVALID");
    }

    // Produce work already in flight still settles at its own terminal result first.
    const midProduce = state({ step: "produce", status: "running", attempt: parseSafeInteger(1) });
    const reenteredMidProduce = planStateTransition({
      current: midProduce,
      target: { phase_instance: midProduce.phase_instance, step: "produce", status: "running", attempt: parseSafeInteger(2), input_fingerprint: D("8") },
      recomputed_input_fingerprint: D("8"),
    });
    expect(reenteredMidProduce.ok ? undefined : reenteredMidProduce.error.code).toBe("TRANSITION_INVALID");
    expect(legalRunStepStatus(midProduce, "produce")).toBe("succeeded");
  });

  it("keeps the surrounding movement space closed", () => {
    // running -> running never moves sideways.
    const midProduce = state();
    const sideways = planStateTransition({
      current: midProduce,
      target: { phase_instance: midProduce.phase_instance, step: "counter_review", status: "running", attempt: parseSafeInteger(1), input_fingerprint: D("8") },
      recomputed_input_fingerprint: D("8"),
    });
    expect(sideways.ok ? undefined : sideways.error.code).toBe("TRANSITION_INVALID");

    // triage-failed may retry itself or re-enter produce, but never move sideways.
    const failedTriage = state({ step: "triage", status: "failed" });
    const sidewaysFromFailed = planStateTransition({
      current: failedTriage,
      target: { phase_instance: failedTriage.phase_instance, step: "counter_review", status: "running", attempt: parseSafeInteger(2), input_fingerprint: D("8") },
      recomputed_input_fingerprint: D("8"),
    });
    expect(sidewaysFromFailed.ok ? undefined : sidewaysFromFailed.error.code).toBe("TRANSITION_INVALID");
    expect(legalRunStepStatus(failedTriage, "counter_review")).toBeUndefined();

    // produce-succeeded still may not skip ahead to triage.
    const produced = state({ status: "succeeded" });
    const skipped = planStateTransition({
      current: produced,
      target: { phase_instance: produced.phase_instance, step: "triage", status: "running", attempt: parseSafeInteger(1), input_fingerprint: D("8") },
      recomputed_input_fingerprint: D("8"),
    });
    expect(skipped.ok ? undefined : skipped.error.code).toBe("TRANSITION_INVALID");
    expect(legalRunStepStatus(produced, "triage")).toBeUndefined();

    // A succeeded non-produce step never re-enters its own running state.
    const reviewed = state({ step: "counter_review", status: "succeeded" });
    const rerun = planStateTransition({
      current: reviewed,
      target: { phase_instance: reviewed.phase_instance, step: "counter_review", status: "running", attempt: parseSafeInteger(2), input_fingerprint: D("8") },
      recomputed_input_fingerprint: D("8"),
    });
    expect(rerun.ok ? undefined : rerun.error.code).toBe("TRANSITION_INVALID");
    expect(legalRunStepStatus(reviewed, "counter_review")).toBeUndefined();
  });

  it("rejects a stale fingerprint before planning", () => {
    const current = state();
    const result = planStateTransition({
      current,
      target: { phase_instance: current.phase_instance, step: "produce", status: "succeeded", attempt: parseSafeInteger(1), input_fingerprint: D("7") },
      recomputed_input_fingerprint: D("8"),
    });
    expect(result.ok ? undefined : result.error.code).toBe("INPUT_FINGERPRINT_MISMATCH");
  });

  it("freezes every workflow movement while an open gate exists", () => {
    const current = state({
      open_gate: {
        gate_id: parsePathSafeId("gate-1"),
        gate_kind: "artifact-approval",
        subject_digest: D("7"),
        context_digest: D("8"),
        frozen_state_digest: D("f"),
        opened_at_revision: parseSafeInteger(4),
      },
    });
    const result = planStateTransition({
      current,
      target: {
        phase_instance: current.phase_instance,
        step: current.step,
        status: "succeeded",
        attempt: current.attempt,
        input_fingerprint: D("9"),
      },
      recomputed_input_fingerprint: D("9"),
    });
    expect(result.ok ? undefined : result.error.code).toBe("TRANSITION_INVALID");
  });

  it("restarts at an earlier planning stage while archiving superseded authority", () => {
    const resultRefs = [
      { phase_instance: parsePhaseInstanceId("prd"), step: "produce" as const, result_digest: D("1"), result_id: parseSafeId("prd-result"), input_fingerprint: D("2") },
      { phase_instance: parsePhaseInstanceId("design"), step: "produce" as const, result_digest: D("3"), result_id: parseSafeId("design-result"), input_fingerprint: D("4") },
      { phase_instance: phase("phase-design", 1), step: "produce" as const, result_digest: D("5"), result_id: parseSafeId("phase-design-result"), input_fingerprint: D("6") },
    ];
    const current = state({
      phase_instance: phase("phase-impl", 1),
      step: "counter_review",
      status: "running",
      planned_final_phase: parseSafeInteger(3),
      authoritative_results: resultRefs,
      waivers: [{
        gate_id: parsePathSafeId("waiver-1"), rule_id: parseSafeId("rule-1"), rule_version: parseSafeInteger(1),
        subject_digest: D("7"), scope: { operation: "review-trigger", boundary: "subject" },
        granted: true, expires: "task-complete", granted_at_revision: parseSafeInteger(3),
      }],
    });
    const restarted = planPlanningRestart({
      current,
      target_phase_instance: parsePhaseInstanceId("design"),
      recomputed_input_fingerprint: D("8"),
      restart_id: parsePathSafeId("restart-1"),
      reason: "Phase planning exposed incorrect requirements.",
      human_provenance: {
        schema_version: "1", actor_class: "human", assurance: "connected-request-trace", channel: "connected-host",
        connection_id: parseSafeId("connection-1"), invocation_id: parseSafeId("invocation-1"), request_id_digest: D("9"), request_digest: D("a"),
      },
    });
    expect(restarted.ok).toBe(true);
    if (!restarted.ok) return;
    expect(restarted.value).toMatchObject({
      phase_instance: "design", step: "produce", status: "running", attempt: 1,
      authoritative_results: [resultRefs[0]], waivers: [],
    });
    expect(restarted.value.planned_final_phase).toBeUndefined();
    expect(restarted.value.restart_history?.at(-1)).toMatchObject({
      source_phase_instance: "phase-impl-1", target_phase_instance: "design",
      superseded_results: [resultRefs[1], resultRefs[2]],
      cleared_waivers: current.waivers,
    });
  });

  it("retains the approved final phase only when restarting at phase design", () => {
    const current = state({
      phase_instance: phase("phase-impl", 2),
      planned_final_phase: parseSafeInteger(4),
    });
    const restarted = planPlanningRestart({
      current,
      target_phase_instance: phase("phase-design", 2),
      recomputed_input_fingerprint: D("8"),
      restart_id: parsePathSafeId("restart-2"),
      reason: "Implementation exposed a plan defect.",
      human_provenance: {
        schema_version: "1", actor_class: "human", assurance: "connected-request-trace", channel: "connected-host",
        connection_id: parseSafeId("connection-1"), invocation_id: parseSafeId("invocation-2"), request_id_digest: D("9"), request_digest: D("a"),
      },
    });
    expect(restarted.ok && restarted.value.planned_final_phase).toBe(4);
  });

  it("rejects initialization artifacts on mature state", () => {
    const current = state();
    const artifact = {
      schema_version: "1", artifact_kind: "task-initialization", task_id: current.task_id,
      repository_identity_digest: current.repository_identity_digest,
      code_baseline_commit: current.policy_base_commit, policy_base_commit: current.policy_base_commit,
      constitution_digest: current.constitution_digest, workflow_digest: current.workflow_digest,
      config_digest: current.config_digest,
      canonical_paths: { task_root: ".archflow/tasks/task-1", config: ".archflow/tasks/task-1/config.yaml",
        state: ".archflow/tasks/task-1/state.json", workflow: ".archflow/workflow.yaml", constitution_root: ".archflow/constitution" },
    } as const;
    const result = planStateTransition({
      current,
      target: { phase_instance: current.phase_instance, step: "produce", status: "succeeded", attempt: parseSafeInteger(1), input_fingerprint: D("8") },
      recomputed_input_fingerprint: D("8"),
      artifact: artifact as never,
    });
    expect(result.ok ? undefined : result.error.code).toBe("TRANSITION_INVALID");
  });

  it("re-derives the planned final phase from a produce that records the design document", () => {
    const current = state({ planned_final_phase: parseSafeInteger(10), step: "produce" });
    const artifact = {
      artifact_kind: "document",
      task_id: current.task_id,
      phase_instance: current.phase_instance,
      step: "produce",
      input_fingerprint: D("8"),
    } as never;
    const reference = {
      phase_instance: current.phase_instance,
      step: "produce" as const,
      result_digest: D("9"),
      result_id: parseSafeId("result-1"),
      input_fingerprint: D("8"),
    };
    const result = planStateTransition({
      current,
      target: { phase_instance: current.phase_instance, step: "produce", status: "succeeded", attempt: parseSafeInteger(1), input_fingerprint: D("8") },
      recomputed_input_fingerprint: D("8"),
      artifact,
      result_reference: reference,
      derived_planned_final_phase: 4,
    });
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value.planned_final_phase).toBe(parseSafeInteger(4));
  });

  it("clears the planned final phase when a recorded open-ended design replaces it", () => {
    const current = state({ planned_final_phase: parseSafeInteger(10), step: "produce" });
    const artifact = {
      artifact_kind: "document",
      task_id: current.task_id,
      phase_instance: current.phase_instance,
      step: "produce",
      input_fingerprint: D("8"),
    } as never;
    const reference = {
      phase_instance: current.phase_instance,
      step: "produce" as const,
      result_digest: D("9"),
      result_id: parseSafeId("result-1"),
      input_fingerprint: D("8"),
    };
    const result = planStateTransition({
      current,
      target: { phase_instance: current.phase_instance, step: "produce", status: "succeeded", attempt: parseSafeInteger(1), input_fingerprint: D("8") },
      recomputed_input_fingerprint: D("8"),
      artifact,
      result_reference: reference,
      derived_planned_final_phase: null,
    });
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value).not.toHaveProperty("planned_final_phase");
  });

  it("keeps the stored planned final phase when the produce records no design document", () => {
    const current = state({ planned_final_phase: parseSafeInteger(10), step: "produce" });
    const artifact = {
      artifact_kind: "document",
      task_id: current.task_id,
      phase_instance: current.phase_instance,
      step: "produce",
      input_fingerprint: D("8"),
    } as never;
    const reference = {
      phase_instance: current.phase_instance,
      step: "produce" as const,
      result_digest: D("9"),
      result_id: parseSafeId("result-1"),
      input_fingerprint: D("8"),
    };
    const result = planStateTransition({
      current,
      target: { phase_instance: current.phase_instance, step: "produce", status: "succeeded", attempt: parseSafeInteger(1), input_fingerprint: D("8") },
      recomputed_input_fingerprint: D("8"),
      artifact,
      result_reference: reference,
    });
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value.planned_final_phase).toBe(parseSafeInteger(10));
  });

  it("does not accept a rule settlement as artifact phase-exit authority", () => {
    const prdExit = state({
      phase_instance: parsePhaseInstanceId("prd"),
      status: "succeeded",
      step: "triage",
      attempt: parseSafeInteger(1),
      rule_settlements: [receipt(parsePhaseInstanceId("prd"), D("5"), 4)],
    });
    const prdCrossing = planStateTransition({
      current: prdExit,
      target: { phase_instance: parsePhaseInstanceId("design"), step: "produce", status: "running", attempt: parseSafeInteger(1), input_fingerprint: D("8") },
      recomputed_input_fingerprint: D("8"),
      completion_subject_digest: D("5"),
    });
    expect(prdCrossing.ok ? undefined : prdCrossing.error.code).toBe("TRANSITION_INVALID");

    // A digest bound to another subject is not this crossing's authority.
    const wrongSubject = planStateTransition({
      current: state({
        phase_instance: parsePhaseInstanceId("prd"),
        status: "succeeded",
        step: "triage",
        attempt: parseSafeInteger(1),
        rule_settlements: [receipt(parsePhaseInstanceId("prd"), D("6"), 4)],
      }),
      target: { phase_instance: parsePhaseInstanceId("design"), step: "produce", status: "running", attempt: parseSafeInteger(1), input_fingerprint: D("8") },
      recomputed_input_fingerprint: D("8"),
      completion_subject_digest: D("5"),
    });
    expect(wrongSubject.ok ? undefined : wrongSubject.error.code).toBe("TRANSITION_INVALID");
  });

  it("does not accept a rule settlement plus commit observation as design crossing authority", () => {
    const designExit = (ruleAdvances: readonly RuleSettlementV1[], observed: boolean) => planStateTransition({
      current: state({
        phase_instance: parsePhaseInstanceId("design"),
        status: "succeeded",
        step: "triage",
        attempt: parseSafeInteger(1),
        rule_settlements: ruleAdvances,
      }),
      target: { phase_instance: phase("phase-design", 1), step: "produce", status: "running", attempt: parseSafeInteger(1), input_fingerprint: D("8") },
      recomputed_input_fingerprint: D("8"),
      completion_subject_digest: D("5"),
      commit_observed: observed,
    });
    expect(designExit([receipt(parsePhaseInstanceId("design"), D("5"), 4)], true).ok).toBe(false);
    expect(designExit([receipt(parsePhaseInstanceId("design"), D("5"), 4)], false).ok).toBe(false);
    expect(designExit([], true).ok).toBe(false);
  });

  it("rejects a plain-object imitation of autonomous crossing authority", () => {
    const current = state({
      phase_instance: parsePhaseInstanceId("prd"), status: "succeeded", step: "triage",
      rule_settlements: [receipt(parsePhaseInstanceId("prd"), D("5"), 4)],
    });
    expect(() => planStateTransition({
      current,
      target: { phase_instance: parsePhaseInstanceId("design"), step: "produce", status: "running", attempt: parseSafeInteger(1), input_fingerprint: D("8") },
      recomputed_input_fingerprint: D("8"), completion_subject_digest: D("5"),
      authenticated_rule_acceptance: {
        policy: {
          task_id: current.task_id,
          policy_base_commit: current.policy_base_commit,
          constitution_digest: current.constitution_digest,
        } as never,
        settlement: current.rule_settlements![0]!,
      },
    })).toThrow(/authenticated rule acceptance policy/u);
  });

  it("does not recover a document handoff from settlement evidence alone", () => {
    const phaseDesign = phase("phase-design", 2);
    const current = state({
      phase_instance: phaseDesign,
      step: "produce",
      status: "succeeded",
      rule_settlements: [receipt(phaseDesign, D("5"), 4)],
    });
    const target = {
      phase_instance: phase("phase-impl", 2),
      step: "produce" as const,
      status: "running" as const,
      attempt: parseSafeInteger(1),
      input_fingerprint: D("8"),
    };

    expect(planStateTransition({
      current,
      target,
      recomputed_input_fingerprint: D("8"),
      completion_subject_digest: D("5"),
      commit_observed: true,
    }).ok).toBe(false);

    // Neither the cursor shape nor commit proof alone supplies authority.
    expect(planStateTransition({
      current: { ...current, rule_settlements: [] },
      target,
      recomputed_input_fingerprint: D("8"),
      completion_subject_digest: D("5"),
      commit_observed: true,
    }).ok).toBe(false);
    expect(planStateTransition({
      current,
      target,
      recomputed_input_fingerprint: D("8"),
      completion_subject_digest: D("5"),
      commit_observed: false,
    }).ok).toBe(false);

    // Recovery remains the fixed graph edge, never a phase skip.
    expect(planStateTransition({
      current,
      target: { ...target, phase_instance: phase("phase-design", 3) },
      recomputed_input_fingerprint: D("8"),
      completion_subject_digest: D("5"),
      commit_observed: true,
    }).ok).toBe(false);
  });

  it("refuses both stale and fresh phase-exit settlements without human approval", () => {
    const restart = {
      restart_id: "restart-1",
      source_phase_instance: phase("phase-design", 2),
      target_phase_instance: parsePhaseInstanceId("prd"),
      reason: "reconsider the plan",
      restarted_at_revision: parseSafeInteger(6),
      superseded_results: [],
      cleared_waivers: [],
      human_provenance: {} as never,
    } as never;
    const superseded = state({
      phase_instance: parsePhaseInstanceId("prd"),
      status: "succeeded",
      step: "triage",
      attempt: parseSafeInteger(1),
      revision: parseSafeInteger(9),
      rule_settlements: [receipt(parsePhaseInstanceId("prd"), D("5"), 4)],
      restart_history: [restart],
    });
    const refused = planStateTransition({
      current: superseded,
      target: { phase_instance: parsePhaseInstanceId("design"), step: "produce", status: "running", attempt: parseSafeInteger(1), input_fingerprint: D("8") },
      recomputed_input_fingerprint: D("8"),
      completion_subject_digest: D("5"),
    });
    expect(refused.ok ? undefined : refused.error.code).toBe("TRANSITION_INVALID");

    // A fresh post-restart evaluation remains evidence only.
    const resettleState = state({
      phase_instance: parsePhaseInstanceId("prd"),
      status: "succeeded",
      step: "triage",
      attempt: parseSafeInteger(1),
      revision: parseSafeInteger(9),
      rule_settlements: [receipt(parsePhaseInstanceId("prd"), D("5"), 4), receipt(parsePhaseInstanceId("prd"), D("5"), 8)],
      restart_history: [restart],
    });
    const freshRefused = planStateTransition({
      current: resettleState,
      target: { phase_instance: parsePhaseInstanceId("design"), step: "produce", status: "running", attempt: parseSafeInteger(1), input_fingerprint: D("8") },
      recomputed_input_fingerprint: D("8"),
      completion_subject_digest: D("5"),
    });
    expect(freshRefused.ok ? undefined : freshRefused.error.code).toBe("TRANSITION_INVALID");
  });

  it("appends the settle-path receipt as one sorted-set entry bound to the settling revision", () => {
    const current = state({ step: "triage" });
    const reference = {
      phase_instance: current.phase_instance,
      step: "triage" as const,
      result_digest: D("9"),
      result_id: parseSafeId("triage-result"),
      input_fingerprint: D("8"),
    };
    const first = planStateTransition({
      current,
      target: { phase_instance: current.phase_instance, step: "triage", status: "succeeded", attempt: parseSafeInteger(1), input_fingerprint: D("8") },
      recomputed_input_fingerprint: D("8"),
      result_reference: reference,
      artifact: { artifact_kind: "triage", evidence: {
        task_id: current.task_id, phase_instance: current.phase_instance, step: "triage",
        input_fingerprint: D("8"), subject_digest: D("5"),
      } } as never,
      rule_settlement: receipt(current.phase_instance, D("5"), 5),
    });
    expect(first.ok).toBe(true);
    if (!first.ok) return;
    expect(first.value.rule_settlements).toEqual([receipt(current.phase_instance, D("5"), 5)]);

    // An exact planning restart re-settles the same (phase_instance, subject_digest) pair at a
    // new revision: the triple key keeps the sorted set valid with both entries present. The
    // order is the durable invariant's own — the schema's tuple key stringifies the revision, so
    // the planner sorts exactly as the strict state schema will re-check it.
    const restartCurrent = state({
      step: "triage",
      revision: parseSafeInteger(9),
      rule_settlements: [receipt(phase("phase-design", 1), D("7"), 3), receipt(current.phase_instance, D("5"), 5)],
    });
    const resettle = planStateTransition({
      current: restartCurrent,
      target: { phase_instance: restartCurrent.phase_instance, step: "triage", status: "succeeded", attempt: parseSafeInteger(1), input_fingerprint: D("8") },
      recomputed_input_fingerprint: D("8"),
      result_reference: { ...reference, input_fingerprint: D("8") },
      artifact: { artifact_kind: "triage", evidence: {
        task_id: restartCurrent.task_id, phase_instance: restartCurrent.phase_instance, step: "triage",
        input_fingerprint: D("8"), subject_digest: D("5"),
      } } as never,
      rule_settlement: receipt(restartCurrent.phase_instance, D("5"), 10),
    });
    expect(resettle.ok).toBe(true);
    if (!resettle.ok) return;
    expect(resettle.value.rule_settlements).toEqual([
      receipt(phase("phase-design", 1), D("7"), 3),
      receipt(restartCurrent.phase_instance, D("5"), 5),
      receipt(restartCurrent.phase_instance, D("5"), 10),
    ]);
    expect(taskStateV1Schema.safeParse({
      ...resettle.value,
      revision: parseSafeInteger(10),
    }).success).toBe(true);

    // A receipt that does not bind this exact transaction — wrong revision, wrong phase, wrong
    // task — is refused rather than appended.
    for (const mismatch of [
      receipt(current.phase_instance, D("5"), 4),
      receipt(phase("phase-design", 3), D("5"), 5),
      { ...receipt(current.phase_instance, D("5"), 5), task_id: parseTaskSlug("other-task") },
    ] as const) {
      const refused = planStateTransition({
        current,
        target: { phase_instance: current.phase_instance, step: "triage", status: "succeeded", attempt: parseSafeInteger(1), input_fingerprint: D("8") },
        recomputed_input_fingerprint: D("8"),
        result_reference: reference,
        artifact: { artifact_kind: "triage", evidence: {
          task_id: current.task_id, phase_instance: current.phase_instance, step: "triage",
          input_fingerprint: D("8"), subject_digest: D("5"),
        } } as never,
        rule_settlement: mismatch,
      });
      expect(refused.ok ? undefined : refused.error.code).toBe("TRANSITION_INVALID");
    }
  });

  it("accepts a settlement carrier only for exact editorial produce re-entry", () => {
    const current = state({ step: "produce", status: "running" });
    const reference = {
      phase_instance: current.phase_instance,
      step: "produce" as const,
      result_digest: D("9"),
      result_id: parseSafeId("editorial-produce-result"),
      input_fingerprint: D("8"),
    };
    const artifact = {
      artifact_kind: "document",
      task_id: current.task_id,
      phase_instance: current.phase_instance,
      step: "produce",
      input_fingerprint: D("8"),
      editorial_predecessor: {
        subject_digest: D("4"), input_fingerprint: D("8"), triage_result_digest: D("3"),
      },
    } as never;
    const transition = (stateOverrides: Partial<TaskStateV1> = {}) => planStateTransition({
      current: state({ ...current, ...stateOverrides }),
      target: {
        phase_instance: current.phase_instance, step: "produce", status: "succeeded",
        attempt: current.attempt, input_fingerprint: D("8"),
      },
      recomputed_input_fingerprint: D("8"), artifact, result_reference: reference,
      resulting_subject_digest: D("5"),
      rule_settlement: { ...receipt(current.phase_instance, D("5"), 5), step: "produce" },
    });

    expect(transition().ok).toBe(true);
    // A pending human revision marks the simple/significant human-owned path, where settlement
    // creation is forbidden even if an artifact tries to carry an editorial predecessor.
    expect(transition({
      pending_human_revision: {
        gate_id: parsePathSafeId("human-revision"), gate_kind: "artifact-approval",
        predecessor_subject_digest: D("4"), predecessor_input_fingerprint: D("8"),
        requested_at_revision: parseSafeInteger(4), attempt: current.attempt, evidence: [],
      },
    }).ok).toBe(false);
  });
});

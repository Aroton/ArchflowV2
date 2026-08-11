import { describe, expect, it } from "vitest";

import type { TaskStateV1 } from "../../src/contracts/durable-state.js";
import { parsePathSafeId, parseSafeId, parseSafeInteger, parseSha256Digest, parseTaskSlug } from "../../src/contracts/evidence.js";
import { encodePhaseInstance, parsePhaseInstanceId, parsePositiveSafePhaseNumber } from "../../src/contracts/phase-instance.js";
import { parseRepositoryPathClaim } from "../../src/contracts/path-claims.js";
import { legalRunStepStatus, planStateTransition } from "../../src/state/transitions.js";

const D = (value: string) => parseSha256Digest(value.repeat(64));
const phase = (kind: "phase-design" | "phase-impl", number: number) => encodePhaseInstance({ kind, phase: parsePositiveSafePhaseNumber(number) });

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
  it("plans the exact running-to-succeeded lifecycle move", () => {
    const current = state({ step: "counter_review" });
    const reference = {
      phase_instance: current.phase_instance,
      step: "counter_review" as const,
      result_digest: D("9"),
      result_id: parseSafeId("counter-review-result"),
      input_fingerprint: D("8"),
      manifest_path: parseRepositoryPathClaim(".archflow/tasks/task-1/results/sha256/" + "9".repeat(64) + "/manifest.json"),
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
      manifest_path: parseRepositoryPathClaim(".archflow/tasks/task-1/results/sha256/" + "9".repeat(64) + "/manifest.json"),
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

  it("moves only through the fixed pipeline and fixed phase sequence", () => {
    const current = state({ status: "succeeded", step: "adjudicate", attempt: parseSafeInteger(3) });
    const result = planStateTransition({
      current,
      target: { phase_instance: phase("phase-impl", 2), step: "produce", status: "running", attempt: parseSafeInteger(1), input_fingerprint: D("8") },
      recomputed_input_fingerprint: D("8"),
    });
    expect(result.ok).toBe(true);

    const skipped = planStateTransition({
      current,
      target: { phase_instance: phase("phase-design", 3), step: "produce", status: "running", attempt: parseSafeInteger(1), input_fingerprint: D("8") },
      recomputed_input_fingerprint: D("8"),
    });
    expect(skipped.ok ? undefined : skipped.error.code).toBe("TRANSITION_INVALID");
  });

  it("keeps the ordinary design successor available when a later legacy resume phase exists", () => {
    const current = state({
      phase_instance: parsePhaseInstanceId("design"),
      status: "succeeded",
      step: "adjudicate",
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
    expect(result.ok).toBe(true);
  });

  it("does not advance an implementation phase until its authorized commit is observed", () => {
    const current = state({
      phase_instance: phase("phase-impl", 2),
      status: "succeeded",
      step: "adjudicate",
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

    for (const step of ["triage", "adjudicate"] as const) {
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

  it("admits the direct produce-to-adjudicate entry only at the same attempt", () => {
    const current = state({ status: "succeeded", attempt: parseSafeInteger(2) });
    const entry = planStateTransition({
      current,
      target: { phase_instance: current.phase_instance, step: "adjudicate", status: "running", attempt: parseSafeInteger(2), input_fingerprint: D("8") },
      recomputed_input_fingerprint: D("8"),
    });
    expect(entry.ok).toBe(true);

    const bumped = planStateTransition({
      current,
      target: { phase_instance: current.phase_instance, step: "adjudicate", status: "running", attempt: parseSafeInteger(3), input_fingerprint: D("8") },
      recomputed_input_fingerprint: D("8"),
    });
    expect(bumped.ok ? undefined : bumped.error.code).toBe("TRANSITION_INVALID");
    expect(legalRunStepStatus(current, "adjudicate")).toBe("running");
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

  it("keeps the surrounding movement space closed", () => {
    // running -> running never moves sideways.
    const midProduce = state();
    const sideways = planStateTransition({
      current: midProduce,
      target: { phase_instance: midProduce.phase_instance, step: "counter_review", status: "running", attempt: parseSafeInteger(1), input_fingerprint: D("8") },
      recomputed_input_fingerprint: D("8"),
    });
    expect(sideways.ok ? undefined : sideways.error.code).toBe("TRANSITION_INVALID");

    // adjudicate-failed re-enters only itself, never produce.
    const failedAdjudication = state({ step: "adjudicate", status: "failed" });
    const backward = planStateTransition({
      current: failedAdjudication,
      target: { phase_instance: failedAdjudication.phase_instance, step: "produce", status: "running", attempt: parseSafeInteger(2), input_fingerprint: D("8") },
      recomputed_input_fingerprint: D("8"),
    });
    expect(backward.ok ? undefined : backward.error.code).toBe("TRANSITION_INVALID");
    expect(legalRunStepStatus(failedAdjudication, "produce")).toBeUndefined();

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
});

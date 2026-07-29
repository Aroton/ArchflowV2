import { describe, expect, it } from "vitest";

import type { TaskStateV1 } from "../../src/contracts/durable-state.js";
import { parseSafeInteger, parseSha256Digest, parseTaskSlug } from "../../src/contracts/evidence.js";
import { encodePhaseInstance, parsePositiveSafePhaseNumber } from "../../src/contracts/phase-instance.js";
import { planStateTransition } from "../../src/state/transitions.js";

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
    const current = state({ step: "self_review" });
    const result = planStateTransition({
      current,
      target: { phase_instance: current.phase_instance, step: "self_review", status: "succeeded", attempt: parseSafeInteger(1), input_fingerprint: D("8") },
      recomputed_input_fingerprint: D("8"),
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

  it("moves only through the fixed pipeline and fixed phase sequence", () => {
    const current = state({ status: "succeeded", step: "adjudicate" });
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

  it("rejects a stale fingerprint before planning", () => {
    const current = state();
    const result = planStateTransition({
      current,
      target: { phase_instance: current.phase_instance, step: "produce", status: "succeeded", attempt: parseSafeInteger(1), input_fingerprint: D("7") },
      recomputed_input_fingerprint: D("8"),
    });
    expect(result.ok ? undefined : result.error.code).toBe("INPUT_FINGERPRINT_MISMATCH");
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

import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

import { taskStateV1Schema } from "../../src/contracts/durable-state.js";
import {
  archFlowApplyInputV1Schema,
  parseArchFlowApplyInputV1,
  parseSemanticResultV1,
  parseWorkflowInvocationV1,
} from "../../src/contracts/semantic-workflow.js";
import {
  comparePhaseInstances,
  isStrictlyEarlierPlanningPhase,
  parsePhaseInstanceId,
} from "../../src/contracts/phase-instance.js";
import semanticWorkflowSchema from "../../src/contracts/schemas/v1/semantic-workflow.schema.json" with { type: "json" };

const offer = `af1_${"a".repeat(64)}`;
const baseApply = () => ({
  schema_version: "1",
  task_id: "api-refactor",
  invocation: { skill: "archflow-phase-design", phase: 1, intent: "reopen" },
  action: { offer, submission: { kind: "reopening-request", request: " Preserve these exact bytes. " } },
});

describe("semantic workflow contracts", () => {
  it("strictly materializes the compact semantic result union", () => {
    const view = {
      schema_version: "1", task_id: "task-1", condition: "ready", headline: "Ready", detail: "Continue.", resources: [],
      next_action: { kind: "inspect", instruction: "Inspect status." },
    } as const;
    expect(parseSemanticResultV1({ schema_version: "1", ok: true, value: view })).toEqual({ schema_version: "1", ok: true, value: view });
    expect(parseSemanticResultV1({ schema_version: "1", ok: false, error: { code: "STALE_OFFER", message: "Refresh status.", retryable: true }, view })).toMatchObject({ ok: false, view });
    expect(() => parseSemanticResultV1({ schema_version: "1", ok: false, error: { code: "BAD", message: "Bad.", retryable: false }, diagnostic: {} })).toThrow();
    const accessor = Object.defineProperty({}, "schema_version", { enumerable: true, get: () => "1" });
    expect(() => parseSemanticResultV1(accessor)).toThrow(/accessor/u);
  });
  it("keeps the public apply schema root a plain object and nests its variants", () => {
    const apply = (semanticWorkflowSchema.$defs as Record<string, Record<string, unknown>>).applyInput;
    expect(apply?.type).toBe("object");
    expect(apply).not.toHaveProperty("oneOf");
    expect(apply).not.toHaveProperty("allOf");
    expect(apply).not.toHaveProperty("$ref");
    expect(archFlowApplyInputV1Schema.safeParse(baseApply()).success).toBe(true);
  });

  it("accepts every invocation shape and refuses phase-implementation reopen", () => {
    for (const invocation of [
      { skill: "archflow-prd", intent: "resume" },
      { skill: "archflow-design", intent: "reopen" },
      { skill: "archflow-phase-design", phase: 2, intent: "resume" },
      { skill: "archflow-phase-impl", phase: 2, intent: "resume" },
    ]) expect(() => parseWorkflowInvocationV1(invocation)).not.toThrow();
    expect(() => parseWorkflowInvocationV1({ skill: "archflow-phase-impl", phase: 2, intent: "reopen" })).toThrow();
  });

  it("preserves authored request bytes and rejects unstable caller-owned objects", () => {
    expect(parseArchFlowApplyInputV1(baseApply()).action.submission).toEqual({
      kind: "reopening-request",
      request: " Preserve these exact bytes. ",
    });
    const action = {} as Record<string, unknown>;
    Object.defineProperty(action, "offer", { enumerable: true, get: () => offer });
    expect(() => parseArchFlowApplyInputV1({ ...baseApply(), action })).toThrow(/accessor/u);
    const hidden = baseApply();
    Object.defineProperty(hidden.action, "hidden", { enumerable: false, value: true });
    expect(() => parseArchFlowApplyInputV1(hidden)).toThrow(/non-enumerable/u);
  });
});

describe("planning restart contract", () => {
  const fixture = (): Record<string, unknown> => JSON.parse(readFileSync(
    new URL("../fixtures/contracts/durable/task-state.valid.json", import.meta.url),
    "utf8",
  )) as Record<string, unknown>;
  const restart = () => ({
    restart_id: "afop-restart-0001",
    source_phase_instance: "phase-impl-1",
    target_phase_instance: "design",
    reason: "Rework the API boundary.",
    restarted_at_revision: 7,
    superseded_results: [],
    cleared_waivers: [],
    human_provenance: {
      schema_version: "1",
      actor_class: "human",
      assurance: "declared-local-trace",
      channel: "connected-host",
      decision_event_id: "decision-1",
      connection_id: "connection-1",
      request_id_digest: "1".repeat(64),
      recorded_at: "2026-08-16T12:00:00.000Z",
    },
  });

  it("defines one total phase order and strict planning targets", () => {
    const ids = ["prd", "design", "phase-design-1", "phase-impl-1", "phase-design-2", "phase-impl-2"].map(parsePhaseInstanceId);
    ids.slice(1).forEach((id, index) => expect(comparePhaseInstances(ids[index]!, id)).toBeLessThan(0));
    expect(isStrictlyEarlierPlanningPhase(parsePhaseInstanceId("phase-design-1"), parsePhaseInstanceId("phase-impl-2"))).toBe(true);
    expect(isStrictlyEarlierPlanningPhase(parsePhaseInstanceId("phase-impl-1"), parsePhaseInstanceId("phase-impl-2"))).toBe(false);
  });

  it("keeps old state readable and accepts one canonical restart record", () => {
    expect(taskStateV1Schema.safeParse(fixture()).success).toBe(true);
    expect(taskStateV1Schema.safeParse({ ...fixture(), restart_history: [restart()] }).success).toBe(true);
  });

  it("rejects non-planning, non-earlier, future, and duplicate restart records", () => {
    const sample = fixture();
    expect(taskStateV1Schema.safeParse({ ...sample, restart_history: [{ ...restart(), target_phase_instance: "phase-impl-1" }] }).success).toBe(false);
    expect(taskStateV1Schema.safeParse({ ...sample, restart_history: [{ ...restart(), target_phase_instance: "phase-design-2" }] }).success).toBe(false);
    expect(taskStateV1Schema.safeParse({ ...sample, restart_history: [{ ...restart(), restarted_at_revision: 8 }] }).success).toBe(false);
    expect(taskStateV1Schema.safeParse({ ...sample, restart_history: [restart(), restart()] }).success).toBe(false);
  });
});

import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

import { taskStateV1Schema } from "../../src/contracts/durable-state.js";
import {
  archFlowApplyInputV1Schema,
  parseArchFlowApplyInputV1,
  parseArchFlowStatusInputV1,
  parseSemanticResultV1,
  parseWorkflowInvocationV1,
  unavailableImplementationRecommendation,
} from "../../src/contracts/semantic-workflow.js";
import {
  comparePhaseInstances,
  isStrictlyEarlierPlanningPhase,
  parsePhaseInstanceId,
} from "../../src/contracts/phase-instance.js";
import semanticWorkflowSchema from "../../src/contracts/schemas/v1/semantic-workflow.schema.json" with { type: "json" };

const offer = `af1_${"a".repeat(64)}`;
const unavailable = unavailableImplementationRecommendation(
  "not-applicable", "This contract fixture has no applicable implementation phase.",
);
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
      implementation_recommendation: unavailable,
    } as const;
    expect(parseSemanticResultV1({ schema_version: "1", ok: true, value: view })).toEqual({ schema_version: "1", ok: true, value: view });
    expect(parseSemanticResultV1({ schema_version: "1", ok: false, error: { code: "STALE_OFFER", message: "Refresh status.", retryable: true }, view })).toMatchObject({ ok: false, view });
    expect(() => parseSemanticResultV1({ schema_version: "1", ok: false, error: { code: "BAD", message: "Bad.", retryable: false }, diagnostic: {} })).toThrow();
    const accessor = Object.defineProperty({}, "schema_version", { enumerable: true, get: () => "1" });
    expect(() => parseSemanticResultV1(accessor)).toThrow(/accessor/u);
  });

  it("requires structured boundary reasons and exposes commit facts without a confirmation flag", () => {
    const value = {
      schema_version: "1",
      task_id: "task-1",
      condition: "awaiting-human",
      headline: "Approval required",
      detail: "Review the exact result.",
      resources: [],
      next_action: {
        kind: "commit",
        instruction: "Commit the authenticated bytes.",
        commit: { paths: ["src/a.ts"], message: "Implement the phase", target_ref: "refs/heads/main", baseline: "1".repeat(40) },
      },
      implementation_recommendation: unavailable,
      presentation: {
        class: "exception",
        title: "Approval required",
        summary: "A policy finding requires judgment.",
        question: "Do you approve?",
        reasons: [{ class: "exception", text: "The pinned rule reported an uncertain result." }],
        options: [{ token: "choice-1", label: "Approve", consequence: "Commit and continue." }],
      },
    } as const;
    expect(parseSemanticResultV1({ schema_version: "1", ok: true, value })).toMatchObject({ ok: true, value });
    expect(() => parseSemanticResultV1({
      schema_version: "1",
      ok: true,
      value: { ...value, next_action: { ...value.next_action, commit: { ...value.next_action.commit, requires_human_confirmation: false } } },
    })).toThrow();
    expect(() => parseSemanticResultV1({
      schema_version: "1",
      ok: true,
      value: { ...value, presentation: { ...value.presentation, reasons: [] } },
    })).toThrow();
    expect(() => parseSemanticResultV1({
      schema_version: "1",
      ok: true,
      value: { ...value, presentation: { ...value.presentation, class: "configured-approval" } },
    })).toThrow(/presentation class/u);
    const secondary = {
      ...value,
      next_action: {
        ...value.next_action,
        commit: { ...value.next_action.commit, repository: { name: "api", location: "/work/api" } },
      },
    };
    expect(parseSemanticResultV1({ schema_version: "1", ok: true, value: secondary })).toMatchObject({
      value: { next_action: { commit: { repository: { name: "api", location: "/work/api" } } } },
    });
  });

  it("accepts ordered writable-secondary implementation declarations", () => {
    const value = {
      schema_version: "1",
      task_id: "api-refactor",
      invocation: { skill: "archflow-phase-impl", phase: 3, intent: "resume" },
      action: { offer, submission: { kind: "work-result", outcome: "succeeded", implementation: {
        base_commit: "1".repeat(40), outputs: [".archflow/tasks/api-refactor/phases/3/impl-notes.md"], restore_targets: [], declared_inputs: [],
        repositories: [{ name: "api", base_commit: "2".repeat(40), outputs: [], restore_targets: [], declared_inputs: [] }],
      } } },
    } as const;
    expect(parseArchFlowApplyInputV1(value)).toEqual(value);
  });
  it("keeps the public apply schema root a plain object and nests its variants", () => {
    const apply = (semanticWorkflowSchema.$defs as Record<string, Record<string, unknown>>).applyInput;
    expect(apply?.type).toBe("object");
    expect(apply).not.toHaveProperty("oneOf");
    expect(apply).not.toHaveProperty("allOf");
    expect(apply).not.toHaveProperty("$ref");
    expect(archFlowApplyInputV1Schema.safeParse(baseApply()).success).toBe(true);
  });

  it("round-trips strict optional review routes on every invocation shape and refuses phase-implementation reopen", () => {
    const review_routes = {
      "counter-reviewer": { model: "claude-fable-5", effort: "high", provider: "zai" },
      adjudicator: { model: "gpt-5.6", effort: "max" },
    } as const;
    for (const invocation of [
      { skill: "archflow-prd", intent: "resume", review_routes },
      { skill: "archflow-design", intent: "reopen", review_routes },
      { skill: "archflow-phase-design", phase: 2, intent: "resume", review_routes },
      { skill: "archflow-phase-impl", phase: 2, intent: "resume", review_routes },
    ]) {
      expect(parseWorkflowInvocationV1(invocation)).toEqual(invocation);
      expect(parseArchFlowStatusInputV1({ schema_version: "1", task_id: "api-refactor", invocation }).invocation).toEqual(invocation);
      expect(parseArchFlowApplyInputV1({ schema_version: "1", task_id: "api-refactor", invocation, action: { offer } }).invocation).toEqual(invocation);
    }
    const specialistRoutes = {
      ...review_routes,
      "test-reviewer": { model: "gpt-5.6-luna", effort: "max" },
    } as const;
    for (const invocation of [
      { skill: "archflow-phase-design", phase: 2, intent: "resume", review_routes: specialistRoutes },
      { skill: "archflow-phase-impl", phase: 2, intent: "resume", review_routes: specialistRoutes },
    ]) expect(parseWorkflowInvocationV1(invocation)).toEqual(invocation);
    for (const skill of ["archflow-prd", "archflow-design"] as const) {
      expect(() => parseWorkflowInvocationV1({ skill, intent: "resume", review_routes: specialistRoutes }))
        .toThrow(/test-reviewer|unrecognized/iu);
      expect(() => parseArchFlowApplyInputV1({
        schema_version: "1", task_id: "api-refactor",
        invocation: { skill, intent: "resume" },
        action: {
          offer,
          submission: {
            kind: "review-dispatch",
            route_override: {
              reason: "temporary test route",
              "test-reviewer": { model: "gpt-5.6-luna", effort: "max" },
            },
          },
        },
      })).toThrow(/only for phase design/iu);
    }
    expect(() => parseWorkflowInvocationV1({ skill: "archflow-phase-impl", phase: 2, intent: "reopen" })).toThrow();
    expect(() => parseWorkflowInvocationV1({ skill: "archflow-prd", intent: "resume", review_routes: {} })).toThrow(/review_routes/u);
    expect(() => parseWorkflowInvocationV1({ skill: "archflow-prd", intent: "resume", review_routes: { reviewer: review_routes["counter-reviewer"] } })).toThrow();
    expect(() => parseWorkflowInvocationV1({ skill: "archflow-prd", intent: "resume", review_routes: { adjudicator: { model: "gpt-5.6", effort: "extreme" } } })).toThrow();
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

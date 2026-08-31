import { describe, expect, it } from "vitest";

import {
  createAutomationStatus,
  createAutomationStatusV2,
  parseAutomationStatus,
  parseAutomationStatusV2,
  type AutomationStatusWithoutIdV1,
  type AutomationStatusWithoutIdV2,
} from "../../src/contracts/automation-status.js";
import { parseSafeInteger, parseSha256Digest, parseTaskSlug } from "../../src/contracts/evidence.js";
import automationStatusSchema from "../../src/contracts/schemas/v1/automation-status.schema.json" with { type: "json" };
import automationStatusV2Schema from "../../src/contracts/schemas/v1/automation-status-v2.schema.json" with { type: "json" };
import primitivesSchema from "../../src/contracts/schemas/v1/primitives.schema.json" with { type: "json" };
import semanticWorkflowSchema from "../../src/contracts/schemas/v1/semantic-workflow.schema.json" with { type: "json" };
import { createJsonSchemaValidator } from "../helpers/json-schema.js";

const task = parseTaskSlug("automation-contract");
const stateDigest = parseSha256Digest("a".repeat(64));
const configDigest = parseSha256Digest("b".repeat(64));
const repositoryDigest = parseSha256Digest("c".repeat(64));
const authority = {
  kind: "readable" as const,
  repository_identity_digest: repositoryDigest,
  state_document_digest: stateDigest,
  live_config_digest: configDigest,
  semantic_snapshot_digest: stateDigest,
};

const ready = (): AutomationStatusWithoutIdV1 => ({
  schema_version: "1",
  task_id: task,
  state_revision: parseSafeInteger(7),
  position: { kind: "phase-design", phase: 2 },
  condition: "ready",
  next_action: {
    actor: "orchestrator",
    kind: "launch-skill",
    skill: "archflow-phase-impl",
    task_id: task,
    skill_args: ["2"],
    instruction: "Launch the server-derived successor.",
  },
});

const unavailable = {
  status: "unavailable" as const,
  phase: 2,
  reason: "not-produced" as const,
  explanation: "No authenticated implementation recommendation has been produced.",
  actual_implementation_route: { status: "not-recorded" as const },
};

const readyV2 = (): AutomationStatusWithoutIdV2 => ({
  ...ready(),
  schema_version: "2",
  implementation_recommendation: unavailable,
});

describe("automation status contract", () => {
  const validate = createJsonSchemaValidator(automationStatusSchema, [primitivesSchema, semanticWorkflowSchema]);

  it("round-trips the strict runtime and generated schema authorities", () => {
    const value = createAutomationStatus(ready(), authority);
    expect(parseAutomationStatus(value)).toEqual(value);
    expect(validate.assert(value)).toEqual(value);
    expect(automationStatusSchema.$id).toBe("urn:archflow:schema:v1:automation-status");
  });

  it("rejects condition data in the wrong arm and any unknown field", () => {
    const value = createAutomationStatus(ready(), authority);
    expect(() => parseAutomationStatus({
      ...value,
      human_boundary: {
        source: "presentation", class: "exception", headline: "No", summary: "No",
        question: "No?", reasons: [{ class: "exception", text: "No." }],
      },
    })).toThrow();
    expect(() => parseAutomationStatus({ ...value, offer: "not-authority" })).toThrow();
  });

  it("binds identity to the complete ID-less observation and authority facts", () => {
    const first = createAutomationStatus(ready(), authority);
    expect(createAutomationStatus(structuredClone(ready()), structuredClone(authority)).observation_id)
      .toBe(first.observation_id);
    expect(createAutomationStatus({ ...ready(), state_revision: parseSafeInteger(8) }, authority).observation_id)
      .not.toBe(first.observation_id);
    expect(createAutomationStatus(ready(), { ...authority, live_config_digest: stateDigest }).observation_id)
      .not.toBe(first.observation_id);
    expect(createAutomationStatus(ready(), { ...authority, state_document_digest: configDigest }).observation_id)
      .not.toBe(first.observation_id);
    expect(createAutomationStatus(ready(), { ...authority, repository_identity_digest: stateDigest }).observation_id)
      .not.toBe(first.observation_id);
    expect(createAutomationStatus(ready(), { ...authority, semantic_snapshot_digest: configDigest }).observation_id)
      .not.toBe(first.observation_id);
  });

  it("never admits decision tokens into a human boundary", () => {
    const human: Extract<AutomationStatusWithoutIdV1, { readonly condition: "awaiting-human" }> = {
      schema_version: "1", task_id: task, state_revision: parseSafeInteger(7), position: { kind: "design" },
      condition: "awaiting-human",
      next_action: {
        actor: "human", kind: "respond-in-session", skill: "archflow-design",
        task_id: task, skill_args: [], instruction: "Answer in the owning session.",
      },
      human_boundary: {
        source: "presentation", class: "configured-approval", headline: "Approval",
        summary: "Review the final bytes.", question: "Approve?",
        reasons: [{ class: "configured-approval", text: "The configured rule requires approval." }],
      },
    };
    const value = createAutomationStatus(human, authority);
    expect(JSON.stringify(value)).not.toContain("token");
    const withToken = {
      ...human,
      human_boundary: { ...human.human_boundary, token: "approve" },
    } as unknown as AutomationStatusWithoutIdV1;
    expect(() => createAutomationStatus(withToken, authority)).toThrow();
  });

  it("requires positions on every readable condition and semantic blocked category", () => {
    const positioned: readonly AutomationStatusWithoutIdV1[] = [
      {
        schema_version: "1", task_id: task, state_revision: parseSafeInteger(7), position: { kind: "phase-design", phase: 2 },
        condition: "awaiting-client",
        next_action: {
          actor: "skill", kind: "continue-skill", skill: "archflow-phase-design",
          task_id: task, skill_args: ["2"], instruction: "Continue the current skill.",
        },
      },
      {
        schema_version: "1", task_id: task, state_revision: parseSafeInteger(7), position: { kind: "design" },
        condition: "awaiting-human",
        next_action: {
          actor: "human", kind: "respond-in-session", skill: "archflow-design",
          task_id: task, skill_args: [], instruction: "Answer in the current session.",
        },
        human_boundary: {
          source: "presentation", class: "configured-approval", headline: "Approval",
          summary: "Review the bytes.", question: "Approve?",
          reasons: [{ class: "configured-approval", text: "Approval is configured." }],
        },
      },
      ready(),
      {
        schema_version: "1", task_id: task, state_revision: parseSafeInteger(7), position: { kind: "phase-impl", phase: 2 },
        condition: "blocked",
        next_action: { actor: "operator", kind: "repair", instruction: "Inspect durable state." },
        blocked: { category: "inspect-state", reasons: ["state inspection is required"] },
      },
      {
        schema_version: "1", task_id: task, state_revision: parseSafeInteger(7), position: { kind: "phase-impl", phase: 2 },
        condition: "complete",
        next_action: { actor: "none", kind: "none", instruction: "No further action is required." },
      },
    ];
    for (const document of positioned) {
      const valid = createAutomationStatus(document, authority);
      const withoutPosition = { ...valid, position: null };
      expect(() => parseAutomationStatus(withoutPosition), document.condition).toThrow();
      expect(() => validate.assert(withoutPosition), document.condition).toThrow();
    }
  });

  it("requires null position only for unreadable and staged repository-edge blocks", () => {
    const edge: AutomationStatusWithoutIdV1 = {
      schema_version: "1", task_id: task, state_revision: null, position: null,
      condition: "blocked",
      next_action: { actor: "operator", kind: "repair", instruction: "Repair the unreadable state." },
      blocked: { category: "state-unreadable", reasons: ["state-noncanonical"] },
    };
    const value = createAutomationStatus(edge, {
      kind: "unreadable", repository_identity_digest: repositoryDigest,
      classification: "noncanonical", identity_digest: stateDigest, live_config_digest: configDigest,
    });
    expect(validate.assert(value)).toEqual(value);
    if (value.condition !== "blocked") throw new TypeError("expected blocked fixture");
    expect(() => parseAutomationStatus({ ...value, position: { kind: "prd" } })).toThrow();
    expect(() => validate.assert({ ...value, position: { kind: "prd" } })).toThrow();
    expect(() => parseAutomationStatus({ ...value, blocked: { ...value.blocked, reasons: [] } })).toThrow();
    expect(() => validate.assert({ ...value, blocked: { ...value.blocked, reasons: [] } })).toThrow();
  });

  it("requires nonempty reasons and an aggregate class matching exceptional reasons", () => {
    const human = {
      schema_version: "1", task_id: task, state_revision: parseSafeInteger(7), position: { kind: "design" },
      condition: "awaiting-human",
      next_action: {
        actor: "human", kind: "respond-in-session", skill: "archflow-design",
        task_id: task, skill_args: [], instruction: "Answer in the current session.",
      },
      human_boundary: {
        source: "presentation", class: "exception", headline: "Approval", summary: "Review.", question: "Approve?",
        reasons: [
          { class: "configured-approval", text: "Approval is configured." },
          { class: "exception", text: "An exceptional risk also needs judgment." },
        ],
      },
    } as const;
    const valid = createAutomationStatus(human, authority);
    expect(valid).toMatchObject({ condition: "awaiting-human" });
    expect(() => createAutomationStatus({
      ...human, human_boundary: { ...human.human_boundary, class: "configured-approval" },
    } as unknown as AutomationStatusWithoutIdV1, authority)).toThrow(/class/u);
    expect(() => validate.assert({
      ...valid,
      human_boundary: { ...human.human_boundary, class: "configured-approval" },
    })).toThrow();
    expect(() => createAutomationStatus({
      ...human, human_boundary: { ...human.human_boundary, class: "exception", reasons: [human.human_boundary.reasons[0]] },
    } as unknown as AutomationStatusWithoutIdV1, authority)).toThrow(/class/u);
    expect(() => createAutomationStatus({
      ...human, human_boundary: { ...human.human_boundary, reasons: [] },
    } as unknown as AutomationStatusWithoutIdV1, authority)).toThrow();
    expect(() => validate.assert({
      ...valid, human_boundary: { ...human.human_boundary, reasons: [] },
    })).toThrow();

    const dispatch = {
      ...human,
      human_boundary: {
        source: "dispatch-failure", class: "exception", headline: "Reviewer unavailable",
        summary: "The reviewer route failed.", question: "Repair or substitute?",
        reasons: [{ class: "configured-approval", text: "A reviewer is configured." }],
        failed_role: "counter-reviewer", failure_code: "AUTH_UNAVAILABLE",
      },
    } as unknown as AutomationStatusWithoutIdV1;
    expect(() => createAutomationStatus(dispatch, authority)).toThrow(/exceptional reason/u);
    expect(() => validate.assert({ ...dispatch, observation_id: valid.observation_id })).toThrow();
  });
});

describe("automation status v2 contract", () => {
  const validateV1 = createJsonSchemaValidator(automationStatusSchema, [primitivesSchema, semanticWorkflowSchema]);
  const validateV2 = createJsonSchemaValidator(automationStatusV2Schema, [primitivesSchema, semanticWorkflowSchema]);

  it("round-trips only v2 through its strict runtime and generated schema", () => {
    const value = createAutomationStatusV2(readyV2(), authority);
    expect(parseAutomationStatusV2(value)).toEqual(value);
    expect(validateV2.assert(value)).toEqual(value);
    expect(automationStatusV2Schema.$id).toBe("urn:archflow:schema:v2:automation-status");
    expect(() => parseAutomationStatus(value)).toThrow();
    expect(() => validateV1.assert(value)).toThrow();

    const v1 = createAutomationStatus(ready(), authority);
    expect(() => parseAutomationStatusV2(v1)).toThrow();
    expect(() => validateV2.assert(v1)).toThrow();
  });

  it("binds recommendation bytes into the v2 observation identity", () => {
    const first = createAutomationStatusV2(readyV2(), authority);
    const changed = createAutomationStatusV2({
      ...readyV2(),
      implementation_recommendation: {
        ...unavailable,
        reason: "subject-stale",
        explanation: "The retained recommendation belongs to prior design bytes.",
      },
    }, authority);
    expect(changed.observation_id).not.toBe(first.observation_id);
    expect(changed.next_action).toEqual(first.next_action);
  });

  it("admits effort-reviewer only in the v2 dispatch-failure vocabulary", () => {
    const document: AutomationStatusWithoutIdV2 = {
      schema_version: "2", task_id: task, state_revision: parseSafeInteger(7), position: { kind: "phase-design", phase: 2 },
      implementation_recommendation: unavailable,
      condition: "awaiting-human",
      next_action: {
        actor: "human", kind: "respond-in-session", skill: "archflow-phase-design",
        task_id: task, skill_args: ["2"], instruction: "Repair or substitute the effort reviewer.",
      },
      human_boundary: {
        source: "dispatch-failure", class: "exception", headline: "Effort reviewer unavailable",
        summary: "The configured effort reviewer failed.", question: "Repair or substitute?",
        reasons: [{ class: "exception", text: "Effort review is required." }],
        failed_role: "effort-reviewer", failure_code: "AUTH_UNAVAILABLE",
      },
    };
    const value = createAutomationStatusV2(document, authority);
    expect(parseAutomationStatusV2(value)).toEqual(value);
    expect(validateV2.assert(value)).toEqual(value);
  });
});

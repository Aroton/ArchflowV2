import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

import { createAutomationStatus, createAutomationStatusV2, parseAutomationStatus, parseAutomationStatusV2, type AutomationStatusWithoutIdV1, type AutomationStatusWithoutIdV2 } from "../../src/contracts/automation-status.js";
import { taskStateV1Schema, validationOverrideRecordV1Schema } from "../../src/contracts/durable-state.js";
import { computeRequestDigest, type RequestDigestSubject } from "../../src/contracts/fingerprints.js";
import { parseSafeInteger, parseSha256Digest, parseTaskSlug } from "../../src/contracts/evidence.js";
import { displacedValidationsV1Schema, parseGateContext, validateGateDecision, validationOverrideRequestV1Schema, validationOverrideSubjectDigest } from "../../src/contracts/gates.js";
import { parseToolCall } from "../../src/contracts/mcp-tools.js";
import { parsePhaseInstanceId } from "../../src/contracts/phase-instance.js";
import { parseArchFlowApplyInputV1, publicValidationOverrideAuditV1Schema } from "../../src/contracts/semantic-workflow.js";

const D = (character: string) => parseSha256Digest(character.repeat(64));
const task = parseTaskSlug("validation-contract");
const phase = parsePhaseInstanceId("phase-impl-2");
const validations = ["npm run test:contracts", "npm run typecheck"].sort((left, right) => left.localeCompare(right));
const offer = `af1_${"a".repeat(64)}`;

const failedWorkResult = (skill: "archflow-phase-impl" | "archflow-phase-design" = "archflow-phase-impl") => ({
  schema_version: "1",
  task_id: task,
  invocation: { skill, phase: 2, intent: skill === "archflow-phase-impl" ? "resume" : "reopen" },
  action: {
    offer,
    submission: {
      kind: "work-result",
      outcome: "failed",
      reason: "The sandbox could not execute the required checks.",
      validation_override_request: { displaced_validations: validations },
    },
  },
} as const);

const stateRequest = () => ({
  schema_version: "1",
  task_id: task,
  intent_id: "validation-request-1",
  expected_revision: 6,
  input_fingerprint: D("1"),
  operation: "request_validation_override",
  phase_instance: phase,
  step: "produce",
  status: "failed",
  reason: "The sandbox could not execute the required checks.",
  validation_override_request: { displaced_validations: validations },
} as const);

const validationGate = () => {
  const inputFingerprint = D("1");
  const governingDesign = D("2");
  const subjectDigest = validationOverrideSubjectDigest({
    task_id: task,
    phase_instance: phase,
    input_fingerprint: inputFingerprint,
    governing_phase_design_digest: governingDesign,
    displaced_validations: validations,
  });
  const context = {
    request_revision: 7,
    input_fingerprint: inputFingerprint,
    governing_phase_design_digest: governingDesign,
    displaced_validations: validations,
    producer_reason: "The sandbox could not execute the required checks.",
  } as const;
  const currentEvidence = {
    schema_version: "1",
    evidence_kind: "validation-override-request",
    task_id: task,
    phase_instance: phase,
    input_fingerprint: inputFingerprint,
    governing_phase_design_digest: governingDesign,
    request_revision: 7,
    validation_request_subject_digest: subjectDigest,
  } as const;
  return {
    schema_version: "1",
    task_id: task,
    intent_id: "validation-gate-1",
    expected_revision: 7,
    input_fingerprint: inputFingerprint,
    phase_instance: phase,
    summary: "Decide whether the exact validations may remain not run.",
    subject_digest: subjectDigest,
    current_evidence: currentEvidence,
    kind: "validation-override",
    context,
  } as const;
};

const stateFixture = (): Record<string, unknown> => JSON.parse(readFileSync(
  new URL("../fixtures/contracts/durable/task-state.valid.json", import.meta.url),
  "utf8",
)) as Record<string, unknown>;

const automationAuthority = {
  kind: "readable" as const,
  repository_identity_digest: D("3"),
  state_document_digest: D("4"),
  live_config_digest: D("5"),
  semantic_snapshot_digest: D("6"),
};

const automationV1 = (): AutomationStatusWithoutIdV1 => ({
  schema_version: "1",
  task_id: task,
  state_revision: parseSafeInteger(7),
  position: { kind: "phase-impl", phase: 2 },
  condition: "awaiting-client",
  next_action: {
    actor: "skill",
    kind: "continue-skill",
    skill: "archflow-phase-impl",
    task_id: task,
    skill_args: ["2"],
    instruction: "Continue the failed implementation boundary.",
  },
});

describe("validation override contracts", () => {
  it("accepts a bounded locale-sorted request only on a failed phase implementation result", () => {
    expect(validationOverrideRequestV1Schema.parse({ displaced_validations: validations })).toEqual({ displaced_validations: validations });
    expect(parseArchFlowApplyInputV1(failedWorkResult())).toEqual(failedWorkResult());
    expect(() => parseArchFlowApplyInputV1(failedWorkResult("archflow-phase-design"))).toThrow(/phase implementation/u);
    expect(() => parseArchFlowApplyInputV1({
      ...failedWorkResult(),
      action: { ...failedWorkResult().action, submission: { ...failedWorkResult().action.submission, outcome: "succeeded" } },
    })).toThrow();

    for (const displaced_validations of [
      [],
      Array.from({ length: 33 }, (_, index) => `check-${String(index).padStart(2, "0")}`),
      ["x".repeat(1025)],
      ["   "],
      ["same", "same"],
      [...validations].reverse(),
    ]) {
      expect(validationOverrideRequestV1Schema.safeParse({ displaced_validations }).success).toBe(false);
      expect(displacedValidationsV1Schema.safeParse(displaced_validations).success).toBe(false);
    }
  });

  it("keeps the low-level operation phase-bound and hashes its exact fields under a distinct discriminator", () => {
    const parsed = parseToolCall("archflow_state", stateRequest());
    expect(parsed.input.operation).toBe("request_validation_override");
    for (const invalid of [
      { ...stateRequest(), phase_instance: "phase-design-2" },
      { ...stateRequest(), status: "succeeded" },
      { ...stateRequest(), step: "triage" },
      { ...stateRequest(), reason: undefined },
      { ...stateRequest(), artifact: {} },
    ]) expect(() => parseToolCall("archflow_state", invalid)).toThrow();

    const subject: RequestDigestSubject = {
      schema_version: "1",
      tool: "archflow_state",
      repository_identity_digest: D("7"),
      task_identity_digest: D("8"),
      input_fingerprint: D("1"),
      operation: "request-validation-override",
      operation_fields: {
        phase_instance: phase,
        step: "produce",
        status: "failed",
        reason: stateRequest().reason,
        validation_override_request: stateRequest().validation_override_request,
      },
    };
    const digest = computeRequestDigest(subject);
    expect(computeRequestDigest({ ...subject, operation_fields: { ...subject.operation_fields, reason: "A different reason." } })).not.toBe(digest);
    expect(() => computeRequestDigest({
      ...subject,
      operation_fields: { ...subject.operation_fields, extra: true },
    } as unknown as RequestDigestSubject)).toThrow(/exactly/u);
  });

  it("strictly binds gate evidence, context, subject, and decisions", () => {
    const gate = validationGate();
    expect(parseToolCall("archflow_gate", gate).input.kind).toBe("validation-override");
    const context = parseGateContext("validation-override", gate.context);
    expect(validateGateDecision("validation-override", context, { decision: "grant-validation-override", reason: "Accept the explicit gap." })).toBeTruthy();
    expect(validateGateDecision("validation-override", context, { decision: "deny-validation-override", reason: "Run the checks instead." })).toBeTruthy();
    expect(() => validateGateDecision("validation-override", context, { decision: "approve", reason: "Too broad." } as never)).toThrow();
    expect(() => validateGateDecision("validation-override", context, { decision: "grant-validation-override", reason: "Accept.", extra: true } as never)).toThrow();
    expect(() => parseToolCall("archflow_gate", { ...gate, phase_instance: "design" })).toThrow(/phase implementation/u);
    expect(() => parseToolCall("archflow_gate", {
      ...gate,
      current_evidence: { ...gate.current_evidence, request_revision: 8 },
    })).toThrow(/exactly bind/u);
    expect(() => parseToolCall("archflow_gate", { ...gate, subject_digest: D("9") })).toThrow(/exactly bind/u);
    expect(() => parseGateContext("validation-override", { ...gate.context, unknown: true })).toThrow();
  });

  it("keeps legacy state readable and permits validation history without an approval or waiver", () => {
    const legacy = stateFixture();
    expect(taskStateV1Schema.safeParse(legacy).success).toBe(true);
    expect(legacy).not.toHaveProperty("validation_overrides");
    expect(legacy).not.toHaveProperty("review_push_throughs");

    const record = {
      gate_id: "gate-validation-1",
      decision_digest: "a".repeat(64),
      phase_instance: "phase-impl-1",
      input_fingerprint: "b".repeat(64),
      governing_phase_design_digest: "c".repeat(64),
      subject_digest: "d".repeat(64),
      displaced_validations: ["Check A", "check b"],
      human_reason: "The named checks are unavailable in this environment.",
      decided_at: "2026-09-02T12:00:00.000Z",
      granted_at_revision: 7,
    } as const;
    expect(validationOverrideRecordV1Schema.parse(record)).toEqual(record);
    const withHistory: Record<string, unknown> = { ...legacy, validation_overrides: [record], review_push_throughs: [] };
    expect(taskStateV1Schema.safeParse(withHistory).success).toBe(true);
    expect((withHistory.approvals as readonly { gate_id: string }[]).some((approval) => approval.gate_id === record.gate_id)).toBe(false);
    expect((withHistory.waivers as readonly { gate_id: string }[]).some((waiver) => waiver.gate_id === record.gate_id)).toBe(false);

    const later = { ...record, gate_id: "gate-validation-2", decision_digest: "e".repeat(64) };
    expect(taskStateV1Schema.safeParse({ ...legacy, validation_overrides: [later, record] }).success).toBe(false);
    expect(taskStateV1Schema.safeParse({ ...legacy, validation_overrides: [record, { ...later, gate_id: record.gate_id, phase_instance: "phase-impl-2" }] }).success).toBe(false);
  });

  it("publishes authenticated and safe damaged-archive audit arms, only in automation v2", () => {
    const authenticated = {
      phase_instance: phase,
      gate_id: "gate-validation-1",
      status: "granted",
      current: true,
      reason: "The exact validations cannot run in this sandbox.",
      decided_at: "2026-09-02T12:00:00.000Z",
      input_fingerprint: D("1"),
      governing_phase_design_digest: D("2"),
      displaced_validations: ["Check A", "check b"],
    } as const;
    expect(publicValidationOverrideAuditV1Schema.parse(authenticated)).toEqual(authenticated);
    for (const status of ["invalid", "unavailable"] as const) {
      const safe = { phase_instance: phase, gate_id: "gate-validation-1", status };
      expect(publicValidationOverrideAuditV1Schema.parse(safe)).toEqual(safe);
      expect(() => publicValidationOverrideAuditV1Schema.parse({ ...safe, reason: "untrusted" })).toThrow();
    }

    const v1 = createAutomationStatus(automationV1(), automationAuthority);
    expect(() => parseAutomationStatus({ ...v1, validation_overrides: [authenticated] })).toThrow();
    const v2Input: AutomationStatusWithoutIdV2 = {
      ...automationV1(),
      schema_version: "2",
      implementation_recommendation: { status: "unavailable", phase: 2, reason: "not-produced", explanation: "No recommendation exists." },
      validation_overrides: [authenticated, { phase_instance: phase, gate_id: "gate-validation-2", status: "unavailable" }],
    };
    const v2 = createAutomationStatusV2(v2Input, automationAuthority);
    expect(parseAutomationStatusV2(v2).validation_overrides).toEqual(v2Input.validation_overrides);
  });
});

import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

import { createAutomationStatus, createAutomationStatusV2, parseAutomationStatus, parseAutomationStatusV2, type AutomationStatusWithoutIdV1, type AutomationStatusWithoutIdV2 } from "../../src/contracts/automation-status.js";
import { parseArchivedGateRequest, parseGateRequest } from "../../src/contracts/durable-gate.js";
import { reviewPushThroughRecordV1Schema, taskStateV1Schema } from "../../src/contracts/durable-state.js";
import { parseSafeInteger, parseSha256Digest, parseTaskSlug } from "../../src/contracts/evidence.js";
import { REVIEW_PUSH_THROUGH_MIN_ATTEMPT, parseGateContext, validateGateDecision } from "../../src/contracts/gates.js";
import { parsePhaseInstanceId } from "../../src/contracts/phase-instance.js";
import { publicReviewPushThroughAuditV1Schema } from "../../src/contracts/semantic-workflow.js";

const D = (character: string) => parseSha256Digest(character.repeat(64));
const task = parseTaskSlug("push-through-contract");
const phase = parsePhaseInstanceId("phase-impl-2");
const evidence = {
  set_digest: D("1"),
  slots: [{
    role: "counter-review",
    evidence_digest: D("2"),
    assurance: "server-attested",
    producer_family: "claude",
    reviewer_family: "codex",
  }],
} as const;
const acceptedOccurrences = [{ review_evidence_digest: D("2"), finding_id: "repeated-defect" }] as const;
const pushThrough = {
  minimum_attempt: REVIEW_PUSH_THROUGH_MIN_ATTEMPT,
  current_evidence_set_digest: evidence.set_digest,
  triage_result_digest: D("3"),
  accepted_occurrences: acceptedOccurrences,
} as const;

const request = (eligible: boolean) => ({
  schema_version: "1",
  gate_id: eligible ? "gate-attempts-push" : "gate-attempts-legacy",
  intent_id: eligible ? "intent-attempts-push" : "intent-attempts-legacy",
  request_digest: D("4"),
  task_id: task,
  phase_instance: phase,
  summary: "The review attempt budget is exhausted.",
  subject_digest: D("5"),
  context_digest: D("6"),
  current_evidence: evidence,
  opened_at_revision: 9,
  kind: "attempts-exhausted",
  context: eligible
    ? { step: "triage", attempts: 3, maximum_attempts: 3, review_push_through: pushThrough }
    : { step: "triage", attempts: 3, maximum_attempts: 3 },
  allowed_decisions: eligible
    ? ["retry-once", "revise", "abort", "push-through-review", "cancel"]
    : ["retry-once", "revise", "abort", "cancel"],
} as const);

const stateFixture = (): Record<string, unknown> => JSON.parse(readFileSync(
  new URL("../fixtures/contracts/durable/task-state.valid.json", import.meta.url),
  "utf8",
)) as Record<string, unknown>;

const pushRecord = (gateId = "gate-push-1") => ({
  gate_id: gateId,
  decision_digest: "7".repeat(64),
  phase_instance: "phase-impl-1",
  subject_digest: "8".repeat(64),
  current_evidence_set_digest: "9".repeat(64),
  triage_result_digest: "a".repeat(64),
  accepted_occurrences: [
    { review_evidence_digest: "b".repeat(64), finding_id: "repeated-defect" },
  ],
  attempt: 3,
  human_reason: "Continue despite this exact repeated finding.",
  decided_at: "2026-09-02T12:00:00.000Z",
  resolved_at_revision: 7,
} as const);

const pushApproval = (record: ReturnType<typeof pushRecord>) => ({
  gate_id: record.gate_id,
  gate_kind: "attempts-exhausted",
  subject_digest: record.subject_digest,
  decision_digest: record.decision_digest,
  resolved_at_revision: record.resolved_at_revision,
} as const);

const automationAuthority = {
  kind: "readable" as const,
  repository_identity_digest: D("c"),
  state_document_digest: D("d"),
  live_config_digest: D("e"),
  semantic_snapshot_digest: D("f"),
};

const automationV1 = (): AutomationStatusWithoutIdV1 => ({
  schema_version: "1",
  task_id: task,
  state_revision: parseSafeInteger(9),
  position: { kind: "phase-impl", phase: 2 },
  condition: "awaiting-client",
  next_action: {
    actor: "skill",
    kind: "continue-skill",
    skill: "archflow-phase-impl",
    task_id: task,
    skill_args: ["2"],
    instruction: "Continue after the human decision.",
  },
});

describe("review push-through contracts", () => {
  it("pins the minimum at two and refuses push-through without its authenticated context", () => {
    expect(REVIEW_PUSH_THROUGH_MIN_ATTEMPT).toBe(2);
    const ineligible = parseGateContext("attempts-exhausted", request(false).context);
    expect(() => validateGateDecision("attempts-exhausted", ineligible, {
      decision: "push-through-review",
      reason: "Continue.",
    })).toThrow(/requires authenticated review push-through context/u);

    const eligible = parseGateContext("attempts-exhausted", request(true).context);
    expect(validateGateDecision("attempts-exhausted", eligible, {
      decision: "push-through-review",
      reason: "Continue despite the exact accepted occurrences.",
    })).toBeTruthy();
    for (const minimum_attempt of [1, 3]) {
      expect(() => parseGateContext("attempts-exhausted", {
        ...request(true).context,
        review_push_through: { ...pushThrough, minimum_attempt },
      })).toThrow();
    }
  });

  it("keeps old requests readable and makes eligible and ineligible decision tuples disjoint", () => {
    const old = request(false);
    expect(parseArchivedGateRequest(old)).toEqual(old);
    expect(parseGateRequest(old)).toEqual(old);
    expect(parseGateRequest(request(true))).toEqual(request(true));
    expect(() => parseGateRequest({
      ...old,
      allowed_decisions: ["retry-once", "revise", "abort", "push-through-review", "cancel"],
    })).toThrow();
    expect(() => parseGateRequest({
      ...request(true),
      allowed_decisions: ["retry-once", "revise", "abort", "cancel"],
    })).toThrow();
    expect(() => parseGateRequest({
      ...request(true),
      current_evidence: { ...evidence, set_digest: D("0") },
    })).toThrow(/bind the gate current evidence set/u);
  });

  it("requires every durable push-through record to pair exactly with its ordinary approval", () => {
    const record = pushRecord();
    expect(reviewPushThroughRecordV1Schema.parse(record)).toEqual(record);
    const base = stateFixture();
    const approvals = [...base.approvals as readonly Record<string, unknown>[], pushApproval(record)];
    expect(taskStateV1Schema.safeParse({ ...base, approvals, review_push_throughs: [record] }).success).toBe(true);
    expect(taskStateV1Schema.safeParse({ ...base, review_push_throughs: [record] }).success).toBe(false);
    expect(taskStateV1Schema.safeParse({ ...base, approvals }).success).toBe(false);
    expect(taskStateV1Schema.safeParse({
      ...base,
      approvals,
      review_push_throughs: [{ ...record, decision_digest: "0".repeat(64) }],
    }).success).toBe(false);

    const later = { ...pushRecord("gate-push-2"), decision_digest: "c".repeat(64) };
    const paired = [pushApproval(record), pushApproval(later)];
    expect(taskStateV1Schema.safeParse({
      ...base,
      approvals: [...base.approvals as readonly Record<string, unknown>[], ...paired],
      review_push_throughs: [later, record],
    }).success).toBe(false);
  });

  it("publishes current, historical, invalid, and unavailable audit arms only in automation v2", () => {
    const current = {
      phase_instance: phase,
      gate_id: "gate-push-1",
      attempt: 3,
      status: "current",
      reason: "Continue despite these exact repeated findings.",
      decided_at: "2026-09-02T12:00:00.000Z",
      accepted_occurrences: acceptedOccurrences,
    } as const;
    const historical = { ...current, gate_id: "gate-push-2", status: "historical" } as const;
    expect(publicReviewPushThroughAuditV1Schema.parse(current)).toEqual(current);
    expect(publicReviewPushThroughAuditV1Schema.parse(historical)).toEqual(historical);
    for (const status of ["invalid", "unavailable"] as const) {
      const safe = { phase_instance: phase, gate_id: "gate-push-3", attempt: 3, status };
      expect(publicReviewPushThroughAuditV1Schema.parse(safe)).toEqual(safe);
      expect(() => publicReviewPushThroughAuditV1Schema.parse({ ...safe, reason: "untrusted" })).toThrow();
    }

    const v1 = createAutomationStatus(automationV1(), automationAuthority);
    expect(() => parseAutomationStatus({ ...v1, review_push_throughs: [current] })).toThrow();
    const v2Input: AutomationStatusWithoutIdV2 = {
      ...automationV1(),
      schema_version: "2",
      implementation_recommendation: { status: "unavailable", phase: 2, reason: "not-produced", explanation: "No recommendation exists." },
      review_push_throughs: [current, historical, { phase_instance: phase, gate_id: "gate-push-3", attempt: 3, status: "invalid" }],
    };
    const v2 = createAutomationStatusV2(v2Input, automationAuthority);
    expect(parseAutomationStatusV2(v2).review_push_throughs).toEqual(v2Input.review_push_throughs);
  });
});

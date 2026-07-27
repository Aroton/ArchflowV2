import { describe, expect, it } from "vitest";
import { parseSha256Digest } from "../../src/contracts/evidence.js";
import { bindParsedToolCallRequest, correlateProjectResult, createInternalResultExpectation, parseToolCall, TOOL_DEFINITIONS, validateProjectResultStructure } from "../../src/contracts/mcp-tools.js";
import { parseTaskPathClaim } from "../../src/contracts/path-claims.js";

const digest = parseSha256Digest("a".repeat(64));
const stateInput = { schema_version: "1", task_id: "task-1", intent_id: "intent-1", expected_revision: 2, input_fingerprint: digest, phase_instance: "phase-impl-2", step: "produce", status: "succeeded" } as const;

describe("correlated MCP tool contracts", () => {
  it("publishes exactly five exact schema fragment pairs", () => {
    expect(Object.keys(TOOL_DEFINITIONS)).toEqual(["archflow_state", "archflow_counter_review", "archflow_adjudicate", "archflow_gate", "archflow_waiver"]);
    for (const [name, definition] of Object.entries(TOOL_DEFINITIONS)) {
      expect(definition.input_schema_id).toBe(`https://archflow.dev/schemas/v1/mcp-tools#/$defs/${name}/input`);
      expect(definition.result_schema_id).toBe(`https://archflow.dev/schemas/v1/mcp-tools#/$defs/${name}/result`);
    }
  });
  it("rejects state artifacts and checks direct request/result equalities", () => {
    expect(() => parseToolCall("archflow_state", { ...stateInput, artifact: null })).toThrow();
    const call = bindParsedToolCallRequest(parseToolCall("archflow_state", stateInput), parseSha256Digest("b".repeat(64)));
    expect(() => validateProjectResultStructure(call, { schema_version: "1", ok: true, value: { path: "phases/2/result.json", revision: 3, status: "failed" } })).toThrow(/status mismatch/);
  });
  it("keeps structural validation distinct from authoritative expectation correlation", () => {
    const call = bindParsedToolCallRequest(parseToolCall("archflow_state", stateInput), parseSha256Digest("b".repeat(64)));
    const value = { path: parseTaskPathClaim("phases/2/result.json"), revision: 3, status: "succeeded" } as const;
    const structural = validateProjectResultStructure(call, { schema_version: "1", ok: true, value });
    const expectation = createInternalResultExpectation({ schema_version: "1", tool: "archflow_state", task_id: "task-1", intent_id: "intent-1", input_fingerprint: digest, request_digest: parseSha256Digest("b".repeat(64)), result_id: "result-1", resulting_revision: 3, success: value });
    expect(correlateProjectResult(call, expectation, structural)).toEqual(expect.objectContaining({ ok: true, value }));
    const wrong = createInternalResultExpectation({ ...expectation, result_id: "result-2", resulting_revision: 4, success: { ...value, revision: 4 } });
    expect(() => correlateProjectResult(call, wrong, structural)).toThrow(/expectation mismatch/);
    const otherRequest = bindParsedToolCallRequest(parseToolCall("archflow_state", stateInput), parseSha256Digest("c".repeat(64)));
    expect(() => correlateProjectResult(otherRequest, expectation, validateProjectResultStructure(otherRequest, { schema_version: "1", ok: true, value }))).toThrow(/invocation mismatch/);
    expect(() => correlateProjectResult(call, { ...expectation }, structural)).toThrow(/authentic/);
    expect(() => correlateProjectResult({ ...call }, expectation, structural)).toThrow(/authentic/);
  });

  it("uses the authoritative exact current-evidence tuple parser for gates", () => {
    const self = { role: "self-review", evidence_digest: "1".repeat(64), assurance: "agent-declared", producer_family: "claude", reviewer_family: "claude", independence: "same-family-self" };
    const counter = { role: "counter-review", evidence_digest: "2".repeat(64), assurance: "server-attested", producer_family: "claude", reviewer_family: "codex", independence: "opposite-family" };
    const base = { schema_version: "1", task_id: "Task:1", intent_id: "Intent:1", expected_revision: 0, input_fingerprint: digest, phase_instance: "phase-impl-2", summary: "Review", subject_digest: digest, current_evidence: { set_digest: "3".repeat(64), slots: [self, counter] }, kind: "artifact-approval", context: { artifact_kind: "phase-implementation" } };
    expect(parseToolCall("archflow_gate", base).input.task_id).toBe("Task:1");
    expect(() => parseToolCall("archflow_gate", { ...base, current_evidence: { ...base.current_evidence, slots: [counter, self] } })).toThrow();
    expect(() => parseToolCall("archflow_gate", { ...base, current_evidence: { ...base.current_evidence, slots: [self, { ...counter, evidence_digest: self.evidence_digest }] } })).toThrow();
    expect(() => parseToolCall("archflow_gate", { ...base, current_evidence: { ...base.current_evidence, slots: [self, { ...counter, reviewer_family: "claude" }] } })).toThrow();
  });

  it("enforces waiver origin identity and canonical UTC-millisecond provenance", () => {
    const origin = { origin_gate_id: "Gate:1", origin_decision_digest: "1".repeat(64), origin_context_digest: "2".repeat(64), task_id: "Task_1", phase_instance: "phase-impl-2", subject_digest: "3".repeat(64), current_evidence_set_digest: "4".repeat(64), rule: { rule_id: "Rule:1", rule_version: 1 }, scope: { operation: "review-trigger", boundary: "subject" } };
    const input = { schema_version: "1", task_id: "Task_1", intent_id: "Intent:1", expected_revision: 0, input_fingerprint: digest, origin, rationale: "Needed" };
    expect(() => parseToolCall("archflow_waiver", { ...input, task_id: "Other" })).toThrow(/task_id/);
    const call = parseToolCall("archflow_waiver", input);
    const success = { origin_gate_id: "Gate:1", waiver_gate_id: "Gate:2", task_id: "Task_1", rule_id: "Rule:1", rule_version: 1, subject_digest: "3".repeat(64), current_evidence_set_digest: "4".repeat(64), scope: origin.scope, human_provenance: { schema_version: "1", actor_class: "human", assurance: "declared-local-trace", channel: "archflow-local", decision_event_id: "Decision:1", helper_invocation_id: "Helper:1", recorded_at: "2026-07-27T12:00:00.000Z" }, granted: false, notes: "Denied", revision: 1 };
    expect(validateProjectResultStructure(call, { schema_version: "1", ok: true, value: success }).ok).toBe(true);
    expect(() => validateProjectResultStructure(call, { schema_version: "1", ok: true, value: { ...success, human_provenance: { ...success.human_provenance, recorded_at: "2026-07-27T12:00:00Z" } } })).toThrow();
  });
});

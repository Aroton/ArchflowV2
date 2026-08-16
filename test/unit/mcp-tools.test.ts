import { readFileSync } from "node:fs";
import { describe, expect, expectTypeOf, it } from "vitest";
import * as publicContracts from "../../src/contracts/index.js";
import { createProjectError } from "../../src/contracts/errors.js";
import { parsePathSafeId, parseSha256Digest, parseTaskSlug } from "../../src/contracts/evidence.js";
import { bindParsedToolCallRequest, correlateProjectResult, createInternalResultExpectation, parseToolCall, TOOL_DEFINITIONS, validateProjectFailureStructure, validateProjectResultStructure, type CommonToolInput, type CounterReviewInput, type GateInput, type ResultIdentityPayload, type StateInput, type WaiverDecisionBinding, type WaiverInput } from "../../src/contracts/mcp-tools.js";
import type { GateDecisionEnvelopeBase } from "../../src/contracts/gates.js";
import type { PathSafeId, TaskSlug } from "../../src/contracts/evidence.js";
import { parseTaskPathClaim } from "../../src/contracts/path-claims.js";
import { TOOL_NAMES } from "../../src/contracts/tool-names.js";

const digest = parseSha256Digest("a".repeat(64));
const stateInput = { schema_version: "1", task_id: "task-1", intent_id: "intent-1", expected_revision: 2, input_fingerprint: digest, phase_instance: "phase-impl-2", step: "produce", status: "succeeded" } as const;
const taskInitialization = JSON.parse(readFileSync(
  new URL("../fixtures/contracts/durable/task-initialization.valid.json", import.meta.url),
  "utf8",
)) as Record<string, unknown>;

describe("correlated MCP tool contracts", () => {
  it("publishes exactly four exact schema fragment pairs", () => {
    expect(Object.keys(TOOL_DEFINITIONS)).toEqual(["archflow_state", "archflow_counter_review", "archflow_gate", "archflow_waiver"]);
    for (const [name, definition] of Object.entries(TOOL_DEFINITIONS)) {
      expect(definition.input_schema_id).toBe(`https://archflow.dev/schemas/v1/mcp-tools#/$defs/${name}/input`);
      expect(definition.result_schema_id).toBe(`https://archflow.dev/schemas/v1/mcp-tools#/$defs/${name}/result`);
    }
  });
  it("detaches and recursively freezes every nested parsed-call semantic", () => {
    const counterSource = { schema_version: "1", task_id: "task-1", intent_id: "intent-1", expected_revision: 0, input_fingerprint: digest, artifact_path: "phases/2/result.md" };
    const counter = parseToolCall("archflow_counter_review", counterSource);
    expect(Object.isFrozen(counter.input)).toBe(true);

    const originSource = { origin_gate_id: "gate-1", origin_decision_digest: "1".repeat(64), origin_context_digest: "2".repeat(64), task_id: "task-1", phase_instance: "phase-impl-2", subject_digest: "3".repeat(64), current_evidence_set_digest: "4".repeat(64), rule: { rule_id: "Rule:1", rule_version: 1 }, scope: { operation: "review-trigger", boundary: "subject" } };
    const waiver = parseToolCall("archflow_waiver", { schema_version: "1", task_id: "task-1", intent_id: "intent-3", expected_revision: 0, input_fingerprint: digest, origin: originSource, rationale: "Needed" });
    originSource.rule.rule_version = 2;
    expect(waiver.input.origin.rule.rule_version).toBe(1);
    expect(Object.isFrozen(waiver.input.origin.rule)).toBe(true);
    expect(Object.isFrozen(waiver.input.origin.scope)).toBe(true);

    const counterSlot = { role: "counter-review", evidence_digest: "6".repeat(64), assurance: "server-attested", producer_family: "claude", reviewer_family: "codex", independence: "opposite-family" };
    const gate = parseToolCall("archflow_gate", { schema_version: "1", task_id: "task-1", intent_id: "intent-4", expected_revision: 0, input_fingerprint: digest, phase_instance: "phase-impl-2", summary: "Review", subject_digest: "7".repeat(64), current_evidence: { set_digest: "8".repeat(64), slots: [counterSlot] }, kind: "artifact-approval", context: { artifact_kind: "phase-implementation" } });
    expect(Object.isFrozen(gate.input.current_evidence.slots)).toBe(true);
    expect(Object.isFrozen(gate.input.current_evidence.slots[0])).toBe(true);
    expect(Object.isFrozen(gate.input.context)).toBe(true);
  });
  it("accepts and freezes closed durable state artifacts while rejecting values outside the union", () => {
    const source = structuredClone(taskInitialization);
    const call = parseToolCall("archflow_state", { ...stateInput, artifact: source });
    source.task_id = "mutated";
    expect(call.input.artifact?.artifact_kind).toBe("task-initialization");
    if (call.input.artifact?.artifact_kind !== "task-initialization") throw new TypeError("expected initialization fixture");
    expect(call.input.artifact.task_id).toBe(taskInitialization.task_id);
    expect(Object.isFrozen(call.input.artifact)).toBe(true);
    const reviewEvidence = {
      schema_version: "1", task_id: "task-1", phase_instance: "phase-impl-2",
      step: "counter_review", role: "counter-review", subject_digest: digest,
      input_fingerprint: digest, rubric_digest: digest, producer_family: "claude",
      findings: [], matched_rule_versions: [], verdict: "pass", blocking_count: 0,
      model_family: "codex", model: "manual", effort: "unknown", assurance: "degraded", reason: "manual fallback",
    } as const;
    // Review evidence is no longer a durable state artifact: the union rejects it outright.
    expect(() => parseToolCall("archflow_state", {
      ...stateInput, step: "counter_review",
      artifact: { schema_version: "1", artifact_kind: "review-evidence", evidence: reviewEvidence },
    })).toThrow();
    const triage = parseToolCall("archflow_state", {
      ...stateInput, step: "triage",
      artifact: {
        schema_version: "1", artifact_kind: "triage",
        evidence: {
          schema_version: "1", task_id: "task-1", phase_instance: "phase-impl-2",
          step: "triage", subject_digest: digest, input_fingerprint: digest,
          current_evidence_set_digest: digest, source_evidence_digests: [],
          dispositions: [], accepted_count: 0, rejected_count: 0,
        },
      },
    });
    expect(triage.input.artifact?.artifact_kind).toBe("triage");
    expect(() => parseToolCall("archflow_state", { ...stateInput, artifact: null })).toThrow();
    expect(() => parseToolCall("archflow_state", { ...stateInput, artifact: { ...taskInitialization, artifact_kind: "unknown" } })).toThrow();
  });
  it("accepts a bounded human-revision classification only on a succeeded produce result", () => {
    const simple = parseToolCall("archflow_state", {
      ...stateInput,
      human_revision: { classification: "simple", rationale: "Only explanatory wording changed." },
    });
    expect(simple.input.human_revision).toEqual({
      classification: "simple",
      rationale: "Only explanatory wording changed.",
    });
    const overridden = parseToolCall("archflow_state", {
      ...stateInput,
      human_revision: {
        classification: "significant",
        rationale: "The behavior and verification changed.",
        user_override: { agent_classification: "simple", rationale: "I want a full fresh review." },
      },
    });
    expect(overridden.input.human_revision?.user_override?.agent_classification).toBe("simple");
    const overriddenSimple = parseToolCall("archflow_state", {
      ...stateInput,
      human_revision: {
        classification: "simple",
        rationale: "The user confirmed the change is wording-only.",
        user_override: { agent_classification: "significant", rationale: "Preserve the current review." },
      },
    });
    expect(overriddenSimple.input.human_revision?.user_override?.agent_classification).toBe("significant");
    expect(() => parseToolCall("archflow_state", {
      ...stateInput,
      status: "running",
      human_revision: { classification: "simple", rationale: "Too early." },
    })).toThrow();
    expect(() => parseToolCall("archflow_state", {
      ...stateInput,
      human_revision: {
        classification: "simple",
        rationale: "No actual override.",
        user_override: { agent_classification: "simple", rationale: "Same value." },
      },
    })).toThrow();
  });
  it("accepts only the bounded additive planning_restart arm", () => {
    const restart = {
      ...stateInput,
      intent_id: "restart-1",
      expected_revision: 12,
      phase_instance: "phase-impl-2",
      step: "produce",
      status: "running",
      operation: "planning_restart",
      target_phase_instance: "prd",
      reason: "Reconsider the API boundary.",
      ask_base_digest: "b".repeat(64),
    } as const;
    const parsed = parseToolCall("archflow_state", restart);
    expect(parsed.input.operation).toBe("planning_restart");
    expect(parsed.input.target_phase_instance).toBe("prd");
    expect(() => parseToolCall("archflow_state", { ...restart, ask_base_digest: undefined })).toThrow();
    expect(() => parseToolCall("archflow_state", { ...restart, target_phase_instance: "design", ask_base_digest: "b".repeat(64) })).toThrow();
    expect(() => parseToolCall("archflow_state", { ...restart, step: "triage" })).toThrow();
    expect(() => parseToolCall("archflow_state", { ...stateInput, target_phase_instance: "prd", reason: "forged" })).toThrow();
  });
  it("checks direct state request/result equalities", () => {
    const call = bindParsedToolCallRequest(parseToolCall("archflow_state", stateInput), parseSha256Digest("b".repeat(64)));
    expect(() => validateProjectResultStructure(call, { schema_version: "1", ok: true, value: { path: "phases/2/result.json", revision: 3, status: "failed" } })).toThrow(/status mismatch/);
  });
  it("keeps structural validation distinct from authoritative expectation correlation", () => {
    const call = bindParsedToolCallRequest(parseToolCall("archflow_state", stateInput), parseSha256Digest("b".repeat(64)));
    const value = { path: parseTaskPathClaim("phases/2/result.json"), revision: 3, status: "succeeded" } as const;
    const structural = validateProjectResultStructure(call, { schema_version: "1", ok: true, value });
    const expectation = createInternalResultExpectation({ schema_version: "1", tool: "archflow_state", task_id: parseTaskSlug("task-1"), intent_id: parsePathSafeId("intent-1"), input_fingerprint: digest, request_digest: parseSha256Digest("b".repeat(64)), result_id: "result-1", resulting_revision: 3, success: value });
    expect(correlateProjectResult(call, expectation, structural)).toEqual(expect.objectContaining({ ok: true, value }));
    const wrong = createInternalResultExpectation({ ...expectation, result_id: "result-2", resulting_revision: 4, success: { ...value, revision: 4 } });
    expect(() => correlateProjectResult(call, wrong, structural)).toThrow(/expectation mismatch/);
    const otherRequest = bindParsedToolCallRequest(parseToolCall("archflow_state", stateInput), parseSha256Digest("c".repeat(64)));
    expect(() => correlateProjectResult(otherRequest, expectation, validateProjectResultStructure(otherRequest, { schema_version: "1", ok: true, value }))).toThrow(/invocation mismatch/);
    expect(() => correlateProjectResult(call, { ...expectation }, structural)).toThrow(/authentic/);
    expect(() => correlateProjectResult({ ...call }, expectation, structural)).toThrow(/authentic/);
  });

  it("authenticates only copied, closed failure results for known tools", () => {
    const source = {
      schema_version: "1",
      ok: false,
      error: createProjectError("CONTRACT_INVALID", { issue_code: "input-invalid" }),
    } as const;
    for (const name of TOOL_NAMES) {
      const result = validateProjectFailureStructure(name, source);
      expect(result).not.toBe(source);
      expect(result).toMatchObject(source);
      if (result.ok) throw new Error("failure validator minted a success");
      expect(result.error).not.toBe(source.error);
      expect(result.error.diagnostic.parameters).not.toBe(source.error.diagnostic.parameters);
      expect(Object.isFrozen(result)).toBe(true);
      expect(Object.isFrozen(result.error)).toBe(true);
      expect(Object.isFrozen(result.error.diagnostic)).toBe(true);
      expect(Object.isFrozen(result.error.diagnostic.parameters)).toBe(true);
    }
    expect(() => validateProjectFailureStructure("archflow_state", { schema_version: "1", ok: true, value: {} })).toThrow();
    expect(() => validateProjectFailureStructure("archflow_state", { ...source, extra: true })).toThrow();
    expect(() => validateProjectFailureStructure("not-a-tool" as never, source)).toThrow(/unknown tool/);
    expect(() => validateProjectFailureStructure("archflow_state", new Map())).toThrow();
    expect(publicContracts.validateProjectFailureStructure).toBe(validateProjectFailureStructure);
  });

  it("correlates optional and required diagnostic tool bindings in both structural validators", () => {
    const call = parseToolCall("archflow_state", stateInput);
    const neutralContractFailure = {
      schema_version: "1",
      ok: false,
      error: createProjectError("CONTRACT_INVALID", { issue_code: "input-invalid" })
    } as const;
    const matchingContractFailure = {
      schema_version: "1",
      ok: false,
      error: createProjectError("CONTRACT_INVALID", { tool: "archflow_state", issue_code: "input-invalid" })
    } as const;
    const crossToolContractFailure = {
      schema_version: "1",
      ok: false,
      error: createProjectError("CONTRACT_INVALID", { tool: "archflow_gate", issue_code: "input-invalid" })
    } as const;
    const matchingResultFailure = {
      schema_version: "1",
      ok: false,
      error: createProjectError("RESULT_INVALID", { tool: "archflow_state", result_id: "result-1" })
    } as const;
    const crossToolResultFailure = {
      schema_version: "1",
      ok: false,
      error: createProjectError("RESULT_INVALID", { tool: "archflow_gate", result_id: "result-1" })
    } as const;

    for (const candidate of [neutralContractFailure, matchingContractFailure, matchingResultFailure]) {
      expect(validateProjectFailureStructure("archflow_state", candidate).ok).toBe(false);
      expect(validateProjectResultStructure(call, candidate).ok).toBe(false);
    }
    for (const candidate of [crossToolContractFailure, crossToolResultFailure]) {
      expect(() => validateProjectFailureStructure("archflow_state", candidate)).toThrow(/tool mismatch/);
      expect(() => validateProjectResultStructure(call, candidate)).toThrow(/tool mismatch/);
    }
    const toolNeutralResultFailure = {
      schema_version: "1",
      ok: false,
      error: { ...matchingResultFailure.error, diagnostic: { ...matchingResultFailure.error.diagnostic, parameters: { result_id: "result-1" } } }
    } as const;
    expect(() => validateProjectFailureStructure("archflow_state", toolNeutralResultFailure)).toThrow();
    expect(() => validateProjectResultStructure(call, toolNeutralResultFailure)).toThrow();
  });

  it("registers failure authenticity without allowing spread clones or tool substitution", () => {
    const call = bindParsedToolCallRequest(parseToolCall("archflow_state", stateInput), parseSha256Digest("b".repeat(64)));
    const success = { path: parseTaskPathClaim("phases/2/result.json"), revision: 3, status: "succeeded" } as const;
    const expectation = createInternalResultExpectation({ schema_version: "1", tool: "archflow_state", task_id: parseTaskSlug("task-1"), intent_id: parsePathSafeId("intent-1"), input_fingerprint: digest, request_digest: parseSha256Digest("b".repeat(64)), result_id: "result-1", resulting_revision: 3, success });
    const source = { schema_version: "1", ok: false, error: createProjectError("INTERNAL_ERROR", { correlation_id: "correlation-1" }) } as const;
    const failure = validateProjectFailureStructure("archflow_state", source);
    expect(correlateProjectResult(call, expectation, failure)).toBe(failure);
    expect(() => correlateProjectResult(call, expectation, { ...failure } as never)).toThrow(/authentic/);
    const substituted = validateProjectFailureStructure("archflow_counter_review", source);
    expect(() => correlateProjectResult(call, expectation, substituted as never)).toThrow(/tool mismatch/);
  });

  it("uses the authoritative exact current-evidence tuple parser for gates", () => {
    const counter = { role: "counter-review", evidence_digest: "2".repeat(64), assurance: "server-attested", producer_family: "claude", reviewer_family: "codex", independence: "opposite-family" };
    const gateCounter = { role: "gate-counter-review", evidence_digest: "1".repeat(64), assurance: "server-attested", producer_family: "claude", reviewer_family: "codex", independence: "opposite-family", gate_id: "gate-1" };
    const base = { schema_version: "1", task_id: "task-1", intent_id: "intent-1", expected_revision: 0, input_fingerprint: digest, phase_instance: "phase-impl-2", summary: "Review", subject_digest: digest, current_evidence: { set_digest: "3".repeat(64), slots: [counter] }, kind: "artifact-approval", context: { artifact_kind: "phase-implementation" } };
    expect(parseToolCall("archflow_gate", base).input.task_id).toBe("task-1");
    expect(() => parseToolCall("archflow_gate", { ...base, current_evidence: { ...base.current_evidence, slots: [counter, gateCounter] } })).toThrow();
    expect(() => parseToolCall("archflow_gate", { ...base, current_evidence: { ...base.current_evidence, slots: [gateCounter] } })).toThrow();
  });

  it("revalidates gate success decisions against the authentic call context", () => {
    const ruleA = { rule_id: "Rule:A", rule_version: 1 } as const;
    const ruleB = { rule_id: "Rule:B", rule_version: 1 } as const;
    const counter = { role: "counter-review", evidence_digest: "2".repeat(64), assurance: "server-attested", producer_family: "claude", reviewer_family: "codex", independence: "opposite-family" } as const;
    const commonInput = {
      schema_version: "1",
      task_id: "task-1",
      intent_id: "intent-1",
      expected_revision: 0,
      input_fingerprint: digest,
      phase_instance: "phase-impl-2",
      summary: "Review",
      subject_digest: digest,
      current_evidence: { set_digest: "3".repeat(64), slots: [counter] }
    } as const;
    const humanProvenance = {
      schema_version: "1",
      actor_class: "human",
      assurance: "declared-local-trace",
      channel: "archflow-local",
      decision_event_id: "Decision:1",
      helper_invocation_id: "Helper:1",
      recorded_at: "2026-07-27T12:00:00.000Z"
    } as const;
    const envelope = (kind: string, payload: Readonly<Record<string, unknown>>) => ({
      schema_version: "1",
      gate_id: "gate-1",
      task_id: commonInput.task_id,
      phase_instance: commonInput.phase_instance,
      subject_digest: commonInput.subject_digest,
      context_digest: "4".repeat(64),
      human_provenance: humanProvenance,
      kind,
      payload
    });
    const result = (kind: string, payload: Readonly<Record<string, unknown>>) => ({
      schema_version: "1",
      ok: true,
      value: { kind, decision: envelope(kind, payload), notes: payload.reason, revision: 1 }
    });

    const reviewCall = parseToolCall("archflow_gate", {
      ...commonInput,
      kind: "constitution-review",
      context: {
        constitution: "fail",
        failed_rules: [ruleB],
        uncertain_rules: [],
        matched_trigger_rules: [ruleA],
        uncertain_trigger_rules: [],
        eligible_waivers: [
          { rule: ruleA, scope: { operation: "review-trigger", boundary: "subject" } },
          { rule: ruleB, scope: { operation: "adjudication-failure", boundary: "subject" } }
        ]
      }
    });
    expect(validateProjectResultStructure(reviewCall, result("constitution-review", {
      decision: "waiver-requested", reason: "Eligible exception", rule: ruleA, operation: "review-trigger", rationale: "Temporary"
    })).ok).toBe(true);
    expect(validateProjectResultStructure(reviewCall, result("constitution-review", {
      decision: "waiver-requested", reason: "Eligible exception", rule: ruleB, operation: "adjudication-failure", rationale: "Temporary"
    })).ok).toBe(true);
    // Right rule, wrong axis: the gate never offered rule A on the compliance axis.
    expect(() => validateProjectResultStructure(reviewCall, result("constitution-review", {
      decision: "waiver-requested", reason: "Ineligible axis", rule: ruleA, operation: "adjudication-failure", rationale: "Temporary"
    }))).toThrow(/eligible/);

    const authority = {
      link_digest: "5".repeat(64),
      purpose: "restore-adoption",
      proposed_generation_digest: "6".repeat(64),
      changed_input_fingerprint: "7".repeat(64)
    } as const;
    const restoreCall = parseToolCall("archflow_gate", {
      ...commonInput,
      kind: "restore-collision",
      context: {
        path: "task/file.md",
        recorded_generation_digest: "8".repeat(64),
        current_generation_digest: "9".repeat(64),
        adoption_candidate: authority
      }
    });
    expect(validateProjectResultStructure(restoreCall, result("restore-collision", {
      decision: "adopt-as-new-generation", reason: "Adopt", adoption_authority: authority, rationale: "Reviewed"
    })).ok).toBe(true);
    expect(() => validateProjectResultStructure(restoreCall, result("restore-collision", {
      decision: "adopt-as-new-generation",
      reason: "Adopt mismatched",
      adoption_authority: { ...authority, link_digest: "a".repeat(64) },
      rationale: "Reviewed"
    }))).toThrow(/authority/);
  });

  it("enforces waiver origin identity and canonical UTC-millisecond provenance", () => {
    const origin = { origin_gate_id: "gate-1", origin_decision_digest: "1".repeat(64), origin_context_digest: "2".repeat(64), task_id: "task-1", phase_instance: "phase-impl-2", subject_digest: "3".repeat(64), current_evidence_set_digest: "4".repeat(64), rule: { rule_id: "Rule:1", rule_version: 1 }, scope: { operation: "review-trigger", boundary: "subject" } };
    const input = { schema_version: "1", task_id: "task-1", intent_id: "intent-1", expected_revision: 0, input_fingerprint: digest, origin, rationale: "Needed" };
    expect(() => parseToolCall("archflow_waiver", { ...input, task_id: "other" })).toThrow(/task_id/);
    const call = parseToolCall("archflow_waiver", input);
    expect(() => parseToolCall("archflow_waiver", { ...input, obsolete_extra: {} })).toThrow();
    const success = { origin_gate_id: "gate-1", waiver_gate_id: "gate-2", task_id: "task-1", rule_id: "Rule:1", rule_version: 1, subject_digest: "3".repeat(64), current_evidence_set_digest: "4".repeat(64), scope: origin.scope, human_provenance: { schema_version: "1", actor_class: "human", assurance: "declared-local-trace", channel: "archflow-local", decision_event_id: "Decision:1", helper_invocation_id: "Helper:1", recorded_at: "2026-07-27T12:00:00.000Z" }, granted: false, notes: "Denied", revision: 1 };
    expect(validateProjectResultStructure(call, { schema_version: "1", ok: true, value: success }).ok).toBe(true);
    expect(() => validateProjectResultStructure(call, { schema_version: "1", ok: true, value: { ...success, human_provenance: { ...success.human_provenance, recorded_at: "2026-07-27T12:00:00Z" } } })).toThrow();
  });
});

describe("retightened boundary identifiers", () => {
  const rubric = { schema_version: "1", kind: "implementation", mode: "adversarial", criteria: [{ id: "paths", text: "Check paths", blocking: true }] } as const;
  const counterInput = { schema_version: "1", task_id: "task-1", intent_id: "intent-1", expected_revision: 0, input_fingerprint: digest, artifact_path: "phases/2/result.md" } as const;
  const waiverOrigin = { origin_gate_id: "gate-1", origin_decision_digest: "1".repeat(64), origin_context_digest: "2".repeat(64), task_id: "task-1", phase_instance: "phase-impl-2", subject_digest: "3".repeat(64), current_evidence_set_digest: "4".repeat(64), rule: { rule_id: "Rule:1", rule_version: 1 }, scope: { operation: "review-trigger", boundary: "subject" } } as const;
  const waiverInput = { schema_version: "1", task_id: "task-1", intent_id: "intent-1", expected_revision: 0, input_fingerprint: digest, origin: waiverOrigin, rationale: "Needed" } as const;

  // Each value below was accepted before the retightening; `safeId` permits `:`, `_`, and uppercase.
  it.each(["Task_1", "Task:1", "task:1", "TASK-1", "-task", "a".repeat(65)])("rejects the previously legal task_id %s", (taskId) => {
    expect(() => parseToolCall("archflow_counter_review", { ...counterInput, task_id: taskId })).toThrow();
    expect(() => parseToolCall("archflow_waiver", { ...waiverInput, task_id: taskId, origin: { ...waiverOrigin, task_id: taskId } })).toThrow();
  });

  it.each(["Intent:1", "retry:3", "intent:1"])("rejects the previously legal intent_id %s", (intentId) => {
    expect(() => parseToolCall("archflow_counter_review", { ...counterInput, intent_id: intentId })).toThrow();
  });

  it.each(["Gate:1", "gate:1"])("rejects the previously legal gate identifier %s", (gateId) => {
    expect(() => parseToolCall("archflow_waiver", { ...waiverInput, origin: { ...waiverOrigin, origin_gate_id: gateId } })).toThrow();
  });

  it("keeps the unchanged identifiers on the broad safeId grammar", () => {
    // rule_id keeps `:`; it never becomes a path segment.
    expect(parseToolCall("archflow_waiver", waiverInput).input.origin.rule.rule_id).toBe("Rule:1");
    const value = { path: parseTaskPathClaim("phases/2/result.json"), revision: 3, status: "succeeded" } as const;
    expect(createInternalResultExpectation({ schema_version: "1", tool: "archflow_state", task_id: parseTaskSlug("task-1"), intent_id: parsePathSafeId("intent-1"), input_fingerprint: digest, request_digest: parseSha256Digest("b".repeat(64)), result_id: "Result:1", resulting_revision: 3, success: value }).result_id).toBe("Result:1");
  });

  it("does not let a plain string mint a task slug or a path-safe identifier", () => {
    expectTypeOf<CommonToolInput["task_id"]>().toEqualTypeOf<TaskSlug>();
    expectTypeOf<CommonToolInput["intent_id"]>().toEqualTypeOf<PathSafeId>();
    expectTypeOf<StateInput["task_id"]>().toEqualTypeOf<TaskSlug>();
    expectTypeOf<CounterReviewInput["task_id"]>().toEqualTypeOf<TaskSlug>();
    expectTypeOf<GateInput["task_id"]>().toEqualTypeOf<TaskSlug>();
    expectTypeOf<WaiverInput["task_id"]>().toEqualTypeOf<TaskSlug>();
    expectTypeOf<ResultIdentityPayload["task_id"]>().toEqualTypeOf<TaskSlug>();
    expectTypeOf<ResultIdentityPayload["result_id"]>().toEqualTypeOf<string>();

    // @ts-expect-error a plain string is not a validated task slug
    const commonTask: CommonToolInput["task_id"] = "task-1";
    // @ts-expect-error a plain string is not a validated path-safe identifier
    const commonIntent: CommonToolInput["intent_id"] = "intent-1";
    // @ts-expect-error a plain string is not a validated task slug
    const stateTask: StateInput["task_id"] = "task-1";
    // @ts-expect-error a plain string is not a validated task slug
    const counterTask: CounterReviewInput["task_id"] = "task-1";
    // @ts-expect-error a plain string is not a validated task slug
    const gateTask: GateInput["task_id"] = "task-1";
    // @ts-expect-error a plain string is not a validated task slug
    const waiverTask: WaiverInput["task_id"] = "task-1";
    // @ts-expect-error a plain string is not a validated task slug
    const identityTask: ResultIdentityPayload["task_id"] = "task-1";
    // @ts-expect-error a plain string is not a validated path-safe identifier
    const identityIntent: ResultIdentityPayload["intent_id"] = "intent-1";
    // @ts-expect-error a plain string is not a validated path-safe identifier
    const bindingOrigin: WaiverDecisionBinding["origin_gate_id"] = "gate-1";
    // @ts-expect-error a plain string is not a validated path-safe identifier
    const bindingWaiver: WaiverDecisionBinding["waiver_gate_id"] = "gate-2";
    // @ts-expect-error a plain string is not a validated task slug
    const bindingTask: WaiverDecisionBinding["task_id"] = "task-1";
    // @ts-expect-error a plain string is not a validated path-safe identifier
    const envelopeGate: GateDecisionEnvelopeBase["gate_id"] = "gate-1";
    // @ts-expect-error a plain string is not a validated task slug
    const envelopeTask: GateDecisionEnvelopeBase["task_id"] = "task-1";
    // rule_id is deliberately unchanged: it is not a path segment and keeps the broad grammar.
    const ruleId: WaiverDecisionBinding["rule_id"] = "Rule:1";

    expect([commonTask, commonIntent, stateTask, counterTask, gateTask, waiverTask, identityTask, identityIntent, bindingOrigin, bindingWaiver, bindingTask, envelopeGate, envelopeTask, ruleId]).toHaveLength(14);
  });
});

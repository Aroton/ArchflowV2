import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import { parseToolCall, TOOL_DEFINITIONS } from "../../src/contracts/mcp-tools.js";
import { createJsonSchemaValidator } from "../../src/contracts/validators.js";

const load = async (path: string) => JSON.parse(await readFile(new URL(path, import.meta.url), "utf8")) as object;

describe("MCP contract schema agreement", () => {
  it("compiles every exact tool input fragment and agrees on closed state fixtures", async () => {
    const mcp = await load("../../src/contracts/schemas/v1/mcp-tools.schema.json") as { $defs: Record<string, { input: object }> };
    const references = [await load("../../src/contracts/schemas/v1/primitives.schema.json"), await load("../../src/contracts/schemas/v1/project-error.schema.json"), await load("../../src/contracts/schemas/v1/rubric.schema.json"), await load("../../src/contracts/schemas/v1/path-claim.schema.json"), await load("../../src/contracts/schemas/v1/evidence-slots.schema.json"), await load("../../src/contracts/schemas/v1/gate-contract.schema.json"), await load("../../src/contracts/schemas/v1/gate-decision.schema.json")];
    const valid = await load("../fixtures/contracts/mcp-tools/state-valid.json");
    const invalid = await load("../fixtures/contracts/mcp-tools/state-invalid-artifact.json");
    const state = createJsonSchemaValidator(mcp, references);
    expect(state.assert(valid)).toBe(valid);
    expect(() => state.assert(invalid)).toThrow();
    expect(parseToolCall("archflow_state", valid).name).toBe("archflow_state");
    expect(() => parseToolCall("archflow_state", invalid)).toThrow();
    expect(Object.values(TOOL_DEFINITIONS).every((definition) => definition.input_schema_id.startsWith("https://archflow.dev/schemas/v1/mcp-tools#/$defs/"))).toBe(true);
  });

  it("compiles the closed correlated result-expectation union", async () => {
    const mcp = await load("../../src/contracts/schemas/v1/mcp-tools.schema.json");
    const expectation = await load("../../src/contracts/schemas/v1/result-expectation.schema.json");
    const references = [mcp, await load("../../src/contracts/schemas/v1/primitives.schema.json"), await load("../../src/contracts/schemas/v1/project-error.schema.json"), await load("../../src/contracts/schemas/v1/rubric.schema.json"), await load("../../src/contracts/schemas/v1/path-claim.schema.json"), await load("../../src/contracts/schemas/v1/evidence-slots.schema.json"), await load("../../src/contracts/schemas/v1/gate-contract.schema.json"), await load("../../src/contracts/schemas/v1/gate-decision.schema.json")];
    const validator = createJsonSchemaValidator(expectation, references);
    const value = { schema_version: "1", tool: "archflow_state", task_id: "task-1", intent_id: "intent-1", input_fingerprint: "a".repeat(64), request_digest: "b".repeat(64), result_id: "result-1", resulting_revision: 3, success: { path: "phases/2/result.json", revision: 3, status: "succeeded" } };
    expect(validator.assert(value)).toBe(value);
    expect(() => validator.assert({ ...value, receipt_id: "not-in-hash-domain" })).toThrow();
    expect(() => validator.assert({ ...value, tool: "archflow_counter_review" })).toThrow();
    expect(() => validator.assert({ ...value, resulting_revision: 4 })).toThrow();
  });

  it("agrees on exact gate tuples, authoritative contexts, and path bytes", async () => {
    const mcp = await load("../../src/contracts/schemas/v1/mcp-tools.schema.json");
    const references = [await load("../../src/contracts/schemas/v1/primitives.schema.json"), await load("../../src/contracts/schemas/v1/project-error.schema.json"), await load("../../src/contracts/schemas/v1/rubric.schema.json"), await load("../../src/contracts/schemas/v1/path-claim.schema.json"), await load("../../src/contracts/schemas/v1/evidence-slots.schema.json"), await load("../../src/contracts/schemas/v1/gate-contract.schema.json"), await load("../../src/contracts/schemas/v1/gate-decision.schema.json")];
    const validator = createJsonSchemaValidator(mcp, references);
    const self = { role: "self-review", evidence_digest: "1".repeat(64), assurance: "agent-declared", producer_family: "claude", reviewer_family: "claude", independence: "same-family-self" };
    const counter = { role: "counter-review", evidence_digest: "2".repeat(64), assurance: "server-attested", producer_family: "claude", reviewer_family: "codex", independence: "opposite-family" };
    const gate = { schema_version: "1", task_id: "Task:1", intent_id: "Intent:1", expected_revision: 0, input_fingerprint: "a".repeat(64), phase_instance: "phase-impl-2", summary: "Review", subject_digest: "a".repeat(64), current_evidence: { set_digest: "3".repeat(64), slots: [self, counter] }, kind: "artifact-approval", context: { artifact_kind: "phase-implementation" } };
    expect(validator.validate(gate)).toBe(true);
    for (const invalid of [{ ...gate, current_evidence: { ...gate.current_evidence, slots: [counter, self] } }, { ...gate, current_evidence: { ...gate.current_evidence, slots: [self, { ...counter, evidence_digest: self.evidence_digest }] } }, { ...gate, kind: "attempts-exhausted", context: { step: "produce", attempts: 1, maximum_attempts: 2 } }]) {
      expect(validator.validate(invalid)).toBe(false);
      expect(() => parseToolCall("archflow_gate", invalid)).toThrow();
    }
    const rubric = { schema_version: "1", kind: "implementation", mode: "adversarial", criteria: [{ id: "paths", text: "Check paths", blocking: true }] };
    for (const artifact_path of [`${"é".repeat(600)}.md`, `bad\u0080path`]) {
      const input = { schema_version: "1", task_id: "task", intent_id: "intent", expected_revision: 0, input_fingerprint: "a".repeat(64), artifact_path, rubric };
      expect(validator.validate(input)).toBe(false);
      expect(() => parseToolCall("archflow_counter_review", input)).toThrow();
    }
    const common = { schema_version: "1", task_id: "Task:1", intent_id: "Intent:1", expected_revision: 0, input_fingerprint: "a".repeat(64) };
    const waiverOrigin = { origin_gate_id: "Gate:1", origin_decision_digest: "1".repeat(64), origin_context_digest: "2".repeat(64), task_id: "Task:1", phase_instance: "phase-impl-2", subject_digest: "3".repeat(64), current_evidence_set_digest: "4".repeat(64), rule: { rule_id: "Rule:1", rule_version: 1 }, scope: { operation: "review-trigger", boundary: "subject" } };
    const examples = [
      ["archflow_state", { ...common, phase_instance: "phase-impl-2", step: "produce", status: "running" }],
      ["archflow_counter_review", { ...common, artifact_path: "phases/2/result.md", rubric }],
      ["archflow_adjudicate", { ...common, artifact_path: "phases/2/result.md", upstream_paths: ["prd.md", "design.md"] }],
      ["archflow_gate", gate],
      ["archflow_waiver", { ...common, origin: waiverOrigin, rationale: "Needed" }]
    ] as const;
    for (const [name, input] of examples) { expect(validator.validate(input), name).toBe(true); expect(parseToolCall(name, input).name).toBe(name); }
    const wrongWaiver = { ...examples[4][1], task_id: "Other" };
    expect(validator.validate(wrongWaiver)).toBe(false);
    expect(() => parseToolCall("archflow_waiver", wrongWaiver)).toThrow();
  });
});

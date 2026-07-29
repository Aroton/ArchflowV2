import { readFile } from "node:fs/promises";
import { specTypeSchemas } from "@modelcontextprotocol/server";
import { describe, expect, it } from "vitest";
import { parseTransportRequestId } from "../../src/contracts/contexts.js";
import { parseToolCall, TOOL_DEFINITIONS, validateProjectResultStructure } from "../../src/contracts/mcp-tools.js";
import { createJsonSchemaValidator } from "../../src/contracts/validators.js";
import { ADVERTISED_TOOL_CATALOGUE } from "../../src/mcp/tools.js";

const load = async (path: string) => JSON.parse(await readFile(new URL(path, import.meta.url), "utf8")) as object;
const durableReferences = async () => Promise.all([
  "durable-primitives", "task-state", "task-initialization", "legacy-import-initialization",
  "document-artifact", "implementation-output", "manual-checkpoint", "manual-checkpoint-import", "secret-scan-result",
].map((name) => load(`../../src/contracts/schemas/v1/${name}.schema.json`)));

describe("MCP contract schema agreement", () => {
  it("agrees with the public SDK RequestId schema across safe boundaries", () => {
    const admitted = ["", "arbitrary \n string \u0000", -0, -1, Number.MIN_SAFE_INTEGER, Number.MAX_SAFE_INTEGER] as const;
    const rejected: readonly unknown[] = [Number.MIN_SAFE_INTEGER - 1, Number.MAX_SAFE_INTEGER + 1, 0.5, Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY, null, true, {}, []];
    for (const candidate of admitted) {
      const sdkResult = specTypeSchemas.RequestId["~standard"].validate(candidate);
      if (sdkResult.issues !== undefined) throw new Error("SDK RequestId rejected an admitted boundary fixture");
      expect(Object.is(sdkResult.value, candidate)).toBe(true);
      expect(Object.is(parseTransportRequestId(candidate), candidate)).toBe(true);
    }
    for (const candidate of rejected) {
      const sdkResult = specTypeSchemas.RequestId["~standard"].validate(candidate);
      expect(sdkResult.issues).toBeDefined();
      expect(() => parseTransportRequestId(candidate)).toThrow();
    }
  });

  it("compiles every exact tool input fragment and agrees on closed state fixtures", async () => {
    const mcp = await load("../../src/contracts/schemas/v1/mcp-tools.schema.json") as { $defs: Record<string, { input: object }> };
    const references = [await load("../../src/contracts/schemas/v1/primitives.schema.json"), await load("../../src/contracts/schemas/v1/project-error.schema.json"), await load("../../src/contracts/schemas/v1/rubric.schema.json"), await load("../../src/contracts/schemas/v1/path-claim.schema.json"), await load("../../src/contracts/schemas/v1/evidence-slots.schema.json"), await load("../../src/contracts/schemas/v1/gate-contract.schema.json"), await load("../../src/contracts/schemas/v1/gate-decision.schema.json"), ...(await durableReferences())];
    const valid = await load("../fixtures/contracts/mcp-tools/state-valid.json");
    const invalid = await load("../fixtures/contracts/mcp-tools/state-invalid-artifact.json");
    const state = createJsonSchemaValidator(mcp, references);
    expect(state.assert(valid)).toBe(valid);
    expect(() => state.assert(invalid)).toThrow();
    expect(parseToolCall("archflow_state", valid).name).toBe("archflow_state");
    expect(() => parseToolCall("archflow_state", invalid)).toThrow();
    expect(Object.values(TOOL_DEFINITIONS).every((definition) => definition.input_schema_id.startsWith("https://archflow.dev/schemas/v1/mcp-tools#/$defs/"))).toBe(true);
  });

  it("keeps waiver success rule versions within the shared positive safe-integer bounds", async () => {
    const mcp = await load("../../src/contracts/schemas/v1/mcp-tools.schema.json") as { $defs: Record<string, { result?: object }> };
    const references = [await load("../../src/contracts/schemas/v1/primitives.schema.json"), await load("../../src/contracts/schemas/v1/project-error.schema.json"), await load("../../src/contracts/schemas/v1/rubric.schema.json"), await load("../../src/contracts/schemas/v1/path-claim.schema.json"), await load("../../src/contracts/schemas/v1/evidence-slots.schema.json"), await load("../../src/contracts/schemas/v1/gate-contract.schema.json"), await load("../../src/contracts/schemas/v1/gate-decision.schema.json"), ...(await durableReferences())];
    const normative = createJsonSchemaValidator({ $schema: "https://json-schema.org/draft/2020-12/schema", ...mcp.$defs.archflow_waiver!.result, $defs: mcp.$defs }, references);
    const advertisedSchema = ADVERTISED_TOOL_CATALOGUE.find(({ name }) => name === "archflow_waiver")!.outputSchema;
    const advertised = createJsonSchemaValidator(advertisedSchema);
    const digest = (character: string) => character.repeat(64);
    const provenance = { schema_version: "1", actor_class: "human", assurance: "declared-local-trace", channel: "archflow-local", decision_event_id: "Decision:1", helper_invocation_id: "Helper:1", recorded_at: "2026-07-27T12:00:00.000Z" };
    const scope = { operation: "review-trigger", boundary: "subject" } as const;
    const rawCall = (ruleVersion: number) => ({ schema_version: "1", task_id: "task-1", intent_id: "intent-1", expected_revision: 0, input_fingerprint: digest("a"), origin: { origin_gate_id: "gate-1", origin_decision_digest: digest("1"), origin_context_digest: digest("2"), task_id: "task-1", phase_instance: "phase-impl-3", subject_digest: digest("3"), current_evidence_set_digest: digest("4"), rule: { rule_id: "Rule:1", rule_version: ruleVersion }, scope }, rationale: "Needed" });
    const output = (ruleVersion: number) => ({ schema_version: "1", ok: true, value: { origin_gate_id: "gate-1", waiver_gate_id: "gate-2", task_id: "task-1", rule_id: "Rule:1", rule_version: ruleVersion, subject_digest: digest("3"), current_evidence_set_digest: digest("4"), scope, human_provenance: provenance, granted: false, notes: "Denied", revision: 1 } });

    for (const boundary of [1, Number.MAX_SAFE_INTEGER]) {
      const candidate = output(boundary);
      expect(normative.validate(candidate), `normative ${boundary}`).toBe(true);
      expect(advertised.validate(candidate), `advertised ${boundary}`).toBe(true);
      expect(validateProjectResultStructure(parseToolCall("archflow_waiver", rawCall(boundary)), candidate).ok, `runtime ${boundary}`).toBe(true);
    }
    for (const adjacent of [0, Number.MAX_SAFE_INTEGER + 1]) {
      const candidate = output(adjacent);
      expect(normative.validate(candidate), `normative ${adjacent}`).toBe(false);
      expect(advertised.validate(candidate), `advertised ${adjacent}`).toBe(false);
      expect(() => validateProjectResultStructure(parseToolCall("archflow_waiver", rawCall(1)), candidate), `runtime ${adjacent}`).toThrow();
    }
  });

  it("compiles the closed correlated result-expectation union", async () => {
    const mcp = await load("../../src/contracts/schemas/v1/mcp-tools.schema.json");
    const expectation = await load("../../src/contracts/schemas/v1/result-expectation.schema.json");
    const references = [mcp, await load("../../src/contracts/schemas/v1/primitives.schema.json"), await load("../../src/contracts/schemas/v1/project-error.schema.json"), await load("../../src/contracts/schemas/v1/rubric.schema.json"), await load("../../src/contracts/schemas/v1/path-claim.schema.json"), await load("../../src/contracts/schemas/v1/evidence-slots.schema.json"), await load("../../src/contracts/schemas/v1/gate-contract.schema.json"), await load("../../src/contracts/schemas/v1/gate-decision.schema.json"), ...(await durableReferences())];
    const validator = createJsonSchemaValidator(expectation, references);
    const value = { schema_version: "1", tool: "archflow_state", task_id: "task-1", intent_id: "intent-1", input_fingerprint: "a".repeat(64), request_digest: "b".repeat(64), result_id: "result-1", resulting_revision: 3, success: { path: "phases/2/result.json", revision: 3, status: "succeeded" } };
    expect(validator.assert(value)).toBe(value);
    expect(() => validator.assert({ ...value, receipt_id: "not-in-hash-domain" })).toThrow();
    expect(() => validator.assert({ ...value, tool: "archflow_counter_review" })).toThrow();
    expect(() => validator.assert({ ...value, resulting_revision: 4 })).toThrow();
  });

  it("agrees on exact gate tuples, authoritative contexts, and path bytes", async () => {
    const mcp = await load("../../src/contracts/schemas/v1/mcp-tools.schema.json");
    const references = [await load("../../src/contracts/schemas/v1/primitives.schema.json"), await load("../../src/contracts/schemas/v1/project-error.schema.json"), await load("../../src/contracts/schemas/v1/rubric.schema.json"), await load("../../src/contracts/schemas/v1/path-claim.schema.json"), await load("../../src/contracts/schemas/v1/evidence-slots.schema.json"), await load("../../src/contracts/schemas/v1/gate-contract.schema.json"), await load("../../src/contracts/schemas/v1/gate-decision.schema.json"), ...(await durableReferences())];
    const validator = createJsonSchemaValidator(mcp, references);
    const self = { role: "self-review", evidence_digest: "1".repeat(64), assurance: "agent-declared", producer_family: "claude", reviewer_family: "claude", independence: "same-family-self" };
    const counter = { role: "counter-review", evidence_digest: "2".repeat(64), assurance: "server-attested", producer_family: "claude", reviewer_family: "codex", independence: "opposite-family" };
    const gate = { schema_version: "1", task_id: "task-1", intent_id: "intent-1", expected_revision: 0, input_fingerprint: "a".repeat(64), phase_instance: "phase-impl-2", summary: "Review", subject_digest: "a".repeat(64), current_evidence: { set_digest: "3".repeat(64), slots: [self, counter] }, kind: "artifact-approval", context: { artifact_kind: "phase-implementation" } };
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
    const common = { schema_version: "1", task_id: "task-1", intent_id: "intent-1", expected_revision: 0, input_fingerprint: "a".repeat(64) };
    const waiverOrigin = { origin_gate_id: "gate-1", origin_decision_digest: "1".repeat(64), origin_context_digest: "2".repeat(64), task_id: "task-1", phase_instance: "phase-impl-2", subject_digest: "3".repeat(64), current_evidence_set_digest: "4".repeat(64), rule: { rule_id: "Rule:1", rule_version: 1 }, scope: { operation: "review-trigger", boundary: "subject" } };
    const examples = [
      ["archflow_state", { ...common, phase_instance: "phase-impl-2", step: "produce", status: "running" }],
      ["archflow_counter_review", { ...common, artifact_path: "phases/2/result.md", rubric }],
      ["archflow_adjudicate", { ...common, artifact_path: "phases/2/result.md", upstream_paths: ["prd.md", "design.md"] }],
      ["archflow_gate", gate],
      ["archflow_waiver", { ...common, origin: waiverOrigin, rationale: "Needed" }]
    ] as const;
    for (const [name, input] of examples) { expect(validator.validate(input), name).toBe(true); expect(parseToolCall(name, input).name).toBe(name); }
    const wrongWaiver = { ...examples[4][1], task_id: "other" };
    expect(validator.validate(wrongWaiver)).toBe(false);
    expect(() => parseToolCall("archflow_waiver", wrongWaiver)).toThrow();
  });
});

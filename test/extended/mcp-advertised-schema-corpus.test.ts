import { readFile } from "node:fs/promises";
import { Ajv2020 } from "ajv/dist/2020.js";
import * as formatsModule from "ajv-formats";
import type { FormatsPlugin } from "ajv-formats";
import { describe, expect, it } from "vitest";

import { parseToolCall, validateProjectFailureStructure, validateProjectResultStructure } from "../../src/contracts/mcp-tools.js";
import { SEMANTIC_TOOL_NAMES, TOOL_NAMES, type ToolName } from "../../src/contracts/tool-names.js";
import { ADVERTISED_TOOL_CATALOGUE } from "../../src/mcp/tools.js";
import { createJsonSchemaValidator } from "../helpers/json-schema.js";

interface CorpusCase {
  readonly label: string;
  readonly tool: ToolName;
  readonly member: "input" | "output";
  readonly classification: "portable-structure" | "runtime-semantic";
  readonly semantic_category?: string;
  readonly materialization: string;
  readonly call_fixture?: ToolName;
  readonly portable: boolean;
  readonly runtime: boolean;
}

interface MaterializedCase {
  readonly value: unknown;
  readonly call?: unknown;
}

const schemaDocumentPaths = [
  "../../src/contracts/schemas/v1/mcp-tools.schema.json",
  "../../src/contracts/schemas/v1/primitives.schema.json",
  "../../src/contracts/schemas/v1/path-claim.schema.json",
  "../../src/contracts/schemas/v1/evidence-slots.schema.json",
  "../../src/contracts/schemas/v1/rubric.schema.json",
  "../../src/contracts/schemas/v1/gate-contract.schema.json",
  "../../src/contracts/schemas/v1/gate-decision.schema.json",
  "../../src/contracts/schemas/v1/project-error.schema.json",
  "../../src/contracts/schemas/v1/durable-primitives.schema.json",
  "../../src/contracts/schemas/v1/task-state.schema.json",
  "../../src/contracts/schemas/v1/task-initialization.schema.json",
  "../../src/contracts/schemas/v1/legacy-import-initialization.schema.json",
  "../../src/contracts/schemas/v1/document-artifact.schema.json",
  "../../src/contracts/schemas/v1/implementation-output.schema.json",
  "../../src/contracts/schemas/v1/secret-scan-result.schema.json",
  "../../src/contracts/schemas/v1/triage.schema.json"
] as const;

const validatingKeywordCoverage = {
  // The project-error document still carries its own byte and ordering keywords, so those arms
  // are document-enforced against the durable contracts — only the path-claim arms (whose
  // keywords retired into the Zod refines) stay runtime-only categories.
  "x-archflow-max-utf8-bytes": ["path-utf8-input", "path-utf8-output"],
  "x-archflow-mcp-semantics": [
    "mcp-waiver-origin-task",
    "gate-constitution-rule-order",
    "gate-constitution-eligible-axis",
    "gate-constitution-nonempty",
    "gate-constitution-pass-consistency",
    "gate-attempts-exhausted",
    "gate-material-drift-order",
    "gate-commit-artifact-order",
    "gate-commit-parent-order"
  ],
  "x-archflow-gate-semantics": [
    "gate-constitution-rule-order",
    "gate-constitution-eligible-axis",
    "gate-constitution-nonempty",
    "gate-constitution-pass-consistency",
    "gate-attempts-exhausted",
    "gate-material-drift-order",
    "gate-commit-artifact-order",
    "gate-commit-parent-order",
    "gate-constitution-waiver-rule-eligibility",
    "gate-constitution-waiver-axis-eligibility",
    "gate-restore-adoption-authority"
  ],
  "x-archflow-nfc": ["path-nfc-input"],
  "x-archflow-sorted-unique-by": ["document-declared-input-order"]
} as const;

const resultCorrelationCoverage = [
  "failure-tool-correlation",
  "state-success-status-correlation",
  "gate-success-kind-correlation",
  "gate-success-decision-kind-correlation",
  "gate-success-task-correlation",
  "gate-success-phase-correlation",
  "gate-success-subject-correlation",
  "gate-success-notes-correlation",
  "waiver-success-origin-correlation",
  "waiver-success-task-correlation",
  "waiver-success-rule-id-correlation",
  "waiver-success-rule-version-correlation",
  "waiver-success-subject-correlation",
  "waiver-success-evidence-correlation",
  "waiver-success-scope-correlation"
] as const;

const annotationKeywords = ["x-archflow-effect"] as const;
/**
 * The `x-archflow-*` keywords still carried by the source documents: the generated `mcp-tools`
 * document keeps `x-archflow-mcp-semantics` on its root by deliberate `.meta` emission, and the
 * generated `project-error` document preserves its path and ordering keywords by emission
 * override. Every other keyword in `validatingKeywordCoverage` (and the `x-archflow-effect`
 * annotation) retired to its shape's Zod authority when the documents became generated; the
 * semantic categories those keywords named remain runtime-enforced.
 */
const survivingSourceKeywords = [
  "x-archflow-max-utf8-bytes",
  "x-archflow-mcp-semantics",
  "x-archflow-nfc",
  "x-archflow-sorted-unique",
] as const;
const expectedRuntimeSemanticCategories = [...new Set([
  ...Object.values(validatingKeywordCoverage).flat(),
  ...resultCorrelationCoverage
])].sort();

const D = (character: string): string => character.repeat(64);
const RULE_A = Object.freeze({ rule_id: "Rule:A", rule_version: 1 });
const RULE_B = Object.freeze({ rule_id: "Rule:B", rule_version: 1 });
const PROVENANCE = Object.freeze({ schema_version: "1", actor_class: "human", assurance: "declared-local-trace", channel: "archflow-local", decision_event_id: "Decision:1", helper_invocation_id: "Helper:1", recorded_at: "2026-07-27T12:00:00.000Z" });
const COMMON = Object.freeze({ schema_version: "1", task_id: "task-1", intent_id: "intent-1", expected_revision: 0, input_fingerprint: D("a") });
const COUNTER = Object.freeze({ role: "counter-review", evidence_digest: D("2"), assurance: "server-attested", producer_family: "claude", reviewer_family: "codex" });
const CURRENT_EVIDENCE = Object.freeze({ set_digest: D("3"), slots: [COUNTER] });
const AUTHORITY = Object.freeze({ link_digest: D("4"), purpose: "restore-adoption", proposed_generation_digest: D("5"), changed_input_fingerprint: D("6") });
const SCOPE = Object.freeze({ operation: "review-trigger", boundary: "subject" });
const DOCUMENT_ARTIFACT = JSON.parse(await readFile(
  new URL("../fixtures/contracts/durable/document-artifact.valid.json", import.meta.url),
  "utf8",
)) as Record<string, unknown>;

const stateCall = (status = "running") => ({ ...COMMON, phase_instance: "phase-impl-3", step: "produce", status });
const counterCall = (artifactPath = "phases/phase-3.md") => ({ ...COMMON, artifact_path: artifactPath });
const gateCall = (kind: string, context: unknown) => ({ ...COMMON, phase_instance: "phase-impl-3", summary: "Review", subject_digest: D("b"), current_evidence: CURRENT_EVIDENCE, kind, context, preview_digest: D("c"), decision: { choice: "approve", reason: "Reviewed." } });
const waiverCall = () => ({ ...COMMON, origin: { origin_gate_id: "gate-1", origin_decision_digest: D("1"), origin_context_digest: D("2"), task_id: COMMON.task_id, phase_instance: "phase-impl-3", subject_digest: D("3"), current_evidence_set_digest: D("4"), rule: RULE_A, scope: SCOPE }, rationale: "Needed", preview_digest: D("c"), decision: { choice: "grant", reason: "Reviewed." } });
const constitutionContext = () => ({ constitution: "fail", failed_rules: [RULE_A], uncertain_rules: [], matched_trigger_rules: [RULE_A], uncertain_trigger_rules: [], eligible_waivers: [{ rule: RULE_A, scope: { operation: "adjudication-failure", boundary: "subject" } }, { rule: RULE_A, scope: SCOPE }] });
const restoreContext = () => ({ path: "task/file.md", recorded_generation_digest: D("7"), current_generation_digest: D("8"), adoption_candidate: AUTHORITY });
const result = (value: unknown) => ({ schema_version: "1", ok: true, value });
const decisionEnvelope = (kind: string, payload: unknown, overrides: Record<string, unknown> = {}) => ({ schema_version: "1", gate_id: "gate-1", task_id: COMMON.task_id, phase_instance: "phase-impl-3", subject_digest: D("b"), context_digest: D("9"), human_provenance: PROVENANCE, kind, payload, ...overrides });
const gateResult = (kind: string, payload: Record<string, unknown>, overrides: Record<string, unknown> = {}) => result({ kind, decision: decisionEnvelope(kind, payload), notes: payload.reason, revision: 1, ...overrides });
const waiverResult = (overrides: Record<string, unknown> = {}) => result({ origin_gate_id: "gate-1", waiver_gate_id: "gate-2", task_id: COMMON.task_id, rule_id: RULE_A.rule_id, rule_version: RULE_A.rule_version, subject_digest: D("3"), current_evidence_set_digest: D("4"), scope: SCOPE, human_provenance: PROVENANCE, granted: false, notes: "Denied", revision: 1, ...overrides });

function freshAjv(): Ajv2020 {
  const ajv = new Ajv2020({ strict: true, allErrors: true, allowUnionTypes: false, coerceTypes: false, removeAdditional: false, useDefaults: false, validateFormats: true });
  const addFormats = formatsModule.default as unknown as FormatsPlugin;
  addFormats(ajv);
  return ajv;
}

function visit(value: unknown, callback: (value: unknown, path: string) => void, path = "$"): void {
  callback(value, path);
  if (Array.isArray(value)) value.forEach((entry, index) => visit(entry, callback, `${path}[${index}]`));
  else if (typeof value === "object" && value !== null) for (const [key, entry] of Object.entries(value)) visit(entry, callback, `${path}.${key}`);
}

async function corpus(): Promise<readonly CorpusCase[]> {
  return JSON.parse(await readFile(new URL("../fixtures/mcp/catalogue/classified-corpus.json", import.meta.url), "utf8")) as CorpusCase[];
}

function materialize(entry: CorpusCase): MaterializedCase {
  const longPath = `${"é".repeat(600)}.md`;
  const nfdPath = "re\u0301sume\u0301.md";
  const artifactGateCall = gateCall("artifact-approval", { artifact_kind: "phase-implementation" });
  const artifactGateResult = gateResult("artifact-approval", { decision: "approve", reason: "Approved" });
  switch (entry.materialization) {
    case "valid-state-input": return { value: stateCall() };
    case "invalid-state-extra": return { value: { ...stateCall(), unexpected: true } };
    case "path-utf8-input": return { value: counterCall(longPath) };
    case "path-nfc-input": return { value: counterCall(nfdPath) };
    case "document-declared-input-order": {
      const artifact = structuredClone(DOCUMENT_ARTIFACT);
      const inputs = artifact.declared_inputs as unknown[];
      artifact.declared_inputs = [inputs[0], inputs[0]];
      return { value: { ...stateCall("succeeded"), artifact } };
    }
    case "waiver-origin-task": return { value: { ...waiverCall(), task_id: "other" } };
    case "current-evidence": return { value: { ...artifactGateCall, current_evidence: { ...CURRENT_EVIDENCE, set_digest: D("0") } } };
    case "constitution-rule-order": return { value: gateCall("constitution-review", { ...constitutionContext(), matched_trigger_rules: [RULE_B, RULE_A], failed_rules: [], constitution: "pass", eligible_waivers: [] }) };
    // A rule offered a waiver on an axis it does not appear on.
    case "constitution-eligible-axis": return { value: gateCall("constitution-review", { ...constitutionContext(), matched_trigger_rules: [], eligible_waivers: [{ rule: RULE_A, scope: SCOPE }] }) };
    case "constitution-nonempty": return { value: gateCall("constitution-review", { ...constitutionContext(), constitution: "pass", failed_rules: [], matched_trigger_rules: [], eligible_waivers: [] }) };
    case "constitution-pass-consistency": return { value: gateCall("constitution-review", { ...constitutionContext(), constitution: "pass" }) };
    case "attempts-exhausted": return { value: gateCall("attempts-exhausted", { step: "produce", attempts: 1, maximum_attempts: 2 }) };
    case "material-drift-order": return { value: gateCall("material-drift", { affected_upstream: { kind: "architecture", digest: D("4") }, drift: "material", affected_claim_ids: ["z", "a"] }) };
    case "commit-artifact-order": return { value: gateCall("commit-authorization", { target_ref: "HEAD", baseline_commit: "1".repeat(40), commit_message: "ArchFlow: Implement task-1 phase 3", paths: ["tracked.txt"], diff_digest: D("4"), current_artifact_digests: [D("b"), D("a")], parent_document_digests: [D("c")] }) };
    case "commit-parent-order": return { value: gateCall("commit-authorization", { target_ref: "HEAD", baseline_commit: "1".repeat(40), commit_message: "ArchFlow: Implement task-1 phase 3", paths: ["tracked.txt"], diff_digest: D("4"), current_artifact_digests: [D("a")], parent_document_digests: [D("c"), D("b")] }) };
    case "valid-state-success": return { call: stateCall(), value: result({ path: "phases/state.json", revision: 1, status: "running" }) };
    case "valid-counter-success": return { call: counterCall(), value: result({ path: "reviews/counter.md", verdict: "pass", blocking_count: 0, constitution: { status: "not-run", reason: "no-active-constitution-rules" }, revision: 1 }) };
    case "valid-gate-success": return { call: artifactGateCall, value: artifactGateResult };
    case "valid-waiver-success": return { call: waiverCall(), value: waiverResult() };
    case "valid-failure": return { value: snapshotFailure(["a/file", "z/file"]) };
    case "path-utf8-output": return { call: stateCall(), value: result({ path: longPath, revision: 1, status: "running" }) };
    case "project-error-path-utf8": return { value: snapshotFailure([longPath]) };
    case "project-error-order": return { value: snapshotFailure(["z/file", "a/file"]) };
    case "failure-tool-correlation": return { value: { schema_version: "1", ok: false, error: { schema_version: "1", code: "CONTRACT_INVALID", owner: "contracts", retryable: false, diagnostic: { template_id: "CONTRACT_INVALID", parameters: { tool: "archflow_gate", issue_code: "input-invalid" } }, next_action: "correct-contract" } } };
    case "constitution-waiver-rule-eligibility": return { call: gateCall("constitution-review", constitutionContext()), value: gateResult("constitution-review", { decision: "waiver-requested", reason: "Exception", rule: RULE_B, operation: "review-trigger", rationale: "Needed" }) };
    // The rule is eligible, but only on the other axis.
    case "constitution-waiver-axis-eligibility": return { call: gateCall("constitution-review", { ...constitutionContext(), eligible_waivers: [{ rule: RULE_A, scope: { operation: "adjudication-failure", boundary: "subject" } }] }), value: gateResult("constitution-review", { decision: "waiver-requested", reason: "Exception", rule: RULE_A, operation: "review-trigger", rationale: "Needed" }) };
    case "restore-adoption-authority": return { call: gateCall("restore-collision", restoreContext()), value: gateResult("restore-collision", { decision: "adopt-as-new-generation", reason: "Adopt", adoption_authority: { ...AUTHORITY, link_digest: D("a") }, rationale: "Reviewed" }) };
    case "state-status-correlation": return { call: stateCall(), value: result({ path: "phases/state.json", revision: 1, status: "failed" }) };
    case "gate-kind-correlation": return { call: artifactGateCall, value: gateResult("artifact-approval", { decision: "approve", reason: "Approved" }, { kind: "constitution-review" }) };
    case "gate-decision-kind-correlation": return { call: artifactGateCall, value: result({ kind: "artifact-approval", decision: decisionEnvelope("material-drift", { decision: "reject", reason: "Approved" }), notes: "Approved", revision: 1 }) };
    case "gate-task-correlation": return { call: artifactGateCall, value: artifactGateResultWithDecision({ task_id: "other" }) };
    case "gate-phase-correlation": return { call: artifactGateCall, value: artifactGateResultWithDecision({ phase_instance: "phase-impl-4" }) };
    case "gate-subject-correlation": return { call: artifactGateCall, value: artifactGateResultWithDecision({ subject_digest: D("c") }) };
    case "gate-notes-correlation": return { call: artifactGateCall, value: result({ ...(artifactGateResult.value as object), notes: "Different" }) };
    case "waiver-origin-correlation": return { call: waiverCall(), value: waiverResult({ origin_gate_id: "gate-other" }) };
    case "waiver-task-correlation": return { call: waiverCall(), value: waiverResult({ task_id: "other" }) };
    case "waiver-rule-id-correlation": return { call: waiverCall(), value: waiverResult({ rule_id: "Rule:Other" }) };
    case "waiver-rule-version-correlation": return { call: waiverCall(), value: waiverResult({ rule_version: 2 }) };
    case "waiver-subject-correlation": return { call: waiverCall(), value: waiverResult({ subject_digest: D("c") }) };
    case "waiver-evidence-correlation": return { call: waiverCall(), value: waiverResult({ current_evidence_set_digest: D("c") }) };
    case "waiver-scope-correlation": return { call: waiverCall(), value: waiverResult({ scope: { ...SCOPE, boundary: "phase" } }) };
    default: throw new TypeError(`unknown corpus materialization: ${entry.materialization}`);
  }
}

function snapshotFailure(paths: string[]): unknown {
  return { schema_version: "1", ok: false, error: { schema_version: "1", code: "SNAPSHOT_LIMIT", owner: "snapshot", retryable: false, diagnostic: { template_id: "SNAPSHOT_LIMIT", parameters: { limit_scope: "task", offending_paths: paths, current_bytes: 2, byte_cap: 1 } }, next_action: "reduce-snapshot" } };
}

function artifactGateResultWithDecision(overrides: Record<string, unknown>): unknown {
  const payload = { decision: "approve", reason: "Approved" };
  return result({ kind: "artifact-approval", decision: decisionEnvelope("artifact-approval", payload, overrides), notes: "Approved", revision: 1 });
}

function validateAuthenticSuccess(tool: ToolName, rawCall: unknown, value: unknown): void {
  switch (tool) {
    case "archflow_state": void validateProjectResultStructure(parseToolCall(tool, rawCall), value); break;
    case "archflow_counter_review": void validateProjectResultStructure(parseToolCall(tool, rawCall), value); break;
    case "archflow_gate": void validateProjectResultStructure(parseToolCall(tool, rawCall), value); break;
    case "archflow_waiver": void validateProjectResultStructure(parseToolCall(tool, rawCall), value); break;
  }
}

describe("advertised MCP tool catalogue", () => {
  it("compiles every standalone input and output with strict Ajv 2020 and standard formats only", () => {
    for (const descriptor of ADVERTISED_TOOL_CATALOGUE) {
      expect(() => freshAjv().compile(descriptor.inputSchema), `${descriptor.name} input`).not.toThrow();
      expect(() => freshAjv().compile(descriptor.outputSchema), `${descriptor.name} output`).not.toThrow();
    }
  });

  it("pins object roots, local references, and portable keywords", async () => {
    const sourceDocuments = await Promise.all(schemaDocumentPaths.map(async (path) => JSON.parse(await readFile(new URL(path, import.meta.url), "utf8")) as object));
    const sourceKeywords = new Set<string>();
    for (const document of sourceDocuments) visit(document, (value) => {
      if (typeof value !== "object" || value === null || Array.isArray(value)) return;
      for (const key of Object.keys(value)) if (key.startsWith("x-archflow-")) sourceKeywords.add(key);
    });
    expect([...sourceKeywords].sort()).toEqual([...survivingSourceKeywords].sort());

    for (const descriptor of ADVERTISED_TOOL_CATALOGUE) {
      for (const [member, schema] of [["input", descriptor.inputSchema], ["output", descriptor.outputSchema]] as const) {
        expect(schema.type, `${descriptor.name} ${member} root`).toBe("object");
        expect(schema.$schema).toBe("https://json-schema.org/draft/2020-12/schema");
        visit(schema, (value, path) => {
          if (typeof value !== "object" || value === null || Array.isArray(value)) return;
          for (const [key, nested] of Object.entries(value)) {
            expect(key, `${descriptor.name} ${member} ${path}`).not.toBe("$id");
            expect(key, `${descriptor.name} ${member} ${path}`).not.toMatch(/^x-archflow-/u);
            if (key === "$ref") expect(nested, `${descriptor.name} ${member} ${path}`).toMatch(/^#\//u);
            if (key === "$schema" && path !== "$") throw new TypeError(`${descriptor.name} ${member} has embedded $schema at ${path}`);
          }
        });
      }
    }
  });

  it("advertises every input as a flat object root that survives host oneOf-flattening", () => {
    // Regression fence: the normative input contract is a union of arms, and at least one MCP
    // host flattens a root-level combinator by dropping branches it cannot resolve through
    // $ref/allOf — observed advertising the tools as zero-field objects. The advertised root
    // must carry the merged field surface directly and leave combinators below the root.
    const retiredReference = { schema_version: "1", task_id: "task-1", intent_id: "intent-1", request_digest: D("c") };
    for (const descriptor of ADVERTISED_TOOL_CATALOGUE) {
      const schema = descriptor.inputSchema;
      for (const combinator of ["oneOf", "allOf", "anyOf", "$ref", "if"]) {
        expect(schema, `${descriptor.name} input root ${combinator}`).not.toHaveProperty(combinator);
      }
      const properties = schema.properties as Record<string, unknown>;
      expect(Object.keys(properties).length, `${descriptor.name} input properties`).toBeGreaterThanOrEqual(3);
      for (const field of schema.required as string[]) {
        expect(properties, `${descriptor.name} requires undeclared ${field}`).toHaveProperty(field);
      }
      expect(schema.additionalProperties, `${descriptor.name} input strictness`).toBe(false);
      // No advertised input carries the retired staged-reference arm in any form.
      expect(JSON.stringify(schema), `${descriptor.name} staged reference`).not.toContain("request_digest");
      expect(freshAjv().compile(schema)(retiredReference), `${descriptor.name} rejects retired staged reference`).toBe(false);
    }

    // The merge must carry the branch field types through, not collapse them: these are the
    // exact fields the zero-field regression left the model to guess as strings. The apply
    // input's submission union stays a below-root def reached from the merged action object,
    // and both variant fields resolve through single-hop flat defs.
    const applyProperties = (ADVERTISED_TOOL_CATALOGUE.find(({ name }) => name === "archflow_apply")!.inputSchema as { properties: Record<string, unknown> }).properties;
    expect(applyProperties.invocation).toEqual({ $ref: "#/$defs/workflowInvocation" });
    expect(applyProperties.task_id).toEqual({ $ref: "#/$defs/taskSlug" });
    const action = applyProperties.action as { properties: Record<string, unknown>; required: readonly string[] };
    expect(action.required).toContain("offer");
    expect(action.properties.offer).toMatchObject({ type: "string" });
    expect(action.properties.submission).toEqual({ $ref: "#/$defs/applySubmission" });
  });

  it("advertises the review-dispatch submission arm self-contained inside applySubmission", async () => {
    const apply = ADVERTISED_TOOL_CATALOGUE.find(({ name }) => name === "archflow_apply")!;
    const armByConst = (node: unknown): Record<string, unknown> | undefined =>
      (node as { anyOf?: readonly Record<string, unknown>[] }).anyOf
        ?.find((candidate) => (candidate.properties as { kind?: { const?: string } } | undefined)?.kind?.const === "review-dispatch");

    const arm = armByConst((apply.inputSchema as { $defs: Record<string, unknown> }).$defs.applySubmission);
    expect(arm).toBeDefined();
    expect(arm!.required).toEqual(["kind", "route_override"]);
    const routeOverride = (arm!.properties as Record<string, { required?: string[]; properties?: Record<string, unknown> }>).route_override!;
    expect(routeOverride.required).toEqual(["reason"]);
    expect(Object.keys(routeOverride.properties!)).toEqual(["reason", "counter-reviewer", "adjudicator"]);
    // The route schema is a semantic-workflow-local clone: the arm resolves without any $ref, so
    // the advertised catalogue never reaches into a config document it does not carry.
    expect(JSON.stringify(arm)).not.toContain("$ref");

    // The generated document carries the same arm inside its own applySubmission def.
    const generated = JSON.parse(await readFile(
      new URL("../../src/contracts/schemas/v1/semantic-workflow.schema.json", import.meta.url),
      "utf8",
    )) as object;
    expect(armByConst((generated as { $defs: Record<string, unknown> }).$defs.applySubmission)).toEqual(arm);

    // The advertised interface accepts a well-formed substitution request and refuses the
    // meaningless override-less arm shape.
    const validate = freshAjv().compile(apply.inputSchema);
    const substitutionInput = {
      schema_version: "1", task_id: "task-1",
      invocation: { skill: "archflow-phase-impl", phase: 1, intent: "resume" },
      action: {
        offer: `af1_${"a".repeat(64)}`,
        submission: {
          kind: "review-dispatch",
          route_override: { reason: "codex CLI auth outage", "counter-reviewer": { model: "gpt-5.6-outage-fallback", effort: "high" } },
        },
      },
    };
    expect(validate(substitutionInput), JSON.stringify(validate.errors)).toBe(true);
    expect(validate({
      ...substitutionInput,
      action: { ...substitutionInput.action, submission: { kind: "review-dispatch" } },
    })).toBe(false);
  });

  it("advertises exactly the reference-reachable definitions within the context-budget fence", () => {
    const unescape = (token: string): string => token.replaceAll("~1", "/").replaceAll("~0", "~");
    const assertExactReachableClosure = (schema: Readonly<Record<string, unknown>>, label: string): void => {
      const reachable = new Set<string>();
      const visitedReferences = new Set<string>();
      const resolve = (reference: string): unknown => {
        let node: unknown = schema;
        for (const token of reference.slice("#/".length).split("/").map(unescape)) {
          node = Array.isArray(node) ? node[Number(token)] : (node as Record<string, unknown>)[token];
          expect(node, `${label} ${reference}`).toBeDefined();
        }
        return node;
      };
      const walk = (value: unknown): void => {
        if (Array.isArray(value)) {
          for (const entry of value) walk(entry);
          return;
        }
        if (typeof value !== "object" || value === null) return;
        for (const [key, entry] of Object.entries(value)) {
          if (key === "$ref" && typeof entry === "string") {
            // Every advertised reference resolves in a single hop: a $ref pointing INTO a
            // nested $defs made at least one MCP host serialize the declared argument as a
            // JSON string instead of an object.
            expect(entry, `${label} reference form`).toMatch(/^#\/\$defs\/[^/]+$/u);
            reachable.add(unescape(entry.split("/")[2] as string));
            if (!visitedReferences.has(entry)) {
              visitedReferences.add(entry);
              walk(resolve(entry));
            }
          } else {
            walk(entry);
          }
        }
      };
      const { $defs, ...fragment } = schema;
      walk(fragment);
      expect([...Object.keys($defs as object)].sort(), label).toEqual([...reachable].sort());
    };

    for (const descriptor of ADVERTISED_TOOL_CATALOGUE) {
      expect((SEMANTIC_TOOL_NAMES as readonly string[]).includes(descriptor.name), descriptor.name).toBe(true);
      assertExactReachableClosure(descriptor.inputSchema, `${descriptor.name} input`);
      assertExactReachableClosure(descriptor.outputSchema, `${descriptor.name} output`);
      // The error union is a result-envelope concern; no semantic tool schema reaches it, and
      // the flat def names never leave a document-key grouping level behind.
      expect(Object.keys(descriptor.inputSchema.$defs as object)).not.toContain("project-error");
      expect(Object.keys(descriptor.outputSchema.$defs as object)).not.toContain("project-error");
      expect(Object.keys(descriptor.outputSchema.$defs as object)).toContain("workflowView");
      for (const documentKey of ["mcp-tools", "primitives", "semantic-workflow", "project-error"]) {
        expect(Object.keys(descriptor.inputSchema.$defs as object), `${descriptor.name} input ${documentKey} group`).not.toContain(documentKey);
        expect(Object.keys(descriptor.outputSchema.$defs as object), `${descriptor.name} output ${documentKey} group`).not.toContain(documentKey);
      }
    }

    // Context-budget regression fence, not a precise contract: the unpruned catalogue
    // serialized to 1,316,997 bytes, ~99% of it definitions no tool member referenced;
    // ref-reachable pruning brought it to 283,708 and the advertised error summary (the full
    // project-error union stays normative and server-checked) to 105,478.
    expect(JSON.stringify({ tools: ADVERTISED_TOOL_CATALOGUE }).length).toBeLessThan(130_000);
  });

  it("deeply freezes the catalogue, descriptors, schemas, and schema descendants", () => {
    visit(ADVERTISED_TOOL_CATALOGUE, (value, path) => {
      if ((typeof value === "object" && value !== null) || typeof value === "function") expect(Object.isFrozen(value), path).toBe(true);
    });
  });

  it("classifies every removed validation branch and call correlation separately from portable structure", async () => {
    const cases = await corpus();
    const runtimeCases = cases.filter(({ classification }) => classification === "runtime-semantic");
    expect(new Set(cases.map(({ classification }) => classification))).toEqual(new Set(["portable-structure", "runtime-semantic"]));
    expect(runtimeCases.map(({ semantic_category }) => semantic_category).sort()).toEqual(expectedRuntimeSemanticCategories);
    expect(new Set(runtimeCases.map(({ semantic_category }) => semantic_category)).size).toBe(runtimeCases.length);

    const validSuccessTools = cases.filter(({ classification, member, portable, runtime, call_fixture }) => classification === "portable-structure" && member === "output" && portable && runtime && call_fixture !== undefined).map(({ tool }) => tool);
    expect(validSuccessTools).toEqual(TOOL_NAMES);

    // The corpus covers the durable request contracts — the internal request vocabulary the
    // semantic composers still emit — so its portable structure is pinned against the generated
    // mcp-tools document, not the advertised (now semantic-only) catalogue.
    const documents = await Promise.all(schemaDocumentPaths.map(async (path) => JSON.parse(await readFile(new URL(path, import.meta.url), "utf8")) as object));
    const mcp = documents[0] as { $id?: string; $defs: Record<string, { input: object; result?: object }> };
    const references = documents.slice(1);
    const durableSchemaValidator = (entry: CorpusCase) => createJsonSchemaValidator<unknown>({
      $schema: "https://json-schema.org/draft/2020-12/schema",
      ...mcp.$defs[entry.tool]![entry.member === "input" ? "input" : "result"]!,
      $defs: mcp.$defs,
    }, references);

    for (const entry of cases) {
      const { value, call } = materialize(entry);
      const validator = durableSchemaValidator(entry);
      expect(validator.validate(value), `${entry.label} portable: ${JSON.stringify(validator.validate.errors)}`).toBe(entry.portable);
      const isSuccessOutput = entry.member === "output" && (value as { ok?: unknown }).ok === true;
      if (isSuccessOutput) {
        expect(entry.call_fixture, `${entry.label} companion call fixture`).toBe(entry.tool);
        expect(call, `${entry.label} companion call`).toBeDefined();
      }
      let runtime = true;
      try {
        if (entry.member === "input") parseToolCall(entry.tool, value);
        else if ((value as { ok?: unknown }).ok === false) validateProjectFailureStructure(entry.tool, value);
        else validateAuthenticSuccess(entry.tool, call, value);
      } catch {
        runtime = false;
      }
      expect(runtime, `${entry.label} runtime`).toBe(entry.runtime);
      if (entry.classification === "runtime-semantic") {
        expect(entry.portable).toBe(true);
        expect(entry.runtime).toBe(false);
      }
    }
    // Compiling a JSON-Schema validator per corpus row over both authorities is CPU-heavy;
    // under a full parallel suite it exceeds the default test timeout without indicating any
    // contract drift.
  }, 30_000);

  it("keeps the catalogue on its direct SDK-free seam", async () => {
    const [source, contractBarrel, packageManifest] = await Promise.all([
      readFile(new URL("../../src/mcp/tools.ts", import.meta.url), "utf8"),
      readFile(new URL("../../src/contracts/index.ts", import.meta.url), "utf8"),
      readFile(new URL("../../package.json", import.meta.url), "utf8")
    ]);
    expect(source).not.toMatch(/@modelcontextprotocol\/(?:core|server)/u);
    expect(source).not.toMatch(/\/internal(?:[/'"]|$)/u);
    expect(contractBarrel).not.toMatch(/ADVERTISED_TOOL_CATALOGUE|AdvertisedToolDescriptor|mcp\/tools/u);
    expect(JSON.parse(packageManifest) as object).not.toHaveProperty("exports");
    await expect(readFile(new URL("../../src/mcp/index.ts", import.meta.url), "utf8")).rejects.toMatchObject({ code: "ENOENT" });
    expect(Object.keys(await import("../../src/mcp/tools.js"))).toEqual(["ADVERTISED_TOOL_CATALOGUE"]);
  });
});

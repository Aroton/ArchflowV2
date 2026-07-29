import { describe, expect, it } from "vitest";

import { PROJECT_ERROR_DEFINITIONS, PROTOCOL_ERROR_DEFINITIONS, parseProjectError, parseProtocolError } from "../../src/contracts/errors.js";
import { gateDecisionEffect, parseGateContract, parseGateDecisionEnvelope, type GateEffect } from "../../src/contracts/gates.js";
import gateContractSchema from "../../src/contracts/schemas/v1/gate-contract.schema.json" with { type: "json" };
import gateDecisionSchema from "../../src/contracts/schemas/v1/gate-decision.schema.json" with { type: "json" };
import primitivesSchema from "../../src/contracts/schemas/v1/primitives.schema.json" with { type: "json" };
import projectErrorSchema from "../../src/contracts/schemas/v1/project-error.schema.json" with { type: "json" };
import protocolErrorSchema from "../../src/contracts/schemas/v1/protocol-error.schema.json" with { type: "json" };
import supplementalSchema from "../../src/contracts/schemas/v1/supplemental-review.schema.json" with { type: "json" };
import { parseSupplementalReviewOutcome } from "../../src/contracts/supplemental.js";
import { createJsonSchemaValidator } from "../../src/contracts/validators.js";

type JsonObject = Record<string, unknown>;
type ErrorDefinition = { readonly owner: string; readonly retryable: boolean; readonly action: string; readonly projection: string; readonly parameter_parser: { readonly parse: (value: unknown) => Readonly<Record<string, unknown>> } };

const D = (character = "a"): string => character.repeat(64);
const RULE = { rule_id: "trust-boundary", rule_version: 1 };
const AUTHORITY = { link_digest: D("a"), purpose: "restore-adoption", proposed_generation_digest: D("b"), changed_input_fingerprint: D("c") };
const gateValidator = createJsonSchemaValidator(gateContractSchema, [primitivesSchema]);
const decisionValidator = createJsonSchemaValidator(gateDecisionSchema, [primitivesSchema, gateContractSchema]);
const projectValidator = createJsonSchemaValidator(projectErrorSchema);
const protocolValidator = createJsonSchemaValidator(protocolErrorSchema);
const supplementalValidator = createJsonSchemaValidator(supplementalSchema, [primitivesSchema]);

const gateCases: readonly JsonObject[] = [
  ...["approve", "revise", "reject"].map((decision) => ({ kind: "artifact-approval", context: { artifact_kind: "prd" }, payload: { decision, reason: "Reviewed" } })),
  ...["approve", "revise", "reject"].map((decision) => ({ kind: "review-trigger", context: { matched_rules: [RULE], uncertain_rules: [], eligible_waiver_rules: [RULE], waiver_scope: { operation: "review-trigger", boundary: "subject" } }, payload: { decision, reason: "Reviewed" } })),
  { kind: "review-trigger", context: { matched_rules: [RULE], uncertain_rules: [], eligible_waiver_rules: [RULE], waiver_scope: { operation: "review-trigger", boundary: "subject" } }, payload: { decision: "waiver-requested", reason: "Exception", rule: RULE, rationale: "Task-scoped exception" } },
  ...["amend-upstream", "revise-current", "reject"].map((decision) => ({ kind: "material-drift", context: { affected_upstream: { kind: "architecture", digest: D("a") }, drift: "material", affected_claim_ids: ["claim-one"] }, payload: { decision, reason: "Reviewed" } })),
  { kind: "adjudication-failure", context: { constitution: "fail", failed_rules: [RULE], uncertain_rules: [], eligible_waiver_rules: [RULE], waiver_scope: { operation: "adjudication-failure", boundary: "phase" } }, payload: { decision: "approve", reason: "Resolved", resolutions: [] } },
  ...["revise", "reject"].map((decision) => ({ kind: "adjudication-failure", context: { constitution: "fail", failed_rules: [RULE], uncertain_rules: [], eligible_waiver_rules: [RULE], waiver_scope: { operation: "adjudication-failure", boundary: "phase" } }, payload: { decision, reason: "Reviewed" } })),
  { kind: "adjudication-failure", context: { constitution: "fail", failed_rules: [RULE], uncertain_rules: [], eligible_waiver_rules: [RULE], waiver_scope: { operation: "adjudication-failure", boundary: "phase" } }, payload: { decision: "waiver-requested", reason: "Exception", rule: RULE, rationale: "Task-scoped exception" } },
  ...["retry-once", "revise", "abort"].map((decision) => ({ kind: "attempts-exhausted", context: { step: "counter_review", attempts: 2, maximum_attempts: 2 }, payload: { decision, reason: "Reviewed" } })),
  ...["revert-edit", "start-base-amendment", "abort"].map((decision) => ({ kind: "constitution-edit", context: { pinned_constitution_digest: D("a"), current_constitution_digest: D("b"), changed_path_class: "task-branch-constitution" }, payload: { decision, reason: "Reviewed" } })),
  ...["authorize-commit", "revise", "abort"].map((decision) => ({ kind: "commit-authorization", context: { target_ref: "refs/heads/task", diff_digest: D("a"), current_artifact_digests: [D("b")], parent_document_digests: [D("c")] }, payload: { decision, reason: "Reviewed" } })),
  ...["discard-and-restore", "abort"].map((decision) => ({ kind: "restore-collision", context: { path: "task/file.md", recorded_generation_digest: D("a"), current_generation_digest: D("b"), adoption_candidate: AUTHORITY }, payload: { decision, reason: "Reviewed" } })),
  { kind: "restore-collision", context: { path: "task/file.md", recorded_generation_digest: D("a"), current_generation_digest: D("b"), adoption_candidate: AUTHORITY }, payload: { decision: "adopt-as-new-generation", reason: "Adopt", adoption_authority: AUTHORITY, rationale: "Reviewed local changes" } },
  ...["accept-import-audit", "revise", "abort"].map((decision) => ({ kind: "migration-audit", context: { source_identity_digest: D("a"), destination_identity_digest: D("b"), import_digest: D("c"), code_baseline_digest: D("d"), policy_baseline_digest: D("e") }, payload: { decision, reason: "Reviewed" } })),
];

function localRef(root: JsonObject, reference: string): JsonObject {
  const name = reference.replace("#/$defs/", "");
  return (root.$defs as JsonObject)[name] as JsonObject;
}

function sampleFromSchema(schema: JsonObject, root: JsonObject): unknown {
  if (typeof schema.$ref === "string") return sampleFromSchema(localRef(root, schema.$ref), root);
  if (Object.hasOwn(schema, "const")) return schema.const;
  if (Array.isArray(schema.enum)) return schema.enum[0];
  if (Array.isArray(schema.oneOf)) return sampleFromSchema(schema.oneOf[0] as JsonObject, root);
  if (schema.type === "array") {
    const count = typeof schema.minItems === "number" ? schema.minItems : 1;
    return Array.from({ length: Math.max(1, count) }, () => sampleFromSchema(schema.items as JsonObject, root));
  }
  if (schema.type === "object" || typeof schema.properties === "object") {
    const result: JsonObject = {};
    const required = Array.isArray(schema.required) ? schema.required as string[] : [];
    const properties = schema.properties as JsonObject;
    for (const name of required) result[name] = sampleFromSchema(properties[name] as JsonObject, root);
    return result;
  }
  if (schema.type === "integer" || schema.type === "number") return typeof schema.minimum === "number" ? schema.minimum : 1;
  if (schema.type === "boolean") return true;
  if (schema.type === "string") {
    const pattern = String(schema.pattern ?? "");
    if (pattern.includes("64}")) return D("a");
    if (pattern.includes("phase-design")) return "phase-impl-2";
    if (pattern.includes("a-z0-9_")) return "safe-code";
    if (pattern.includes("A-Za-z0-9.-")) return "1.0";
    if (pattern.includes("A-Za-z0-9._:-")) return "id-1";
    return "value";
  }
  throw new TypeError(`cannot synthesize schema sample: ${JSON.stringify(schema)}`);
}

function errorBranches(root: JsonObject): readonly JsonObject[] {
  return (root.oneOf as JsonObject[]).map((reference) => localRef(root, reference.$ref as string));
}

function branchContract(branch: JsonObject, root: JsonObject): { code: string; parameters: unknown } {
  const overlay = (branch.allOf as JsonObject[])[1]!;
  const properties = overlay.properties as JsonObject;
  const code = ((properties.code as JsonObject).const) as string;
  const diagnostic = properties.diagnostic as JsonObject;
  const parameterSchema = ((diagnostic.properties as JsonObject).parameters) as JsonObject;
  return { code, parameters: sampleFromSchema(parameterSchema, root) };
}

describe("exhaustive gate, error, and supplemental authority", () => {
  it("checks every runtime decision effect against every normative annotation", () => {
    const root = gateContractSchema as unknown as JsonObject;
    const definitions = root.$defs as JsonObject;
    const annotated = Object.values(definitions).filter((definition): definition is JsonObject => typeof definition === "object" && definition !== null && Object.hasOwn(definition, "x-archflow-effect"));
    const annotatedPairs = annotated.map((definition) => ({ decision: (((definition.properties as JsonObject).decision as JsonObject).const) as string, effect: definition["x-archflow-effect"] as GateEffect }));
    expect(annotatedPairs).toHaveLength(15);
    for (const pair of annotatedPairs) expect(gateDecisionEffect({ decision: pair.decision } as never)).toBe(pair.effect);

    const schemaPairs = new Set<string>();
    for (const rootRef of root.oneOf as JsonObject[]) {
      const contract = localRef(root, rootRef.$ref as string);
      const kind = (((contract.properties as JsonObject).kind as JsonObject).const) as string;
      const payload = ((contract.properties as JsonObject).payload) as JsonObject;
      for (const payloadRef of payload.oneOf as JsonObject[]) {
        const definition = localRef(root, payloadRef.$ref as string);
        schemaPairs.add(`${kind}:${String(((definition.properties as JsonObject).decision as JsonObject).const)}`);
      }
    }
    expect(new Set(gateCases.map((value) => `${String(value.kind)}:${String((value.payload as JsonObject).decision)}`))).toEqual(schemaPairs);
  });

  it("accepts every gate decision variant without mutation and rejects trust-boundary substitutions", () => {
    expect(gateCases).toHaveLength(29);
    for (const value of gateCases) {
      const before = structuredClone(value);
      expect(gateValidator.validate(value), `${String(value.kind)}:${JSON.stringify(gateValidator.validate.errors)}`).toBe(true);
      expect(parseGateContract(value)).toEqual(value);
      expect(value).toEqual(before);
      const envelope = { schema_version: "1", gate_id: "gate-1", task_id: "task-1", phase_instance: "phase-impl-2", subject_digest: D("a"), context_digest: D("b"), human_provenance: { schema_version: "1", actor_class: "human", assurance: "declared-local-trace", channel: "archflow-local", decision_event_id: `event-${String(value.kind)}`, helper_invocation_id: "helper-1", recorded_at: "2026-07-27T12:00:00.000Z" }, kind: value.kind, payload: value.payload };
      const envelopeBefore = structuredClone(envelope);
      expect(decisionValidator.validate(envelope), `${String(value.kind)}:${JSON.stringify(decisionValidator.validate.errors)}`).toBe(true);
      expect(parseGateDecisionEnvelope(envelope)).toEqual(envelope);
      expect(envelope).toEqual(envelopeBefore);
      const unknownContext = { ...value, context: { ...(value.context as JsonObject), gate_id: "forged-gate" } };
      expect(gateValidator.validate(unknownContext)).toBe(false);
      expect(() => parseGateContract(unknownContext)).toThrow();
    }
    const restore = gateCases.find((value) => (value.payload as JsonObject).decision === "adopt-as-new-generation")!;
    const wrongAuthority = { ...restore, payload: { ...(restore.payload as JsonObject), adoption_authority: { ...AUTHORITY, link_digest: D("f") } } };
    expect(gateValidator.validate(wrongAuthority)).toBe(false);
    expect(() => parseGateContract(wrongAuthority)).toThrow();
  });

  it("exercises all 57 exact error rows and rejects every correlated-field mutation", () => {
    const roots = [projectErrorSchema as unknown as JsonObject, protocolErrorSchema as unknown as JsonObject] as const;
    const exercisedCodes = new Set<string>();
    let exercised = 0;
    for (const root of roots) {
      const isProject = root.$id === "urn:archflow:schema:v1:project-error";
      const registry = (isProject ? PROJECT_ERROR_DEFINITIONS : PROTOCOL_ERROR_DEFINITIONS) as unknown as Readonly<Record<string, ErrorDefinition>>;
      const validator = isProject ? projectValidator : protocolValidator;
      for (const branch of errorBranches(root)) {
        const { code, parameters } = branchContract(branch, root);
        const definition = registry[code]!;
        expect(definition.projection).toBe(isProject ? "project" : "protocol");
        expect(Object.isFrozen(definition)).toBe(true);
        expect(Object.isFrozen(definition.parameter_parser)).toBe(true);
        const before = structuredClone(parameters);
        const parsedParameters = definition.parameter_parser.parse(parameters);
        expect(parameters).toEqual(before);
        const value = { schema_version: "1", code, owner: definition.owner, retryable: definition.retryable, diagnostic: { template_id: code, parameters: parsedParameters }, next_action: definition.action };
        const valueBefore = structuredClone(value);
        expect(validator.validate(value), `${code}:${JSON.stringify(validator.validate.errors)}`).toBe(true);
        expect(isProject ? parseProjectError(value) : parseProtocolError(value)).toBe(value);
        expect(value).toEqual(valueBefore);
        expect(() => definition.parameter_parser.parse({ ...parsedParameters, unsafe_detail: "raw peer data" })).toThrow();
        for (const mutation of [{ ...value, owner: "wrong-owner" }, { ...value, retryable: !value.retryable }, { ...value, next_action: "wrong-action" }, { ...value, diagnostic: { ...value.diagnostic, template_id: "WRONG_CODE" } }]) {
          expect(validator.validate(mutation)).toBe(false);
          expect(() => isProject ? parseProjectError(mutation) : parseProtocolError(mutation)).toThrow();
        }
        exercisedCodes.add(code);
        exercised += 1;
      }
    }
    expect(exercised).toBe(57);
    expect(exercisedCodes).toEqual(new Set([...Object.keys(PROJECT_ERROR_DEFINITIONS), ...Object.keys(PROTOCOL_ERROR_DEFINITIONS)]));
  });

  it("covers every supplemental variant, gate binding, decline shape, and supersession invariant", () => {
    const gate = { prior_gate_id: "gate-1", task_id: "task-1", phase_instance: "phase-impl-2", subject_digest: D("a"), input_fingerprint: D("b") };
    const review = { ...gate, evidence_slot: { role: "gate-counter-review", evidence_digest: D("c"), assurance: "degraded", producer_family: "claude", reviewer_family: "codex", independence: "opposite-family", gate_id: "gate-1" } };
    const cases = [
      { action: "decline", gate, reason: "Declined" },
      { action: "ingest", review, reason: "Ingested" },
      { action: "triage-no-change", review, triage_digest: D("d"), reason: "No change" },
      { action: "supersede", review, accepted_triage_digest: D("d"), old_subject_digest: D("a"), new_subject_digest: D("e"), reason: "Changed" },
    ];
    for (const value of cases) {
      const before = structuredClone(value);
      expect(supplementalValidator.validate(value), JSON.stringify(supplementalValidator.validate.errors)).toBe(true);
      expect(parseSupplementalReviewOutcome(value)).toEqual(value);
      expect(value).toEqual(before);
    }
    const invalid = [
      { ...cases[0], review },
      { ...cases[1], review: { ...review, evidence_slot: { ...review.evidence_slot, gate_id: "gate-2" } } },
      { ...cases[1], review: { ...review, evidence_slot: { ...review.evidence_slot, reviewer_family: "claude" } } },
      { ...cases[3], old_subject_digest: D("f") },
      { ...cases[3], new_subject_digest: D("a") },
    ];
    for (const value of invalid) {
      expect(supplementalValidator.validate(value)).toBe(false);
      expect(() => parseSupplementalReviewOutcome(value)).toThrow();
    }
  });
});

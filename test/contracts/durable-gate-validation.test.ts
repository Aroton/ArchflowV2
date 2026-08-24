import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

import { activeGateV1Schema, gateRequestV1Schema, parseGateRequest } from "../../src/contracts/durable-gate.js";
import { parseGateContext } from "../../src/contracts/gates.js";
import { createJsonSchemaValidator, type JsonSchemaValidator, type ZodLikeSchema } from "../helpers/json-schema.js";

/**
 * Validation of the two gate roots under the Zod authority. `parseGateRequest` and
 * `parseActiveGate` parse through `gateRequestV1Schema` and `activeGateV1Schema`, and the
 * committed schemas are generated from them, with `check:schemas` fencing the bytes. The compiled
 * documents appear only as third-party consumers: they must accept every arm, and they are purely
 * structural — the generated documents carry neither gate-semantics nor the retired byte/NFC/
 * ledger keywords — so every semantic rejection below belongs to the Zod authority alone, and the
 * `validate(...)).toBe(true)` assertions pin that gap.
 */

const SCHEMA_DIR = new URL("../../src/contracts/schemas/v1/", import.meta.url);
const FIXTURE_DIR = new URL("../fixtures/contracts/durable/", import.meta.url);

type JsonObject = Record<string, unknown>;

const clone = <T>(value: T): T => structuredClone(value);

const schema = (stem: string): JsonObject =>
  JSON.parse(readFileSync(new URL(`${stem}.schema.json`, SCHEMA_DIR), "utf8")) as JsonObject;

const fixture = (name: string): JsonObject =>
  JSON.parse(readFileSync(new URL(`${name}.json`, FIXTURE_DIR), "utf8")) as JsonObject;

const GATE_REFERENCE_STEMS = [
  "primitives",
  "path-claim",
  "gate-contract",
  "gate-decision",
  "evidence-slots",
  "gate-request",
  "gate-decision-record",
] as const;

const gateRequestValidator: JsonSchemaValidator<unknown> = createJsonSchemaValidator<unknown>(
  schema("gate-request"),
  GATE_REFERENCE_STEMS.filter((stem) => stem !== "gate-request").map(schema)
);

const activeGateValidator: JsonSchemaValidator<unknown> = createJsonSchemaValidator<unknown>(
  schema("active-gate"),
  GATE_REFERENCE_STEMS.map(schema)
);

const d = (character: string): string => character.repeat(64);
const rule = (id: string, version: number): JsonObject => ({ rule_id: id, rule_version: version });
const approvalTrigger = (subject: "prd" | "design" | "phase-design" | "phase-impl"): JsonObject => ({
  kind: "rule-settlement",
  settlement: { subject_digest: d("c"), config_digest: d("0"), settled_at_revision: 3 },
  conclusion: { wait: true, match: { kind: "subject", subject } },
  rule_authority: "authenticated",
});
const ordinaryPolicy = (subject: "prd" | "design" | "phase-design" | "phase-impl"): JsonObject => ({
  constitution: "pass",
  policy_findings: [],
  eligible_waivers: [],
  approval_trigger: approvalTrigger(subject),
});

const waiverOrigin = (operation: "review-trigger" | "adjudication-failure"): JsonObject => ({
  origin_gate_id: "gate-0",
  origin_decision_digest: d("1"),
  origin_context_digest: d("2"),
  task_id: "task-1",
  phase_instance: "phase-impl-2",
  subject_digest: d("c"),
  current_evidence_set_digest: d("3"),
  rule: rule("rule-a", 1),
  scope: { operation, boundary: "subject" },
});

/** One sample per current `gate-request.schema.json` `oneOf` arm. */
const ARM_SAMPLES: readonly { name: string; kind: string; context: JsonObject; allowed: readonly string[]; waiver: boolean }[] = [
  { name: "artifact-approval", kind: "artifact-approval", context: { artifact_kind: "prd", ...ordinaryPolicy("prd") }, allowed: ["approve", "revise", "reject", "waiver-requested", "cancel"], waiver: false },
  { name: "design-approval", kind: "design-approval", context: { artifact_kind: "design", ...ordinaryPolicy("design"), target_ref: "refs/heads/feature", baseline_commit: "1".repeat(40), commit_message: "ArchFlow: Approve task-1 design" }, allowed: ["approve", "revise", "reject", "waiver-requested", "cancel"], waiver: false },
  { name: "material-drift", kind: "material-drift", context: { affected_upstream: { kind: "prd", digest: d("4") }, drift: "material", affected_claim_ids: ["claim-a", "claim-b"] }, allowed: ["amend-upstream", "revise-current", "reject", "cancel"], waiver: false },
  { name: "attempts-exhausted", kind: "attempts-exhausted", context: { step: "produce", attempts: 3, maximum_attempts: 3 }, allowed: ["retry-once", "revise", "abort", "cancel"], waiver: false },
  { name: "constitution-edit", kind: "constitution-edit", context: { pinned_constitution_digest: d("5"), current_constitution_digest: d("6"), changed_path_class: "task-branch-constitution" }, allowed: ["revert-edit", "start-base-amendment", "abort", "cancel"], waiver: false },
  { name: "commit-authorization", kind: "commit-authorization", context: { ...ordinaryPolicy("phase-impl"), target_ref: "refs/heads/feature", baseline_commit: "1".repeat(40), commit_message: "ArchFlow: Implement task-1 phase 1", paths: ["tracked.txt"], diff_digest: d("7"), current_artifact_digests: [d("8")], parent_document_digests: [d("9")] }, allowed: ["authorize-commit", "revise", "abort", "waiver-requested", "cancel"], waiver: false },
  { name: "restore-collision", kind: "restore-collision", context: { path: "docs/notes.md", recorded_generation_digest: d("a"), current_generation_digest: d("b"), adoption_candidate: { link_digest: d("0"), purpose: "restore-adoption", proposed_generation_digest: d("1"), changed_input_fingerprint: d("2") } }, allowed: ["discard-and-restore", "adopt-as-new-generation", "abort", "cancel"], waiver: false },
  { name: "migration-audit", kind: "migration-audit", context: { source_identity_digest: d("1"), destination_identity_digest: d("2"), import_digest: d("3"), code_baseline_digest: d("4"), policy_baseline_digest: d("5") }, allowed: ["accept-import-audit", "revise", "abort", "cancel"], waiver: false },
  { name: "trigger-axis waiver", kind: "constitution-review", context: { origin: waiverOrigin("review-trigger"), rationale: "Waiver requested for the flagged rule" }, allowed: ["grant", "deny", "cancel"], waiver: true },
  { name: "compliance-axis waiver", kind: "constitution-review", context: { origin: waiverOrigin("adjudication-failure"), rationale: "Waiver requested for the failed rule" }, allowed: ["grant", "deny", "cancel"], waiver: true },
];

const armRequest = (arm: (typeof ARM_SAMPLES)[number]): JsonObject => ({
  ...clone(fixture("gate-request.valid")),
  kind: arm.kind,
  context: clone(arm.context),
  allowed_decisions: [...arm.allowed],
});

const armActiveGate = (arm: (typeof ARM_SAMPLES)[number]): JsonObject => ({
  ...armRequest(arm),
  status: "awaiting-human",
  decision_template: {
    schema_version: "1",
    gate_id: "gate-review-1",
    task_id: "task-1",
    phase_instance: "phase-impl-2",
    kind: arm.kind,
    subject_digest: d("c"),
    context_digest: d("d"),
    required_fields: arm.waiver ? ["granted", "scope", "origin", "notes", "human_provenance"] : ["payload", "human_provenance"],
    cancellation_fields: ["cancelled", "reason", "human_provenance"],
  },
});

type GateRoot = {
  readonly name: string;
  readonly json: JsonSchemaValidator<unknown>;
  readonly zod: ZodLikeSchema<unknown>;
  readonly sample: JsonObject;
};

const ROOTS: readonly GateRoot[] = [
  { name: "gate-request", json: gateRequestValidator, zod: gateRequestV1Schema, sample: fixture("gate-request.valid") },
  { name: "active-gate", json: activeGateValidator, zod: activeGateV1Schema, sample: fixture("active-gate.valid") },
];

const accepts = (target: GateRoot, value: unknown, label: string): void => {
  const result = target.zod.safeParse(value);
  expect(result.success, `${label}: Zod rejected`).toBe(true);
  if (result.success) expect(result.data, `${label}: Zod transformed the value`).toEqual(value);
  expect(target.json.validate(value), `${label}: published schema rejected`).toBe(true);
};

describe("the gate roots validate under the Zod authority", () => {
  for (const entry of ROOTS) {
    it(`accepts the ${entry.name} fixture, and the published schema accepts it too`, () => {
      accepts(entry, entry.sample, entry.name);
    });

    it(`rejects ${entry.name} with an unknown property`, () => {
      const mutated = { ...clone(entry.sample), archflow_unknown_property: "x" };
      expect(entry.zod.safeParse(mutated).success).toBe(false);
    });
  }

  for (const arm of ARM_SAMPLES) {
    it(`accepts the ${arm.name} gate-request arm`, () => {
      accepts(ROOTS[0]!, armRequest(arm), arm.name);
    });

    it(`accepts the ${arm.name} active-gate arm`, () => {
      accepts(ROOTS[1]!, armActiveGate(arm), arm.name);
    });
  }

  it("rejects a kind whose allowed_decisions vocabulary belongs to another arm", () => {
    const mutated = { ...clone(fixture("gate-request.valid")), allowed_decisions: ["authorize-commit", "revise", "abort", "cancel"] };
    expect(gateRequestV1Schema.safeParse(mutated).success).toBe(false);
  });

  it("rejects the retired policy-context constitution review from both fresh writer roots", () => {
    const retired = {
      name: "retired constitution policy gate", kind: "constitution-review",
      context: { constitution: "fail", failed_rules: [rule("rule-a", 1)], uncertain_rules: [], matched_trigger_rules: [], uncertain_trigger_rules: [], eligible_waivers: [{ rule: rule("rule-a", 1), scope: { operation: "adjudication-failure", boundary: "subject" } }] },
      allowed: ["approve", "revise", "reject", "waiver-requested", "cancel"], waiver: false,
    };
    expect(gateRequestV1Schema.safeParse(armRequest(retired)).success).toBe(false);
    expect(activeGateV1Schema.safeParse(armActiveGate(retired)).success).toBe(false);
  });
});

/**
 * Generation retired `x-archflow-nfc` and `x-archflow-max-utf8-bytes` from `path-claim`, the
 * so the compiled validators accept both path violations; the Zod schemas behind
 * `parseGateRequest` and `parseActiveGate` are the surviving authority.
 */
describe("negatives under retired keyword-backed rules are rejected by the Zod authority", () => {
  it("rejects a restore-collision path that is not NFC", () => {
    const sample = fixture("gate-request.invalid-nfd-path");
    expect(gateRequestValidator.validate(sample)).toBe(true);
    expect(gateRequestV1Schema.safeParse(sample).success).toBe(false);
  });

  it("rejects a restore-collision path above 1024 UTF-8 bytes", () => {
    const sample = fixture("gate-request.invalid-nfd-path");
    (sample.context as JsonObject).path = `docs/${"a".repeat(1100)}.md`;
    expect(gateRequestValidator.validate(sample)).toBe(true);
    expect(gateRequestV1Schema.safeParse(sample).success).toBe(false);
  });

});

/**
 * Retired policy-context constitution requests are structurally rejected by the fresh roots. The
 * context parser is tested separately so its gate semantics remain pinned for archived readers;
 * writer rejection must not accidentally erase archive validation.
 */
describe("gate-semantics negatives are rejected by the Zod authority", () => {
  it("rejects an eligible waiver naming a rule the gate never flagged", () => {
    const sample = fixture("gate-request.invalid-ineligible-waiver-rule");
    expect(gateRequestV1Schema.safeParse(sample).success).toBe(false);
    expect(() => parseGateContext("constitution-review", sample.context)).toThrowError(/axis its operation covers/);
    expect(gateRequestValidator.validate(clone(sample))).toBe(false);
  });

  it("rejects matched rules that are unique but not sorted", () => {
    const sample = fixture("gate-request.invalid-unsorted-matched-rules");
    expect(gateRequestV1Schema.safeParse(sample).success).toBe(false);
    expect(() => parseGateContext("constitution-review", sample.context)).toThrowError(/sorted and unique/);
    expect(gateRequestValidator.validate(clone(sample))).toBe(false);
  });

  it("rejects an active constitution-review gate offering a waiver on an axis the rule is not on", () => {
    const sample = fixture("active-gate.invalid-waiver-scope-operation");
    expect(activeGateV1Schema.safeParse(sample).success).toBe(false);
    expect(() => parseGateContext("constitution-review", sample.context)).toThrowError(/axis its operation covers/);
    expect(activeGateValidator.validate(clone(sample))).toBe(false);
  });
});

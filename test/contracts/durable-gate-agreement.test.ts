import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

import { activeGateV1Schema, gateRequestV1Schema, parseGateRequest } from "../../src/contracts/durable-gate.js";
import { parseGateContext } from "../../src/contracts/gates.js";
import {
  activeGateV1Validator,
  assertZodAgreement,
  gateRequestV1Validator,
  type JsonSchemaValidator,
  type ZodLikeSchema,
} from "../../src/contracts/validators.js";

/**
 * Agreement suite for the two gate mirrors in `durable-gate.ts`. The mirrors are now the runtime
 * authority — `parseGateRequest` and `parseActiveGate` parse through them — and the committed
 * schemas are generated from them; this file proves the generated documents and their Zod sources
 * accept and reject the same values across every arm, and that the gate-semantics logic from
 * `gates.ts` is wired into the mirrors.
 *
 * One asymmetry is pinned deliberately: the compiled Ajv validators are purely structural — the
 * generated documents carry neither `x-archflow-gate-semantics` nor the retired byte/NFC/ledger
 * keywords — so every semantic rejection below belongs to the mirrors alone, and the
 * `validate(...)).toBe(true)` assertions pin that gap.
 */

const FIXTURE_DIR = new URL("../fixtures/contracts/durable/", import.meta.url);

type JsonObject = Record<string, unknown>;

const clone = <T>(value: T): T => structuredClone(value);

const fixture = (name: string): JsonObject =>
  JSON.parse(readFileSync(new URL(`${name}.json`, FIXTURE_DIR), "utf8")) as JsonObject;

const d = (character: string): string => character.repeat(64);
const rule = (id: string, version: number): JsonObject => ({ rule_id: id, rule_version: version });

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

/** One sample per `gate-request.schema.json` `oneOf` arm: the nine kinds plus both waiver arms. */
const ARM_SAMPLES: readonly { name: string; kind: string; context: JsonObject; allowed: readonly string[]; waiver: boolean }[] = [
  { name: "artifact-approval", kind: "artifact-approval", context: { artifact_kind: "phase-implementation" }, allowed: ["approve", "revise", "reject", "cancel"], waiver: false },
  { name: "review-trigger", kind: "review-trigger", context: { matched_rules: [rule("rule-a", 1), rule("rule-b", 2)], uncertain_rules: [rule("rule-c", 1)], eligible_waiver_rules: [rule("rule-a", 1)], waiver_scope: { operation: "review-trigger", boundary: "subject" } }, allowed: ["approve", "revise", "reject", "waiver-requested", "cancel"], waiver: false },
  { name: "material-drift", kind: "material-drift", context: { affected_upstream: { kind: "prd", digest: d("4") }, drift: "material", affected_claim_ids: ["claim-a", "claim-b"] }, allowed: ["amend-upstream", "revise-current", "reject", "cancel"], waiver: false },
  { name: "adjudication-failure", kind: "adjudication-failure", context: { constitution: "fail", failed_rules: [rule("rule-a", 1)], uncertain_rules: [], eligible_waiver_rules: [rule("rule-a", 1)], waiver_scope: { operation: "adjudication-failure", boundary: "phase" } }, allowed: ["approve", "revise", "reject", "waiver-requested", "cancel"], waiver: false },
  { name: "attempts-exhausted", kind: "attempts-exhausted", context: { step: "produce", attempts: 3, maximum_attempts: 3 }, allowed: ["retry-once", "revise", "abort", "cancel"], waiver: false },
  { name: "constitution-edit", kind: "constitution-edit", context: { pinned_constitution_digest: d("5"), current_constitution_digest: d("6"), changed_path_class: "task-branch-constitution" }, allowed: ["revert-edit", "start-base-amendment", "abort", "cancel"], waiver: false },
  { name: "commit-authorization", kind: "commit-authorization", context: { target_ref: "refs/heads/feature", diff_digest: d("7"), current_artifact_digests: [d("8")], parent_document_digests: [d("9")] }, allowed: ["authorize-commit", "revise", "abort", "cancel"], waiver: false },
  { name: "restore-collision", kind: "restore-collision", context: { path: "docs/notes.md", recorded_generation_digest: d("a"), current_generation_digest: d("b"), adoption_candidate: { link_digest: d("0"), purpose: "restore-adoption", proposed_generation_digest: d("1"), changed_input_fingerprint: d("2") } }, allowed: ["discard-and-restore", "adopt-as-new-generation", "abort", "cancel"], waiver: false },
  { name: "migration-audit", kind: "migration-audit", context: { source_identity_digest: d("1"), destination_identity_digest: d("2"), import_digest: d("3"), code_baseline_digest: d("4"), policy_baseline_digest: d("5") }, allowed: ["accept-import-audit", "revise", "abort", "cancel"], waiver: false },
  { name: "review-trigger waiver", kind: "review-trigger", context: { origin: waiverOrigin("review-trigger"), rationale: "Waiver requested for the flagged rule" }, allowed: ["grant", "deny", "cancel"], waiver: true },
  { name: "adjudication-failure waiver", kind: "adjudication-failure", context: { origin: waiverOrigin("adjudication-failure"), rationale: "Waiver requested for the failed rule" }, allowed: ["grant", "deny", "cancel"], waiver: true },
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
  supplemental: [],
});

type Mirrored = {
  readonly name: string;
  readonly json: JsonSchemaValidator<unknown>;
  readonly zod: ZodLikeSchema<unknown>;
  readonly sample: JsonObject;
};

const MIRRORED: readonly Mirrored[] = [
  { name: "gate-request", json: gateRequestV1Validator as JsonSchemaValidator<unknown>, zod: gateRequestV1Schema, sample: fixture("gate-request.valid") },
  { name: "active-gate", json: activeGateV1Validator as JsonSchemaValidator<unknown>, zod: activeGateV1Schema, sample: fixture("active-gate.valid") },
];

describe("the gate mirrors agree with their JSON Schema authorities", () => {
  for (const entry of MIRRORED) {
    it(`agrees for the ${entry.name} fixture`, () => {
      expect(assertZodAgreement(entry.sample, entry.json, entry.zod, entry.name)).toEqual(entry.sample);
    });

    it(`agrees for ${entry.name} when an unknown property is added`, () => {
      const mutated = { ...clone(entry.sample), archflow_unknown_property: "x" };
      expect(entry.json.validate(mutated)).toBe(false);
      expect(entry.zod.safeParse(mutated).success).toBe(false);
      expect(() => assertZodAgreement(mutated, entry.json, entry.zod, entry.name)).toThrowError(
        /schema validation failed/
      );
    });
  }

  for (const arm of ARM_SAMPLES) {
    it(`agrees for the ${arm.name} gate-request arm`, () => {
      const sample = armRequest(arm);
      expect(assertZodAgreement(sample, gateRequestV1Validator, gateRequestV1Schema, arm.name)).toEqual(sample);
    });

    it(`agrees for the ${arm.name} active-gate arm`, () => {
      const sample = armActiveGate(arm);
      expect(assertZodAgreement(sample, activeGateV1Validator, activeGateV1Schema, arm.name)).toEqual(sample);
    });
  }

  it("rejects a kind whose allowed_decisions vocabulary belongs to another arm, in both authorities", () => {
    const mutated = { ...clone(fixture("gate-request.valid")), allowed_decisions: ["authorize-commit", "revise", "abort", "cancel"] };
    expect(gateRequestV1Validator.validate(mutated)).toBe(false);
    expect(gateRequestV1Schema.safeParse(mutated).success).toBe(false);
  });
});

/**
 * Generation retired `x-archflow-nfc` and `x-archflow-max-utf8-bytes` from `path-claim`, the
 * supplemental-semantics keyword from `supplemental-review`, and the ledger's structural
 * supersession exclusion, so the compiled validators now accept all four; the mirrors behind
 * `parseGateRequest` and `parseActiveGate` are the surviving authority.
 */
describe("negatives under retired keyword-backed rules are rejected by the Zod authority", () => {
  it("rejects a restore-collision path that is not NFC", () => {
    const sample = fixture("gate-request.invalid-nfd-path");
    expect(gateRequestV1Validator.validate(sample)).toBe(true);
    expect(gateRequestV1Schema.safeParse(sample).success).toBe(false);
  });

  it("rejects a restore-collision path above 1024 UTF-8 bytes", () => {
    const sample = fixture("gate-request.invalid-nfd-path");
    (sample.context as JsonObject).path = `docs/${"a".repeat(1100)}.md`;
    expect(gateRequestV1Validator.validate(sample)).toBe(true);
    expect(gateRequestV1Schema.safeParse(sample).success).toBe(false);
  });

  it("rejects a supplemental slot bound to a different gate", () => {
    const sample = fixture("active-gate.invalid-supplemental-slot-binding");
    expect(activeGateV1Validator.validate(sample)).toBe(true);
    expect(activeGateV1Schema.safeParse(sample).success).toBe(false);
  });

  it("rejects a supersession entry in the supplemental ledger", () => {
    const sample = fixture("active-gate.valid");
    const review = ((sample.supplemental as JsonObject[])[0] as JsonObject).review as JsonObject;
    sample.supplemental = [{
      action: "supersede",
      review,
      accepted_triage_digest: d("8"),
      old_subject_digest: review.subject_digest,
      new_subject_digest: d("9"),
      reason: "Triage accepted a superseding subject",
    }];
    expect(activeGateV1Validator.validate(sample)).toBe(true);
    expect(activeGateV1Schema.safeParse(sample).success).toBe(false);
  });
});

/**
 * The gate-semantics violations. The structural Ajv validators accept these — the two schema roots
 * do not carry `x-archflow-gate-semantics` — so the old rejection authority for a request is
 * `parseGateRequest` (Ajv plus `parseGateContext`), and the mirror must reject on its own. The
 * `validate(...)).toBe(true)` assertions pin that gap: if a later change adds the keyword to the
 * schemas, they should flip to `false` and the mirror agreement can tighten.
 */
describe("gate-semantics negatives are rejected by the mirror and the effective authority", () => {
  it("rejects an eligible waiver rule that neither matched nor is uncertain", () => {
    const sample = fixture("gate-request.invalid-ineligible-waiver-rule");
    expect(gateRequestV1Schema.safeParse(sample).success).toBe(false);
    expect(() => parseGateRequest(clone(sample))).toThrowError(/eligible waiver rule/);
    expect(gateRequestV1Validator.validate(clone(sample))).toBe(true);
  });

  it("rejects matched rules that are unique but not sorted", () => {
    const sample = fixture("gate-request.invalid-unsorted-matched-rules");
    expect(gateRequestV1Schema.safeParse(sample).success).toBe(false);
    expect(() => parseGateRequest(clone(sample))).toThrowError(/sorted and unique/);
    expect(gateRequestV1Validator.validate(clone(sample))).toBe(true);
  });

  it("rejects an active adjudication-failure gate whose waiver scope names the wrong operation", () => {
    const sample = fixture("active-gate.invalid-waiver-scope-operation");
    expect(activeGateV1Schema.safeParse(sample).success).toBe(false);
    expect(() => parseGateContext("adjudication-failure", sample.context)).toThrowError(/waiver operation/);
    expect(activeGateV1Validator.validate(clone(sample))).toBe(true);
  });
});

import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

import { intentReceiptV1Schema } from "../../src/contracts/durable-intent.js";
import {
  assertZodAgreement,
  createJsonSchemaValidator,
  type JsonSchemaValidator,
} from "../../src/contracts/validators.js";

/**
 * `intent-receipt` agreement: the Zod mirror in `durable-intent.ts` against the compiled
 * `intent-receipt.schema.json`, which production validation stays on (`parseIntentReceipt`).
 * The receipt schema carries no `x-archflow-*` keyword of its own; the three
 * `x-archflow-sorted-unique-by` rules it inherits arrive through the `prepared_state` `$ref` to
 * `task-state`, so each is exercised here through a whole receipt — a sample only one side
 * rejects is exactly the drift `assertZodAgreement` exists to catch, and the `$ref` seam is where
 * a composed mirror could drift while both leaf mirrors stay correct.
 */

const SCHEMA_DIR = new URL("../../src/contracts/schemas/v1/", import.meta.url);
const FIXTURE_DIR = new URL("../fixtures/contracts/durable/", import.meta.url);

type JsonObject = Record<string, unknown>;

const schema = (stem: string): JsonObject =>
  JSON.parse(readFileSync(new URL(`${stem}.schema.json`, SCHEMA_DIR), "utf8")) as JsonObject;

const fixture = (name: string): JsonObject =>
  JSON.parse(readFileSync(new URL(`${name}.json`, FIXTURE_DIR), "utf8")) as JsonObject;

const jsonValidator = (): JsonSchemaValidator<unknown> =>
  createJsonSchemaValidator<unknown>(schema("intent-receipt"), [
    schema("primitives"),
    schema("path-claim"),
    schema("task-state"),
  ]);

describe("intent-receipt agreement between JSON Schema and the Zod mirror", () => {
  const json = jsonValidator();
  const sample = fixture("intent-receipt.valid");

  const expectBothReject = (mutated: unknown): void => {
    expect(json.validate(mutated)).toBe(false);
    expect(intentReceiptV1Schema.safeParse(mutated).success).toBe(false);
  };

  it("agrees on the canonical valid fixture", () => {
    expect(assertZodAgreement(sample, json, intentReceiptV1Schema, "intent-receipt")).toEqual(sample);
  });

  it("agrees when an unknown property is added", () => {
    const mutated = { ...sample, archflow_unknown_property: "x" };
    expectBothReject(mutated);
    expect(() => assertZodAgreement(mutated, json, intentReceiptV1Schema, "intent-receipt")).toThrowError(
      /schema validation failed/
    );
  });

  it("both reject an unknown property nested inside prepared_state", () => {
    const mutated = structuredClone(sample);
    (mutated.prepared_state as JsonObject).archflow_unknown_property = "x";
    expectBothReject(mutated);
  });

  it("both reject a missing required field", () => {
    const { prepared_state_digest, ...mutated } = sample;
    void prepared_state_digest;
    expectBothReject(mutated);
  });

  it("both reject the retired tool name — the enum admits exactly the four live tools", () => {
    expectBothReject({ ...sample, tool: "archflow_adjudicate" });
  });

  it("both reject resulting_revision 0 — a receipt's resulting revision is never 0", () => {
    expectBothReject({ ...sample, resulting_revision: 0 });
  });

  it("both accept prior_revision 0 — initialization commits from the synthetic predecessor", () => {
    const mutated = { ...sample, prior_revision: 0 };
    expect(assertZodAgreement(mutated, json, intentReceiptV1Schema, "intent-receipt")).toEqual(mutated);
  });

  /** The plainJson `$def`'s null arm — the one value position where JSON null is data. */
  it("both accept a null outcome, a scalar outcome, and the fixture's nested outcome", () => {
    for (const outcome of [null, "no-op", sample.outcome]) {
      const mutated = { ...sample, outcome };
      expect(assertZodAgreement(mutated, json, intentReceiptV1Schema, "intent-receipt")).toEqual(mutated);
    }
  });

  /**
   * The three `x-archflow-sorted-unique-by` keywords the receipt inherits through the
   * `prepared_state` `$ref`, each exercised by splicing task-state's own negative fixture for that
   * keyword into an otherwise-valid receipt.
   */
  for (const [keyword, stateFixture] of [
    ["authoritative_results sorted by (phase_instance, step)", "task-state.invalid-unsorted-authoritative-results"],
    ["approvals unique by gate_id", "task-state.invalid-duplicate-approval-gate-id"],
    ["waivers unique by gate_id", "task-state.invalid-duplicate-waiver-gate-id"],
  ] as const) {
    it(`both reject a prepared_state violating ${keyword}`, () => {
      expectBothReject({ ...sample, prepared_state: fixture(stateFixture) });
    });
  }
});

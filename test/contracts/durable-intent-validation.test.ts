import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

import { intentReceiptV1Schema } from "../../src/contracts/durable-intent.js";
import { createJsonSchemaValidator, type JsonSchemaValidator } from "../helpers/json-schema.js";

/**
 * `intent-receipt` validation under the Zod authority. `intentReceiptV1Schema` is the runtime
 * authority behind `parseIntentReceipt`, and `intent-receipt.schema.json` is generated from it —
 * `check:schemas` fences the committed bytes, so no agreement loop is run here. The compiled
 * schema appears only as a third-party consumer: it must accept the canonical fixture, and it
 * deliberately accepts the ordering violations below because generation retired the ordering
 * keywords — those rejections belong to the Zod authority alone.
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

describe("intent-receipt validation under the Zod authority", () => {
  const json = jsonValidator();
  const sample = fixture("intent-receipt.valid");

  const accepts = (value: unknown, label: string): void => {
    const result = intentReceiptV1Schema.safeParse(value);
    expect(result.success, `${label}: Zod rejected`).toBe(true);
    if (result.success) expect(result.data, `${label}: Zod transformed the value`).toEqual(value);
  };

  const rejects = (value: unknown, label: string): void => {
    expect(intentReceiptV1Schema.safeParse(value).success, `${label}: Zod accepted`).toBe(false);
  };

  it("accepts the canonical fixture, and the published schema accepts it too", () => {
    accepts(sample, "canonical");
    expect(json.validate(sample)).toBe(true);
  });

  it("rejects an unknown property", () => {
    rejects({ ...sample, archflow_unknown_property: "x" }, "unknown property");
  });

  it("rejects an unknown property nested inside prepared_state", () => {
    const mutated = structuredClone(sample);
    (mutated.prepared_state as JsonObject).archflow_unknown_property = "x";
    rejects(mutated, "nested unknown property");
  });

  it("rejects a missing required field", () => {
    const { prepared_state_digest, ...mutated } = sample;
    void prepared_state_digest;
    rejects(mutated, "missing prepared_state_digest");
  });

  it("rejects the retired tool name — the enum admits exactly the four live tools", () => {
    rejects({ ...sample, tool: "archflow_adjudicate" }, "retired tool");
  });

  it("rejects resulting_revision 0 — a receipt's resulting revision is never 0", () => {
    rejects({ ...sample, resulting_revision: 0 }, "resulting_revision 0");
  });

  it("accepts prior_revision 0 — initialization commits from the synthetic predecessor", () => {
    accepts({ ...sample, prior_revision: 0 }, "prior_revision 0");
  });

  /** The plainJson `$def`'s null arm — the one value position where JSON null is data. */
  it("accepts a null outcome, a scalar outcome, and the fixture's nested outcome", () => {
    for (const outcome of [null, "no-op", sample.outcome]) {
      accepts({ ...sample, outcome }, `outcome ${JSON.stringify(outcome)}`);
    }
  });

  /**
   * The three task-state ordering rules the receipt inherits through the `prepared_state` `$ref`.
   * Generation retired the ordering keywords from the committed schema, so the compiled document
   * accepts these fixtures; the Zod authority behind `parseIntentReceipt` must keep rejecting them.
   */
  for (const [keyword, field, mutation] of [
    ["authoritative_results sorted by (phase_instance, step)", "authoritative_results", "reverse"],
    ["approvals unique by gate_id", "approvals", "duplicate"],
    ["waivers unique by gate_id", "waivers", "duplicate"],
  ] as const) {
    it(`the Zod authority rejects a prepared_state violating ${keyword}`, () => {
      const prepared = structuredClone(sample.prepared_state) as JsonObject;
      const values = prepared[field] as unknown[];
      prepared[field] = mutation === "reverse" ? [...values].reverse() : [...values, values[0]];
      const mutated = { ...sample, prepared_state: prepared };
      expect(json.validate(mutated), "generated schema kept a retired keyword").toBe(true);
      rejects(mutated, keyword);
    });
  }
});

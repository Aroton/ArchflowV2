import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

import { maintenanceRecordV1Schema } from "../../src/contracts/durable-maintenance.js";
import {
  assertZodAgreement,
  createJsonSchemaValidator,
  type JsonSchemaValidator,
} from "../../src/contracts/validators.js";

/**
 * `maintenance-record` agreement: `maintenanceRecordV1Schema` is now the runtime authority —
 * `maintenance-roots.ts` and `local/commands.ts` validate through `parseMaintenanceRecord` — and
 * `maintenance-record.schema.json` is generated from it. The compiled schema is still exercised so
 * the generated document and its Zod source cannot drift structurally; the byte-cap and ordering
 * rules are Zod-only since generation retired the `x-archflow-max-utf8-bytes` and
 * `x-archflow-sorted-unique-by` keywords.
 */

const SCHEMA_DIR = new URL("../../src/contracts/schemas/v1/", import.meta.url);
const FIXTURE_DIR = new URL("../fixtures/contracts/durable/", import.meta.url);

type JsonObject = Record<string, unknown>;

const schema = (stem: string): JsonObject =>
  JSON.parse(readFileSync(new URL(`${stem}.schema.json`, SCHEMA_DIR), "utf8")) as JsonObject;

const fixture = (name: string): JsonObject =>
  JSON.parse(readFileSync(new URL(`${name}.json`, FIXTURE_DIR), "utf8")) as JsonObject;

const jsonValidator = (): JsonSchemaValidator<unknown> =>
  createJsonSchemaValidator<unknown>(schema("maintenance-record"), [schema("primitives"), schema("path-claim")]);

describe("maintenance-record agreement between JSON Schema and the Zod mirror", () => {
  const json = jsonValidator();
  const sample = fixture("maintenance-record.valid");

  it("agrees on the canonical valid fixture", () => {
    expect(assertZodAgreement(sample, json, maintenanceRecordV1Schema, "maintenance-record")).toEqual(sample);
  });

  it("agrees when an unknown property is added", () => {
    const mutated = { ...sample, archflow_unknown_property: "x" };
    expect(json.validate(mutated)).toBe(false);
    expect(maintenanceRecordV1Schema.safeParse(mutated).success).toBe(false);
    expect(() => assertZodAgreement(mutated, json, maintenanceRecordV1Schema, "maintenance-record")).toThrowError(
      /schema validation failed/
    );
  });

  it("agrees when a nested deletion carries an unknown property", () => {
    const mutated = structuredClone(sample);
    (mutated.deletions as JsonObject[])[0]!.archflow_unknown_property = "x";
    expect(json.validate(mutated)).toBe(false);
    expect(maintenanceRecordV1Schema.safeParse(mutated).success).toBe(false);
  });

  /**
   * Generation retired `x-archflow-max-utf8-bytes`, so the compiled document accepts this fixture —
   * 2049 two-byte characters: 4098 UTF-8 bytes in 2049 code units. The Zod `.refine()` behind
   * `parseMaintenanceRecord` counts bytes and is the surviving authority.
   */
  it("the Zod authority rejects a human_reason above 4096 UTF-8 bytes", () => {
    const mutated = fixture("maintenance-record.invalid.human-reason-bytes");
    expect(json.validate(mutated)).toBe(true);
    expect(maintenanceRecordV1Schema.safeParse(mutated).success).toBe(false);
  });

  /** Generation retired `x-archflow-sorted-unique-by: "digest"`; the Zod `.refine()` survives. */
  it("the Zod authority rejects deletions out of digest order", () => {
    const mutated = fixture("maintenance-record.invalid.deletions-unsorted");
    expect(json.validate(mutated)).toBe(true);
    expect(maintenanceRecordV1Schema.safeParse(mutated).success).toBe(false);
  });

  it("the Zod authority rejects a duplicated deletion — strict digest increase subsumes uniqueness", () => {
    const [first] = sample.deletions as readonly unknown[];
    const mutated = { ...sample, deletions: [first, first] };
    expect(json.validate(mutated)).toBe(true);
    expect(maintenanceRecordV1Schema.safeParse(mutated).success).toBe(false);
  });

  it("both reject performed_at_revision of 0 (D8 — there is no revision 0)", () => {
    const mutated = { ...sample, performed_at_revision: 0 };
    expect(json.validate(mutated)).toBe(false);
    expect(maintenanceRecordV1Schema.safeParse(mutated).success).toBe(false);
  });

  it("both accept a zero byte_count and a zero total — those genuinely admit 0", () => {
    const [first] = sample.deletions as readonly JsonObject[];
    const mutated = { ...sample, deletions: [{ ...first!, byte_count: 0 }], total_bytes_deleted: 0 };
    expect(assertZodAgreement(mutated, json, maintenanceRecordV1Schema, "maintenance-record")).toEqual(mutated);
  });

  it("both reject empty deletions — a record that deleted nothing is not a record", () => {
    const mutated = { ...sample, deletions: [] };
    expect(json.validate(mutated)).toBe(false);
    expect(maintenanceRecordV1Schema.safeParse(mutated).success).toBe(false);
  });
});

import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

import { maintenanceRecordV1Schema } from "../../src/contracts/durable-maintenance.js";
import { createJsonSchemaValidator, type JsonSchemaValidator } from "../helpers/json-schema.js";

/**
 * `maintenance-record` validation under the Zod authority. `maintenanceRecordV1Schema` is the
 * runtime authority — `maintenance-roots.ts` and `local/commands.ts` validate through
 * `parseMaintenanceRecord` — and `maintenance-record.schema.json` is generated from it, with
 * `check:schemas` fencing the committed bytes. The compiled schema appears only as a third-party
 * consumer: it must accept the canonical fixture, and it deliberately accepts the byte-cap and
 * ordering violations below because generation retired those keywords — the rejections belong to
 * the Zod authority alone.
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

describe("maintenance-record validation under the Zod authority", () => {
  const json = jsonValidator();
  const sample = fixture("maintenance-record.valid");

  const accepts = (value: unknown, label: string): void => {
    const result = maintenanceRecordV1Schema.safeParse(value);
    expect(result.success, `${label}: Zod rejected`).toBe(true);
    if (result.success) expect(result.data, `${label}: Zod transformed the value`).toEqual(value);
  };

  const rejects = (value: unknown, label: string): void => {
    expect(maintenanceRecordV1Schema.safeParse(value).success, `${label}: Zod accepted`).toBe(false);
  };

  it("accepts the canonical fixture, and the published schema accepts it too", () => {
    accepts(sample, "canonical");
    expect(json.validate(sample)).toBe(true);
  });

  it("rejects an unknown property", () => {
    rejects({ ...sample, archflow_unknown_property: "x" }, "unknown property");
  });

  it("rejects a nested deletion carrying an unknown property", () => {
    const mutated = structuredClone(sample);
    (mutated.deletions as JsonObject[])[0]!.archflow_unknown_property = "x";
    rejects(mutated, "nested unknown property");
  });

  /**
   * Generation retired the byte-cap keyword, so the compiled document accepts this fixture —
   * 2049 two-byte characters: 4098 UTF-8 bytes in 2049 code units. The Zod `.refine()` behind
   * `parseMaintenanceRecord` counts bytes and is the surviving authority.
   */
  it("the Zod authority rejects a human_reason above 4096 UTF-8 bytes", () => {
    const mutated = fixture("maintenance-record.invalid.human-reason-bytes");
    expect(json.validate(mutated), "generated schema kept a retired keyword").toBe(true);
    rejects(mutated, "human_reason bytes");
  });

  /** Generation retired the digest-ordering keyword; the Zod `.refine()` survives. */
  it("the Zod authority rejects deletions out of digest order", () => {
    const mutated = fixture("maintenance-record.invalid.deletions-unsorted");
    expect(json.validate(mutated), "generated schema kept a retired keyword").toBe(true);
    rejects(mutated, "deletions unsorted");
  });

  it("the Zod authority rejects a duplicated deletion — strict digest increase subsumes uniqueness", () => {
    const [first] = sample.deletions as readonly unknown[];
    const mutated = { ...sample, deletions: [first, first] };
    expect(json.validate(mutated), "generated schema kept a retired keyword").toBe(true);
    rejects(mutated, "duplicated deletion");
  });

  it("rejects performed_at_revision of 0 (D8 — there is no revision 0)", () => {
    rejects({ ...sample, performed_at_revision: 0 }, "performed_at_revision 0");
  });

  it("accepts a zero byte_count and a zero total — those genuinely admit 0", () => {
    const [first] = sample.deletions as readonly JsonObject[];
    accepts({ ...sample, deletions: [{ ...first!, byte_count: 0 }], total_bytes_deleted: 0 }, "zero bytes");
  });

  it("rejects empty deletions — a record that deleted nothing is not a record", () => {
    rejects({ ...sample, deletions: [] }, "empty deletions");
  });
});

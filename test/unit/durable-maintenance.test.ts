import { readFile } from "node:fs/promises";

import { describe, expect, it } from "vitest";

import { MAINTENANCE_DELETION_CATEGORIES, maintenanceRecordV1Schema, type MaintenanceRecordV1 } from "../../src/contracts/durable-maintenance.js";
import { createJsonSchemaValidator } from "../../src/contracts/validators.js";

/**
 * Structural coverage for `maintenance-record` against its compiled JSON Schema; the Zod mirror's
 * agreement lives in `test/contracts/durable-maintenance-agreement.test.ts`.
 */
const readJson = async (url: URL): Promise<Record<string, unknown>> =>
  JSON.parse(await readFile(url, "utf8")) as Record<string, unknown>;

const schema = async (name: string): Promise<Record<string, unknown>> =>
  readJson(new URL(`../../src/contracts/schemas/v1/${name}.schema.json`, import.meta.url));

const maintenanceValidator = async () =>
  createJsonSchemaValidator<MaintenanceRecordV1>(await schema("maintenance-record"), [
    await schema("primitives"),
    await schema("path-claim"),
  ]);

const validRecord = async (): Promise<Record<string, unknown>> =>
  readJson(new URL("../fixtures/contracts/durable/maintenance-record.valid.json", import.meta.url));

const rejects = async (mutate: (record: Record<string, unknown>) => Record<string, unknown>): Promise<void> => {
  const validator = await maintenanceValidator();
  expect(validator.validate(mutate(await validRecord()))).toBe(false);
};

/**
 * Rejected by the Zod authority alone: generation retired the ordering keywords from the committed
 * schema, so the compiled document accepts these; the Zod refinement behind the parse function is
 * the surviving authority.
 */
const rejectedByZodAuthority = async (mutate: (record: Record<string, unknown>) => Record<string, unknown>): Promise<void> => {
  const validator = await maintenanceValidator();
  const mutated = mutate(await validRecord());
  expect(validator.validate(mutated)).toBe(true);
  expect(maintenanceRecordV1Schema.safeParse(mutated).success).toBe(false);
};

describe("maintenance record contract", () => {
  it("round-trips the canonical valid fixture through its JSON Schema", async () => {
    const validator = await maintenanceValidator();
    const record = await validRecord();
    expect(validator.validate(record), JSON.stringify(validator.validate.errors)).toBe(true);
  });

  it("keeps the deletion-category tuple identical to its schema enum", async () => {
    const maintenance = await schema("maintenance-record");
    const defs = maintenance.$defs as Record<string, { properties?: Record<string, { enum?: readonly string[] }> }>;
    expect(defs.maintenanceDeletion?.properties?.category?.enum).toEqual([...MAINTENANCE_DELETION_CATEGORIES]);
  });

  it("rejects performed_at_revision of 0 (D8 — SafeInteger admits 0)", async () => {
    await rejects((record) => ({ ...record, performed_at_revision: 0 }));
  });

  it("accepts a zero byte_count and a zero total — those genuinely admit 0 and $ref safeInteger", async () => {
    const validator = await maintenanceValidator();
    const record = await validRecord();
    const [first] = record.deletions as Record<string, unknown>[];
    expect(validator.validate({ ...record, deletions: [{ ...first, byte_count: 0 }], total_bytes_deleted: 0 })).toBe(true);
  });

  it("rejects a shuffled or duplicated deletions set in the Zod authority", async () => {
    await rejectedByZodAuthority((record) => ({ ...record, deletions: [...(record.deletions as unknown[])].reverse() }));
    await rejectedByZodAuthority((record) => {
      const [first] = record.deletions as unknown[];
      return { ...record, deletions: [first, first] };
    });
  });

  it("rejects an empty deletions array — a record that deleted nothing is not a record", async () => {
    await rejects((record) => ({ ...record, deletions: [] }));
  });

  it("rejects an empty human_reason structurally and an over-cap one in the Zod authority", async () => {
    await rejects((record) => ({ ...record, human_reason: "" }));
    await rejectedByZodAuthority((record) => ({ ...record, human_reason: "é".repeat(2049) }));
  });
});

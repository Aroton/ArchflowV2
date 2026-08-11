import { readFile } from "node:fs/promises";

import { describe, expect, it } from "vitest";

import {
  legacyImportInitializationV1Schema,
  parseLegacyImportInitialization,
  type LegacyImportInitializationV1,
} from "../../src/contracts/durable-legacy-import.js";
import { assertZodAgreement, createJsonSchemaValidator } from "../../src/contracts/validators.js";

const schema = async (name: string): Promise<object> =>
  JSON.parse(await readFile(new URL(`../../src/contracts/schemas/v1/${name}.schema.json`, import.meta.url), "utf8")) as object;

/**
 * The schema is not registered in `versions.ts` yet — chunk 13 is that file's sole writer — so the
 * validator is built directly from the reference set. Compiling it also proves the pinned
 * `urn:archflow:schema:v1:durable-primitives#/$defs/canonicalTaskPaths` pointer resolves: Ajv raises
 * `can't resolve reference` at compile time if it does not.
 */
const validator = async () =>
  createJsonSchemaValidator<LegacyImportInitializationV1>(
    await schema("legacy-import-initialization"),
    [await schema("primitives"), await schema("path-claim"), await schema("durable-primitives")]
  );

const fixture = JSON.parse(
  await readFile(new URL("../fixtures/contracts/durable/legacy-import-initialization.valid.json", import.meta.url), "utf8")
) as Record<string, unknown>;

const mapping = fixture.mapping as Record<string, unknown>[];
const stagedPayloadRefs = fixture.staged_payload_refs as Record<string, unknown>[];

/** Rejected structurally by BOTH authorities, never by one alone. */
const rejectedBoth = async (value: unknown): Promise<void> => {
  const jsonValidator = await validator();
  expect(jsonValidator.validate(value)).toBe(false);
  expect(legacyImportInitializationV1Schema.safeParse(value).success).toBe(false);
};

/**
 * Rejected by the Zod authority alone: generation retired the ordering keywords from the committed
 * schema, so the compiled document accepts these; the Zod refinement behind the parse function is
 * the surviving authority.
 */
const rejectedByZodAuthority = async (value: unknown): Promise<void> => {
  const jsonValidator = await validator();
  expect(jsonValidator.validate(value)).toBe(true);
  expect(legacyImportInitializationV1Schema.safeParse(value).success).toBe(false);
};

describe("legacy import initialization contract", () => {
  it("round-trips the canonical valid fixture through the JSON Schema", async () => {
    const jsonValidator = await validator();
    expect(jsonValidator.validate(fixture), JSON.stringify(jsonValidator.validate.errors)).toBe(true);
  });

  it("agrees between the two authorities on the fixture", async () => {
    const jsonValidator = await validator();
    expect(assertZodAgreement(fixture, jsonValidator, legacyImportInitializationV1Schema)).toBe(fixture);
  });

  it("parses the fixture", () => {
    expect(parseLegacyImportInitialization(fixture)).toEqual(fixture);
  });

  it("rejects an approved disposition in both authorities", async () => {
    await rejectedBoth({
      ...fixture,
      mapping: [{ ...mapping[0], disposition: "approved" }, mapping[1]],
    });
  });

  it("rejects shuffled and duplicated mapping in the Zod authority", async () => {
    await rejectedByZodAuthority({ ...fixture, mapping: [...mapping].reverse() });
    await rejectedByZodAuthority({ ...fixture, mapping: [mapping[0], mapping[0]] });
  });

  it("rejects shuffled and duplicated staged_payload_refs in the Zod authority", async () => {
    await rejectedByZodAuthority({ ...fixture, staged_payload_refs: [...stagedPayloadRefs].reverse() });
    await rejectedByZodAuthority({ ...fixture, staged_payload_refs: [stagedPayloadRefs[0], stagedPayloadRefs[0]] });
  });

  it("rejects an unknown field in both authorities", async () => {
    await rejectedBoth({ ...fixture, repin_of: "something" });
  });
});

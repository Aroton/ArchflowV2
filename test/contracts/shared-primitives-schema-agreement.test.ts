import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import { z } from "zod";

import {
  safeCodeV1Schema,
  safeIdV1Schema,
  safeIntegerV1Schema,
  safeVersionV1Schema,
  sha256DigestV1Schema
} from "../../src/contracts/evidence.js";
import { taskPathClaimV1Schema } from "../../src/contracts/path-claims.js";
import { assertZodAgreement, createJsonSchemaValidator } from "../../src/contracts/validators.js";

const schema = async (name: string) => JSON.parse(await readFile(new URL(`../../src/contracts/schemas/v1/${name}.schema.json`, import.meta.url), "utf8")) as object;

describe("normative shared primitive schemas agree with Zod mirrors", () => {
  it.each([
    ["sha256Digest", sha256DigestV1Schema, "0".repeat(64), "A".repeat(64)],
    ["safeId", safeIdV1Schema, "task-1:phase", "-task"],
    ["safeCode", safeCodeV1Schema, "invalid_contract", "INVALID"],
    ["safeVersion", safeVersionV1Schema, "1.2-rc1", "1_2"],
    ["safeInteger", safeIntegerV1Schema, Number.MAX_SAFE_INTEGER, -1]
  ] as const)("agrees for the %s definition", async (definition, zodSchema, valid, invalid) => {
    const primitiveSchema = await schema("primitives") as { $defs: Record<string, object> };
    const validator = createJsonSchemaValidator({
      $schema: "https://json-schema.org/draft/2020-12/schema",
      ...primitiveSchema.$defs[definition]
    });
    expect(assertZodAgreement(valid, validator, zodSchema)).toBe(valid);
    expect(() => assertZodAgreement(invalid, validator, zodSchema)).toThrow();
  });

  it("agrees on lexical structure and exact UTF-8 byte bounds", async () => {
    const validator = createJsonSchemaValidator<string>(await schema("path-claim"));
    for (const valid of ["review.md", "資料/設計.md", "é".repeat(512)]) {
      expect(assertZodAgreement(valid, validator, taskPathClaimV1Schema)).toBe(valid);
    }
    for (const invalid of ["/absolute", "./relative", "x/../escape", "é".repeat(513)]) {
      expect(() => assertZodAgreement(invalid, validator, taskPathClaimV1Schema)).toThrow();
    }
  });

  it("does not mutate values and rejects non-plain inputs before either validator", async () => {
    const validator = createJsonSchemaValidator<string>(await schema("path-claim"));
    const boxed = new String("review.md");
    expect(() => assertZodAgreement(boxed, validator, z.string())).toThrow(/plain prototype/iu);
  });
});

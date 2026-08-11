import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import { z } from "zod";

import {
  pathSafeIdV1Schema,
  safeCodeV1Schema,
  safeIdV1Schema,
  safeIntegerV1Schema,
  safeVersionV1Schema,
  sha256DigestV1Schema,
  taskSlugV1Schema
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
    ["safeInteger", safeIntegerV1Schema, Number.MAX_SAFE_INTEGER, -1],
    ["pathSafeId", pathSafeIdV1Schema, "Intent-1.retry", "task-1:phase"],
    ["taskSlug", taskSlugV1Schema, "mcp-integration", "My_Task"]
  ] as const)("agrees for the %s definition", async (definition, zodSchema, valid, invalid) => {
    const primitiveSchema = await schema("primitives") as { $defs: Record<string, object> };
    const validator = createJsonSchemaValidator({
      $schema: "https://json-schema.org/draft/2020-12/schema",
      ...primitiveSchema.$defs[definition]
    });
    expect(assertZodAgreement(valid, validator, zodSchema)).toBe(valid);
    expect(() => assertZodAgreement(invalid, validator, zodSchema)).toThrow();
  });

  it("agrees on lexical structure in both authorities", async () => {
    const validator = createJsonSchemaValidator<string>(await schema("path-claim"));
    for (const valid of ["review.md", "資料/設計.md", "é".repeat(512)]) {
      expect(assertZodAgreement(valid, validator, taskPathClaimV1Schema)).toBe(valid);
    }
    for (const invalid of [
      "/absolute",
      "./relative",
      "x/../escape",
      "file.txt:stream",
      "a*b",
      "a?b",
      "a[b]",
      "a<b",
      "a>b",
      "a|b",
      "CON",
      "dir/CON.txt",
      "trailing.",
      "trailing ",
    ]) {
      expect(() => assertZodAgreement(invalid, validator, taskPathClaimV1Schema)).toThrow();
    }
  });

  it("enforces the UTF-8 byte bound and NFC form through the Zod authority alone", async () => {
    // x-archflow-max-utf8-bytes and x-archflow-nfc retired with the generated path-claim
    // document (neither is expressible as a pattern), so the compiled JSON Schema accepts both
    // violations while the path-claim refines remain the enforcing authority.
    const validator = createJsonSchemaValidator<string>(await schema("path-claim"));
    const oversized = "é".repeat(513);
    // NFD: "é" as "e" + U+0301.
    const decomposed = "e\u0301.md";
    expect(validator.validate(oversized)).toBe(true);
    expect(validator.validate(decomposed)).toBe(true);
    expect(validator.validate(decomposed.normalize("NFC"))).toBe(true);
    expect(taskPathClaimV1Schema.safeParse(oversized).success).toBe(false);
    expect(taskPathClaimV1Schema.safeParse(decomposed).success).toBe(false);
    expect(taskPathClaimV1Schema.safeParse(decomposed.normalize("NFC")).success).toBe(true);
  });

  it("does not mutate values and rejects non-plain inputs before either validator", async () => {
    const validator = createJsonSchemaValidator<string>(await schema("path-claim"));
    const boxed = new String("review.md");
    expect(() => assertZodAgreement(boxed, validator, z.string())).toThrow(/plain prototype/iu);
  });
});

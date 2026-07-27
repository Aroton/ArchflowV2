import { describe, expect, it } from "vitest";
import { z } from "zod";
import {
  ContractValidationError,
  PlainJsonError,
  assertPlainJson,
  assertZodAgreement,
  createJsonSchemaValidator,
  isPlainJsonValue
} from "../../src/contracts/index.js";

describe("plain JSON preflight", () => {
  it("accepts JSON trees and does not mutate them", () => {
    const shared = { ok: true };
    const value = { text: "héllo", count: 1, nil: null, list: [shared, shared] };
    const before = structuredClone(value);
    assertPlainJson(value, "fixture");
    expect(value).toEqual(before);
    expect(isPlainJsonValue(value)).toBe(true);
  });

  it.each([
    ["undefined", { value: undefined }],
    ["function", { value: () => undefined }],
    ["bigint", { value: 1n }],
    ["symbol", { value: Symbol("no") }],
    ["NaN", { value: Number.NaN }],
    ["infinity", { value: Number.POSITIVE_INFINITY }],
    ["date", new Date(0)],
    ["map", new Map()],
    ["sparse array", Array(2)]
  ])("rejects %s values", (_name, value) => {
    expect(() => assertPlainJson(value)).toThrow(PlainJsonError);
  });

  it("rejects cycles while allowing repeated non-cyclic references", () => {
    const cyclic: { self?: unknown } = {};
    cyclic.self = cyclic;
    expect(() => assertPlainJson(cyclic)).toThrow(/cyclic/iu);
    const leaf = { value: 1 };
    expect(() => assertPlainJson([leaf, leaf])).not.toThrow();
  });

  it("rejects inherited, accessor, symbol, and dangerous own properties", () => {
    expect(() => assertPlainJson(Object.create({ inherited: true }))).toThrow(/plain prototype/iu);

    const accessor = {};
    Object.defineProperty(accessor, "value", { enumerable: true, get: () => 1 });
    expect(() => assertPlainJson(accessor)).toThrow(/accessor/iu);

    const symbolKey = { [Symbol("hidden")]: true };
    expect(() => assertPlainJson(symbolKey)).toThrow(/symbol/iu);

    for (const key of ["__proto__", "prototype", "constructor"]) {
      const dangerous = {};
      Object.defineProperty(dangerous, key, { value: true, enumerable: true });
      expect(() => assertPlainJson(dangerous), key).toThrow(/dangerous own key/iu);
    }
  });
});

describe("strict validator infrastructure", () => {
  const jsonSchema = {
    type: "object",
    properties: { email: { type: "string", format: "email" } },
    required: ["email"],
    additionalProperties: false
  } as const;
  const validator = createJsonSchemaValidator<{ readonly email: string }>(jsonSchema);
  const zodSchema = z.strictObject({ email: z.email() });

  it("enforces formats and closed objects without changing the input", () => {
    const value = { email: "person@example.com" };
    const before = structuredClone(value);
    validator.assert(value);
    expect(assertZodAgreement(value, validator, zodSchema)).toBe(value);
    expect(value).toEqual(before);
    expect(() => validator.assert({ email: "not-an-email" })).toThrow(ContractValidationError);
    expect(() => validator.assert({ email: "person@example.com", extra: true })).toThrow(ContractValidationError);
  });

  it("reports contradictory Zod and JSON Schema acceptance", () => {
    const disagreeing = z.strictObject({ email: z.literal("different@example.com") });
    expect(() => assertZodAgreement({ email: "person@example.com" }, validator, disagreeing)).toThrow(/disagree/iu);
  });

  it("runs plain-JSON preflight before schema validation", () => {
    const inherited = Object.create({ email: "person@example.com" }) as unknown;
    expect(() => validator.assert(inherited)).toThrow(PlainJsonError);
  });
});

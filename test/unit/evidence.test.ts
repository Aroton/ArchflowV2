import { describe, expect, expectTypeOf, it } from "vitest";

import {
  parseSafeCode,
  parseSafeInteger,
  safeIdV1Schema,
  safeVersionV1Schema,
  sha256DigestV1Schema,
  type SafeCode,
  type SafeInteger,
  type Sha256Digest
} from "../../src/contracts/evidence.js";

describe("shared evidence primitives", () => {
  it("accepts only canonical lowercase SHA-256 syntax", () => {
    const digest = "0123456789abcdef".repeat(4);
    expect(sha256DigestV1Schema.parse(digest)).toBe(digest);
    for (const invalid of [
      digest.toUpperCase(),
      `sha256:${digest}`,
      ` ${digest}`,
      `${digest} `,
      digest.slice(1),
      `${digest}0`,
      "０".repeat(64)
    ]) expect(() => sha256DigestV1Schema.parse(invalid)).toThrow();
  });

  it("enforces the bounded identifier, code, version, and integer vocabularies", () => {
    expect(safeIdV1Schema.parse(`a${"-".repeat(127)}`)).toHaveLength(128);
    expect(parseSafeCode(`a${"_".repeat(63)}`)).toHaveLength(64);
    expect(safeVersionV1Schema.parse(`1${".".repeat(63)}`)).toHaveLength(64);
    expect(parseSafeInteger(Number.MAX_SAFE_INTEGER)).toBe(Number.MAX_SAFE_INTEGER);

    for (const invalid of ["", "-leading", `a${".".repeat(128)}`, "é"]) expect(() => safeIdV1Schema.parse(invalid)).toThrow();
    for (const invalid of ["", "UPPER", "-leading", `a${"_".repeat(64)}`]) expect(() => parseSafeCode(invalid)).toThrow();
    for (const invalid of ["", "v_1", `1${".".repeat(64)}`, "é"]) expect(() => safeVersionV1Schema.parse(invalid)).toThrow();
    for (const invalid of [-1, 1.5, Number.MAX_SAFE_INTEGER + 1, "1"]) expect(() => parseSafeInteger(invalid)).toThrow();
  });

  it("keeps identities opaque at compile time", () => {
    expectTypeOf<Sha256Digest>().toMatchTypeOf<string>();
    expectTypeOf<SafeCode>().toMatchTypeOf<string>();
    expectTypeOf<SafeInteger>().toMatchTypeOf<number>();
    // @ts-expect-error unparsed strings cannot mint a digest brand
    const untrustedDigest: Sha256Digest = "0".repeat(64);
    // @ts-expect-error a plain string cannot mint a safe code
    const untrustedCode: SafeCode = "invalid_contract";
    expect(untrustedCode).toBe("invalid_contract");
    expect(untrustedDigest).toHaveLength(64);
  });

  it("runs recursive plain-JSON preflight before primitive parsing", () => {
    expect(() => parseSafeCode(new String("invalid_contract"))).toThrow(/plain prototype/iu);
  });
});

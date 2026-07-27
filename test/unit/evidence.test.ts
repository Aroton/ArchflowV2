import { describe, expect, expectTypeOf, it } from "vitest";

import {
  parseSafeCode,
  parseSafeId,
  parseSafeInteger,
  parseSafeVersion,
  parseSha256Digest,
  type ReferencedEvidence,
  type SafeCode,
  type SafeId,
  type SafeInteger,
  type SafeVersion,
  type Sha256Digest
} from "../../src/contracts/index.js";

describe("shared evidence primitives", () => {
  it("accepts only canonical lowercase SHA-256 syntax", () => {
    const digest = "0123456789abcdef".repeat(4);
    expect(parseSha256Digest(digest)).toBe(digest);
    for (const invalid of [
      digest.toUpperCase(),
      `sha256:${digest}`,
      ` ${digest}`,
      `${digest} `,
      digest.slice(1),
      `${digest}0`,
      "０".repeat(64)
    ]) expect(() => parseSha256Digest(invalid)).toThrow();
  });

  it("enforces the bounded identifier, code, version, and integer vocabularies", () => {
    expect(parseSafeId(`a${"-".repeat(127)}`)).toHaveLength(128);
    expect(parseSafeCode(`a${"_".repeat(63)}`)).toHaveLength(64);
    expect(parseSafeVersion(`1${".".repeat(63)}`)).toHaveLength(64);
    expect(parseSafeInteger(Number.MAX_SAFE_INTEGER)).toBe(Number.MAX_SAFE_INTEGER);

    for (const invalid of ["", "-leading", `a${".".repeat(128)}`, "é"]) expect(() => parseSafeId(invalid)).toThrow();
    for (const invalid of ["", "UPPER", "-leading", `a${"_".repeat(64)}`]) expect(() => parseSafeCode(invalid)).toThrow();
    for (const invalid of ["", "v_1", `1${".".repeat(64)}`, "é"]) expect(() => parseSafeVersion(invalid)).toThrow();
    for (const invalid of [-1, 1.5, Number.MAX_SAFE_INTEGER + 1, "1"]) expect(() => parseSafeInteger(invalid)).toThrow();
  });

  it("keeps identities and evidence references opaque at compile time", () => {
    expectTypeOf<Sha256Digest>().toMatchTypeOf<string>();
    expectTypeOf<SafeId>().toMatchTypeOf<string>();
    expectTypeOf<SafeCode>().toMatchTypeOf<string>();
    expectTypeOf<SafeVersion>().toMatchTypeOf<string>();
    expectTypeOf<SafeInteger>().toMatchTypeOf<number>();
    // @ts-expect-error unparsed strings cannot mint a digest brand
    const untrustedDigest: Sha256Digest = "0".repeat(64);
    const reference: ReferencedEvidence<{ readonly value: string }> = {
      evidence_digest: parseSha256Digest("0".repeat(64)),
      evidence: { value: "payload" }
    };
    expect(reference.evidence.value).toBe("payload");
    expect(untrustedDigest).toHaveLength(64);
  });

  it("runs recursive plain-JSON preflight before primitive parsing", () => {
    expect(() => parseSha256Digest(new String("0".repeat(64)))).toThrow(/plain prototype/iu);
  });
});

import { describe, expect, it } from "vitest";

import {
  assertPortablePath as assertPortablePathJs,
  canonicalJsonBytes as canonicalJsonBytesJs,
  sha256 as sha256Js
} from "../../scripts/release-support.mjs";
import {
  canonicalJsonBytes,
  parseTaskPathClaim,
  sha256Bytes,
  type PlainJsonValue
} from "../../src/contracts/index.js";

/**
 * `scripts/release-support.mjs` is plain JavaScript that TypeScript cannot import, so Phase 6
 * re-derives its canonical primitives in `src/contracts/canonical.ts`. The duplication is
 * deliberate; this suite is what keeps the two copies from drifting.
 *
 * Only the two importable primitives are covered here. The containment predicate is the third
 * duplicated primitive, but release-support's `isInside` is module-private, so its parity is
 * asserted behaviourally in `test/unit/repository-paths.test.ts` against `src/repository/paths.ts`
 * — including the one recorded divergence, that `isInside` requires `rel !== ""` and so rejects the
 * root itself while Phase 6 containment accepts `rel === ""`.
 */

const CORPUS: ReadonlyArray<readonly [string, PlainJsonValue]> = [
  ["ordinal-vs-locale key order", { b: 1, A: 2, _x: 3, a: 4, B: 5, "0": 6, "-": 7 }],
  ["nested ordinal key order", { z: { d: 1, c: { B: 1, a: 2, Z: 3 } }, y: { "": 0 } }],
  ["semantic array order", { items: ["c", "a", "b"], numbers: [3, 1, 2] }],
  ["arrays of objects", [{ b: 1, a: 2 }, { d: 3, c: 4 }]],
  ["empty containers", { object: {}, array: [], nested: [{}, []] }],
  ["deep nesting", { a: { b: { c: { d: { e: { f: { g: [{ h: 1 }] } } } } } } }],
  ["non-ASCII strings", { "キー": "値 – ü 🌍", "é": "\u00e9 vs e\u0301" }],
  ["escaped strings", { quote: '"', backslash: "\\", newline: "a\nb", tab: "a\tb", control: "\u0001" }],
  ["boundary numbers", {
    max: Number.MAX_SAFE_INTEGER,
    min: Number.MIN_SAFE_INTEGER,
    zero: 0,
    negativeZero: -0,
    tiny: 5e-324,
    huge: 1e21,
    fraction: 0.1,
    negative: -1
  }],
  ["primitives", [null, true, false, "", 0]],
  ["scalar root", "just a string"],
  ["array root", [1, 2, 3]],
  ["null root", null]
];

describe("canonicalJsonBytes parity with scripts/release-support.mjs", () => {
  it.each(CORPUS)("renders identical bytes for %s", (_label, value) => {
    const typescript = canonicalJsonBytes(value);
    const javascript = canonicalJsonBytesJs(value);

    expect(Buffer.from(typescript).equals(Buffer.from(javascript))).toBe(true);
    expect(sha256Bytes(typescript)).toBe(sha256Js(javascript));
  });

  it("rejects undefined and non-finite numbers on both sides", () => {
    for (const value of [{ a: undefined }, { a: Number.NaN }, { a: Number.POSITIVE_INFINITY }]) {
      expect(() => canonicalJsonBytes(value as unknown as PlainJsonValue)).toThrow();
      expect(() => canonicalJsonBytesJs(value)).toThrow();
    }
  });
});

/**
 * `assertPortablePath` and `parseTaskPathClaim` are the same lexical predicate in two languages:
 * relative, forward-slash, no drive or UNC prefix, no empty/`.`/`..` segment.
 */
const PORTABLE_PATHS = [
  "manifest.json",
  "legal/review.json",
  "a/b/c/d.txt",
  "資料/設計.md",
  "dotted.name/with.dots.json",
  "-leading-dash",
  ".hidden/file"
] as const;

const UNPORTABLE_PATHS = [
  "",
  "/absolute",
  "//server/share",
  "C:/drive/path",
  "c:relative-drive",
  "back\\slash",
  "double//slash",
  ".",
  "..",
  "./child",
  "../child",
  "child/.",
  "child/..",
  "child/../escape",
  "trailing/"
] as const;

const verdict = (run: () => unknown): "accept" | "reject" => {
  try {
    run();
    return "accept";
  } catch {
    return "reject";
  }
};

describe("portable path parity with scripts/release-support.mjs", () => {
  it.each(PORTABLE_PATHS)("both accept %s", (value) => {
    expect(verdict(() => assertPortablePathJs(value))).toBe("accept");
    expect(verdict(() => parseTaskPathClaim(value))).toBe("accept");
  });

  it.each(UNPORTABLE_PATHS)("both reject %s", (value) => {
    expect(verdict(() => assertPortablePathJs(value))).toBe("reject");
    expect(verdict(() => parseTaskPathClaim(value))).toBe("reject");
  });

  // Two rules exist only on the contract side, and the asymmetry is intentional rather than drift:
  // a release payload path is generated, while a task path claim is caller-supplied.
  it.each([["control\u0000byte"], ["control\u007fbyte"], ["a".repeat(1025)]])(
    "the contract schema is deliberately stricter for %s",
    (value) => {
      expect(verdict(() => assertPortablePathJs(value))).toBe("accept");
      expect(verdict(() => parseTaskPathClaim(value))).toBe("reject");
    }
  );
});

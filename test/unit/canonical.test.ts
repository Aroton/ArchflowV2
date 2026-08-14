import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";

import { describe, expect, it } from "vitest";

import {
  GIT_TREE_MODES,
  canonicalDocument,
  canonicalJsonBytes,
  canonicalJsonDigest,
  gitBlobOid,
  historyIdentityDigest,
  normalizeGitTreeMode,
  parseCanonicalDocument,
  parseGitOid,
  parseGitTreeMode,
  repositoryCandidateDigest,
  sha256Bytes,
  type GitOid,
  type PlainJsonValue
} from "../../src/contracts/index.js";

const encoder = new TextEncoder();
const decoder = new TextDecoder("utf-8");

const bytes = (text: string): Uint8Array => encoder.encode(text);
const text = (value: Uint8Array): string => decoder.decode(value);

const gitAvailable = ((): boolean => {
  try {
    execFileSync("git", ["--version"], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
})();

describe("canonicalJsonBytes", () => {
  it("sorts object keys by ordinal comparison, not locale comparison", () => {
    const rendered = text(canonicalJsonBytes({ b: 1, A: 2, _x: 3, a: 4, B: 5 }));
    const keys = [...rendered.matchAll(/"([^"]+)":/gu)].map((match) => match[1]);

    expect(keys).toEqual(["A", "B", "_x", "a", "b"]);
    expect(keys).not.toEqual([...keys].sort((left, right) => String(left).localeCompare(String(right))));
  });

  it("sorts keys recursively at every depth", () => {
    const rendered = text(canonicalJsonBytes({ z: { d: 1, c: { b: 1, a: 2 } }, y: [{ n: 1, m: 2 }] }));

    expect(rendered).toBe(
      [
        "{",
        '  "y": [',
        "    {",
        '      "m": 2,',
        '      "n": 1',
        "    }",
        "  ],",
        '  "z": {',
        '    "c": {',
        '      "a": 2,',
        '      "b": 1',
        "    },",
        '    "d": 1',
        "  }",
        "}",
        ""
      ].join("\n")
    );
  });

  it("preserves array order, which is semantic", () => {
    const forward = text(canonicalJsonBytes({ items: ["c", "a", "b"] }));
    const reversed = text(canonicalJsonBytes({ items: ["b", "a", "c"] }));

    expect(forward).toContain('"c",\n    "a",\n    "b"');
    expect(forward).not.toBe(reversed);
  });

  it("renders empty objects and arrays", () => {
    expect(text(canonicalJsonBytes({ a: {}, b: [] }))).toBe('{\n  "a": {},\n  "b": []\n}\n');
  });

  it("renders deeply nested values", () => {
    let nested: PlainJsonValue = 0;
    for (let depth = 0; depth < 40; depth += 1) nested = { level: nested };

    const rendered = text(canonicalJsonBytes(nested));
    expect(rendered.split("level").length - 1).toBe(40);
    expect(parseCanonicalDocument(canonicalJsonBytes(nested)).value).toEqual(nested);
  });

  it("emits non-ASCII strings as raw UTF-8", () => {
    const value = { "キー": "値 – ü 🌍" };
    const rendered = canonicalJsonBytes(value);

    expect(text(rendered)).toBe('{\n  "キー": "値 – ü 🌍"\n}\n');
    expect(rendered.byteLength).toBeGreaterThan(text(rendered).length);
  });

  it("renders boundary numbers exactly as JSON.stringify does", () => {
    const value = {
      max: Number.MAX_SAFE_INTEGER,
      min: Number.MIN_SAFE_INTEGER,
      zero: 0,
      negativeZero: -0,
      tiny: 5e-324,
      huge: 1e21,
      fraction: 0.1
    };

    expect(text(canonicalJsonBytes(value))).toBe(
      [
        "{",
        '  "fraction": 0.1,',
        '  "huge": 1e+21,',
        '  "max": 9007199254740991,',
        '  "min": -9007199254740991,',
        '  "negativeZero": 0,',
        '  "tiny": 5e-324,',
        '  "zero": 0',
        "}",
        ""
      ].join("\n")
    );
  });

  it("uses a 2-space indent and exactly one trailing newline", () => {
    const rendered = text(canonicalJsonBytes({ a: { b: 1 } }));

    expect(rendered).toContain('\n  "a"');
    expect(rendered).toContain('\n    "b"');
    expect(rendered.endsWith("}\n")).toBe(true);
    expect(rendered.endsWith("}\n\n")).toBe(false);
  });

  it("rejects undefined and non-finite numbers", () => {
    expect(() => canonicalJsonBytes({ a: undefined } as unknown as PlainJsonValue)).toThrow(/undefined/u);
    expect(() => canonicalJsonBytes([undefined] as unknown as PlainJsonValue)).toThrow(/undefined/u);
    expect(() => canonicalJsonBytes({ a: Number.NaN } as unknown as PlainJsonValue)).toThrow(/non-finite/u);
    expect(() => canonicalJsonBytes({ a: Number.POSITIVE_INFINITY } as unknown as PlainJsonValue)).toThrow(/non-finite/u);
    expect(() => canonicalJsonBytes({ deep: { a: Number.NEGATIVE_INFINITY } } as unknown as PlainJsonValue)).toThrow(/non-finite/u);
  });

  it("agrees with canonicalJsonDigest and canonicalDocument", () => {
    const value = { b: 1, a: [2, 1] };
    const document = canonicalDocument(value);

    expect(document.bytes).toEqual(canonicalJsonBytes(value));
    expect(document.digest).toBe(canonicalJsonDigest(value));
    expect(document.digest).toBe(sha256Bytes(canonicalJsonBytes(value)));
    expect(document.value).toBe(value);
  });
});

describe("parseCanonicalDocument", () => {
  it("accepts a canonical document and digests the original bytes", () => {
    const input = canonicalJsonBytes({ b: 1, a: { d: [1, 2], c: "ü" } });
    const document = parseCanonicalDocument<{ a: { c: string; d: number[] }; b: number }>(input);

    expect(document.bytes).toBe(input);
    expect(document.value).toEqual({ a: { c: "ü", d: [1, 2] }, b: 1 });
    expect(document.digest).toBe(sha256Bytes(input));
  });

  it("rejects malformed UTF-8 before parsing", () => {
    // {"a":"<0xc3>"} — a truncated two-byte sequence.
    const input = new Uint8Array([0x7b, 0x22, 0x61, 0x22, 0x3a, 0x22, 0xc3, 0x22, 0x7d, 0x0a]);

    expect(() => parseCanonicalDocument(input)).toThrow(/not valid UTF-8/u);
  });

  it("rejects input that is not JSON at all", () => {
    expect(() => parseCanonicalDocument(bytes("not json\n"))).toThrow(/not valid JSON/u);
  });

  it("rejects duplicate keys, because the re-render is shorter", () => {
    expect(() => parseCanonicalDocument(bytes('{\n  "a": 1,\n  "a": 2\n}\n'))).toThrow(/not canonical JSON/u);
  });

  it("rejects permuted key order", () => {
    expect(() => parseCanonicalDocument(bytes('{\n  "b": 1,\n  "a": 2\n}\n'))).toThrow(/not canonical JSON/u);
  });

  it("rejects a four-space indent", () => {
    expect(() => parseCanonicalDocument(bytes('{\n    "a": 1\n}\n'))).toThrow(/not canonical JSON/u);
  });

  it("rejects compact rendering with no indent", () => {
    expect(() => parseCanonicalDocument(bytes('{"a":1}\n'))).toThrow(/not canonical JSON/u);
  });

  it("rejects a missing trailing newline", () => {
    expect(() => parseCanonicalDocument(bytes('{\n  "a": 1\n}'))).toThrow(/not canonical JSON/u);
  });

  it("rejects an extra trailing newline", () => {
    expect(() => parseCanonicalDocument(bytes('{\n  "a": 1\n}\n\n'))).toThrow(/not canonical JSON/u);
  });

  it("rejects dangerous own keys through assertPlainJson", () => {
    expect(() => parseCanonicalDocument(bytes('{\n  "constructor": 1\n}\n'))).toThrow(/constructor/u);
  });

  it("rejects a non-byte argument", () => {
    expect(() => parseCanonicalDocument("{}\n" as unknown as Uint8Array)).toThrow(/must be bytes/u);
  });
});

describe("gitBlobOid", () => {
  // Expected values produced by `git hash-object --stdin` (git 2.43.0) and pinned so the suite
  // needs no git; the final case re-proves agreement against a real git when one is present.
  const cases: ReadonlyArray<readonly [string, Uint8Array, string]> = [
    ["empty content", new Uint8Array(0), "e69de29bb2d1d6434b8b29ae775ad8c2e48c5391"],
    ["hello with trailing newline", bytes("hello\n"), "ce013625030ba8dba906f756967f9e9ca394464a"],
    ["content without a trailing newline", bytes("no trailing newline"), "69db55d99f68896760e56c209fbd5823dae98e66"],
    ["CRLF content", bytes("line1\r\nline2\r\n"), "8561d5d6dca37a4e5d7a60b130242f748fcfec84"],
    ["binary content containing NUL", new Uint8Array([0x00, 0x01, 0x02, 0xff, 0x00]), "d652de3d01104727430d9598afb3f238a20a5ee8"],
    ["content over 1 MiB", new Uint8Array(1024 * 1024 + 1).fill(0x61), "2cbbea0a2701ec1725ae740a1e113d9661d453ed"]
  ];

  it.each(cases)("matches git for %s", (_label, content, expected) => {
    expect(gitBlobOid(content)).toBe(expected);
  });

  it("computes the documented header formula", () => {
    expect(gitBlobOid(bytes("hello\n"))).toBe(sha1Hex(bytes("blob 6\0hello\n")));
  });

  it.skipIf(!gitAvailable)("agrees with a real `git hash-object --stdin`", () => {
    for (const [, content, expected] of cases) {
      const observed = execFileSync("git", ["hash-object", "--stdin"], { input: Buffer.from(content) })
        .toString()
        .trim();
      expect(observed).toBe(expected);
      expect(gitBlobOid(content)).toBe(observed);
    }
  });
});

function sha1Hex(input: Uint8Array): string {
  // Local, deliberately independent of the implementation under test.
  return createHash("sha1").update(input).digest("hex");
}

describe("git object names and tree modes", () => {
  it("parses a lowercase 40-hex object name", () => {
    expect(parseGitOid("ce013625030ba8dba906f756967f9e9ca394464a")).toBe("ce013625030ba8dba906f756967f9e9ca394464a");
  });

  it.each([
    "CE013625030BA8DBA906F756967F9E9CA394464A",
    "ce013625030ba8dba906f756967f9e9ca394464",
    "ce013625030ba8dba906f756967f9e9ca394464az",
    "",
    42
  ])("rejects %s as an object name", (value) => {
    expect(() => parseGitOid(value)).toThrow();
  });

  it.each(GIT_TREE_MODES)("parses tree mode %s", (mode) => {
    expect(parseGitTreeMode(mode)).toBe(mode);
  });

  it("normalises the raw-tree 40000 form to 040000", () => {
    expect(normalizeGitTreeMode("40000")).toBe("040000");
  });

  it.each(GIT_TREE_MODES)("leaves the displayed mode %s unchanged", (mode) => {
    expect(normalizeGitTreeMode(mode)).toBe(mode);
  });

  it.each(["644", "100664", "0100644", ""])("rejects %s as a tree mode", (mode) => {
    expect(() => normalizeGitTreeMode(mode)).toThrow();
  });
});

describe("shared error digest helpers", () => {
  const oid = parseGitOid("ce013625030ba8dba906f756967f9e9ca394464a");
  const otherOid = parseGitOid("e69de29bb2d1d6434b8b29ae775ad8c2e48c5391");

  it("is deterministic and digest-shaped", () => {
    expect(historyIdentityDigest(oid)).toBe(historyIdentityDigest(oid));
    expect(historyIdentityDigest(oid)).toMatch(/^[0-9a-f]{64}$/u);
    expect(repositoryCandidateDigest("/srv/repo")).toBe(repositoryCandidateDigest("/srv/repo"));
    expect(repositoryCandidateDigest("/srv/repo")).toMatch(/^[0-9a-f]{64}$/u);
  });

  it("separates distinct subjects and the two domains", () => {
    expect(historyIdentityDigest(oid)).not.toBe(historyIdentityDigest(otherOid));
    expect(repositoryCandidateDigest("/srv/repo")).not.toBe(repositoryCandidateDigest("/srv/other"));
    expect(repositoryCandidateDigest(oid as string)).not.toBe(historyIdentityDigest(oid as GitOid));
  });
});

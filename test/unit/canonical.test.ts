import { describe, expect, it } from "vitest";

import {
  canonicalJsonBytes,
  canonicalJsonDigest,
  parseGitOid,
  repositoryCandidateDigest,
  sha256Bytes,
} from "../../src/contracts/canonical.js";
import { type PlainJsonValue } from "../../src/contracts/plain-json.js";

const decoder = new TextDecoder("utf-8");

const text = (value: Uint8Array): string => decoder.decode(value);

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
    expect(JSON.parse(rendered)).toEqual(nested);
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

  it("agrees with canonicalJsonDigest", () => {
    const value = { b: 1, a: [2, 1] };
    expect(canonicalJsonDigest(value)).toBe(sha256Bytes(canonicalJsonBytes(value)));
  });
});

describe("git object names", () => {
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
});

describe("repository candidate digest", () => {
  it("is deterministic and digest-shaped", () => {
    expect(repositoryCandidateDigest("/srv/repo")).toBe(repositoryCandidateDigest("/srv/repo"));
    expect(repositoryCandidateDigest("/srv/repo")).toMatch(/^[0-9a-f]{64}$/u);
  });

  it("separates distinct subjects", () => {
    expect(repositoryCandidateDigest("/srv/repo")).not.toBe(repositoryCandidateDigest("/srv/other"));
  });
});

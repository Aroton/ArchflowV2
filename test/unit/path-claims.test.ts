import { describe, expect, expectTypeOf, it } from "vitest";

import { parseRepositoryPathClaim, type RepositoryPathClaim } from "../../src/contracts/path-claims.js";

const UNSAFE_CLAIMS = [
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
  "control\u0000byte",
  "line\nbreak",
  // Colons: drive-relative paths and NTFS alternate data streams in one rule.
  "file.txt:stream",
  "dir/a:b",
  // Windows-illegal wildcard characters.
  "a*b",
  "a?b",
  // Remaining Windows-illegal characters.
  "a<b",
  "a>b",
  "a|b",
  // Reserved device names, with or without an extension, in any segment and any case.
  "CON",
  "con",
  "CON.txt",
  "dir/NUL.json",
  "com1",
  "LPT9.md",
  // Win32 strips trailing dots and spaces, so these alias a different file.
  "a.",
  "a ",
  "dir./file.md",
  "dir /file.md",
  // Already-decomposed text: NFC is required, never applied.
  "e\u0301.md",
  "dir/re\u0301sume\u0301"
] as const;

describe("lexical path claims", () => {
  it.each([
    "artifact.md",
    "reviews/phase-2.md",
    ".archflow/constitution/default/00-rule.md",
    "資料/設計.md",
    "CONFIG.md",
    "console/log.txt",
    "COM0"
  ])("accepts bounded slash-separated lexical claim %s", (value) => {
    expect(parseRepositoryPathClaim(value)).toBe(value);
  });

  it.each(UNSAFE_CLAIMS)("rejects unsafe lexical alias %s", (value) => {
    expect(() => parseRepositoryPathClaim(value)).toThrow();
  });

  it("bounds UTF-8 bytes rather than JavaScript string length", () => {
    expect(parseRepositoryPathClaim("é".repeat(512))).toHaveLength(512);
    expect(() => parseRepositoryPathClaim("é".repeat(513))).toThrow(/1024 UTF-8 bytes/iu);
  });
});

describe("repository path claims", () => {
  it.each([
    "src/app/api/management/jobs/[id]/confirm-empty/route.ts",
    "src/app/api/management/jobs/[id]/retry/route.ts",
    "src/app/[...slug]/page.tsx",
    "src/app/[[...slug]]/page.tsx",
    "a[b]",
    "dir/[abc]/x",
  ])("preserves literal brackets in %s", (value) => {
    expect(parseRepositoryPathClaim(value)).toBe(value);
  });

  it.each([
    "conx",
    "aux1",
    "lpt0",
    "PRN1",
    "com0",
    "a.b.c",
    "z".repeat(128),
    ".archflow/constitution/aux1.md",
    `.archflow/constitution/${"z".repeat(128)}.md`,
  ])("accepts near-reserved, dotted, and long name %s", (value) => {
    expect(parseRepositoryPathClaim(value)).toBe(value);
  });
});

describe("path brands", () => {
  it("does not let a string mint lexical path authority", () => {
    expectTypeOf<RepositoryPathClaim>().toMatchTypeOf<string>();
    // @ts-expect-error a plain string is not a validated lexical claim
    const untrusted: RepositoryPathClaim = "reviews/result.md";
    const lexical = parseRepositoryPathClaim("reviews/result.md");
    expect(untrusted).toBe(lexical);
  });
});

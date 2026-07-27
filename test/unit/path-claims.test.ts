import { describe, expect, expectTypeOf, it } from "vitest";

import { parseTaskPathClaim, type TaskPathClaim } from "../../src/contracts/index.js";

describe("task path claims", () => {
  it.each([
    "artifact.md",
    "reviews/phase-2.md",
    ".archflow/tasks/example/prd.md",
    "資料/設計.md"
  ])("accepts bounded slash-separated lexical claim %s", (value) => {
    expect(parseTaskPathClaim(value)).toBe(value);
  });

  it.each([
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
    "line\nbreak"
  ])("rejects unsafe lexical alias %s", (value) => {
    expect(() => parseTaskPathClaim(value)).toThrow();
  });

  it("bounds UTF-8 bytes rather than JavaScript string length", () => {
    expect(parseTaskPathClaim("é".repeat(512))).toHaveLength(512);
    expect(() => parseTaskPathClaim("é".repeat(513))).toThrow(/1024 UTF-8 bytes/iu);
  });

  it("does not let a string mint lexical or resolved path authority", () => {
    expectTypeOf<TaskPathClaim>().toMatchTypeOf<string>();
    // @ts-expect-error a plain string is not a validated lexical claim
    const untrusted: TaskPathClaim = "reviews/result.md";
    type ResolvedSafePath = string & { readonly __resolvedSafePath: unique symbol };
    const lexical = parseTaskPathClaim("reviews/result.md");
    // @ts-expect-error a lexical claim is not Phase 4 resolved-safe-path authority
    const resolved: ResolvedSafePath = lexical;
    expect(untrusted).toBe(lexical);
    expect(resolved).toBe(lexical);
  });
});

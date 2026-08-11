import { describe, expect, expectTypeOf, it } from "vitest";

import {
  PATH_CLASSES,
  READ_ONLY_PATH_CLASSES,
  REPOSITORY_PATH_CLASSES,
  TASK_PATH_CLASSES,
  parsePathClass,
  parseRepositoryPathClaim,
  parseTaskPathClaim,
  parseTaskSlug,
  rawGitPath,
  toRepositoryPathClaim,
  tryRepositoryPathClaim,
  type RawGitPath,
  type RepositoryPathClaim,
  type TaskPathClaim
} from "../../src/contracts/index.js";
import type { ResolvedTaskPath } from "../../src/repository/paths.js";

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
  // Git pathspec metacharacters: one claim must never select more than one file.
  "a*b",
  "a?b",
  "a[b]",
  "dir/[abc]/x",
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

describe("task path claims", () => {
  it.each([
    "artifact.md",
    "reviews/phase-2.md",
    ".archflow/tasks/example/prd.md",
    "資料/設計.md",
    "CONFIG.md",
    "console/log.txt",
    "COM0"
  ])("accepts bounded slash-separated lexical claim %s", (value) => {
    expect(parseTaskPathClaim(value)).toBe(value);
  });

  it.each(UNSAFE_CLAIMS)("rejects unsafe lexical alias %s", (value) => {
    expect(() => parseTaskPathClaim(value)).toThrow();
  });

  it("bounds UTF-8 bytes rather than JavaScript string length", () => {
    expect(parseTaskPathClaim("é".repeat(512))).toHaveLength(512);
    expect(() => parseTaskPathClaim("é".repeat(513))).toThrow(/1024 UTF-8 bytes/iu);
  });
});

describe("repository path claims", () => {
  it("shares one lexical authority with task claims", () => {
    expect(parseRepositoryPathClaim(".archflow/workflow.yaml")).toBe(".archflow/workflow.yaml");
    for (const value of UNSAFE_CLAIMS) expect(() => parseRepositoryPathClaim(value)).toThrow();
  });

  it("re-frames a task claim under the task directory", () => {
    const taskId = parseTaskSlug("mcp-integration");
    const claim = parseTaskPathClaim("reviews/phase-2.md");
    expect(toRepositoryPathClaim(taskId, claim)).toBe(".archflow/tasks/mcp-integration/reviews/phase-2.md");
  });

  it("brands raw Git output without asserting anything about it", () => {
    for (const value of ["weird:name", "a.", "e\u0301", "line\nbreak", ""]) {
      expect(rawGitPath(value)).toBe(value);
    }
  });

  it("promotes only representable Git output, and counts rather than throws otherwise", () => {
    expect(tryRepositoryPathClaim(rawGitPath("src/index.ts"))).toBe("src/index.ts");
    const unrepresentable = ["conflict:file.json", "trailing.", "e\u0301.md", "../escape"].map(rawGitPath);
    expect(unrepresentable.filter((value) => tryRepositoryPathClaim(value) === undefined)).toHaveLength(4);
  });
});

describe("path classes", () => {
  it("partitions the class vocabulary between the two frames", () => {
    expect(PATH_CLASSES).toEqual([...TASK_PATH_CLASSES, ...REPOSITORY_PATH_CLASSES]);
    expect(TASK_PATH_CLASSES).toHaveLength(16);
    expect(REPOSITORY_PATH_CLASSES).toHaveLength(4);
    expect(new Set(PATH_CLASSES).size).toBe(PATH_CLASSES.length);
    expect(READ_ONLY_PATH_CLASSES).toEqual(["shared-workflow", "shared-constitution"]);
    for (const value of PATH_CLASSES) expect(parsePathClass(value)).toBe(value);
    expect(() => parsePathClass("not-a-class")).toThrow();
  });
});

describe("path brands", () => {
  it("does not let a string mint lexical or resolved path authority", () => {
    expectTypeOf<TaskPathClaim>().toMatchTypeOf<string>();
    // @ts-expect-error a plain string is not a validated lexical claim
    const untrusted: TaskPathClaim = "reviews/result.md";
    // The brand is real as of Phase 6 chunk 6: `ResolvedTaskPath` is minted only by
    // `src/repository/paths.ts`, after realpath containment under the worktree root.
    const lexical = parseTaskPathClaim("reviews/result.md");
    // @ts-expect-error a lexical claim carries no containment proof
    const resolved: ResolvedTaskPath = lexical;
    expect(untrusted).toBe(lexical);
    expect(resolved).toBe(lexical);
  });

  it("keeps the three path representations mutually unassignable", () => {
    expectTypeOf<RepositoryPathClaim>().toMatchTypeOf<string>();
    expectTypeOf<RawGitPath>().toMatchTypeOf<string>();
    const task = parseTaskPathClaim("reviews/result.md");
    const repository = parseRepositoryPathClaim("reviews/result.md");
    const raw = rawGitPath("reviews/result.md");

    // @ts-expect-error a plain string cannot mint a repository claim
    const untrustedRepository: RepositoryPathClaim = "reviews/result.md";
    // @ts-expect-error a plain string cannot mint raw Git output
    const untrustedRaw: RawGitPath = "reviews/result.md";
    // @ts-expect-error the task frame is not the worktree frame
    const wrongFrame: RepositoryPathClaim = task;
    // @ts-expect-error the worktree frame is not the task frame
    const wrongFrameBack: TaskPathClaim = repository;
    // @ts-expect-error raw Git output carries no lexical guarantee
    const unvalidated: RepositoryPathClaim = raw;
    // @ts-expect-error a validated claim is not raw Git output
    const misattributed: RawGitPath = repository;

    expect([untrustedRepository, untrustedRaw, wrongFrame, wrongFrameBack, unvalidated, misattributed])
      .toEqual(Array.from({ length: 6 }, () => "reviews/result.md"));
  });
});

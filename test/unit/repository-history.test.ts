import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterAll, describe, expect, it } from "vitest";

import { historyIdentityDigest, parseGitOid } from "../../src/contracts/canonical.js";
import { parseSafeCode, parseSafeInteger, parseTaskSlug } from "../../src/contracts/evidence.js";
import { rawGitPath, parseRepositoryPathClaim } from "../../src/contracts/path-claims.js";
import {
  encodePhaseInstance,
  parsePositiveSafePhaseNumber,
} from "../../src/contracts/phase-instance.js";
import {
  createGitRunner,
  GitInvocationError,
  type RepositoryOperationContext,
} from "../../src/repository/git.js";
import {
  classifyMutationReadiness,
  IN_PROGRESS_OPERATIONS,
  readHistoryStatus,
  type WorktreeHistoryStatus,
} from "../../src/repository/history.js";
import { discoverWorktree, type RootBoundGitRunner } from "../../src/repository/identity.js";
import { ARCHFLOW_GITATTRIBUTES_RULE } from "../../src/repository/attributes.js";

const context: RepositoryOperationContext = {
  task_id: parseTaskSlug("mcp-integration"),
  phase_instance: encodePhaseInstance({
    kind: "phase-impl",
    phase: parsePositiveSafePhaseNumber(6),
  }),
  operation: parseSafeCode("startup-check"),
  attempt: parseSafeInteger(1),
};

function gitAvailable(): boolean {
  try {
    execFileSync("git", ["--version"], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

const hasGit = gitAvailable();
const temporaryRoots: string[] = [];

afterAll(() => {
  for (const root of temporaryRoots) rmSync(root, { recursive: true, force: true });
});

const GIT_ENV: NodeJS.ProcessEnv = {
  ...process.env,
  GIT_CONFIG_GLOBAL: "/dev/null",
  GIT_CONFIG_SYSTEM: "/dev/null",
  GIT_AUTHOR_NAME: "ArchFlow Test",
  GIT_AUTHOR_EMAIL: "test@example.invalid",
  GIT_COMMITTER_NAME: "ArchFlow Test",
  GIT_COMMITTER_EMAIL: "test@example.invalid",
};

function git(cwd: string, ...args: readonly string[]): string {
  return execFileSync("git", [...args], { cwd, env: GIT_ENV, encoding: "utf8" }).trimEnd();
}

/** Commands whose whole purpose is to stop on a conflict exit nonzero; that is the fixture. */
function gitAllowFail(cwd: string, ...args: readonly string[]): void {
  try {
    execFileSync("git", [...args], { cwd, env: GIT_ENV, stdio: "ignore" });
  } catch {
    /* expected: the conflict is the fixture */
  }
}

const GITATTRIBUTES = `* text=auto\n${ARCHFLOW_GITATTRIBUTES_RULE}\n`;

function temporaryRoot(label: string): string {
  const root = realpathSync(mkdtempSync(join(tmpdir(), `archflow-history-${label}-`)));
  temporaryRoots.push(root);
  return root;
}

function newRepository(label: string, options: { readonly commit?: boolean } = {}): string {
  const root = temporaryRoot(label);
  const repository = join(root, "repo");
  mkdirSync(join(repository, ".archflow"), { recursive: true });
  git(root, "-c", "init.defaultBranch=main", "init", "-q", "repo");
  writeFileSync(join(repository, ".gitattributes"), GITATTRIBUTES, "utf8");
  if (options.commit !== false) {
    writeFileSync(join(repository, ".archflow", "state.json"), '{"v":0}\n', "utf8");
    writeFileSync(join(repository, "file.txt"), "base\n", "utf8");
    commitAll(repository, "base");
  }
  return repository;
}

function commitAll(repository: string, message: string): void {
  git(repository, "add", "-A");
  git(repository, "commit", "-q", "-m", message);
}

async function boundRunnerAt(directory: string): Promise<RootBoundGitRunner> {
  const result = await discoverWorktree(createGitRunner({ cwd: directory }), context);
  if (!result.ok) throw new Error(`discovery failed: ${result.error.code}`);
  return result.value;
}

async function statusOf(repository: string): Promise<WorktreeHistoryStatus> {
  const result = await readHistoryStatus(await boundRunnerAt(repository), context);
  if (!result.ok) throw new Error(`readHistoryStatus failed: ${result.error.code}`);
  return result.value;
}

/** A runner satisfying the type without running git, for streams git will not produce on demand. */
function stubRunner(options: {
  readonly gitDir: string;
  readonly status: readonly string[];
  readonly conflicted?: readonly string[];
}): RootBoundGitRunner {
  return {
    cwd: "/nowhere",
    location: {
      worktreeRoot: "/nowhere",
      gitDir: options.gitDir,
      gitCommonDir: options.gitDir,
      linked: false,
    },
    run: () => Promise.reject(new Error("unused")),
    runText: () => Promise.reject(new Error("unused")),
    runNulFields: (spec: { readonly argv: readonly string[] }) =>
      Promise.resolve(spec.argv[0] === "status" ? options.status : (options.conflicted ?? [])),
  } as unknown as RootBoundGitRunner;
}

describe("IN_PROGRESS_OPERATIONS", () => {
  it("is the pinned five-operation list", () => {
    expect(IN_PROGRESS_OPERATIONS).toEqual([
      "merge",
      "rebase-merge",
      "rebase-apply",
      "cherry-pick",
      "revert",
    ]);
  });
});

describe.skipIf(!hasGit)("readHistoryStatus — upstream", () => {
  it("reports the distinct no-upstream state, never 0 ahead / 0 behind", async () => {
    const repository = newRepository("no-upstream");

    // The gotcha, asserted against the raw stream: with no upstream configured, `# branch.upstream`
    // and `# branch.ab` are *silently absent* — there is no 0/0 to misread.
    const runner = await boundRunnerAt(repository);
    const fields = await runner.runNulFields({
      argv: ["status", "--porcelain=v2", "--branch", "-z"],
      operation: parseSafeCode("git-status"),
    });
    expect(fields.some((field) => field.startsWith("# branch.ab"))).toBe(false);
    expect(fields.some((field) => field.startsWith("# branch.upstream"))).toBe(false);
    expect(fields.some((field) => field.startsWith("# branch.head"))).toBe(true);

    const status = await statusOf(repository);
    expect(status.upstream).toEqual({ kind: "no-upstream" });
    expect(status.branch).toBe("main");
    expect(status.head).toBe(git(repository, "rev-parse", "HEAD"));
    expect(status.inProgress).toEqual([]);
    expect(status.conflictedArchflowPaths).toEqual([]);
    expect(status.conflictedOtherPaths).toEqual([]);
    expect(status.unrepresentableOtherConflicts).toBe(0);
  });

  it("reports a tracked upstream with real ahead/behind counts", async () => {
    const upstream = newRepository("tracked-upstream");
    const root = temporaryRoot("tracked-clone");
    const clone = join(root, "clone");
    git(root, "clone", "-q", upstream, "clone");

    const status = await statusOf(clone);
    expect(status.upstream).toEqual({
      kind: "tracked",
      upstream: "origin/main",
      ahead: 0,
      behind: 0,
      upstreamOid: git(clone, "rev-parse", "origin/main"),
    });
  });
});

describe.skipIf(!hasGit)("readHistoryStatus — divergence", () => {
  it("produces GIT_DIVERGED carrying the upstream and head history digests", async () => {
    const upstream = newRepository("diverged-upstream");
    const root = temporaryRoot("diverged-clone");
    const clone = join(root, "clone");
    git(root, "clone", "-q", upstream, "clone");

    writeFileSync(join(clone, "local.txt"), "local\n", "utf8");
    commitAll(clone, "local");
    writeFileSync(join(upstream, "remote.txt"), "remote\n", "utf8");
    commitAll(upstream, "remote");
    git(clone, "fetch", "-q");

    const status = await statusOf(clone);
    expect(status.upstream.kind).toBe("tracked");
    if (status.upstream.kind !== "tracked") throw new Error("unreachable");
    expect(status.upstream.ahead).toBe(1);
    expect(status.upstream.behind).toBe(1);

    const headOid = parseGitOid(git(clone, "rev-parse", "HEAD"));
    const upstreamOid = parseGitOid(git(clone, "rev-parse", "origin/main"));
    expect(status.head).toBe(headOid);
    expect(status.upstream.upstreamOid).toBe(upstreamOid);

    const readiness = classifyMutationReadiness(status, context);
    expect(readiness.ok).toBe(false);
    if (readiness.ok) throw new Error("unreachable");
    expect(readiness.error.code).toBe("GIT_DIVERGED");
    expect(readiness.error.diagnostic.parameters).toEqual({
      expected_digest: historyIdentityDigest(upstreamOid),
      observed_digest: historyIdentityDigest(headOid),
    });
    // Digests, not raw OIDs: PROJECT_PARAMETER_SCHEMAS requires /^[0-9a-f]{64}$/.
    for (const value of Object.values(readiness.error.diagnostic.parameters)) {
      expect(value).toMatch(/^[0-9a-f]{64}$/u);
    }
  });

  it("stays clean when only ahead, and when only behind", async () => {
    const upstream = newRepository("ahead-only-upstream");
    const root = temporaryRoot("ahead-only-clone");
    const clone = join(root, "clone");
    git(root, "clone", "-q", upstream, "clone");

    writeFileSync(join(clone, "local.txt"), "local\n", "utf8");
    commitAll(clone, "local");
    const ahead = await statusOf(clone);
    expect(ahead.upstream).toMatchObject({ ahead: 1, behind: 0 });
    expect(classifyMutationReadiness(ahead, context).ok).toBe(true);

    git(clone, "reset", "-q", "--hard", "origin/main");
    writeFileSync(join(upstream, "remote.txt"), "remote\n", "utf8");
    commitAll(upstream, "remote");
    git(clone, "fetch", "-q");
    const behind = await statusOf(clone);
    expect(behind.upstream).toMatchObject({ ahead: 0, behind: 1 });
    expect(classifyMutationReadiness(behind, context).ok).toBe(true);
  });
});

describe.skipIf(!hasGit)("readHistoryStatus — in-progress operations", () => {
  function conflictingBranches(repository: string): void {
    git(repository, "checkout", "-q", "-b", "feature");
    writeFileSync(join(repository, "file.txt"), "feature\n", "utf8");
    commitAll(repository, "feature");
    git(repository, "checkout", "-q", "main");
    writeFileSync(join(repository, "file.txt"), "main\n", "utf8");
    commitAll(repository, "main");
  }

  it("detects an in-progress conflicted merge", async () => {
    const repository = newRepository("merge");
    conflictingBranches(repository);
    gitAllowFail(repository, "merge", "feature");

    const status = await statusOf(repository);
    expect(status.inProgress).toEqual(["merge"]);
    expect(status.branch).toBe("main");
    expect(status.conflictedOtherPaths).toEqual([rawGitPath("file.txt")]);

    const readiness = classifyMutationReadiness(status, context);
    expect(readiness.ok).toBe(false);
    if (readiness.ok) throw new Error("unreachable");
    expect(readiness.error.code).toBe("HANDOFF_REQUIRED");
    expect(readiness.error.diagnostic.parameters).toEqual({ phase_instance: "phase-impl-6" });
  });

  it("detects an in-progress conflicted rebase, handles (detached), and accepts a directory marker", async () => {
    const repository = newRepository("rebase");
    conflictingBranches(repository);
    git(repository, "checkout", "-q", "feature");
    gitAllowFail(repository, "rebase", "main");

    const status = await statusOf(repository);
    expect(status.inProgress).toContain("rebase-merge");
    // `# branch.head` reads `(detached)` mid-rebase — branch-name logic breaks unless the rebase is
    // detected first, which is why detection runs before anything reads the branch.
    expect(status.branch).toBe("(detached)");
    expect(status.head).not.toBeUndefined();

    const marker = join(repository, ".git", "rebase-merge");
    expect(statSync(marker).isDirectory()).toBe(true);

    const readiness = classifyMutationReadiness(status, context);
    expect(readiness.ok).toBe(false);
    if (readiness.ok) throw new Error("unreachable");
    expect(readiness.error.code).toBe("HANDOFF_REQUIRED");
  });

  it("detects an in-progress cherry-pick", async () => {
    const repository = newRepository("cherry-pick");
    conflictingBranches(repository);
    gitAllowFail(repository, "cherry-pick", "feature");

    const status = await statusOf(repository);
    expect(status.inProgress).toContain("cherry-pick");
    expect(classifyMutationReadiness(status, context).ok).toBe(false);
  });

  it("detects an in-progress revert", async () => {
    const repository = newRepository("revert");
    const first = git(repository, "rev-parse", "HEAD");
    writeFileSync(join(repository, "file.txt"), "second\n", "utf8");
    commitAll(repository, "second");
    const second = git(repository, "rev-parse", "HEAD");
    writeFileSync(join(repository, "file.txt"), "third\n", "utf8");
    commitAll(repository, "third");
    expect(second).not.toBe(first);

    gitAllowFail(repository, "revert", "--no-edit", second);

    const status = await statusOf(repository);
    expect(status.inProgress).toContain("revert");
    expect(classifyMutationReadiness(status, context).ok).toBe(false);
  });
});

describe.skipIf(!hasGit)("readHistoryStatus — conflicted paths, raw versus validated", () => {
  /** A colon, a trailing dot, and a non-NFC name: all legal on ext4, none expressible as a claim. */
  const UNREPRESENTABLE = ["weird:name.txt", "trailing.", "café.txt"] as const;

  function conflictedRepository(): string {
    const repository = newRepository("conflicts", { commit: false });
    const names = [".archflow/state.json", "plain.txt", ...UNREPRESENTABLE];
    for (const name of names) writeFileSync(join(repository, name), "base\n", "utf8");
    commitAll(repository, "base");

    git(repository, "checkout", "-q", "-b", "feature");
    for (const name of names) writeFileSync(join(repository, name), "feature\n", "utf8");
    commitAll(repository, "feature");
    git(repository, "checkout", "-q", "main");
    for (const name of names) writeFileSync(join(repository, name), "main\n", "utf8");
    commitAll(repository, "main");
    gitAllowFail(repository, "merge", "feature");
    return repository;
  }

  it("validates .archflow/ conflicts and keeps every other conflict raw, without throwing", async () => {
    const repository = conflictedRepository();
    const status = await statusOf(repository);

    expect(status.conflictedArchflowPaths).toEqual([parseRepositoryPathClaim(".archflow/state.json")]);
    expect([...status.conflictedOtherPaths].sort()).toEqual(
      ["plain.txt", ...UNREPRESENTABLE].sort()
    );
    expect(status.unrepresentableOtherConflicts).toBe(UNREPRESENTABLE.length);

    // The `.archflow/` file carries `merge=binary`, so it conflicts with zero markers and still
    // parses; the control file has markers. Conflict detection and parseability are independent.
    const archflow = git(repository, "show", ":2:.archflow/state.json");
    expect(archflow).not.toContain("<<<<<<<");
  });

  it("produces GIT_CONFLICT with the caller's operation for an .archflow/ conflict", async () => {
    const status = await statusOf(conflictedRepository());
    const readiness = classifyMutationReadiness(status, context);
    expect(readiness.ok).toBe(false);
    if (readiness.ok) throw new Error("unreachable");
    expect(readiness.error.code).toBe("GIT_CONFLICT");
    expect(readiness.error.diagnostic.parameters).toEqual({ operation: "startup-check" });
  });

  it("fails with TASK_INVALID when git returns an unrepresentable name inside .archflow/", async () => {
    const runner = stubRunner({
      gitDir: temporaryRoot("archflow-invalid"),
      status: ["# branch.oid (initial)", "# branch.head main"],
      conflicted: [".archflow/weird:name.json"],
    });
    const result = await readHistoryStatus(runner, context);
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("unreachable");
    expect(result.error.code).toBe("TASK_INVALID");
    expect(result.error.diagnostic.parameters).toEqual({
      task_id: "mcp-integration",
      issue_code: "git-path-mismatch",
    });
  });
});

describe.skipIf(!hasGit)("readHistoryStatus — porcelain parsing", () => {
  it("parses real rename lines under -z and ignores an unrecognised # header", async () => {
    const repository = newRepository("rename");
    git(repository, "mv", "file.txt", "renamed.txt");

    const runner = await boundRunnerAt(repository);
    const fields = await runner.runNulFields({
      argv: ["status", "--porcelain=v2", "--branch", "-z"],
      operation: parseSafeCode("git-status"),
    });
    // Rename entries really are two NUL fields in `-z` mode: the entry, then the original path.
    const renameIndex = fields.findIndex((field) => field.startsWith("2 "));
    expect(renameIndex).toBeGreaterThanOrEqual(0);
    expect(fields[renameIndex + 1]).toBe("file.txt");

    const head = git(repository, "rev-parse", "HEAD");
    const augmented = [
      "# unrecognised.header some future value",
      ...fields,
      "# another.unknown 1 2 3",
    ];
    const result = await readHistoryStatus(
      stubRunner({ gitDir: join(repository, ".git"), status: augmented }),
      context
    );
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("unreachable");
    expect(result.value.head).toBe(head);
    expect(result.value.branch).toBe("main");
    expect(result.value.upstream).toEqual({ kind: "no-upstream" });

    // The real reader agrees with the augmented stream: the extra headers changed nothing.
    const direct = await readHistoryStatus(runner, context);
    expect(direct.ok).toBe(true);
    if (!direct.ok) throw new Error("unreachable");
    expect(direct.value.head).toBe(head);
  });

  it("reports head: undefined for an unborn HEAD", async () => {
    const repository = newRepository("unborn", { commit: false });
    const status = await statusOf(repository);
    expect(status.head).toBeUndefined();
    expect(status.branch).toBe("main");
    expect(status.upstream).toEqual({ kind: "no-upstream" });
    expect(classifyMutationReadiness(status, context).ok).toBe(true);
  });

  it("translates a runner failure to IO_ERROR", async () => {
    const runner = {
      cwd: "/nowhere",
      location: {
        worktreeRoot: "/nowhere",
        gitDir: temporaryRoot("io-error"),
        gitCommonDir: "/nowhere",
        linked: false,
      },
      run: () => Promise.reject(new Error("unused")),
      runText: () => Promise.reject(new Error("unused")),
      runNulFields: () =>
        Promise.reject(
          new GitInvocationError({
            kind: "timeout",
            operation: parseSafeCode("git-status"),
            argv: ["status"],
          })
        ),
    } as unknown as RootBoundGitRunner;

    const result = await readHistoryStatus(runner, context);
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("unreachable");
    expect(result.error.code).toBe("IO_ERROR");
    expect(result.error.diagnostic.parameters).toEqual({
      operation: "startup-check",
      attempt: 1,
    });
  });
});

describe.skipIf(!hasGit)("classifyMutationReadiness", () => {
  it("succeeds on a clean tree and carries no value", async () => {
    const status = await statusOf(newRepository("clean"));
    const readiness = classifyMutationReadiness(status, context);
    expect(readiness).toEqual({ schema_version: "1", ok: true, value: undefined });
  });

  it("prefers an .archflow/ conflict over divergence and an in-progress operation", () => {
    const upstreamOid = parseGitOid("a".repeat(40));
    const headOid = parseGitOid("b".repeat(40));
    const status: WorktreeHistoryStatus = {
      head: headOid,
      branch: "main",
      upstream: { kind: "tracked", upstream: "origin/main", ahead: 1, behind: 1, upstreamOid },
      inProgress: ["merge"],
      conflictedArchflowPaths: [parseRepositoryPathClaim(".archflow/state.json")],
      conflictedOtherPaths: [],
      unrepresentableOtherConflicts: parseSafeInteger(0),
    };
    const readiness = classifyMutationReadiness(status, context);
    expect(readiness.ok).toBe(false);
    if (readiness.ok) throw new Error("unreachable");
    expect(readiness.error.code).toBe("GIT_CONFLICT");
  });
});

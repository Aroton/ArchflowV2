import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { isAbsolute, join } from "node:path";

import { afterAll, describe, expect, it } from "vitest";

import { canonicalJsonBytes, sha256Bytes } from "../../src/contracts/canonical.js";
import { parseSafeCode, parseSafeInteger, parseTaskSlug } from "../../src/contracts/evidence.js";
import {
  encodePhaseInstance,
  parsePositiveSafePhaseNumber,
} from "../../src/contracts/phase-instance.js";
import {
  createGitRunner,
  preflightGit,
  type GitEnvironment,
  type RepositoryOperationContext,
} from "../../src/repository/git.js";
import {
  computeTaskIdentity,
  discoverWorktree,
  isRootBoundGitRunner,
  resolveRepositoryIdentity,
  verifyRepositoryIdentity,
  type RepositoryIdentity,
  type RootBoundGitRunner,
} from "../../src/repository/identity.js";

const context: RepositoryOperationContext = {
  task_id: parseTaskSlug("mcp-integration"),
  phase_instance: encodePhaseInstance({
    kind: "phase-design",
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

function temporaryDirectory(prefix: string): string {
  const directory = realpathSync(mkdtempSync(join(tmpdir(), prefix)));
  temporaryRoots.push(directory);
  return directory;
}

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

function initRepository(directory: string): string {
  mkdirSync(directory, { recursive: true });
  git(directory, "-c", "init.defaultBranch=main", "init", "-q");
  return directory;
}

function commitFile(directory: string, name: string, content: string, message: string): void {
  writeFileSync(join(directory, name), content, "utf8");
  git(directory, "add", "--", name);
  git(directory, "commit", "-q", "-m", message);
}

/** A repository with a single root commit whose content is unique to `label`. */
function singleRootRepository(label: string): string {
  const directory = initRepository(join(temporaryDirectory("archflow-identity-"), "repo"));
  commitFile(directory, "a.txt", `${label}\n`, `root ${label}`);
  return directory;
}

async function environmentAt(directory: string): Promise<GitEnvironment> {
  const result = await preflightGit(createGitRunner({ cwd: directory }), context);
  if (!result.ok) throw new Error(`preflight failed: ${result.error.code}`);
  return result.value;
}

async function discoverAt(directory: string): Promise<RootBoundGitRunner> {
  const result = await discoverWorktree(createGitRunner({ cwd: directory }), context);
  if (!result.ok) throw new Error(`discovery failed: ${result.error.code}`);
  return result.value;
}

async function identityAt(directory: string): Promise<RepositoryIdentity> {
  const environment = await environmentAt(directory);
  const result = await resolveRepositoryIdentity(await discoverAt(directory), environment, context);
  if (!result.ok) throw new Error(`identity failed: ${result.error.code}`);
  return result.value;
}

function digestOfRoots(roots: readonly string[]): string {
  return sha256Bytes(canonicalJsonBytes({ object_format: "sha1", root_commits: [...roots] }));
}

describe.skipIf(!hasGit)("worktree discovery", () => {
  it("resolves the worktree root from a subdirectory, not the subdirectory itself", async () => {
    const repository = singleRootRepository("sub");
    const subdirectory = join(repository, "nested", "deeper");
    mkdirSync(subdirectory, { recursive: true });

    // Raw `--git-common-dir` from a subdirectory is relative to the *process cwd*, so resolving it
    // naively against the toplevel would land two levels above the repository.
    const rawCommonDir = git(subdirectory, "rev-parse", "--git-common-dir");
    expect(isAbsolute(rawCommonDir)).toBe(false);
    expect(join(repository, rawCommonDir)).not.toBe(join(repository, ".git"));

    const runner = await discoverAt(subdirectory);

    expect(runner.location.worktreeRoot).toBe(repository);
    expect(runner.cwd).toBe(repository);
    expect(runner.location.gitDir).toBe(join(repository, ".git"));
    expect(runner.location.gitCommonDir).toBe(join(repository, ".git"));
    expect(runner.location.linked).toBe(false);
  });

  it("handles paths containing spaces and non-ASCII characters", async () => {
    const parent = temporaryDirectory("archflow-identity-");
    const repository = initRepository(join(parent, "ré po ü space"));
    commitFile(repository, "ü space.txt", "unicode\n", "unicode root");

    const subdirectory = join(repository, "sub dir ü");
    mkdirSync(subdirectory, { recursive: true });

    const runner = await discoverAt(subdirectory);
    expect(runner.location.worktreeRoot).toBe(repository);
    expect(runner.location.gitDir).toBe(join(repository, ".git"));
    expect(runner.location.gitCommonDir).toBe(join(repository, ".git"));
  });

  it("refuses a directory that is not inside any repository", async () => {
    const plain = temporaryDirectory("archflow-identity-");

    const result = await discoverWorktree(createGitRunner({ cwd: plain }), context);

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe("REPOSITORY_NOT_FOUND");
    expect(result.error.diagnostic.parameters).toHaveProperty("repository_candidate_digest");
  });

  it("refuses a bare repository", async () => {
    const parent = temporaryDirectory("archflow-identity-");
    const bare = join(parent, "bare.git");
    mkdirSync(bare, { recursive: true });
    git(bare, "init", "-q", "--bare");

    expect(git(bare, "rev-parse", "--is-bare-repository")).toBe("true");

    const result = await discoverWorktree(createGitRunner({ cwd: bare }), context);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe("REPOSITORY_NOT_FOUND");
  });

  it("refuses a cwd inside .git/", async () => {
    const repository = singleRootRepository("gitdir");
    const insideGitDir = join(repository, ".git");

    expect(git(insideGitDir, "rev-parse", "--is-inside-git-dir")).toBe("true");

    const result = await discoverWorktree(createGitRunner({ cwd: insideGitDir }), context);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe("REPOSITORY_NOT_FOUND");
  });

  it("refuses a shallow clone", async () => {
    const source = singleRootRepository("shallow");
    commitFile(source, "b.txt", "second\n", "second commit");
    const parent = temporaryDirectory("archflow-identity-");
    const clone = join(parent, "shallow-clone");
    git(parent, "clone", "-q", "--depth=1", `file://${source}`, clone);

    expect(git(clone, "rev-parse", "--is-shallow-repository")).toBe("true");

    const result = await discoverWorktree(createGitRunner({ cwd: clone }), context);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe("REPOSITORY_NOT_FOUND");
  });

  it("refuses a submodule checkout on empty-versus-non-empty superproject output, not exit code", async () => {
    const child = singleRootRepository("submodule-child");
    const parent = singleRootRepository("submodule-parent");
    git(
      parent,
      "-c",
      "protocol.file.allow=always",
      "submodule",
      "add",
      "--quiet",
      child,
      "sub"
    );
    git(parent, "commit", "-q", "-m", "add submodule");
    const submodule = join(parent, "sub");

    // Both invocations exit 0; only the output distinguishes them, which is why the exit status is
    // never the test.
    let parentStatus = 0;
    let parentOutput = "unset";
    try {
      parentOutput = git(parent, "rev-parse", "--show-superproject-working-tree");
    } catch (error) {
      parentStatus = (error as { status?: number }).status ?? -1;
    }
    let childStatus = 0;
    let childOutput = "unset";
    try {
      childOutput = git(submodule, "rev-parse", "--show-superproject-working-tree");
    } catch (error) {
      childStatus = (error as { status?: number }).status ?? -1;
    }

    expect(parentStatus).toBe(0);
    expect(childStatus).toBe(0);
    expect(parentOutput).toBe("");
    expect(childOutput).not.toBe("");
    expect(realpathSync(childOutput)).toBe(parent);

    const result = await discoverWorktree(createGitRunner({ cwd: submodule }), context);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe("REPOSITORY_NOT_FOUND");

    // The superproject itself is still discoverable.
    const superproject = await discoverWorktree(createGitRunner({ cwd: parent }), context);
    expect(superproject.ok).toBe(true);
  });
});

describe.skipIf(!hasGit)("linked worktrees", () => {
  it("resolves relative and absolute git-dir output alike and shares one identity", async () => {
    const parent = temporaryDirectory("archflow-identity-");
    const main = initRepository(join(parent, "main"));
    commitFile(main, "a.txt", "linked\n", "root");
    const linked = join(parent, "linked wt ü");
    git(main, "worktree", "add", "-q", linked, "-b", "other");

    // The trap this resolution exists for: relative from the main worktree, absolute from the
    // linked one.
    expect(git(main, "rev-parse", "--git-dir")).toBe(".git");
    expect(git(main, "rev-parse", "--git-common-dir")).toBe(".git");
    expect(isAbsolute(git(linked, "rev-parse", "--git-dir"))).toBe(true);
    expect(isAbsolute(git(linked, "rev-parse", "--git-common-dir"))).toBe(true);

    const mainRunner = await discoverAt(main);
    const linkedRunner = await discoverAt(linked);

    expect(mainRunner.location.worktreeRoot).toBe(main);
    expect(mainRunner.location.gitDir).toBe(join(main, ".git"));
    expect(mainRunner.location.gitCommonDir).toBe(join(main, ".git"));
    expect(mainRunner.location.linked).toBe(false);

    expect(linkedRunner.location.worktreeRoot).toBe(realpathSync(linked));
    expect(isAbsolute(linkedRunner.location.gitDir)).toBe(true);
    // Git derives the administrative directory name from the basename, sanitised, so only the
    // parent is pinned.
    expect(linkedRunner.location.gitDir.startsWith(join(main, ".git", "worktrees"))).toBe(true);
    expect(linkedRunner.location.gitDir).not.toBe(join(main, ".git", "worktrees"));
    expect(linkedRunner.location.gitCommonDir).toBe(join(main, ".git"));
    expect(linkedRunner.location.linked).toBe(true);

    const environment = await environmentAt(main);
    const mainIdentity = await resolveRepositoryIdentity(mainRunner, environment, context);
    const linkedIdentity = await resolveRepositoryIdentity(linkedRunner, environment, context);
    expect(mainIdentity.ok && linkedIdentity.ok).toBe(true);
    if (!mainIdentity.ok || !linkedIdentity.ok) return;
    expect(linkedIdentity.value.digest).toBe(mainIdentity.value.digest);
  });
});

describe.skipIf(!hasGit)("repository identity", () => {
  it("hashes the whole sorted root set for an unrelated-histories merge", async () => {
    const repository = singleRootRepository("multi-root");
    git(repository, "checkout", "-q", "--orphan", "second");
    git(repository, "rm", "-q", "-rf", ".");
    commitFile(repository, "b.txt", "second root\n", "second root");
    git(repository, "checkout", "-q", "main");
    git(repository, "merge", "-q", "--allow-unrelated-histories", "--no-edit", "second");

    const rawRoots = git(repository, "rev-list", "--max-parents=0", "HEAD").split("\n");
    expect(rawRoots).toHaveLength(2);

    const identity = await identityAt(repository);

    expect(identity.root_commits).toHaveLength(2);
    expect([...identity.root_commits]).toStrictEqual([...rawRoots].sort());
    expect(identity.digest).toBe(digestOfRoots([...rawRoots].sort()));

    // Taking the first line alone — the bug this design forbids — produces a different digest.
    const firstLineOnly = digestOfRoots([rawRoots[0] ?? ""]);
    expect(firstLineOnly).not.toBe(identity.digest);

    // …and so does hashing the set in emitted rather than sorted order, when they differ.
    const sorted = [...rawRoots].sort();
    if (sorted[0] !== rawRoots[0]) {
      expect(digestOfRoots(rawRoots)).not.toBe(identity.digest);
    }
  });

  it("answers identically through a runner discovered from a subdirectory", async () => {
    const repository = singleRootRepository("bound");
    const subdirectory = join(repository, "deep", "nested");
    mkdirSync(subdirectory, { recursive: true });
    const environment = await environmentAt(repository);

    const fromRoot = await resolveRepositoryIdentity(
      await discoverAt(repository),
      environment,
      context
    );
    const fromSubdirectory = await resolveRepositoryIdentity(
      await discoverAt(subdirectory),
      environment,
      context
    );

    expect(fromRoot.ok && fromSubdirectory.ok).toBe(true);
    if (!fromRoot.ok || !fromSubdirectory.ok) return;
    expect(fromSubdirectory.value.digest).toBe(fromRoot.value.digest);
  });

  it("refuses an unborn HEAD", async () => {
    const repository = initRepository(join(temporaryDirectory("archflow-identity-"), "unborn"));

    // Discovery succeeds: the worktree exists. The root-commit query is what fails.
    const runner = await discoverAt(repository);
    const result = await resolveRepositoryIdentity(
      runner,
      await environmentAt(repository),
      context
    );

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe("REPOSITORY_NOT_FOUND");
    expect(result.error.diagnostic.parameters).toHaveProperty("repository_candidate_digest");
  });

  it("is unchanged when the repository directory is relocated", async () => {
    const parent = temporaryDirectory("archflow-identity-");
    const original = initRepository(join(parent, "before"));
    commitFile(original, "a.txt", "relocate\n", "root");

    const before = await identityAt(original);

    const moved = join(parent, "after moved ü");
    renameSync(original, moved);

    const after = await identityAt(moved);

    expect(after.digest).toBe(before.digest);
    expect([...after.root_commits]).toStrictEqual([...before.root_commits]);
  });

  it("reports schema_version and object_format from the preflighted environment", async () => {
    const identity = await identityAt(singleRootRepository("shape"));
    expect(identity.schema_version).toBe("1");
    expect(identity.object_format).toBe("sha1");
    expect(identity.digest).toMatch(/^[0-9a-f]{64}$/u);
  });
});

describe.skipIf(!hasGit)("identity comparison and task identity", () => {
  it("accepts a matching digest and reports both digests on mismatch", async () => {
    const first = await identityAt(singleRootRepository("compare-a"));
    const second = await identityAt(singleRootRepository("compare-b"));
    expect(second.digest).not.toBe(first.digest);

    const match = verifyRepositoryIdentity(first.digest, first);
    expect(match.ok).toBe(true);
    if (match.ok) expect(match.value).toBe(first);

    const mismatch = verifyRepositoryIdentity(first.digest, second);
    expect(mismatch.ok).toBe(false);
    if (mismatch.ok) return;
    expect(mismatch.error.code).toBe("REPOSITORY_MISMATCH");
    expect(mismatch.error.diagnostic.parameters).toStrictEqual({
      expected_digest: first.digest,
      observed_digest: second.digest,
    });
  });

  it("derives a deterministic task identity that varies with both inputs", async () => {
    const repository = await identityAt(singleRootRepository("task-identity-a"));
    const other = await identityAt(singleRootRepository("task-identity-b"));
    const alpha = parseTaskSlug("alpha-task");
    const beta = parseTaskSlug("beta-task");

    const identity = computeTaskIdentity(alpha, repository);

    expect(identity.schema_version).toBe("1");
    expect(identity.task_id).toBe(alpha);
    expect(identity.repository_identity_digest).toBe(repository.digest);
    expect(identity.digest).toMatch(/^[0-9a-f]{64}$/u);
    expect(computeTaskIdentity(alpha, repository).digest).toBe(identity.digest);
    expect(computeTaskIdentity(beta, repository).digest).not.toBe(identity.digest);
    expect(computeTaskIdentity(alpha, other).digest).not.toBe(identity.digest);
  });
});

describe.skipIf(!hasGit)("in-memory memoization", () => {
  it("memoizes resolveRepositoryIdentity for the same HEAD commit", async () => {
    const repository = singleRootRepository("memo-ident");
    const environment = await environmentAt(repository);
    const runner = await discoverAt(repository);

    const first = await resolveRepositoryIdentity(runner, environment, context);
    expect(first.ok).toBe(true);
    if (!first.ok) return;

    let revListCount = 0;
    const trackingRunner: RootBoundGitRunner = {
      ...runner,
      runText: async (spec) => {
        if (spec.argv.includes("rev-list")) {
          revListCount += 1;
        }
        return runner.runText(spec);
      },
    };

    const second = await resolveRepositoryIdentity(trackingRunner, environment, context);
    expect(second.ok).toBe(true);
    if (!second.ok) return;

    expect(second.value).toBe(first.value);
    expect(revListCount).toBe(0);
  });

  it("memoizes discoverWorktree for an already bound runner and for cached cwd", async () => {
    const repository = singleRootRepository("memo-discover");
    const runner = await discoverAt(repository);
    expect(isRootBoundGitRunner(runner)).toBe(true);

    let runCount = 0;
    const trackingRunner: RootBoundGitRunner = {
      ...runner,
      runText: async (spec) => {
        runCount += 1;
        return runner.runText(spec);
      },
    };

    const rediscovered = await discoverWorktree(trackingRunner, context);
    expect(rediscovered.ok).toBe(true);
    expect(runCount).toBe(0);

    const freshRunner = createGitRunner({ cwd: repository });
    const freshDiscovered = await discoverWorktree(freshRunner, context);
    expect(freshDiscovered.ok).toBe(true);
    if (freshDiscovered.ok) {
      expect(freshDiscovered.value.location.worktreeRoot).toBe(repository);
    }
  });

  it("re-evaluates identity when HEAD moves to a new commit", async () => {
    const repository = singleRootRepository("memo-head-move");
    const environment = await environmentAt(repository);
    const runner = await discoverAt(repository);

    const initial = await resolveRepositoryIdentity(runner, environment, context);
    expect(initial.ok).toBe(true);

    commitFile(repository, "next.txt", "second\n", "second commit");

    const updated = await resolveRepositoryIdentity(runner, environment, context);
    expect(updated.ok).toBe(true);
    if (!initial.ok || !updated.ok) return;

    expect(updated.value.digest).toBe(initial.value.digest);
    expect(updated.value.root_commits).toStrictEqual(initial.value.root_commits);
  });
});


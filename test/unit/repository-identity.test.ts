import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { isAbsolute, join } from "node:path";

import { afterAll, describe, expect, it } from "vitest";

import { parseSafeCode, parseSafeInteger } from "../../src/contracts/evidence.js";
import {
  createGitRunner,
  type RepositoryOperationContext,
} from "../../src/repository/git.js";
import {
  discoverWorktree,
  isRootBoundGitRunner,
  type RootBoundGitRunner,
} from "../../src/repository/identity.js";

const context: RepositoryOperationContext = {
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

async function discoverAt(directory: string): Promise<RootBoundGitRunner> {
  const result = await discoverWorktree(createGitRunner({ cwd: directory }), context);
  if (!result.ok) throw new Error(`discovery failed: ${result.error.code}`);
  return result.value;
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
  it("resolves relative and absolute git-dir output alike", async () => {
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
  });
});

describe.skipIf(!hasGit)("in-memory memoization", () => {

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
});


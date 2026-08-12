import { execFileSync } from "node:child_process";
import {
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterAll, describe, expect, it } from "vitest";

import { parseSafeCode, parseSafeInteger, parseTaskSlug } from "../../src/contracts/evidence.js";
import {
  encodePhaseInstance,
  parsePositiveSafePhaseNumber,
} from "../../src/contracts/phase-instance.js";
import { createGitRunner, type RepositoryOperationContext } from "../../src/repository/git.js";
import { discoverWorktree, type RootBoundGitRunner } from "../../src/repository/identity.js";
import {
  WORKSPACE_PATH_CLASSES,
  classifyWorkspacePath,
  parseWorkspacePathClaim,
  resolveTaskWorkspaceCleanupTarget,
  resolveTaskWorkspacePath,
  resolveTaskWorkspaceRoot,
  type WorkspacePathClaim,
} from "../../src/repository/paths.js";

const TASK_ID = parseTaskSlug("demo-task");
const context: RepositoryOperationContext = {
  task_id: TASK_ID,
  phase_instance: encodePhaseInstance({
    kind: "phase-impl",
    phase: parsePositiveSafePhaseNumber(2),
  }),
  operation: parseSafeCode("workspace-path-test"),
  attempt: parseSafeInteger(1),
};

const roots: string[] = [];
afterAll(() => {
  for (const root of roots) rmSync(root, { recursive: true, force: true });
});

const environment: NodeJS.ProcessEnv = {
  ...process.env,
  GIT_CONFIG_GLOBAL: "/dev/null",
  GIT_CONFIG_SYSTEM: "/dev/null",
  GIT_AUTHOR_NAME: "ArchFlow Test",
  GIT_AUTHOR_EMAIL: "test@example.invalid",
  GIT_COMMITTER_NAME: "ArchFlow Test",
  GIT_COMMITTER_EMAIL: "test@example.invalid",
};

function gitAvailable(): boolean {
  try {
    execFileSync("git", ["--version"], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

async function repository(): Promise<{
  parent: string;
  root: string;
  runner: RootBoundGitRunner;
}> {
  const parent = realpathSync(mkdtempSync(join(tmpdir(), "archflow-workspace-paths-")));
  roots.push(parent);
  const root = join(parent, "repo");
  mkdirSync(root);
  execFileSync("git", ["-c", "init.defaultBranch=main", "init", "-q"], {
    cwd: root,
    env: environment,
  });
  writeFileSync(join(root, "tracked.txt"), "root\n");
  execFileSync("git", ["add", "--", "tracked.txt"], { cwd: root, env: environment });
  execFileSync("git", ["commit", "-q", "-m", "root"], { cwd: root, env: environment });
  const discovered = await discoverWorktree(createGitRunner({ cwd: root }), context);
  if (!discovered.ok) throw new Error(`discovery failed: ${discovered.error.code}`);
  return { parent, root, runner: discovered.value };
}

const DIGEST = "a".repeat(64);
const samples = [
  ["workspace-intent", "transient/intents/intent-1.json"],
  ["workspace-staged-request", "transient/intents/intent-1.request.json"],
  ["workspace-lock", "transient/.transaction-lock"],
  ["workspace-result-payload", `cache/results/${DIGEST}/payload/src/index.ts`],
  ["workspace-review", "cache/reviews/prd.counter.md"],
  ["workspace-gate-interface", "cache/gates/gate.json"],
  ["workspace-verification-transcript", "cache/phases/2/verification.txt"],
  ["workspace-import", `cache/imports/${DIGEST}/payload/legacy/file.txt`],
  ["workspace-attempt", "diagnostics/attempts/phase-impl-2/attempt-1.json"],
  ["workspace-scratch", "cache/scratch/render.tmp"],
] as const;

describe.skipIf(!gitAvailable())("task workspace paths", () => {
  it("classifies and resolves every workspace class beneath the exact task root", async () => {
    const { root, runner } = await repository();
    expect(samples.map(([pathClass]) => pathClass)).toEqual([...WORKSPACE_PATH_CLASSES]);
    for (const [pathClass, value] of samples) {
      const claim = parseWorkspacePathClaim(value);
      expect(classifyWorkspacePath(TASK_ID, claim)).toMatchObject({ ok: true, value: pathClass });
      const resolved = await resolveTaskWorkspacePath({
        runner,
        taskId: TASK_ID,
        claim,
        expectedClass: pathClass,
        context,
      });
      expect(resolved).toMatchObject({
        ok: true,
        value: {
          path_class: pathClass,
          workspaceRelative: value,
          repositoryRelative: `.archflow/runtime/tasks/${TASK_ID}/${value}`,
          absolute: join(root, ".archflow", "runtime", "tasks", TASK_ID, value),
        },
      });
    }
  });

  it("resolves a missing task workspace root under the worktree", async () => {
    const { root, runner } = await repository();
    await expect(resolveTaskWorkspaceRoot({ runner, taskId: TASK_ID, context })).resolves.toEqual({
      schema_version: "1",
      ok: true,
      value: join(root, ".archflow", "runtime", "tasks", TASK_ID),
    });
  });

  it("rejects worktree escapes and sibling-task symlinks with distinct codes", async () => {
    const { parent, root, runner } = await repository();
    const workspace = join(root, ".archflow", "runtime", "tasks", TASK_ID);
    mkdirSync(join(workspace, "cache", "reviews"), { recursive: true });

    const outside = join(parent, "outside");
    mkdirSync(outside);
    writeFileSync(join(outside, "prd.counter.md"), "outside\n");
    symlinkSync(outside, join(workspace, "cache", "reviews", "outside"), "dir");
    const escaped = await resolveTaskWorkspacePath({
      runner,
      taskId: TASK_ID,
      claim: "cache/reviews/outside/prd.counter.md" as WorkspacePathClaim,
      expectedClass: "workspace-review",
      context,
    });
    // The bypassed claim does not match first, so use a classifying leaf symlink for containment.
    expect(escaped.ok).toBe(false);

    const other = join(root, ".archflow", "runtime", "tasks", "other-task");
    mkdirSync(join(other, "cache", "reviews"), { recursive: true });
    writeFileSync(join(other, "cache", "reviews", "prd.counter.md"), "other\n");
    rmSync(join(workspace, "cache", "reviews"), { recursive: true });
    symlinkSync(join(other, "cache", "reviews"), join(workspace, "cache", "reviews"), "dir");
    const sibling = await resolveTaskWorkspacePath({
      runner,
      taskId: TASK_ID,
      claim: parseWorkspacePathClaim("cache/reviews/prd.counter.md"),
      context,
    });
    expect(sibling.ok).toBe(false);
    if (!sibling.ok) expect(sibling.error.code).toBe("TASK_SCOPE_VIOLATION");

    rmSync(join(workspace, "cache", "reviews"));
    symlinkSync(outside, join(workspace, "cache", "reviews"), "dir");
    const outsideResult = await resolveTaskWorkspacePath({
      runner,
      taskId: TASK_ID,
      claim: parseWorkspacePathClaim("cache/reviews/prd.counter.md"),
      context,
    });
    expect(outsideResult.ok).toBe(false);
    if (!outsideResult.ok) expect(outsideResult.error.code).toBe("PATH_ESCAPE");
  });

  it("authenticates cleanup ancestors but never follows the deletion leaf", async () => {
    const { parent, root, runner } = await repository();
    const workspace = join(root, ".archflow", "runtime", "tasks", TASK_ID);
    const outside = join(parent, "outside-clean");
    mkdirSync(outside);
    writeFileSync(join(outside, "keep.txt"), "keep\n");
    mkdirSync(join(workspace, "cache", "reviews"), { recursive: true });
    const leaf = join(workspace, "cache", "reviews", "prd.counter.md");
    symlinkSync(join(outside, "keep.txt"), leaf);

    const result = await resolveTaskWorkspaceCleanupTarget({
      runner,
      taskId: TASK_ID,
      claim: parseWorkspacePathClaim("cache/reviews/prd.counter.md"),
      context,
    });
    expect(result).toMatchObject({
      ok: true,
      value: { absolute: leaf, leaf_kind: "symlink" },
    });
    if (!result.ok) return;
    rmSync(result.value.absolute, { recursive: true, force: true });
    expect(realpathSync(join(outside, "keep.txt"))).toBe(join(outside, "keep.txt"));
  });

  it("rejects cleanup beneath a symlinked ancestor in another task", async () => {
    const { root, runner } = await repository();
    const tasks = join(root, ".archflow", "runtime", "tasks");
    const workspace = join(tasks, TASK_ID);
    const other = join(tasks, "other-task");
    mkdirSync(join(workspace, "cache"), { recursive: true });
    mkdirSync(join(other, "reviews"), { recursive: true });
    symlinkSync(join(other, "reviews"), join(workspace, "cache", "reviews"), "dir");
    const result = await resolveTaskWorkspaceCleanupTarget({
      runner,
      taskId: TASK_ID,
      claim: parseWorkspacePathClaim("cache/reviews/prd.counter.md"),
      context,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe("TASK_SCOPE_VIOLATION");
  });

  it("rejects a task workspace root substituted with a sibling-task symlink", async () => {
    const { root, runner } = await repository();
    const tasks = join(root, ".archflow", "runtime", "tasks");
    const other = join(tasks, "other-task");
    mkdirSync(join(other, "cache", "reviews"), { recursive: true });
    writeFileSync(join(other, "cache", "reviews", "prd.counter.md"), "other\n");
    symlinkSync(other, join(tasks, TASK_ID), "dir");

    const rootResult = await resolveTaskWorkspaceRoot({ runner, taskId: TASK_ID, context });
    expect(rootResult.ok).toBe(false);
    if (!rootResult.ok) expect(rootResult.error.code).toBe("TASK_SCOPE_VIOLATION");

    const childResult = await resolveTaskWorkspacePath({
      runner,
      taskId: TASK_ID,
      claim: parseWorkspacePathClaim("cache/reviews/prd.counter.md"),
      context,
    });
    expect(childResult.ok).toBe(false);
    if (!childResult.ok) expect(childResult.error.code).toBe("TASK_SCOPE_VIOLATION");

    // Whole-task cleanup may still safely unlink the substituted root itself without following it.
    const cleanup = await resolveTaskWorkspaceCleanupTarget({ runner, taskId: TASK_ID, context });
    expect(cleanup).toMatchObject({ ok: true, value: { leaf_kind: "symlink" } });
  });
});

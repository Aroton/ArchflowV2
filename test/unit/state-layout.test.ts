import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, realpathSync, symlinkSync, writeFileSync } from "node:fs";
import { lstat, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { parsePathSafeId, parseSafeCode, parseSafeInteger, parseTaskSlug } from "../../src/contracts/evidence.js";
import { encodePhaseInstance, parsePositiveSafePhaseNumber } from "../../src/contracts/phase-instance.js";
import { createGitRunner, preflightGit, type RepositoryOperationContext } from "../../src/repository/git.js";
import { discoverWorktree } from "../../src/repository/identity.js";
import { createInternalTransactionAuthority, type TransactionAuthority } from "../../src/state/authority.js";
import { ensureAttemptDirectory, ensureDecisionDirectory, ensureIntentDirectory, ensurePayloadParent, ensureResultDirectory, ensureTaskProjectionParent, ensureWorkspaceProjectionParent, type DecisionLayoutError, type IntentLayoutError, type ResultLayoutError } from "../../src/state/layout.js";
import type { ResolvedTaskPath, ResolvedTaskWorkspacePath } from "../../src/repository/paths.js";

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))); });
const taskId = parseTaskSlug("task-1");
const context: RepositoryOperationContext = {
  task_id: taskId,
  phase_instance: encodePhaseInstance({ kind: "phase-impl", phase: parsePositiveSafePhaseNumber(9) }),
  operation: parseSafeCode("state-layout-test"),
  attempt: parseSafeInteger(1),
};
const environment: NodeJS.ProcessEnv = {
  ...process.env,
  GIT_CONFIG_GLOBAL: "/dev/null",
  GIT_CONFIG_SYSTEM: "/dev/null",
  GIT_AUTHOR_NAME: "ArchFlow Test",
  GIT_AUTHOR_EMAIL: "test@example.invalid",
  GIT_COMMITTER_NAME: "ArchFlow Test",
  GIT_COMMITTER_EMAIL: "test@example.invalid",
};

async function authority(): Promise<Readonly<{ root: string; value: TransactionAuthority }>> {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "archflow-state-layout-")));
  roots.push(root);
  execFileSync("git", ["-c", "init.defaultBranch=main", "init", "-q"], { cwd: root, env: environment });
  writeFileSync(join(root, "tracked.txt"), "root\n");
  execFileSync("git", ["add", "--", "tracked.txt"], { cwd: root, env: environment });
  execFileSync("git", ["commit", "-q", "-m", "root"], { cwd: root, env: environment });
  mkdirSync(join(root, ".archflow", "tasks", taskId), { recursive: true });
  const runner = createGitRunner({ cwd: root });
  const git = await preflightGit(runner, context);
  const worktree = await discoverWorktree(runner, context);
  if (!git.ok || !worktree.ok) throw new Error("Git setup failed");
  const result = await createInternalTransactionAuthority({ runner: worktree.value, environment: git.value, task_id: taskId, context });
  if (!result.ok) throw new Error("authority setup failed");
  return { root, value: result.value };
}

describe("intent directory layout", () => {
  it("creates and idempotently verifies only the fixed task-local directory", async () => {
    const { root, value } = await authority();
    await ensureIntentDirectory(value);
    await ensureIntentDirectory(value);
    const intents = join(root, ".archflow", "work", "tasks", taskId, "transient", "intents");
    expect((await lstat(intents)).isDirectory()).toBe(true);
    expect(await readdir(join(root, ".archflow", "tasks", taskId))).toEqual([]);
  });

  it("rejects symlinks and non-directories without replacing them", async () => {
    const first = await authority();
    const external = realpathSync(mkdtempSync(join(tmpdir(), "archflow-state-layout-target-")));
    roots.push(external);
    mkdirSync(join(first.value.workspace_root, "transient"), { recursive: true });
    const firstPath = join(first.value.workspace_root, "transient", "intents");
    symlinkSync(external, firstPath, "dir");
    await expect(ensureIntentDirectory(first.value)).rejects.toMatchObject({ stage: "verify" } satisfies Partial<IntentLayoutError>);
    expect((await lstat(firstPath)).isSymbolicLink()).toBe(true);

    const second = await authority();
    mkdirSync(join(second.value.workspace_root, "transient"), { recursive: true });
    const secondPath = join(second.value.workspace_root, "transient", "intents");
    writeFileSync(secondPath, "not a directory");
    await expect(ensureIntentDirectory(second.value)).rejects.toMatchObject({ stage: "verify" } satisfies Partial<IntentLayoutError>);
    expect((await lstat(secondPath)).isFile()).toBe(true);
  });

  it("accepts no caller path and rejects structural authority lookalikes", async () => {
    const { value } = await authority();
    const sibling = join(value.workspace_root, "..", "other-task", "transient", "intents");
    await expect(ensureIntentDirectory({ ...value } as TransactionAuthority)).rejects.toThrow(/authentic/u);
    await expect(lstat(sibling)).rejects.toMatchObject({ code: "ENOENT" });
  });
});

describe("decision directory layout", () => {
  it("creates and idempotently verifies the root and validated gate child", async () => {
    const { value } = await authority();
    await ensureDecisionDirectory(value, parsePathSafeId("gate-1"));
    await ensureDecisionDirectory(value, parsePathSafeId("gate-1"));
    expect((await lstat(join(value.task_root, "authority", "decisions", "gate-1"))).isDirectory()).toBe(true);
  });

  it("rejects symlink substitutions at either directory level", async () => {
    const external = realpathSync(mkdtempSync(join(tmpdir(), "archflow-decision-layout-target-")));
    roots.push(external);
    const first = await authority();
    mkdirSync(join(first.value.task_root, "authority"));
    symlinkSync(external, join(first.value.task_root, "authority", "decisions"), "dir");
    await expect(ensureDecisionDirectory(first.value, parsePathSafeId("gate-1")))
      .rejects.toMatchObject({ stage: "verify" } satisfies Partial<DecisionLayoutError>);

    const second = await authority();
    mkdirSync(join(second.value.task_root, "authority", "decisions"), { recursive: true });
    symlinkSync(external, join(second.value.task_root, "authority", "decisions", "gate-1"), "dir");
    await expect(ensureDecisionDirectory(second.value, parsePathSafeId("gate-1")))
      .rejects.toMatchObject({ stage: "verify" } satisfies Partial<DecisionLayoutError>);
  });
});

describe("projection parent layout", () => {
  it("creates nested projection parents inside the task root idempotently", async () => {
    const { value } = await authority();
    const target = join(value.task_root, "reviews", "prd.self.md") as ResolvedTaskPath;
    await ensureTaskProjectionParent(value, target);
    await ensureTaskProjectionParent(value, target);
    expect((await lstat(join(value.task_root, "reviews"))).isDirectory()).toBe(true);

    const nested = join(value.task_root, "results", "extra", "deep.md") as ResolvedTaskPath;
    await ensureTaskProjectionParent(value, nested);
    expect((await lstat(join(value.task_root, "results", "extra"))).isDirectory()).toBe(true);
  });

  it("leaves projection targets outside the task root untouched", async () => {
    const { root, value } = await authority();
    const outside = join(root, "src", "generated.ts") as ResolvedTaskPath;
    await ensureTaskProjectionParent(value, outside);
    await expect(lstat(join(root, "src"))).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("rejects a symlinked parent segment with a verify-stage error carrying no filesystem path", async () => {
    const external = realpathSync(mkdtempSync(join(tmpdir(), "archflow-projection-layout-target-")));
    roots.push(external);
    const { value } = await authority();
    symlinkSync(external, join(value.task_root, "reviews"), "dir");
    const target = join(value.task_root, "reviews", "prd.self.md") as ResolvedTaskPath;
    try {
      await ensureTaskProjectionParent(value, target);
      throw new Error("expected ensureTaskProjectionParent to reject");
    } catch (error) {
      expect(error).toMatchObject({ stage: "verify" } satisfies Partial<ResultLayoutError>);
      expect((error as Error).message).not.toContain(value.task_root);
    }
    expect((await lstat(join(value.task_root, "reviews"))).isSymbolicLink()).toBe(true);
  });
});

describe("task directory layouts", () => {
  it("creates verified phase-attempt hierarchies idempotently", async () => {
    const { value } = await authority();
    await ensureAttemptDirectory(value, context.phase_instance);
    await ensureAttemptDirectory(value, context.phase_instance);
    expect((await lstat(join(
      value.workspace_root,
      "diagnostics",
      "attempts",
      context.phase_instance,
    ))).isDirectory()).toBe(true);
  });

  it("separates durable result authority from ignored payload storage", async () => {
    const { value } = await authority();
    const digest = "a".repeat(64);
    await ensureResultDirectory(value, digest);
    expect((await lstat(join(value.task_root, "authority", "results"))).isDirectory()).toBe(true);
    const payloadRoot = join(value.workspace_root, "cache", "results", digest, "payload");
    expect((await lstat(payloadRoot)).isDirectory()).toBe(true);

    const payload = join(payloadRoot, "src", "nested", "index.ts") as ResolvedTaskWorkspacePath;
    await ensurePayloadParent(value, digest, payload);
    expect((await lstat(join(payloadRoot, "src", "nested"))).isDirectory()).toBe(true);
  });

  it("creates reconstructible cache parents only within the exact task workspace", async () => {
    const { value } = await authority();
    const review = join(value.workspace_root, "cache", "reviews", "prd.counter.md") as ResolvedTaskWorkspacePath;
    await ensureWorkspaceProjectionParent(value, review);
    expect((await lstat(join(value.workspace_root, "cache", "reviews"))).isDirectory()).toBe(true);

    const outside = join(value.task_root, "prd.md") as ResolvedTaskWorkspacePath;
    await expect(ensureWorkspaceProjectionParent(value, outside)).rejects.toThrow(/escaped/u);
  });
});

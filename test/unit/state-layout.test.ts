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
import { ensureAttemptDirectory, ensureDecisionDirectory, ensureIntentDirectory, ensureManualCheckpointDirectory, type DecisionLayoutError, type IntentLayoutError } from "../../src/state/layout.js";

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
    const intents = join(root, ".archflow", "tasks", taskId, "intents");
    expect((await lstat(intents)).isDirectory()).toBe(true);
    expect(await readdir(join(root, ".archflow", "tasks", taskId))).toEqual(["intents"]);
  });

  it("rejects symlinks and non-directories without replacing them", async () => {
    const first = await authority();
    const external = realpathSync(mkdtempSync(join(tmpdir(), "archflow-state-layout-target-")));
    roots.push(external);
    const firstPath = join(first.value.task_root, "intents");
    symlinkSync(external, firstPath, "dir");
    await expect(ensureIntentDirectory(first.value)).rejects.toMatchObject({ stage: "verify" } satisfies Partial<IntentLayoutError>);
    expect((await lstat(firstPath)).isSymbolicLink()).toBe(true);

    const second = await authority();
    const secondPath = join(second.value.task_root, "intents");
    writeFileSync(secondPath, "not a directory");
    await expect(ensureIntentDirectory(second.value)).rejects.toMatchObject({ stage: "verify" } satisfies Partial<IntentLayoutError>);
    expect((await lstat(secondPath)).isFile()).toBe(true);
  });

  it("accepts no caller path and rejects structural authority lookalikes", async () => {
    const { value } = await authority();
    const sibling = join(value.task_root, "..", "other-task", "intents");
    await expect(ensureIntentDirectory({ ...value } as TransactionAuthority)).rejects.toThrow(/authentic/u);
    await expect(lstat(sibling)).rejects.toMatchObject({ code: "ENOENT" });
  });
});

describe("decision directory layout", () => {
  it("creates and idempotently verifies the root and validated gate child", async () => {
    const { value } = await authority();
    await ensureDecisionDirectory(value, parsePathSafeId("gate-1"));
    await ensureDecisionDirectory(value, parsePathSafeId("gate-1"));
    expect((await lstat(join(value.task_root, "decisions", "gate-1"))).isDirectory()).toBe(true);
  });

  it("rejects symlink substitutions at either directory level", async () => {
    const external = realpathSync(mkdtempSync(join(tmpdir(), "archflow-decision-layout-target-")));
    roots.push(external);
    const first = await authority();
    symlinkSync(external, join(first.value.task_root, "decisions"), "dir");
    await expect(ensureDecisionDirectory(first.value, parsePathSafeId("gate-1")))
      .rejects.toMatchObject({ stage: "verify" } satisfies Partial<DecisionLayoutError>);

    const second = await authority();
    mkdirSync(join(second.value.task_root, "decisions"));
    symlinkSync(external, join(second.value.task_root, "decisions", "gate-1"), "dir");
    await expect(ensureDecisionDirectory(second.value, parsePathSafeId("gate-1")))
      .rejects.toMatchObject({ stage: "verify" } satisfies Partial<DecisionLayoutError>);
  });
});

describe("phase 15 directory layouts", () => {
  it("creates verified manual-checkpoint and phase-attempt hierarchies idempotently", async () => {
    const { value } = await authority();
    await ensureManualCheckpointDirectory(value);
    await ensureManualCheckpointDirectory(value);
    await ensureAttemptDirectory(value, context.phase_instance);
    await ensureAttemptDirectory(value, context.phase_instance);
    expect((await lstat(join(value.task_root, "manual", "checkpoints"))).isDirectory()).toBe(true);
    expect((await lstat(join(value.task_root, "attempts", context.phase_instance))).isDirectory()).toBe(true);
  });
});

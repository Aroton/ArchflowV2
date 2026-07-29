import { execFileSync } from "node:child_process";
import { access, mkdir, mkdtemp, readdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { parseSafeCode, parseSafeInteger, parseSha256Digest, parseTaskSlug } from "../../src/contracts/evidence.js";
import { encodePhaseInstance, parsePositiveSafePhaseNumber } from "../../src/contracts/phase-instance.js";
import { parseTaskPathClaim } from "../../src/contracts/path-claims.js";
import { createGitRunner, preflightGit, type RepositoryOperationContext } from "../../src/repository/git.js";
import { discoverWorktree } from "../../src/repository/identity.js";
import { createInternalTransactionAuthority } from "../../src/state/authority.js";
import { TaskLockRepairError } from "../../src/state/lock.js";
import { classifySuppliedRepairHistory, MAX_REPAIR_HISTORY_ENTRIES, planAbandonedLockRepair, repairAbandonedLock } from "../../src/state/repair.js";

const D = (value: string) => parseSha256Digest(value.repeat(64));
const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))); });

async function authorityWithLock() {
  const root = await mkdtemp(join(tmpdir(), "archflow-lock-repair-"));
  roots.push(root);
  const task = parseTaskSlug("task-1");
  execFileSync("git", ["-c", "init.defaultBranch=main", "init", "-q"], { cwd: root });
  await writeFile(join(root, "tracked"), "x");
  execFileSync("git", ["add", "tracked"], { cwd: root });
  execFileSync("git", ["-c", "user.name=Test", "-c", "user.email=test@example.invalid", "commit", "-q", "-m", "base"], { cwd: root });
  const taskRoot = join(root, ".archflow", "tasks", task);
  await mkdir(taskRoot, { recursive: true });
  await writeFile(join(taskRoot, "state.json"), "{}");
  await writeFile(join(taskRoot, "config.yaml"), "task: task-1\n");
  const context: RepositoryOperationContext = {
    task_id: task,
    phase_instance: encodePhaseInstance({ kind: "phase-impl", phase: parsePositiveSafePhaseNumber(10) }),
    operation: parseSafeCode("lock-repair-test"), attempt: parseSafeInteger(1),
  };
  const discovered = await discoverWorktree(createGitRunner({ cwd: root }), context);
  if (!discovered.ok) throw new Error("discovery failed");
  const environment = await preflightGit(discovered.value, context);
  if (!environment.ok) throw new Error("preflight failed");
  const authority = await createInternalTransactionAuthority({ runner: discovered.value, environment: environment.value, task_id: task, context });
  if (!authority.ok) throw new Error("authority failed");
  return { authority: authority.value, taskRoot };
}

describe("classifySuppliedRepairHistory", () => {
  it("does not promote one of multiple prepared successors", () => {
    const result = classifySuppliedRepairHistory([
      { path: parseTaskPathClaim("intents/a.json"), document_kind: "intent-receipt", digest: D("a"), relation: "prepared" },
      { path: parseTaskPathClaim("intents/b.json"), document_kind: "intent-receipt", digest: D("b"), relation: "prepared" },
    ]);
    expect(result.map((entry) => entry.classification)).toEqual(["competing-successor", "competing-successor"]);
    expect(result.every((entry) => entry.next_action === "request-human-successor-selection")).toBe(true);
  });

  it("rejects a caller list outside the explicit bound", () => {
    const entry = { path: parseTaskPathClaim("intents/a.json"), document_kind: "intent-receipt" as const, digest: D("a"), relation: "superseded" as const };
    expect(() => classifySuppliedRepairHistory(Array.from({ length: MAX_REPAIR_HISTORY_ENTRIES + 1 }, () => entry))).toThrow(/bounded limit/u);
  });

  it("removes only the exact empty inspected lock after explicit confirmation", async () => {
    const { authority, taskRoot } = await authorityWithLock();
    const lock = join(taskRoot, ".transaction-lock");
    await mkdir(lock);
    const plan = await planAbandonedLockRepair(authority);
    await expect(repairAbandonedLock(authority, plan, false)).rejects.toMatchObject({ reason: "unconfirmed" });
    await repairAbandonedLock(authority, plan, true);
    await expect(planAbandonedLockRepair(authority)).rejects.toMatchObject({ reason: "missing" });
    expect((await readdir(taskRoot)).filter((name) => name.startsWith(".transaction-lock.repair-"))).toEqual([]);
  });

  it("rejects symlink, non-empty, and replaced lock targets", async () => {
    const { authority, taskRoot } = await authorityWithLock();
    const lock = join(taskRoot, ".transaction-lock");
    const outside = join(taskRoot, "outside");
    await mkdir(outside);
    await symlink(outside, lock);
    await expect(planAbandonedLockRepair(authority)).rejects.toMatchObject({ reason: "symlink" });
    await rm(lock);
    await mkdir(lock);
    await writeFile(join(lock, "foreign"), "x");
    await expect(planAbandonedLockRepair(authority)).rejects.toMatchObject({ reason: "not-empty" });
    await rm(lock, { recursive: true });
    await mkdir(lock);
    const plan = await planAbandonedLockRepair(authority);
    await rm(lock, { recursive: true });
    await mkdir(lock);
    await expect(repairAbandonedLock(authority, plan, true)).rejects.toBeInstanceOf(TaskLockRepairError);
    const quarantines = (await readdir(taskRoot)).filter((name) => name.startsWith(".transaction-lock.repair-"));
    expect(quarantines).toEqual([]);
    await expect(access(lock)).resolves.toBeUndefined();
  });
});

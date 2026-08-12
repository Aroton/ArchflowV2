import { AsyncLocalStorage } from "node:async_hooks";
import { randomUUID } from "node:crypto";
import { constants as fsConstants } from "node:fs";
import { lstat, mkdir, open, readdir, realpath, rename, rmdir, type FileHandle } from "node:fs/promises";
import { dirname, join } from "node:path";
import { performance } from "node:perf_hooks";
import { setTimeout as delay } from "node:timers/promises";

import type { ResolvedTaskWorkspacePath } from "../repository/paths.js";
import { assertInternalTransactionAuthority, type TransactionAuthority } from "./authority.js";

export type TaskLock = Readonly<{
  runExclusive<T>(workspaceRoot: ResolvedTaskWorkspacePath, work: () => Promise<T>): Promise<T>;
}>;

export class TaskLockError extends Error {
  public constructor(public readonly stage: "acquire" | "release", cause?: unknown) {
    super(`task lock ${stage} failed`, cause === undefined ? undefined : { cause });
    this.name = "TaskLockError";
  }
}

const TASK_LOCK_POLICY = Object.freeze({
  relativePath: join("transient", ".transaction-lock"),
  pollIntervalMs: 10,
  deadlineMs: 250,
});

const authenticRepairPlans = new WeakSet<object>();
const repairPlanHandles = new WeakMap<object, FileHandle>();

export type AbandonedTaskLockPlan = Readonly<{
  workspace_root: ResolvedTaskWorkspacePath;
  lock_path: string;
  device: number;
  inode: number;
  birthtime_ms: number;
  ctime_ms: number;
}>;

export class TaskLockRepairError extends Error {
  public constructor(public readonly reason: "missing" | "symlink" | "not-directory" | "not-empty" | "replaced" | "unconfirmed" | "io") {
    super(`task lock repair rejected: ${reason}`);
    this.name = "TaskLockRepairError";
  }
}

function errnoOf(error: unknown): string | undefined {
  return error !== null && typeof error === "object" && "code" in error
    ? String(error.code)
    : undefined;
}

async function verifiedLock(authority: TransactionAuthority): Promise<{ lockPath: string; device: number; inode: number; birthtimeMs: number; ctimeMs: number }> {
  assertInternalTransactionAuthority(authority);
  const root = await realpath(authority.workspace_root).catch(() => { throw new TaskLockRepairError("io"); });
  if (root !== authority.workspace_root) throw new TaskLockRepairError("replaced");
  const lockPath = join(root, TASK_LOCK_POLICY.relativePath);
  let stat;
  try {
    stat = await lstat(lockPath);
  } catch (error) {
    throw new TaskLockRepairError(errnoOf(error) === "ENOENT" ? "missing" : "io");
  }
  if (stat.isSymbolicLink()) throw new TaskLockRepairError("symlink");
  if (!stat.isDirectory()) throw new TaskLockRepairError("not-directory");
  const contents = await readdir(lockPath).catch(() => { throw new TaskLockRepairError("io"); });
  if (contents.length !== 0) throw new TaskLockRepairError("not-empty");
  return { lockPath, device: stat.dev, inode: stat.ino, birthtimeMs: stat.birthtimeMs, ctimeMs: stat.ctimeMs };
}

/** Captures the exact empty direct-child lock object; it does not infer abandonment. */
export async function inspectAbandonedTaskLock(authority: TransactionAuthority): Promise<AbandonedTaskLockPlan> {
  const lock = await verifiedLock(authority);
  let handle: FileHandle;
  try {
    handle = await open(lock.lockPath, fsConstants.O_RDONLY | fsConstants.O_DIRECTORY | fsConstants.O_NOFOLLOW);
  } catch {
    throw new TaskLockRepairError("replaced");
  }
  const held = await handle.stat().catch(async () => {
    await handle.close().catch(() => undefined);
    throw new TaskLockRepairError("replaced");
  });
  if (held.dev !== lock.device || held.ino !== lock.inode) {
    await handle.close().catch(() => undefined);
    throw new TaskLockRepairError("replaced");
  }
  const plan = Object.freeze({
    workspace_root: authority.workspace_root,
    lock_path: lock.lockPath,
    device: lock.device,
    inode: lock.inode,
    birthtime_ms: lock.birthtimeMs,
    ctime_ms: lock.ctimeMs,
  });
  authenticRepairPlans.add(plan);
  repairPlanHandles.set(plan, handle);
  return plan;
}

/** Removes only the inspected object after a separate explicit human no-writer confirmation. */
export async function removeConfirmedAbandonedTaskLock(
  authority: TransactionAuthority,
  plan: AbandonedTaskLockPlan,
  humanConfirmedNoLiveWriter: boolean,
): Promise<void> {
  assertInternalTransactionAuthority(authority);
  if (!humanConfirmedNoLiveWriter) throw new TaskLockRepairError("unconfirmed");
  if (!authenticRepairPlans.has(plan) || plan.workspace_root !== authority.workspace_root) throw new TaskLockRepairError("replaced");
  const handle = repairPlanHandles.get(plan);
  if (handle === undefined) throw new TaskLockRepairError("replaced");
  const quarantine = join(dirname(plan.lock_path), `.transaction-lock.repair-${randomUUID()}`);
  try {
    const current = await verifiedLock(authority);
    const held = await handle.stat().catch(() => { throw new TaskLockRepairError("replaced"); });
    if (current.lockPath !== plan.lock_path || current.device !== plan.device || current.inode !== plan.inode ||
        current.birthtimeMs !== plan.birthtime_ms || current.ctimeMs !== plan.ctime_ms ||
        held.dev !== current.device || held.ino !== current.inode) {
      throw new TaskLockRepairError("replaced");
    }
    try {
      await rename(current.lockPath, quarantine);
    } catch (error) {
      throw new TaskLockRepairError(errnoOf(error) === "ENOENT" ? "missing" : "io");
    }
    let moved;
    try {
      moved = await lstat(quarantine);
    } catch {
      throw new TaskLockRepairError("replaced");
    }
    const movedContents = await readdir(quarantine).catch(() => { throw new TaskLockRepairError("replaced"); });
    const heldAfterRename = await handle.stat().catch(() => { throw new TaskLockRepairError("replaced"); });
    if (!moved.isDirectory() || moved.isSymbolicLink() || movedContents.length !== 0 ||
        moved.dev !== heldAfterRename.dev || moved.ino !== heldAfterRename.ino) {
      // The quarantined object is not the inspected lock. Leave it intact for explicit inspection;
      // never delete it and never overwrite a new fixed-path lock while attempting restoration.
      throw new TaskLockRepairError("replaced");
    }
    await rmdir(quarantine);
  } catch (error) {
    if (error instanceof TaskLockRepairError) throw error;
    const code = errnoOf(error);
    throw new TaskLockRepairError(code === "ENOENT" ? "missing" : code === "ENOTEMPTY" ? "not-empty" : "io");
  } finally {
    await handle.close().catch(() => undefined);
    repairPlanHandles.delete(plan);
    authenticRepairPlans.delete(plan);
  }
}

export function createTaskLock(): TaskLock {
  const heldRoots = new AsyncLocalStorage<ReadonlySet<ResolvedTaskWorkspacePath>>();

  async function acquire(lockPath: string): Promise<void> {
    const deadline = performance.now() + TASK_LOCK_POLICY.deadlineMs;
    for (;;) {
      try {
        await mkdir(lockPath);
        return;
      } catch (error) {
        if (errnoOf(error) !== "EEXIST") throw new TaskLockError("acquire");
      }

      const remaining = deadline - performance.now();
      if (remaining <= 0) throw new TaskLockError("acquire");
      await delay(Math.min(TASK_LOCK_POLICY.pollIntervalMs, remaining));
    }
  }

  async function runExclusive<T>(taskRoot: ResolvedTaskWorkspacePath, work: () => Promise<T>): Promise<T> {
    const inheritedRoots = heldRoots.getStore() ?? new Set<ResolvedTaskWorkspacePath>();
    if (inheritedRoots.has(taskRoot)) throw new TaskLockError("acquire");
    const lockPath = join(taskRoot, TASK_LOCK_POLICY.relativePath);
    await acquire(lockPath);
    const scopedRoots = new Set([...inheritedRoots, taskRoot]);
    let workResult: T;
    let workError: unknown;
    let workThrew = false;
    try {
      workResult = await heldRoots.run(scopedRoots, work);
    } catch (error) {
      workThrew = true;
      workError = error;
    }
    scopedRoots.delete(taskRoot);
    try {
      await rmdir(lockPath);
    } catch {
      throw new TaskLockError("release", workThrew ? workError : undefined);
    }
    if (workThrew) throw workError;
    return workResult!;
  }

  return Object.freeze({ runExclusive });
}

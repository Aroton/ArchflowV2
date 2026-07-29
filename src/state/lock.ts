import { AsyncLocalStorage } from "node:async_hooks";
import { mkdir, rmdir } from "node:fs/promises";
import { join } from "node:path";
import { performance } from "node:perf_hooks";
import { setTimeout as delay } from "node:timers/promises";

import type { ResolvedTaskPath } from "../repository/paths.js";

export type TaskLock = Readonly<{
  runExclusive<T>(taskRoot: ResolvedTaskPath, work: () => Promise<T>): Promise<T>;
}>;

export class TaskLockError extends Error {
  public constructor(public readonly stage: "acquire" | "release", cause?: unknown) {
    super(`task lock ${stage} failed`, cause === undefined ? undefined : { cause });
    this.name = "TaskLockError";
  }
}

const TASK_LOCK_POLICY = Object.freeze({
  directoryName: ".transaction-lock",
  pollIntervalMs: 10,
  deadlineMs: 250,
});

function errnoOf(error: unknown): string | undefined {
  return error !== null && typeof error === "object" && "code" in error
    ? String(error.code)
    : undefined;
}

export function createTaskLock(): TaskLock {
  const heldRoots = new AsyncLocalStorage<ReadonlySet<ResolvedTaskPath>>();

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

  async function runExclusive<T>(taskRoot: ResolvedTaskPath, work: () => Promise<T>): Promise<T> {
    const inheritedRoots = heldRoots.getStore() ?? new Set<ResolvedTaskPath>();
    if (inheritedRoots.has(taskRoot)) throw new TaskLockError("acquire");
    const lockPath = join(taskRoot, TASK_LOCK_POLICY.directoryName);
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

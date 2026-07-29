import { access, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import type { ResolvedTaskPath } from "../../src/repository/paths.js";
import { createTaskLock, TaskLockError } from "../../src/state/lock.js";

const roots: string[] = [];
const LOCK_DIRECTORY = ".transaction-lock";

async function taskRoot(): Promise<ResolvedTaskPath> {
  const root = await mkdtemp(join(tmpdir(), "archflow-state-lock-"));
  roots.push(root);
  return root as ResolvedTaskPath;
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

function deferred(): Readonly<{
  promise: Promise<void>;
  resolve: () => void;
}> {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

async function lockFailure(promise: Promise<unknown>): Promise<TaskLockError> {
  try {
    await promise;
  } catch (error) {
    expect(error).toBeInstanceOf(TaskLockError);
    return error as TaskLockError;
  }
  throw new Error("expected TaskLockError");
}

describe("createTaskLock", () => {
  it("serializes contenders for one task and releases in callback order", async () => {
    const root = await taskRoot();
    const lock = createTaskLock();
    const firstEntered = deferred();
    const releaseFirst = deferred();
    const events: string[] = [];

    const first = lock.runExclusive(root, async () => {
      events.push("first-enter");
      firstEntered.resolve();
      await releaseFirst.promise;
      events.push("first-exit");
    });
    await firstEntered.promise;
    const second = lock.runExclusive(root, async () => {
      events.push("second-enter");
    });
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(events).toEqual(["first-enter"]);

    releaseFirst.resolve();
    await Promise.all([first, second]);
    expect(events).toEqual(["first-enter", "first-exit", "second-enter"]);
    await expect(access(join(root, LOCK_DIRECTORY))).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("allows independent task roots to execute concurrently", async () => {
    const firstRoot = await taskRoot();
    const secondRoot = await taskRoot();
    const lock = createTaskLock();
    const bothEntered = deferred();
    const release = deferred();
    let entered = 0;
    const work = async (): Promise<void> => {
      entered += 1;
      if (entered === 2) bothEntered.resolve();
      await release.promise;
    };

    const first = lock.runExclusive(firstRoot, work);
    const second = lock.runExclusive(secondRoot, work);
    await bothEntered.promise;
    expect(entered).toBe(2);
    release.resolve();
    await Promise.all([first, second]);
  });

  it("rejects re-entry from the active callback instead of deadlocking", async () => {
    const root = await taskRoot();
    const lock = createTaskLock();

    await lock.runExclusive(root, async () => {
      const error = await lockFailure(lock.runExclusive(root, async () => undefined));
      expect(error.stage).toBe("acquire");
    });
  });

  it("leaves an existing abandoned lock in place and fails after bounded polling", async () => {
    const root = await taskRoot();
    const lockPath = join(root, LOCK_DIRECTORY);
    await mkdir(lockPath);
    const started = performance.now();

    const error = await lockFailure(createTaskLock().runExclusive(root, async () => undefined));
    expect(error.stage).toBe("acquire");
    expect(performance.now() - started).toBeGreaterThanOrEqual(200);
    await expect(access(lockPath)).resolves.toBeUndefined();
  });

  it("releases after callback failure and preserves the callback error", async () => {
    const root = await taskRoot();
    const lock = createTaskLock();
    const failure = new Error("work failed");

    await expect(lock.runExclusive(root, async () => Promise.reject(failure))).rejects.toBe(failure);
    await expect(access(join(root, LOCK_DIRECTORY))).rejects.toMatchObject({ code: "ENOENT" });
    await expect(lock.runExclusive(root, async () => "recovered")).resolves.toBe("recovered");
  });

  it("attaches the callback error when release fails too", async () => {
    const root = await taskRoot();
    const lockPath = join(root, LOCK_DIRECTORY);
    const failure = new Error("work failed first");

    const error = await lockFailure(createTaskLock().runExclusive(root, async () => {
      await writeFile(join(lockPath, "blocks-rmdir"), "foreign");
      throw failure;
    }));
    expect(error.stage).toBe("release");
    expect(error.cause).toBe(failure);
  });

  it("reports release failure without removing foreign replacement content", async () => {
    const root = await taskRoot();
    const lockPath = join(root, LOCK_DIRECTORY);

    const error = await lockFailure(
      createTaskLock().runExclusive(root, async () => {
        await writeFile(join(lockPath, "foreign"), "do not remove");
      }),
    );
    expect(error.stage).toBe("release");
    await expect(access(join(lockPath, "foreign"))).resolves.toBeUndefined();
  });

  it("reports a missing task root as an acquisition failure", async () => {
    const root = await taskRoot();
    await rm(root, { recursive: true });

    const error = await lockFailure(createTaskLock().runExclusive(root, async () => undefined));
    expect(error.stage).toBe("acquire");
  });
});

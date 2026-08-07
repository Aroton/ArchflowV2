import { randomUUID } from "node:crypto";
import { link, open, rename, symlink, unlink, type FileHandle } from "node:fs/promises";
import { basename, dirname, join } from "node:path";

import type { ResolvedPath } from "../repository/paths.js";

export type ExclusiveCreateResult = "created" | "exists";

export type AtomicWriter = Readonly<{
  createExclusive(path: ResolvedPath, bytes: Uint8Array): Promise<ExclusiveCreateResult>;
  replace(path: ResolvedPath, bytes: Uint8Array): Promise<void>;
  removeGateInterface(path: ResolvedPath): Promise<void>;
}>;

/** Narrow mutable-file primitives used by snapshot projection after collision checks. */
export type ProjectionWriter = Readonly<{
  replaceRegular(path: ResolvedPath, bytes: Uint8Array, executable: boolean): Promise<void>;
  replaceSymlink(path: ResolvedPath, target: string): Promise<void>;
  remove(path: ResolvedPath): Promise<void>;
}>;

export class AtomicReplaceError extends Error {
  public readonly operation: "create-exclusive" | "replace";
  public readonly target_may_have_changed: boolean;
  public readonly collision: boolean;
  public readonly errno?: string;

  public constructor(input: Readonly<{
    operation: "create-exclusive" | "replace";
    target_may_have_changed: boolean;
    collision: boolean;
    errno?: string | undefined;
  }>) {
    super(`atomic ${input.operation} failed`);
    this.name = "AtomicReplaceError";
    this.operation = input.operation;
    this.target_may_have_changed = input.target_may_have_changed;
    this.collision = input.collision;
    if (input.errno !== undefined) this.errno = input.errno;
  }
}

function errnoOf(error: unknown): string | undefined {
  return error !== null && typeof error === "object" && "code" in error
    ? String(error.code)
    : undefined;
}

async function writeAll(handle: FileHandle, bytes: Uint8Array): Promise<void> {
  let offset = 0;
  while (offset < bytes.byteLength) {
    const { bytesWritten } = await handle.write(bytes, offset, bytes.byteLength - offset, null);
    if (bytesWritten <= 0) throw new Error("temporary file write made no progress");
    offset += bytesWritten;
  }
}

async function createExclusive(path: ResolvedPath, bytes: Uint8Array): Promise<ExclusiveCreateResult> {
  if (
    path.path_class !== "intent" && path.path_class !== "maintenance-record" &&
    path.path_class !== "result-manifest" && path.path_class !== "result-payload" &&
    path.path_class !== "decision" && path.path_class !== "manual-checkpoint"
  ) {
    throw new TypeError("createExclusive requires an immutable resolved path");
  }

  const target = path.absolute;
  const temporary = join(
    dirname(target),
    `.${basename(target)}.${process.pid}.${randomUUID()}.tmp`,
  );
  let handle: FileHandle | undefined;
  let linkAttempted = false;

  try {
    handle = await open(temporary, "wx");
    await writeAll(handle, bytes);
    await handle.sync();
    await handle.close();
    handle = undefined;

    linkAttempted = true;
    try {
      await link(temporary, target);
    } catch (error) {
      if (errnoOf(error) === "EEXIST") return "exists";
      throw error;
    }
    return "created";
  } catch (error) {
    if (error instanceof AtomicReplaceError) throw error;
    throw new AtomicReplaceError({
      operation: "create-exclusive",
      target_may_have_changed: linkAttempted,
      collision: errnoOf(error) === "EEXIST",
      errno: errnoOf(error),
    });
  } finally {
    if (handle !== undefined) {
      await handle.close().catch(() => undefined);
    }
    await unlink(temporary).catch(() => undefined);
  }
}

async function replace(path: ResolvedPath, bytes: Uint8Array): Promise<void> {
  if (path.path_class !== "task-state" && path.path_class !== "gate-interface") {
    throw new TypeError("replace requires a task-state or gate-interface resolved path");
  }

  await replaceRegularBytes(path.absolute, bytes, 0o644);
}

async function removeGateInterface(path: ResolvedPath): Promise<void> {
  if (path.path_class !== "gate-interface") {
    throw new TypeError("removeGateInterface requires a gate-interface resolved path");
  }
  try {
    await unlink(path.absolute);
  } catch (error) {
    if (errnoOf(error) !== "ENOENT") {
      throw new AtomicReplaceError({
        operation: "replace",
        target_may_have_changed: false,
        collision: false,
        errno: errnoOf(error),
      });
    }
  }
}

export function createAtomicWriter(): AtomicWriter {
  return Object.freeze({ createExclusive, replace, removeGateInterface });
}

const PROJECTABLE = new Set([
  "attempt", "document", "import", "manual-checkpoint", "repository-source", "result-payload", "review",
  "task-branch-constitution",
]);

function requireProjectable(path: ResolvedPath): void {
  if (!PROJECTABLE.has(path.path_class)) throw new TypeError("projection requires a declared output path");
}

async function replaceRegularBytes(target: string, bytes: Uint8Array, mode: number): Promise<void> {
  const temporary = join(dirname(target), `.${basename(target)}.${process.pid}.${randomUUID()}.tmp`);
  let handle: FileHandle | undefined;
  let renameAttempted = false;
  try {
    handle = await open(temporary, "wx", mode);
    await writeAll(handle, bytes);
    await handle.sync();
    await handle.close();
    handle = undefined;
    renameAttempted = true;
    await rename(temporary, target);
  } catch (error) {
    throw new AtomicReplaceError({
      operation: "replace",
      target_may_have_changed: renameAttempted,
      collision: false,
      errno: errnoOf(error),
    });
  } finally {
    await handle?.close().catch(() => undefined);
    await unlink(temporary).catch(() => undefined);
  }
}

async function replaceRegular(path: ResolvedPath, bytes: Uint8Array, executable: boolean): Promise<void> {
  requireProjectable(path);
  await replaceRegularBytes(path.absolute, bytes, executable ? 0o755 : 0o644);
}

async function replaceSymlink(path: ResolvedPath, target: string): Promise<void> {
  requireProjectable(path);
  const temporary = join(dirname(path.absolute), `.${basename(path.absolute)}.${process.pid}.${randomUUID()}.tmp`);
  let created = false;
  try {
    await symlink(target, temporary);
    created = true;
    await rename(temporary, path.absolute);
    created = false;
  } catch (error) {
    throw new AtomicReplaceError({
      operation: "replace",
      target_may_have_changed: created,
      collision: false,
      errno: errnoOf(error),
    });
  } finally {
    if (created) await unlink(temporary).catch(() => undefined);
  }
}

async function remove(path: ResolvedPath): Promise<void> {
  requireProjectable(path);
  try {
    await unlink(path.absolute);
  } catch (error) {
    if (errnoOf(error) !== "ENOENT") {
      throw new AtomicReplaceError({
        operation: "replace",
        target_may_have_changed: false,
        collision: false,
        errno: errnoOf(error),
      });
    }
  }
}

export function createProjectionWriter(): ProjectionWriter {
  return Object.freeze({ replaceRegular, replaceSymlink, remove });
}

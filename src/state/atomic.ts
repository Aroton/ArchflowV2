import { randomUUID } from "node:crypto";
import { link, open, unlink, type FileHandle } from "node:fs/promises";
import { basename, dirname, join } from "node:path";

import writeFileAtomic from "write-file-atomic";

import type { ResolvedPath } from "../repository/paths.js";

export type ExclusiveCreateResult = "created" | "exists";

export type AtomicWriter = Readonly<{
  createExclusive(path: ResolvedPath, bytes: Uint8Array): Promise<ExclusiveCreateResult>;
  replace(path: ResolvedPath, bytes: Uint8Array): Promise<void>;
}>;

export class AtomicReplaceError extends Error {
  public readonly operation: "create-exclusive" | "replace";
  public readonly target_may_have_changed: boolean;
  public readonly collision: boolean;

  public constructor(input: Readonly<{
    operation: "create-exclusive" | "replace";
    target_may_have_changed: boolean;
    collision: boolean;
  }>) {
    super(`atomic ${input.operation} failed`);
    this.name = "AtomicReplaceError";
    this.operation = input.operation;
    this.target_may_have_changed = input.target_may_have_changed;
    this.collision = input.collision;
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
  if (path.path_class !== "intent") {
    throw new TypeError("createExclusive requires an intent resolved path");
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
    });
  } finally {
    if (handle !== undefined) {
      await handle.close().catch(() => undefined);
    }
    await unlink(temporary).catch(() => undefined);
  }
}

async function replace(path: ResolvedPath, bytes: Uint8Array): Promise<void> {
  if (path.path_class !== "task-state") {
    throw new TypeError("replace requires a task-state resolved path");
  }

  try {
    await writeFileAtomic(path.absolute, bytes);
  } catch {
    throw new AtomicReplaceError({
      operation: "replace",
      target_may_have_changed: true,
      collision: false,
    });
  }
}

export function createAtomicWriter(): AtomicWriter {
  return Object.freeze({ createExclusive, replace });
}

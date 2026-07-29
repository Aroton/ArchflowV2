import { constants as fsConstants } from "node:fs";
import { lstat, mkdir } from "node:fs/promises";
import { join } from "node:path";

import { openResolved, type ResolvedTaskPath } from "../repository/paths.js";
import { assertInternalTransactionAuthority, type TransactionAuthority } from "./authority.js";

export class IntentLayoutError extends Error {
  public constructor(public readonly stage: "create" | "verify") {
    super(`intent layout ${stage} failed`);
    this.name = "IntentLayoutError";
  }
}

function errnoOf(error: unknown): string | undefined {
  return error !== null && typeof error === "object" && "code" in error
    ? String(error.code)
    : undefined;
}

/** Creates and verifies the one fixed `intents/` child of an authentic task authority. */
export async function ensureIntentDirectory(authority: TransactionAuthority): Promise<void> {
  assertInternalTransactionAuthority(authority);
  // This is the sole state-layer path-brand cast: the child name is a fixed literal under a
  // constructor-proven authentic task root, and verification opens it with O_NOFOLLOW and
  // O_DIRECTORY. No caller-controlled path component crosses this boundary.
  const directory = join(authority.task_root, "intents") as ResolvedTaskPath;
  try {
    await mkdir(directory);
  } catch (error) {
    if (errnoOf(error) !== "EEXIST") throw new IntentLayoutError("create");
  }

  const directoryFlag = (fsConstants as { O_DIRECTORY?: number }).O_DIRECTORY ?? 0;
  let handle;
  try {
    const metadata = await lstat(directory);
    if (metadata.isSymbolicLink() || !metadata.isDirectory()) throw new IntentLayoutError("verify");
    // `openResolved` adds O_NOFOLLOW. O_DIRECTORY independently rejects an existing regular file.
    handle = await openResolved(directory, fsConstants.O_RDONLY | directoryFlag);
    const stat = await handle.stat();
    if (!stat.isDirectory()) throw new IntentLayoutError("verify");
  } catch (error) {
    if (error instanceof IntentLayoutError) throw error;
    throw new IntentLayoutError("verify");
  } finally {
    await handle?.close().catch(() => undefined);
  }
}

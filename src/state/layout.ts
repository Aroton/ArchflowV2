import { constants as fsConstants } from "node:fs";
import { lstat, mkdir } from "node:fs/promises";
import { isAbsolute, join, relative, sep } from "node:path";

import { parsePathSafeId, type PathSafeId } from "../contracts/evidence.js";
import { openResolved, type ResolvedTaskPath } from "../repository/paths.js";
import { assertInternalTransactionAuthority, type TransactionAuthority } from "./authority.js";

export class IntentLayoutError extends Error {
  public constructor(public readonly stage: "create" | "verify") {
    super(`intent layout ${stage} failed`);
    this.name = "IntentLayoutError";
  }
}

export class ResultLayoutError extends Error {
  public constructor(public readonly stage: "create" | "verify") {
    super(`result layout ${stage} failed`);
    this.name = "ResultLayoutError";
  }
}

export class DecisionLayoutError extends Error {
  public constructor(public readonly stage: "create" | "verify") {
    super(`decision layout ${stage} failed`);
    this.name = "DecisionLayoutError";
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

async function ensureDecisionChild(path: ResolvedTaskPath): Promise<void> {
  try {
    await mkdir(path);
  } catch (error) {
    if (errnoOf(error) !== "EEXIST") throw new DecisionLayoutError("create");
  }
  const directoryFlag = (fsConstants as { O_DIRECTORY?: number }).O_DIRECTORY ?? 0;
  let handle;
  try {
    const metadata = await lstat(path);
    if (metadata.isSymbolicLink() || !metadata.isDirectory()) throw new DecisionLayoutError("verify");
    handle = await openResolved(path, fsConstants.O_RDONLY | directoryFlag);
    if (!(await handle.stat()).isDirectory()) throw new DecisionLayoutError("verify");
  } catch (error) {
    if (error instanceof DecisionLayoutError) throw error;
    throw new DecisionLayoutError("verify");
  } finally {
    await handle?.close().catch(() => undefined);
  }
}

/** Creates and verifies `decisions/` and one validated caller-named gate child. */
export async function ensureDecisionDirectory(
  authority: TransactionAuthority,
  gateId: PathSafeId,
): Promise<void> {
  assertInternalTransactionAuthority(authority);
  const validatedGateId = parsePathSafeId(gateId);
  const decisions = join(authority.task_root, "decisions") as ResolvedTaskPath;
  const gate = join(decisions, validatedGateId) as ResolvedTaskPath;
  await ensureDecisionChild(decisions);
  await ensureDecisionChild(gate);
}


async function ensureRealDirectory(path: ResolvedTaskPath): Promise<void> {
  try {
    await mkdir(path);
  } catch (error) {
    if (errnoOf(error) !== "EEXIST") throw new ResultLayoutError("create");
  }
  const directoryFlag = (fsConstants as { O_DIRECTORY?: number }).O_DIRECTORY ?? 0;
  let handle;
  try {
    const metadata = await lstat(path);
    if (metadata.isSymbolicLink() || !metadata.isDirectory()) throw new ResultLayoutError("verify");
    handle = await openResolved(path, fsConstants.O_RDONLY | directoryFlag);
    if (!(await handle.stat()).isDirectory()) throw new ResultLayoutError("verify");
  } catch (error) {
    if (error instanceof ResultLayoutError) throw error;
    throw new ResultLayoutError("verify");
  } finally {
    await handle?.close().catch(() => undefined);
  }
}

/** Creates only the fixed task-local content-address hierarchy for one validated digest. */
export async function ensureResultDirectory(authority: TransactionAuthority, digest: string): Promise<void> {
  assertInternalTransactionAuthority(authority);
  if (!/^[0-9a-f]{64}$/u.test(digest)) throw new TypeError("result digest must be lowercase SHA-256");
  const parts = ["results", "sha256", digest, "payload"];
  let current = authority.task_root as string;
  for (const part of parts) {
    current = join(current, part);
    await ensureRealDirectory(current as ResolvedTaskPath);
  }
}

/** Ensures payload subdirectories cannot leave the authenticated result payload root. */
export async function ensurePayloadParent(
  authority: TransactionAuthority,
  digest: string,
  target: ResolvedTaskPath,
): Promise<void> {
  assertInternalTransactionAuthority(authority);
  if (!/^[0-9a-f]{64}$/u.test(digest)) throw new TypeError("result digest must be lowercase SHA-256");
  const root = join(authority.task_root, "results", "sha256", digest, "payload");
  const parent = join(target, "..");
  const rel = relative(root, parent);
  if (rel === ".." || rel.startsWith(`..${sep}`) || isAbsolute(rel)) throw new TypeError("payload parent escaped result directory");
  await mkdir(parent, { recursive: true });
}

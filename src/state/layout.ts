import { constants as fsConstants } from "node:fs";
import { lstat, mkdir } from "node:fs/promises";
import { isAbsolute, join, relative, sep } from "node:path";

import { parsePathSafeId, type PathSafeId } from "../contracts/evidence.js";
import { parsePhaseInstanceId, type PhaseInstanceId } from "../contracts/phase-instance.js";
import {
  openResolved,
  type ResolvedTaskPath,
  type ResolvedTaskWorkspacePath,
} from "../repository/paths.js";
import { assertInternalTransactionAuthority, type TransactionAuthority } from "./authority.js";

export class IntentLayoutError extends Error {
  public constructor(public readonly stage: "create" | "verify") {
    super(`intent layout ${stage} failed`);
    this.name = "IntentLayoutError";
  }
}

export class ResultLayoutError extends Error {
  public readonly errno?: string;

  public constructor(public readonly stage: "create" | "verify", errno?: string | undefined) {
    super(`result layout ${stage} failed`);
    this.name = "ResultLayoutError";
    if (errno !== undefined) this.errno = errno;
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

type ResolvedLayoutPath = ResolvedTaskPath | ResolvedTaskWorkspacePath;

async function ensureWorkspaceRoot(authority: TransactionAuthority): Promise<void> {
  const archflowRoot = join(authority.task_root, "..", "..");
  const fixed = [
    join(archflowRoot, "runtime"),
    join(archflowRoot, "runtime", "tasks"),
    authority.workspace_root,
  ];
  for (const directory of fixed) await ensureRealDirectory(directory as ResolvedLayoutPath);
}

/** Creates and verifies `runtime/tasks/<task>/transient/intents/`. */
export async function ensureIntentDirectory(authority: TransactionAuthority): Promise<void> {
  assertInternalTransactionAuthority(authority);
  try {
    await ensureWorkspaceRoot(authority);
    await ensureRealDirectory(join(authority.workspace_root, "transient") as ResolvedTaskWorkspacePath);
    await ensureRealDirectory(
      join(authority.workspace_root, "transient", "intents") as ResolvedTaskWorkspacePath,
    );
  } catch (error) {
    throw new IntentLayoutError(
      error instanceof ResultLayoutError && error.stage === "verify" ? "verify" : "create",
    );
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
  const authorityRoot = join(authority.task_root, "authority") as ResolvedTaskPath;
  const decisions = join(authorityRoot, "decisions") as ResolvedTaskPath;
  const gate = join(decisions, validatedGateId) as ResolvedTaskPath;
  await ensureDecisionChild(authorityRoot);
  await ensureDecisionChild(decisions);
  await ensureDecisionChild(gate);
}

/** Creates and verifies ignored `diagnostics/attempts/<phase-instance>/` dispatch records. */
export async function ensureAttemptDirectory(
  authority: TransactionAuthority,
  phaseInstance: PhaseInstanceId,
): Promise<void> {
  assertInternalTransactionAuthority(authority);
  const validated = parsePhaseInstanceId(phaseInstance);
  await ensureWorkspaceRoot(authority);
  await ensureRealDirectory(join(authority.workspace_root, "diagnostics") as ResolvedTaskWorkspacePath);
  await ensureRealDirectory(
    join(authority.workspace_root, "diagnostics", "attempts") as ResolvedTaskWorkspacePath,
  );
  await ensureRealDirectory(
    join(authority.workspace_root, "diagnostics", "attempts", validated) as ResolvedTaskWorkspacePath,
  );
}


async function ensureRealDirectory(path: ResolvedLayoutPath): Promise<void> {
  try {
    await mkdir(path);
  } catch (error) {
    if (errnoOf(error) !== "EEXIST") throw new ResultLayoutError("create", errnoOf(error));
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
    throw new ResultLayoutError("verify", errnoOf(error));
  } finally {
    await handle?.close().catch(() => undefined);
  }
}

/** Creates and verifies the durable task authority root. */
export async function ensureAuthorityDirectory(authority: TransactionAuthority): Promise<void> {
  assertInternalTransactionAuthority(authority);
  await ensureRealDirectory(join(authority.task_root, "authority") as ResolvedTaskPath);
}

/** Creates durable result authority and its ignored payload-cache hierarchy. */
export async function ensureResultDirectory(authority: TransactionAuthority, digest: string): Promise<void> {
  assertInternalTransactionAuthority(authority);
  if (!/^[0-9a-f]{64}$/u.test(digest)) throw new TypeError("result digest must be lowercase SHA-256");
  await ensureAuthorityDirectory(authority);
  await ensureRealDirectory(join(authority.task_root, "authority", "results") as ResolvedTaskPath);
  await ensureWorkspaceRoot(authority);
  const parts = ["cache", "results", digest, "payload"];
  let current = authority.workspace_root as string;
  for (const part of parts) {
    current = join(current, part);
    await ensureRealDirectory(current as ResolvedTaskWorkspacePath);
  }
}

/** Ensures payload subdirectories cannot leave the authenticated result payload root. */
export async function ensurePayloadParent(
  authority: TransactionAuthority,
  digest: string,
  target: ResolvedTaskWorkspacePath,
): Promise<void> {
  assertInternalTransactionAuthority(authority);
  if (!/^[0-9a-f]{64}$/u.test(digest)) throw new TypeError("result digest must be lowercase SHA-256");
  const root = join(authority.workspace_root, "cache", "results", digest, "payload");
  const parent = join(target, "..");
  const rel = relative(root, parent);
  if (rel === ".." || rel.startsWith(`..${sep}`) || isAbsolute(rel)) throw new TypeError("payload parent escaped result directory");
  let current = root;
  for (const part of rel.split(sep).filter((candidate) => candidate !== "" && candidate !== ".")) {
    current = join(current, part);
    await ensureRealDirectory(current as ResolvedTaskWorkspacePath);
  }
}

/** Materializes ignored workspace parents one verified real directory at a time. */
export async function ensureWorkspaceProjectionParent(
  authority: TransactionAuthority,
  target: ResolvedTaskWorkspacePath,
): Promise<void> {
  assertInternalTransactionAuthority(authority);
  const parent = join(target, "..");
  const rel = relative(authority.workspace_root, parent);
  if (rel === ".." || rel.startsWith(`..${sep}`) || isAbsolute(rel)) {
    throw new TypeError("workspace projection parent escaped task workspace");
  }
  await ensureWorkspaceRoot(authority);
  let current = authority.workspace_root as string;
  for (const part of rel.split(sep).filter((candidate) => candidate !== "" && candidate !== ".")) {
    current = join(current, part);
    await ensureRealDirectory(current as ResolvedTaskWorkspacePath);
  }
}

/** Materializes task-local projection parents one verified real directory at a time. */
export async function ensureTaskProjectionParent(
  authority: TransactionAuthority,
  target: ResolvedTaskPath,
): Promise<void> {
  assertInternalTransactionAuthority(authority);
  const parent = join(target, "..");
  const rel = relative(authority.task_root, parent);
  if (rel === ".." || rel.startsWith(`..${sep}`) || isAbsolute(rel)) return;
  let current = authority.task_root as string;
  for (const part of rel.split(sep).filter((candidate) => candidate !== "" && candidate !== ".")) {
    current = join(current, part);
    await ensureRealDirectory(current as ResolvedTaskPath);
  }
}

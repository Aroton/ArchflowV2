import { lstat, readFile, readdir, rm, rmdir, stat, unlink } from "node:fs/promises";
import { basename, dirname, join, relative, sep } from "node:path";

import { parseCanonicalDocument } from "../contracts/canonical.js";
import { validateDurableSemantics } from "../contracts/durable.js";
import { parseIntentReceipt } from "../contracts/durable-intent.js";
import { parseResultManifest, type ResultManifestV1 } from "../contracts/durable-result-manifest.js";
import type { TaskStateV1 } from "../contracts/durable-state.js";
import { parseSafeInteger, type SafeCode, type SafeInteger, type Sha256Digest } from "../contracts/evidence.js";
import type { ProjectResult } from "../contracts/errors.js";
import { createProjectError } from "../contracts/errors.js";
import {
  resolveTaskWorkspaceCleanupTarget,
  type WorkspaceCleanupTarget,
} from "../repository/paths.js";
import { assertInternalTransactionAuthority, type TransactionAuthority } from "./authority.js";
import type { TransactionDependencies } from "./transaction.js";

export type WorkspaceCleanupReport = Readonly<{
  removed_files: SafeInteger;
  removed_bytes: SafeInteger;
  retained_files: SafeInteger;
  retained_bytes: SafeInteger;
  cleanup_pending: boolean;
}>;

type FileEntry = Readonly<{ absolute: string; relative: string; byte_count: number; symlink: boolean }>;

const ok = <T>(value: T): ProjectResult<T> => Object.freeze({ schema_version: "1", ok: true, value });

function io(authority: TransactionAuthority, operation: string): ProjectResult<never> {
  return Object.freeze({
    schema_version: "1",
    ok: false,
    error: createProjectError("IO_ERROR", { operation, attempt: authority.context.attempt }),
  });
}

function inside(root: string, candidate: string): boolean {
  const rel = relative(root, candidate);
  return rel !== "" && rel !== ".." && !rel.startsWith(`..${sep}`);
}

async function filesBelow(root: string): Promise<readonly FileEntry[]> {
  const output: FileEntry[] = [];
  const walk = async (directory: string): Promise<void> => {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const absolute = join(directory, entry.name);
      if (!inside(root, absolute)) throw new TypeError("workspace inventory escaped its root");
      if (entry.isSymbolicLink()) {
        const metadata = await lstat(absolute);
        output.push({ absolute, relative: relative(root, absolute).split(sep).join("/"), byte_count: metadata.size, symlink: true });
      } else if (entry.isDirectory()) {
        await walk(absolute);
      } else if (entry.isFile()) {
        const metadata = await stat(absolute);
        output.push({ absolute, relative: relative(root, absolute).split(sep).join("/"), byte_count: metadata.size, symlink: false });
      } else {
        throw new TypeError("workspace inventory contains an unsupported filesystem object");
      }
    }
  };
  try {
    const rootMetadata = await lstat(root);
    if (rootMetadata.isSymbolicLink()) {
      return Object.freeze([{ absolute: root, relative: "", byte_count: rootMetadata.size, symlink: true }]);
    }
    if (!rootMetadata.isDirectory()) throw new TypeError("task workspace is not a directory");
  } catch (error) {
    if ((error as { code?: unknown }).code === "ENOENT") return Object.freeze([]);
    throw error;
  }
  await walk(root);
  return Object.freeze(output.sort((left, right) => left.relative.localeCompare(right.relative)));
}

function phaseNumber(phaseInstance: string): string | undefined {
  return /^(?:phase-design|phase-impl)-([1-9][0-9]*)$/u.exec(phaseInstance)?.[1];
}

async function receiptIsRecoveryBuffer(entry: FileEntry, state: TaskStateV1): Promise<boolean> {
  if (!/^transient\/intents\/.+\.json$/u.test(entry.relative) || entry.relative.endsWith(".request.json")) return false;
  try {
    const document = parseCanonicalDocument(await readFile(entry.absolute), "intent receipt");
    const receipt = parseIntentReceipt(document.value);
    return receipt.prior_revision === state.revision && receipt.resulting_revision === state.revision + 1;
  } catch {
    // Unknown transaction bytes fail toward retention so a human can inspect or repair them.
    return true;
  }
}

async function shouldRetainWorkspaceEntry(
  entry: FileEntry,
  state: TaskStateV1,
  decisionProtectedResults: ReadonlySet<string>,
): Promise<boolean> {
  if (entry.relative === "transient/.transaction-lock" || entry.relative.startsWith("transient/.transaction-lock/")) return true;
  if (await receiptIsRecoveryBuffer(entry, state)) return true;
  if (/^transient\/intents\/.+\.request\.json$/u.test(entry.relative)) {
    const intentId = basename(entry.relative, ".request.json");
    if (state.last_transition?.intent_id === intentId) return false;
    const receipt = entry.relative.replace(/\.request\.json$/u, ".json");
    try {
      await lstat(join(entry.absolute, "..", basename(receipt)));
      return false;
    } catch (error) {
      return (error as { code?: unknown }).code === "ENOENT";
    }
  }
  if (entry.relative.startsWith("cache/imports/")) return state.phase_instance === "prd";
  if (entry.relative.startsWith("cache/gates/")) return state.open_gate !== undefined;
  if (entry.relative.startsWith(`cache/reviews/${state.phase_instance}`)) return true;
  if (entry.relative.startsWith(`diagnostics/attempts/${state.phase_instance}/`)) return true;
  const currentPhase = phaseNumber(state.phase_instance);
  if (currentPhase !== undefined && entry.relative.startsWith(`cache/phases/${currentPhase}/`)) return true;
  if (entry.relative.startsWith("cache/results/")) {
    const digest = entry.relative.split("/")[2];
    return decisionProtectedResults.has(digest ?? "") || state.authoritative_results.some((reference) =>
      reference.result_digest === digest && reference.phase_instance === state.phase_instance) ||
      (state.human_revision_history ?? []).some((revision) => revision.evidence.some((reference) =>
        reference.result_digest === digest));
  }
  return false;
}

async function referencedDecisionDigests(authority: TransactionAuthority): Promise<ReadonlySet<string>> {
  const root = join(authority.task_root, "authority", "decisions");
  const digests = new Set<string>();
  let files: readonly FileEntry[];
  try {
    files = await filesBelow(root);
  } catch {
    // An unreadable authority graph must fail toward retention.
    return new Set(["*"]);
  }
  const pattern = /\b[0-9a-f]{64}\b/gu;
  for (const file of files) {
    if (file.symlink) return new Set(["*"]);
    const text = await readFile(file.absolute, "utf8").catch(() => "");
    for (const match of text.matchAll(pattern)) digests.add(match[0]!);
  }
  return digests;
}

async function decisionProtectedAuthorityResults(
  authority: TransactionAuthority,
): Promise<ReadonlySet<string>> {
  const root = join(authority.task_root, "authority", "results");
  const decisionDigests = await referencedDecisionDigests(authority);
  let files: readonly FileEntry[];
  try {
    files = await filesBelow(root);
  } catch {
    return new Set(["*"]);
  }
  if (decisionDigests.has("*") || files.some((file) => file.symlink)) return new Set(["*"]);
  const protectedResults = new Set<string>();
  for (const file of files) {
    const digest = /^([0-9a-f]{64})\.json$/u.exec(file.relative)?.[1];
    if (digest === undefined) continue;
    try {
      const document = parseCanonicalDocument<ResultManifestV1>(
        await readFile(file.absolute),
        "result manifest",
      );
      const manifest = parseResultManifest(document.value);
      const semantics = validateDurableSemantics({ result_manifest: document });
      // The filename authenticates the manifest identity. Semantic validation authenticates the
      // artifact digest against the embedded source artifact. No other manifest digest can retain
      // a result merely because it happens to occur in nested metadata.
      if (document.digest !== digest || !semantics.ok) {
        protectedResults.add(digest);
        continue;
      }
      if (decisionDigests.has(digest) || decisionDigests.has(manifest.artifact_digest)) {
        protectedResults.add(digest);
      }
    } catch {
      // Unknown authority bytes fail toward retention so a human can inspect or repair them.
      protectedResults.add(digest);
    }
  }
  return protectedResults;
}

async function unreferencedAuthorityResults(
  authority: TransactionAuthority,
  state: TaskStateV1,
  decisionProtectedResults: ReadonlySet<string>,
): Promise<readonly FileEntry[]> {
  const root = join(authority.task_root, "authority", "results");
  const live = new Set([
    ...state.authoritative_results.map((reference) => reference.result_digest),
    ...(state.human_revision_history ?? []).flatMap((revision) =>
      revision.evidence.map((reference) => reference.result_digest)),
    ...(state.restart_history ?? []).flatMap((restart) => [
      ...restart.superseded_results.map((reference) => reference.result_digest),
      ...(restart.cleared_pending_human_revision?.evidence ?? []).map((reference) => reference.result_digest),
    ]),
  ]);
  if (decisionProtectedResults.has("*")) return Object.freeze([]);
  let files: readonly FileEntry[];
  try {
    files = await filesBelow(root);
  } catch {
    return Object.freeze([]);
  }
  return Object.freeze(files.filter((file) => {
    const digest = /^([0-9a-f]{64})\.json$/u.exec(file.relative)?.[1];
    return digest !== undefined && !live.has(digest as Sha256Digest) && !decisionProtectedResults.has(digest);
  }));
}

async function unreferencedAuthorityDecisions(
  authority: TransactionAuthority,
  state: TaskStateV1,
): Promise<readonly FileEntry[]> {
  const root = join(authority.task_root, "authority", "decisions");
  let groups;
  try { groups = await readdir(root, { withFileTypes: true }); }
  catch (error) {
    return (error as { code?: unknown }).code === "ENOENT" ? Object.freeze([]) : Object.freeze([]);
  }
  if (groups.some((entry) => entry.isSymbolicLink() || (!entry.isDirectory() && !entry.isFile()))) {
    return Object.freeze([]);
  }
  const known = new Set(groups.filter((entry) => entry.isDirectory()).map((entry) => entry.name));
  const openGateIds: string[] = state.open_gate === undefined
    ? []
    : [state.open_gate.gate_id, ...(state.open_gate.waiver_origin_gate_id === undefined ? [] : [state.open_gate.waiver_origin_gate_id])];
  const live = new Set<string>([
    ...state.approvals.map((entry) => entry.gate_id),
    ...state.waivers.map((entry) => entry.gate_id),
    ...openGateIds,
    ...(state.pending_human_revision === undefined ? [] : [state.pending_human_revision.gate_id]),
    ...(state.human_revision_history ?? []).map((entry) => entry.gate_id),
    ...(state.restart_history ?? []).flatMap((restart) => [
      restart.restart_id,
      ...restart.cleared_waivers.map((entry) => entry.gate_id),
      ...(restart.cleared_pending_human_revision === undefined
        ? []
        : [restart.cleared_pending_human_revision.gate_id]),
    ]),
    ...(state.last_transition !== undefined && known.has(state.last_transition.result_id)
      ? [state.last_transition.result_id]
      : []),
  ]);
  let changed = true;
  while (changed) {
    changed = false;
    for (const gateId of [...live]) {
      let entries: readonly FileEntry[];
      try { entries = await filesBelow(join(root, gateId)); }
      catch { return Object.freeze([]); }
      for (const entry of entries) {
        if (entry.symlink) return Object.freeze([]);
        const text = await readFile(entry.absolute, "utf8").catch(() => "");
        for (const candidate of known) {
          if (!live.has(candidate) && text.includes(`\"${candidate}\"`)) {
            live.add(candidate);
            changed = true;
          }
        }
      }
    }
  }
  const stale: FileEntry[] = [];
  for (const gateId of known) {
    if (live.has(gateId)) continue;
    try { stale.push(...await filesBelow(join(root, gateId))); }
    catch { return Object.freeze([]); }
  }
  return Object.freeze(stale);
}

async function removeFile(entry: FileEntry): Promise<void> {
  await unlink(entry.absolute);
}

async function removeEmptyDirectories(root: string, preserve: ReadonlySet<string> = new Set()): Promise<void> {
  let directories: string[] = [];
  const walk = async (directory: string): Promise<void> => {
    let children;
    try { children = await readdir(directory, { withFileTypes: true }); }
    catch (error) { if ((error as { code?: unknown }).code === "ENOENT") return; throw error; }
    for (const child of children) if (child.isDirectory() && !child.isSymbolicLink()) await walk(join(directory, child.name));
    if (!preserve.has(directory)) directories.push(directory);
  };
  await walk(root);
  directories = directories.sort((left, right) => right.length - left.length);
  for (const directory of directories) await rmdir(directory).catch(() => undefined);
}

async function removeEmptyParents(start: string, boundary: string): Promise<void> {
  let current = start;
  while (inside(boundary, current)) {
    try { await rmdir(current); }
    catch { return; }
    current = dirname(current);
  }
}

async function cleanupTarget(
  dependencies: TransactionDependencies,
  authority: TransactionAuthority,
): Promise<ProjectResult<WorkspaceCleanupTarget>> {
  return resolveTaskWorkspaceCleanupTarget({
    runner: dependencies.runner,
    taskId: authority.task_id,
    context: authority.context,
  });
}

/** Read-only projection used by status. */
export async function inspectWorkspaceCleanup(
  dependencies: TransactionDependencies,
  authority: TransactionAuthority,
  state: TaskStateV1,
): Promise<ProjectResult<WorkspaceCleanupReport>> {
  assertInternalTransactionAuthority(authority, { runner: dependencies.runner, environment: dependencies.environment });
  const target = await cleanupTarget(dependencies, authority);
  if (!target.ok) return target;
  try {
    const workspaceFiles = await filesBelow(target.value.absolute);
    const authorityFiles = await filesBelow(join(authority.task_root, "authority"));
    const decisionProtectedResults = await decisionProtectedAuthorityResults(authority);
    const authorityCandidates = [
      ...await unreferencedAuthorityResults(authority, state, decisionProtectedResults),
      ...await unreferencedAuthorityDecisions(authority, state),
    ];
    const candidatePaths = new Set(authorityCandidates.map((entry) => entry.absolute));
    const retainedAuthority = authorityFiles.filter((entry) => !candidatePaths.has(entry.absolute));
    let retainedFiles = retainedAuthority.length;
    let retainedBytes = retainedAuthority.reduce((sum, entry) => sum + entry.byte_count, 0);
    let removableFiles = authorityCandidates.length;
    let removableBytes = authorityCandidates.reduce((sum, entry) => sum + entry.byte_count, 0);
    for (const entry of workspaceFiles) {
      if (await shouldRetainWorkspaceEntry(entry, state, decisionProtectedResults)) {
        retainedFiles += 1;
        retainedBytes += entry.byte_count;
      } else {
        removableFiles += 1;
        removableBytes += entry.byte_count;
      }
    }
    return ok(Object.freeze({
      removed_files: parseSafeInteger(0),
      removed_bytes: parseSafeInteger(0),
      retained_files: parseSafeInteger(retainedFiles),
      retained_bytes: parseSafeInteger(retainedBytes),
      cleanup_pending: removableFiles > 0 || removableBytes > 0,
    }));
  } catch {
    return io(authority, "inspect-workspace-cleanup");
  }
}

/** Best-effort after commit; callers decide whether an error is surfaced or deferred. */
export async function cleanTaskWorkspace(
  dependencies: TransactionDependencies,
  authority: TransactionAuthority,
  state: TaskStateV1,
): Promise<ProjectResult<WorkspaceCleanupReport>> {
  assertInternalTransactionAuthority(authority, { runner: dependencies.runner, environment: dependencies.environment });
  const target = await cleanupTarget(dependencies, authority);
  if (!target.ok) return target;
  try {
    const workspaceFiles = await filesBelow(target.value.absolute);
    const authorityFiles = await filesBelow(join(authority.task_root, "authority"));
    const decisionProtectedResults = await decisionProtectedAuthorityResults(authority);
    const authorityCandidates = [
      ...await unreferencedAuthorityResults(authority, state, decisionProtectedResults),
      ...await unreferencedAuthorityDecisions(authority, state),
    ];
    let removedFiles = 0;
    let removedBytes = 0;
    const candidatePaths = new Set(authorityCandidates.map((entry) => entry.absolute));
    const retainedAuthority = authorityFiles.filter((entry) => !candidatePaths.has(entry.absolute));
    let retainedFiles = retainedAuthority.length;
    let retainedBytes = retainedAuthority.reduce((sum, entry) => sum + entry.byte_count, 0);
    for (const entry of [...workspaceFiles, ...authorityCandidates]) {
      const authorityFile = entry.absolute.startsWith(join(authority.task_root, "authority") + sep);
      if (!authorityFile && await shouldRetainWorkspaceEntry(entry, state, decisionProtectedResults)) {
        retainedFiles += 1;
        retainedBytes += entry.byte_count;
        continue;
      }
      await removeFile(entry);
      await removeEmptyParents(dirname(entry.absolute), authorityFile
        ? join(authority.task_root, "authority")
        : target.value.absolute);
      removedFiles += 1;
      removedBytes += entry.byte_count;
    }
    await removeEmptyDirectories(target.value.absolute, new Set([
      join(target.value.absolute, "transient", ".transaction-lock"),
    ]));
    await removeEmptyDirectories(join(authority.task_root, "authority", "results"));
    await removeEmptyDirectories(join(authority.task_root, "authority", "decisions"));
    return ok(Object.freeze({
      removed_files: parseSafeInteger(removedFiles),
      removed_bytes: parseSafeInteger(removedBytes),
      retained_files: parseSafeInteger(retainedFiles),
      retained_bytes: parseSafeInteger(retainedBytes),
      cleanup_pending: false,
    }));
  } catch {
    return io(authority, "clean-task-workspace");
  }
}

/**
 * Removes the phase documents a backward planning restart just superseded.
 *
 * A restart rewinds the phase and supersedes the results of everything after it, but the abandoned
 * attempt's documents stay in the worktree. The design milestone commit that follows covers the whole
 * task directory, so a leftover `phases/N/impl-notes.md` is swept into a commit that never reviewed
 * it — and the milestone observation then, correctly, refuses to recognize that commit. Since the
 * commit cannot be retried once made, the workflow deadlocks. Clearing the leftover at the restart
 * removes the cause rather than relaxing the check.
 *
 * Only untracked documents are removed. A tracked one is already in history, and deleting it would
 * simply move the same unauthorized change into the commit as a deletion.
 */
export async function removeSupersededPhaseDocuments(
  dependencies: TransactionDependencies,
  authority: TransactionAuthority,
  targetPhaseInstance: string,
): Promise<readonly string[]> {
  // Only planning targets supersede documents. A restart never lands on an implementation phase,
  // and treating one as a target would delete the very notes that phase is meant to keep.
  const planning = /^phase-design-([1-9][0-9]*)$/u.exec(targetPhaseInstance);
  const target = targetPhaseInstance === "prd" || targetPhaseInstance === "design"
    ? 0
    : planning === null ? NaN : Number(planning[1]);
  if (!Number.isInteger(target)) return Object.freeze([]);
  const prefix = `.archflow/tasks/${authority.task_id}/`;
  const untracked = await dependencies.runner.runNulFields({
    argv: [
      "ls-files", "--others", "--exclude-standard", "-z",
      "--", `:(top,literal)${prefix}phases`,
    ],
    operation: "git-restart-superseded-documents" as SafeCode,
  });
  const removed: string[] = [];
  for (const path of untracked) {
    if (!path.startsWith(prefix)) continue;
    const relative = path.slice(prefix.length);
    const document = /^phases\/([1-9][0-9]*)\/(design|impl-notes)\.md$/u.exec(relative);
    if (document === null) continue;
    const phase = Number(document[1]);
    // The target phase's own design is what the restart is about to redo, so it survives; its
    // implementation notes and every later document belong to work the restart abandoned.
    const superseded = document[2] === "impl-notes" ? phase >= target : phase > target;
    if (!superseded) continue;
    const absolute = join(authority.task_root, ...relative.split("/"));
    if (!inside(authority.task_root, absolute)) throw new TypeError("superseded document escaped its task root");
    await unlink(absolute).catch(() => undefined);
    await removeEmptyParents(dirname(absolute), join(authority.task_root, "phases"));
    removed.push(relative);
  }
  return Object.freeze(removed.sort());
}

/** Removes all task-local runtime data after terminal authority is durable. */
export async function cleanTerminalTaskWorkspace(
  dependencies: TransactionDependencies,
  authority: TransactionAuthority,
): Promise<ProjectResult<WorkspaceCleanupReport>> {
  const target = await cleanupTarget(dependencies, authority);
  if (!target.ok) return target;
  try {
    const files = await filesBelow(target.value.absolute);
    await rm(target.value.absolute, { recursive: true, force: true });
    return ok(Object.freeze({
      removed_files: parseSafeInteger(files.length),
      removed_bytes: parseSafeInteger(files.reduce((sum, entry) => sum + entry.byte_count, 0)),
      retained_files: parseSafeInteger(0),
      retained_bytes: parseSafeInteger(0),
      cleanup_pending: false,
    }));
  } catch {
    return io(authority, "clean-terminal-task-workspace");
  }
}

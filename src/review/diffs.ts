import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { createWriteStream } from "node:fs";
import { chmod, lstat, mkdir, rm, symlink, writeFile } from "node:fs/promises";
import { join, relative, resolve } from "node:path";
import { pipeline } from "node:stream/promises";

import { createProjectError } from "../contracts/errors.js";
import type { TaskStateV1 } from "../contracts/durable-state.js";
import type { Sha256Digest } from "../contracts/evidence.js";
import type { DispatchRepositoryViewPlan, DispatchWorkspace } from "../dispatch/workspace.js";
import { readCommitTreeBlob, readGitBlobBytes } from "../repository/git.js";
import type { RootBoundGitRunner } from "../repository/identity.js";
import type { CurrentProduceSubject } from "../state/produce-subject.js";
import { retainedResultReferences } from "../state/retained-result-graph.js";
import type { ProjectionDesired, ProjectionPlan } from "../state/snapshots.js";
import type { TransactionDependencies, RetainedResultInstallation } from "../state/transaction.js";
import type { ReviewDiff, ReviewDiffContext, ReviewDiffFile } from "./envelopes.js";
import type { PriorTriageRecord } from "./pinned-context.js";

export type PreparedReviewDiffs = Readonly<{
  full: ReviewDiff;
  reviewers: ReadonlyMap<string, ReviewDiffContext>;
}>;

type DiffInput = Readonly<{
  workspace: DispatchWorkspace;
  repositories: DispatchRepositoryViewPlan;
  runners: ReadonlyMap<string, RootBoundGitRunner>;
  subject: CurrentProduceSubject;
  state: TaskStateV1;
  dependencies: Pick<TransactionDependencies, "load_retained_manifest" | "load_retained_result">;
  prior_triage?: PriorTriageRecord;
  signal: AbortSignal;
}>;

const visiblePath = (path: string): boolean => path !== ".archflow" && !path.startsWith(".archflow/");
const ordinal = (a: string, b: string): number => a < b ? -1 : a > b ? 1 : 0;
const UNAVAILABLE = "The previous reviewed implementation could not be reconstructed. Start with the complete implementation diff and the supplied prior feedback.";

/** Materialize only authenticated paths, without following repository-owned symlinks. */
async function writeImage(root: string, path: string, image: ProjectionDesired): Promise<void> {
  if (image.state === "absent") return;
  const target = resolve(root, path);
  const local = relative(root, target);
  if (!local || local === ".." || local.startsWith("../") || local.startsWith("/")) {
    throw new TypeError("review diff path escapes its temporary tree");
  }
  let parent = root;
  for (const segment of local.split("/").slice(0, -1)) {
    parent = join(parent, segment);
    try {
      if (!(await lstat(parent)).isDirectory()) throw new TypeError("review diff path crosses a non-directory");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      await mkdir(parent);
    }
  }
  if (image.file_type === "symlink") await symlink(new TextDecoder("utf-8", { fatal: true }).decode(image.bytes), target);
  else {
    const mode = image.mode === "100755" ? 0o755 : 0o644;
    await writeFile(target, image.bytes, { mode, flag: "wx" });
    await chmod(target, mode);
  }
}

/** A file transport: stdout is streamed, never constrained by the child-report or envelope caps. */
async function gitDiffFile(
  cwd: string, output: string, flags: readonly string[], signal: AbortSignal,
): Promise<Omit<ReviewDiffFile, "path">> {
  const child = spawn("git", ["--no-pager", "-c", "core.quotePath=true", "-c", "core.fileMode=true",
    "diff", "--no-index", "--no-prefix", "--no-color", "--no-ext-diff", "--no-textconv",
    "--find-renames", "--unified=3", ...flags, "--", "a", "b"], {
    cwd,
    env: { PATH: process.env.PATH, LC_ALL: "C", GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null" },
    stdio: ["ignore", "pipe", "pipe"], signal,
  });
  let timedOut = false;
  const deadline = setTimeout(() => { timedOut = true; child.kill("SIGKILL"); }, 60_000);
  deadline.unref();
  const hash = createHash("sha256");
  let bytes = 0;
  child.stdout.on("data", (chunk: Buffer) => { hash.update(chunk); bytes += chunk.byteLength; });
  // Drain diagnostics, but never retain arbitrary Git output or source text in public errors.
  child.stderr.resume();
  const exited = new Promise<void>((accept, reject) => {
    child.once("error", reject);
    child.once("close", (code) => code === 0 || code === 1
      ? accept() : reject(new Error(timedOut ? "review diff generation timed out" : "review diff generation failed")));
  });
  try {
    await Promise.all([exited, pipeline(child.stdout, createWriteStream(output, { flags: "wx", mode: 0o600 }))]);
    await chmod(output, 0o444);
    return { content_digest: hash.digest("hex") as Sha256Digest, byte_count: bytes };
  } finally {
    clearTimeout(deadline);
    if (child.exitCode === null) child.kill("SIGKILL");
  }
}

async function comparison(
  input: DiffInput, label: string, previous?: Readonly<{ digest: Sha256Digest; plans: ReadonlyMap<string, ProjectionPlan> }>,
): Promise<ReviewDiff> {
  const directory = join(input.workspace.root, "review-diffs");
  await mkdir(directory, { recursive: true });
  const trees = join(directory, `${label}-trees`);
  await mkdir(join(trees, "a"), { recursive: true });
  await mkdir(join(trees, "b"), { recursive: true });
  try {
    for (const repository of input.repositories) {
      const before = new Map(previous?.plans.get(repository.name)?.entries.map(entry => [String(entry.path), entry.desired]));
      const after = new Map(repository.projection_plan?.entries.map(entry => [String(entry.path), entry.desired]));
      const paths = [...new Set([...before.keys(), ...after.keys()])].filter(visiblePath).sort(ordinal);
      const runner = input.runners.get(repository.name);
      if (runner === undefined) throw new TypeError("review diff repository is unavailable");
      for (const path of paths) {
        let baseline: ProjectionDesired = { state: "absent" };
        if (!before.has(path) || !after.has(path)) {
          const blob = await readCommitTreeBlob(runner, repository.commit, path);
          if (blob !== undefined) baseline = {
            state: "present", file_type: blob.mode === "120000" ? "symlink" : "regular",
            mode: blob.mode, bytes: await readGitBlobBytes(runner, blob.oid),
          } as ProjectionDesired;
        }
        const display = input.repositories.length === 1 ? path : `${repository.name}/${path}`;
        await writeImage(join(trees, "a"), display, before.get(path) ?? baseline);
        await writeImage(join(trees, "b"), display, after.get(path) ?? baseline);
      }
    }
    const patchPath = join(directory, `${label}.patch`);
    const statPath = join(directory, `${label}.stat`);
    const patch = await gitDiffFile(trees, patchPath, ["--patch"], input.signal);
    const stat = await gitDiffFile(trees, statPath, ["--numstat", "--summary"], input.signal);
    const childPath = (path: string): string => relative(input.workspace.repository_view_root!, path);
    return {
      kind: previous === undefined ? "implementation" : "revision",
      subject_digest: input.subject.artifact_digest,
      ...(previous === undefined ? {} : { base_subject_digest: previous.digest }),
      patch: { path: childPath(patchPath), ...patch },
      stat: { path: childPath(statPath), ...stat },
    };
  } finally {
    await rm(trees, { recursive: true, force: true });
  }
}

/** Historical lookup is limited to retained produce references for this task and phase. */
async function previousPlans(input: DiffInput, digest: Sha256Digest): Promise<ReadonlyMap<string, ProjectionPlan> | undefined> {
  const { load_retained_manifest: manifest, load_retained_result: payload } = input.dependencies;
  if (manifest === undefined || payload === undefined) return undefined;
  const matches = [];
  for (const reference of retainedResultReferences(input.state)) {
    if (reference.phase_instance !== input.state.phase_instance || reference.step !== "produce") continue;
    const loaded = await manifest(reference);
    if (loaded.ok && loaded.value.manifest.value.artifact_digest === digest) matches.push(reference);
  }
  if (matches.length !== 1) return undefined;
  const loaded = await payload(matches[0]!);
  if (!loaded.ok) return undefined;
  const retained: RetainedResultInstallation = loaded.value;
  const artifact = retained.prepared.manifest.value.source_artifact;
  if (artifact.artifact_kind !== "implementation-output" || artifact.task_id !== input.state.task_id ||
      artifact.phase_instance !== input.state.phase_instance || artifact.base_commit !== input.repositories[0]?.commit) return undefined;
  const plans = new Map<string, ProjectionPlan>([["primary", retained.projection_plan]]);
  for (const secondary of retained.secondary_projection_plans ?? []) {
    const current = input.repositories.find(repository => repository.name === secondary.repository);
    if (current === undefined || current.commit !== secondary.base_commit ||
        current.repository_identity_digest !== secondary.repository_identity_digest) return undefined;
    plans.set(secondary.repository, secondary.projection_plan);
  }
  return plans;
}

/** Full implementation context plus one cached delta per distinct reviewer baseline. */
export async function prepareImplementationDiffs(input: DiffInput): Promise<PreparedReviewDiffs> {
  if (input.subject.artifact.artifact_kind !== "implementation-output") throw new TypeError("diffs require implementation output");
  let full: ReviewDiff;
  try { full = await comparison(input, "full"); }
  catch {
    if (input.signal.aborted) throw createProjectError("CANCELLED", { source: "client", attempt: input.state.attempt ?? 1 });
    throw createProjectError("IO_ERROR", { operation: "review-diff-generation", attempt: input.state.attempt ?? 1 });
  }
  const reviewers = new Map<string, ReviewDiffContext>();
  const previous = input.prior_triage?.source_review?.evidence;
  const response = input.prior_triage?.response;
  const reports = previous?.schema_version === "4"
    ? new Map([...(previous.previous_reports ?? []), ...previous.reports].map(report => [report.reviewer_id, report]))
    : new Map();
  const comparisons = new Map<Sha256Digest, ReviewDiff | undefined>();
  if (response?.decision === "revise") for (const selected of response.reviewers) {
    input.signal.throwIfAborted();
    const digest = reports.get(selected.reviewer_id)?.subject_digest as Sha256Digest | undefined;
    if (digest !== undefined && !comparisons.has(digest)) {
      // An unavailable historical baseline removes convenience, never current review authority.
      let plans: ReadonlyMap<string, ProjectionPlan> | undefined;
      try { plans = await previousPlans(input, digest); } catch { input.signal.throwIfAborted(); }
      let revision: ReviewDiff | undefined;
      if (plans !== undefined) {
        try { revision = await comparison(input, `since-${digest}`, { digest, plans }); }
        catch { input.signal.throwIfAborted(); }
      }
      comparisons.set(digest, revision);
    }
    const revision = digest === undefined ? undefined : comparisons.get(digest);
    reviewers.set(selected.reviewer_id, revision === undefined
      ? { full, revision_unavailable: UNAVAILABLE } : { full, revision });
  }
  return { full, reviewers };
}

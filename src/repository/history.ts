import { stat } from "node:fs/promises";
import { join } from "node:path";

import { historyIdentityDigest, parseGitOid, type GitOid } from "../contracts/canonical.js";
import {
  createProjectError,
  type ProjectError,
  type ProjectResult,
} from "../contracts/errors.js";
import { parseSafeInteger, type SafeCode, type SafeInteger } from "../contracts/evidence.js";
import {
  rawGitPath,
  tryRepositoryPathClaim,
  type RawGitPath,
  type RepositoryPathClaim,
} from "../contracts/path-claims.js";
import {
  GitInvocationError,
  projectErrorForGitFailure,
  type ExpectedAbsence,
  type RepositoryOperationContext,
} from "./git.js";
import type { RootBoundGitRunner } from "./identity.js";

/**
 * **Honesty constraint, repeated verbatim from the architecture.** This module detects *divergent
 * history and conflicts*. It explicitly does **not** claim to detect independent-clone concurrency
 * before divergence: two clones can each hold a consistent, conflict-free, non-diverged history and
 * still be mutating the same task. Locking and revision CAS coordinate only processes sharing one
 * filesystem; Git is transport and history, **not** a distributed lock. Nothing below should be read
 * as a concurrency control.
 */

export type UpstreamState =
  | Readonly<{ kind: "no-upstream" }>
  | Readonly<{
      kind: "tracked";
      upstream: string;
      ahead: number;
      behind: number;
      upstreamOid: GitOid;
    }>;

export const IN_PROGRESS_OPERATIONS = [
  "merge",
  "rebase-merge",
  "rebase-apply",
  "cherry-pick",
  "revert",
] as const;
export type InProgressOperation = (typeof IN_PROGRESS_OPERATIONS)[number];

export interface WorktreeHistoryStatus {
  /** `undefined` **only** for unborn HEAD, which porcelain v2 reports as `branch.oid (initial)`. */
  readonly head: GitOid | undefined;
  readonly branch: string | "(detached)";
  readonly upstream: UpstreamState;
  readonly inProgress: readonly InProgressOperation[];
  /** Validated: an unrepresentable `.archflow/` name is a `TASK_INVALID`, since we own that tree. */
  readonly conflictedArchflowPaths: readonly RepositoryPathClaim[];
  /** Raw: a valid repository may legitimately contain names ArchFlow claims cannot express. */
  readonly conflictedOtherPaths: readonly RawGitPath[];
  readonly unrepresentableOtherConflicts: SafeInteger;
}

const STATUS_OPERATION = "git-status" as SafeCode;
const UNMERGED_OPERATION = "git-diff-unmerged" as SafeCode;
const UPSTREAM_OID_OPERATION = "git-rev-parse-upstream" as SafeCode;
const AHEAD_BEHIND_OPERATION = "git-rev-list-ahead-behind" as SafeCode;
const PATH_MISMATCH = "git-path-mismatch" as SafeCode;

/** The prefix of the tree ArchFlow owns, and therefore the only tree whose names must be valid. */
const ARCHFLOW_PREFIX = ".archflow/";

/** Porcelain v2 spells an unborn HEAD's object name this way rather than omitting the header. */
const INITIAL_OID = "(initial)";

/**
 * `git rev-parse --verify --quiet` exits 1 and writes nothing when the revision does not resolve.
 * The empty `stderrIncludes` is scoped to this one command exactly as in `identity.ts`: `--quiet`
 * suppresses the diagnostic, so there is no substring to match, and exit 1 is a code no fatal path
 * uses. This is never a bare-128 absence.
 */
const UNRESOLVED_REVISION: readonly ExpectedAbsence[] = [{ code: 1, stderrIncludes: "" }];

/**
 * `git rev-list … '@{upstream}…HEAD'` exits 128 with this exact diagnostic when the branch has no
 * upstream — declared per command, with the diagnostic, rather than inferred from the exit code.
 */
const NO_UPSTREAM_CONFIGURED: readonly ExpectedAbsence[] = [
  { code: 128, stderrIncludes: "no upstream configured" },
];

/** Marker → the operation it proves. `rebase-merge` and `rebase-apply` are **directories**. */
const IN_PROGRESS_MARKERS: readonly (readonly [InProgressOperation, string])[] = [
  ["merge", "MERGE_HEAD"],
  ["rebase-merge", "rebase-merge"],
  ["rebase-apply", "rebase-apply"],
  ["cherry-pick", "CHERRY_PICK_HEAD"],
  ["revert", "REVERT_HEAD"],
];

function ok<T>(value: T): ProjectResult<T> {
  return Object.freeze({ schema_version: "1", ok: true, value });
}

function fail<T>(error: ProjectError): ProjectResult<T> {
  return Object.freeze({ schema_version: "1", ok: false, error });
}

function ioError(context: RepositoryOperationContext): ProjectError {
  return createProjectError("IO_ERROR", {
    operation: context.operation,
    attempt: context.attempt,
  });
}

function taskInvalid(context: RepositoryOperationContext, issueCode: SafeCode): ProjectError {
  return createProjectError("TASK_INVALID", {
    task_id: context.task_id,
    issue_code: issueCode,
  });
}

function errnoOf(error: unknown): string | undefined {
  const code = (error as { code?: unknown } | null)?.code;
  return typeof code === "string" ? code : undefined;
}

/**
 * Existence, accepting **directories as well as files**. `rebase-merge/` and `rebase-apply/` are
 * directories, so a file-only check (`readFile`, `open`) would silently miss every rebase.
 */
async function markerExists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch (error) {
    const code = errnoOf(error);
    if (code === "ENOENT" || code === "ENOTDIR") return false;
    throw error;
  }
}

/**
 * In-progress markers live under the **absolute git dir** — `WorktreeLocation.gitDir`, which is
 * per-worktree, so a linked worktree's own rebase is seen and a sibling's is not.
 *
 * This runs **before** anything reads the branch name, and that ordering is the point: during a
 * rebase `# branch.head` reads `(detached)`, so any branch-name logic silently breaks mid-rebase
 * unless the rebase is detected first. `REBASE_HEAD` is deliberately not the probe — the two
 * `rebase-*` directories are what distinguish the merge and apply backends.
 */
async function detectInProgress(gitDir: string): Promise<readonly InProgressOperation[]> {
  const found: InProgressOperation[] = [];
  for (const [operation, marker] of IN_PROGRESS_MARKERS) {
    if (await markerExists(join(gitDir, marker))) found.push(operation);
  }
  return Object.freeze(found);
}

interface PorcelainBranch {
  readonly oid: string | undefined;
  readonly head: string | undefined;
  readonly upstream: string | undefined;
  readonly ahead: number | undefined;
  readonly behind: number | undefined;
}

const AHEAD_BEHIND = /^\+(?<ahead>\d+) -(?<behind>\d+)$/u;

/**
 * Defensive porcelain v2 parsing over `-z` fields.
 *
 * `-z` matters: without it, unusual paths are backslash-quoted per `core.quotePath`. The one wrinkle
 * is that in `-z` mode the rename/copy `2` lines put the **original path in a separate
 * NUL-terminated field**, so field counts differ by entry type — the loop below therefore consumes
 * that extra field explicitly rather than assuming one field per entry.
 *
 * Dispatch is on the first token (`1`, `2`, `u`, `?`, `!`, `#`) and **unrecognised headers are
 * ignored rather than fatal**, because porcelain v2 is documented as an extensible set of optional
 * headers while v1 carries the backward-compatibility guarantee. Porcelain v2 has existed since Git
 * 2.11 (2016) and adds no version floor of its own.
 */
function parsePorcelain(fields: readonly string[]): PorcelainBranch {
  let oid: string | undefined;
  let head: string | undefined;
  let upstream: string | undefined;
  let ahead: number | undefined;
  let behind: number | undefined;

  for (let index = 0; index < fields.length; index += 1) {
    const field = fields[index] ?? "";
    if (field === "") continue;
    const space = field.indexOf(" ");
    const token = space < 0 ? field : field.slice(0, space);

    if (token === "2") {
      // The rename/copy original path is its own NUL field in `-z` mode.
      index += 1;
      continue;
    }
    if (token !== "#" || space < 0) continue;

    const rest = field.slice(space + 1);
    const separator = rest.indexOf(" ");
    if (separator < 0) continue;
    const key = rest.slice(0, separator);
    const value = rest.slice(separator + 1);

    if (key === "branch.oid") oid = value;
    else if (key === "branch.head") head = value;
    else if (key === "branch.upstream") upstream = value;
    else if (key === "branch.ab") {
      const matched = AHEAD_BEHIND.exec(value);
      if (matched?.groups !== undefined) {
        ahead = Number(matched.groups["ahead"]);
        behind = Number(matched.groups["behind"]);
      }
    }
    // Every other `#` header — present or future — is ignored, not fatal.
  }

  return { oid, head, upstream, ahead, behind };
}

/**
 * Resolves the upstream state.
 *
 * **The critical gotcha:** with no upstream configured, `# branch.upstream` and `# branch.ab` are
 * *silently absent*. A missing `branch.ab` must **never** be read as "0 ahead, 0 behind" — for a
 * task branch that has never been pushed, "no upstream" is the normal state, and it is a distinct
 * one, so it is handled first and returns before any counting happens.
 *
 * `git rev-list --left-right --count '@{upstream}...HEAD'` is a **secondary source only**: three
 * dots are required, **left is behind and right is ahead**, and the command *fails* without an
 * upstream. It is consulted only when an upstream exists but `branch.ab` is absent, which is what
 * `status --no-ahead-behind` produces.
 */
async function resolveUpstream(
  runner: RootBoundGitRunner,
  branch: PorcelainBranch
): Promise<UpstreamState> {
  const NO_UPSTREAM: UpstreamState = Object.freeze({ kind: "no-upstream" });
  if (branch.upstream === undefined) return NO_UPSTREAM;

  const upstreamOidText = await runner.runText({
    argv: ["rev-parse", "--verify", "--quiet", `${branch.upstream}^{commit}`],
    operation: UPSTREAM_OID_OPERATION,
    expectedAbsence: UNRESOLVED_REVISION,
  });
  // Configured but never fetched: there is no upstream commit to compare against, so reporting a
  // tracked state with invented counts would be a lie.
  if (upstreamOidText === "") return NO_UPSTREAM;

  let ahead = branch.ahead;
  let behind = branch.behind;
  if (ahead === undefined || behind === undefined) {
    const counts = await runner.runText({
      argv: ["rev-list", "--left-right", "--count", "@{upstream}...HEAD"],
      operation: AHEAD_BEHIND_OPERATION,
      expectedAbsence: NO_UPSTREAM_CONFIGURED,
    });
    const parts = counts.split(/\s+/u).filter((part) => part !== "");
    if (parts.length !== 2) return NO_UPSTREAM;
    behind = Number(parts[0]);
    ahead = Number(parts[1]);
    if (!Number.isInteger(ahead) || !Number.isInteger(behind)) return NO_UPSTREAM;
  }

  return Object.freeze({
    kind: "tracked",
    upstream: branch.upstream,
    ahead,
    behind,
    upstreamOid: parseGitOid(upstreamOidText),
  });
}

/**
 * Reads the worktree's history position, in-progress operations, and conflicted paths.
 *
 * Conflicts come from `git diff --name-only --diff-filter=U -z`, the cleanest conflicted-path
 * primitive; porcelain `u` lines carry all three stage OIDs and modes when richer data is wanted,
 * and the unmerged XY codes are `DD`, `AU`, `UD`, `UA`, `DU`, `AA`, `UU`.
 *
 * **The raw/validated split is the whole point of having two path types.** A conflicted `.archflow/`
 * path is *validated* into a `RepositoryPathClaim`, because we own that tree and an unrepresentable
 * name there is our own bug. A conflicted path anywhere else stays a `RawGitPath`: a valid
 * repository may legitimately hold a name with a colon, a trailing dot, non-NFC text, a reserved
 * device name, or a newline, and `tryRepositoryPathClaim` is the only promotion — it returns
 * `undefined` rather than throwing so those names can be *counted* in
 * `unrepresentableOtherConflicts`. This must never throw while merely checking for unrelated
 * conflicts.
 */
export async function readHistoryStatus(
  runner: RootBoundGitRunner,
  context: RepositoryOperationContext
): Promise<ProjectResult<WorktreeHistoryStatus>> {
  try {
    // Rebase first: `# branch.head` reads `(detached)` mid-rebase.
    const inProgress = await detectInProgress(runner.location.gitDir);

    const statusFields = await runner.runNulFields({
      argv: ["status", "--porcelain=v2", "--branch", "-z"],
      operation: STATUS_OPERATION,
    });
    const branch = parsePorcelain(statusFields);

    let head: GitOid | undefined;
    if (branch.oid !== undefined && branch.oid !== INITIAL_OID) {
      try {
        head = parseGitOid(branch.oid);
      } catch {
        // Git produced an object name we cannot parse. The failure map has no row for malformed
        // output, and IO_ERROR is the row that covers a command that did not deliver usable data.
        return fail(ioError(context));
      }
    }

    const upstream = await resolveUpstream(runner, branch);

    const conflicted = await runner.runNulFields({
      argv: ["diff", "--name-only", "--diff-filter=U", "-z"],
      operation: UNMERGED_OPERATION,
    });

    const conflictedArchflowPaths: RepositoryPathClaim[] = [];
    const conflictedOtherPaths: RawGitPath[] = [];
    let unrepresentable = 0;

    for (const path of conflicted) {
      if (path === "") continue;
      const raw = rawGitPath(path);
      if (path.startsWith(ARCHFLOW_PREFIX)) {
        const claim = tryRepositoryPathClaim(raw);
        if (claim === undefined) {
          // Same family as the failure map's "a returned path is not the requested claim" row: Git
          // returned a name inside the tree we own that cannot be a claim at all.
          return fail(taskInvalid(context, PATH_MISMATCH));
        }
        conflictedArchflowPaths.push(claim);
        continue;
      }
      conflictedOtherPaths.push(raw);
      if (tryRepositoryPathClaim(raw) === undefined) unrepresentable += 1;
    }

    return ok<WorktreeHistoryStatus>(
      Object.freeze({
        head,
        branch: branch.head ?? "(detached)",
        upstream,
        inProgress,
        conflictedArchflowPaths: Object.freeze(conflictedArchflowPaths),
        conflictedOtherPaths: Object.freeze(conflictedOtherPaths),
        unrepresentableOtherConflicts: parseSafeInteger(unrepresentable),
      })
    );
  } catch (error) {
    if (error instanceof GitInvocationError) {
      return fail(projectErrorForGitFailure(error, runner, context));
    }
    if (errnoOf(error) !== undefined) return fail(ioError(context));
    throw error;
  }
}

/**
 * `ProjectResult<void>`, not a third shape: success carries no value, failure carries the code.
 *
 * The context is an argument because **none** of the three codes can be constructed from a
 * `WorktreeHistoryStatus` alone — `GIT_CONFLICT` needs `operation`, `GIT_DIVERGED` needs a digest
 * pair, and `HANDOFF_REQUIRED` needs `phase_instance`. `UpstreamState.tracked` carries `upstreamOid`
 * for exactly that reason.
 *
 * `GIT_DIVERGED`'s parameters are **sha256 digests, not raw OIDs**, because
 * `PROJECT_PARAMETER_SCHEMAS` requires `/^[0-9a-f]{64}$/`. Hashing each OID through chunk 1's shared
 * `historyIdentityDigest` satisfies that without inventing a per-chunk encoding, and sharing the
 * helper is what stops two chunks constructing the same error with different digests.
 *
 * Order is the failure map's order: an `.archflow/` conflict is the most specific and most
 * actionable condition, divergence next, and a merely in-progress operation last.
 */
export function classifyMutationReadiness(
  status: WorktreeHistoryStatus,
  context: RepositoryOperationContext
): ProjectResult<void> {
  if (status.conflictedArchflowPaths.length > 0) {
    return fail(createProjectError("GIT_CONFLICT", { operation: context.operation }));
  }

  const upstream = status.upstream;
  if (
    upstream.kind === "tracked" &&
    upstream.ahead !== 0 &&
    upstream.behind !== 0 &&
    status.head !== undefined
  ) {
    return fail(
      createProjectError("GIT_DIVERGED", {
        expected_digest: historyIdentityDigest(upstream.upstreamOid),
        observed_digest: historyIdentityDigest(status.head),
      })
    );
  }

  if (status.inProgress.length > 0) {
    return fail(createProjectError("HANDOFF_REQUIRED", { phase_instance: context.phase_instance }));
  }

  return ok<void>(undefined);
}

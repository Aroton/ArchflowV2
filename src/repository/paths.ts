import { constants as fsConstants } from "node:fs";
import { lstat, open, realpath, type FileHandle } from "node:fs/promises";
import {
  basename,
  dirname,
  isAbsolute,
  join,
  relative,
  resolve as resolvePath,
  sep,
  win32,
} from "node:path";

import {
  createProjectError,
  type ProjectError,
  type ProjectResult,
} from "../contracts/errors.js";
import { parseTaskSlug, type PathSafeId, type TaskSlug } from "../contracts/evidence.js";
import type { PhaseInstanceId } from "../contracts/phase-instance.js";
import {
  parseRepositoryPathClaim,
  parseTaskPathClaim,
  toRepositoryPathClaim,
  type PathClass,
  type RepositoryPathClaim,
  type RepositoryPathClass,
  type TaskPathClaim,
  type TaskPathClass,
} from "../contracts/path-claims.js";
import type { ClaimableOutputPathClass } from "../contracts/durable-primitives.js";
import type { RepositoryOperationContext } from "./git.js";
import type { RootBoundGitRunner } from "./identity.js";

declare const resolvedTaskPathBrand: unique symbol;
declare const workspacePathClaimBrand: unique symbol;
declare const resolvedTaskWorkspacePathBrand: unique symbol;
declare const resolvedWorkspaceCleanupTargetBrand: unique symbol;

/**
 * A path proven contained under the worktree root by `realpath` **at resolution time**.
 *
 * The brand records a historical fact, not a standing guarantee. See the containment notes on
 * {@link containedUnder}: this is a check-then-use control with an inherent TOCTOU window, and the
 * brand deliberately does not claim otherwise.
 */
export type ResolvedTaskPath = string & { readonly [resolvedTaskPathBrand]: true };

/** A lexical claim rooted at `.archflow/work/tasks/<task-id>/`. */
export type WorkspacePathClaim = string & { readonly [workspacePathClaimBrand]: true };

/** A workspace path proven contained beneath the active task's ignored workspace. */
export type ResolvedTaskWorkspacePath = string & {
  readonly [resolvedTaskWorkspacePathBrand]: true;
};

/**
 * A recursive-removal target whose ancestors were authenticated without resolving the target
 * itself. Keeping this brand distinct prevents a normal read/write path from accidentally being
 * used as a cleanup root (or vice versa).
 */
export type ResolvedWorkspaceCleanupTarget = string & {
  readonly [resolvedWorkspaceCleanupTargetBrand]: true;
};

export interface ResolvedPath {
  readonly path_class: PathClass;
  readonly repositoryRelative: RepositoryPathClaim;
  readonly absolute: ResolvedTaskPath;
}

export const WORKSPACE_PATH_CLASSES = [
  "workspace-intent",
  "workspace-staged-request",
  "workspace-lock",
  "workspace-result-payload",
  "workspace-review",
  "workspace-gate-interface",
  "workspace-verification-transcript",
  "workspace-import",
  "workspace-attempt",
  "workspace-scratch",
] as const;

export type WorkspacePathClass = (typeof WORKSPACE_PATH_CLASSES)[number];

export interface ResolvedWorkspacePath {
  readonly path_class: WorkspacePathClass;
  readonly workspaceRelative: WorkspacePathClaim;
  readonly repositoryRelative: RepositoryPathClaim;
  readonly absolute: ResolvedTaskWorkspacePath;
}

export type WorkspaceCleanupLeafKind = "missing" | "symlink" | "directory" | "file" | "other";

export interface WorkspaceCleanupTarget {
  readonly workspaceRelative: WorkspacePathClaim | "";
  readonly repositoryRelative: RepositoryPathClaim;
  readonly absolute: ResolvedWorkspaceCleanupTarget;
  readonly leaf_kind: WorkspaceCleanupLeafKind;
}

export type ResolvedSourcePath = Readonly<{
  sourceRelative: RepositoryPathClaim;
  absolute: ResolvedTaskPath;
}>;

export function gateRequestClaim(gateId: PathSafeId): TaskPathClaim {
  return parseTaskPathClaim(`authority/decisions/${gateId}/request.json`);
}

/** The ignored staged-request slot for one intent. */
export function stagedRequestClaim(intentId: PathSafeId): WorkspacePathClaim {
  return parseWorkspacePathClaim(`transient/intents/${intentId}.request.json`);
}

export function gateDecisionClaim(gateId: PathSafeId): TaskPathClaim {
  return parseTaskPathClaim(`authority/decisions/${gateId}/decision.json`);
}

export function gateSupplementalReviewClaim(gateId: PathSafeId): TaskPathClaim {
  return parseTaskPathClaim(`authority/decisions/${gateId}/supplemental-review.json`);
}

export function initializationAuthorityClaim(): TaskPathClaim {
  return parseTaskPathClaim("authority/initialization.json");
}

export function resultAuthorityClaim(resultDigest: string): TaskPathClaim {
  if (!/^[0-9a-f]{64}$/u.test(resultDigest)) {
    throw new TypeError("result digest must be lowercase SHA-256");
  }
  return parseTaskPathClaim(`authority/results/${resultDigest}.json`);
}

export function intentReceiptClaim(intentId: PathSafeId): WorkspacePathClaim {
  return parseWorkspacePathClaim(`transient/intents/${intentId}.json`);
}

export function verificationTranscriptClaim(phase: number): WorkspacePathClaim {
  if (!Number.isSafeInteger(phase) || phase < 1) {
    throw new TypeError("phase must be a positive safe integer");
  }
  return parseWorkspacePathClaim(`cache/phases/${phase}/verification.txt`);
}

export function counterReviewClaim(phaseInstance: PhaseInstanceId): WorkspacePathClaim {
  return parseWorkspacePathClaim(`cache/reviews/${phaseInstance}.counter.md`);
}

export function triageReviewClaim(phaseInstance: PhaseInstanceId): WorkspacePathClaim {
  return parseWorkspacePathClaim(`cache/reviews/${phaseInstance}.triage.md`);
}

export function adjudicationReviewClaim(phaseInstance: PhaseInstanceId): WorkspacePathClaim {
  return parseWorkspacePathClaim(`cache/reviews/${phaseInstance}.adjudication.md`);
}

export function gateCounterReviewClaim(
  phaseInstance: PhaseInstanceId,
  gateId: PathSafeId,
): WorkspacePathClaim {
  return parseWorkspacePathClaim(
    `cache/reviews/${phaseInstance}.gate-counter.${gateId}.md`,
  );
}

// ---------------------------------------------------------------------------
// The class table
// ---------------------------------------------------------------------------

/**
 * Identifier vocabularies, spelled once. Each fragment is the regular-expression form of exactly one
 * branded contract type, so a template cannot silently admit a wider identifier than the type it
 * claims to carry:
 *
 * | Fragment          | Contract type                                |
 * |-------------------|----------------------------------------------|
 * | `PATH_SAFE_ID`    | `PathSafeId` (`evidence.ts`)                 |
 * | `SHA256`          | `Sha256Digest` — already a strict subset of `PathSafeId` |
 * | `PHASE_INSTANCE`  | `PhaseInstanceId` (`phase-instance.ts`)      |
 * | `PHASE_NUMBER`    | `PositiveSafePhaseNumber`                    |
 */
const PATH_SAFE_ID = "[A-Za-z0-9][A-Za-z0-9._-]{0,127}";
const SHA256 = "[0-9a-f]{64}";
const PHASE_INSTANCE = "(?:prd|design|phase-design-[1-9][0-9]*|phase-impl-[1-9][0-9]*)";
const PHASE_NUMBER = "[1-9][0-9]*";

interface ClassRule<C extends string> {
  readonly path_class: C;
  readonly pattern: RegExp;
}

const anchored = (body: string): RegExp => new RegExp(`^${body}$`, "u");

/**
 * Every task-scoped class, its template, and the identifiers the template requires. Paths are
 * relative to `.archflow/tasks/<task-id>/`.
 *
 * | Class               | Template                                                                                  | Required identifiers            |
 * |---------------------|-------------------------------------------------------------------------------------------|---------------------------------|
 * | `task-config`       | `config.yaml`                                                                               | —                               |
 * | `task-state`        | `state.json`                                                                                | —                               |
 * | `task-ask`          | `ask.md`                                                                                    | —                               |
 * | `document`          | `prd.md` \| `design.md` \| `phases/<n>/design.md` \| `phases/<n>/impl-notes.md`             | positive phase number           |
 * | `authority-initialization` | `authority/initialization.json`                                                   | —                               |
 * | `authority-result`  | `authority/results/<result-digest>.json`                                                   | result digest                   |
 * | `authority-decision`| `authority/decisions/<gate-id>/{request,decision,supplemental-review}.json`                  | gate ID                         |
 */
const TASK_CLASS_RULES: readonly ClassRule<TaskPathClass>[] = [
  { path_class: "task-config", pattern: anchored("config\\.yaml") },
  { path_class: "task-state", pattern: anchored("state\\.json") },
  { path_class: "task-ask", pattern: anchored("ask\\.md") },
  {
    path_class: "document",
    pattern: anchored(
      `(?:prd\\.md|design\\.md|phases/${PHASE_NUMBER}/design\\.md|phases/${PHASE_NUMBER}/impl-notes\\.md)`
    ),
  },
  {
    path_class: "authority-initialization",
    pattern: anchored("authority/initialization\\.json"),
  },
  {
    path_class: "authority-result",
    pattern: anchored(`authority/results/${SHA256}\\.json`),
  },
  {
    path_class: "authority-decision",
    pattern: anchored(
      `authority/decisions/${PATH_SAFE_ID}/(?:request|decision|supplemental-review)\\.json`,
    ),
  },
];

/**
 * Ignored, reconstructible task-workspace paths. This table intentionally lives outside the
 * persisted `PathClass` contract: workspace files are neither durable authority nor claimable
 * implementation outputs.
 */
const WORKSPACE_CLASS_RULES: readonly ClassRule<WorkspacePathClass>[] = [
  {
    path_class: "workspace-staged-request",
    pattern: anchored(`transient/intents/${PATH_SAFE_ID}\\.request\\.json`),
  },
  {
    path_class: "workspace-intent",
    pattern: anchored(`transient/intents/${PATH_SAFE_ID}(?<!\\.request)\\.json`),
  },
  { path_class: "workspace-lock", pattern: anchored("transient/\\.transaction-lock") },
  {
    path_class: "workspace-result-payload",
    pattern: anchored(`cache/results/${SHA256}/payload/.+`),
  },
  {
    path_class: "workspace-review",
    pattern: anchored(
      `cache/reviews/${PHASE_INSTANCE}\\.(?:counter|triage|adjudication)\\.md` +
        `|cache/reviews/${PHASE_INSTANCE}\\.gate-counter\\.${PATH_SAFE_ID}\\.md`,
    ),
  },
  {
    path_class: "workspace-gate-interface",
    pattern: anchored(`cache/gates/(?:gate\\.(?:json|decision)|${PATH_SAFE_ID}\\.(?:json|md))`),
  },
  {
    path_class: "workspace-verification-transcript",
    pattern: anchored(`cache/phases/${PHASE_NUMBER}/verification\\.txt`),
  },
  {
    path_class: "workspace-import",
    pattern: anchored(`cache/imports/${SHA256}/(?:manifest\\.json|payload/.+)`),
  },
  {
    path_class: "workspace-attempt",
    pattern: anchored(`diagnostics/attempts/${PHASE_INSTANCE}/${PATH_SAFE_ID}\\.json`),
  },
  {
    path_class: "workspace-scratch",
    pattern: anchored(`(?:transient|cache|diagnostics)/scratch(?:/.+)?`),
  },
];

/**
 * Every repository-scoped class. Paths are relative to the worktree root.
 *
 * | Class                      | Template                                      | Required identifiers |
 * |----------------------------|-----------------------------------------------|----------------------|
 * | `shared-workflow`          | `.archflow/workflow.yaml`                     | — (read-only)        |
 * | `shared-constitution`      | `.archflow/constitution/<name>.md`            | name (read-only)     |
 * | `task-branch-constitution` | `.archflow/constitution/<name>.md`            | name                 |
 * | `repository-source`        | any repository claim **not** under `.archflow/` | —                  |
 *
 * **`shared-constitution` and `task-branch-constitution` share one template deliberately.** They
 * name the same file and are distinguished by *operation*, not by path: reading pinned policy versus
 * detecting a task-branch edit. A path alone therefore cannot decide between them, so
 * {@link classifyRepositoryPath} always returns `shared-constitution`, and the **caller narrows** to
 * `task-branch-constitution` by passing it as `expectedClass` when the operation is the
 * constitution-edit check. That narrowing is stated here rather than hidden in a heuristic.
 */
const REPOSITORY_CLASS_RULES: readonly ClassRule<RepositoryPathClass>[] = [
  { path_class: "shared-workflow", pattern: anchored("\\.archflow/workflow\\.yaml") },
  {
    path_class: "shared-constitution",
    pattern: anchored(`\\.archflow/constitution/${PATH_SAFE_ID}\\.md`),
  },
];

const ARCHFLOW_TREE = ".archflow";

const inArchflowTree = (claim: string): boolean =>
  claim === ARCHFLOW_TREE || claim.startsWith(`${ARCHFLOW_TREE}/`);

/**
 * The repository frame has no active task, and the pinned `classifyRepositoryPath` signature carries
 * no `RepositoryOperationContext`, so a direct call has no task identifier to report in a
 * `PATH_INVALID` diagnostic. Both resolvers do have a context and substitute `context.task_id`; this
 * reserved slug is only ever seen by a caller that classifies outside any operation.
 */
const UNSCOPED_TASK_ID = parseTaskSlug("unscoped");

// ---------------------------------------------------------------------------
// Result helpers
// ---------------------------------------------------------------------------

function ok<T>(value: T): ProjectResult<T> {
  return Object.freeze({ schema_version: "1", ok: true, value });
}

function fail<T>(error: ProjectError): ProjectResult<T> {
  return Object.freeze({ schema_version: "1", ok: false, error });
}

/**
 * `PATH_INVALID` requires `{task_id, path_class}`, but a claim that matched no template has no
 * class by definition. The diagnostic therefore reports the caller's `expectedClass` when one was
 * declared, and otherwise `repository-source` — the only class whose meaning is "no ArchFlow-managed
 * class applies".
 */
function pathInvalid(taskId: TaskSlug, expectedClass: PathClass | undefined): ProjectError {
  return createProjectError("PATH_INVALID", {
    task_id: taskId,
    path_class: expectedClass ?? "repository-source",
  });
}

function pathEscape(taskId: TaskSlug, pathClass: PathClass): ProjectError {
  return createProjectError("PATH_ESCAPE", { task_id: taskId, path_class: pathClass });
}

function taskScopeViolation(taskId: TaskSlug, pathClass: PathClass): ProjectError {
  return createProjectError("TASK_SCOPE_VIOLATION", { task_id: taskId, path_class: pathClass });
}

function ioError(context: RepositoryOperationContext): ProjectError {
  return createProjectError("IO_ERROR", {
    operation: context.operation,
    attempt: context.attempt,
  });
}

function errnoOf(error: unknown): string | undefined {
  const code = (error as { code?: unknown } | null)?.code;
  return typeof code === "string" ? code : undefined;
}

// ---------------------------------------------------------------------------
// Classification
// ---------------------------------------------------------------------------

function classifyIn<C extends string>(
  rules: readonly ClassRule<C>[],
  claim: string
): C | undefined {
  for (const rule of rules) if (rule.pattern.test(claim)) return rule.path_class;
  return undefined;
}

/** Classifies a claim rooted at `.archflow/tasks/<task-id>/` against the task-scoped table. */
export function classifyTaskPath(
  taskId: TaskSlug,
  claim: TaskPathClaim
): ProjectResult<TaskPathClass> {
  const matched = classifyIn(TASK_CLASS_RULES, claim);
  if (matched === undefined) return fail(pathInvalid(taskId, undefined));
  return ok(matched);
}

/** Parses a bounded lexical claim in the ignored task-workspace frame. */
export function parseWorkspacePathClaim(value: unknown): WorkspacePathClaim {
  return parseTaskPathClaim(value) as unknown as WorkspacePathClaim;
}

/** Classifies a path relative to `.archflow/work/tasks/<task-id>/`. */
export function classifyWorkspacePath(
  taskId: TaskSlug,
  claim: WorkspacePathClaim,
): ProjectResult<WorkspacePathClass> {
  const matched = classifyIn(WORKSPACE_CLASS_RULES, claim);
  // Workspace classes deliberately are not persisted PathClass values. Use task-state as the
  // stable public diagnostic class while returning the precise workspace class on success.
  if (matched === undefined) return fail(pathInvalid(taskId, "task-state"));
  return ok(matched);
}

/**
 * Classifies a claim rooted at the worktree against the repository-scoped table.
 *
 * Anything outside the `.archflow/` tree is `repository-source`. Anything inside it that matches
 * neither the shared workflow nor a shared constitution is a task-scoped path presented in the wrong
 * frame, and is rejected rather than mapped to a repository class.
 */
export function classifyRepositoryPath(
  claim: RepositoryPathClaim
): ProjectResult<RepositoryPathClass> {
  return classifyRepositoryPathFor(UNSCOPED_TASK_ID, claim, undefined);
}

function classifyRepositoryPathFor(
  taskId: TaskSlug,
  claim: RepositoryPathClaim,
  expectedClass: RepositoryPathClass | undefined
): ProjectResult<RepositoryPathClass> {
  if (!inArchflowTree(claim)) return ok("repository-source");
  const matched = classifyIn(REPOSITORY_CLASS_RULES, claim);
  if (matched === undefined) return fail(pathInvalid(taskId, expectedClass));
  return ok(matched);
}

// ---------------------------------------------------------------------------
// Containment
// ---------------------------------------------------------------------------

type Containment =
  | Readonly<{ kind: "contained"; absolute: ResolvedTaskPath }>
  | Readonly<{ kind: "escape" }>
  | Readonly<{ kind: "io" }>;

const WIN32_DRIVE = /^[A-Za-z]:/u;

/**
 * `realpath` the candidate, and on `ENOENT` `realpath` the nearest existing ancestor and re-append
 * the missing tail. A not-yet-existing path must still be resolvable — every write in this system
 * targets a file that does not exist yet — but the *existing* prefix must still be resolved through
 * its symlinks, or the whole control degrades to a string comparison for exactly the paths we are
 * about to create.
 */
async function realpathWithMissingTail(candidate: string): Promise<string> {
  let current = candidate;
  const tail: string[] = [];
  for (;;) {
    try {
      const real = await realpath(current);
      return tail.length === 0 ? real : join(real, ...tail);
    } catch (error) {
      if (errnoOf(error) !== "ENOENT") throw error;
    }
    const parent = dirname(current);
    if (parent === current) throw Object.assign(new Error("no existing ancestor"), { code: "ENOENT" });
    tail.unshift(basename(current));
    current = parent;
  }
}

/**
 * The seven-step containment sequence. Every step is load-bearing, and the order is not negotiable.
 *
 * 1. Reject NUL, `path.isAbsolute(input)`, or a win32 drive/UNC prefix **before** resolving. Not
 *    optional: an absolute second argument makes `path.resolve` discard the root entirely —
 *    `resolve("/srv/root", "/etc/passwd")` is `/etc/passwd`.
 * 2. `candidate = path.resolve(root, input)`.
 * 3. `realRoot = await realpath(root)`.
 * 4. `realCand = await realpath(candidate)`, walking to the nearest existing ancestor on `ENOENT`.
 * 5. `rel = path.relative(realRoot, realCand)`.
 * 6. Accept only if `rel` is empty or a genuine descendant. `path.relative`, never `startsWith`:
 *    `startsWith(root)` accepts `/srv/root-evil/x` and `/srv/rootx`, while `startsWith(root + sep)`
 *    wrongly rejects the root itself.
 * 7. On the real open, OR in `(fs.constants.O_NOFOLLOW ?? 0)` — see {@link openResolved}.
 *
 * Steps 3–4 are the whole control. Without them this is a string check, not a security boundary.
 * The lesson the design encodes everywhere, from CVE-2026-31802 / GHSA-9ppj-qmqm-q256 in `node-tar`
 * (which validated `..` against a path still carrying a `C:` prefix and stripped the drive letter
 * afterwards, yielding arbitrary file overwrite): **validate containment on the final normalised
 * path, never on an intermediate form.**
 *
 * **This is a check-then-use control with an inherent TOCTOU window, and it says so rather than
 * implying atomicity.** Node 24 has no `openat`-style API: no `O_PATH`, no `O_RESOLVE_BENEATH`, no
 * dir-relative `fs` variants, `FileHandle` cannot serve as a directory base, and there is no Node
 * equivalent of Go's `os.Root`. A target created between step 4 and the open is not re-checked.
 * `O_NOFOLLOW` in step 7 is defence-in-depth against exactly that race, not a substitute for it.
 * (Note also that `fsPromises.realpath.native` is `undefined`, even though `fs.realpath.native` and
 * `fs.realpathSync.native` exist, so the promise-form `realpath` used here is the only option.)
 *
 * **One recorded divergence from `scripts/release-support.mjs`'s module-private `isInside`**, which
 * is otherwise the same predicate: `isInside` requires `rel !== ""` and so rejects the root itself,
 * because a release payload path is always a strict sub-path. Step 6 here **accepts `rel === ""`**,
 * because a path class may legitimately resolve to the task root. The `rel !== ".."` guard is shared
 * with `isInside` and is not redundant: `"..".startsWith(".." + sep)` is `false`.
 *
 * **No dependency.** `is-path-inside`
 * disqualifies itself in its own bundled type definitions — "You should not use this as a security
 * mechanism" — and never resolves symlinks; `path-is-inside`, `resolve-path`, and `contains-path`
 * are lexical-only. A small local implementation resolves the relevant roots before containment
 * checks and keeps this security boundary explicit without adding a package for roughly thirty
 * lines of code.
 */
async function containedUnder(root: string, input: string): Promise<Containment> {
  // Step 1 — reject before resolving.
  if (input.includes("\0")) return { kind: "escape" };
  if (isAbsolute(input) || win32.isAbsolute(input) || WIN32_DRIVE.test(input)) {
    return { kind: "escape" };
  }

  // Step 2.
  const candidate = resolvePath(root, input);

  let realRoot: string;
  let realCandidate: string;
  try {
    // Steps 3 and 4. The root gets the same nearest-existing-ancestor treatment as the candidate,
    // because the task root `.archflow/tasks/<task-id>/` legitimately does not exist before task
    // initialization. Both sides are normalised identically, so the step-5 comparison stays sound.
    realRoot = await realpathWithMissingTail(root);
    realCandidate = await realpathWithMissingTail(candidate);
  } catch {
    return { kind: "io" };
  }

  // Steps 5 and 6.
  const rel = relative(realRoot, realCandidate);
  const contained =
    rel === "" || (rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel));
  return contained ? { kind: "contained", absolute: realCandidate as ResolvedTaskPath } : { kind: "escape" };
}

// ---------------------------------------------------------------------------
// Resolvers
// ---------------------------------------------------------------------------

/** Resolves unclassified, read-only legacy material beneath one explicitly selected source root. */
export async function resolveLegacySourcePath(options: {
  readonly sourceRoot: string;
  readonly claim: RepositoryPathClaim;
  readonly context: RepositoryOperationContext;
}): Promise<ProjectResult<ResolvedSourcePath>> {
  const contained = await containedUnder(options.sourceRoot, options.claim);
  if (contained.kind === "io") return fail(ioError(options.context));
  if (contained.kind === "escape") {
    return fail(pathEscape(options.context.task_id, "repository-source"));
  }
  return ok(Object.freeze({ sourceRelative: options.claim, absolute: contained.absolute }));
}

/**
 * Resolves a task-frame claim. Two containment checks run, because they answer two different
 * questions with two different codes: escaping the worktree is `PATH_ESCAPE`, while landing inside
 * the worktree but outside `.archflow/tasks/<task-id>/` — reachable through a symlink pointing at a
 * sibling task — is `TASK_SCOPE_VIOLATION`.
 */
export async function resolveTaskPath(options: {
  readonly runner: RootBoundGitRunner;
  readonly taskId: TaskSlug;
  readonly claim: TaskPathClaim;
  readonly expectedClass?: TaskPathClass;
  readonly context: RepositoryOperationContext;
}): Promise<ProjectResult<ResolvedPath>> {
  const { runner, taskId, claim, expectedClass, context } = options;

  const classified = classifyTaskPath(taskId, claim);
  if (!classified.ok) {
    return fail(pathInvalid(taskId, expectedClass));
  }
  if (expectedClass !== undefined && classified.value !== expectedClass) {
    return fail(pathInvalid(taskId, expectedClass));
  }
  const pathClass: TaskPathClass = classified.value;

  // `toRepositoryPathClaim` throws when the composed path is not itself a valid claim — a 1024-byte
  // task claim plus the `.archflow/tasks/<task-id>/` prefix is the reachable case.
  let repositoryRelative: RepositoryPathClaim;
  try {
    repositoryRelative = toRepositoryPathClaim(taskId, claim);
  } catch {
    return fail(pathInvalid(taskId, pathClass));
  }

  const root = runner.location.worktreeRoot;
  const withinWorktree = await containedUnder(root, repositoryRelative);
  if (withinWorktree.kind === "io") return fail(ioError(context));
  if (withinWorktree.kind === "escape") return fail(pathEscape(taskId, pathClass));

  const taskRoot = resolvePath(root, ARCHFLOW_TREE, "tasks", taskId);
  const withinTask = await containedUnder(taskRoot, claim);
  if (withinTask.kind === "io") return fail(ioError(context));
  if (withinTask.kind === "escape") return fail(taskScopeViolation(taskId, pathClass));

  return ok<ResolvedPath>(
    Object.freeze({
      path_class: pathClass,
      repositoryRelative,
      absolute: withinWorktree.absolute,
    })
  );
}

/**
 * Resolves the task directory itself through the same live containment authority used for files.
 * This is an internal repository seam: callers cannot mint a task root by taking `dirname` and
 * casting a resolved child path.
 */
export async function resolveTaskRoot(options: {
  readonly runner: RootBoundGitRunner;
  readonly taskId: TaskSlug;
  readonly context: RepositoryOperationContext;
}): Promise<ProjectResult<ResolvedTaskPath>> {
  const { runner, taskId, context } = options;
  const repositoryRelative = join(ARCHFLOW_TREE, "tasks", taskId);
  const withinWorktree = await containedUnder(runner.location.worktreeRoot, repositoryRelative);
  if (withinWorktree.kind === "io") return fail(ioError(context));
  if (withinWorktree.kind === "escape") return fail(pathEscape(taskId, "task-state"));

  const taskRoot = resolvePath(runner.location.worktreeRoot, repositoryRelative);
  const self = await containedUnder(taskRoot, "");
  if (self.kind === "io") return fail(ioError(context));
  if (self.kind === "escape") return fail(taskScopeViolation(taskId, "task-state"));
  return ok(self.absolute);
}

const workspaceRepositoryRelative = (
  taskId: TaskSlug,
  suffix?: WorkspacePathClaim,
): RepositoryPathClaim =>
  parseRepositoryPathClaim(
    suffix === undefined
      ? `${ARCHFLOW_TREE}/work/tasks/${taskId}`
      : `${ARCHFLOW_TREE}/work/tasks/${taskId}/${suffix}`,
  );

/**
 * Resolves the ignored workspace root for exactly one validated task. Like the durable task-root
 * resolver, this supports a not-yet-created root while authenticating its nearest existing
 * ancestor through `realpath`.
 */
export async function resolveTaskWorkspaceRoot(options: {
  readonly runner: RootBoundGitRunner;
  readonly taskId: TaskSlug;
  readonly context: RepositoryOperationContext;
}): Promise<ProjectResult<ResolvedTaskWorkspacePath>> {
  const { runner, context } = options;
  let taskId: TaskSlug;
  let repositoryRelative: RepositoryPathClaim;
  try {
    taskId = parseTaskSlug(options.taskId);
    repositoryRelative = workspaceRepositoryRelative(taskId);
  } catch {
    return fail(pathInvalid(context.task_id, "task-state"));
  }

  const withinWorktree = await containedUnder(runner.location.worktreeRoot, repositoryRelative);
  if (withinWorktree.kind === "io") return fail(ioError(context));
  if (withinWorktree.kind === "escape") return fail(pathEscape(taskId, "task-state"));

  const workspaceRoot = resolvePath(
    runner.location.worktreeRoot,
    ARCHFLOW_TREE,
    "work",
    "tasks",
    taskId,
  );
  const tasksRoot = resolvePath(runner.location.worktreeRoot, ARCHFLOW_TREE, "work", "tasks");
  let realTasksRoot: string;
  let realWorkspaceRoot: string;
  try {
    realTasksRoot = await realpathWithMissingTail(tasksRoot);
    realWorkspaceRoot = await realpathWithMissingTail(workspaceRoot);
  } catch {
    return fail(ioError(context));
  }
  // Containment alone is insufficient here: a symlink named for this task can resolve to a sibling
  // that is still beneath `work/tasks`. Require the resolved child identity itself to remain exact.
  if (relative(realTasksRoot, realWorkspaceRoot) !== taskId) {
    return fail(taskScopeViolation(taskId, "task-state"));
  }
  return ok(realWorkspaceRoot as ResolvedTaskWorkspacePath);
}

/**
 * Resolves a classified workspace file with independent worktree and exact-task containment.
 * A symlink into a sibling task therefore reports `TASK_SCOPE_VIOLATION`; a symlink outside the
 * worktree reports `PATH_ESCAPE`.
 */
export async function resolveTaskWorkspacePath(options: {
  readonly runner: RootBoundGitRunner;
  readonly taskId: TaskSlug;
  readonly claim: WorkspacePathClaim;
  readonly expectedClass?: WorkspacePathClass;
  readonly context: RepositoryOperationContext;
}): Promise<ProjectResult<ResolvedWorkspacePath>> {
  const { runner, claim, expectedClass, context } = options;
  let taskId: TaskSlug;
  try {
    taskId = parseTaskSlug(options.taskId);
  } catch {
    return fail(pathInvalid(context.task_id, "task-state"));
  }

  const classified = classifyWorkspacePath(taskId, claim);
  if (!classified.ok) return classified;
  if (expectedClass !== undefined && classified.value !== expectedClass) {
    return fail(pathInvalid(taskId, "task-state"));
  }

  let repositoryRelative: RepositoryPathClaim;
  try {
    repositoryRelative = workspaceRepositoryRelative(taskId, claim);
  } catch {
    return fail(pathInvalid(taskId, "task-state"));
  }

  const withinWorktree = await containedUnder(runner.location.worktreeRoot, repositoryRelative);
  if (withinWorktree.kind === "io") return fail(ioError(context));
  if (withinWorktree.kind === "escape") return fail(pathEscape(taskId, "task-state"));

  const authenticatedRoot = await resolveTaskWorkspaceRoot({ runner, taskId, context });
  if (!authenticatedRoot.ok) return authenticatedRoot;

  const workspaceRoot = authenticatedRoot.value;
  const withinWorkspace = await containedUnder(workspaceRoot, claim);
  if (withinWorkspace.kind === "io") return fail(ioError(context));
  if (withinWorkspace.kind === "escape") {
    return fail(taskScopeViolation(taskId, "task-state"));
  }

  return ok(Object.freeze({
    path_class: classified.value,
    workspaceRelative: claim,
    repositoryRelative,
    absolute: withinWorkspace.absolute as unknown as ResolvedTaskWorkspacePath,
  }));
}

async function cleanupLeafKind(path: string): Promise<WorkspaceCleanupLeafKind> {
  try {
    const metadata = await lstat(path);
    if (metadata.isSymbolicLink()) return "symlink";
    if (metadata.isDirectory()) return "directory";
    if (metadata.isFile()) return "file";
    return "other";
  } catch (error) {
    if (errnoOf(error) === "ENOENT") return "missing";
    throw error;
  }
}

/**
 * Authenticates a target for recursive workspace cleanup without following its leaf.
 *
 * All existing ancestors are realpathed and checked against both the worktree and exact task
 * workspace. The returned target is the lexical leaf, not its realpath. A symlink at that leaf is
 * consequently removed as a symlink by a no-follow recursive remover; it can never redirect the
 * cleanup traversal. Callers must still use `lstat`-based traversal (Node's `fs.rm` has this
 * property) and must not replace the returned lexical target with `realpath(target)`.
 */
export async function resolveTaskWorkspaceCleanupTarget(options: {
  readonly runner: RootBoundGitRunner;
  readonly taskId: TaskSlug;
  /** Omit to clean the whole task-specific workspace at a terminal boundary. */
  readonly claim?: WorkspacePathClaim;
  readonly context: RepositoryOperationContext;
}): Promise<ProjectResult<WorkspaceCleanupTarget>> {
  const { runner, context, claim } = options;
  let taskId: TaskSlug;
  let repositoryRelative: RepositoryPathClaim;
  try {
    taskId = parseTaskSlug(options.taskId);
    repositoryRelative = workspaceRepositoryRelative(taskId, claim);
  } catch {
    return fail(pathInvalid(context.task_id, "task-state"));
  }

  const worktreeRoot = runner.location.worktreeRoot;
  const workspaceRoot = resolvePath(worktreeRoot, ARCHFLOW_TREE, "work", "tasks", taskId);
  const target = resolvePath(worktreeRoot, repositoryRelative);

  // Never realpath the leaf: it may itself be a symlink that cleanup can safely unlink. The parent
  // is the complete traversal authority for a leaf deletion. For whole-workspace deletion, the
  // shared `work/tasks` parent plays the same role.
  const parent = dirname(target);
  const parentRepositoryRelative = relative(worktreeRoot, parent);
  const withinWorktree = await containedUnder(worktreeRoot, parentRepositoryRelative);
  if (withinWorktree.kind === "io") return fail(ioError(context));
  if (withinWorktree.kind === "escape") return fail(pathEscape(taskId, "task-state"));

  if (claim !== undefined) {
    const authenticatedRoot = await resolveTaskWorkspaceRoot({ runner, taskId, context });
    if (!authenticatedRoot.ok) return authenticatedRoot;
    const parentWorkspaceRelative = relative(workspaceRoot, parent);
    const withinWorkspace = await containedUnder(workspaceRoot, parentWorkspaceRelative);
    if (withinWorkspace.kind === "io") return fail(ioError(context));
    if (withinWorkspace.kind === "escape") {
      return fail(taskScopeViolation(taskId, "task-state"));
    }
  } else {
    // The task workspace is itself the leaf. Authenticate the fixed shared parent and keep the task
    // component lexical, so even a malicious task-root symlink is unlinked rather than followed.
    const tasksRoot = resolvePath(worktreeRoot, ARCHFLOW_TREE, "work", "tasks");
    const tasksParent = await containedUnder(worktreeRoot, relative(worktreeRoot, tasksRoot));
    if (tasksParent.kind === "io") return fail(ioError(context));
    if (tasksParent.kind === "escape") return fail(pathEscape(taskId, "task-state"));
  }

  let leafKind: WorkspaceCleanupLeafKind;
  try {
    leafKind = await cleanupLeafKind(target);
  } catch {
    return fail(ioError(context));
  }
  return ok(Object.freeze({
    workspaceRelative: claim ?? "",
    repositoryRelative,
    absolute: target as ResolvedWorkspaceCleanupTarget,
    leaf_kind: leafKind,
  }));
}

/**
 * Resolves a worktree-frame claim.
 *
 * `expectedClass: "task-branch-constitution"` is the documented narrowing described on
 * {@link REPOSITORY_CLASS_RULES}: classification can only ever return `shared-constitution` for that
 * template, so the caller declaring the constitution-edit operation is what promotes it.
 */
export async function resolveRepositoryPath(options: {
  readonly runner: RootBoundGitRunner;
  readonly claim: RepositoryPathClaim;
  readonly expectedClass?: RepositoryPathClass;
  readonly context: RepositoryOperationContext;
}): Promise<ProjectResult<ResolvedPath>> {
  const { runner, claim, expectedClass, context } = options;
  const taskId = context.task_id;

  const classified = classifyRepositoryPathFor(taskId, claim, expectedClass);
  if (!classified.ok) return classified;

  let pathClass: RepositoryPathClass = classified.value;
  if (expectedClass !== undefined) {
    const narrowed =
      expectedClass === "task-branch-constitution" && pathClass === "shared-constitution";
    if (!narrowed && pathClass !== expectedClass) return fail(pathInvalid(taskId, expectedClass));
    pathClass = expectedClass;
  }

  const withinWorktree = await containedUnder(runner.location.worktreeRoot, claim);
  if (withinWorktree.kind === "io") return fail(ioError(context));
  if (withinWorktree.kind === "escape") return fail(pathEscape(taskId, pathClass));

  return ok<ResolvedPath>(
    Object.freeze({
      path_class: pathClass,
      repositoryRelative: claim,
      absolute: withinWorktree.absolute,
    })
  );
}

const TASK_OUTPUT_CLASSES: ReadonlySet<ClaimableOutputPathClass> = new Set([
  "document",
]);

/**
 * Resolves one implementation-output claim in its declared class. Task-owned output paths are
 * repository-frame claims in the contract, so the active task prefix is removed exactly once
 * before delegating to the task-frame resolver.
 */
export async function resolveDeclaredOutputPath(options: {
  readonly runner: RootBoundGitRunner;
  readonly taskId: TaskSlug;
  readonly claim: RepositoryPathClaim;
  readonly pathClass: ClaimableOutputPathClass;
  readonly context: RepositoryOperationContext;
}): Promise<ProjectResult<ResolvedPath>> {
  const { runner, taskId, claim, pathClass, context } = options;
  if (TASK_OUTPUT_CLASSES.has(pathClass)) {
    const prefix = `.archflow/tasks/${taskId}/`;
    if (!claim.startsWith(prefix)) return fail(pathInvalid(taskId, pathClass));
    const taskClaim = claim.slice(prefix.length) as TaskPathClaim;
    return resolveTaskPath({
      runner,
      taskId,
      claim: taskClaim,
      expectedClass: pathClass as TaskPathClass,
      context,
    });
  }
  return resolveRepositoryPath({
    runner,
    claim,
    expectedClass: pathClass as RepositoryPathClass,
    context,
  });
}

/** Resolves a non-overwriting rename and rejects endpoints in different path classes. */
export async function resolveDeclaredRename(options: {
  readonly runner: RootBoundGitRunner;
  readonly taskId: TaskSlug;
  readonly previousPath: RepositoryPathClaim;
  readonly path: RepositoryPathClaim;
  readonly pathClass: ClaimableOutputPathClass;
  readonly context: RepositoryOperationContext;
}): Promise<ProjectResult<Readonly<{ previous: ResolvedPath; next: ResolvedPath }>>> {
  const previous = await resolveDeclaredOutputPath({
    runner: options.runner,
    taskId: options.taskId,
    claim: options.previousPath,
    pathClass: options.pathClass,
    context: options.context,
  });
  if (!previous.ok) return previous;
  const next = await resolveDeclaredOutputPath({
    runner: options.runner,
    taskId: options.taskId,
    claim: options.path,
    pathClass: options.pathClass,
    context: options.context,
  });
  if (!next.ok) return next;
  if (previous.value.path_class !== next.value.path_class) {
    return fail(pathInvalid(options.taskId, options.pathClass));
  }
  return ok(Object.freeze({ previous: previous.value, next: next.value }));
}

/**
 * Containment step 7, and the only sanctioned way to open a resolved path.
 *
 * **Throws**, per the failure convention: a failure here is an environment fault with no
 * caller-facing project code.
 *
 * `?? 0` is defensive clarity, not a correctness fix. Bitwise OR applies `ToInt32`, so
 * `flags | undefined` evaluates to `flags`, not `NaN` — the flag would simply be dropped silently.
 * The real point is platform-specific: **`O_NOFOLLOW` does not exist on Windows**, so there step 7
 * is a no-op and the symlink defence rests entirely on steps 3–6.
 */
export async function openResolved(
  path: ResolvedTaskPath | ResolvedTaskWorkspacePath,
  flags: number,
): Promise<FileHandle> {
  const noFollow = (fsConstants as { O_NOFOLLOW?: number }).O_NOFOLLOW ?? 0;
  return open(path, flags | noFollow);
}

import { realpath } from "node:fs/promises";
import { resolve as resolvePath } from "node:path";

import {
  canonicalJsonBytes,
  parseGitOid,
  repositoryCandidateDigest,
  sha256Bytes,
  type GitOid,
} from "../contracts/canonical.js";
import {
  createProjectError,
  type ProjectError,
  type ProjectResult,
} from "../contracts/errors.js";
import type { SafeCode, Sha256Digest, TaskSlug } from "../contracts/evidence.js";
import {
  GitInvocationError,
  projectErrorForGitFailure,
  type ExpectedAbsence,
  type GitCommandSpec,
  type GitEnvironment,
  type GitRunner,
  type RepositoryOperationContext,
} from "./git.js";

export interface WorktreeLocation {
  /** Absolute realpath of the current worktree root — where `.archflow/` lives. */
  readonly worktreeRoot: string;
  /** Absolute; per-worktree. */
  readonly gitDir: string;
  /** Absolute; shared across linked worktrees. */
  readonly gitCommonDir: string;
  readonly linked: boolean;
}

const rootBoundBrand = Symbol("rootBoundBrand");

/**
 * A runner whose cwd is provably the worktree root. Only `discoverWorktree` can mint one, because
 * `rootBoundBrand` is module-private and no other module can produce the property type.
 *
 * This exists to close a reproduced silent-wrong-answer hole rather than a theoretical one. From a
 * subdirectory `repo/sub`, `git ls-files -s -- .archflow/…` returns nothing and
 * `git check-attr text merge -- .archflow/…` returns `text: auto` / `merge: unspecified` — neither
 * errors, both are simply wrong. Spelling the path `../.archflow/…` finds the file but emits a path
 * that can never be a valid `RepositoryPathClaim`. Making every reader below discovery accept only
 * this type removes the possibility structurally instead of by convention.
 */
export interface RootBoundGitRunner extends GitRunner {
  readonly location: WorktreeLocation;
  readonly [rootBoundBrand]: true;
}

export function isRootBoundGitRunner(runner: unknown): runner is RootBoundGitRunner {
  if (typeof runner !== "object" || runner === null) return false;
  const candidate = runner as {
    [rootBoundBrand]?: unknown;
    location?: unknown;
    cwd?: unknown;
  };
  return (
    candidate[rootBoundBrand] === true &&
    typeof candidate.location === "object" &&
    candidate.location !== null &&
    typeof (candidate.location as WorktreeLocation).worktreeRoot === "string"
  );
}

export interface RepositoryIdentity {
  readonly schema_version: "1";
  readonly object_format: "sha1";
  /** Ordinal-sorted, one entry per root commit. */
  readonly root_commits: readonly GitOid[];
  /** `sha256(canonicalJsonBytes({ object_format, root_commits }))`. */
  readonly digest: Sha256Digest;
}

export interface TaskIdentity {
  readonly schema_version: "1";
  readonly task_id: TaskSlug;
  readonly repository_identity_digest: Sha256Digest;
  readonly digest: Sha256Digest;
}

const LOCATION_OPERATION = "git-rev-parse-location" as SafeCode;
const GIT_DIR_OPERATION = "git-rev-parse-git-dir" as SafeCode;
const HEAD_OPERATION = "git-rev-parse-head" as SafeCode;
const ROOTS_OPERATION = "git-rev-list-roots" as SafeCode;

/**
 * Absence declared per command, never inferred from a bare exit 128. Outside any repository
 * `git rev-parse` exits 128 with the first diagnostic; in a bare repository or with the cwd inside
 * `.git/`, the batched location query prints its boolean flags and then dies with the second one
 * at `--show-toplevel`. Both are "no usable work tree here"; every other 128 stays a failure.
 */
const NOT_A_REPOSITORY: readonly ExpectedAbsence[] = [
  { code: 128, stderrIncludes: "not a git repository" },
  { code: 128, stderrIncludes: "must be run in a work tree" },
];

/**
 * `git rev-parse --verify --quiet` exits 1 and writes nothing when the revision does not resolve,
 * which for `HEAD^{commit}` is exactly the unborn-HEAD case. The empty `stderrIncludes` is
 * deliberate and scoped to this one command: `--quiet` suppresses the diagnostic, so there is no
 * substring to match, and the distinguishing signal is the exit code 1 that no fatal path uses.
 */
const UNBORN_HEAD: readonly ExpectedAbsence[] = [{ code: 1, stderrIncludes: "" }];

function ok<T>(value: T): ProjectResult<T> {
  return Object.freeze({ schema_version: "1", ok: true, value });
}

function fail<T>(error: ProjectError): ProjectResult<T> {
  return Object.freeze({ schema_version: "1", ok: false, error });
}

function repositoryNotFound(runner: GitRunner): ProjectError {
  return createProjectError("REPOSITORY_NOT_FOUND", {
    repository_candidate_digest: repositoryCandidateDigest(runner.cwd),
  });
}

function ioError(context: RepositoryOperationContext): ProjectError {
  return createProjectError("IO_ERROR", {
    operation: context.operation,
    attempt: context.attempt,
  });
}

function isErrnoException(error: unknown): boolean {
  return error instanceof Error && typeof (error as { code?: unknown }).code === "string";
}

function ordinal(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

const MAX_REPOSITORY_IDENTITIES = 256;
const repositoryIdentityCache = new Map<string, RepositoryIdentity>();

export function resetRepositoryIdentityCacheForTesting(): void {
  repositoryIdentityCache.clear();
}



/**
 * The runner interface exposes no way to change the cwd it closed over, so binding prefixes every
 * argv with `-C <worktreeRoot>`. That keeps the caller's git path, buffer, and timeout settings
 * while making the effective working directory the worktree root for every command, including
 * pathspec resolution.
 */
function bindToRoot(runner: GitRunner, location: WorktreeLocation): RootBoundGitRunner {
  const atRoot = (spec: GitCommandSpec): GitCommandSpec => ({
    ...spec,
    argv: ["-C", location.worktreeRoot, ...spec.argv],
  });
  return Object.freeze({
    cwd: location.worktreeRoot,
    location,
    run: (spec: GitCommandSpec) => runner.run(atRoot(spec)),
    runText: (spec: GitCommandSpec) => runner.runText(atRoot(spec)),
    runNulFields: (spec: GitCommandSpec) => runner.runNulFields(atRoot(spec)),
    [rootBoundBrand]: true,
  }) as unknown as RootBoundGitRunner;
}

/**
 * Discovers the worktree the runner's cwd sits in and returns a runner bound to its root — the
 * location alone is deliberately not returned, so there is no way to keep using the unbound runner.
 *
 * Refusals, each detected explicitly:
 *
 * - not inside a work tree, bare repository, cwd inside `.git/` — the
 *   `--is-inside-work-tree` / `--is-bare-repository` / `--is-inside-git-dir` matrix;
 * - submodule — `--show-superproject-working-tree`, which prints the parent worktree and is empty
 *   otherwise but **exits 0 either way**, so the test is for empty output, not exit code;
 * - shallow clone — `--is-shallow-repository`; a shallow clone's `rev-list --max-parents=0` returns
 *   the grafted boundary commit, which is not the true root and varies with clone depth.
 *
 * All of those flags are answered by a single `rev-parse` invocation (see the body for the
 * line-count rule its superproject flag imposes).
 *
 * Unborn HEAD is refused by `resolveRepositoryIdentity`, where the root-commit query lives.
 *
 * `--git-dir` and `--git-common-dir` return the relative path `.git` at the top of the main
 * worktree but an absolute path from a linked worktree, so raw output is never concatenated — it is
 * resolved against the worktree root. `--path-format=absolute` would remove the wrinkle but raises
 * the Git floor to ~2.31; this design holds it at ~2.25.
 */
export async function discoverWorktree(
  runner: GitRunner,
  context: RepositoryOperationContext
): Promise<ProjectResult<RootBoundGitRunner>> {
  if (isRootBoundGitRunner(runner) && runner.cwd === runner.location.worktreeRoot) {
    return ok(runner);
  }

  try {
    // One process answers the whole matrix. `rev-parse` prints one line per flag in argument
    // order, except `--show-superproject-working-tree`, which prints nothing at all outside a
    // submodule — so it goes last: exactly five lines means "not a submodule", a sixth line is the
    // superproject path. Any other shape is refused rather than guessed at.
    const lines = (
      await runner.runText({
        argv: [
          "rev-parse",
          "--is-inside-work-tree",
          "--is-bare-repository",
          "--is-inside-git-dir",
          "--is-shallow-repository",
          "--show-toplevel",
          "--show-superproject-working-tree",
        ],
        operation: LOCATION_OPERATION,
        expectedAbsence: NOT_A_REPOSITORY,
      })
    ).split("\n");
    const toplevel = lines[4];
    if (
      lines.length !== 5 ||
      lines[0] !== "true" ||
      lines[1] !== "false" ||
      lines[2] !== "false" ||
      lines[3] !== "false" ||
      toplevel === undefined ||
      toplevel === ""
    ) {
      return fail(repositoryNotFound(runner));
    }

    const worktreeRoot = await realpath(toplevel);

    // Relative git-dir output is relative to the *process* cwd, not to the toplevel — reproduced:
    // from `repo/nested/deeper`, `--git-dir` prints an absolute path but `--git-common-dir` prints
    // `../../.git`. Running the pair with `-C <worktreeRoot>` makes the cwd the worktree root, so
    // resolving against the root is then exactly right in every case.
    const directories = (
      await runner.runText({
        argv: ["-C", worktreeRoot, "rev-parse", "--git-dir", "--git-common-dir"],
        operation: GIT_DIR_OPERATION,
      })
    ).split("\n");
    const rawGitDir = directories[0] ?? "";
    const rawCommonDir = directories[1] ?? "";
    if (rawGitDir === "" || rawCommonDir === "") return fail(repositoryNotFound(runner));
    const gitDir = await realpath(resolvePath(worktreeRoot, rawGitDir));
    const gitCommonDir = await realpath(resolvePath(worktreeRoot, rawCommonDir));

    const location: WorktreeLocation = Object.freeze({
      worktreeRoot,
      gitDir,
      gitCommonDir,
      linked: gitDir !== gitCommonDir,
    });

    return ok(bindToRoot(runner, location));
  } catch (error) {
    if (error instanceof GitInvocationError) {
      return fail(projectErrorForGitFailure(error, runner, context));
    }
    if (isErrnoException(error)) return fail(ioError(context));
    throw error;
  }
}

/**
 * Repository identity is `sha256(canonicalJsonBytes({ object_format, root_commits }))` over the
 * ordinal-sorted output of `git rev-list --max-parents=0 HEAD`. Multiple root commits are normal in
 * repositories formed with `--allow-unrelated-histories`, so the whole sorted set is hashed and the
 * first line is never taken alone. The identity contains no filesystem path, so it survives
 * relocation and is shared by every linked worktree of the same repository.
 *
 * Orphan branches are a documented limitation, not a compensated one: checking out an orphan branch
 * changes HEAD's root set, and computing over `--all` would only trade one instability for another
 * (any new unrelated branch would move the identity). Identity is recorded at task initialization
 * and compared thereafter, so a change surfaces as `REPOSITORY_MISMATCH` — the correct behaviour.
 */
export async function resolveRepositoryIdentity(
  runner: RootBoundGitRunner,
  environment: GitEnvironment,
  context: RepositoryOperationContext
): Promise<ProjectResult<RepositoryIdentity>> {
  try {
    const head = await runner.runText({
      argv: ["rev-parse", "--verify", "--quiet", "HEAD^{commit}"],
      operation: HEAD_OPERATION,
      expectedAbsence: UNBORN_HEAD,
    });
    if (head === "") return fail(repositoryNotFound(runner));

    const cacheKey = `${runner.location.worktreeRoot}\0${head}\0${environment.object_format}`;
    const cached = repositoryIdentityCache.get(cacheKey);
    if (cached !== undefined) {
      repositoryIdentityCache.delete(cacheKey);
      repositoryIdentityCache.set(cacheKey, cached);
      return ok(cached);
    }

    const output = await runner.runText({
      argv: ["rev-list", "--max-parents=0", "HEAD"],
      operation: ROOTS_OPERATION,
    });
    const rootCommits = output
      .split("\n")
      .filter((line) => line !== "")
      .map((line) => parseGitOid(line))
      .sort(ordinal);
    if (rootCommits.length === 0) return fail(repositoryNotFound(runner));

    const digest = sha256Bytes(
      canonicalJsonBytes({
        object_format: environment.object_format,
        root_commits: rootCommits.map((oid) => oid as string),
      })
    );
    const identity: RepositoryIdentity = Object.freeze({
      schema_version: "1",
      object_format: environment.object_format,
      root_commits: Object.freeze(rootCommits),
      digest,
    });

    if (repositoryIdentityCache.size >= MAX_REPOSITORY_IDENTITIES) {
      const oldestKey = repositoryIdentityCache.keys().next().value;
      if (oldestKey !== undefined) repositoryIdentityCache.delete(oldestKey);
    }
    repositoryIdentityCache.set(cacheKey, identity);

    return ok<RepositoryIdentity>(identity);
  } catch (error) {
    if (error instanceof GitInvocationError) {
      return fail(projectErrorForGitFailure(error, runner, context));
    }
    if (isErrnoException(error)) return fail(ioError(context));
    throw error;
  }
}

/** Compares a recorded repository identity digest against a freshly observed one. */
export function verifyRepositoryIdentity(
  expected: Sha256Digest,
  observed: RepositoryIdentity
): ProjectResult<RepositoryIdentity> {
  if (expected === observed.digest) return ok(observed);
  return fail(
    createProjectError("REPOSITORY_MISMATCH", {
      expected_digest: expected,
      observed_digest: observed.digest,
    })
  );
}

/** Bare return: a pure derivation over already-parsed inputs, per the failure convention. */
export function computeTaskIdentity(
  taskId: TaskSlug,
  repository: RepositoryIdentity
): TaskIdentity {
  const repositoryIdentityDigest = repository.digest;
  return Object.freeze({
    schema_version: "1",
    task_id: taskId,
    repository_identity_digest: repositoryIdentityDigest,
    digest: sha256Bytes(
      canonicalJsonBytes({
        schema_version: "1",
        task_id: taskId as string,
        repository_identity_digest: repositoryIdentityDigest as string,
      })
    ),
  });
}

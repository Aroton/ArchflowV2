import {
  normalizeGitTreeMode,
  parseGitOid,
  type ArchflowTreeMode,
  type GitOid,
  type GitTreeMode,
} from "../contracts/canonical.js";
import {
  createProjectError,
  type ProjectError,
  type ProjectResult,
} from "../contracts/errors.js";
import type { SafeCode } from "../contracts/evidence.js";
import type { RepositoryPathClaim } from "../contracts/path-claims.js";
import {
  GitInvocationError,
  projectErrorForGitFailure,
  type RepositoryOperationContext,
} from "./git.js";
import type { RootBoundGitRunner } from "./identity.js";

export interface IndexEntry {
  readonly path: RepositoryPathClaim;
  readonly mode: GitTreeMode;
  readonly oid: GitOid;
  /** `0` for a merged entry; `1`–`3` are the base/ours/theirs stages of an unmerged one. */
  readonly stage: 0 | 1 | 2 | 3;
}

const LS_FILES_OPERATION = "git-ls-files" as SafeCode;
const TREE_MODE_ILLEGAL = "archflow-tree-mode-illegal" as SafeCode;
const PATH_MISMATCH = "git-path-mismatch" as SafeCode;

/** The prefix below which only `100644` is legal. */
const ARCHFLOW_PREFIX = ".archflow/";
/** Gitlinks are refused everywhere, not only below `.archflow/`. */
const GITLINK_MODE = "160000";

function ok<T>(value: T): ProjectResult<T> {
  return Object.freeze({ schema_version: "1", ok: true, value });
}

function fail<T>(error: ProjectError): ProjectResult<T> {
  return Object.freeze({ schema_version: "1", ok: false, error });
}

function taskInvalid(context: RepositoryOperationContext, issueCode: SafeCode): ProjectError {
  return createProjectError("TASK_INVALID", {
    task_id: context.task_id,
    issue_code: issueCode,
  });
}

/**
 * Throws, per the failure convention for assertion helpers; `readIndexEntries` translates the throw
 * into `TASK_INVALID{issue_code: "archflow-tree-mode-illegal"}`.
 *
 * Below `.archflow/**` only mode `100644` is legal — no executables, symlinks, or gitlinks. That
 * single rule removes the entire `core.fileMode` / `core.symlinks` problem space for our own files.
 */
export function assertArchflowIndexEntry(
  entry: IndexEntry
): asserts entry is IndexEntry & { readonly mode: ArchflowTreeMode } {
  if (entry.mode !== "100644") {
    throw new TypeError(
      `${entry.path} has index mode ${entry.mode}; only 100644 is legal below .archflow/`
    );
  }
}

function parseStage(value: string): 0 | 1 | 2 | 3 | undefined {
  return value === "0" ? 0 : value === "1" ? 1 : value === "2" ? 2 : value === "3" ? 3 : undefined;
}

/**
 * Reads mode, OID, and stage for the claimed paths **from the index, never the filesystem**.
 * `core.fileMode=false` makes Git ignore the filesystem executable bit and reuse the index mode, and
 * a symlink-incapable checkout still records `120000` in the index while storing the target path as
 * a blob with no trailing newline — so index-sourced mode plus content-derived OID is stable across
 * `core.fileMode` and `core.symlinks` in both settings. `-s` is used rather than `--format`, which
 * needs Git ≥2.38 and would raise the version floor for no gain.
 *
 * The reader is `-z`. Without it, `git ls-files -s` C-quotes non-ASCII names — reproduced with
 * `.archflow/ü space.json`. With `-z` each entry is one NUL-terminated field of the form
 * `<mode> <oid> <stage>\t<path>`: split on NUL first, then on the single `\t`, and never split the
 * path on whitespace.
 *
 * Pathspecs are `:(top,literal)<claim>` so they anchor at the worktree root and glob nothing.
 * `--literal-pathspecs` is deliberately **not** passed, and that is a correction to the design's
 * prose rather than an omission: the flag disables pathspec magic entirely, so
 * `git --literal-pathspecs ls-files -s -z -- :(top,literal).archflow/x` matches nothing at all
 * (reproduced against git 2.43.0), and `ls-files` rejects the flag outright when it is placed after
 * the subcommand. The magic prefix already supplies both properties the flag was there to provide.
 *
 * Every returned path must be byte-equal to one of the requested claims. A path Git returns that
 * was not requested — for instance `../.archflow/state.json`, which is what an unbound runner in a
 * subdirectory emits — is `git-path-mismatch`. An untracked claim is simply absent from the result,
 * which is not an error: `ls-files` reports what the index holds, and cardinality is pinned only for
 * `check-attr`, whose output is one triplet per requested path regardless of tracking.
 */
export async function readIndexEntries(
  runner: RootBoundGitRunner,
  paths: readonly RepositoryPathClaim[],
  context: RepositoryOperationContext
): Promise<ProjectResult<readonly IndexEntry[]>> {
  if (paths.length === 0) return ok<readonly IndexEntry[]>(Object.freeze([]));

  let fields: readonly string[];
  try {
    fields = await runner.runNulFields({
      argv: [
        "ls-files",
        "-s",
        "-z",
        "--",
        ...paths.map((claim) => `:(top,literal)${claim}`),
      ],
      operation: LS_FILES_OPERATION,
    });
  } catch (error) {
    if (error instanceof GitInvocationError) {
      return fail(projectErrorForGitFailure(error, runner, context));
    }
    throw error;
  }

  const requested = new Map(paths.map((claim) => [claim as string, claim]));
  const entries: IndexEntry[] = [];

  for (const field of fields) {
    const tab = field.indexOf("\t");
    if (tab < 0) return fail(taskInvalid(context, PATH_MISMATCH));
    const meta = field.slice(0, tab).split(" ");
    if (meta.length !== 3) return fail(taskInvalid(context, PATH_MISMATCH));
    const [modeText, oidText, stageText] = meta as [string, string, string];

    const claim = requested.get(field.slice(tab + 1));
    if (claim === undefined) return fail(taskInvalid(context, PATH_MISMATCH));

    let mode: GitTreeMode;
    try {
      mode = normalizeGitTreeMode(modeText);
    } catch {
      return fail(taskInvalid(context, TREE_MODE_ILLEGAL));
    }
    if (mode === GITLINK_MODE) return fail(taskInvalid(context, TREE_MODE_ILLEGAL));

    let oid: GitOid;
    try {
      oid = parseGitOid(oidText);
    } catch {
      return fail(taskInvalid(context, PATH_MISMATCH));
    }

    const stage = parseStage(stageText);
    if (stage === undefined) return fail(taskInvalid(context, PATH_MISMATCH));

    const entry: IndexEntry = Object.freeze({ path: claim, mode, oid, stage });
    if (claim.startsWith(ARCHFLOW_PREFIX)) {
      try {
        assertArchflowIndexEntry(entry);
      } catch {
        return fail(taskInvalid(context, TREE_MODE_ILLEGAL));
      }
    }
    entries.push(entry);
  }

  return ok<readonly IndexEntry[]>(Object.freeze(entries));
}

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

/** The single line that must sit in the repository root `.gitattributes`, after `* text=auto`. */
export const ARCHFLOW_GITATTRIBUTES_RULE = ".archflow/** -text merge=binary";

/**
 * The remediation a user needs when the rule is absent or overridden. A bare failure code is
 * worthless here, so the text is exported rather than merely documented.
 *
 * It is exported as a constant because the error contract has nowhere else to put it:
 * `ProjectError` carries only `{code, owner, retryable, diagnostic: {template_id, parameters},
 * next_action}`, `TASK_INVALID`'s parameter schema is `object({task_id, issue_code}).strict()`, and
 * `issue_code` is a `SafeCode` (`/^[a-z0-9][a-z0-9_-]{0,63}$/`) that cannot hold a sentence. There
 * is no free-form message field anywhere in the error contract, so whoever renders
 * `TASK_INVALID{issue_code: "archflow-attributes-missing"}` reads the text from here.
 */
export const ARCHFLOW_ATTRIBUTES_REMEDIATION = `add \`${ARCHFLOW_GITATTRIBUTES_RULE}\` to the repository root \`.gitattributes\`, commit it, then run \`git add --renormalize .archflow\``;

export interface AttributeCheck {
  readonly path: RepositoryPathClaim;
  /** Must be `"unset"`. */
  readonly text: string;
  /** Must be `"binary"`. */
  readonly merge: string;
}

/** The two attribute values `ARCHFLOW_GITATTRIBUTES_RULE` produces, and the only accepted pair. */
const REQUIRED_TEXT = "unset";
const REQUIRED_MERGE = "binary";

const CHECK_ATTR_OPERATION = "git-check-attr" as SafeCode;
const ATTRIBUTES_MISSING = "archflow-attributes-missing" as SafeCode;
const PATH_MISMATCH = "git-path-mismatch" as SafeCode;

/** Fields per requested path: two `<path>\0<attribute>\0<value>\0` triplets, `text` then `merge`. */
const FIELDS_PER_PATH = 6;

/**
 * Basenames whose content is derived by a package manager rather than written by hand. Review
 * material renders matching files digest-only even in repositories that never configured
 * `linguist-generated`, because lockfile churn carries no review signal at any size.
 */
export const REVIEW_EXCLUDED_BASENAMES: ReadonlySet<string> = Object.freeze(new Set([
  "package-lock.json",
  "npm-shrinkwrap.json",
  "yarn.lock",
  "pnpm-lock.yaml",
  "bun.lock",
  "bun.lockb",
  "Cargo.lock",
  "poetry.lock",
  "uv.lock",
  "Pipfile.lock",
  "Gemfile.lock",
  "composer.lock",
  "go.sum",
  "flake.lock",
]));

const GENERATED_ATTRIBUTE = "linguist-generated";
/** One `<path>\0<attribute>\0<value>\0` triplet per path for the single attribute requested. */
const GENERATED_FIELDS_PER_PATH = 3;
/** `check-attr` values meaning "not generated": absent, explicitly unset, or `linguist-generated=false`. */
const NOT_GENERATED_VALUES: ReadonlySet<string> = Object.freeze(new Set(["unspecified", "unset", "false"]));

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
 * Verifies that every claimed path is governed by `ARCHFLOW_GITATTRIBUTES_RULE`, which is what
 * licenses hashing file bytes in process: with `-text` in force the blob OID is a pure function of
 * the content, independent of `core.autocrlf`, `core.eol`, and the platform.
 *
 * The reader is `-z` and its cardinality is pinned. Without `-z`, `git check-attr` C-quotes
 * non-ASCII names — reproduced with `.archflow/ü space.json` — forcing the caller to implement
 * C-style unquoting to recover a name it already knows. With `-z` the output is **NUL triplets, not
 * lines**: `<path>\0<attribute>\0<value>\0`, one triplet per (path, attribute) pair, so for N paths
 * and the two attributes requested it is exactly 2N triplets — 6N NUL-terminated fields. Any other
 * count is `git-path-mismatch` rather than a best-effort parse, and every returned path must be
 * byte-equal to the claim requested at that position.
 *
 * `--literal-pathspecs` is deliberately absent: `git check-attr` takes **pathnames, not pathspecs**,
 * rejects the flag as a subcommand option outright, and does no globbing on its arguments, so the
 * flag would be either an error or a no-op. `--` still separates the attribute list from the names.
 *
 * Accepting only a `RootBoundGitRunner` is structural, not stylistic: from a subdirectory
 * `repo/sub`, `git check-attr text merge -- .archflow/…` reports `text: auto` / `merge: unspecified`
 * with no error at all — a silent wrong answer this signature makes unwritable.
 */
export async function checkArchflowAttributes(
  runner: RootBoundGitRunner,
  paths: readonly RepositoryPathClaim[],
  context: RepositoryOperationContext
): Promise<ProjectResult<readonly AttributeCheck[]>> {
  if (paths.length === 0) return ok<readonly AttributeCheck[]>(Object.freeze([]));

  let fields: readonly string[];
  try {
    fields = await runner.runNulFields({
      argv: ["check-attr", "-z", "text", "merge", "--", ...paths],
      operation: CHECK_ATTR_OPERATION,
    });
  } catch (error) {
    if (error instanceof GitInvocationError) {
      return fail(projectErrorForGitFailure(error, runner, context));
    }
    throw error;
  }

  if (fields.length !== paths.length * FIELDS_PER_PATH) {
    return fail(taskInvalid(context, PATH_MISMATCH));
  }

  const checks: AttributeCheck[] = [];
  for (const [index, claim] of paths.entries()) {
    const base = index * FIELDS_PER_PATH;
    const textPath = fields[base];
    const textName = fields[base + 1];
    const textValue = fields[base + 2];
    const mergePath = fields[base + 3];
    const mergeName = fields[base + 4];
    const mergeValue = fields[base + 5];

    if (textPath !== claim || mergePath !== claim) {
      return fail(taskInvalid(context, PATH_MISMATCH));
    }
    if (textName !== "text" || mergeName !== "merge") {
      return fail(taskInvalid(context, PATH_MISMATCH));
    }
    if (textValue !== REQUIRED_TEXT || mergeValue !== REQUIRED_MERGE) {
      return fail(taskInvalid(context, ATTRIBUTES_MISSING));
    }
    checks.push(Object.freeze({ path: claim, text: textValue, merge: mergeValue }));
  }

  return ok<readonly AttributeCheck[]>(Object.freeze(checks));
}

/**
 * Reports which of the claimed paths the repository marks `linguist-generated` — the
 * ecosystem-standard `.gitattributes` marker for derived content. Any value other than
 * `unspecified`, `unset`, or `false` (so `set`, `true`, or a custom string) marks the path
 * generated. Reader discipline mirrors `checkArchflowAttributes`: `-z` NUL triplets, pinned
 * cardinality, byte-equal path echo, root-bound runner.
 */
export async function checkGeneratedAttributes(
  runner: RootBoundGitRunner,
  paths: readonly RepositoryPathClaim[],
  context: RepositoryOperationContext
): Promise<ProjectResult<ReadonlySet<RepositoryPathClaim>>> {
  if (paths.length === 0) return ok<ReadonlySet<RepositoryPathClaim>>(Object.freeze(new Set<RepositoryPathClaim>()));

  let fields: readonly string[];
  try {
    fields = await runner.runNulFields({
      argv: ["check-attr", "-z", GENERATED_ATTRIBUTE, "--", ...paths],
      operation: CHECK_ATTR_OPERATION,
    });
  } catch (error) {
    if (error instanceof GitInvocationError) {
      return fail(projectErrorForGitFailure(error, runner, context));
    }
    throw error;
  }

  if (fields.length !== paths.length * GENERATED_FIELDS_PER_PATH) {
    return fail(taskInvalid(context, PATH_MISMATCH));
  }

  const generated = new Set<RepositoryPathClaim>();
  for (const [index, claim] of paths.entries()) {
    const base = index * GENERATED_FIELDS_PER_PATH;
    const echoedPath = fields[base];
    const attributeName = fields[base + 1];
    const value = fields[base + 2];
    if (echoedPath !== claim || attributeName !== GENERATED_ATTRIBUTE || value === undefined) {
      return fail(taskInvalid(context, PATH_MISMATCH));
    }
    if (!NOT_GENERATED_VALUES.has(value)) generated.add(claim);
  }

  return ok<ReadonlySet<RepositoryPathClaim>>(Object.freeze(generated));
}

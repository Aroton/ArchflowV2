import { z } from "zod";

import { endsWithDotOrSpace, isReservedDeviceName, type PathSafeId, type Sha256Digest, type TaskSlug } from "./evidence.js";
import { assertPlainJson } from "./plain-json.js";

declare const taskPathClaimBrand: unique symbol;
declare const repositoryPathClaimBrand: unique symbol;
declare const rawGitPathBrand: unique symbol;

/** A lexical claim rooted at the task directory, `.archflow/tasks/<task-id>/`. */
export type TaskPathClaim = string & { readonly [taskPathClaimBrand]: true };
/** Same lexical rules as `TaskPathClaim`; different frame — rooted at the worktree, not the task. */
export type RepositoryPathClaim = string & { readonly [repositoryPathClaimBrand]: true };
/** A path exactly as Git emitted it. Total constructor; carries no lexical guarantee at all. */
export type RawGitPath = string & { readonly [rawGitPathBrand]: true };

const utf8Length = (value: string): number => Buffer.byteLength(value, "utf8");
const containsControl = (value: string): boolean => /[\u0000-\u001f\u007f-\u009f]/u.test(value);
const hasDriveOrUncPrefix = (value: string): boolean => /^[A-Za-z]:/u.test(value) || value.startsWith("//");
const hasInvalidComponent = (value: string): boolean => value.split("/").some((component) => component === "" || component === "." || component === "..");
/** `:` also covers Windows drive-relative paths and NTFS alternate data streams; `*?[]` are Git pathspec metacharacters. */
const forbiddenCharacter = /[:*?[\]<>|]/u;
/** Both component rules are the shared ones from `evidence.ts`, applied to every segment. */
const hasReservedComponent = (value: string): boolean => value.split("/").some(isReservedDeviceName);
const hasTrailingDotOrSpace = (value: string): boolean => value.split("/").some(endsWithDotOrSpace);

/**
 * The one-pattern form of every lexical rule below except the NFC and UTF-8 byte bounds, which no
 * `pattern` can express. `path-claim.schema.json` emits this source verbatim, so the generated
 * schema and the named refines cannot drift apart.
 */
const PATH_CLAIM_PATTERN = new RegExp(
  String.raw`^(?!/)(?![A-Za-z]:)(?!//)(?!.*\\)(?!.*[\u0000-\u001F\u007F-\u009F])(?!\.\.?(?:/|$))(?!.*\/\.\.?(?:/|$))(?!.*//)(?!.*[:*?\[\]<>|])(?!.*[. ](?:/|$))(?!(?:.*/)?(?:[Cc][Oo][Nn]|[Pp][Rr][Nn]|[Aa][Uu][Xx]|[Nn][Uu][Ll]|[Cc][Oo][Mm][1-9]|[Ll][Pp][Tt][1-9])(?:\.[^/]*)?(?:/|$)).+$`,
  "u"
);

/**
 * The sole lexical authority for both claim frames, mirroring
 * `src/contracts/schemas/v1/path-claim.schema.json` rule for rule. Built once per identity: the
 * schema generator registers the document root and both branded `primitives` defs separately, and
 * a registry identity can carry only one URI, so each must be its own object.
 */
const pathClaimLexical = () => z.string()
  .min(1)
  .regex(PATH_CLAIM_PATTERN, "path claim violates the lexical path pattern")
  .refine((value) => utf8Length(value) <= 1024, "path claim must be at most 1024 UTF-8 bytes")
  .refine((value) => !value.startsWith("/"), "path claim must be relative")
  .refine((value) => !hasDriveOrUncPrefix(value), "path claim must not use a drive or UNC prefix")
  .refine((value) => !value.includes("\\"), "path claim must use forward slashes")
  .refine((value) => !containsControl(value), "path claim must not contain control characters")
  .refine((value) => !forbiddenCharacter.test(value), "path claim must not contain : * ? [ ] < > or |")
  .refine((value) => !hasInvalidComponent(value), "path claim components must be non-empty and may not be . or ..")
  .refine((value) => !hasReservedComponent(value), "path claim components must not be reserved device names")
  .refine((value) => !hasTrailingDotOrSpace(value), "path claim components must not end with a dot or a space")
  .refine((value) => value.normalize("NFC") === value, "path claim components must already be NFC");

/** The `path-claim.schema.json` document root; the branded schemas below are its two frames. */
export const pathClaimLexicalV1Schema = pathClaimLexical();
export const taskPathClaimV1Schema = pathClaimLexical() as unknown as z.ZodType<TaskPathClaim>;
export const repositoryPathClaimV1Schema = pathClaimLexical() as unknown as z.ZodType<RepositoryPathClaim>;

/**
 * Parses a bounded task-relative lexical claim. This does not inspect a file
 * system or grant repository/task containment authority.
 */
export function parseTaskPathClaim(value: unknown): TaskPathClaim {
  assertPlainJson(value, "task path claim");
  return taskPathClaimV1Schema.parse(value);
}

/** Parses the same lexical claim in the worktree frame rather than the task frame. */
export function parseRepositoryPathClaim(value: unknown): RepositoryPathClaim {
  assertPlainJson(value, "repository path claim");
  return repositoryPathClaimV1Schema.parse(value);
}

/**
 * Re-frames a task claim as a worktree claim under `.archflow/tasks/<task-id>/`. Throws, per the
 * contract-layer convention, if the composed path is not itself a valid claim — which a 1024-byte
 * task claim plus the prefix, or a task slug ending in a dot, can produce.
 */
export function toRepositoryPathClaim(taskId: TaskSlug, claim: TaskPathClaim): RepositoryPathClaim {
  return parseRepositoryPathClaim(`.archflow/tasks/${taskId}/${claim}`);
}

/** The verbatim request and clarification record pinned into PRD review envelopes. */
export function userAskClaim(): TaskPathClaim {
  return parseTaskPathClaim("ask.md");
}

export function authorityInitializationClaim(): TaskPathClaim {
  return parseTaskPathClaim("authority/initialization.json");
}

/** The sole durable manifest location derived from its content digest. */
export function authorityResultClaim(resultDigest: Sha256Digest): TaskPathClaim {
  return parseTaskPathClaim(`authority/results/${resultDigest}.json`);
}

export function authorityDecisionRequestClaim(gateId: PathSafeId): TaskPathClaim {
  return parseTaskPathClaim(`authority/decisions/${gateId}/request.json`);
}

export function authorityDecisionRecordClaim(gateId: PathSafeId): TaskPathClaim {
  return parseTaskPathClaim(`authority/decisions/${gateId}/decision.json`);
}

export function authoritySupplementalReviewClaim(gateId: PathSafeId): TaskPathClaim {
  return parseTaskPathClaim(`authority/decisions/${gateId}/supplemental-review.json`);
}

/** Total constructor: a path is branded as Git's output without asserting anything about it. */
export function rawGitPath(value: string): RawGitPath {
  return value as RawGitPath;
}

/**
 * The sole promotion from untrusted Git output to a branded claim. Returns `undefined` rather
 * than throwing, so a caller can count the names it cannot represent instead of failing while
 * merely inspecting them.
 */
export function tryRepositoryPathClaim(value: RawGitPath): RepositoryPathClaim | undefined {
  const result = repositoryPathClaimV1Schema.safeParse(value);
  return result.success ? result.data : undefined;
}

export const TASK_PATH_CLASSES = [
  "task-config", "task-state", "task-ask", "document",
  "authority-initialization", "authority-result", "authority-decision",
] as const;
export const REPOSITORY_PATH_CLASSES = [
  "shared-workflow", "shared-constitution", "task-branch-constitution", "repository-source",
] as const;
export const PATH_CLASSES = [...TASK_PATH_CLASSES, ...REPOSITORY_PATH_CLASSES] as const;

export type TaskPathClass = (typeof TASK_PATH_CLASSES)[number];
export type RepositoryPathClass = (typeof REPOSITORY_PATH_CLASSES)[number];
export type PathClass = (typeof PATH_CLASSES)[number];

/** Classes ArchFlow reads but never writes. */
export const READ_ONLY_PATH_CLASSES: readonly PathClass[] = ["shared-workflow", "shared-constitution"];

const pathClassSchema = z.enum(PATH_CLASSES);

export function parsePathClass(value: unknown): PathClass {
  assertPlainJson(value, "path class");
  return pathClassSchema.parse(value);
}

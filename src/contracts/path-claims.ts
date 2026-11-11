import { z } from "zod";

import { endsWithDotOrSpace, isReservedDeviceName } from "./evidence.js";
import { assertPlainJson } from "./plain-json.js";

declare const repositoryPathClaimBrand: unique symbol;
/** A lexical path claim rooted at the worktree. */
export type RepositoryPathClaim = string & { readonly [repositoryPathClaimBrand]: true };

const utf8Length = (value: string): number => Buffer.byteLength(value, "utf8");
const containsControl = (value: string): boolean => /[\u0000-\u001f\u007f-\u009f]/u.test(value);
const hasDriveOrUncPrefix = (value: string): boolean => /^[A-Za-z]:/u.test(value) || value.startsWith("//");
const hasInvalidComponent = (value: string): boolean => value.split("/").some((component) => component === "" || component === "." || component === "..");
/**
 * `:` also covers Windows drive-relative paths and NTFS alternate data streams; the other
 * forbidden characters are Windows-illegal. Brackets are literal filename characters;
 * Git callers use literal pathspecs.
 */
const forbiddenCharacter = /[:*?<>|]/u;
/** Both component rules are the shared ones from `evidence.ts`, applied to every segment. */
const hasReservedComponent = (value: string): boolean => value.split("/").some(isReservedDeviceName);
const hasTrailingDotOrSpace = (value: string): boolean => value.split("/").some(endsWithDotOrSpace);

/**
 * The one-pattern form of every lexical rule below except the NFC and UTF-8 byte bounds, which no
 * `pattern` can express. `path-claim.schema.json` emits this source verbatim, so the generated
 * schema and the named refines cannot drift apart.
 */
const PATH_CLAIM_PATTERN = new RegExp(
  String.raw`^(?!/)(?![A-Za-z]:)(?!//)(?!.*\\)(?!.*[\u0000-\u001F\u007F-\u009F])(?!\.\.?(?:/|$))(?!.*\/\.\.?(?:/|$))(?!.*//)(?!.*[:*?<>|])(?!.*[. ](?:/|$))(?!(?:.*/)?(?:[Cc][Oo][Nn]|[Pp][Rr][Nn]|[Aa][Uu][Xx]|[Nn][Uu][Ll]|[Cc][Oo][Mm][1-9]|[Ll][Pp][Tt][1-9])(?:\.[^/]*)?(?:/|$)).+$`,
  "u"
);

/**
 * The sole lexical path-claim authority, mirroring `src/contracts/schemas/v1/path-claim.schema.json`
 * rule for rule. Built once per identity: the schema generator registers the document root, and a
 * registry identity can carry only one URI, so the branded schema must be its own object.
 */
const pathClaimLexical = () => z.string()
  .min(1)
  .regex(PATH_CLAIM_PATTERN, "path claim violates the lexical path pattern")
  .refine((value) => utf8Length(value) <= 1024, "path claim must be at most 1024 UTF-8 bytes")
  .refine((value) => !value.startsWith("/"), "path claim must be relative")
  .refine((value) => !hasDriveOrUncPrefix(value), "path claim must not use a drive or UNC prefix")
  .refine((value) => !value.includes("\\"), "path claim must use forward slashes")
  .refine((value) => !containsControl(value), "path claim must not contain control characters")
  .refine((value) => !forbiddenCharacter.test(value), "path claim must not contain : * ? < > or |")
  .refine((value) => !hasInvalidComponent(value), "path claim components must be non-empty and may not be . or ..")
  .refine((value) => !hasReservedComponent(value), "path claim components must not be reserved device names")
  .refine((value) => !hasTrailingDotOrSpace(value), "path claim components must not end with a dot or a space")
  .refine((value) => value.normalize("NFC") === value, "path claim components must already be NFC");

/** The `path-claim.schema.json` document root; `simple-review-input` references it for declared paths. */
export const pathClaimLexicalV1Schema = pathClaimLexical();
export const repositoryPathClaimV1Schema = pathClaimLexical() as unknown as z.ZodType<RepositoryPathClaim>;

/** Parses a worktree-relative lexical claim. This does not inspect a file system. */
export function parseRepositoryPathClaim(value: unknown): RepositoryPathClaim {
  assertPlainJson(value, "repository path claim");
  return repositoryPathClaimV1Schema.parse(value);
}

import { z } from "zod";

import { assertPlainJson } from "./plain-json.js";

declare const sha256DigestBrand: unique symbol;
declare const safeIdBrand: unique symbol;
declare const pathSafeIdBrand: unique symbol;
declare const taskSlugBrand: unique symbol;
declare const safeCodeBrand: unique symbol;
declare const safeVersionBrand: unique symbol;
declare const safeIntegerBrand: unique symbol;

export type Sha256Digest = string & { readonly [sha256DigestBrand]: true };
export type SafeId = string & { readonly [safeIdBrand]: true };
/**
 * An identifier that is safe to embed as a single path segment. Narrower than `SafeId`, which
 * permits `:` — a character the path claim schema rejects outright.
 */
export type PathSafeId = string & { readonly [pathSafeIdBrand]: true };
/** A task identifier: lowercase only, no `:`, and at most 64 characters. */
export type TaskSlug = string & { readonly [taskSlugBrand]: true };
export type SafeCode = string & { readonly [safeCodeBrand]: true };
export type SafeVersion = string & { readonly [safeVersionBrand]: true };
export type SafeInteger = number & { readonly [safeIntegerBrand]: true };

export interface ReferencedEvidence<T> {
  readonly evidence_digest: Sha256Digest;
  readonly evidence: T;
}

/**
 * Win32 reserves these names with any extension, so `CON.txt` is still `CON`.
 *
 * This lives here rather than in `path-claims.ts` because it is a rule about a *single path
 * component*, and `PathSafeId`/`TaskSlug` exist precisely to be embedded as one. `path-claims.ts`
 * imports it (the dependency runs claims → evidence, never the reverse), so the identifier
 * vocabularies and the path-claim authority cannot drift apart.
 */
export const RESERVED_DEVICE_NAME = /^(?:CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])(?:\.[^/]*)?$/iu;
export const isReservedDeviceName = (component: string): boolean => RESERVED_DEVICE_NAME.test(component);
/** Win32 silently strips trailing dots and spaces, so `a.` and `a` would alias one file. */
export const endsWithDotOrSpace = (component: string): boolean => /[. ]$/u.test(component);

/**
 * The path-segment rules below mirror `src/contracts/schemas/v1/path-claim.schema.json` and the
 * `pathSafeId`/`taskSlug` `$defs` in `primitives.schema.json`. Each `.regex()` carries its
 * primitives pattern verbatim — lookaheads included — so a generated schema emits the same
 * `pattern`; the refines restate the lookahead rules with named messages. A trailing space needs
 * no rule of its own: neither character class admits a space anywhere. Both vocabularies are
 * ASCII-only, so the claim schema's NFC and UTF-8 byte-length rules are satisfied by construction.
 */
const pathSegmentSafe = <T extends z.ZodType<string>>(schema: T): T =>
  schema
    .refine((value) => !isReservedDeviceName(value), "must not be a reserved Windows device name")
    .refine((value) => !endsWithDotOrSpace(value), "must not end with a dot or a space") as unknown as T;

export const sha256DigestV1Schema = z.string().regex(/^[0-9a-f]{64}$/u);
export const safeIdV1Schema = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u);
export const pathSafeIdV1Schema = pathSegmentSafe(z.string().regex(/^(?!(?:[Cc][Oo][Nn]|[Pp][Rr][Nn]|[Aa][Uu][Xx]|[Nn][Uu][Ll]|[Cc][Oo][Mm][1-9]|[Ll][Pp][Tt][1-9])(?:\.[^/]*)?$)(?!.*[. ]$)[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u)) as unknown as z.ZodType<PathSafeId>;
export const taskSlugV1Schema = pathSegmentSafe(z.string().regex(/^(?!(?:[Cc][Oo][Nn]|[Pp][Rr][Nn]|[Aa][Uu][Xx]|[Nn][Uu][Ll]|[Cc][Oo][Mm][1-9]|[Ll][Pp][Tt][1-9])(?:\.[^/]*)?$)(?!.*[. ]$)[a-z0-9][a-z0-9._-]{0,63}$/u)) as unknown as z.ZodType<TaskSlug>;
export const safeCodeV1Schema = z.string().regex(/^[a-z0-9][a-z0-9_-]{0,63}$/u);
export const safeVersionV1Schema = z.string().regex(/^[A-Za-z0-9.-]{1,64}$/u);
export const safeIntegerV1Schema = z.number().int().min(0).max(Number.MAX_SAFE_INTEGER);

export function parseSha256Digest(value: unknown): Sha256Digest {
  assertPlainJson(value, "SHA-256 digest");
  return sha256DigestV1Schema.parse(value) as Sha256Digest;
}

export function parseSafeId(value: unknown): SafeId {
  assertPlainJson(value, "safe identifier");
  return safeIdV1Schema.parse(value) as SafeId;
}

export function parsePathSafeId(value: unknown): PathSafeId {
  assertPlainJson(value, "path-safe identifier");
  return pathSafeIdV1Schema.parse(value);
}

export function parseTaskSlug(value: unknown): TaskSlug {
  assertPlainJson(value, "task slug");
  return taskSlugV1Schema.parse(value);
}

export function parseSafeCode(value: unknown): SafeCode {
  assertPlainJson(value, "safe code");
  return safeCodeV1Schema.parse(value) as SafeCode;
}

export function parseSafeVersion(value: unknown): SafeVersion {
  assertPlainJson(value, "safe version");
  return safeVersionV1Schema.parse(value) as SafeVersion;
}

export function parseSafeInteger(value: unknown): SafeInteger {
  assertPlainJson(value, "safe integer");
  return safeIntegerV1Schema.parse(value) as SafeInteger;
}

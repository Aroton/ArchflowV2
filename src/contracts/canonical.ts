import { createHash } from "node:crypto";

import { z } from "zod";

import type { Sha256Digest } from "./evidence.js";
import { assertPlainJson, type PlainJsonValue } from "./plain-json.js";

declare const gitOidBrand: unique symbol;

/** Lowercase 40-character hexadecimal SHA-1 object name; blobs and commits share one brand. */
export type GitOid = string & { readonly [gitOidBrand]: true };

export const GIT_TREE_MODES = ["040000", "100644", "100755", "120000", "160000"] as const;
export type GitTreeMode = (typeof GIT_TREE_MODES)[number];
/** The only mode legal below the `.archflow` tree: no executables, symlinks, or gitlinks. */
export type ArchflowTreeMode = "100644";

export const gitOidV1Schema = z.string().regex(/^[0-9a-f]{40}$/u) as unknown as z.ZodType<GitOid>;
export const gitTreeModeV1Schema = z.enum(GIT_TREE_MODES) as unknown as z.ZodType<GitTreeMode>;

export function parseGitOid(value: unknown): GitOid {
  assertPlainJson(value, "git object name");
  return gitOidV1Schema.parse(value);
}

export function parseGitTreeMode(value: unknown): GitTreeMode {
  assertPlainJson(value, "git tree mode");
  return gitTreeModeV1Schema.parse(value);
}

/** Normalises the raw-tree 5-character `40000` form to the displayed `040000` form. */
export function normalizeGitTreeMode(value: string): GitTreeMode {
  return parseGitTreeMode(value === "40000" ? "040000" : value);
}

const encoder = new TextEncoder();
const decoder = new TextDecoder("utf-8", { fatal: true });

function ordinal(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/**
 * Mirrors `sortCanonical` in `scripts/release-support.mjs`: object keys are sorted by ordinal
 * comparison, arrays keep their source order because that order is semantic, and `undefined`
 * or non-finite numbers are rejected rather than silently dropped or emitted as `null`.
 */
function sortCanonical(value: unknown): unknown {
  if (Array.isArray(value)) return (value as readonly unknown[]).map(sortCanonical);
  if (value !== null && typeof value === "object") {
    const record = value as Record<string, unknown>;
    return Object.fromEntries(
      Object.keys(record)
        .sort(ordinal)
        .map((key) => [key, sortCanonical(record[key])])
    );
  }
  if (value === undefined) throw new TypeError("canonical JSON cannot contain undefined");
  if (typeof value === "number" && !Number.isFinite(value)) {
    throw new TypeError("canonical JSON cannot contain a non-finite number");
  }
  return value;
}

/** Ordinal-sorted keys, 2-space indent, exactly one trailing newline, UTF-8. */
export function canonicalJsonBytes(value: PlainJsonValue): Uint8Array {
  return encoder.encode(`${JSON.stringify(sortCanonical(value), null, 2)}\n`);
}

export function sha256Bytes(bytes: Uint8Array): Sha256Digest {
  return createHash("sha256").update(bytes).digest("hex") as Sha256Digest;
}

export function canonicalJsonDigest(value: PlainJsonValue): Sha256Digest {
  return sha256Bytes(canonicalJsonBytes(value));
}

/** OID = SHA1("blob " + ASCII_decimal(content.byteLength) + NUL + content). */
export function gitBlobOid(content: Uint8Array): GitOid {
  const header = Buffer.from(`blob ${String(content.byteLength)}\0`, "ascii");
  return createHash("sha1").update(header).update(content).digest("hex") as GitOid;
}

/**
 * Shared digest helpers so independent callers construct identical error parameters. Both are
 * domain-tagged so a commit name and a filesystem path can never collide on one digest, and both
 * hash their subject rather than carrying it, because the project error parameter schemas accept
 * only `/^[0-9a-f]{64}$/`.
 */
export function historyIdentityDigest(oid: GitOid): Sha256Digest {
  return sha256Bytes(encoder.encode(`archflow:history-identity:v1:${oid}`));
}

export function repositoryCandidateDigest(absoluteCwd: string): Sha256Digest {
  return sha256Bytes(encoder.encode(`archflow:repository-candidate:v1:${absoluteCwd}`));
}

export interface CanonicalDocument<T extends PlainJsonValue> {
  readonly bytes: Uint8Array;
  readonly value: T;
  readonly digest: Sha256Digest;
}

export function canonicalDocument<T extends PlainJsonValue>(value: T): CanonicalDocument<T> {
  const bytes = canonicalJsonBytes(value);
  return Object.freeze({ bytes, value, digest: sha256Bytes(bytes) });
}

/**
 * Byte authority for a canonical JSON document. In this exact order: fatal UTF-8 decode, so
 * malformed input throws rather than producing replacement characters; `JSON.parse`;
 * `assertPlainJson`; re-render with `canonicalJsonBytes` and byte-compare against the input,
 * rejecting every noncanonical form — permuted keys, non-two-space indent, a missing or extra
 * trailing newline, or any other whitespace difference. Duplicate object keys need no special
 * rule: `JSON.parse` keeps the last, so the re-render is shorter and fails the comparison.
 * `digest` covers the original bytes, which the comparison has proven byte-identical to the
 * canonical form, so the two possible readings coincide by construction.
 */
export function parseCanonicalDocument<T extends PlainJsonValue>(
  bytes: Uint8Array,
  label = "JSON document"
): CanonicalDocument<T> {
  if (!(bytes instanceof Uint8Array)) throw new TypeError(`${label} must be bytes`);
  let text: string;
  try {
    text = decoder.decode(bytes);
  } catch (error) {
    throw new TypeError(`${label} is not valid UTF-8: ${(error as Error).message}`);
  }
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch (error) {
    throw new TypeError(`${label} is not valid JSON: ${(error as Error).message}`);
  }
  assertPlainJson(value, label);
  const expected = canonicalJsonBytes(value);
  if (!Buffer.from(bytes).equals(Buffer.from(expected))) {
    throw new TypeError(`${label} is not canonical JSON`);
  }
  return Object.freeze({ bytes, value: value as T, digest: sha256Bytes(bytes) });
}

import { createHash } from "node:crypto";

import { z } from "zod";

import type { Sha256Digest } from "./evidence.js";
import { assertPlainJson, type PlainJsonValue } from "./plain-json.js";

declare const gitOidBrand: unique symbol;

/** Lowercase 40-character hexadecimal SHA-1 object name; blobs and commits share one brand. */
export type GitOid = string & { readonly [gitOidBrand]: true };

const GIT_OID_REGEX = /^[0-9a-f]{40}$/u;

export const gitOidV1Schema = z.string().regex(/^[0-9a-f]{40}$/u) as unknown as z.ZodType<GitOid>;

export function parseGitOid(value: unknown): GitOid {
  if (typeof value === "string" && value.length === 40 && GIT_OID_REGEX.test(value)) {
    return value as GitOid;
  }
  assertPlainJson(value, "git object name");
  return gitOidV1Schema.parse(value);
}

const encoder = new TextEncoder();

function ordinal(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/**
 * Mirrors `sortCanonical` in `scripts/release-support.mjs`: object keys are sorted by ordinal
 * comparison, arrays keep their source order because that order is semantic, and `undefined`
 * or non-finite numbers are rejected rather than silently dropped or emitted as `null`.
 */
function sortCanonical(value: unknown): unknown {
  if (typeof value === "string" || typeof value === "boolean" || value === null) {
    return value;
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value)) {
      throw new TypeError("canonical JSON cannot contain a non-finite number");
    }
    return value;
  }
  if (Array.isArray(value)) {
    const len = value.length;
    const result = new Array(len);
    for (let i = 0; i < len; i++) {
      result[i] = sortCanonical(value[i]);
    }
    return result;
  }
  if (typeof value === "object") {
    const record = value as Record<string, unknown>;
    const keys = Object.keys(record);
    if (keys.length > 1) {
      keys.sort(ordinal);
    }
    const sorted: Record<string, unknown> = {};
    for (let i = 0; i < keys.length; i++) {
      const key = keys[i]!;
      sorted[key] = sortCanonical(record[key]);
    }
    return sorted;
  }
  if (value === undefined) throw new TypeError("canonical JSON cannot contain undefined");
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
  return createHash("sha256")
    .update(`${JSON.stringify(sortCanonical(value), null, 2)}\n`, "utf8")
    .digest("hex") as Sha256Digest;
}

export function repositoryCandidateDigest(absoluteCwd: string): Sha256Digest {
  return createHash("sha256")
    .update(`archflow:repository-candidate:v1:${absoluteCwd}`, "utf8")
    .digest("hex") as Sha256Digest;
}

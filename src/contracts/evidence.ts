import { z } from "zod";

import { assertPlainJson } from "./plain-json.js";

declare const sha256DigestBrand: unique symbol;
declare const safeIdBrand: unique symbol;
declare const safeCodeBrand: unique symbol;
declare const safeVersionBrand: unique symbol;
declare const safeIntegerBrand: unique symbol;

export type Sha256Digest = string & { readonly [sha256DigestBrand]: true };
export type SafeId = string & { readonly [safeIdBrand]: true };
export type SafeCode = string & { readonly [safeCodeBrand]: true };
export type SafeVersion = string & { readonly [safeVersionBrand]: true };
export type SafeInteger = number & { readonly [safeIntegerBrand]: true };

export interface ReferencedEvidence<T> {
  readonly evidence_digest: Sha256Digest;
  readonly evidence: T;
}

export const sha256DigestV1Schema = z.string().regex(/^[0-9a-f]{64}$/u);
export const safeIdV1Schema = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u);
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

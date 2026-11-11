import { z } from "zod";

import { assertPlainJson } from "./plain-json.js";

declare const sha256DigestBrand: unique symbol;
declare const safeCodeBrand: unique symbol;
declare const safeIntegerBrand: unique symbol;

export type Sha256Digest = string & { readonly [sha256DigestBrand]: true };
export type SafeCode = string & { readonly [safeCodeBrand]: true };
export type SafeInteger = number & { readonly [safeIntegerBrand]: true };

/**
 * Win32 reserves these names with any extension, so `CON.txt` is still `CON`. `path-claims.ts`
 * applies this rule to every component of a path claim.
 */
const RESERVED_DEVICE_NAME = /^(?:CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])(?:\.[^/]*)?$/iu;
export const isReservedDeviceName = (component: string): boolean => RESERVED_DEVICE_NAME.test(component);
/** Win32 silently strips trailing dots and spaces, so `a.` and `a` would alias one file. */
export const endsWithDotOrSpace = (component: string): boolean => /[. ]$/u.test(component);

const SAFE_CODE_REGEX = /^[a-z0-9][a-z0-9_-]{0,63}$/u;

export const sha256DigestV1Schema = z.string().regex(/^[0-9a-f]{64}$/u);
export const safeIdV1Schema = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u);
export const safeCodeV1Schema = z.string().regex(/^[a-z0-9][a-z0-9_-]{0,63}$/u);
export const safeVersionV1Schema = z.string().regex(/^[A-Za-z0-9.-]{1,64}$/u);
export const safeIntegerV1Schema = z.number().int().min(0).max(Number.MAX_SAFE_INTEGER);

export function parseSafeCode(value: unknown): SafeCode {
  if (typeof value === "string" && value.length >= 1 && value.length <= 64 && SAFE_CODE_REGEX.test(value)) {
    return value as SafeCode;
  }
  assertPlainJson(value, "safe code");
  return safeCodeV1Schema.parse(value) as SafeCode;
}

export function parseSafeInteger(value: unknown): SafeInteger {
  if (typeof value === "number" && Number.isInteger(value) && value >= 0 && value <= Number.MAX_SAFE_INTEGER) {
    return value as SafeInteger;
  }
  assertPlainJson(value, "safe integer");
  return safeIntegerV1Schema.parse(value) as SafeInteger;
}

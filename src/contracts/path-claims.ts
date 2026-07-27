import { z } from "zod";

import { assertPlainJson } from "./plain-json.js";

declare const taskPathClaimBrand: unique symbol;

export type TaskPathClaim = string & { readonly [taskPathClaimBrand]: true };

const utf8Length = (value: string): number => Buffer.byteLength(value, "utf8");
const containsControl = (value: string): boolean => /[\u0000-\u001f\u007f-\u009f]/u.test(value);
const hasDriveOrUncPrefix = (value: string): boolean => /^[A-Za-z]:/u.test(value) || value.startsWith("//");
const hasInvalidComponent = (value: string): boolean => value.split("/").some((component) => component === "" || component === "." || component === "..");

export const taskPathClaimV1Schema = z.string()
  .min(1)
  .refine((value) => utf8Length(value) <= 1024, "path claim must be at most 1024 UTF-8 bytes")
  .refine((value) => !value.startsWith("/"), "path claim must be relative")
  .refine((value) => !hasDriveOrUncPrefix(value), "path claim must not use a drive or UNC prefix")
  .refine((value) => !value.includes("\\"), "path claim must use forward slashes")
  .refine((value) => !containsControl(value), "path claim must not contain control characters")
  .refine((value) => !hasInvalidComponent(value), "path claim components must be non-empty and may not be . or ..");

/**
 * Parses a bounded task-relative lexical claim. This does not inspect a file
 * system or grant repository/task containment authority.
 */
export function parseTaskPathClaim(value: unknown): TaskPathClaim {
  assertPlainJson(value, "task path claim");
  return taskPathClaimV1Schema.parse(value) as TaskPathClaim;
}

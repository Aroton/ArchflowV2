import { z } from "zod";

import type { SafeCode, SafeId, SafeInteger } from "./evidence.js";
import { safeCodeV1Schema, safeIdV1Schema } from "./evidence.js";
import type { PathClass, RepositoryPathClaim } from "./path-claims.js";
import { PATH_CLASSES, repositoryPathClaimV1Schema } from "./path-claims.js";
import { assertPlainJson } from "./plain-json.js";

/**
 * A scan subject. `virtual_path` is a `RepositoryPathClaim` and that is provable rather than
 * assumed: candidates are always *declared* paths — a projection ArchFlow itself generates under
 * `.archflow/`, or a declared implementation output the claim schema has already validated. They
 * are never raw Git output, so no unrepresentable name can reach this contract.
 */
export interface SecretScanCandidate {
  readonly virtual_path: RepositoryPathClaim;
  readonly path_class: PathClass;
  readonly content: string;
}

/**
 * A finding carries no matched text, no surrounding context, and no redacted excerpt. The existing
 * `SECRET_DETECTED` error takes exactly `{path_class, detector_id}`, which is the correct shape.
 *
 * Safety note for whoever adapts an engine in Phase 8: secretlint puts the **matched secret into
 * `message`** — real output reads `"found GitHub Token…: ghp_16C7e"`. An adapter must
 * **explicitly drop `message`**, not merely omit it from the TypeScript type, or the value
 * survives into logs through a stray object spread. `loc.start.line` and `loc.start.column` map
 * cleanly onto `line`/`column`, and `ruleId` maps onto `detector_id`.
 */
export type SecretFinding = {
  readonly detector_id: SafeId;
  readonly path_class: PathClass;
  readonly virtual_path: RepositoryPathClaim;
  /** 1-based, matching editor and secretlint convention; `SafeInteger` alone would permit `0`. */
  readonly line: SafeInteger;
  /** 1-based. */
  readonly column: SafeInteger;
};

/**
 * `outcome: "unavailable"` is the one declared exception to the phase's failure convention, and it
 * is a third channel deliberately: the scanner's absence is a *result state* that must be
 * persistable as evidence that a projection was never scanned, not a call failure. A
 * `ProjectResult` error would be surfaced and discarded.
 */
export type SecretScanResult =
  | Readonly<{ schema_version: "1"; outcome: "clean"; detector_set_id: SafeId; scanned_paths: readonly RepositoryPathClaim[] }>
  | Readonly<{ schema_version: "1"; outcome: "detected"; detector_set_id: SafeId; findings: readonly SecretFinding[] }>
  | Readonly<{ schema_version: "1"; outcome: "unavailable"; reason: SafeCode }>;

const detectorId = safeIdV1Schema as unknown as z.ZodType<SafeId>;
const pathClass = z.enum(PATH_CLASSES);
const position = z.number().int().min(1).max(Number.MAX_SAFE_INTEGER);

export const secretFindingV1Schema = z.object({
  detector_id: detectorId,
  path_class: pathClass,
  virtual_path: repositoryPathClaimV1Schema,
  line: position,
  column: position,
}).strict();

export const secretScanResultV1Schema = z.discriminatedUnion("outcome", [
  z.object({
    schema_version: z.literal("1"),
    outcome: z.literal("clean"),
    detector_set_id: detectorId,
    scanned_paths: z.array(repositoryPathClaimV1Schema),
  }).strict(),
  z.object({
    schema_version: z.literal("1"),
    outcome: z.literal("detected"),
    detector_set_id: detectorId,
    findings: z.array(secretFindingV1Schema),
  }).strict(),
  z.object({
    schema_version: z.literal("1"),
    outcome: z.literal("unavailable"),
    reason: safeCodeV1Schema,
  }).strict(),
]) as unknown as z.ZodType<SecretScanResult>;

/** Throws, per the contract-layer convention. */
export function parseSecretScanResult(value: unknown): SecretScanResult {
  assertPlainJson(value, "secret scan result");
  return secretScanResultV1Schema.parse(value);
}

/**
 * The interface Phase 8 implements. This phase ships the contract and no implementation: no
 * scanning engine and no dependency.
 */
export interface SecretScanner {
  readonly scan: (candidates: readonly SecretScanCandidate[]) => Promise<SecretScanResult>;
}

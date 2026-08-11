import type { PathSafeId, SafeInteger, Sha256Digest, TaskSlug } from "./evidence.js";
import type { RepositoryPathClaim } from "./path-claims.js";

/**
 * The record of one human-authorized maintenance deletion pass.
 *
 * **This module declares no Zod schema (D2), and it must not.** Like `TaskStateV1`, a maintenance
 * record is purely server-internal — no agent supplies one across the MCP tool boundary — so
 * `maintenance-record.schema.json` is its sole shape authority. A success criterion greps for a
 * mirror. Every type is a `type` alias rather than an `interface` (D1).
 */

/**
 * `retired-intent` covers only `record-state-boundary` receipts that no longer sit at or after the
 * current revision. Every other receipt kind is retained indefinitely, because adjudication
 * (`loadRetiredOutcome`) and gate replay both read *retired* receipts by intent id; a boundary
 * receipt installs no result and has no such reader. `retired-staged-request` covers the
 * compose-to-call handoff buffer once its receipt exists — the request digest, not the file, is
 * what a rehydration is authenticated against.
 */
export const MAINTENANCE_DELETION_CATEGORIES = [
  "unreferenced-attempt",
  "superseded-payload",
  "retired-intent",
  "retired-staged-request",
] as const;
export type MaintenanceDeletionCategory = (typeof MAINTENANCE_DELETION_CATEGORIES)[number];

/**
 * `byte_count` genuinely admits `0` — a zero-byte payload is deletable — so it reuses `SafeInteger`
 * and `$ref`s `primitives#/$defs/safeInteger` rather than pinning its own minimum (D8).
 */
export type MaintenanceDeletion = {
  readonly digest: Sha256Digest;
  readonly path: RepositoryPathClaim;
  readonly byte_count: SafeInteger;
  readonly category: MaintenanceDeletionCategory;
};

export type MaintenanceRecordV1 = {
  readonly schema_version: "1";
  readonly maintenance_id: PathSafeId;
  readonly task_id: TaskSlug;
  /** `>= 1` (D8) — there is no revision `0`. */
  readonly performed_at_revision: SafeInteger;
  /** The human's own words. `minLength` 1, capped at 4096 UTF-8 bytes. */
  readonly human_reason: string;
  readonly reachability_proof_digest: Sha256Digest;
  /**
   * SET — sorted by `digest`, duplicates rejected, and **non-empty**: a maintenance record that
   * deleted nothing is not a record worth writing.
   */
  readonly deletions: readonly MaintenanceDeletion[];
  /** Equals the sum of `deletions[*].byte_count`; the equality is `validateDurableSemantics`'s. */
  readonly total_bytes_deleted: SafeInteger;
};

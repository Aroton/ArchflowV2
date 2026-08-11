import { z } from "zod";

import type { PathSafeId, SafeInteger, Sha256Digest, TaskSlug } from "./evidence.js";
import { pathSafeIdV1Schema, safeIntegerV1Schema, sha256DigestV1Schema, taskSlugV1Schema } from "./evidence.js";
import type { RepositoryPathClaim } from "./path-claims.js";
import { repositoryPathClaimV1Schema } from "./path-claims.js";
import { assertPlainJson } from "./plain-json.js";
import { isSortedUniqueBy, tupleKey } from "./validators.js";

/**
 * The record of one human-authorized maintenance deletion pass. A maintenance record is purely
 * server-internal — no agent supplies one across the MCP tool boundary. `maintenanceRecordV1Schema`
 * below is the runtime shape authority — `parseMaintenanceRecord` is what `maintenance-roots.ts`
 * and `local/commands.ts` validate through — and `maintenance-record.schema.json` is generated from
 * it. `total_bytes_deleted === sum(deletions[*].byte_count)` — not expressible in either — stays
 * with `validateDurableSemantics`. Every type is a `type` alias rather than an `interface` (D1).
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

const safeInteger = safeIntegerV1Schema as unknown as z.ZodType<SafeInteger>;
const sha256Digest = sha256DigestV1Schema as unknown as z.ZodType<Sha256Digest>;

/** The `human_reason` byte cap, mirroring `x-archflow-max-utf8-bytes` in the JSON Schema. */
const HUMAN_REASON_MAX_UTF8_BYTES = 4096;

/** Exported for schema generation only: the `maintenanceDeletion` `$def` is root-internal. */
export const maintenanceDeletionV1Schema = z.object({
  digest: sha256Digest,
  path: repositoryPathClaimV1Schema,
  byte_count: safeInteger,
  category: z.enum(MAINTENANCE_DELETION_CATEGORIES),
}).strict();

/**
 * The mirror. `performed_at_revision` pins its own `.min(1)` rather than reusing
 * `safeIntegerV1Schema` (D8): `SafeInteger` admits `0`, and there is no revision `0`. The
 * `deletions` ordering rule calls `isSortedUniqueBy` with `tupleKey("digest")` — the shared
 * exported ordering predicates — so every shape enforces literally the same rule. `human_reason`
 * bounds UTF-8 *bytes*, not code units.
 */
export const maintenanceRecordV1Schema = z.object({
  schema_version: z.literal("1"),
  maintenance_id: pathSafeIdV1Schema,
  task_id: taskSlugV1Schema,
  performed_at_revision: z.number().int().min(1).max(Number.MAX_SAFE_INTEGER),
  human_reason: z.string().min(1)
    .refine((value) => Buffer.byteLength(value, "utf8") <= HUMAN_REASON_MAX_UTF8_BYTES, "human_reason must be at most 4096 UTF-8 bytes"),
  reachability_proof_digest: sha256Digest,
  deletions: z.array(maintenanceDeletionV1Schema).min(1)
    .refine((items) => isSortedUniqueBy(items, tupleKey("digest")), "deletions must be sorted by digest with no duplicates"),
  total_bytes_deleted: safeInteger,
}).strict() as unknown as z.ZodType<MaintenanceRecordV1>;

/** Throws, per the contract-layer convention. */
export function parseMaintenanceRecord(value: unknown): MaintenanceRecordV1 {
  assertPlainJson(value, "maintenance record");
  return maintenanceRecordV1Schema.parse(value);
}

import { z } from "zod";

import type { GitOid } from "./canonical.js";
import { gitOidV1Schema } from "./canonical.js";
import type { CanonicalTaskPaths } from "./durable-primitives.js";
import { canonicalTaskPathsV1Schema } from "./durable-primitives.js";
import type { SafeInteger, Sha256Digest, TaskSlug } from "./evidence.js";
import { safeIntegerV1Schema, sha256DigestV1Schema, taskSlugV1Schema } from "./evidence.js";
import type { PhaseInstanceId } from "./phase-instance.js";
import { phaseInstanceIdV1Schema } from "./phase-instance.js";
import type { RepositoryPathClaim } from "./path-claims.js";
import { repositoryPathClaimV1Schema } from "./path-claims.js";
import { assertPlainJson } from "./plain-json.js";
import { isSortedUniqueBy, tupleKey } from "./validators.js";

/**
 * One legacy document, where it lands in the destination task, and what standing it arrives with.
 *
 * `disposition` is `"draft" | "historical"` and deliberately never `"approved"`: an imported legacy
 * document has not passed this system's gates, so it cannot arrive pre-approved. The two-member
 * enum makes that unrepresentable in both authorities rather than rejected by a later rule.
 */
export type LegacyMappingEntry = {
  readonly legacy_path: RepositoryPathClaim;
  readonly destination_path: RepositoryPathClaim;
  readonly phase_instance: PhaseInstanceId;
  readonly disposition: "draft" | "historical";
};

/** One staged byte payload of the immutable import, addressed by its source path. */
export type StagedPayloadRef = {
  readonly legacy_path: RepositoryPathClaim;
  readonly digest: Sha256Digest;
  /** `$ref`s `safeInteger` deliberately (D8): a zero-byte staged payload is legal. */
  readonly byte_count: SafeInteger;
};

/**
 * The document a legacy-import-initialized task adopts once. Phase 7 defines the format only:
 * nothing stages, records, or enforces these values until Phase 9. The *manual-import-as-checkpoint-chain*
 * half of REQ-50 is Phase 8's and is deliberately absent here.
 *
 * It carries all five fields `TaskStateV1` duplicates — `repository_identity_digest`,
 * `config_digest`, `workflow_digest`, `constitution_digest`, `policy_base_commit` — plus `task_id`,
 * exactly as `task-initialization` does. That uniformity is what lets chunk 10's rank-7 comparison
 * run one clause list over both artifact kinds with no branch.
 *
 * D1 — a `type` alias, not an `interface`, transitively. This root is a member of
 * `CanonicalDocument<DurableArtifact>` in chunk 10, and `T extends PlainJsonValue` is checked
 * through the whole reachable graph.
 *
 * D2 — this shape is Zod-mirrored because an agent supplies it across the MCP tool boundary through
 * `archflow_state.artifact`, so it must be validated from untrusted input. This Zod source is the
 * shape authority: the committed `legacy-import-initialization.schema.json` is generated from it,
 * so the published document cannot drift.
 *
 * D15 — there is deliberately **no** re-pin field, no amendment field, no upgrade field, and no
 * second config digest. `config_digest` is the destination's config bytes and is the only one; do
 * not add another "for future flexibility".
 */
export type LegacyImportInitializationV1 = {
  readonly schema_version: "1";
  /** The discriminant of the `DurableArtifact` union (chunk 10). */
  readonly artifact_kind: "legacy-import-initialization";
  /** The destination task. */
  readonly task_id: TaskSlug;
  readonly repository_identity_digest: Sha256Digest;
  /** The selected legacy source, never mutated. */
  readonly source_identity_digest: Sha256Digest;
  /** The immutable staged import. */
  readonly import_digest: Sha256Digest;
  readonly import_baseline_commit: GitOid;
  readonly code_baseline_commit: GitOid;
  readonly policy_base_commit: GitOid;
  readonly constitution_digest: Sha256Digest;
  readonly workflow_digest: Sha256Digest;
  /** The exact whole-file config bytes of the DESTINATION task (D15). */
  readonly config_digest: Sha256Digest;
  readonly canonical_paths: CanonicalTaskPaths;
  /** SET — sorted by `destination_path`, duplicates rejected. */
  readonly mapping: readonly LegacyMappingEntry[];
  /** SET — sorted by `legacy_path`, duplicates rejected. */
  readonly staged_payload_refs: readonly StagedPayloadRef[];
  /** Present for resumable imports produced by the current upgrader. */
  readonly resume_phase?: PhaseInstanceId;
  readonly planned_final_phase?: SafeInteger;
  readonly target_ref?: string;
  readonly commit_message?: string;
};

const sha256Digest = sha256DigestV1Schema as unknown as z.ZodType<Sha256Digest>;
const safeInteger = safeIntegerV1Schema as unknown as z.ZodType<SafeInteger>;

/** Exported for schema generation only: nothing outside this root declares a field of either element type. */
export const legacyMappingEntryV1Schema = z.object({
  legacy_path: repositoryPathClaimV1Schema,
  destination_path: repositoryPathClaimV1Schema,
  phase_instance: phaseInstanceIdV1Schema,
  disposition: z.enum(["draft", "historical"]),
}).strict();

export const stagedPayloadRefV1Schema = z.object({
  legacy_path: repositoryPathClaimV1Schema,
  digest: sha256Digest,
  byte_count: safeInteger,
}).strict();

/**
 * `.strict()` so an unknown field is rejected at the parse boundary rather than inside the semantic
 * validator, matching `additionalProperties: false` in `legacy-import-initialization.schema.json`.
 * Every field is required: absence is expressed as `.optional()` plus omission from `required`,
 * never as `null`, and this shape has no optional field.
 *
 * D11 — both set orderings call `isSortedUniqueBy` with `tupleKey(...)`, the shared exported
 * ordering predicates, so every shape enforces literally the same rule. Ordering is structural because `canonicalJsonBytes`
 * preserves array order: an unsorted set would let two callers digest identical logical content
 * differently.
 */
export const legacyImportInitializationV1Schema = z.object({
  schema_version: z.literal("1"),
  artifact_kind: z.literal("legacy-import-initialization"),
  task_id: taskSlugV1Schema,
  repository_identity_digest: sha256Digest,
  source_identity_digest: sha256Digest,
  import_digest: sha256Digest,
  import_baseline_commit: gitOidV1Schema,
  code_baseline_commit: gitOidV1Schema,
  policy_base_commit: gitOidV1Schema,
  constitution_digest: sha256Digest,
  workflow_digest: sha256Digest,
  config_digest: sha256Digest,
  canonical_paths: canonicalTaskPathsV1Schema,
  mapping: z.array(legacyMappingEntryV1Schema)
    .refine((items) => isSortedUniqueBy(items, tupleKey("destination_path")), "mapping must be sorted by destination_path with no duplicates"),
  staged_payload_refs: z.array(stagedPayloadRefV1Schema)
    .refine((items) => isSortedUniqueBy(items, tupleKey("legacy_path")), "staged_payload_refs must be sorted by legacy_path with no duplicates"),
  resume_phase: phaseInstanceIdV1Schema.optional(),
  planned_final_phase: safeInteger.optional(),
  target_ref: z.string().min(1).max(512).optional(),
  commit_message: z.string().min(1).max(512).optional(),
}).strict() as unknown as z.ZodType<LegacyImportInitializationV1>;

/** Throws, per the contract-layer convention. */
export function parseLegacyImportInitialization(value: unknown): LegacyImportInitializationV1 {
  assertPlainJson(value, "legacy import initialization");
  return legacyImportInitializationV1Schema.parse(value);
}

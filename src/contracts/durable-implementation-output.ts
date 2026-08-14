import { z } from "zod";

import type { GitOid } from "./canonical.js";
import { gitOidV1Schema } from "./canonical.js";
import type { OutputEntry, SnapshotAccountingV1 } from "./durable-primitives.js";
import { declaredInputRefV1Schema, outputEntryV1Schema, snapshotAccountingV1Schema } from "./durable-primitives.js";
import type { PathSafeId, SafeInteger, Sha256Digest, TaskSlug } from "./evidence.js";
import { pathSafeIdV1Schema, safeIntegerV1Schema, sha256DigestV1Schema, taskSlugV1Schema } from "./evidence.js";
import type { DeclaredInputRef } from "./fingerprints.js";
import type { PhaseInstanceId } from "./phase-instance.js";
import { phaseInstanceIdV1Schema } from "./phase-instance.js";
import type { RawGitPath, RepositoryPathClaim, TaskPathClaim } from "./path-claims.js";
import { repositoryPathClaimV1Schema, taskPathClaimV1Schema } from "./path-claims.js";
import { assertPlainJson } from "./plain-json.js";
import type { SecretScanResult } from "./secret-scan.js";
import { secretScanResultV1Schema } from "./secret-scan.js";
import { isSortedUniqueBy, tupleKey } from "./validators.js";
import type { PipelineStep } from "./vocabulary.js";
import { PIPELINE_STEPS } from "./vocabulary.js";

/**
 * The parent document an implementation output was produced against.
 *
 * D3 — `document_path` is a `TaskPathClaim`: task-relative, rooted at `.archflow/tasks/<task_id>/`,
 * and therefore a different *frame* from `OutputEntry.path` and `restore_targets`, which are
 * `RepositoryPathClaim` and rooted at the worktree. The two brands are the same runtime validator
 * cast twice (`path-claims.ts:44-45`), so the frames are runtime-indistinguishable and the `$ref`
 * name in the JSON Schema is what states the frame at each site. There is no runtime frame check
 * and there cannot be one.
 */
export type ParentDocumentRef = {
  readonly document_path: TaskPathClaim;
  readonly content_digest: Sha256Digest;
  readonly role: "prd" | "design" | "phase-design" | "impl-notes";
};

/**
 * What the worktree held that the output did not declare.
 *
 * `undeclared_paths` is `RawGitPath[]` rather than `RepositoryPathClaim[]`, deliberately: a valid
 * repository may contain a dirty file whose name carries a colon, a trailing dot, non-NFC text, or
 * a newline, and *reporting* an undeclared change must not throw when it meets one. `RawGitPath` is
 * a total constructor with no lexical rule (`path-claims.ts:15`, `:72`), and its JSON mirror is a
 * bare `{"type": "string"}` declared inline — it has no `$def` in `primitives.schema.json` and must
 * not be given one here. `unrepresentable_count` counts the names that could not be represented at
 * all, so a scan can be honest about what it dropped instead of silently shortening the list.
 */
export type UndeclaredChangeReport = {
  readonly scanned: boolean;
  /** SET — sorted, duplicates rejected. Raw Git output, not a claim. */
  readonly undeclared_paths: readonly RawGitPath[];
  readonly unrepresentable_count: SafeInteger;
};

/** Digest binding for the ignored raw verification transcript. */
export type VerificationEvidence = {
  readonly transcript_digest: Sha256Digest;
  readonly byte_count: SafeInteger;
};

/**
 * The manifest an implementation step produces: what it changed, against which tree, what the
 * review and commit authorization actually cover, and what it declared as input.
 *
 * D1 — a `type` alias, not an `interface`, transitively. This root becomes a member of
 * `CanonicalDocument<DurableArtifact>` in chunk 10, where `T extends PlainJsonValue` is checked
 * through the whole reachable graph; an `interface` anywhere inside fails with `TS2344`.
 *
 * D2 — Zod-mirrored, because an agent supplies this across the MCP tool boundary through
 * `archflow_state.artifact` and it must therefore be validated from untrusted input. This Zod
 * source is the shape authority: the committed `implementation-output.schema.json` is generated
 * from it, so the published document cannot drift.
 *
 * D14 — `constitution_edit_gate_id` is a **structural hook and nothing more**. An earlier draft made
 * a `task-branch-constitution` output claimable only when this field was present; that is
 * constitution-edit *gate policy*, which is REQ-16 and belongs to Phase 12. There is deliberately no
 * conditional-requirement rule tying this field to `path_class`, in either authority.
 *
 * **Structurally total, not integrity-total.** Nothing here requires `payload_bytes` to equal the
 * length of bytes actually retained, `payload_digest` to equal SHA-256 of those bytes, or
 * `after.oid` to equal `gitBlobOid(bytes)`. In Phase 7 those three are *assertions*; Phase 11 turns
 * them into verified facts at materialization time. A passing validation here is not evidence that
 * the bytes exist.
 *
 * **What this shape deliberately does not enforce**, because `validateDurableSemantics` (chunk 10)
 * is the single authority for it and a second one would drift: `restore_targets ⊆ outputs[].path`,
 * the accounting sums, the accounting-to-outputs correspondence, `previous_path !== path`, and
 * `phase_instance` decoding to `kind: "phase-impl"`. This shape's job is to make every field those
 * clauses read present, typed, and required.
 */
export type ImplementationOutputV1 = {
  readonly schema_version: "1";
  /** The discriminant of the `DurableArtifact` union (chunk 10). */
  readonly artifact_kind: "implementation-output";
  readonly task_id: TaskSlug;
  /** Chunk 10's rank 4b restricts this to `phase-impl-<n>`; the schema admits any instance. */
  readonly phase_instance: PhaseInstanceId;
  /** D19 — the step that produced this artifact; the other half of rank 8's correlation key. */
  readonly step: PipelineStep;
  /** Immutable: the tree the diff is taken against. */
  readonly base_commit: GitOid;
  readonly index_identity_digest: Sha256Digest;
  readonly worktree_identity_digest: Sha256Digest;
  /** SET — sorted by `path`, duplicates rejected, and non-empty. */
  readonly outputs: readonly OutputEntry[];
  /** SET — sorted by `document_path`, duplicates rejected. */
  readonly parent_documents: readonly ParentDocumentRef[];
  /** The exact review and commit-authorization subject. */
  readonly diff_digest: Sha256Digest;
  /** Domain-separated canonical declared-output snapshot; never the retained result address. */
  readonly snapshot_digest: Sha256Digest;
  /** SET — sorted, duplicates rejected. A subset of `outputs[].path`, checked by chunk 10. */
  readonly restore_targets: readonly RepositoryPathClaim[];
  readonly accounting: SnapshotAccountingV1;
  readonly secret_scan: SecretScanResult;
  readonly undeclared_changes: UndeclaredChangeReport;
  /** Binds this durable output to the exact verification bytes reviewed for it. */
  readonly verification_evidence: VerificationEvidence;
  /** SET — sorted by `input_id`, duplicates rejected. */
  readonly declared_inputs: readonly DeclaredInputRef[];
  readonly input_fingerprint: Sha256Digest;
  /** D14 — a structural hook only. Absence is omission, never `null`. */
  readonly constitution_edit_gate_id?: PathSafeId;
};

const sha256Digest = sha256DigestV1Schema as unknown as z.ZodType<Sha256Digest>;
const safeInteger = safeIntegerV1Schema as unknown as z.ZodType<SafeInteger>;

/** Exported for schema generation only: the `parentDocumentRef` `$def` is root-internal. */
export const parentDocumentRefV1Schema = z.object({
  document_path: taskPathClaimV1Schema,
  content_digest: sha256Digest,
  role: z.enum(["prd", "design", "phase-design", "impl-notes"]),
}).strict();

/**
 * `z.string()` with no lexical rule, mirroring the inline `{"type": "string"}` in the JSON Schema.
 * Applying claim rules here would make the report throw on exactly the names it exists to report.
 */
const rawGitPathMirror = z.string() as unknown as z.ZodType<RawGitPath>;

/** Exported for schema generation only: the `undeclaredChangeReport` `$def` is root-internal. */
export const undeclaredChangeReportV1Schema = z.object({
  scanned: z.boolean(),
  undeclared_paths: z.array(rawGitPathMirror)
    .refine((items) => isSortedUniqueBy(items), "undeclared_paths must be sorted with no duplicates"),
  unrepresentable_count: safeInteger,
}).strict();

/** Exported for schema generation only: the `verificationEvidence` `$def` is root-internal. */
export const verificationEvidenceV1Schema = z.object({
  transcript_digest: sha256Digest,
  byte_count: safeInteger,
}).strict() as unknown as z.ZodType<VerificationEvidence>;

/**
 * `.strict()` mirrors `additionalProperties: false`; absence is `.optional()` plus omission from
 * `required`, never `null`. Every set rule calls the same exported `isSortedUniqueBy` — with
 * `tupleKey(...)` for the keyed sets — so every shape enforces literally the same ordering
 * predicate.
 */
export const implementationOutputV1Schema = z.object({
  schema_version: z.literal("1"),
  artifact_kind: z.literal("implementation-output"),
  task_id: taskSlugV1Schema,
  phase_instance: phaseInstanceIdV1Schema,
  step: z.enum(PIPELINE_STEPS),
  base_commit: gitOidV1Schema,
  index_identity_digest: sha256Digest,
  worktree_identity_digest: sha256Digest,
  outputs: z.array(outputEntryV1Schema)
    .min(1)
    .refine((items) => isSortedUniqueBy(items, tupleKey("path")), "outputs must be sorted by path with no duplicates"),
  parent_documents: z.array(parentDocumentRefV1Schema)
    .refine((items) => isSortedUniqueBy(items, tupleKey("document_path")), "parent_documents must be sorted by document_path with no duplicates"),
  diff_digest: sha256Digest,
  snapshot_digest: sha256Digest,
  restore_targets: z.array(repositoryPathClaimV1Schema)
    .refine((items) => isSortedUniqueBy(items), "restore_targets must be sorted with no duplicates"),
  accounting: snapshotAccountingV1Schema,
  secret_scan: secretScanResultV1Schema,
  undeclared_changes: undeclaredChangeReportV1Schema,
  verification_evidence: verificationEvidenceV1Schema,
  declared_inputs: z.array(declaredInputRefV1Schema)
    .refine((items) => isSortedUniqueBy(items, tupleKey("input_id")), "declared_inputs must be sorted by input_id with no duplicates"),
  input_fingerprint: sha256Digest,
  constitution_edit_gate_id: pathSafeIdV1Schema.optional(),
}).strict() as unknown as z.ZodType<ImplementationOutputV1>;

/** Throws, per the contract-layer convention. */
export function parseImplementationOutput(value: unknown): ImplementationOutputV1 {
  assertPlainJson(value, "implementation output");
  return implementationOutputV1Schema.parse(value);
}

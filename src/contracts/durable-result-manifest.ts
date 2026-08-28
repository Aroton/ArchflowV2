import { z } from "zod";

import type { CanonicalDocument } from "./canonical.js";
import type { DocumentArtifactV1 } from "./durable-document.js";
import { documentArtifactV1Schema } from "./durable-document.js";
import type { ImplementationOutputV1 } from "./durable-implementation-output.js";
import { implementationOutputV1Schema } from "./durable-implementation-output.js";
import type { AdjudicationEvidence } from "./adjudication.js";
import { adjudicationEvidenceSchema } from "./adjudication.js";
import type { OutputEntry, ProjectionDigestRef, SnapshotAccountingV1 } from "./durable-primitives.js";
import { outputEntryV1Schema, projectionDigestRefV1Schema, snapshotAccountingV1Schema } from "./durable-primitives.js";
import type { SafeId, Sha256Digest, TaskSlug } from "./evidence.js";
import { safeIdV1Schema, sha256DigestV1Schema, taskSlugV1Schema } from "./evidence.js";
import type { PhaseInstanceId } from "./phase-instance.js";
import { phaseInstanceIdV1Schema } from "./phase-instance.js";
import { assertPlainJson } from "./plain-json.js";
import type { ReviewEvidence } from "./review.js";
import { reviewEvidenceSchema } from "./review.js";
import type { SecretScanResult } from "./secret-scan.js";
import { secretScanResultV1Schema } from "./secret-scan.js";
import type { TriageCandidate } from "./triage.js";
import { triageCandidateSchema } from "./triage.js";
import { isSortedUniqueBy, tupleKey } from "./validators.js";
import type { PipelineStep } from "./vocabulary.js";
import { PIPELINE_STEPS } from "./vocabulary.js";
import type { RepositoryName } from "./config.js";
import { durableRepositoryNameV1Schema } from "./durable-primitives.js";

/**
 * Immutable authority stored at `authority/results/<result-digest>.json`.
 *
 * This is a server-internal persisted root. `resultManifestV1Schema` below is the runtime shape
 * authority — `parseResultManifest` validates through it — and `result-manifest.schema.json` is
 * generated from it. The exact validated source artifact is embedded so every later read can
 * re-establish the artifact digest and all duplicated wrapper facts without request-lifetime memory.
 */
export type ResultManifestV1 = {
  readonly schema_version: "1";
  readonly task_id: TaskSlug;
  readonly repository_identity_digest: Sha256Digest;
  readonly result_id: SafeId;
  readonly phase_instance: PhaseInstanceId;
  readonly step: PipelineStep;
  readonly artifact_digest: Sha256Digest;
  readonly source_artifact: ResultSourceArtifactV1;
  readonly input_fingerprint: Sha256Digest;
  /** Domain-separated declared-output snapshot, not this manifest's content address. */
  readonly snapshot_digest: Sha256Digest;
  readonly outputs: readonly OutputEntry[];
  readonly projections: readonly ProjectionDigestRef[];
  readonly secondary_projections?: readonly SecondaryProjectionSetV1[];
  readonly accounting: SnapshotAccountingV1;
  readonly secret_scan: SecretScanResult;
};

export type SecondaryProjectionSetV1 = {
  readonly repository: RepositoryName;
  readonly repository_identity_digest: Sha256Digest;
  readonly projections: readonly ProjectionDigestRef[];
};

export type ReviewEvidenceArtifactV1 = {
  readonly schema_version: "1";
  readonly artifact_kind: "review-evidence";
  readonly evidence: ReviewEvidence;
};

export type TriageArtifactV1 = {
  readonly schema_version: "1";
  readonly artifact_kind: "triage";
  readonly evidence: TriageCandidate;
};

export type AdjudicationEvidenceArtifactV1 = {
  readonly schema_version: "1";
  readonly artifact_kind: "adjudication-evidence";
  readonly evidence: AdjudicationEvidence;
};

export type EvidenceArtifactV1 =
  | ReviewEvidenceArtifactV1
  | TriageArtifactV1
  | AdjudicationEvidenceArtifactV1;

export type ResultSourceArtifactV1 =
  | DocumentArtifactV1
  | ImplementationOutputV1
  | EvidenceArtifactV1;

export const reviewEvidenceArtifactV1Schema = z.object({
  schema_version: z.literal("1"),
  artifact_kind: z.literal("review-evidence"),
  evidence: reviewEvidenceSchema,
}).strict() as unknown as z.ZodType<ReviewEvidenceArtifactV1>;

export const triageArtifactV1Schema = z.object({
  schema_version: z.literal("1"),
  artifact_kind: z.literal("triage"),
  evidence: triageCandidateSchema,
}).strict() as unknown as z.ZodType<TriageArtifactV1>;

export const adjudicationEvidenceArtifactV1Schema = z.object({
  schema_version: z.literal("1"),
  artifact_kind: z.literal("adjudication-evidence"),
  evidence: adjudicationEvidenceSchema,
}).strict() as unknown as z.ZodType<AdjudicationEvidenceArtifactV1>;

/**
 * A plain union rather than a `discriminatedUnion` on `artifact_kind`, matching the schema's
 * `oneOf`. The five arms are still mutually exclusive — each pins a distinct `artifact_kind`
 * const — so `oneOf`'s exactly-one and the union's first-match admit the same values.
 */
export const resultSourceArtifactV1Schema = z.union([
  documentArtifactV1Schema,
  implementationOutputV1Schema,
  reviewEvidenceArtifactV1Schema,
  triageArtifactV1Schema,
  adjudicationEvidenceArtifactV1Schema,
]) as unknown as z.ZodType<ResultSourceArtifactV1>;

export const secondaryProjectionSetV1Schema = z.object({
  repository: durableRepositoryNameV1Schema,
  repository_identity_digest: sha256DigestV1Schema,
  projections: z.array(projectionDigestRefV1Schema)
    .refine((items) => isSortedUniqueBy(items, tupleKey("path")), "projections must be sorted by path with no duplicates"),
}).strict().superRefine((section, context) => {
  if (section.projections.some((projection) => projection.repository !== section.repository)) {
    context.addIssue({ code: "custom", path: ["projections"], message: "secondary projection repositories must match their wrapper" });
  }
}) as unknown as z.ZodType<SecondaryProjectionSetV1>;

/**
 * The authority. Both set-ordering sites call `isSortedUniqueBy` with `tupleKey("path")` — the
 * shared exported ordering predicates — so each ordering rule is literally one predicate across
 * every shape.
 */
/**
 * Shared by the strict parser and the structural one below, so the envelope can never drift between
 * them: they differ in exactly one property, `source_artifact`, and in nothing else.
 */
const resultManifestShape = {
  schema_version: z.literal("1"),
  task_id: taskSlugV1Schema,
  repository_identity_digest: sha256DigestV1Schema,
  result_id: safeIdV1Schema,
  phase_instance: phaseInstanceIdV1Schema,
  step: z.enum(PIPELINE_STEPS),
  artifact_digest: sha256DigestV1Schema,
  source_artifact: resultSourceArtifactV1Schema,
  input_fingerprint: sha256DigestV1Schema,
  snapshot_digest: sha256DigestV1Schema,
  outputs: z.array(outputEntryV1Schema)
    .refine((items) => isSortedUniqueBy(items, tupleKey("path")), "outputs must be sorted by path with no duplicates"),
  projections: z.array(projectionDigestRefV1Schema)
    .refine((items) => isSortedUniqueBy(items, tupleKey("path")), "projections must be sorted by path with no duplicates"),
  secondary_projections: z.array(secondaryProjectionSetV1Schema)
    .refine((items) => isSortedUniqueBy(items, tupleKey("repository")), "secondary_projections must be sorted by repository with no duplicates")
    .optional(),
  accounting: snapshotAccountingV1Schema,
  secret_scan: secretScanResultV1Schema,
} as const;

export const resultManifestV1Schema = z.object(resultManifestShape)
  .strict() as unknown as z.ZodType<ResultManifestV1>;

export function parseResultManifest(value: unknown): ResultManifestV1 {
  assertPlainJson(value, "result manifest");
  return resultManifestV1Schema.parse(value);
}

/**
 * The evidence arms as a graph-walking reader needs them: the correlation fields every consumer of a
 * manifest *envelope* reads, and nothing else about the body.
 *
 * `validateDurableSemantics` correlates an evidence result through exactly these four fields and the
 * canonical digest of the whole body, so they stay required and typed here. The rest of the body
 * passes through unread, because the readers below never look at it.
 */
const structuralEvidenceBodySchema = z.object({
  task_id: taskSlugV1Schema,
  phase_instance: phaseInstanceIdV1Schema,
  step: z.enum(PIPELINE_STEPS),
  input_fingerprint: sha256DigestV1Schema,
}).passthrough();

const structuralEvidenceArtifactSchema = z.object({
  schema_version: z.literal("1"),
  artifact_kind: z.enum(["review-evidence", "triage", "adjudication-evidence"]),
  evidence: structuralEvidenceBodySchema,
}).strict();

const resultManifestStructureSchema = z.object({
  ...resultManifestShape,
  source_artifact: z.union([
    documentArtifactV1Schema,
    implementationOutputV1Schema,
    structuralEvidenceArtifactSchema,
  ]),
}).strict() as unknown as z.ZodType<ResultManifestV1>;

/**
 * Parses a retained manifest for a reader that walks the retained-result graph rather than one that
 * interrogates an artifact body.
 *
 * Identical to {@link parseResultManifest} except in one place: a review, triage, or adjudication
 * *body* is validated only down to the correlation fields above. Everything the graph-walkers
 * actually read — outputs, projections, accounting, secondary projections, the artifact kind, and
 * the whole document and implementation-output arms — stays exactly as strict as before.
 *
 * This exists because the retained graph spans every result a task has ever produced, so a walker
 * meets manifests written by earlier server versions, while the *current* shape of an evidence body
 * is a moving target. Binding the walkers to it meant a field rename inside adjudication evidence
 * (`source_evidence_set_digest` to `source_review_envelope_digest`) stopped reconciliation discovery
 * and byte accounting from reading manifests whose bodies they never open — stranding tasks whose
 * only fault was being older than the rename.
 *
 * Nothing is trusted more as a result. Evidence bodies are re-parsed strictly at the point of use by
 * `validateLoadedEvidence`, which also re-derives the canonical digest and compares the exact bytes,
 * and every producer path validates a new manifest with the strict parser before it is ever written.
 */
export function parseResultManifestStructure(value: unknown): ResultManifestV1 {
  assertPlainJson(value, "result manifest");
  return resultManifestStructureSchema.parse(value);
}

/** Compile-time assertion that the whole persisted graph remains canonical-JSON-compatible. */
export type ResultManifestDocument = CanonicalDocument<ResultManifestV1>;

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

/**
 * Immutable authority stored at `results/sha256/<result-digest>/manifest.json`.
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
  readonly accounting: SnapshotAccountingV1;
  readonly secret_scan: SecretScanResult;
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

/**
 * The authority. Both set-ordering sites call `isSortedUniqueBy` with `tupleKey("path")` — the
 * shared exported ordering predicates — so each ordering rule is literally one predicate across
 * every shape.
 */
export const resultManifestV1Schema = z.object({
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
  accounting: snapshotAccountingV1Schema,
  secret_scan: secretScanResultV1Schema,
}).strict() as unknown as z.ZodType<ResultManifestV1>;

export function parseResultManifest(value: unknown): ResultManifestV1 {
  assertPlainJson(value, "result manifest");
  return resultManifestV1Schema.parse(value);
}

/** Compile-time assertion that the whole persisted graph remains canonical-JSON-compatible. */
export type ResultManifestDocument = CanonicalDocument<ResultManifestV1>;

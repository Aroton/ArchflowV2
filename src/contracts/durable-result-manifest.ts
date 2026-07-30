import type { CanonicalDocument } from "./canonical.js";
import type { ProjectionDigestRef } from "./durable-checkpoint.js";
import type { DocumentArtifactV1 } from "./durable-document.js";
import type { ImplementationOutputV1 } from "./durable-implementation-output.js";
import type { OutputEntry, SnapshotAccountingV1 } from "./durable-primitives.js";
import type { SafeId, Sha256Digest, TaskSlug } from "./evidence.js";
import type { PhaseInstanceId } from "./phase-instance.js";
import { assertPlainJson } from "./plain-json.js";
import type { SecretScanResult } from "./secret-scan.js";
import { resultManifestV1Validator } from "./validators.js";
import type { PipelineStep } from "./vocabulary.js";

/**
 * Immutable authority stored at `results/sha256/<result-digest>/manifest.json`.
 *
 * This is a server-internal persisted root with one normative JSON Schema and no Zod mirror. The
 * exact validated source artifact is embedded so every later read can re-establish the artifact
 * digest and all duplicated wrapper facts without request-lifetime memory.
 */
export type ResultManifestV1 = {
  readonly schema_version: "1";
  readonly task_id: TaskSlug;
  readonly repository_identity_digest: Sha256Digest;
  readonly result_id: SafeId;
  readonly phase_instance: PhaseInstanceId;
  readonly step: PipelineStep;
  readonly artifact_digest: Sha256Digest;
  readonly source_artifact: DocumentArtifactV1 | ImplementationOutputV1;
  readonly input_fingerprint: Sha256Digest;
  /** Domain-separated declared-output snapshot, not this manifest's content address. */
  readonly snapshot_digest: Sha256Digest;
  readonly outputs: readonly OutputEntry[];
  readonly projections: readonly ProjectionDigestRef[];
  readonly accounting: SnapshotAccountingV1;
  readonly secret_scan: SecretScanResult;
};

export function parseResultManifest(value: unknown): ResultManifestV1 {
  assertPlainJson(value, "result manifest");
  return resultManifestV1Validator.assert(value, "result manifest");
}

/** Compile-time assertion that the whole persisted graph remains canonical-JSON-compatible. */
export type ResultManifestDocument = CanonicalDocument<ResultManifestV1>;

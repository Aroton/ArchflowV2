import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

import { canonicalDocument, canonicalJsonDigest } from "../../src/contracts/canonical.js";
import type { ImplementationOutputV1 } from "../../src/contracts/durable-implementation-output.js";
import { parseResultManifest, type ResultManifestV1, type ReviewEvidenceArtifactV1 } from "../../src/contracts/durable-result-manifest.js";
import { validateDurableSemantics } from "../../src/contracts/durable.js";
import { parseSha256Digest } from "../../src/contracts/evidence.js";
import { createRetainedEvidenceReference, createTransactionAuthorityLink } from "../../src/contracts/internal/test-capabilities.js";
import { parseRepositoryPathClaim } from "../../src/contracts/path-claims.js";

const source = JSON.parse(readFileSync(new URL("../fixtures/contracts/durable/implementation-output.valid.json", import.meta.url), "utf8")) as ImplementationOutputV1;
const repositoryDigest = parseSha256Digest("f".repeat(64));
const firstOutput = source.outputs[0]!;
if (firstOutput.storage !== "raw-payload") throw new TypeError("fixture must begin with raw payload output");

const manifest = (): ResultManifestV1 => ({
  schema_version: "1",
  task_id: source.task_id,
  repository_identity_digest: repositoryDigest,
  result_id: "implementation-result-1" as ResultManifestV1["result_id"],
  phase_instance: source.phase_instance,
  step: source.step,
  artifact_digest: canonicalJsonDigest(source),
  source_artifact: structuredClone(source),
  input_fingerprint: source.input_fingerprint,
  snapshot_digest: source.snapshot_digest,
  outputs: structuredClone(source.outputs),
  projections: [
    { path: firstOutput.path, content_digest: firstOutput.payload_digest },
    { path: source.outputs[1]!.path, content_digest: parseSha256Digest("e".repeat(64)) },
  ],
  accounting: structuredClone(source.accounting),
  secret_scan: structuredClone(source.secret_scan),
});

const reviewSource = (): ReviewEvidenceArtifactV1 => ({
  schema_version: "1",
  artifact_kind: "review-evidence",
  evidence: {
    schema_version: "1",
    task_id: source.task_id,
    phase_instance: source.phase_instance,
    step: "self_review",
    role: "self-review",
    subject_digest: parseSha256Digest("1".repeat(64)),
    input_fingerprint: source.input_fingerprint,
    rubric_digest: parseSha256Digest("2".repeat(64)),
    producer_family: "claude",
    findings: [],
    matched_rule_versions: [],
    verdict: "pass",
    blocking_count: 0,
    assurance: "agent-declared",
    model_family: "claude",
    model: "claude",
    effort: "high",
  },
});

const reviewManifest = (): ResultManifestV1 => {
  const sourceArtifact = reviewSource();
  const path = `.archflow/tasks/${source.task_id}/reviews/${source.phase_instance}.self.md` as typeof firstOutput.path;
  const renderedDigest = parseSha256Digest("3".repeat(64));
  return {
    schema_version: "1",
    task_id: source.task_id,
    repository_identity_digest: repositoryDigest,
    result_id: "self-review-result-1" as ResultManifestV1["result_id"],
    phase_instance: source.phase_instance,
    step: "self_review",
    artifact_digest: canonicalJsonDigest(sourceArtifact.evidence),
    source_artifact: sourceArtifact,
    input_fingerprint: source.input_fingerprint,
    snapshot_digest: parseSha256Digest("4".repeat(64)),
    outputs: [{
      path,
      path_class: "review",
      operation: "add",
      storage: "raw-payload",
      payload_bytes: 100 as never,
      payload_digest: renderedDigest,
      file_type: "regular",
      after: { oid: "1234567890abcdef1234567890abcdef12345678" as never, mode: "100644", size_bytes: 100 as never },
    }],
    projections: [{ path, content_digest: renderedDigest }],
    accounting: {
      schema_version: "1",
      result_bytes: 100 as never,
      task_bytes: 100 as never,
      result_byte_cap: 26_214_400 as never,
      task_byte_cap: 262_144_000 as never,
      counted_entries: [{ path, storage: "raw-payload", stored_bytes: 100 as never }],
      measured_at_revision: 3 as never,
    },
    secret_scan: {
      schema_version: "1",
      outcome: "clean",
      detector_set_id: "archflow.default:v1" as never,
      scanned_paths: [path],
    },
  };
};

describe("ResultManifestV1", () => {
  it("parses through its sole JSON Schema and validates embedded-artifact correlations", () => {
    const parsed = parseResultManifest(manifest());
    expect(validateDurableSemantics({ result_manifest: canonicalDocument(parsed) })).toEqual({
      schema_version: "1",
      ok: true,
      value: undefined,
    });
  });

  it("rejects unknown structure and reports a changed embedded artifact digest", () => {
    expect(() => parseResultManifest({ ...manifest(), extra: true })).toThrow();
    const changed = { ...manifest(), artifact_digest: parseSha256Digest("d".repeat(64)) };
    const result = validateDurableSemantics({ result_manifest: canonicalDocument(changed) });
    expect(result).toMatchObject({ ok: false, error: { code: "SNAPSHOT_INVALID", diagnostic: { parameters: { issue_code: "result-manifest-artifact-digest-mismatch" } } } });
  });

  it("retains evidence by canonical payload identity and its exact review projection", () => {
    const value = reviewManifest();
    expect(parseResultManifest(value)).toEqual(value);
    expect(validateDurableSemantics({ result_manifest: canonicalDocument(value) })).toMatchObject({ ok: true });
    expect(value.artifact_digest).toBe(canonicalJsonDigest((value.source_artifact as ReviewEvidenceArtifactV1).evidence));
    expect(value.artifact_digest).not.toBe(canonicalJsonDigest(value.source_artifact));

    for (const changed of [
      { ...value, artifact_digest: canonicalJsonDigest(value.source_artifact) },
      { ...value, outputs: [{ ...value.outputs[0]!, path_class: "document" }] },
      { ...value, projections: [{ ...value.projections[0]!, content_digest: parseSha256Digest("5".repeat(64)) }] },
    ] as const) {
      expect(validateDurableSemantics({ result_manifest: canonicalDocument(changed) }).ok).toBe(false);
    }
  });

  it("derives retained evidence identity and rejects invented result or transaction facts", () => {
    const manifestDocument = canonicalDocument(reviewManifest());
    const reference = {
      phase_instance: manifestDocument.value.phase_instance,
      step: manifestDocument.value.step,
      result_digest: manifestDocument.digest,
      result_id: manifestDocument.value.result_id,
      input_fingerprint: manifestDocument.value.input_fingerprint,
      manifest_path: parseRepositoryPathClaim(
        `.archflow/tasks/${manifestDocument.value.task_id}/results/sha256/${manifestDocument.digest}/manifest.json`,
      ),
    };
    const retained = createRetainedEvidenceReference<"review", "agent-declared">(manifestDocument, reference);
    expect(retained.verified.evidence_digest).toBe(manifestDocument.value.artifact_digest);
    expect(() => createRetainedEvidenceReference(manifestDocument, {
      ...reference,
      result_digest: parseSha256Digest("9".repeat(64)),
    })).toThrow(/does not match/u);
    expect(() => createTransactionAuthorityLink(retained, {
      state: canonicalDocument({}),
      outcome: { revision: 1 },
      replayed: false,
    } as never)).toThrow(/not minted by the state transaction kernel/u);
  });
});

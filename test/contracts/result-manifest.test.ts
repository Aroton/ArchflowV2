import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

import { canonicalDocument, canonicalJsonDigest } from "../../src/contracts/canonical.js";
import type { ImplementationOutputV1 } from "../../src/contracts/durable-implementation-output.js";
import { parseResultManifest, type ResultManifestV1 } from "../../src/contracts/durable-result-manifest.js";
import { validateDurableSemantics } from "../../src/contracts/durable.js";
import { parseSha256Digest } from "../../src/contracts/evidence.js";

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
});

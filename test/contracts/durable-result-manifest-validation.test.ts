import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

import { resultManifestV1Schema } from "../../src/contracts/durable-result-manifest.js";
import { createJsonSchemaValidator, type JsonSchemaValidator } from "../helpers/json-schema.js";

/**
 * `result-manifest` validation under the Zod authority. `resultManifestV1Schema` is the runtime
 * authority behind `parseResultManifest`, and `result-manifest.schema.json` is generated from it,
 * with `check:schemas` fencing the committed bytes. The compiled schema appears only as a
 * third-party consumer: it must accept every `source_artifact` arm, and it deliberately accepts
 * the set-ordering violations below because generation retired the ordering keywords — those
 * rejections belong to the Zod authority alone.
 *
 * Cross-field digest and source-artifact correlations are `validateDurableSemantics` territory
 * (`result-manifest.test.ts`), so the digests here only need to be structurally valid.
 */

type JsonObject = Record<string, unknown>;

const SCHEMA_DIR = new URL("../../src/contracts/schemas/v1/", import.meta.url);
const FIXTURE_DIR = new URL("../fixtures/contracts/", import.meta.url);

const clone = <T>(value: T): T => structuredClone(value);

const schema = (stem: string): JsonObject =>
  JSON.parse(readFileSync(new URL(`${stem}.schema.json`, SCHEMA_DIR), "utf8")) as JsonObject;

const fixture = (name: string): JsonObject =>
  JSON.parse(readFileSync(new URL(name, FIXTURE_DIR), "utf8")) as JsonObject;

const digest = (character: string): string => character.repeat(64);

const resultManifestValidator: JsonSchemaValidator<unknown> = createJsonSchemaValidator<unknown>(
  schema("result-manifest"),
  [
    "primitives",
    "path-claim",
    "durable-primitives",
    "secret-scan-result",
    "document-artifact",
    "implementation-output",
    "review",
    "review-evidence",
    "triage",
    "adjudication",
    "adjudication-evidence",
  ].map(schema)
);

const implementationSource = fixture("durable/implementation-output.valid.json");
const documentSource = fixture("durable/document-artifact.valid.json");

/** The raw adjudication fixture plus the provenance fields the evidence union's agent arm adds. */
const adjudicationEvidence = {
  ...fixture("adjudication/valid.json"),
  model_family: "claude",
  model: "claude-test",
  effort: "high",
  assurance: "agent-declared",
};

const reviewEvidenceArtifact = (): JsonObject => ({
  schema_version: "1",
  artifact_kind: "review-evidence",
  evidence: {
    schema_version: "1",
    task_id: "demo",
    phase_instance: "phase-impl-1",
    step: "counter_review",
    role: "counter-review",
    subject_digest: digest("1"),
    input_fingerprint: digest("2"),
    rubric_digest: digest("3"),
    producer_family: "claude",
    findings: [],
    matched_rule_versions: [],
    verdict: "pass",
    blocking_count: 0,
    assurance: "server-attested",
    adapter: "codex-cli",
    cli_version: "1.0.0",
    model_family: "codex",
    model: "gpt-test",
    effort: "high",
    invocation_id: "invocation-1",
    envelope_input_digest: digest("4"),
    observed_output_digest: digest("5"),
    result_id: "result-1",
  },
});

const triageArtifact = (): JsonObject => ({
  schema_version: "1",
  artifact_kind: "triage",
  evidence: {
    schema_version: "1",
    task_id: "demo",
    phase_instance: "phase-impl-1",
    step: "triage",
    subject_digest: digest("1"),
    input_fingerprint: digest("2"),
    current_evidence_set_digest: digest("3"),
    source_evidence_digests: [digest("4")],
    dispositions: [],
    accepted_count: 0,
    rejected_count: 0,
    accepted_editorial_count: 0,
  },
});

const adjudicationArtifact = (): JsonObject => ({
  schema_version: "1",
  artifact_kind: "adjudication-evidence",
  evidence: clone(adjudicationEvidence),
});

/**
 * A structurally valid manifest around the implementation-output fixture; overrides swap in the
 * other `source_artifact` arms. `outputs` inherits the fixture's path order, and `projections`
 * derives its paths from `outputs`, so both sets are sorted by construction.
 */
const manifest = (overrides: JsonObject = {}): JsonObject => ({
  schema_version: "1",
  task_id: implementationSource.task_id,
  repository_identity_digest: digest("f"),
  result_id: "implementation-result-1",
  phase_instance: implementationSource.phase_instance,
  step: implementationSource.step,
  artifact_digest: digest("a"),
  source_artifact: clone(implementationSource),
  input_fingerprint: digest("b"),
  snapshot_digest: digest("c"),
  outputs: clone(implementationSource.outputs),
  projections: (implementationSource.outputs as readonly JsonObject[]).map((output, index) => ({
    path: output.path,
    content_digest: digest(String(index)),
  })),
  accounting: clone(implementationSource.accounting),
  secret_scan: clone(implementationSource.secret_scan),
  ...overrides,
});

/** One sample per `source_artifact` arm, in the schema's `oneOf` order. */
const SAMPLES: ReadonlyArray<readonly [string, JsonObject]> = [
  ["document-artifact", manifest({ source_artifact: clone(documentSource), step: documentSource.step })],
  ["implementation-output", manifest()],
  ["review-evidence", manifest({ source_artifact: reviewEvidenceArtifact(), step: "counter_review", result_id: "counter-review-result-1" })],
  ["triage", manifest({ source_artifact: triageArtifact(), step: "triage", result_id: "triage-result-1" })],
  ["adjudication-evidence", manifest({ source_artifact: adjudicationArtifact(), step: "adjudicate", result_id: "adjudication-result-1" })],
];

const accepts = (value: unknown, label: string): void => {
  const result = resultManifestV1Schema.safeParse(value);
  expect(result.success, `${label}: Zod rejected`).toBe(true);
  if (result.success) expect(result.data, `${label}: Zod transformed the value`).toEqual(value);
};

const rejects = (value: unknown, label: string): void => {
  expect(resultManifestV1Schema.safeParse(value).success, `${label}: Zod accepted`).toBe(false);
};

describe("result-manifest validation under the Zod authority", () => {
  it("covers exactly the five source_artifact arms", () => {
    expect(SAMPLES.map(([name]) => name)).toEqual([
      "document-artifact",
      "implementation-output",
      "review-evidence",
      "triage",
      "adjudication-evidence",
    ]);
  });

  for (const [name, sample] of SAMPLES) {
    it(`accepts a ${name}-sourced manifest, and the published schema accepts it too`, () => {
      accepts(sample, name);
      expect(resultManifestValidator.validate(sample), name).toBe(true);
    });

    it(`rejects a ${name}-sourced manifest carrying an unknown property`, () => {
      rejects({ ...clone(sample), archflow_unknown_property: "x" }, name);
    });
  }

  it("rejects an unknown property inside an evidence wrapper", () => {
    const artifact = { ...reviewEvidenceArtifact(), archflow_unknown_property: "x" };
    rejects(manifest({ source_artifact: artifact, step: "counter_review" }), "wrapper-unknown-property");
  });
});

/**
 * Generation retired the set-ordering keywords from the committed schema, so the compiled document
 * accepts these; the Zod authority behind `parseResultManifest` must keep rejecting them.
 */
describe("both set-ordering sites reject in the Zod authority", () => {
  const rejectedByZodAuthority = (mutated: JsonObject, label: string): void => {
    expect(resultManifestValidator.validate(mutated), `${label}: generated schema kept a retired keyword`).toBe(true);
    rejects(mutated, label);
  };

  it("rejects outputs out of path order", () => {
    const sample = manifest();
    rejectedByZodAuthority({ ...sample, outputs: [...(sample.outputs as readonly JsonObject[])].reverse() }, "outputs-unsorted");
  });

  it("rejects a duplicated outputs path", () => {
    const first = (manifest().outputs as readonly JsonObject[])[0]!;
    rejectedByZodAuthority(manifest({ outputs: [clone(first), clone(first)] }), "outputs-duplicate");
  });

  it("rejects projections out of path order", () => {
    const sample = manifest();
    rejectedByZodAuthority({ ...sample, projections: [...(sample.projections as readonly JsonObject[])].reverse() }, "projections-unsorted");
  });

  it("rejects a duplicated projections path", () => {
    const first = (manifest().projections as readonly JsonObject[])[0]!;
    rejectedByZodAuthority(manifest({ projections: [clone(first), clone(first)] }), "projections-duplicate");
  });
});

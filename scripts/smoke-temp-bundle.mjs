import assert from "node:assert/strict";

const contracts = await import(new URL("../.tmp/archflow-contracts.mjs", import.meta.url));

assert.deepEqual(
  contracts.parseSingleYamlDocument("name: archflow\nenabled: true\n", "bundle-smoke.yaml"),
  { name: "archflow", enabled: true }
);

const validator = contracts.createJsonSchemaValidator({
  $schema: "https://json-schema.org/draft/2020-12/schema",
  type: "object",
  additionalProperties: false,
  required: ["id", "uri"],
  properties: {
    id: { type: "integer", minimum: 1 },
    uri: { type: "string", format: "uri" }
  }
});
assert.deepEqual(validator.assert({ id: 1, uri: "https://example.test/contract" }, "bundle-smoke"), {
  id: 1,
  uri: "https://example.test/contract"
});
assert.throws(() => validator.assert({ id: 0, uri: "not a URI" }, "bundle-smoke"));
assert.equal(contracts.parsePositiveSafePhaseNumber(1), 1);

const digest = "a".repeat(64);
const review = contracts.parseAndDeriveReview({
  schema_version: "1",
  task_id: "bundle-smoke",
  phase_instance: "phase-impl-2",
  step: "counter_review",
  role: "counter-review",
  subject_digest: digest,
  input_fingerprint: "b".repeat(64),
  rubric_digest: "c".repeat(64),
  producer_family: "claude",
  findings: [],
  matched_rule_versions: [],
  verdict: "pass",
  blocking_count: 0
});
assert.equal(review.verdict, "pass");
assert.deepEqual(
  contracts.parseAndDeriveAdjudication({
    schema_version: "1",
    task_id: "bundle-smoke",
    phase_instance: "phase-impl-2",
    step: "adjudicate",
    subject_digest: digest,
    input_fingerprint: "b".repeat(64),
    pinned_constitution_digest: "d".repeat(64),
    approved_upstream_digests: [],
    source_evidence_set_digest: "e".repeat(64),
    rule_findings: [],
    drift_findings: [],
    constitution: "pass",
    drift: "aligned",
    matched_rule_versions: [],
    uncertain_rule_versions: []
  }).constitution,
  "pass"
);
const forgedReview = {
  evidence_digest: "f".repeat(64),
  evidence: {
    ...review,
    assurance: "degraded",
    model_family: "codex",
    model: "bundle-smoke",
    effort: "unknown",
    reason: "temporary bundle smoke"
  },
  authority: {}
};
assert.throws(() => contracts.renderReviewEvidence(forgedReview), /qualified review evidence/u);
assert.throws(() => contracts.renderAdjudicationEvidence({ evidence_digest: digest, evidence: {}, authority: {} }), /qualified adjudication evidence/u);
assert.throws(() => contracts.renderTriage({ schema_version: "1" }), /validated triage/u);

assert.equal(Object.keys(contracts.PROJECT_ERROR_DEFINITIONS).length, 52);
assert.equal(Object.keys(contracts.PROTOCOL_ERROR_DEFINITIONS).length, 4);
assert.equal(
  contracts.createProjectError("STATE_CONFLICT", { expected_revision: 1, observed_revision: 2 }).next_action,
  "reread-and-retry-intent"
);
assert.equal(
  contracts.createProtocolError("TOOL_NOT_FOUND", { tool_name_digest: digest }).owner,
  "protocol"
);

assert.deepEqual(Object.keys(contracts.TOOL_DEFINITIONS), [
  "archflow_state",
  "archflow_counter_review",
  "archflow_adjudicate",
  "archflow_gate",
  "archflow_waiver"
]);
for (const [name, definition] of Object.entries(contracts.TOOL_DEFINITIONS)) {
  assert.equal(definition.name, name);
  assert.equal(
    definition.input_schema_id,
    `https://archflow.dev/schemas/v1/mcp-tools#/$defs/${name}/input`
  );
  assert.equal(
    definition.result_schema_id,
    `https://archflow.dev/schemas/v1/mcp-tools#/$defs/${name}/result`
  );
}
assert.equal("resultExpectationBrand" in contracts, false);
assert.equal("connectionContextFactory" in contracts, false);
assert.equal("createTestResultExpectation" in contracts, false);
assert.equal("createTestObservationCapability" in contracts, false);
assert.equal("createTestAuthorityLink" in contracts, false);
assert.equal("createTestVerifiedReferencedEvidence" in contracts, false);
assert.equal("createTestCurrentReviewSetAuthority" in contracts, false);

console.log(`Temporary contract bundle loaded and exercised under ${process.version}.`);

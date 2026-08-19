import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { pathToFileURL } from "node:url";

export async function smokeTemporaryBundles({ contractsBundle, runtimeBundle }) {
const contracts = await import(pathToFileURL(contractsBundle));

assert.deepEqual(
  contracts.parseSingleYamlDocument("name: archflow\nenabled: true\n", "bundle-smoke.yaml"),
  { name: "archflow", enabled: true }
);

// Ajv left the runtime dependency closure; the bundle must not carry its compiler.
assert.equal("createJsonSchemaValidator" in contracts, false);
assert.equal("assertZodAgreement" in contracts, false);
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
    drift_findings: []
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
assert.throws(() => contracts.renderReviewEvidence(forgedReview), /authenticated review evidence/u);
assert.throws(() => contracts.renderAdjudicationEvidence({ evidence_digest: digest, evidence: {}, authority: {} }), /authenticated adjudication evidence/u);
assert.throws(() => contracts.renderTriage({ schema_version: "1" }), /validated triage/u);

assert.equal(Object.keys(contracts.PROJECT_ERROR_DEFINITIONS).length, 53);
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
assert.equal(typeof contracts.parseIntentReceipt, "function");
assert.equal(typeof contracts.intentReceiptDigest, "function");
assert.equal(typeof contracts.intentOutcomeDigest, "function");
for (const internalStateCapability of [
  "AtomicReplaceError",
  "createAtomicWriter",
  "TaskLockError",
  "createTaskLock",
  "createInternalTransactionAuthority",
  "createInternalInputFingerprintResolver",
  "runStateTransaction"
]) {
  assert.equal(internalStateCapability in contracts, false);
}

const runtime = spawnSync(process.execPath, [runtimeBundle], {
  encoding: "utf8",
  input: "",
  timeout: 10_000
});
assert.equal(runtime.error, undefined, "inert runtime must terminate after stdin EOF");
assert.equal(runtime.status, 0, `inert runtime exited unsuccessfully: ${runtime.stderr}`);
assert.equal(runtime.stdout, "", "runtime stdout must contain protocol frames only");
assert.equal(runtime.stderr, "", "clean inert EOF must not emit diagnostics");
}

import { describe, expect, it } from "vitest";

import { createJsonSchemaValidator } from "../../src/contracts/validators.js";
import gateContractSchema from "../../src/contracts/schemas/v1/gate-contract.schema.json" with { type: "json" };
import gateDecisionSchema from "../../src/contracts/schemas/v1/gate-decision.schema.json" with { type: "json" };
import projectErrorSchema from "../../src/contracts/schemas/v1/project-error.schema.json" with { type: "json" };
import protocolErrorSchema from "../../src/contracts/schemas/v1/protocol-error.schema.json" with { type: "json" };
import primitivesSchema from "../../src/contracts/schemas/v1/primitives.schema.json" with { type: "json" };
import pathClaimSchema from "../../src/contracts/schemas/v1/path-claim.schema.json" with { type: "json" };
import supplementalSchema from "../../src/contracts/schemas/v1/supplemental-review.schema.json" with { type: "json" };
import { createProjectError, createProtocolError, parseProjectError } from "../../src/contracts/errors.js";
import { parseGateContract } from "../../src/contracts/gates.js";
import { parseSupplementalReviewOutcome } from "../../src/contracts/supplemental.js";

const D = "a".repeat(64);
const gateValidator = createJsonSchemaValidator(gateContractSchema, [primitivesSchema, pathClaimSchema]);
const decisionValidator = createJsonSchemaValidator(gateDecisionSchema, [primitivesSchema, pathClaimSchema, gateContractSchema]);
const projectValidator = createJsonSchemaValidator(projectErrorSchema);
const protocolValidator = createJsonSchemaValidator(protocolErrorSchema);
const supplementalValidator = createJsonSchemaValidator(supplementalSchema, [primitivesSchema]);

describe("gate and error JSON Schema authority", () => {
  it("accepts a correlated gate contract and rejects cross-kind/unknown fields", () => {
    const value = { kind: "commit-authorization", context: { target_ref: "refs-heads-task", diff_digest: D, current_artifact_digests: [D], parent_document_digests: [D] }, payload: { decision: "authorize-commit", reason: "Approved" } };
    expect(gateValidator.validate(value)).toBe(true);
    expect(gateValidator.validate({ ...value, payload: { decision: "waiver-requested", reason: "No", rule: { rule_id: "rule", rule_version: 1 }, rationale: "No" } })).toBe(false);
    expect(gateValidator.validate({ ...value, context: { ...value.context, gate_id: "forged" } })).toBe(false);
  });

  it("enforces semantic gate correlations in the Zod authority", () => {
    // Generation retired `x-archflow-gate-semantics`, so the compiled document accepts these;
    // `parseGateContract` — running the same context schemas — is the surviving authority.
    const invalid = [
      { kind: "attempts-exhausted", context: { step: "produce", attempts: 1, maximum_attempts: 2 }, payload: { decision: "abort", reason: "Stop" } },
      { kind: "review-trigger", context: { matched_rules: [{ rule_id: "z", rule_version: 1 }, { rule_id: "a", rule_version: 1 }], uncertain_rules: [], eligible_waiver_rules: [], waiver_scope: { operation: "review-trigger", boundary: "subject" } }, payload: { decision: "approve", reason: "No" } },
      { kind: "adjudication-failure", context: { constitution: "fail", failed_rules: [{ rule_id: "rule", rule_version: 1 }], uncertain_rules: [], eligible_waiver_rules: [], waiver_scope: { operation: "adjudication-failure", boundary: "phase" } }, payload: { decision: "approve", reason: "Handled", resolutions: [] } }
    ];
    for (const value of invalid) { expect(gateValidator.validate(value)).toBe(true); expect(() => parseGateContract(value)).toThrow(); }
  });

  it("enforces supplemental gate and subject correlations in the Zod authority", () => {
    const review = { prior_gate_id: "gate-1", task_id: "task-1", phase_instance: "phase-impl-2", subject_digest: D, input_fingerprint: D, evidence_slot: { role: "gate-counter-review", evidence_digest: "b".repeat(64), assurance: "degraded", producer_family: "claude", reviewer_family: "codex", independence: "opposite-family", gate_id: "gate-1" } };
    const valid = { action: "supersede", review, accepted_triage_digest: D, old_subject_digest: D, new_subject_digest: "c".repeat(64), reason: "Revise" };
    expect(supplementalValidator.validate(valid)).toBe(true);
    expect(parseSupplementalReviewOutcome(valid).action).toBe("supersede");
    // Generation retired `x-archflow-supplemental-semantics`, so the compiled document accepts
    // these correlation violations; `parseSupplementalReviewOutcome` is the surviving authority.
    for (const value of [{ ...valid, review: { ...review, evidence_slot: { ...review.evidence_slot, gate_id: "gate-2" } } }, { ...valid, new_subject_digest: D }, { ...valid, old_subject_digest: "d".repeat(64) }]) {
      expect(supplementalValidator.validate(value)).toBe(true);
      expect(() => parseSupplementalReviewOutcome(value)).toThrow();
    }
  });

  it("accepts a closed kind-correlated decision envelope", () => {
    const envelope = { schema_version: "1", gate_id: "gate-1", task_id: "task-1", phase_instance: "phase-impl-2", subject_digest: D, context_digest: D, human_provenance: { schema_version: "1", actor_class: "human", assurance: "declared-local-trace", channel: "archflow-local", decision_event_id: "decision-1", helper_invocation_id: "helper-1", recorded_at: "2026-07-27T12:00:00.000Z" }, kind: "artifact-approval", payload: { decision: "approve", reason: "Approved" } };
    expect(decisionValidator.validate(envelope)).toBe(true);
    expect(decisionValidator.validate({ ...envelope, payload: { decision: "authorize-commit", reason: "No" } })).toBe(false);
  });

  it("agrees with both exhaustive serialized error registries", () => {
    const project = createProjectError("STATE_CONFLICT", { expected_revision: 1, observed_revision: 2 });
    const protocol = createProtocolError("TOOL_NOT_FOUND", { tool_name_digest: D });
    expect(projectValidator.validate(project)).toBe(true);
    expect(protocolValidator.validate(protocol)).toBe(true);
    expect(projectValidator.validate({ ...project, owner: "protocol" })).toBe(false);
    expect(protocolValidator.validate({ ...protocol, diagnostic: { ...protocol.diagnostic, parameters: { tool_name_digest: D, raw_name: "secret" } } })).toBe(false);
  });

  it("makes ENVELOPE_OVERFLOW paths lexical, sorted, and unique in both authorities", () => {
    const error = (offending_paths: string[]) => ({ schema_version: "1", code: "ENVELOPE_OVERFLOW", owner: "contracts", retryable: false, diagnostic: { template_id: "ENVELOPE_OVERFLOW", parameters: { offending_paths, current_bytes: 2_000_000, byte_cap: 1_048_576 } }, next_action: "reduce-review-subject" });
    expect(projectValidator.validate(error(["dist/archflow-mcp.mjs", "package-lock.json"]))).toBe(true);
    expect(parseProjectError(error(["dist/archflow-mcp.mjs"])).code).toBe("ENVELOPE_OVERFLOW");
    for (const paths of [["z/file", "a/file"], ["a/file", "a/file"], ["../escape"], []]) {
      const value = error(paths);
      expect(projectValidator.validate(value), JSON.stringify(projectValidator.validate.errors)).toBe(false);
      expect(() => parseProjectError(value)).toThrow();
    }
  });

  it("makes SNAPSHOT_LIMIT paths lexical, sorted, and unique in both authorities", () => {
    const error = (offending_paths: string[]) => ({ schema_version: "1", code: "SNAPSHOT_LIMIT", owner: "snapshot", retryable: false, diagnostic: { template_id: "SNAPSHOT_LIMIT", parameters: { limit_scope: "task", offending_paths, current_bytes: 2, byte_cap: 1 } }, next_action: "reduce-snapshot" });
    expect(projectValidator.validate(error(["a/file", "z/file"]))).toBe(true);
    for (const paths of [["z/file", "a/file"], ["a/file", "a/file"], ["../escape"], ["a/../escape"], ["a/\u0080bad"]]) {
      const value = error(paths);
      expect(projectValidator.validate(value), JSON.stringify(projectValidator.validate.errors)).toBe(false);
      expect(() => parseProjectError(value)).toThrow();
    }
  });
});

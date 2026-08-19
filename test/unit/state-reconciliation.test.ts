import { describe, expect, it } from "vitest";

import { canonicalDocument, canonicalJsonDigest } from "../../src/contracts/canonical.js";
import { intentOutcomeDigest, parseIntentReceipt, type IntentReceiptV1 } from "../../src/contracts/durable-intent.js";
import type { TaskStateV1 } from "../../src/contracts/durable-state.js";
import { parsePathSafeId, parseSafeCode, parseSafeId, parseSafeInteger, parseSha256Digest, parseTaskSlug } from "../../src/contracts/evidence.js";
import { encodePhaseInstance, parsePositiveSafePhaseNumber } from "../../src/contracts/phase-instance.js";
import { parseRepositoryPathClaim } from "../../src/contracts/path-claims.js";
import { reconcileCurrentAuthority } from "../../src/state/reconciliation.js";

const D = (value: string) => parseSha256Digest(value.repeat(64));
const PHASE = encodePhaseInstance({ kind: "phase-impl", phase: parsePositiveSafePhaseNumber(10) });
const STATE: TaskStateV1 = {
  schema_version: "1", task_id: parseTaskSlug("task-1"), repository_identity_digest: D("1"),
  revision: parseSafeInteger(4), phase_instance: PHASE, step: "produce", status: "running",
  attempt: parseSafeInteger(1), input_fingerprint: D("2"), initialization_digest: D("3"),
  config_digest: D("4"), workflow_digest: D("5"), constitution_digest: D("6"),
  policy_base_commit: "abcdef0123456789abcdef0123456789abcdef01" as TaskStateV1["policy_base_commit"],
  authoritative_results: [], approvals: [], waivers: [],
};

describe("reconcileCurrentAuthority", () => {
  it("classifies only supplied matching projections as consistent", () => {
    const projection = { path: parseRepositoryPathClaim("src/a.ts"), content_digest: D("a") };
    expect(reconcileCurrentAuthority({
      state: canonicalDocument(STATE), recorded_projections: [projection], current_projections: [projection], active_heads: {},
    })).toEqual({ classification: "consistent", findings: [] });
  });

  it("reports supplied projection drift without discovering retained history", () => {
    const path = parseRepositoryPathClaim("src/a.ts");
    const result = reconcileCurrentAuthority({
      state: canonicalDocument(STATE),
      recorded_projections: [{ path, content_digest: D("a") }],
      current_projections: [{ path, content_digest: D("b") }],
      active_heads: {},
    });
    expect(result.classification).toBe("reconciliation-required");
    expect(result.findings).toEqual([expect.objectContaining({ kind: "projection-mismatch", recorded_digest: D("a"), observed_digest: D("b") })]);
  });

  it("marks a missing projection unrestorable only when discovery named it and no bytes remain", () => {
    const retained = parseRepositoryPathClaim("src/retained.ts");
    const adopted = parseRepositoryPathClaim("src/adopted.ts");
    const result = reconcileCurrentAuthority({
      state: canonicalDocument(STATE),
      recorded_projections: [
        { path: retained, content_digest: D("a") },
        { path: adopted, content_digest: D("b") },
      ],
      current_projections: [],
      active_heads: {},
      unrestorable_paths: [adopted],
    });
    expect(result.findings).toEqual([
      expect.objectContaining({ kind: "projection-mismatch", path: retained }),
      expect.objectContaining({ kind: "projection-mismatch", path: adopted, restore_unavailable: true }),
    ]);
    const digestDrift = reconcileCurrentAuthority({
      state: canonicalDocument(STATE),
      recorded_projections: [{ path: adopted, content_digest: D("b") }],
      current_projections: [{ path: adopted, content_digest: D("c") }],
      active_heads: {},
      unrestorable_paths: [adopted],
    });
    expect(digestDrift.findings).toEqual([expect.objectContaining({ kind: "projection-mismatch" })]);
    expect(digestDrift.findings[0]).not.toHaveProperty("restore_unavailable");
  });

  it("compares an active gate head", () => {
    const gate = { gate_id: parsePathSafeId("gate-1"), gate_kind: "commit-authorization" as const, subject_digest: D("a"), context_digest: D("b"), frozen_state_digest: D("f"), opened_at_revision: parseSafeInteger(4) };
    const state = { ...STATE, open_gate: gate };
    const result = reconcileCurrentAuthority({
      state: canonicalDocument(state), recorded_projections: [], current_projections: [],
      active_heads: { gate: { gate_id: gate.gate_id, subject_digest: gate.subject_digest, context_digest: gate.context_digest } },
    });
    expect(result).toEqual({ classification: "consistent", findings: [] });
  });

  it("never returns resume-exact-intent for forged or malformed receipt evidence", () => {
    const outcome = { path: "state.json", revision: 5, status: "succeeded" };
    const prepared = { ...STATE, revision: parseSafeInteger(5), status: "succeeded" as const };
    const valid = canonicalDocument(parseIntentReceipt({
      schema_version: "1", intent_id: parsePathSafeId("intent-1"), task_id: STATE.task_id,
      repository_identity_digest: STATE.repository_identity_digest, tool: "archflow_state",
      operation: parseSafeCode("record-state-boundary"), request_digest: D("7"), input_fingerprint: STATE.input_fingerprint,
      prior_revision: STATE.revision, resulting_revision: prepared.revision, result_id: parseSafeId("state-5"),
      outcome_digest: intentOutcomeDigest(outcome), outcome,
      prepared_state_digest: canonicalJsonDigest(prepared), prepared_state: prepared,
    }));
    const forged = { ...valid, digest: D("f") };
    const malformed = canonicalDocument({ schema_version: "1" } as unknown as IntentReceiptV1);
    for (const receipt of [forged, malformed]) {
      const result = reconcileCurrentAuthority({
        state: canonicalDocument(STATE), recorded_projections: [], current_projections: [], active_heads: {},
        intent: { request_digest: D("7"), receipt },
      });
      expect(result.findings).toContainEqual(expect.objectContaining({ kind: "receipt-invalid" }));
      expect(result.findings.some((finding) => finding.kind === "receipt-only")).toBe(false);
    }
    const validResult = reconcileCurrentAuthority({
      state: canonicalDocument(STATE), recorded_projections: [], current_projections: [], active_heads: {},
      intent: { request_digest: D("7"), receipt: valid },
    });
    expect(validResult.findings).toContainEqual(expect.objectContaining({ kind: "receipt-only", next_action: "resume-exact-intent" }));

    const committedState: TaskStateV1 = {
      ...prepared,
      last_transition: {
        schema_version: "1",
        tool: valid.value.tool,
        operation: valid.value.operation,
        intent_id: valid.value.intent_id,
        request_digest: valid.value.request_digest,
        input_fingerprint: valid.value.input_fingerprint,
        result_id: valid.value.result_id,
        outcome: valid.value.outcome,
        outcome_digest: valid.value.outcome_digest,
        prior_revision: valid.value.prior_revision,
        resulting_revision: valid.value.resulting_revision,
      },
    };
    const committedResult = reconcileCurrentAuthority({
      state: canonicalDocument(committedState), recorded_projections: [], current_projections: [], active_heads: {},
      intent: { request_digest: D("7"), receipt: valid },
    });
    expect(committedResult).toEqual({ classification: "consistent", findings: [] });
  });
});

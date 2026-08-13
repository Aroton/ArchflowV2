import { describe, expect, it } from "vitest";

import { canonicalDocument } from "../../src/contracts/canonical.js";
import { parseActiveGate, parseGateDecisionRecord, parseGateRequest } from "../../src/contracts/durable-gate.js";
import { DURABLE_ISSUE_CODES, validateDurableSemantics } from "../../src/contracts/durable.js";
import { computeGateContextDigest, computeGateId } from "../../src/contracts/fingerprints.js";
import { parseSha256Digest } from "../../src/contracts/evidence.js";

const d = (character: string) => parseSha256Digest(character.repeat(64));
const provenance = { schema_version: "1", actor_class: "human", assurance: "declared-local-trace", channel: "archflow-local", decision_event_id: "decision-1", helper_invocation_id: "helper-1", recorded_at: "2026-07-30T12:00:00.000Z" } as const;
const counter = { role: "counter-review", evidence_digest: d("2"), assurance: "server-attested", producer_family: "claude", reviewer_family: "codex", independence: "opposite-family" } as const;
const context = { artifact_kind: "phase-implementation" } as const;
const gateId = computeGateId({ task_identity_digest: d("a"), intent_id: "intent-1" as never, request_digest: d("b") });
const contextDigest = computeGateContextDigest("artifact-approval", context);
const request = () => parseGateRequest({ schema_version: "1", gate_id: gateId, intent_id: "intent-1", request_digest: d("b"), task_id: "task-1", phase_instance: "phase-impl-2", summary: "Approve implementation", subject_digest: d("c"), context_digest: contextDigest, current_evidence: { set_digest: d("3"), slots: [counter] }, kind: "artifact-approval", context, allowed_decisions: ["approve", "revise", "reject", "cancel"], opened_at_revision: 4 });
const decision = () => parseGateDecisionRecord({ schema_version: "1", gate_id: gateId, task_id: "task-1", phase_instance: "phase-impl-2", kind: "artifact-approval", subject_digest: d("c"), context_digest: contextDigest, outcome: "decided", envelope: { schema_version: "1", gate_id: gateId, task_id: "task-1", phase_instance: "phase-impl-2", kind: "artifact-approval", subject_digest: d("c"), context_digest: contextDigest, human_provenance: provenance, payload: { decision: "approve", reason: "Approved" } } });

describe("durable gate roots", () => {
  it("parses all roots and correlates the archived request with its decision", () => {
    const archived = request();
    const closure = decision();
    expect(validateDurableSemantics({ gate_request: canonicalDocument(archived), gate_decision: canonicalDocument(closure) })).toMatchObject({ ok: true });
    expect(parseActiveGate({ ...archived, status: "awaiting-human", decision_template: { schema_version: "1", gate_id: gateId, task_id: "task-1", phase_instance: "phase-impl-2", kind: "artifact-approval", subject_digest: d("c"), context_digest: contextDigest, required_fields: ["payload", "human_provenance"], cancellation_fields: ["cancelled", "reason", "human_provenance"] } }).status).toBe("awaiting-human");
  });

  it("rejects a decision correlated to another subject", () => {
    const closure = { ...decision(), subject_digest: d("d") };
    expect(validateDurableSemantics({ gate_request: canonicalDocument(request()), gate_decision: canonicalDocument(closure) })).toMatchObject({ ok: false, error: { diagnostic: { parameters: { issue_code: DURABLE_ISSUE_CODES.gateDecisionSubjectMismatch } } } });
  });

  it("rejects a kind-inappropriate allowed-decision vocabulary", () => {
    expect(() => parseGateRequest({ ...request(), allowed_decisions: ["authorize-commit", "cancel"] })).toThrow();
  });
});

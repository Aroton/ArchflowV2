import { describe, expect, it } from "vitest";
import { createHash } from "node:crypto";

import { parseSha256Digest, parseTaskSlug, parseSafeInteger } from "../../src/contracts/evidence.js";
import { encodePhaseInstance } from "../../src/contracts/phase-instance.js";
import type { TaskStateV1 } from "../../src/contracts/durable-state.js";
import type { NextActionInput } from "../../src/state/next-action.js";
import { deriveNextAction } from "../../src/state/next-action.js";

const digest = (content: string) => parseSha256Digest(createHash("sha256").update(content).digest("hex"));
const TASK = parseTaskSlug("status-round-task");
const phase = encodePhaseInstance({ kind: "design" });
const subjectDigest = digest("a");
const inputFingerprint = digest("b");

function makeState(): TaskStateV1 {
  return {
    schema_version: "1",
    task_id: TASK,
    repository_identity_digest: digest("r"),
    revision: parseSafeInteger(1),
    phase_instance: phase,
    step: "triage",
    status: "succeeded",
    attempt: parseSafeInteger(1),
    input_fingerprint: inputFingerprint,
    initialization_digest: digest("i"),
    config_digest: digest("k"),
    workflow_digest: digest("w"),
    constitution_digest: digest("c"),
    policy_base_commit: "0".repeat(40) as never,
    authoritative_results: [{
      phase_instance: phase,
      step: "produce",
      result_digest: digest("prod"),
      result_id: "prod-res" as never,
      input_fingerprint: inputFingerprint,
    }],
    approvals: [],
    waivers: [],
  };
}

function makeInput(overrides: Partial<NextActionInput> = {}): NextActionInput {
  const state = makeState();
  return {
    repository_initialized: true,
    config_verified: true,
    state,
    subject_digest: subjectDigest,
    assessment: {
      next: "advance",
      current: ["counter_review", "triage", "adjudicate"],
      stale: [],
      editorial_revision_required: false,
      reentry_required: false,
      exhausted: false,
      every_finding_dispositioned: true,
      blocker_remains: false,
      adjudication_gate_pending: false,
    },
    current_evidence_set_digest: digest("1"),
    ...overrides,
  };
}

describe("status round digest and approval scoping", () => {
  it("does not satisfy gate when approval is from a different evidence round digest", () => {
    const round1EvidenceSet = digest("1");
    const round2EvidenceSet = digest("2");

    const input = makeInput({
      current_evidence_set_digest: round2EvidenceSet,
      authenticated_approvals: [{
        gate_kind: "design-approval",
        subject_digest: subjectDigest,
        current_evidence_set_digest: round1EvidenceSet, // from round 1!
      }],
    });

    const action = deriveNextAction(input);
    expect(action.code).toBe("open-gate");
    if (action.code === "open-gate") {
      expect(action.gate_kind).toBe("design-approval");
    }
  });

  it("satisfies gate when approval matches the current round evidence set digest", () => {
    const round2EvidenceSet = digest("2");

    const input = makeInput({
      current_evidence_set_digest: round2EvidenceSet,
      authenticated_approvals: [{
        gate_kind: "design-approval",
        subject_digest: subjectDigest,
        current_evidence_set_digest: round2EvidenceSet, // exact match!
      }],
      commit_observed: true,
    });

    const action = deriveNextAction(input);
    expect(action.code).not.toBe("open-gate");
  });

  it("permits un-scoped legacy approval when current_evidence_set_digest is undefined", () => {
    const round2EvidenceSet = digest("2");

    const input = makeInput({
      current_evidence_set_digest: round2EvidenceSet,
      authenticated_approvals: [{
        gate_kind: "design-approval",
        subject_digest: subjectDigest,
      }],
      commit_observed: true,
    });

    const action = deriveNextAction(input);
    expect(action.code).not.toBe("open-gate");
  });

  it("forces ordinary gate open when escalated_human_findings is true", () => {
    const currentEvidenceSet = digest("1");

    const input = makeInput({
      current_evidence_set_digest: currentEvidenceSet,
      escalated_human_findings: true,
      authenticated_approvals: [],
    });

    const action = deriveNextAction(input);
    expect(action.code).toBe("open-gate");
    if (action.code === "open-gate") {
      expect(action.gate_kind).toBe("design-approval");
      expect(action.detail).toMatch(/human escalation requires an explicit decision/u);
    }
  });
});

import { describe, expect, it } from "vitest";

import type { TaskStateV1 } from "../../src/contracts/durable-state.js";
import { parsePathSafeId, parseSafeId, parseSafeInteger, parseSha256Digest, parseTaskSlug } from "../../src/contracts/evidence.js";
import { encodePhaseInstance, parsePositiveSafePhaseNumber } from "../../src/contracts/phase-instance.js";
import { parseRepositoryPathClaim } from "../../src/contracts/path-claims.js";
import type { EvidenceAssessment } from "../../src/review/fixed-point.js";
import { deriveNextAction, type NextActionInput } from "../../src/state/next-action.js";
import type { ReconciliationFinding } from "../../src/state/reconciliation.js";

const D = (value: string) => parseSha256Digest(value.repeat(64));
const implementation = (phase: number) => encodePhaseInstance({
  kind: "phase-impl",
  phase: parsePositiveSafePhaseNumber(phase),
});
const phaseDesign = (phase: number) => encodePhaseInstance({
  kind: "phase-design",
  phase: parsePositiveSafePhaseNumber(phase),
});
const produced = (phaseInstance: TaskStateV1["phase_instance"]): TaskStateV1["authoritative_results"][number] => ({
  phase_instance: phaseInstance,
  step: "produce",
  result_digest: D("7"),
  result_id: parseSafeId("result-1"),
  input_fingerprint: D("2"),
  manifest_path: parseRepositoryPathClaim(`.archflow/tasks/task-1/results/sha256/${"7".repeat(64)}/manifest.json`),
});

function state(overrides: Partial<TaskStateV1> = {}): TaskStateV1 {
  const value: TaskStateV1 = {
    schema_version: "1",
    task_id: parseTaskSlug("task-1"),
    repository_identity_digest: D("1"),
    revision: parseSafeInteger(4),
    phase_instance: implementation(1),
    step: "adjudicate",
    status: "succeeded",
    attempt: parseSafeInteger(1),
    input_fingerprint: D("2"),
    initialization_digest: D("3"),
    config_digest: D("4"),
    workflow_digest: D("5"),
    constitution_digest: D("6"),
    policy_base_commit: "abcdef0123456789abcdef0123456789abcdef01" as TaskStateV1["policy_base_commit"],
    authoritative_results: [],
    approvals: [],
    waivers: [],
    ...overrides,
  };
  return overrides.authoritative_results === undefined
    ? { ...value, authoritative_results: [produced(value.phase_instance)] }
    : value;
}

function assessment(next: EvidenceAssessment["next"]): EvidenceAssessment {
  return {
    current: [], stale: [], every_finding_dispositioned: true, blocker_remains: false,
    reentry_required: false, exhausted: false, adjudication_gate_pending: false, next,
  };
}

function input(overrides: Partial<NextActionInput> = {}): NextActionInput {
  return {
    repository_initialized: true,
    state: state(),
    config_verified: true,
    reconciliation_findings: [],
    assessment: assessment("self_review"),
    evidence_available: true,
    subject_digest: D("a"),
    ...overrides,
  };
}

const reconciliationCases: readonly [ReconciliationFinding, string][] = [
  [{ kind: "receipt-only", request_digest: D("a"), receipt_digest: D("b"), next_action: "resume-exact-intent" }, "resume-exact-intent"],
  [{ kind: "projection-mismatch", path: "design.md" as never, recorded_digest: D("a"), next_action: "restore-or-record-new-transition" }, "restore-or-record-new-transition"],
  [{ kind: "receipt-invalid", receipt_digest: D("a"), next_action: "inspect-retained-receipt" }, "inspect-retained-receipt"],
  [{ kind: "intent-mismatch", requested_digest: D("a"), receipt_request_digest: D("b"), next_action: "create-fresh-intent" }, "create-fresh-intent"],
  [{ kind: "active-gate-mismatch", next_action: "resolve-current-authority" }, "resolve-current-authority"],
];

describe("deriveNextAction", () => {
  it("covers every closed next-action code", () => {
    const gate = {
      gate_id: parsePathSafeId("gate-1"), gate_kind: "artifact-approval" as const,
      subject_digest: D("a"), context_digest: D("b"), frozen_state_digest: D("c"),
      opened_at_revision: parseSafeInteger(4),
    };
    const cases: readonly (readonly [string, NextActionInput])[] = [
      ["initialize-repository", { repository_initialized: false }],
      ["create-task", { repository_initialized: true }],
      ...reconciliationCases.map(([finding, code]) => [code, input({ reconciliation_findings: [finding] })] as const),
      ["restore-pinned-config", input({ config_verified: false })],
      ["resolve-open-gate", input({ state: state({ open_gate: gate }) })],
      ["triage-supplemental-review", input({ state: state({ open_gate: gate }), untriaged_supplemental_review: true })],
      ["import-manual-checkpoints", input({ checkpoint_head_revision: 5 })],
      ["run-step", input({ assessment: assessment("triage") })],
      ["open-gate", input({ assessment: assessment("advance") })],
      ["commit-phase", input({ assessment: assessment("advance"), authenticated_approvals: [{ gate_kind: "commit-authorization", subject_digest: D("a") }] })],
      ["advance-phase", input({ assessment: assessment("advance"), authenticated_approvals: [{ gate_kind: "commit-authorization", subject_digest: D("a") }], commit_observed: true })],
      ["complete-task", input({ state: state({ planned_final_phase: parseSafeInteger(1) }), assessment: assessment("advance"), authenticated_approvals: [{ gate_kind: "commit-authorization", subject_digest: D("a") }], commit_observed: true })],
      ["task-complete", input({ state: state({ terminal: "complete" }) })],
      ["inspect-state", {
        repository_initialized: true, state: state(), config_verified: true,
        reconciliation_findings: [], evidence_available: false,
      }],
    ];
    expect(cases.map(([expected, value]) => [expected, deriveNextAction(value).code]))
      .toEqual(cases.map(([expected]) => [expected, expected]));
  });

  it("applies the pinned precedence ladder when conditions conflict", () => {
    const openGate = {
      gate_id: parsePathSafeId("gate-1"), gate_kind: "artifact-approval" as const,
      subject_digest: D("a"), context_digest: D("b"), frozen_state_digest: D("c"),
      opened_at_revision: parseSafeInteger(4),
    };
    expect(deriveNextAction(input({ config_verified: false, state: state({ open_gate: openGate }) })).code)
      .toBe("restore-pinned-config");
    expect(deriveNextAction(input({ reconciliation_findings: [reconciliationCases[0]![0]], assessment: assessment("advance") })).code)
      .toBe("resume-exact-intent");
    expect(deriveNextAction(input({ state: state({ terminal: "complete", open_gate: openGate }) })).code)
      .toBe("task-complete");
    expect(deriveNextAction(input({ checkpoint_head_revision: 5, assessment: assessment("advance") })).code)
      .toBe("import-manual-checkpoints");
  });

  it("directs intentional pinned-config changes to a new task or explicit upgrade", () => {
    const next = deriveNextAction(input({ config_verified: false }));
    expect(next).toMatchObject({ code: "restore-pinned-config", human_required: true });
    expect(next.detail).toContain("new task or the explicit upgrade flow");
  });

  it("does not guess between ambiguous retained successor receipts", () => {
    expect(deriveNextAction(input({
      reconciliation_blocking_reasons: ["retained-receipt-ambiguity"],
    })).code).toBe("inspect-retained-receipt");
    expect(deriveNextAction(input({
      reconciliation_blocking_reasons: ["active-gate-request-missing"],
    })).code).toBe("inspect-state");
  });

  it("names the actual remaining produce work from the durable step status", () => {
    // A newly initialized or advanced phase sits at produce-running: the entry write is already
    // recorded, so the remaining work is the terminal result — never a repeat running entry.
    expect(deriveNextAction(input({
      state: state({ step: "produce", status: "running", authoritative_results: [] }),
      evidence_available: false,
    }))).toMatchObject({
      code: "run-step", step: "produce", human_required: false,
      detail: "Record the terminal produce result.",
    });
    expect(deriveNextAction(input({
      state: state({ step: "produce", status: "failed", authoritative_results: [] }),
      evidence_available: false,
    }))).toMatchObject({
      code: "run-step", step: "produce",
      detail: "Retry the produce pipeline step.",
    });
    expect(deriveNextAction(input({
      state: state({ step: "adjudicate", status: "succeeded", authoritative_results: [] }),
      evidence_available: false,
    }))).toMatchObject({
      code: "run-step", step: "produce",
      detail: "Run the produce pipeline step.",
    });
  });

  it("advances a recorded self-review to the counter-review entry instead of repeating it", () => {
    // The fixed point says next: "self_review" until both reviews retain; once the self-review
    // is recorded, the only legal movement from self_review-succeeded is the counter_review
    // entry, and the derived action must say so.
    expect(deriveNextAction(input({
      state: state({ step: "self_review", status: "succeeded" }),
      assessment: assessment("self_review"),
      evidence_available: false,
    }))).toMatchObject({
      code: "run-step", step: "counter_review",
      detail: "Run the counter_review pipeline step.",
    });
    expect(deriveNextAction(input({
      state: state({ step: "produce", status: "succeeded" }),
      assessment: assessment("self_review"),
      evidence_available: false,
    }))).toMatchObject({ code: "run-step", step: "self_review" });
  });

  it("requires the phase-specific approval before advancing", () => {
    for (const phaseInstance of [
      encodePhaseInstance({ kind: "prd" }),
      encodePhaseInstance({ kind: "design" }),
      phaseDesign(2),
      implementation(2),
    ]) {
      const action = deriveNextAction(input({ state: state({ phase_instance: phaseInstance }), assessment: assessment("advance") }));
      expect(action).toMatchObject({
        code: "open-gate",
        gate_kind: phaseInstance === "prd" || phaseInstance === "design" || phaseInstance === phaseDesign(2)
          ? "artifact-approval"
          : "commit-authorization",
      });
    }

    expect(deriveNextAction(input({
      state: state({ phase_instance: phaseDesign(2) }),
      assessment: assessment("advance"),
      authenticated_approvals: [{ gate_kind: "artifact-approval", subject_digest: D("a") }],
    }))).toMatchObject({ code: "advance-phase", human_required: false });
  });

  it("requires an observed authorized commit before advancing or completing", () => {
    const approved = [{ gate_kind: "commit-authorization" as const, subject_digest: D("a") }];
    expect(deriveNextAction(input({
      state: state({ phase_instance: implementation(2), planned_final_phase: parseSafeInteger(2) }),
      assessment: assessment("advance"), authenticated_approvals: approved,
    }))).toMatchObject({ code: "commit-phase", human_required: true });
    expect(deriveNextAction(input({
      state: state({ phase_instance: implementation(2), planned_final_phase: parseSafeInteger(2) }),
      assessment: assessment("advance"), authenticated_approvals: approved, commit_observed: true,
    }))).toMatchObject({
      code: "complete-task",
      detail: "Record that the final planned implementation phase is committed.",
    });
    expect(deriveNextAction(input({
      state: state({ phase_instance: implementation(1), planned_final_phase: parseSafeInteger(2) }),
      assessment: assessment("advance"), authenticated_approvals: approved, commit_observed: true,
    })).code).toBe("advance-phase");
    expect(deriveNextAction(input({
      state: state({ phase_instance: implementation(2) }), assessment: assessment("advance"), authenticated_approvals: approved, commit_observed: true,
    })).code).toBe("advance-phase");
    expect(deriveNextAction(input({
      state: state({ phase_instance: implementation(2), planned_final_phase: parseSafeInteger(2) }),
      assessment: assessment("advance"), authenticated_approvals: [{ gate_kind: "commit-authorization", subject_digest: D("b") }],
    }))).toMatchObject({ code: "open-gate", gate_kind: "commit-authorization" });
    expect(deriveNextAction(input({ state: state({ terminal: "complete" }) })).detail)
      .toBe("The final planned implementation phase is committed.");
  });
});

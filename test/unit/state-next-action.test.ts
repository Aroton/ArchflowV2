import { describe, expect, it } from "vitest";

import type { TaskStateV1 } from "../../src/contracts/durable-state.js";
import { parsePathSafeId, parseSafeId, parseSafeInteger, parseSha256Digest, parseTaskSlug } from "../../src/contracts/evidence.js";
import { encodePhaseInstance, parsePositiveSafePhaseNumber } from "../../src/contracts/phase-instance.js";
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
    reentry_required: false, editorial_revision_required: false, exhausted: false,
    adjudication_gate_pending: false, next,
  };
}

function input(overrides: Partial<NextActionInput> = {}): NextActionInput {
  return {
    repository_initialized: true,
    state: state(),
    config_verified: true,
    reconciliation_findings: [],
    assessment: assessment("counter_review"),
    evidence_available: true,
    subject_digest: D("a"),
    ...overrides,
  };
}

const designCommit = Object.freeze({
  path: ".archflow/tasks/task-1",
  message: "ArchFlow: Approve task-1 design",
  target_ref: "refs/heads/main",
  baseline_commit: "abcdef0123456789abcdef0123456789abcdef01",
});

const implementationCommit = Object.freeze({
  paths: Object.freeze(["src/feature.ts"]),
  message: "ArchFlow: Implement task-1 phase 1",
  target_ref: "refs/heads/main",
  baseline_commit: "abcdef0123456789abcdef0123456789abcdef01",
});

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
      ["run-step", input({ assessment: assessment("triage") })],
      ["open-gate", input({ assessment: assessment("advance") })],
      ["commit-artifacts", input({
        state: state({ phase_instance: encodePhaseInstance({ kind: "design" }) }),
        assessment: assessment("advance"),
        authenticated_approvals: [{ gate_kind: "design-approval", subject_digest: D("a") }],
        design_commit: designCommit,
      })],
      ["commit-phase", input({ assessment: assessment("advance"), authenticated_approvals: [{ gate_kind: "commit-authorization", subject_digest: D("a") }], implementation_commit: implementationCommit })],
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

  it("stops offering the design milestone commit once it can no longer succeed", () => {
    const commitInput = {
      state: state({ phase_instance: encodePhaseInstance({ kind: "design" }) }),
      assessment: assessment("advance"),
      authenticated_approvals: [{ gate_kind: "design-approval" as const, subject_digest: D("a") }],
      design_commit: designCommit,
    };
    expect(deriveNextAction(input(commitInput)).code).toBe("commit-artifacts");
    // The commit action requires the target to still be the approved baseline, so once the
    // milestone exists but cannot be recognized, re-offering it would loop forever.
    const blocked = deriveNextAction(input({
      ...commitInput,
      commit_blocked_reason: "unauthorized-task-document",
    }));
    expect(blocked).toMatchObject({ code: "inspect-state", human_required: true });
    expect(blocked.detail).toMatch(/running it again cannot resolve this/u);
  });

  it("routes an editorial revision to the produce step with revision-intent wording", () => {
    const editorial = deriveNextAction(input({
      assessment: { ...assessment("produce"), editorial_revision_required: true },
    }));
    expect(editorial).toMatchObject({
      code: "run-step",
      step: "produce",
      editorial_revision: true,
      human_required: false,
    });
    expect(editorial.detail).toMatch(/editorial revision intents/u);
    expect(editorial.detail).toMatch(/nothing is re-run/u);
    // A full re-entry keeps the ordinary produce wording and no editorial flag.
    const reentry = deriveNextAction(input({
      assessment: { ...assessment("produce"), reentry_required: true },
    }));
    expect(reentry).toMatchObject({ code: "run-step", step: "produce" });
    expect(reentry.editorial_revision).toBeUndefined();
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

  it("always prescribes finishing produce while a produce re-entry is mid-flight", () => {
    // After a produce re-entry running entry is recorded (accepted, editorial, or the
    // author-initiated door), the prior cycle's retained produce result and evidence still
    // exist. Neither stale-evidence routing nor unavailable evidence may re-route the action:
    // the only legal move is recording the terminal produce result (or retrying a failure).
    for (const evidence of [
      { evidence_available: false as const },
      { assessment: assessment("triage"), evidence_available: true as const },
    ]) {
      expect(deriveNextAction(input({
        state: state({ step: "produce", status: "running" }),
        ...evidence,
      }))).toMatchObject({
        code: "run-step", step: "produce", human_required: false,
        detail: "Record the terminal produce result.",
      });
      expect(deriveNextAction(input({
        state: state({ step: "produce", status: "failed" }),
        ...evidence,
      }))).toMatchObject({
        code: "run-step", step: "produce",
        detail: "Retry the produce pipeline step.",
      });
    }
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
        gate_kind: phaseInstance === "prd"
          ? "artifact-approval"
          : phaseInstance === "design" || phaseInstance === phaseDesign(2)
            ? "design-approval"
            : "commit-authorization",
      });
    }

    // A gate already recorded under the former document-only contract may finish without
    // manufacturing a second approval or retroactively authorizing a commit.
    expect(deriveNextAction(input({
      state: state({ phase_instance: phaseDesign(2) }),
      assessment: assessment("advance"),
      authenticated_approvals: [{ gate_kind: "artifact-approval", subject_digest: D("a") }],
    }))).toMatchObject({
      code: "advance-phase",
      human_required: false,
      phase_instance: phaseDesign(2),
      target_phase_instance: implementation(2),
      skill: "archflow-phase-impl",
      skill_args: ["2"],
    });
  });

  it("routes every phase handoff to the destination skill and arguments", () => {
    const artifactApproved = [{ gate_kind: "artifact-approval" as const, subject_digest: D("a") }];
    const designApproved = [{ gate_kind: "design-approval" as const, subject_digest: D("a") }];
    const committed = [{ gate_kind: "commit-authorization" as const, subject_digest: D("a") }];
    const cases = [
      ["prd", "design", "archflow-design", []],
      ["design", phaseDesign(1), "archflow-phase-design", ["1"]],
      [phaseDesign(3), implementation(3), "archflow-phase-impl", ["3"]],
      [implementation(3), phaseDesign(4), "archflow-phase-design", ["4"]],
    ] as const;
    for (const [current, target, skill, skillArgs] of cases) {
      const isImpl = String(current).startsWith("phase-impl-");
      const isPrd = current === "prd";
      expect(deriveNextAction(input({
        state: state({ phase_instance: current as TaskStateV1["phase_instance"] }),
        assessment: assessment("advance"),
        authenticated_approvals: isImpl ? committed : isPrd ? artifactApproved : designApproved,
        ...(!isPrd ? { commit_observed: true } : {}),
      }))).toMatchObject({
        code: "advance-phase",
        phase_instance: current,
        target_phase_instance: target,
        skill,
        skill_args: skillArgs,
      });
    }
  });

  it("keeps material drift as a distinct redirect decision after combined design approval", () => {
    expect(deriveNextAction(input({
      state: state({ phase_instance: encodePhaseInstance({ kind: "design" }) }),
      assessment: assessment("adjudication-gate"),
      authenticated_approvals: [{ gate_kind: "design-approval", subject_digest: D("a") }],
      adjudication_gate_kind: "material-drift",
      pending_adjudication_gate_kinds: ["material-drift"],
    }))).toMatchObject({
      code: "open-gate",
      gate_kind: "material-drift",
      human_required: true,
    });
  });

  it("fails closed when a non-final maximum phase has no representable successor", () => {
    const maximum = implementation(Number.MAX_SAFE_INTEGER);
    expect(deriveNextAction(input({
      state: state({ phase_instance: maximum }),
      assessment: assessment("advance"),
      authenticated_approvals: [{ gate_kind: "commit-authorization", subject_digest: D("a") }],
      commit_observed: true,
    }))).toMatchObject({ code: "inspect-state", human_required: true, phase_instance: maximum });
  });

  it("requires an observed authorized commit before advancing or completing", () => {
    const approved = [{ gate_kind: "commit-authorization" as const, subject_digest: D("a") }];
    expect(deriveNextAction(input({
      state: state({ phase_instance: implementation(2), planned_final_phase: parseSafeInteger(2) }),
      assessment: assessment("advance"), authenticated_approvals: approved,
      implementation_commit: { ...implementationCommit, message: "ArchFlow: Implement task-1 phase 2" },
    }))).toMatchObject({
      code: "commit-phase",
      human_required: false,
      commit_paths: ["src/feature.ts"],
      commit_message: "ArchFlow: Implement task-1 phase 2",
      commit_target_ref: "refs/heads/main",
      commit_baseline: "abcdef0123456789abcdef0123456789abcdef01",
    });
    expect(deriveNextAction(input({
      state: state({ phase_instance: implementation(2), planned_final_phase: parseSafeInteger(2) }),
      assessment: assessment("advance"), authenticated_approvals: approved, commit_observed: true,
    }))).toMatchObject({
      code: "complete-task",
      detail: "Record that the final planned implementation phase is committed.",
      target_phase_instance: implementation(2),
      skill: "archflow-phase-impl",
      skill_args: ["2"],
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

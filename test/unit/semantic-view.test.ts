import { describe, expect, it } from "vitest";

import type { TaskStateV1 } from "../../src/contracts/durable-state.js";
import { parseSha256Digest, parseTaskSlug } from "../../src/contracts/evidence.js";
import { encodePhaseInstance, parsePositiveSafePhaseNumber } from "../../src/contracts/phase-instance.js";
import type { PlainJsonValue } from "../../src/contracts/plain-json.js";
import type {
  PublicFindingV1,
  SemanticActionOfferV1,
  SemanticStatusSnapshotV1,
  WorkflowInvocationV1,
  WorkflowReopenImpactV1,
} from "../../src/contracts/semantic-workflow.js";
import type { NextAction, NextActionCode } from "../../src/state/next-action.js";
import { computeSemanticStatusSnapshot } from "../../src/state/semantic-status.js";
import { projectSemanticStatus, semanticOfferToken } from "../../src/state/semantic-view.js";
import type { TaskStatusV1 } from "../../src/state/status.js";

const taskId = parseTaskSlug("semantic-test");
const digestA = parseSha256Digest("a".repeat(64));
const digestB = parseSha256Digest("b".repeat(64));
const phase = encodePhaseInstance({ kind: "phase-impl", phase: parsePositiveSafePhaseNumber(1) });
const invocation: WorkflowInvocationV1 = { skill: "archflow-phase-impl", phase: 1, intent: "resume" };

function action(code: NextActionCode, extra: Partial<NextAction> = {}): NextAction {
  return Object.freeze({ code, detail: `detail for ${code}`, human_required: false, phase_instance: phase, ...extra });
}

function fullStatus(nextAction: NextAction, extra: Partial<TaskStatusV1> = {}): TaskStatusV1 {
  return {
    task_id: taskId,
    state: "active",
    revision: 7,
    phase_instance: phase,
    step: "produce",
    status: "pending",
    attempt: 2,
    input_fingerprint: digestA,
    blocking_reasons: [],
    resources: [
      { role: "current-artifact", path: ".archflow/tasks/semantic-test/phases/1/impl-notes.md", access: "write", digest: digestB },
      { role: "phase-design", path: ".archflow/tasks/semantic-test/phases/1/design.md", access: "read-write", digest: digestA },
    ],
    review_policy: {
      rubric_id: "implementation-v1",
      rubric_digest: digestB,
      rubric: {
        schema_version: "1", kind: "implementation", mode: "adversarial",
        criteria: [{ id: "correctness", text: "Find material defects.", blocking: true }],
      },
    },
    constitution: {
      digest: digestA,
      active_rules: [{ id: "trust", version: 1, text: "Require explicit approval." }],
    },
    config: { verified: true },
    next_action: nextAction,
    ...extra,
  } as TaskStatusV1;
}

function snapshot(status: TaskStatusV1, extra: Partial<SemanticStatusSnapshotV1> = {}): SemanticStatusSnapshotV1 {
  return {
    schema_version: "1",
    repository_identity_digest: digestA,
    status: structuredClone(status) as unknown as PlainJsonValue,
    full_findings: [],
    reopen_impacts: [],
    ...extra,
  };
}

describe("semantic status projection", () => {
  it("suppresses writable resources at a close-only revision checkpoint", () => {
    const status = fullStatus(action("run-step", { step: "produce" }), { step: "triage", status: "succeeded" });
    const projected = projectSemanticStatus(snapshot(status, {
      revision_checkpoint: { status: "valid", choice: "revise-current" },
    }), invocation);
    expect(projected.view.next_action.kind).toBe("revise");
    expect(projected.view.resources).toEqual([]);
  });

  it("maps every current NextActionCode without exposing a protocol action", () => {
    const codes = [
      "initialize-repository", "create-task", "resume-exact-intent",
      "inspect-retained-receipt", "create-fresh-intent", "resolve-current-authority",
      "open-gate", "resolve-open-gate", "run-step", "commit-artifacts", "commit-phase", "advance-phase",
      "complete-task", "task-complete", "inspect-state",
    ] as const satisfies readonly NextActionCode[];

    for (const code of codes) {
      const extras: Partial<NextAction> = code === "run-step"
        ? { step: "produce" }
        : code === "commit-artifacts"
          ? { commit_path: ".archflow/tasks/semantic-test/design.md", commit_message: "Approve design", commit_target_ref: "refs/heads/main", commit_baseline: "1".repeat(40) }
          : code === "advance-phase"
            ? { skill: "archflow-phase-design", skill_args: ["2"] }
            : {};
      const statusExtras: Partial<TaskStatusV1> = code === "resolve-open-gate"
        ? ({ open_gate: { presentation: { title: "Choose", summary: "Summary", question: "Continue?", options: [{ token: "approve", label: "Approve", consequence: "Continue." }] } } } as unknown as Partial<TaskStatusV1>)
        : {};
      const result = projectSemanticStatus(snapshot(fullStatus(action(code, extras), statusExtras)), invocation);
      expect(result.view.next_action.kind).toBeTruthy();
      expect(JSON.stringify(result.view)).not.toContain("request_digest");
    }
  });

  it("projects a config change notice without changing the action kind", () => {
    const entries = [
      { path: "roles.counter-reviewer.effort", before: "xhigh", after: "high" },
      { path: "max_attempts", after: 4 },
    ] as const;
    const status = fullStatus(action("run-step", { step: "produce" }), {
      config_change: entries,
    } as Partial<TaskStatusV1>);
    const projected = projectSemanticStatus(snapshot(status), invocation);
    // Informational only: the entries ride along verbatim and the prose gains one line, but
    // the condition and the action are exactly what an unedited config would produce.
    expect(projected.view.next_action.kind).toBe("begin-work");
    expect(projected.view.config_change).toEqual([...entries]);
    expect(projected.view.detail).toContain("2 fields");
  });

  it("projects work, review, empty triage, triage, and honest implementation commit states", () => {
    const running = fullStatus(action("run-step", { step: "produce" }), { step: "produce", status: "running" });
    expect(projectSemanticStatus(snapshot(running), invocation).view.next_action.kind).toBe("submit-work");

    const review = fullStatus(action("run-step", { step: "counter_review" }), { step: "produce", status: "succeeded" });
    expect(projectSemanticStatus(snapshot(review), invocation).view.next_action.kind).toBe("review");

    const emptyTriage = fullStatus(action("run-step", { step: "triage" }), { step: "counter_review", status: "succeeded" });
    expect(projectSemanticStatus(snapshot(emptyTriage), invocation).view.next_action.kind).toBe("review");

    const finding: PublicFindingV1 = {
      finding_id: "material-defect", severity: "major", blocking: false, summary: "A real defect",
      evidence: "The retained implementation omits the required branch.", suggested_resolution: "Implement the branch.",
    };
    const triage = projectSemanticStatus(snapshot(emptyTriage, { full_findings: [finding] }), invocation);
    expect(triage.view.next_action.kind).toBe("triage");
    expect(triage.view.findings).toEqual([finding]);

    const authorized = projectSemanticStatus(snapshot(fullStatus(action("commit-phase", {
      commit_paths: ["src/z.ts", "src/a.ts"],
      commit_message: "Implement the approved phase",
      commit_target_ref: "refs/heads/main",
      commit_baseline: "2".repeat(40),
    }))), invocation).view.next_action;
    expect(authorized.kind).toBe("commit");
    expect(authorized.commit).toEqual({
      paths: ["src/a.ts", "src/z.ts"],
      message: "Implement the approved phase",
      target_ref: "refs/heads/main",
      baseline: "2".repeat(40),
      requires_human_confirmation: true,
    });
    expect(authorized.offer).toBeUndefined();
    expect(authorized.instruction).toContain("explicit confirmation");

    const missingAuthority = projectSemanticStatus(snapshot(fullStatus(action("commit-phase"))), invocation).view.next_action;
    expect(missingAuthority.kind).toBe("inspect");
    expect(missingAuthority.commit).toBeUndefined();
    expect(missingAuthority.instruction).toContain("implementation commit authority");

    const milestone = projectSemanticStatus(snapshot(fullStatus(action("commit-artifacts", {
      commit_path: ".archflow/tasks/semantic-test/design.md",
      commit_message: "Approve design",
      commit_target_ref: "refs/heads/main",
      commit_baseline: "1".repeat(40),
    }))), invocation).view.next_action;
    expect(milestone.commit).toEqual({
      paths: [".archflow/tasks/semantic-test/design.md"],
      message: "Approve design",
      target_ref: "refs/heads/main",
      baseline: "1".repeat(40),
      requires_human_confirmation: false,
    });
  });

  it("maps the migration-audit gate position and import milestone commit through the shared shapes", () => {
    const designInvocation: WorkflowInvocationV1 = { skill: "archflow-design", intent: "resume" };
    const designPhase = encodePhaseInstance({ kind: "design" });
    const auditPosition = projectSemanticStatus(snapshot(fullStatus(
      action("open-gate", { gate_kind: "migration-audit", phase_instance: designPhase }),
      { phase_instance: designPhase, step: "triage", status: "succeeded" },
    )), designInvocation).view.next_action;
    expect(auditPosition.kind).toBe("decide");
    expect(auditPosition.expected_submission).toBe("gate-summary");

    const importCommit = projectSemanticStatus(snapshot(fullStatus(
      action("commit-artifacts", {
        commit_path: ".archflow/tasks/semantic-test",
        commit_message: "Import legacy task semantic-test",
        commit_target_ref: "refs/heads/main",
        commit_baseline: "3".repeat(40),
      }),
      { phase_instance: designPhase, step: "triage", status: "succeeded" },
    )), designInvocation).view.next_action;
    expect(importCommit.kind).toBe("commit");
    expect(importCommit.commit).toEqual({
      paths: [".archflow/tasks/semantic-test"],
      message: "Import legacy task semantic-test",
      target_ref: "refs/heads/main",
      baseline: "3".repeat(40),
      requires_human_confirmation: false,
    });
  });

  it("binds offers to invocation and repository while generic status cannot mutate", () => {
    const documentPhase = encodePhaseInstance({ kind: "phase-design", phase: parsePositiveSafePhaseNumber(1) });
    const status = fullStatus(action("run-step", { step: "produce", phase_instance: documentPhase }), {
      phase_instance: documentPhase,
    });
    const documentInvocation: WorkflowInvocationV1 = { skill: "archflow-phase-design", phase: 1, intent: "resume" };
    const generic = projectSemanticStatus(snapshot(status));
    expect(generic.view.next_action.kind).toBe("begin-work");
    expect(generic.view.next_action.offer).toBeUndefined();
    expect(generic.internal_offer).toBeUndefined();

    const owned = projectSemanticStatus(snapshot(status), documentInvocation);
    expect(owned.view.next_action.offer).toMatch(/^af1_[0-9a-f]{64}$/u);
    const otherRepo = projectSemanticStatus(snapshot(status, { repository_identity_digest: digestB }), documentInvocation);
    expect(otherRepo.view.next_action.offer).not.toBe(owned.view.next_action.offer);

    const wrongInvocation: WorkflowInvocationV1 = { skill: "archflow-design", intent: "resume" };
    const wrong = projectSemanticStatus(snapshot(status), wrongInvocation);
    expect(wrong.view.next_action.offer).toBeUndefined();
    expect(wrong.view.detail).toContain("does not own");

    const implementation = projectSemanticStatus(snapshot(fullStatus(action("run-step", { step: "produce" }))), invocation);
    expect(implementation.view.next_action.kind).toBe("begin-work");
    expect(implementation.view.next_action.offer).toMatch(/^af1_[0-9a-f]{64}$/u);
  });

  it("lets only the exact successor invocation recover an authenticated handoff", () => {
    const successor = encodePhaseInstance({ kind: "phase-design", phase: parsePositiveSafePhaseNumber(2) });
    const status = fullStatus(action("advance-phase", {
      target_phase_instance: successor,
      skill: "archflow-phase-design",
      skill_args: ["2"],
    }));
    const exact: WorkflowInvocationV1 = { skill: "archflow-phase-design", phase: 2, intent: "resume" };
    const wrong: WorkflowInvocationV1 = { skill: "archflow-phase-design", phase: 3, intent: "resume" };

    expect(projectSemanticStatus(snapshot(status), exact).view.next_action.offer).toMatch(/^af1_[0-9a-f]{64}$/u);
    expect(projectSemanticStatus(snapshot(status), wrong).view.next_action.offer).toBeUndefined();
  });

  it("offers only a server-derived legal earlier reopen and explains its impact", () => {
    const impact: WorkflowReopenImpactV1 = {
      target: { kind: "design" },
      affected_positions: [{ kind: "design" }, { kind: "phase-design", phase: 1 }, { kind: "phase-impl", phase: 1 }],
      authority_effects: ["supersede-results", "clear-active-waivers", "clear-pending-human-revision", "clear-planned-final-phase"],
      planned_final_phase: "clear",
      preserves_existing_git_index_and_worktree_bytes: true,
      appends_prd_ask_history: false,
      requires_fresh_review_and_approval: true,
    };
    const reopenInvocation: WorkflowInvocationV1 = { skill: "archflow-design", intent: "reopen" };
    const result = projectSemanticStatus(snapshot(fullStatus(action("run-step", { step: "produce" })), { reopen_impacts: [impact] }), reopenInvocation);
    expect(result.view.next_action.kind).toBe("reopen");
    expect(result.view.next_action.reopen).toEqual(impact);
    expect(result.view.next_action.expected_submission).toBe("reopening-request");

    const unavailable = projectSemanticStatus(snapshot(fullStatus(action("run-step", { step: "produce" }))), reopenInvocation);
    expect(unavailable.view.next_action.kind).toBe("begin-work");
    expect(unavailable.view.next_action.offer).toBeUndefined();
  });

  it("keeps mechanical authority out of the public view", () => {
    const projected = projectSemanticStatus(snapshot(fullStatus(action("run-step", { step: "produce" }))), invocation);
    const keys = new Set<string>();
    const visit = (value: unknown): void => {
      if (Array.isArray(value)) return value.forEach(visit);
      if (value !== null && typeof value === "object") {
        for (const [key, child] of Object.entries(value)) { keys.add(key); visit(child); }
      }
    };
    visit(projected.view);
    for (const forbidden of ["revision", "input_fingerprint", "request_digest", "intent_id", "gate_id", "subject_digest", "evidence_digest", "rubric_digest", "repository_identity_digest"]) {
      expect(keys.has(forbidden), forbidden).toBe(false);
    }
    expect(projected.view.resources[0]).not.toHaveProperty("digest");
  });

  it("fails closed when a pending waiver archive is invalid", () => {
    const status = fullStatus(action("inspect-state"));
    const result = projectSemanticStatus(snapshot(status, {
      pending_waiver_origin: { status: "invalid" },
    }), invocation);
    expect(result.view.condition).toBe("blocked");
    expect(result.view.next_action.kind).toBe("inspect");
    expect(result.view.next_action.offer).toBeUndefined();
  });

  it("uses canonical offer bytes for stable opaque tokens", () => {
    const offer: SemanticActionOfferV1 = {
      schema_version: "1", repository_identity_digest: digestA, task_id: taskId, revision: 1,
      input_fingerprint: digestB, invocation, action_kind: "review", next_action_code: "run-step",
      expected_submission: "none", phase_instance: phase, attempt: 1,
    };
    expect(semanticOfferToken(offer)).toMatch(/^af1_[0-9a-f]{64}$/u);
    expect(semanticOfferToken(structuredClone(offer))).toBe(semanticOfferToken(offer));
  });

  it("rejects snapshots assembled from different durable revisions", () => {
    const status = fullStatus(action("run-step", { step: "produce" }));
    const state = {
      repository_identity_digest: digestA,
      revision: 8, phase_instance: phase, step: "produce", status: "pending", attempt: 2, input_fingerprint: digestA,
    } as unknown as TaskStateV1;
    expect(() => computeSemanticStatusSnapshot(status, {
      repository_identity_digest: digestA, state, full_findings: [],
    })).toThrow(/same canonical read/u);
  });

  it("rejects caller-supplied repository identity that conflicts with durable authority", () => {
    const status = fullStatus(action("run-step", { step: "produce" }));
    const state = {
      repository_identity_digest: digestB,
      revision: status.revision, phase_instance: phase, step: status.step, status: status.status,
      attempt: status.attempt, input_fingerprint: status.input_fingerprint,
    } as unknown as TaskStateV1;
    expect(() => computeSemanticStatusSnapshot(status, {
      repository_identity_digest: digestA, state, full_findings: [],
    })).toThrow(/repository identity/u);
  });
});

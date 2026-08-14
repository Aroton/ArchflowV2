import { describe, expect, it } from "vitest";

import { projectBriefStatus, type TaskStatusV1 } from "../../src/state/status.js";

const D = "a".repeat(64);

/** A synthetic but shape-faithful full status; the projection is purely structural. */
function fullStatus(overrides: Record<string, unknown> = {}): TaskStatusV1 {
  return {
    task_id: "brief-task",
    state: "active",
    revision: 4,
    phase_instance: "prd",
    step: "counter_review",
    status: "succeeded",
    attempt: 2,
    input_fingerprint: D,
    subject_digest: D,
    resources: [
      { role: "current-artifact", path: ".archflow/tasks/brief-task/prd.md", access: "write" },
      { role: "user-ask", path: ".archflow/tasks/brief-task/ask.md", access: "read-write" },
    ],
    review_policy: {
      rubric_id: "prd-v1",
      rubric_digest: D,
      rubric: {
        schema_version: "1",
        kind: "artifact",
        mode: "adversarial",
        criteria: [{ id: "large-policy-body", text: "Verbose rubric text omitted from brief status.", blocking: true }],
      },
    },
    config: { verified: true, expected_digest: D, observed_digest: D },
    constitution: {
      digest: D,
      active_rules: [
        { id: "task-and-evidence-isolation", version: 1, text: "Tasks are isolated from one another." },
        { id: "secret-hygiene", version: 2, text: "Secrets never enter durable artifacts.", review_trigger: "A secret appears." },
      ],
    },
    evidence: { available: false, reason: "review-set-incomplete" },
    approval_issues: [{
      gate_id: "gate-1",
      gate_kind: "artifact-approval",
      error: { code: "APPROVAL_LOAD_EXCEPTION", message: "diagnostic detail omitted from brief status" },
    }],
    blocking_reasons: ["gate-decision-required"],
    next_action: {
      code: "resolve-open-gate",
      detail: "Resolve the open gate.",
      human_required: true,
      gate_id: "gate-1",
      gate_kind: "artifact-approval",
      request: { tool: "archflow_gate", input: { summary: "placeholder request body" } },
      guidance: "Verbose generated guidance that routine status must omit.",
    },
    ...overrides,
  } as unknown as TaskStatusV1;
}

describe("projectBriefStatus", () => {
  it("projects exactly the brief field set with rule ids instead of rule text", () => {
    const brief = projectBriefStatus(fullStatus());
    expect(Object.keys(brief).sort()).toEqual([
      "attempt", "blocking_reasons", "constitution", "next_action",
      "phase_instance", "revision", "state", "status", "step", "task_id",
    ]);
    expect(brief.constitution).toEqual({
      digest: D,
      active_rule_ids: ["task-and-evidence-isolation", "secret-hygiene"],
    });
    expect(JSON.stringify(brief)).not.toContain("Tasks are isolated");
    expect(JSON.stringify(brief)).not.toContain("input_fingerprint");
    expect(JSON.stringify(brief)).not.toContain("current-artifact");
    expect(JSON.stringify(brief)).not.toContain("Verbose rubric text");
    expect(JSON.stringify(brief)).not.toContain("diagnostic detail omitted");
    expect(brief).not.toHaveProperty("approval_issues");
    expect(brief.next_action.code).toBe("resolve-open-gate");
    expect(brief.next_action).toMatchObject({
      gate_kind: "artifact-approval",
      human_required: true,
    });
    expect(brief.next_action).not.toHaveProperty("gate_id");
    expect(brief.next_action).not.toHaveProperty("request");
    expect(brief.next_action).not.toHaveProperty("guidance");
    expect(JSON.stringify(brief)).not.toContain("placeholder request body");
    expect(JSON.stringify(brief)).not.toContain("Verbose generated guidance");
  });

  it("projects only an open gate's conversational presentation", () => {
    const brief = projectBriefStatus(fullStatus({
      open_gate_id: "gate-1",
      open_gate: {
        gate_id: "gate-1",
        kind: "artifact-approval",
        decision_path: ".archflow/runtime/tasks/brief-task/cache/gates/gate.decision",
        archive_decision_path: ".archflow/tasks/brief-task/authority/decisions/gate-1/decision.json",
        request_path: ".archflow/tasks/brief-task/authority/decisions/gate-1/request.json",
        decision_templates: [
          { decision: "approve", reason: "placeholder body" },
          { decision: "revise", reason: "placeholder body" },
          { decision: "waiver-requested", reason: "placeholder body", rule: { rule_id: "r", rule_version: 1 } },
          { cancelled: true, reason: "placeholder body" },
          { granted: true, notes: "placeholder body" },
          { granted: false, notes: "placeholder body" },
        ],
        presentation: {
          title: "Review the finished work",
          summary: "The implementation is ready for your review.",
          question: "Does this work meet your expectations? Choose an option and briefly explain why.",
          options: [
            { token: "approve", label: "Approve and continue", consequence: "Continue the workflow." },
            { token: "request-changes", label: "Request changes", consequence: "Return the work for revision." },
          ],
        },
      },
    }));
    expect(brief.open_gate).toEqual({
      title: "Review the finished work",
      summary: "The implementation is ready for your review.",
      question: "Does this work meet your expectations? Choose an option and briefly explain why.",
      options: [
        { token: "approve", label: "Approve and continue", consequence: "Continue the workflow." },
        { token: "request-changes", label: "Request changes", consequence: "Return the work for revision." },
      ],
    });
    expect(brief).not.toHaveProperty("open_gate_id");
    expect(brief.next_action).not.toHaveProperty("gate_id");
    const serialized = JSON.stringify(brief);
    expect(serialized).not.toContain("counter_review_prompt");
    expect(serialized).not.toContain("rendered prompt");
    expect(serialized).not.toContain("placeholder body");
    expect(serialized).not.toContain("gate-1");
  });

  it("keeps reconciliation findings as kinds and paths only, and drops the empty case", () => {
    const withFindings = projectBriefStatus(fullStatus({
      reconciliation: {
        classification: "reconciliation-required",
        findings: [
          { kind: "projection-mismatch", path: ".archflow/tasks/brief-task/prd.md", recorded_digest: D, observed_digest: D },
          { kind: "active-gate-orphan" },
        ],
      },
    }));
    expect(withFindings.reconciliation).toEqual({
      classification: "reconciliation-required",
      findings: [
        { kind: "projection-mismatch", path: ".archflow/tasks/brief-task/prd.md" },
        { kind: "active-gate-orphan" },
      ],
    });

    const empty = projectBriefStatus(fullStatus({
      reconciliation: { classification: "consistent", findings: [] },
    }));
    expect(empty.reconciliation).toBeUndefined();
  });

  it("exposes workspace cleanup only while cleanup is pending", () => {
    const clean = projectBriefStatus(fullStatus({
      workspace: {
        removed_files: 0, removed_bytes: 0, retained_files: 2, retained_bytes: 20,
        cleanup_pending: false,
      },
    }));
    expect(clean.workspace).toBeUndefined();

    const pending = projectBriefStatus(fullStatus({
      workspace: {
        removed_files: 0, removed_bytes: 0, retained_files: 1, retained_bytes: 10,
        cleanup_pending: true,
      },
    }));
    expect(pending.workspace).toEqual({
      removed_files: 0, removed_bytes: 0, retained_files: 1, retained_bytes: 10,
      cleanup_pending: true,
    });
    expect(pending.blocking_reasons).toEqual(["gate-decision-required"]);
  });
});

import { describe, expect, it } from "vitest";
import { createProjectError, describeValidationIssues } from "../../src/contracts/errors.js";
import { archFlowApplyInputV1Schema } from "../../src/contracts/semantic-workflow.js";
import { workflowFailure } from "../../src/state/workflow-recovery.js";

describe("workflow failure recovery", () => {
  it("preserves the configured repository field and repair instruction", () => {
    const error = workflowFailure(createProjectError("CONFIG_INVALID", {
      issue_code: "repository-identity-changed",
      issues: ["repositories.api.path: repository identity changed at the unchanged declared path"],
    }));
    expect(error.message).toContain("repositories.api.path");
    expect(error.recovery).toMatchObject({ kind: "repair" });
    expect(error.recovery?.instruction).toContain("archflow_status");
    expect(error.retryable).toBe(false);
    expect(error.message).not.toContain("issue_code");
  });

  it("distinguishes refreshing a stale offer from replaying an interrupted operation", () => {
    const stale = workflowFailure({ code: "SEMANTIC_OFFER_STALE", message: "The offer changed." });
    expect(stale).toMatchObject({ retryable: false, recovery: { kind: "refresh-status" } });
    const interrupted = workflowFailure(createProjectError("IO_ERROR", { operation: "record-state", attempt: 1 }));
    expect(interrupted).toMatchObject({ retryable: true, recovery: { kind: "retry" } });
    expect(interrupted.recovery?.instruction).toContain("identical call");
  });

  it("reports the nested field in the matching submission branch", () => {
    const result = archFlowApplyInputV1Schema.safeParse({
      schema_version: "1", task_id: "recovery-test",
      invocation: { skill: "archflow-prd", intent: "resume" },
      action: { offer: `af1_${"a".repeat(64)}`, submission: { kind: "gate-summary", summary: 12 } },
    });
    expect(result.success).toBe(false);
    if (result.success) return;
    const issues = describeValidationIssues(result.error);
    expect(issues).toHaveLength(1);
    expect(issues![0]).toContain("action.submission.summary");
    expect(issues![0]).toContain("string");
    expect(issues![0]).not.toContain("task-ask");
  });

  it("does not replace unauthenticated replay failures with a retry recipe", () => {
    expect(workflowFailure({ code: "SEMANTIC_REPLAY_MISMATCH", message: "The archived decision cannot be authenticated." }))
      .toMatchObject({ retryable: false, recovery: { kind: "operator" } });
  });
});

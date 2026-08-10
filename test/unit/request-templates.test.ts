import { describe, expect, it } from "vitest";

import type { TaskStateV1 } from "../../src/contracts/durable-state.js";
import type { Sha256Digest, TaskSlug } from "../../src/contracts/evidence.js";
import { parseToolCall } from "../../src/contracts/mcp-tools.js";
import type { CurrentEvidenceSetRef } from "../../src/contracts/trust.js";
import type { NextAction } from "../../src/state/next-action.js";
import { buildNextActionRequest } from "../../src/state/request-templates.js";
import type { CommitAuthorizationInput } from "../../src/state/status.js";

const taskId = "template-task" as TaskSlug;
const fingerprint = "a".repeat(64) as Sha256Digest;
const subjectDigest = "b".repeat(64) as Sha256Digest;

function stateAt(phaseInstance: string, step: TaskStateV1["step"] = "produce"): TaskStateV1 {
  return {
    schema_version: "1",
    task_id: taskId,
    revision: 7,
    phase_instance: phaseInstance,
    step,
    status: "succeeded",
    attempt: 1,
    input_fingerprint: fingerprint,
  } as unknown as TaskStateV1;
}

function action(partial: Partial<NextAction> & Pick<NextAction, "code">): NextAction {
  return { detail: "test", human_required: false, ...partial } as NextAction;
}

function assertFrozenPlainJson(value: unknown, path = "$"): void {
  if (value === null || typeof value !== "object") {
    expect(["string", "number", "boolean"].includes(typeof value) || value === null, path).toBe(true);
    return;
  }
  expect(Object.isFrozen(value), path).toBe(true);
  for (const [key, nested] of Object.entries(value)) assertFrozenPlainJson(nested, `${path}.${key}`);
}

describe("next-action request templates", () => {
  it("prefills the initialization entry point and fails closed when submitted unedited", () => {
    const request = buildNextActionRequest(action({ code: "create-task" }), { task_id: taskId });
    expect(request?.tool).toBe("archflow_state");
    expect(request?.template).toMatchObject({
      schema_version: "1",
      task_id: taskId,
      intent_id: "initialize-task",
      expected_revision: 0,
      phase_instance: "prd",
      step: "produce",
      status: "running",
    });
    assertFrozenPlainJson(request?.template);
    // Placeholder prose must not survive ingress: the fingerprint and artifact placeholders
    // each violate their field's contract, so an unedited template cannot become a real call.
    expect(() => parseToolCall("archflow_state", structuredClone(request?.template))).toThrow();
  });

  it("prefills the running step entry from durable state", () => {
    const request = buildNextActionRequest(
      action({ code: "run-step", step: "self_review" }),
      { task_id: taskId, state: stateAt("prd") },
    );
    expect(request?.tool).toBe("archflow_state");
    expect(request?.template).toMatchObject({
      expected_revision: 7,
      input_fingerprint: fingerprint,
      phase_instance: "prd",
      step: "self_review",
      status: "running",
    });
    expect(request?.guidance).toContain("archflow-local envelope");
  });

  it("derives the canonical review subject paths per phase kind", () => {
    const counter = buildNextActionRequest(
      action({ code: "run-step", step: "counter_review" }),
      { task_id: taskId, state: stateAt("phase-design-2") },
    );
    expect(counter?.tool).toBe("archflow_counter_review");
    expect(counter?.template).toMatchObject({ artifact_path: "phases/2/design.md" });
    expect(() => parseToolCall("archflow_counter_review", structuredClone(counter?.template))).toThrow();

    const adjudicate = buildNextActionRequest(
      action({ code: "run-step", step: "adjudicate" }),
      { task_id: taskId, state: stateAt("phase-impl-3") },
    );
    expect(adjudicate?.tool).toBe("archflow_adjudicate");
    expect(adjudicate?.template).toMatchObject({
      artifact_path: "phases/3/impl-notes.md",
      upstream_paths: ["phases/3/design.md", "design.md"],
    });
  });

  it("binds the artifact-approval gate template to the authenticated subject", () => {
    const currentEvidence = {
      set_digest: "c".repeat(64),
      sources: [],
    } as unknown as CurrentEvidenceSetRef;
    const request = buildNextActionRequest(
      action({ code: "open-gate", gate_kind: "artifact-approval" }),
      { task_id: taskId, state: stateAt("design"), subject_digest: subjectDigest, current_evidence: currentEvidence },
    );
    expect(request?.tool).toBe("archflow_gate");
    expect(request?.template).toMatchObject({
      subject_digest: subjectDigest,
      kind: "artifact-approval",
      context: { artifact_kind: "design" },
    });
  });

  it("folds the commit-authorization facts into a complete gate template", () => {
    const authorization = {
      kind: "commit-authorization",
      subject_digest: subjectDigest,
      current_evidence: { set_digest: "c".repeat(64), sources: [] },
      context: {
        target_ref: "refs/heads/main",
        diff_digest: "d".repeat(64),
        current_artifact_digests: [subjectDigest],
        parent_document_digests: [],
      },
      target_ref_guidance: "Confirm the target ref.",
    } as unknown as CommitAuthorizationInput;
    const request = buildNextActionRequest(
      action({ code: "open-gate", gate_kind: "commit-authorization" }),
      { task_id: taskId, state: stateAt("phase-impl-1"), commit_authorization: authorization },
    );
    expect(request?.tool).toBe("archflow_gate");
    expect(request?.template).toMatchObject({
      kind: "commit-authorization",
      subject_digest: subjectDigest,
      context: { target_ref: "refs/heads/main" },
    });
    expect(request?.guidance).toContain("Confirm the target ref.");
  });

  it("emits nothing for actions that already have a surface or are pure human judgment", () => {
    for (const code of ["resolve-open-gate", "triage-supplemental-review", "advance-phase", "commit-phase", "complete-task", "task-complete", "inspect-state"] as const) {
      expect(buildNextActionRequest(action({ code }), { task_id: taskId, state: stateAt("prd") })).toBeUndefined();
    }
    expect(buildNextActionRequest(action({ code: "run-step", step: "produce" }), { task_id: taskId })).toBeUndefined();
  });
});

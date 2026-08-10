import { describe, expect, it } from "vitest";

import type { DurableArtifact } from "../../src/contracts/durable.js";
import type { AuthoritativeResultRef, TaskStateV1 } from "../../src/contracts/durable-state.js";
import type { SafeInteger, Sha256Digest, TaskSlug } from "../../src/contracts/evidence.js";
import { parseToolCall } from "../../src/contracts/mcp-tools.js";
import type { CurrentEvidenceSetRef } from "../../src/contracts/trust.js";
import type { PipelineStep } from "../../src/contracts/vocabulary.js";
import type { NextAction } from "../../src/state/next-action.js";
import { buildNextActionRequest } from "../../src/state/request-templates.js";
import type { CommitAuthorizationInput } from "../../src/state/status.js";
import { legalRunStepStatus, planStateTransition } from "../../src/state/transitions.js";

const taskId = "template-task" as TaskSlug;
const fingerprint = "a".repeat(64) as Sha256Digest;
const subjectDigest = "b".repeat(64) as Sha256Digest;
const fingerprintSentinel = "0".repeat(64);

function stateAt(
  phaseInstance: string,
  step: TaskStateV1["step"] = "produce",
  status: TaskStateV1["status"] = "succeeded",
): TaskStateV1 {
  return {
    schema_version: "1",
    task_id: taskId,
    revision: 7,
    phase_instance: phaseInstance,
    step,
    status,
    attempt: 1,
    input_fingerprint: fingerprint,
    authoritative_results: [],
    approvals: [],
    waivers: [],
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
    expect(request?.request.tool).toBe("archflow_state");
    expect(request?.request.input).toMatchObject({
      schema_version: "1",
      task_id: taskId,
      intent_id: "initialize-task",
      expected_revision: 0,
      phase_instance: "prd",
      step: "produce",
      status: "running",
    });
    assertFrozenPlainJson(request?.request.input);
    // Placeholder prose must not survive ingress: the artifact placeholder violates its field's
    // contract, so an unedited template cannot become a real call. The fingerprint sentinel is
    // parseable on purpose (envelope must be able to process the completed template) but can
    // never match a computed fingerprint, so it too fails closed at the server.
    expect(() => parseToolCall("archflow_state", structuredClone(request?.request.input))).toThrow();
  });

  it("prefills the running step entry from durable state with the sentinel fingerprint", () => {
    const request = buildNextActionRequest(
      action({ code: "run-step", step: "self_review" }),
      { task_id: taskId, state: stateAt("prd") },
    );
    expect(request?.request.tool).toBe("archflow_state");
    expect(request?.request.input).toMatchObject({
      expected_revision: 7,
      input_fingerprint: fingerprintSentinel,
      phase_instance: "prd",
      step: "self_review",
      status: "running",
    });
    expect(request?.guidance).toContain("archflow-local envelope");
  });

  it("emits the terminal record, not a repeat entry, for a step already running", () => {
    const request = buildNextActionRequest(
      action({ code: "run-step", step: "produce" }),
      { task_id: taskId, state: stateAt("prd", "produce", "running") },
    );
    expect(request?.request.tool).toBe("archflow_state");
    expect(request?.request.input).toMatchObject({
      phase_instance: "prd",
      step: "produce",
      status: "succeeded",
    });
    expect((request?.request.input as { artifact?: unknown }).artifact).toContain("build-request");
    expect(request?.guidance).toContain("failed");
    expect(() => parseToolCall("archflow_state", structuredClone(request?.request.input))).toThrow();

    const review = buildNextActionRequest(
      action({ code: "run-step", step: "self_review" }),
      { task_id: taskId, state: stateAt("prd", "self_review", "running") },
    );
    expect(review?.request.input).toMatchObject({ step: "self_review", status: "succeeded" });
  });

  it("emits the retry entry for a failed step", () => {
    const request = buildNextActionRequest(
      action({ code: "run-step", step: "produce" }),
      { task_id: taskId, state: stateAt("prd", "produce", "failed") },
    );
    expect(request?.request.input).toMatchObject({ step: "produce", status: "running" });
    expect((request?.request.input as { artifact?: unknown }).artifact).toBeUndefined();
  });

  it("emits nothing when no legal run-step transition exists from the derived state", () => {
    // A succeeded step has no same-subject move left; only its successor is legal.
    expect(buildNextActionRequest(
      action({ code: "run-step", step: "produce" }),
      { task_id: taskId, state: stateAt("prd", "produce", "succeeded") },
    )).toBeUndefined();
    // counter_review is not the pipeline successor of produce.
    expect(buildNextActionRequest(
      action({ code: "run-step", step: "counter_review" }),
      { task_id: taskId, state: stateAt("prd", "produce", "succeeded") },
    )).toBeUndefined();
  });

  it("derives the canonical review subject paths per phase kind while the step is running", () => {
    const counter = buildNextActionRequest(
      action({ code: "run-step", step: "counter_review" }),
      { task_id: taskId, state: stateAt("phase-design-2", "counter_review", "running") },
    );
    expect(counter?.request.tool).toBe("archflow_counter_review");
    expect(counter?.request.input).toMatchObject({ artifact_path: "phases/2/design.md" });
    expect(() => parseToolCall("archflow_counter_review", structuredClone(counter?.request.input))).toThrow();

    const adjudicate = buildNextActionRequest(
      action({ code: "run-step", step: "adjudicate" }),
      { task_id: taskId, state: stateAt("phase-impl-3", "adjudicate", "running") },
    );
    expect(adjudicate?.request.tool).toBe("archflow_adjudicate");
    expect(adjudicate?.request.input).toMatchObject({
      artifact_path: "phases/3/impl-notes.md",
      upstream_paths: ["phases/3/design.md", "design.md"],
    });

    const counterEntry = buildNextActionRequest(
      action({ code: "run-step", step: "counter_review" }),
      { task_id: taskId, state: stateAt("phase-design-2", "self_review", "succeeded") },
    );
    expect(counterEntry?.request.tool).toBe("archflow_state");
    expect(counterEntry?.request.input).toMatchObject({ step: "counter_review", status: "running" });
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
    expect(request?.request.tool).toBe("archflow_gate");
    expect(request?.request.input).toMatchObject({
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
    expect(request?.request.tool).toBe("archflow_gate");
    expect(request?.request.input).toMatchObject({
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

describe("run-step template legality", () => {
  const steps: readonly PipelineStep[] = ["produce", "self_review", "counter_review", "triage", "adjudicate"];
  const statuses: readonly TaskStateV1["status"][] = ["running", "failed", "succeeded"];

  // Mirrors the server's attempt derivation: the client never supplies attempt, so the template's
  // target must be legal at exactly the attempt the handler will derive for it.
  function derivedAttempt(current: TaskStateV1, targetStep: PipelineStep): SafeInteger {
    const retry = current.status === "failed" && current.step === targetStep;
    const reentry = current.step !== targetStep &&
      (current.step === "triage" || current.step === "adjudicate") && targetStep === "produce";
    return (retry || reentry ? current.attempt + 1 : current.attempt) as SafeInteger;
  }

  function documentStub(current: TaskStateV1, step: PipelineStep): DurableArtifact {
    return {
      artifact_kind: "document",
      task_id: current.task_id,
      phase_instance: current.phase_instance,
      step,
      input_fingerprint: fingerprint,
    } as unknown as DurableArtifact;
  }

  function referenceStub(current: TaskStateV1, step: PipelineStep): AuthoritativeResultRef {
    return {
      phase_instance: current.phase_instance,
      step,
      result_digest: subjectDigest,
      result_id: "result-1",
      input_fingerprint: fingerprint,
      manifest_path: `.archflow/tasks/${taskId}/results/sha256/${"b".repeat(64)}/manifest.json`,
    } as unknown as AuthoritativeResultRef;
  }

  it("every emitted archflow_state target is a legal transition from the state it was derived in", () => {
    for (const step of steps) for (const status of statuses) {
      const current = stateAt("prd", step, status);
      for (const target of steps) {
        const derived = legalRunStepStatus(current, target);
        if (derived === undefined) continue;
        // counter_review and adjudicate terminal results are recorded by their own tools,
        // never through an archflow_state template.
        if (derived === "succeeded" && (target === "counter_review" || target === "adjudicate")) continue;
        const producing = derived === "succeeded";
        const plan = planStateTransition({
          current,
          target: {
            phase_instance: current.phase_instance,
            step: target,
            status: derived,
            attempt: derivedAttempt(current, target),
            input_fingerprint: fingerprint,
          },
          recomputed_input_fingerprint: fingerprint,
          ...(producing && target === "produce" ? { artifact: documentStub(current, target) } : {}),
          ...(producing ? { result_reference: referenceStub(current, target) } : {}),
        });
        expect(plan.ok, `${step}-${status} -> ${target}-${derived}`).toBe(true);
      }
    }
  });

  it("never derives the repeat running entry the server rejects mid-step", () => {
    for (const step of steps) {
      const current = stateAt("prd", step, "running");
      expect(legalRunStepStatus(current, step)).not.toBe("running");
      const plan = planStateTransition({
        current,
        target: {
          phase_instance: current.phase_instance,
          step,
          status: "running",
          attempt: current.attempt,
          input_fingerprint: fingerprint,
        },
        recomputed_input_fingerprint: fingerprint,
      });
      expect(plan.ok ? undefined : plan.error.code, `${step}-running -> ${step}-running`).toBe("TRANSITION_INVALID");
    }
  });
});

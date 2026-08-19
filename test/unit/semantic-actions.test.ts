import { describe, expect, it } from "vitest";

import type { TaskStateV1 } from "../../src/contracts/durable-state.js";
import { parseSha256Digest, type Sha256Digest } from "../../src/contracts/evidence.js";
import type {
  ApplySubmissionV1,
  SemanticStatusSnapshotV1,
  WorkflowInvocationV1,
} from "../../src/contracts/semantic-workflow.js";
import {
  authenticateSemanticLastTransition,
  executeSemanticAction,
  executeSemanticActionSubstep,
  parseSemanticSubstepIntentId,
  planSemanticAction,
  SemanticActionPlanError,
  SemanticActionExecutionError,
  semanticSubstepIntentId,
} from "../../src/state/semantic-actions.js";
import { projectSemanticStatus } from "../../src/state/semantic-view.js";
import type { TaskStatusV1 } from "../../src/state/status.js";
import type { ProductionServices } from "../../src/state/production.js";

const digest = (character: string): Sha256Digest => parseSha256Digest(character.repeat(64));
const invocation: WorkflowInvocationV1 = { skill: "archflow-phase-design", phase: 1, intent: "resume" };

function state(step: "produce" | "counter_review" | "triage", status: "running" | "succeeded" | "failed" = "succeeded"): TaskStateV1 {
  return {
    schema_version: "1", task_id: "api-refactor" as TaskStateV1["task_id"], repository_identity_digest: digest("1"),
    revision: 7 as TaskStateV1["revision"], phase_instance: "phase-design-1" as TaskStateV1["phase_instance"], step, status,
    attempt: 1 as TaskStateV1["attempt"], input_fingerprint: digest("2"), initialization_digest: digest("3"),
    config_digest: digest("4"), workflow_digest: digest("5"), constitution_digest: digest("6"),
    policy_base_commit: "a".repeat(40) as TaskStateV1["policy_base_commit"], authoritative_results: [], approvals: [], waivers: [],
  };
}

function snapshot(
  durable: TaskStateV1,
  nextAction: TaskStatusV1["next_action"],
  extra: Partial<SemanticStatusSnapshotV1> = {},
): SemanticStatusSnapshotV1 {
  const status: TaskStatusV1 = {
    task_id: durable.task_id,
    state: "active",
    revision: durable.revision,
    phase_instance: durable.phase_instance,
    step: durable.step,
    status: durable.status,
    attempt: durable.attempt,
    input_fingerprint: durable.input_fingerprint,
    blocking_reasons: [],
    config: { verified: true },
    next_action: nextAction,
  };
  return {
    schema_version: "1", repository_identity_digest: durable.repository_identity_digest, state: durable,
    status: status as unknown as SemanticStatusSnapshotV1["status"], full_findings: [], reopen_impacts: [], ...extra,
  };
}

function apply(
  current: SemanticStatusSnapshotV1,
  owner: WorkflowInvocationV1,
  submission?: ApplySubmissionV1,
): ReturnType<typeof planSemanticAction> {
  const offer = projectSemanticStatus(current, owner).view.next_action.offer;
  if (offer === undefined) throw new Error("fixture did not produce an offer");
  return planSemanticAction(current, {
    schema_version: "1", task_id: "api-refactor", invocation: owner,
    action: { offer, ...(submission === undefined ? {} : { submission }) },
  });
}

describe("semantic one-action planning", () => {
  it("plans begin-work deterministically as one compose-request substep", () => {
    const current = snapshot(state("produce", "failed"), {
      code: "run-step", detail: "Retry produce.", human_required: false, phase_instance: "phase-design-1" as TaskStateV1["phase_instance"], step: "produce",
    });
    const first = apply(current, invocation);
    const retry = apply(current, invocation);
    expect(first).toEqual(retry);
    expect(first).toMatchObject({ action_kind: "begin-work", substeps: ["begin-work"], next_substep: "begin-work", execution: "compose-request", request_facts: { kind: "running", step: "produce" } });
    expect(parseSemanticSubstepIntentId(first.intent_id)).toEqual({ operation_digest: first.operation_digest, substep: "begin-work" });
  });

  it("strictly matches submissions and binds changed work facts to a different operation", () => {
    const current = snapshot(state("produce", "running"), {
      code: "run-step", detail: "Submit produce.", human_required: false, phase_instance: "phase-design-1" as TaskStateV1["phase_instance"], step: "produce",
    });
    const work = (rationale: string): ApplySubmissionV1 => ({
      kind: "work-result", outcome: "succeeded",
      human_revision: { classification: "simple", rationale },
    });
    expect(() => apply(current, invocation)).toThrow(SemanticActionPlanError);
    const first = apply(current, invocation, work("first revision"));
    const changed = apply(current, invocation, work("second revision"));
    expect(first.operation_digest).not.toBe(changed.operation_digest);
    expect(first.request_facts).toMatchObject({ kind: "produce" });
    const offered = projectSemanticStatus(current, invocation).view.next_action.offer!;
    expect(() => planSemanticAction(current, { schema_version: "1", task_id: "api-refactor", invocation, action: { offer: offered, submission: { kind: "gate-summary", summary: "Wrong." } } })).toThrow(/expects work-result/u);
  });

  it("requires implementation facts at a phase-impl position and refuses them at document positions", () => {
    const implementationInvocation: WorkflowInvocationV1 = { skill: "archflow-phase-impl", phase: 1, intent: "resume" };
    const implementationState = { ...state("produce", "running"), phase_instance: "phase-impl-1" as TaskStateV1["phase_instance"] };
    const implementationPosition = snapshot(implementationState, {
      code: "run-step", detail: "Submit implementation.", human_required: false, phase_instance: implementationState.phase_instance, step: "produce",
    });
    const facts = { base_commit: "a".repeat(40), outputs: ["src/a.ts"], restore_targets: ["src/a.ts"], declared_inputs: [] };
    expect(() => apply(implementationPosition, implementationInvocation, { kind: "work-result", outcome: "succeeded" }))
      .toThrowError(expect.objectContaining({ code: "SEMANTIC_SUBMISSION_MISMATCH" }));
    const declared = apply(implementationPosition, implementationInvocation, { kind: "work-result", outcome: "succeeded", implementation: facts });
    expect(declared.action_kind).toBe("submit-work");
    expect(declared.request_facts).toMatchObject({ kind: "produce", implementation: { outputs: ["src/a.ts"] } });
    expect(apply(implementationPosition, implementationInvocation, { kind: "work-result", outcome: "failed", reason: "verification failed" }))
      .toMatchObject({ action_kind: "submit-work", request_facts: { kind: "failed" } });

    const documentPosition = snapshot(state("produce", "running"), {
      code: "run-step", detail: "Submit document.", human_required: false, phase_instance: "phase-design-1" as TaskStateV1["phase_instance"], step: "produce",
    });
    expect(() => apply(documentPosition, invocation, { kind: "work-result", outcome: "succeeded", implementation: facts }))
      .toThrowError(expect.objectContaining({ code: "SEMANTIC_SUBMISSION_MISMATCH" }));
    expect(apply(documentPosition, invocation, { kind: "work-result", outcome: "failed", reason: "document work failed" }))
      .toMatchObject({ action_kind: "submit-work", request_facts: { kind: "failed" } });
  });

  it("uses fixed review continuations without redispatching a finding-free retained review", () => {
    const pending = snapshot(state("produce", "succeeded"), {
      code: "run-step", detail: "Run review.", human_required: false, phase_instance: "phase-impl-1" as TaskStateV1["phase_instance"], step: "counter_review",
    });
    expect(apply(pending, invocation)).toMatchObject({ substeps: ["review-enter", "review-run", "review-empty-triage"], next_substep: "review-enter", execution: "compose-request" });

    const running = snapshot(state("counter_review", "running"), {
      code: "run-step", detail: "Record review.", human_required: false, phase_instance: "phase-impl-1" as TaskStateV1["phase_instance"], step: "counter_review",
    });
    expect(apply(running, invocation)).toMatchObject({ substeps: ["review-run"], execution: "counter-review-handler", request_facts: { kind: "counter-review" } });

    const forgedState = { ...state("counter_review", "running"), last_transition: {
      schema_version: "1", tool: "archflow_state", operation: "wrong-operation",
      intent_id: semanticSubstepIntentId(digest("a"), "review-enter"), request_digest: digest("b"),
      input_fingerprint: digest("2"), result_id: "result-1", outcome: { ok: true }, outcome_digest: digest("c"),
      prior_revision: 6, resulting_revision: 7,
    } } as unknown as TaskStateV1;
    const forged = snapshot(forgedState, {
      code: "run-step", detail: "Record review.", human_required: false, phase_instance: forgedState.phase_instance, step: "counter_review",
    });
    expect(() => apply(forged, invocation)).toThrowError(expect.objectContaining({ code: "SEMANTIC_REPLAY_MISMATCH" }));

    const empty = snapshot(state("counter_review", "succeeded"), {
      code: "run-step", detail: "Record empty triage.", human_required: false, phase_instance: "phase-impl-1" as TaskStateV1["phase_instance"], step: "triage",
    });
    expect(apply(empty, invocation)).toMatchObject({ substeps: ["review-empty-triage"], execution: "compose-request", request_facts: { kind: "triage", dispositions: [] } });
  });

  it("recovers the remaining review substeps when an intervening gate overwrote the entry transition", () => {
    // A human gate decision (for example baseline-adoption) may legally land at any position and
    // overwrites the single last_transition slot. That is not forgery: the review keeps going.
    const interloper = (durable: TaskStateV1): TaskStateV1 => ({ ...durable, last_transition: {
      schema_version: "1", tool: "archflow_gate", operation: "gate",
      intent_id: semanticSubstepIntentId(digest("a"), "open-gate"), request_digest: digest("b"),
      input_fingerprint: digest("2"), result_id: "gate-1", outcome: { ok: true }, outcome_digest: digest("c"),
      prior_revision: 6, resulting_revision: 7,
    } } as unknown as TaskStateV1);
    const recordReview: TaskStatusV1["next_action"] = {
      code: "run-step", detail: "Record review.", human_required: false, phase_instance: "phase-impl-1" as TaskStateV1["phase_instance"], step: "counter_review",
    };
    const recordTriage: TaskStatusV1["next_action"] = {
      code: "run-step", detail: "Record empty triage.", human_required: false, phase_instance: "phase-impl-1" as TaskStateV1["phase_instance"], step: "triage",
    };

    // The wedge: counter_review/running still dispatches a real review, under a fresh operation.
    const wedged = apply(snapshot(interloper(state("counter_review", "running")), recordReview), invocation);
    expect(wedged).toMatchObject({ substeps: ["review-run"], next_substep: "review-run", execution: "counter-review-handler", request_facts: { kind: "counter-review" } });
    expect(parseSemanticSubstepIntentId(wedged.intent_id).operation_digest).toBe(wedged.operation_digest);
    expect(wedged.operation_digest).not.toBe(digest("a"));

    for (const durable of [interloper(state("counter_review", "succeeded")), interloper(state("triage", "running"))]) {
      expect(apply(snapshot(durable, recordTriage), invocation)).toMatchObject({
        substeps: ["review-empty-triage"], execution: "compose-request", request_facts: { kind: "triage", dispositions: [] },
      });
    }

    // Pre-facade transitions keep their existing continuation.
    const preFacade = { ...state("counter_review", "running"), last_transition: {
      schema_version: "1", tool: "archflow_state", operation: "record-state-boundary",
      intent_id: "review-20260819T001901-43d5", request_digest: digest("b"),
      input_fingerprint: digest("2"), result_id: "result-1", outcome: { ok: true }, outcome_digest: digest("c"),
      prior_revision: 6, resulting_revision: 7,
    } } as unknown as TaskStateV1;
    expect(apply(snapshot(preFacade, recordReview), invocation)).toMatchObject({ substeps: ["review-run"], execution: "counter-review-handler" });

    // A transition that claims the continued substep but fails authentication is still a forgery.
    const forgedTriageEntry = { ...state("triage", "running"), last_transition: {
      schema_version: "1", tool: "archflow_state", operation: "wrong-operation",
      intent_id: semanticSubstepIntentId(digest("a"), "triage-enter"), request_digest: digest("b"),
      input_fingerprint: digest("2"), result_id: "result-1", outcome: { ok: true }, outcome_digest: digest("c"),
      prior_revision: 6, resulting_revision: 7,
    } } as unknown as TaskStateV1;
    expect(() => apply(snapshot(forgedTriageEntry, recordTriage), invocation))
      .toThrowError(expect.objectContaining({ code: "SEMANTIC_REPLAY_MISMATCH" }));
  });

  it("plans triage, revision entry, gate opening, and handoff as bounded single actions", () => {
    const finding = { finding_id: "finding-1", severity: "major" as const, blocking: false, summary: "Issue", evidence: "Evidence", suggested_resolution: "Fix" };
    const triage = snapshot(state("triage", "running"), {
      code: "run-step", detail: "Triage.", human_required: false, phase_instance: "phase-impl-1" as TaskStateV1["phase_instance"], step: "triage",
    }, { full_findings: [finding] });
    expect(apply(triage, invocation, { kind: "triage", dispositions: [{ finding_id: "finding-1", disposition: "rejected", rationale: "Not material.", evidence: "Current behavior." }] })).toMatchObject({ action_kind: "triage", substeps: ["triage"], request_facts: { kind: "triage" } });

    const revise = snapshot(state("triage", "succeeded"), {
      code: "run-step", detail: "Revise.", human_required: false, phase_instance: "phase-impl-1" as TaskStateV1["phase_instance"], step: "produce",
    });
    expect(apply(revise, invocation)).toMatchObject({ action_kind: "revise", substeps: ["revise-enter"], request_facts: { kind: "running", step: "produce" } });

    const gate = snapshot(state("triage", "succeeded"), {
      code: "open-gate", detail: "Open gate.", human_required: true, phase_instance: "phase-impl-1" as TaskStateV1["phase_instance"], gate_kind: "commit-authorization",
    });
    expect(apply(gate, invocation, { kind: "gate-summary", summary: "Ready for authorization." })).toMatchObject({ action_kind: "decide", substeps: ["open-gate"], request_facts: { kind: "gate", summary: "Ready for authorization." } });

    const handoff = snapshot(state("triage", "succeeded"), {
      code: "advance-phase", detail: "Advance.", human_required: false, phase_instance: "phase-impl-1" as TaskStateV1["phase_instance"], target_phase_instance: "phase-design-2" as TaskStateV1["phase_instance"], skill: "archflow-phase-design", skill_args: ["2"],
    });
    expect(projectSemanticStatus(handoff, invocation).view.next_action.offer).toBeUndefined();
    expect(apply(handoff, { skill: "archflow-phase-design", phase: 2, intent: "resume" })).toMatchObject({
      action_kind: "start-next-skill", substeps: ["start-next-skill"], request_facts: { kind: "advance" },
    });
  });

  it("preserves exact reopening bytes and retains direct decision submission for archive execution", () => {
    const currentState = { ...state("produce", "running"), phase_instance: "phase-impl-2" as TaskStateV1["phase_instance"] };
    const impact = { target: { kind: "design" as const }, affected_positions: [{ kind: "design" as const }], authority_effects: ["supersede-results" as const], planned_final_phase: "clear" as const, preserves_existing_git_index_and_worktree_bytes: true as const, appends_prd_ask_history: false, requires_fresh_review_and_approval: true as const };
    const reopenSnapshot = snapshot(currentState, { code: "run-step", detail: "Current work.", human_required: false, phase_instance: currentState.phase_instance, step: "produce" }, { reopen_impacts: [impact] });
    const reopenInvocation: WorkflowInvocationV1 = { skill: "archflow-design", intent: "reopen" };
    expect(apply(reopenSnapshot, reopenInvocation, { kind: "reopening-request", request: " exact request \n" })).toMatchObject({
      action_kind: "reopen", execution: "compose-request", reopening_request: " exact request \n",
      request_facts: { kind: "planning-restart", invocation: reopenInvocation, reason: " exact request \n" },
    });

    const waiver = snapshot(state("triage", "succeeded"), {
      code: "inspect-state", detail: "Open pending waiver.", human_required: false,
    }, { pending_waiver_origin: { status: "exact" } });
    expect(apply(waiver, invocation)).toMatchObject({
      action_kind: "open-waiver", execution: "compose-request", request_facts: { kind: "waiver" },
    });

    const open = state("triage", "succeeded");
    const decision = snapshot(open, {
      code: "resolve-open-gate", detail: "Choose.", human_required: true, phase_instance: open.phase_instance, gate_id: "gate-1" as never, gate_kind: "artifact-approval",
    });
    (decision.status as unknown as Record<string, unknown>).open_gate = { presentation: { title: "Approve", summary: "Summary", question: "Choose?", options: [{ token: "approve", label: "Approve", consequence: "Advances" }] } };
    const deferred = apply(decision, invocation, { kind: "decision", choice: "approve", reason: "Approved." });
    expect(deferred).toMatchObject({
      substeps: ["decision-archive", "decision-settle"], next_substep: "decision-archive",
      execution: "decision-archive", decision_submission: { choice: "approve", reason: "Approved." },
    });

    const malformedConnected = { ...decision, archived_decision: { status: "invalid" } } as SemanticStatusSnapshotV1;
    const blocked = projectSemanticStatus(malformedConnected, invocation).view;
    expect(blocked.next_action).toMatchObject({ kind: "inspect" });
    expect(blocked.next_action.offer).toBeUndefined();
    expect(() => planSemanticAction(malformedConnected, {
      schema_version: "1", task_id: "api-refactor", invocation,
      action: { offer: `af1_${"a".repeat(64)}` },
    })).toThrowError(expect.objectContaining({ code: "SEMANTIC_OFFER_STALE" }));

    for (const archivedDecision of [
      { status: "exact", operation_digest: digest("8") },
      { status: "exact", operation_digest: digest("9"), provenance: "pre-facade" },
    ]) {
      const continuation = { ...decision, archived_decision: archivedDecision } as SemanticStatusSnapshotV1;
      expect(apply(continuation, invocation)).toMatchObject({
        action_kind: "decide", next_substep: "decision-settle",
        operation_digest: archivedDecision.operation_digest,
      });
    }
  });

  it("authenticates replay from complete transition identity, never an afop prefix alone", () => {
    const operation = digest("a");
    const intent = semanticSubstepIntentId(operation, "begin-work");
    const durable = { ...state("produce", "running"), last_transition: {
      schema_version: "1" as const, tool: "archflow_state" as const, operation: "record-running", intent_id: intent,
      request_digest: digest("b"), input_fingerprint: digest("2"), result_id: "result-1" as never,
      outcome: { ok: true }, outcome_digest: digest("c"), prior_revision: 6 as never, resulting_revision: 7 as never,
    } } as unknown as TaskStateV1;
    expect(authenticateSemanticLastTransition(durable, operation, "begin-work", { tool: "archflow_state", operation: "record-running", input_fingerprint: digest("2"), request_digest: digest("b") })).toBe(true);
    expect(authenticateSemanticLastTransition(durable, operation, "begin-work", { tool: "archflow_state", operation: "record-running", input_fingerprint: digest("3") })).toBe(false);
    expect(authenticateSemanticLastTransition(durable, operation, "begin-work", { tool: "archflow_state", operation: "wrong", input_fingerprint: digest("2") })).toBe(false);
  });

  it("executes exactly one fixed substep and never consumes the later review substeps", async () => {
    const current = snapshot(state("produce", "succeeded"), {
      code: "run-step", detail: "Run review.", human_required: false, phase_instance: "phase-impl-1" as TaskStateV1["phase_instance"], step: "counter_review",
    });
    const plan = apply(current, invocation);
    let composeCalls = 0;
    let executeCalls = 0;
    const services = {} as ProductionServices;
    const result = await executeSemanticActionSubstep(services, plan, {
      compose_request: async (_services, facts) => {
        composeCalls += 1;
        return { schema_version: "1", ok: true, value: { envelope: {} as never, intent_id: (facts as { intent_id: never }).intent_id } };
      },
      execute_composed_request: async (_composed, executedPlan) => {
        executeCalls += 1;
        return { executed: executedPlan.next_substep };
      },
    });
    expect(composeCalls).toBe(1);
    expect(executeCalls).toBe(1);
    expect(result.substep).toBe("review-enter");
    expect(plan.substeps).toEqual(["review-enter", "review-run", "review-empty-triage"]);
  });

  it("stages exact initialization ask bytes before composing revision zero", async () => {
    const missingStatus = {
      task_id: "api-refactor", state: "missing", blocking_reasons: [], config: { verified: true },
      next_action: { code: "create-task", detail: "Create task.", human_required: false },
    } as unknown as TaskStatusV1;
    const missing: SemanticStatusSnapshotV1 = { schema_version: "1", repository_identity_digest: digest("1"), status: missingStatus as unknown as SemanticStatusSnapshotV1["status"], full_findings: [], reopen_impacts: [] };
    const owner: WorkflowInvocationV1 = { skill: "archflow-prd", intent: "resume" };
    const plan = apply(missing, owner, { kind: "task-ask", text: " exact ask\n" });
    const order: string[] = [];
    const services = { runner: { location: { worktreeRoot: "/repo" } }, authority: { task_id: "api-refactor" } } as unknown as ProductionServices;
    await executeSemanticActionSubstep(services, plan, {
      stage_task_ask: async (input) => {
        order.push(`stage:${input.text}`);
        return { schema_version: "1", ok: true, value: { path: ".archflow/tasks/api-refactor/ask.md" as never, byte_count: 11, digest: digest("a") } };
      },
      compose_request: async (_services, facts) => {
        order.push(`compose:${(facts as { kind: string }).kind}`);
        return { schema_version: "1", ok: true, value: { envelope: {} as never, intent_id: (facts as { intent_id: never }).intent_id } };
      },
      execute_composed_request: async () => {
        order.push("execute:initialize-task");
        return { ok: true };
      },
    });
    expect(order).toEqual(["stage: exact ask\n", "compose:initialize", "execute:initialize-task"]);
  });

  it("keeps one operation digest across the serialized compound review and returns the fresh view", async () => {
    const initial = snapshot(state("produce", "succeeded"), {
      code: "run-step", detail: "Run review.", human_required: false, phase_instance: "phase-impl-1" as TaskStateV1["phase_instance"], step: "counter_review",
    });
    const offered = projectSemanticStatus(initial, invocation).view.next_action.offer!;
    const input = { schema_version: "1", task_id: "api-refactor", invocation, action: { offer: offered } };
    const executed: ReturnType<typeof parseSemanticSubstepIntentId>[] = [];
    const refreshed: SemanticStatusSnapshotV1[] = [];
    const withTransition = (durable: TaskStateV1, plan: ReturnType<typeof apply>, tool: "archflow_state" | "archflow_counter_review", operation: string): TaskStateV1 => ({
      ...durable,
      last_transition: {
        schema_version: "1", tool, operation: operation as never, intent_id: plan.intent_id,
        request_digest: digest("b"), input_fingerprint: durable.input_fingerprint, result_id: "result-1" as never,
        outcome: { ok: true }, outcome_digest: digest("c"), prior_revision: 6 as never, resulting_revision: 7 as never,
      },
    });
    refreshed.push(
      snapshot(state("counter_review", "running"), {
        code: "run-step", detail: "Run review.", human_required: false, phase_instance: "phase-impl-1" as never, step: "counter_review",
      }),
      snapshot(state("counter_review", "succeeded"), {
        code: "run-step", detail: "Empty triage.", human_required: false, phase_instance: "phase-impl-1" as never, step: "triage",
      }),
      snapshot(state("triage", "running"), {
        code: "run-step", detail: "Finish empty triage.", human_required: false, phase_instance: "phase-impl-1" as never, step: "triage",
      }),
      snapshot(state("triage", "succeeded"), {
        code: "open-gate", detail: "Approval.", human_required: true, phase_instance: "phase-impl-1" as never, gate_kind: "commit-authorization",
      }),
    );
    const services = {} as ProductionServices;
    let refreshIndex = 0;
    const viewPromise = executeSemanticAction(services, initial, input, {
      compose_request: async (_services, facts) => ({ schema_version: "1", ok: true, value: { envelope: {} as never, intent_id: (facts as { intent_id: never }).intent_id } }),
      execute_composed_request: async (_composed, plan) => {
        executed.push(parseSemanticSubstepIntentId(plan.intent_id));
        if (plan.next_substep === "review-enter") {
          refreshed[0] = snapshot(withTransition(state("counter_review", "running"), plan, "archflow_state", "record-state-boundary"), {
            code: "run-step", detail: "Run review.", human_required: false, phase_instance: "phase-impl-1" as never, step: "counter_review",
          });
        } else if (plan.next_substep === "triage-enter") {
          refreshed[2] = snapshot(withTransition(state("triage", "running"), plan, "archflow_state", "record-state-boundary"), {
            code: "run-step", detail: "Finish empty triage.", human_required: false, phase_instance: "phase-impl-1" as never, step: "triage",
          });
        } else if (plan.next_substep === "review-empty-triage") {
          refreshed[3] = snapshot(withTransition(state("triage", "succeeded"), plan, "archflow_state", "record-triage"), {
            code: "open-gate", detail: "Approval.", human_required: true, phase_instance: "phase-impl-1" as never, gate_kind: "commit-authorization",
          });
        }
        return { ok: true };
      },
      run_counter_review: async (plan) => {
        executed.push(parseSemanticSubstepIntentId(plan.intent_id));
        refreshed[1] = snapshot(withTransition(state("counter_review", "succeeded"), plan, "archflow_counter_review", "counter-review"), {
          code: "run-step", detail: "Empty triage.", human_required: false, phase_instance: "phase-impl-1" as never, step: "triage",
        });
        return { ok: true };
      },
      refresh_snapshot: async () => refreshed[refreshIndex++]!,
    });
    const view = await viewPromise;
    expect(executed.map((identity) => identity.substep)).toEqual(["review-enter", "review-run", "triage-enter", "review-empty-triage"]);
    expect(new Set(executed.map((identity) => identity.operation_digest))).toHaveLength(1);
    expect(view.next_action.kind).toBe("decide");
    expect(refreshIndex).toBe(4);
  });

  it("recovers the original review operation digest on a fresh continuation offer", () => {
    const pending = snapshot(state("produce", "succeeded"), {
      code: "run-step", detail: "Run review.", human_required: false, phase_instance: "phase-impl-1" as never, step: "counter_review",
    });
    const originalOffer = projectSemanticStatus(pending, invocation).view.next_action.offer!;
    const originalInput = { schema_version: "1", task_id: "api-refactor", invocation, action: { offer: originalOffer } };
    const original = planSemanticAction(pending, originalInput);
    const runningBase = { ...state("counter_review", "running"), revision: 8 as TaskStateV1["revision"], input_fingerprint: digest("7") };
    const runningState = { ...runningBase, last_transition: {
      schema_version: "1", tool: "archflow_state", operation: "record-state-boundary", intent_id: semanticSubstepIntentId(original.operation_digest, "review-enter"),
      request_digest: digest("b"), input_fingerprint: digest("7"), result_id: "result-1", outcome: { ok: true }, outcome_digest: digest("c"), prior_revision: 7, resulting_revision: 8,
    } } as unknown as TaskStateV1;
    const running = snapshot(runningState, {
      code: "run-step", detail: "Continue review.", human_required: false, phase_instance: runningState.phase_instance, step: "counter_review",
    });
    const fresh = apply(running, invocation);
    const old = planSemanticAction(running, originalInput);
    expect(fresh.operation_digest).toBe(original.operation_digest);
    expect(fresh.operation_key).toBeUndefined();
    expect(parseSemanticSubstepIntentId(fresh.intent_id)).toEqual({ operation_digest: original.operation_digest, substep: "review-run" });
    expect(old.operation_digest).toBe(original.operation_digest);
    expect(old.operation_key).toBeDefined();
    expect(old.intent_id).toBe(fresh.intent_id);
  });

  it("accepts only the exact old triage call after its authenticated entry boundary", () => {
    const finding = { finding_id: "finding-1", severity: "major" as const, blocking: false, summary: "Issue", evidence: "Evidence", suggested_resolution: "Fix" };
    const before = snapshot(state("counter_review", "succeeded"), {
      code: "run-step", detail: "Triage.", human_required: false, phase_instance: "phase-impl-1" as never, step: "triage",
    }, { full_findings: [finding] });
    const submission = { kind: "triage" as const, dispositions: [{ finding_id: "finding-1", disposition: "rejected" as const, rationale: "Not material.", evidence: "Current behavior." }] };
    const originalOffer = projectSemanticStatus(before, invocation).view.next_action.offer!;
    const originalInput = { schema_version: "1", task_id: "api-refactor", invocation, action: { offer: originalOffer, submission } } as const;
    const original = planSemanticAction(before, originalInput);
    const enteredBase = { ...state("triage", "running"), revision: 8 as never, input_fingerprint: digest("7") };
    const enteredState = { ...enteredBase, last_transition: {
      schema_version: "1", tool: "archflow_state", operation: "record-state-boundary",
      intent_id: semanticSubstepIntentId(original.operation_digest, "triage-enter"), request_digest: digest("b"),
      input_fingerprint: enteredBase.input_fingerprint, result_id: "result-1", outcome: { ok: true }, outcome_digest: digest("c"),
      prior_revision: 7, resulting_revision: 8,
    } } as unknown as TaskStateV1;
    const entered = snapshot(enteredState, {
      code: "run-step", detail: "Triage.", human_required: false, phase_instance: enteredState.phase_instance, step: "triage",
    }, { full_findings: [finding] });
    expect(planSemanticAction(entered, originalInput)).toMatchObject({
      action_kind: "triage", operation_digest: original.operation_digest, next_substep: "triage",
    });
    expect(() => planSemanticAction(entered, { ...originalInput, action: { ...originalInput.action, offer: `af1_${"f".repeat(64)}` } }))
      .toThrowError(expect.objectContaining({ code: "SEMANTIC_OFFER_STALE" }));
  });

  it("replays an exact old revise-enter call from its authenticated durable boundary", async () => {
    const beforeState = { ...state("triage", "succeeded"), attempt: 2 as never };
    const before = snapshot(beforeState, {
      code: "run-step", detail: "Revise.", human_required: false, phase_instance: beforeState.phase_instance, step: "produce",
    });
    const originalOffer = projectSemanticStatus(before, invocation).view.next_action.offer!;
    const originalInput = { schema_version: "1", task_id: "api-refactor", invocation, action: { offer: originalOffer } } as const;
    const original = planSemanticAction(before, originalInput);
    const enteredBase = { ...state("produce", "running"), revision: 8 as never, attempt: 2 as never, input_fingerprint: digest("7") };
    const enteredState = { ...enteredBase, last_transition: {
      schema_version: "1", tool: "archflow_gate", operation: "semantic-revision-enter", intent_id: original.intent_id,
      request_digest: digest("b"), input_fingerprint: enteredBase.input_fingerprint, result_id: "gate-1",
      outcome: { ok: true, predecessor_attempt: 2 }, outcome_digest: digest("c"), prior_revision: 7, resulting_revision: 8,
    } } as unknown as TaskStateV1;
    const entered = snapshot(enteredState, {
      code: "run-step", detail: "Submit revision.", human_required: false, phase_instance: enteredState.phase_instance, step: "produce",
    });
    const replay = planSemanticAction(entered, originalInput);
    expect(replay).toMatchObject({ action_kind: "revise", operation_digest: original.operation_digest, revision_checkpoint: true });
    let replayed = 0;
    const view = await executeSemanticAction({} as ProductionServices, entered, originalInput, {
      enter_revision_checkpoint: async () => { replayed += 1; return { ok: true }; },
      refresh_snapshot: async () => entered,
    });
    expect(replayed).toBe(1);
    expect(view.next_action.kind).toBe("submit-work");

    const stateEntered = { ...enteredState, attempt: 3 as never, last_transition: {
      ...enteredState.last_transition!, tool: "archflow_state", operation: "record-state-boundary", outcome: { revision: 8 },
    } } as unknown as TaskStateV1;
    const stateReplay = planSemanticAction(snapshot(stateEntered, {
      code: "run-step", detail: "Submit revision.", human_required: false, phase_instance: stateEntered.phase_instance, step: "produce",
    }), originalInput);
    expect(stateReplay).toMatchObject({ action_kind: "revise", operation_digest: original.operation_digest });
    expect(stateReplay.revision_checkpoint).toBeUndefined();

    const retryOnceEntered = { ...enteredState, attempt: 3 as never, last_transition: {
      ...enteredState.last_transition!, outcome: { ok: true, predecessor_attempt: 2 },
    } } as unknown as TaskStateV1;
    const retryOnceReplay = planSemanticAction(snapshot(retryOnceEntered, {
      code: "run-step", detail: "Submit retry.", human_required: false, phase_instance: retryOnceEntered.phase_instance, step: "produce",
    }), originalInput);
    expect(retryOnceReplay).toMatchObject({
      action_kind: "revise", operation_digest: original.operation_digest, revision_checkpoint: true,
      operation_key: { attempt: 2 },
    });
  });

  it("consumes a closed revision checkpoint only through the explicit authenticated capability", async () => {
    const durable = state("triage", "succeeded");
    const current = snapshot(durable, {
      code: "run-step", detail: "Enter revision.", human_required: false, phase_instance: durable.phase_instance, step: "produce",
    }, { revision_checkpoint: { status: "valid" } });
    const offer = projectSemanticStatus(current, invocation).view.next_action.offer!;
    const input = { schema_version: "1", task_id: "api-refactor", invocation, action: { offer } };
    const refreshed = snapshot(state("produce", "running"), {
      code: "run-step", detail: "Submit revision.", human_required: false, phase_instance: durable.phase_instance, step: "produce",
    });
    let entered = 0;
    const view = await executeSemanticAction({} as ProductionServices, current, input, {
      enter_revision_checkpoint: async () => { entered += 1; return { ok: true }; },
      refresh_snapshot: async () => refreshed,
    });
    expect(entered).toBe(1);
    expect(view.next_action.kind).toBe("submit-work");
    await expect(executeSemanticAction({} as ProductionServices, current, input, {
      refresh_snapshot: async () => refreshed,
    })).rejects.toMatchObject({ code: "SEMANTIC_ACTION_UNSUPPORTED" });
  });

  it("archives, refreshes services, and settles one human decision without consuming a later action", async () => {
    const durable = state("triage", "succeeded");
    const open = snapshot(durable, {
      code: "resolve-open-gate", detail: "Choose.", human_required: true, phase_instance: durable.phase_instance,
      gate_id: "gate-1" as never, gate_kind: "artifact-approval",
    });
    (open.status as unknown as Record<string, unknown>).open_gate = {
      presentation: { title: "Approve", summary: "Summary", question: "Choose?", options: [{ token: "approve", label: "Approve", consequence: "Advances" }] },
    };
    const offer = projectSemanticStatus(open, invocation).view.next_action.offer!;
    const input = { schema_version: "1", task_id: "api-refactor", invocation, action: {
      offer, submission: { kind: "decision", choice: "approve", reason: "Approved." },
    } } as const;
    const operation = planSemanticAction(open, input).operation_digest;
    const archived: SemanticStatusSnapshotV1 = {
      ...open, archived_decision: { status: "exact", operation_digest: operation },
    };
    const done = snapshot(durable, { code: "task-complete", detail: "Done.", human_required: false });
    const serviceA = { authority: { task_id: "api-refactor" } } as unknown as ProductionServices;
    const serviceB = { authority: { task_id: "api-refactor" } } as unknown as ProductionServices;
    const order: string[] = [];
    let refresh = 0;
    const view = await executeSemanticAction(serviceA, open, input, {
      archive_decision: async (plan) => { order.push(`archive:${plan.decision_submission?.choice}`); return { schema_version: "1", ok: true, value: {} }; },
      settle_decision: async (plan) => { order.push(`settle:${plan.next_substep}`); return { schema_version: "1", ok: true, value: {} }; },
      refresh_services: async () => ++refresh === 1
        ? { services: serviceB, snapshot: archived }
        : { services: serviceB, snapshot: done },
    });
    expect(order).toEqual(["archive:approve", "settle:decision-settle"]);
    expect(refresh).toBe(2);
    expect(view.next_action.kind).toBe("none");
  });

  it("propagates a failed lower-level project result before projecting success", async () => {
    const current = snapshot(state("produce", "failed"), {
      code: "run-step", detail: "Retry produce.", human_required: false, phase_instance: "phase-design-1" as never, step: "produce",
    });
    const offer = projectSemanticStatus(current, invocation).view.next_action.offer!;
    let refreshes = 0;
    await expect(executeSemanticAction({} as ProductionServices, current, {
      schema_version: "1", task_id: "api-refactor", invocation, action: { offer },
    }, {
      compose_request: async (_services, facts) => ({ schema_version: "1", ok: true, value: { envelope: {} as never, intent_id: (facts as { intent_id: never }).intent_id } }),
      execute_composed_request: async () => ({ schema_version: "1", ok: false, error: { schema_version: "1", code: "IO_ERROR", diagnostic: { schema_version: "1", parameters: { operation: "test", attempt: 1 } } } }),
      refresh_snapshot: async () => { refreshes += 1; return current; },
    })).rejects.toBeInstanceOf(SemanticActionExecutionError);
    expect(refreshes).toBe(0);
  });
});

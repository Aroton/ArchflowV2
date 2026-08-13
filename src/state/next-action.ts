import type { TaskStateV1 } from "../contracts/durable-state.js";
import type { GateKind } from "../contracts/gates.js";
import type { PathSafeId, Sha256Digest } from "../contracts/evidence.js";
import { decodePhaseInstance, type PhaseInstanceId } from "../contracts/phase-instance.js";
import type { PlainJsonValue } from "../contracts/plain-json.js";
import type { ToolName } from "../contracts/tool-names.js";
import { WORKFLOW_V1 } from "../contracts/workflow.js";
import type { PipelineStep } from "../contracts/vocabulary.js";
import type { EvidenceAssessment } from "../review/fixed-point.js";
import type { ReconciliationFinding } from "./reconciliation.js";

export type NextActionCode =
  | "initialize-repository"
  | "create-task"
  | "resume-exact-intent"
  | "restore-or-record-new-transition"
  | "inspect-retained-receipt"
  | "create-fresh-intent"
  | "resolve-current-authority"
  | "restore-pinned-config"
  | "open-gate"
  | "resolve-open-gate"
  | "run-step"
  | "commit-phase"
  | "advance-phase"
  | "complete-task"
  | "task-complete"
  | "inspect-state";

/**
 * A mechanically complete request for the named tool, in the one canonical request shape:
 * `{tool, input}` is byte-acceptable `archflow-local envelope` stdin, and `input` is the tool
 * call's argument object. Placeholder prose marks every field the agent or human must author;
 * all other fields are prefilled from authenticated status facts.
 */
export type NextActionRequest = Readonly<{
  tool: ToolName;
  input: PlainJsonValue;
}>;

export type NextAction = Readonly<{
  code: NextActionCode;
  detail: string;
  human_required: boolean;
  phase_instance?: PhaseInstanceId;
  step?: PipelineStep;
  skill?: string;
  gate_id?: PathSafeId;
  gate_kind?: GateKind;
  /**
   * Every constitution gate this review still demands, in the order they will open, including the
   * one named by `gate_kind`. Present only when more than one remains, so a human can be told the
   * total cost of the review before answering the first. Disclosure only: each gate is still
   * opened and decided separately.
   */
  pending_gate_kinds?: readonly GateKind[];
  /** Set on the produce run-step routed by `editorial_revision_required`: the produce re-entry applies exactly the accepted editorial revision intents and preserves review evidence. */
  editorial_revision?: boolean;
  request?: NextActionRequest;
  guidance?: string;
}>;

export type AuthenticatedApprovalFact = Readonly<{
  gate_kind: GateKind;
  subject_digest: Sha256Digest;
}>;

export type NextActionInput = Readonly<{
  repository_initialized: boolean;
  state?: TaskStateV1;
  config_verified?: boolean;
  reconciliation_findings?: readonly ReconciliationFinding[];
  reconciliation_blocking_reasons?: readonly string[];
  assessment?: EvidenceAssessment;
  evidence_available?: boolean;
  subject_digest?: Sha256Digest;
  authenticated_approvals?: readonly AuthenticatedApprovalFact[];
  commit_observed?: boolean;
  adjudication_gate_kind?: GateKind;
  /** Every constitution gate still pending, in the order they open; the first is `adjudication_gate_kind`. */
  pending_adjudication_gate_kinds?: readonly GateKind[];
}>;

function action(
  code: NextActionCode,
  detail: string,
  humanRequired: boolean,
  state?: TaskStateV1,
  extra: Partial<NextAction> = {},
): NextAction {
  if (state === undefined) return Object.freeze({ code, detail, human_required: humanRequired, ...extra });
  const kind = decodePhaseInstance(state.phase_instance).kind;
  const skill = WORKFLOW_V1.phases.find((phase) => phase.id === kind)?.skill;
  return Object.freeze({
    code,
    detail,
    human_required: humanRequired,
    phase_instance: state.phase_instance,
    ...(skill === undefined ? {} : { skill }),
    ...extra,
  });
}

/**
 * Names the actual remaining work for a run-step action: a step already running needs its
 * terminal result recorded, a failed step needs a retry entry, anything else needs its
 * running entry. The recorded entry write is part of "running" the step, so the mid-step
 * state must never be described as if the step had not started.
 */
function runStepDetail(state: TaskStateV1, step: PipelineStep): string {
  if (state.step === step && state.status === "running") return `Record the terminal ${step} result.`;
  if (state.step === step && state.status === "failed") return `Retry the ${step} pipeline step.`;
  return `Run the ${step} pipeline step.`;
}

function matchingApproval(input: NextActionInput, kind: GateKind): boolean {
  return input.subject_digest !== undefined &&
    (input.authenticated_approvals ?? []).some((approval) =>
      approval.gate_kind === kind && approval.subject_digest === input.subject_digest);
}

function advanceAction(input: NextActionInput, state: TaskStateV1): NextAction {
  const phase = decodePhaseInstance(state.phase_instance);
  const requiredKind = phase.kind === "prd" || phase.kind === "design" || phase.kind === "phase-design"
    ? "artifact-approval"
    : phase.kind === "phase-impl"
      ? "commit-authorization"
      : undefined;
  if (requiredKind !== undefined && !matchingApproval(input, requiredKind)) {
    return action("open-gate", `Open the required ${requiredKind} gate.`, true, state, {
      gate_kind: requiredKind,
    });
  }
  if (phase.kind === "phase-impl" && input.commit_observed !== true) {
    return action(
      "commit-phase",
      "Stage the authorized phase outputs, show and confirm the commit, then commit them to the approved current target ref.",
      true,
      state,
    );
  }
  if (
    phase.kind === "phase-impl" &&
    state.planned_final_phase !== undefined &&
    Number(phase.phase) === Number(state.planned_final_phase)
  ) {
    return action("complete-task", "Record that the final planned implementation phase is committed.", false, state);
  }
  return action("advance-phase", "Advance to the next phase in the fixed workflow.", false, state);
}

/** Derives exactly one legal next action from already-authenticated status facts. Pure and I/O-free. */
export function deriveNextAction(input: NextActionInput): NextAction {
  const state = input.state;
  if (state === undefined) {
    return input.repository_initialized
      ? action("create-task", "Create durable state for this task.", false)
      : action("initialize-repository", "Initialize ArchFlow in this repository.", false);
  }
  if (input.config_verified !== true) {
    return action(
      "restore-pinned-config",
      "Restore the task's digest-pinned configuration before continuing; an intentional configuration change requires a new task or the explicit upgrade flow.",
      true,
      state,
    );
  }
  const finding = input.reconciliation_findings?.[0];
  if (finding !== undefined) {
    return action(finding.next_action, `Resolve reconciliation finding ${finding.kind}.`, true, state);
  }
  const discoveryBlocker = input.reconciliation_blocking_reasons?.[0];
  if (discoveryBlocker !== undefined) {
    return discoveryBlocker === "retained-receipt-ambiguity"
      ? action("inspect-retained-receipt", "Inspect the ambiguous retained successor receipts.", true, state)
      : action("inspect-state", `Inspect reconciliation discovery blocker ${discoveryBlocker}.`, true, state);
  }
  if (state.terminal !== undefined) {
    return action(
      "task-complete",
      state.terminal === "complete"
        ? "The final planned implementation phase is committed."
        : `Task is terminal: ${state.terminal}.`,
      false,
      state,
    );
  }
  if (state.open_gate !== undefined) {
    return action("resolve-open-gate", "Resolve the currently open human gate.", true, state, {
      gate_id: state.open_gate.gate_id,
      gate_kind: state.open_gate.gate_kind,
    });
  }
  const currentProduce = state.authoritative_results.some((reference) =>
    reference.phase_instance === state.phase_instance && reference.step === "produce");
  if (!currentProduce) {
    return action("run-step", runStepDetail(state, "produce"), false, state, { step: "produce" });
  }
  // Mid-produce (running or failed) the only legal move is finishing produce. This covers every
  // produce re-entry once its running entry is recorded — accepted findings, editorial revision,
  // or the author-initiated new-information door: prior-cycle evidence is still retained but
  // must not re-route the next action while the artifact is being rewritten.
  if (state.step === "produce" && state.status !== "succeeded") {
    return action("run-step", runStepDetail(state, "produce"), false, state, { step: "produce" });
  }
  const next = input.assessment?.next;
  if (next !== undefined) {
    if (next === "advance") return advanceAction(input, state);
    if (next === "attempts-exhausted") {
      return action("open-gate", "Open the attempts-exhausted gate.", true, state, { gate_kind: "attempts-exhausted" });
    }
    if (next === "adjudication-gate") {
      if (input.adjudication_gate_kind === undefined) {
        return action("inspect-state", "Inspect the unresolved adjudication gate obligation.", true, state);
      }
      const pending = input.pending_adjudication_gate_kinds ?? [];
      const remaining = pending.length > 1
        ? ` This review requires ${pending.length} separate human decisions; the rest open in turn: ${pending.slice(1).join(", ")}.`
        : "";
      return action("open-gate", `Open the required ${input.adjudication_gate_kind} gate.${remaining}`, true, state, {
        gate_kind: input.adjudication_gate_kind,
        ...(pending.length > 1 ? { pending_gate_kinds: Object.freeze([...pending]) } : {}),
      });
    }
    if (next === "produce" && input.assessment?.editorial_revision_required === true) {
      return action(
        "run-step",
        "Apply exactly the accepted editorial revision intents to the artifact, then run the produce step; nothing is re-run — the retained reviews and constitution verdict stay bound to the declared predecessor.",
        false,
        state,
        { step: "produce", editorial_revision: true },
      );
    }
    return action("run-step", runStepDetail(state, next), false, state, { step: next });
  }
  return input.evidence_available === false
    ? action("inspect-state", "Inspect why current evidence is unavailable.", true, state)
    : action("run-step", runStepDetail(state, state.step), false, state, { step: state.step });
}

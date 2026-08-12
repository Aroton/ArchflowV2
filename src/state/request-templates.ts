import type { TaskStateV1 } from "../contracts/durable-state.js";
import type { Sha256Digest, TaskSlug } from "../contracts/evidence.js";
import { decodePhaseInstance } from "../contracts/phase-instance.js";
import type { PlainJsonValue } from "../contracts/plain-json.js";
import type { ToolName } from "../contracts/tool-names.js";
import type { CurrentEvidenceSetRef } from "../contracts/trust.js";
import type { PipelineStep } from "../contracts/vocabulary.js";
import type { AdjudicationGateRequest } from "../review/adjudication.js";
import type { NextAction, NextActionRequest } from "./next-action.js";
import { phaseReviewPaths, type PhaseReviewPaths } from "./phase-documents.js";
import type { CommitAuthorizationInput } from "./status.js";
import { legalRunStepStatus } from "./transitions.js";

// Placeholder prose deliberately fails the target field's ingress validation wherever the
// contract allows it (intent ids reject spaces and artifacts reject strings), so a
// template submitted unedited fails closed. Judgment fields the agent or human must author are
// only ever placeholders; mechanical fields arrive prefilled.
const TEMPLATE_INTENT_ID = "Choose a fresh intent id for this request.";
const TEMPLATE_INITIALIZATION_ARTIFACT = "Replace with the task-initialization artifact; archflow-local build-request (kind \"initialize\") composes this entire request already completed and fingerprint-resolved — pass its request.input verbatim.";
const TEMPLATE_SUMMARY = "Summarize the gate subject for the human reviewer.";

// A syntactically valid, deliberately all-zero digest. It parses, so `archflow-local envelope`
// can process the completed template and substitute the real fingerprint, yet it can never match
// a computed fingerprint, so a call that skips envelope still fails closed at the server. Gate
// and waiver templates are the exception: their fingerprint authority is the durable state value
// itself, which is prefilled verbatim instead.
const TEMPLATE_FINGERPRINT_SENTINEL = "0".repeat(64);

const TERMINAL_ARTIFACT_PLACEHOLDERS: Partial<Record<PipelineStep, string>> = {
  produce: "Replace with the complete document or implementation-output artifact; archflow-local build-request emits this entire request already completed and fingerprint-resolved.",
  triage: "Replace with the complete triage artifact; archflow-local build-request (kind \"triage\") composes this entire request from the dispositions alone.",
};

export type NextActionRequestFacts = Readonly<{
  task_id: TaskSlug;
  state?: TaskStateV1;
  subject_digest?: Sha256Digest;
  current_evidence?: CurrentEvidenceSetRef;
  commit_authorization?: CommitAuthorizationInput;
  /**
   * The pending constitution-review gate, derived mechanically from retained adjudication
   * evidence by the same selector the fixed point uses; only the summary is authored.
   */
  adjudication_gate?: AdjudicationGateRequest;
  /** The resolved attempt ceiling, needed to prefill the attempts-exhausted gate context. */
  maximum_attempts?: number;
}>;

function deepFreeze<T>(value: T): T {
  if (value !== null && typeof value === "object" && !Object.isFrozen(value)) {
    for (const nested of Object.values(value)) deepFreeze(nested);
    Object.freeze(value);
  }
  return value;
}

export type BuiltNextActionRequest = Readonly<{
  request: NextActionRequest;
  guidance: string;
}>;

function request(tool: ToolName, input: PlainJsonValue, guidance: string): BuiltNextActionRequest {
  return deepFreeze({ request: { tool, input }, guidance });
}

function envelopeGuidance(taskId: TaskSlug, tool: ToolName, detail: string): string {
  return `${detail} Fill every placeholder field, then pipe the completed request as {"tool":"${tool}","input":<request>} to archflow-local envelope --task ${taskId}; it resolves the fingerprint internally, so call ${tool} with the returned request.input verbatim — the envelope output, not this template, is the fingerprint authority.`;
}

function mechanicalPrefix(
  taskId: TaskSlug,
  state: TaskStateV1,
  fingerprint: string = TEMPLATE_FINGERPRINT_SENTINEL,
): Record<string, PlainJsonValue> {
  return {
    schema_version: "1",
    task_id: taskId,
    intent_id: TEMPLATE_INTENT_ID,
    expected_revision: state.revision,
    input_fingerprint: fingerprint,
  };
}

function reviewPaths(state: TaskStateV1): PhaseReviewPaths {
  return phaseReviewPaths(state.phase_instance);
}

export const APPROVAL_ARTIFACT_KINDS = {
  "prd": "prd",
  "design": "design",
  "phase-design": "phase-design",
  "phase-impl": "phase-implementation",
} as const;

/**
 * Builds the mechanically complete request for a next action whose tool call is derivable from
 * already-authenticated status facts. Judgment content is never drafted here: artifact bodies,
 * review findings, triage dispositions, and gate decisions stay agent- or human-authored.
 */
export function buildNextActionRequest(next: NextAction, facts: NextActionRequestFacts): BuiltNextActionRequest | undefined {
  if (next.code === "create-task") {
    return request("archflow_state", {
      schema_version: "1",
      task_id: facts.task_id,
      intent_id: "initialize-task",
      expected_revision: 0,
      input_fingerprint: TEMPLATE_FINGERPRINT_SENTINEL,
      phase_instance: "prd",
      step: "produce",
      status: "running",
      artifact: TEMPLATE_INITIALIZATION_ARTIFACT,
    }, `Pipe {"intent_id":"initialize-task","kind":"initialize"} to archflow-local build-request --task ${facts.task_id}; it returns this entire request already completed and fingerprint-resolved. Call archflow_state with the returned request.input verbatim as typed JSON — artifact is a JSON object and expected_revision is the number 0, never strings. Initialize is the one request kind whose build-request output carries no staged reference; the server accepts no entry point other than prd/produce/running at expected_revision 0.`);
  }
  const state = facts.state;
  if (state === undefined) return undefined;

  if (next.code === "run-step") {
    const step = next.step ?? state.step;
    // The target status comes from the same movement rules the server enforces; when no legal
    // run-step transition exists from this state, no template is emitted at all. A template that
    // looks authoritative but cannot execute is worse than an absent one.
    const target = legalRunStepStatus(state, step);
    if (target === undefined) return undefined;
    if (target === "succeeded") {
      // Mid-step: the remaining call records this step's terminal result. Counter-review records
      // its own terminal state through its dedicated tool — and runs the constitution review
      // itself when the pinned constitution has active rules.
      if (step === "counter_review") {
        return request("archflow_counter_review", {
          ...mechanicalPrefix(facts.task_id, state),
          artifact_path: reviewPaths(state).artifact_path,
        }, envelopeGuidance(
          facts.task_id,
          "archflow_counter_review",
          "The server selects the phase's canonical rubric and also runs the constitution review inside this call when the pinned constitution has active rules; the result reports both verdicts.",
        ));
      }
      return request("archflow_state", {
        ...mechanicalPrefix(facts.task_id, state),
        phase_instance: state.phase_instance,
        step,
        status: "succeeded",
        artifact: TERMINAL_ARTIFACT_PLACEHOLDERS[step] ?? "Replace with the step's complete artifact.",
      }, envelopeGuidance(
        facts.task_id,
        "archflow_state",
        `This records the terminal ${step} result and carries the step artifact; record status "failed" without an artifact instead if the work did not succeed.`,
      ));
    }
    return request("archflow_state", {
      ...mechanicalPrefix(facts.task_id, state),
      phase_instance: state.phase_instance,
      step,
      status: "running",
    }, envelopeGuidance(
      facts.task_id,
      "archflow_state",
      next.editorial_revision === true && step === "produce"
        ? "This is the running entry for the editorial produce re-entry: apply exactly the accepted editorial revision intents to the artifact — nothing else — then record the terminal produce result with archflow-local build-request (kind \"produce\"), which attaches the editorial predecessor link from durable authority. Nothing is re-run: the retained reviews and constitution verdict stay bound to the declared predecessor for this one hop."
        : `This is the running entry for the ${step} step; the terminal write that follows the work carries the step artifact and a succeeded or failed status.`,
    ));
  }

  if (next.code === "open-gate") {
    if (next.gate_kind === "commit-authorization" && facts.commit_authorization !== undefined) {
      const authorization = facts.commit_authorization;
      return request("archflow_gate", {
        ...mechanicalPrefix(facts.task_id, state, state.input_fingerprint),
        phase_instance: state.phase_instance,
        summary: TEMPLATE_SUMMARY,
        subject_digest: authorization.subject_digest,
        current_evidence: authorization.current_evidence as unknown as PlainJsonValue,
        kind: "commit-authorization",
        context: authorization.context as unknown as PlainJsonValue,
      }, envelopeGuidance(
        facts.task_id,
        "archflow_gate",
        `Write the summary for the human reviewer. ${authorization.target_ref_guidance}`,
      ));
    }
    if (next.gate_kind === "artifact-approval" && facts.subject_digest !== undefined && facts.current_evidence !== undefined) {
      return request("archflow_gate", {
        ...mechanicalPrefix(facts.task_id, state, state.input_fingerprint),
        phase_instance: state.phase_instance,
        summary: TEMPLATE_SUMMARY,
        subject_digest: facts.subject_digest,
        current_evidence: facts.current_evidence as unknown as PlainJsonValue,
        kind: "artifact-approval",
        context: { artifact_kind: APPROVAL_ARTIFACT_KINDS[decodePhaseInstance(state.phase_instance).kind] },
      }, envelopeGuidance(
        facts.task_id,
        "archflow_gate",
        "Write the summary for the human reviewer.",
      ));
    }
    if (
      (next.gate_kind === "constitution-review" ||
        next.gate_kind === "material-drift") &&
      facts.adjudication_gate !== undefined &&
      facts.adjudication_gate.kind === next.gate_kind &&
      facts.current_evidence !== undefined
    ) {
      // The constitution-review gates open at the post-triage fixed point through this ordinary
      // gate flow. Kind, subject, and context all come from the retained adjudication evidence
      // via the same selector the fixed point uses; only the summary is authored.
      return request("archflow_gate", {
        ...mechanicalPrefix(facts.task_id, state, state.input_fingerprint),
        phase_instance: state.phase_instance,
        summary: TEMPLATE_SUMMARY,
        subject_digest: facts.adjudication_gate.subject_digest,
        current_evidence: facts.current_evidence as unknown as PlainJsonValue,
        kind: facts.adjudication_gate.kind,
        context: facts.adjudication_gate.context as unknown as PlainJsonValue,
      }, envelopeGuidance(
        facts.task_id,
        "archflow_gate",
        "Write the summary for the human reviewer: name the constitution rules that failed compliance, are uncertain, matched a review trigger, or drifted, say which of those axes each rule appears on, and report what the constitution review said about each.",
      ));
    }
    // Exhaustion is a decision point, not a failure: without a template the human's entire view
    // of it is agent-authored prose. The context is mechanical, so only the summary is authored.
    if (
      next.gate_kind === "attempts-exhausted" &&
      facts.subject_digest !== undefined &&
      facts.current_evidence !== undefined &&
      facts.maximum_attempts !== undefined
    ) {
      return request("archflow_gate", {
        ...mechanicalPrefix(facts.task_id, state, state.input_fingerprint),
        phase_instance: state.phase_instance,
        summary: TEMPLATE_SUMMARY,
        subject_digest: facts.subject_digest,
        current_evidence: facts.current_evidence as unknown as PlainJsonValue,
        kind: "attempts-exhausted",
        context: {
          step: state.step,
          attempts: state.attempt,
          maximum_attempts: facts.maximum_attempts,
        },
      }, envelopeGuidance(
        facts.task_id,
        "archflow_gate",
        "Write the summary for the human reviewer: state what the remaining findings are, what the last round changed, and why the loop reached the attempt ceiling. The human chooses retry-once, revise, or abort — say plainly whether you believe the artifact is decision-ready despite the open findings, and list them.",
      ));
    }
  }

  return undefined;
}

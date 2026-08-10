import type { TaskStateV1 } from "../contracts/durable-state.js";
import type { Sha256Digest, TaskSlug } from "../contracts/evidence.js";
import { decodePhaseInstance } from "../contracts/phase-instance.js";
import type { PlainJsonValue } from "../contracts/plain-json.js";
import type { ToolName } from "../contracts/tool-names.js";
import type { CurrentEvidenceSetRef } from "../contracts/trust.js";
import type { NextAction, NextActionRequest } from "./next-action.js";
import type { CommitAuthorizationInput } from "./status.js";

// Placeholder prose deliberately fails the target field's ingress validation wherever the
// contract allows it (intent ids reject spaces, fingerprints reject non-hex, artifacts and
// rubrics reject strings), so a template submitted unedited fails closed. Judgment fields the
// agent or human must author are only ever placeholders; mechanical fields arrive prefilled.
const TEMPLATE_INTENT_ID = "Choose a fresh intent id for this request.";
const TEMPLATE_INPUT_FINGERPRINT = "Substitute the input_fingerprint returned by archflow-local envelope.";
const TEMPLATE_INITIALIZATION_ARTIFACT = "Paste the archflow-local task-init initialization artifact unchanged.";
const TEMPLATE_RUBRIC = "Supply the skill's stable rubric verbatim.";
const TEMPLATE_SUMMARY = "Summarize the gate subject for the human reviewer.";

export type NextActionRequestFacts = Readonly<{
  task_id: TaskSlug;
  state?: TaskStateV1;
  subject_digest?: Sha256Digest;
  current_evidence?: CurrentEvidenceSetRef;
  commit_authorization?: CommitAuthorizationInput;
}>;

function deepFreeze<T>(value: T): T {
  if (value !== null && typeof value === "object" && !Object.isFrozen(value)) {
    for (const nested of Object.values(value)) deepFreeze(nested);
    Object.freeze(value);
  }
  return value;
}

function request(tool: ToolName, template: PlainJsonValue, guidance: string): NextActionRequest {
  return deepFreeze({ tool, template, guidance });
}

function envelopeGuidance(taskId: TaskSlug, tool: ToolName, detail: string): string {
  return `${detail} Fill every placeholder field, then run archflow-local envelope --task ${taskId} over the completed request and substitute the returned input_fingerprint before calling ${tool}; the envelope output, not this template, is the fingerprint authority.`;
}

function mechanicalPrefix(taskId: TaskSlug, state: TaskStateV1): Record<string, PlainJsonValue> {
  return {
    schema_version: "1",
    task_id: taskId,
    intent_id: TEMPLATE_INTENT_ID,
    expected_revision: state.revision,
    input_fingerprint: state.input_fingerprint,
  };
}

/** Canonical review-subject paths per phase kind, as published by the phase skills. */
function reviewPaths(state: TaskStateV1): Readonly<{ artifact_path: string; upstream_paths: readonly string[] }> {
  const phase = decodePhaseInstance(state.phase_instance);
  switch (phase.kind) {
    case "prd": return { artifact_path: "prd.md", upstream_paths: [] };
    case "design": return { artifact_path: "design.md", upstream_paths: ["prd.md"] };
    case "phase-design": return {
      artifact_path: `phases/${phase.phase}/design.md`,
      upstream_paths: ["design.md", "prd.md"],
    };
    case "phase-impl": return {
      artifact_path: `phases/${phase.phase}/impl-notes.md`,
      upstream_paths: [`phases/${phase.phase}/design.md`, "design.md"],
    };
  }
}

const APPROVAL_ARTIFACT_KINDS = {
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
export function buildNextActionRequest(next: NextAction, facts: NextActionRequestFacts): NextActionRequest | undefined {
  if (next.code === "create-task") {
    return request("archflow_state", {
      schema_version: "1",
      task_id: facts.task_id,
      intent_id: "initialize-task",
      expected_revision: 0,
      input_fingerprint: TEMPLATE_INPUT_FINGERPRINT,
      phase_instance: "prd",
      step: "produce",
      status: "running",
      artifact: TEMPLATE_INITIALIZATION_ARTIFACT,
    }, envelopeGuidance(
      facts.task_id,
      "archflow_state",
      "Run archflow-local task-init and replace the artifact placeholder with its returned initialization artifact unchanged; the server accepts no entry point other than prd/produce/running at expected_revision 0.",
    ));
  }
  const state = facts.state;
  if (state === undefined) return undefined;

  if (next.code === "run-step") {
    const step = next.step ?? state.step;
    if (step === "counter_review") {
      return request("archflow_counter_review", {
        ...mechanicalPrefix(facts.task_id, state),
        artifact_path: reviewPaths(state).artifact_path,
        rubric: TEMPLATE_RUBRIC,
      }, envelopeGuidance(
        facts.task_id,
        "archflow_counter_review",
        "Replace the rubric placeholder with the skill's stable rubric verbatim.",
      ));
    }
    if (step === "adjudicate") {
      const paths = reviewPaths(state);
      return request("archflow_adjudicate", {
        ...mechanicalPrefix(facts.task_id, state),
        artifact_path: paths.artifact_path,
        upstream_paths: paths.upstream_paths,
      }, envelopeGuidance(
        facts.task_id,
        "archflow_adjudicate",
        "The artifact and upstream paths are the canonical review subjects for this phase.",
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
      `This is the running entry for the ${step} step; the terminal write that follows the work carries the step artifact and a succeeded or failed status.`,
    ));
  }

  if (next.code === "open-gate") {
    if (next.gate_kind === "commit-authorization" && facts.commit_authorization !== undefined) {
      const authorization = facts.commit_authorization;
      return request("archflow_gate", {
        ...mechanicalPrefix(facts.task_id, state),
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
        ...mechanicalPrefix(facts.task_id, state),
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
  }

  return undefined;
}

import { isDeepStrictEqual } from "node:util";

import type { DurableArtifact } from "../contracts/durable.js";
import type { AuthoritativeResultRef, TaskStateV1 } from "../contracts/durable-state.js";
import { createProjectError, type ProjectResult } from "../contracts/errors.js";
import type { SafeInteger, Sha256Digest } from "../contracts/evidence.js";
import { decodePhaseInstance, encodePhaseInstance, parsePositiveSafePhaseNumber } from "../contracts/phase-instance.js";
import type { PhaseInstanceId } from "../contracts/phase-instance.js";
import { assertPlainJson } from "../contracts/plain-json.js";
import { WORKFLOW_V1 } from "../contracts/workflow.js";
import type { PipelineStep } from "../contracts/vocabulary.js";
import {
  assertAuthenticatedGateApproval,
  type AuthenticatedGateApproval,
} from "./gates.js";
import type { NextStateDraft } from "./transaction.js";

export type TransitionTarget = Readonly<{
  phase_instance: TaskStateV1["phase_instance"];
  step: PipelineStep;
  status: TaskStateV1["status"];
  attempt: SafeInteger;
  input_fingerprint: Sha256Digest;
}>;

export type TransitionPlanInput = Readonly<{
  current: TaskStateV1;
  target: TransitionTarget;
  recomputed_input_fingerprint: Sha256Digest;
  artifact?: DurableArtifact;
  result_reference?: AuthoritativeResultRef;
  completion_subject_digest?: Sha256Digest;
  authenticated_gate_approvals?: readonly AuthenticatedGateApproval[];
  commit_observed?: boolean;
  legacy_resume_phase?: PhaseInstanceId;
}>;

const ok = <T>(value: T): ProjectResult<T> => Object.freeze({ schema_version: "1", ok: true, value });

function invalid(input: TransitionPlanInput, from: string, to: string): ProjectResult<never> {
  return Object.freeze({
    schema_version: "1",
    ok: false,
    error: createProjectError("TRANSITION_INVALID", {
      phase_instance: input.target.phase_instance,
      from,
      to,
    }),
  });
}

function fingerprintFailure(expected: Sha256Digest, observed: Sha256Digest): ProjectResult<never> {
  return Object.freeze({
    schema_version: "1",
    ok: false,
    error: createProjectError("INPUT_FINGERPRINT_MISMATCH", {
      expected_digest: expected,
      observed_digest: observed,
    }),
  });
}

function phaseKind(instance: TaskStateV1["phase_instance"]): "prd" | "design" | "phase-design" | "phase-impl" {
  return decodePhaseInstance(instance).kind;
}

function pipeline(instance: TaskStateV1["phase_instance"]): readonly PipelineStep[] {
  const kind = phaseKind(instance);
  const configured = WORKFLOW_V1.phases.find((phase) => phase.id === kind);
  if (configured === undefined) throw new TypeError("phase instance is absent from the fixed workflow");
  return configured.pipeline;
}

function nextPhase(instance: TaskStateV1["phase_instance"]): TaskStateV1["phase_instance"] | undefined {
  const decoded = decodePhaseInstance(instance);
  switch (decoded.kind) {
    case "prd": return encodePhaseInstance({ kind: "design" });
    case "design": return encodePhaseInstance({ kind: "phase-design", phase: parsePositiveSafePhaseNumber(1) });
    case "phase-design": return encodePhaseInstance({ kind: "phase-impl", phase: decoded.phase });
    case "phase-impl":
      if (decoded.phase === Number.MAX_SAFE_INTEGER) return undefined;
      return encodePhaseInstance({ kind: "phase-design", phase: parsePositiveSafePhaseNumber(decoded.phase + 1) });
  }
}

function sameSubject(current: TaskStateV1, target: TransitionTarget): boolean {
  return current.phase_instance === target.phase_instance && current.step === target.step;
}

/**
 * The status a same-phase run-step request may legally target for `step` from `current`, derived
 * from the same movement rules `legalMovement` enforces: mid-step work records its terminal
 * result, a failed step re-enters running, a succeeded step hands off to its pipeline successor
 * (or back to produce from triage/adjudicate). `undefined` means no run-step request from this
 * state can legally target `step`, so no request template may honestly be emitted for it.
 */
export function legalRunStepStatus(
  current: Pick<TaskStateV1, "phase_instance" | "step" | "status" | "terminal" | "open_gate">,
  step: PipelineStep,
): "running" | "succeeded" | undefined {
  if (current.terminal !== undefined || current.open_gate !== undefined) return undefined;
  if (current.step === step) {
    if (current.status === "running") return "succeeded";
    if (current.status === "failed") return "running";
    return undefined;
  }
  if (current.status !== "succeeded") return undefined;
  if ((current.step === "triage" || current.step === "adjudicate") && step === "produce") return "running";
  const steps = pipeline(current.phase_instance);
  const index = steps.indexOf(current.step);
  return index >= 0 && steps[index + 1] === step ? "running" : undefined;
}

function hasAuthenticatedMigrationAudit(input: TransitionPlanInput): boolean {
  if (input.legacy_resume_phase === undefined || input.target.phase_instance !== input.legacy_resume_phase) return false;
  for (const authenticated of input.authenticated_gate_approvals ?? []) {
    assertAuthenticatedGateApproval(authenticated);
    if (
      authenticated.approval.gate_kind === "migration-audit" &&
      authenticated.request.kind === "migration-audit" &&
      authenticated.request.phase_instance === "design" &&
      authenticated.request.subject_digest === authenticated.approval.subject_digest &&
      authenticated.decision.envelope.payload.decision === "accept-import-audit"
    ) return true;
  }
  return false;
}

function legalMovement(input: TransitionPlanInput): boolean {
  const { current, target } = input;
  if (current.terminal !== undefined || current.open_gate !== undefined) return false;
  if (sameSubject(current, target)) {
    if (current.status === "running") {
      return target.attempt === current.attempt && (target.status === "succeeded" || target.status === "failed");
    }
    return current.status === "failed" && target.status === "running" && target.attempt === current.attempt + 1;
  }
  if (current.status !== "succeeded" || target.status !== "running") return false;
  if (
    target.phase_instance === current.phase_instance &&
    (current.step === "triage" || current.step === "adjudicate") &&
    target.step === "produce"
  ) {
    return target.attempt === current.attempt + 1;
  }
  const steps = pipeline(current.phase_instance);
  const index = steps.indexOf(current.step);
  if (index < 0) return false;
  if (index + 1 < steps.length) {
    return target.phase_instance === current.phase_instance &&
      target.step === steps[index + 1] &&
      target.attempt === current.attempt;
  }
  if (
    current.phase_instance === "design" &&
    target.step === "produce" &&
    target.attempt === 1 &&
    target.phase_instance !== nextPhase(current.phase_instance) &&
    hasAuthenticatedMigrationAudit(input)
  ) return true;
  const following = nextPhase(current.phase_instance);
  return following !== undefined &&
    target.phase_instance === following &&
    target.step === pipeline(following)[0] &&
    target.attempt === 1;
}

function artifactMatches(input: TransitionPlanInput): boolean {
  const artifact = input.artifact;
  if (artifact === undefined) {
    // Entering/retrying work and recording non-producing review boundaries need no durable
    // artifact. A successful `produce` step does: that is the artifact-producing boundary.
    return input.target.status !== "succeeded" || input.target.step !== "produce";
  }
  const artifactTaskId = artifact.artifact_kind === "review-evidence" || artifact.artifact_kind === "triage"
    ? artifact.evidence.task_id
    : artifact.task_id;
  if (artifactTaskId !== input.current.task_id) return false;
  if (artifact.artifact_kind === "task-initialization" || artifact.artifact_kind === "legacy-import-initialization") {
    // Initialization is legal only through the distinct missing-state revision-0 transaction.
    return false;
  }
  if (artifact.artifact_kind === "document" || artifact.artifact_kind === "implementation-output") {
    return artifact.phase_instance === input.target.phase_instance &&
      artifact.step === input.target.step &&
      artifact.input_fingerprint === input.recomputed_input_fingerprint;
  }
  if (artifact.artifact_kind === "review-evidence" || artifact.artifact_kind === "triage") {
    return artifact.evidence.phase_instance === input.target.phase_instance &&
      artifact.evidence.step === input.target.step &&
      artifact.evidence.input_fingerprint === input.recomputed_input_fingerprint;
  }
  if (artifact.artifact_kind === "manual-checkpoint-import") {
    return artifact.chain.some((checkpoint) => checkpoint.phase_instance === input.target.phase_instance &&
      checkpoint.step === input.target.step && checkpoint.status === input.target.status &&
      checkpoint.attempt === input.target.attempt && checkpoint.input_fingerprint === input.recomputed_input_fingerprint);
  }
  return input.target.phase_instance === input.current.phase_instance && input.target.step === input.current.step;
}

function resultReferenceMatches(input: TransitionPlanInput): boolean {
  const reference = input.result_reference;
  const sourceKind = input.artifact?.artifact_kind;
  const evidenceStep = input.target.step === "self_review" ||
    input.target.step === "counter_review" ||
    input.target.step === "triage" ||
    input.target.step === "adjudicate";
  const producing = input.target.status === "succeeded" && (
    (input.target.step === "produce" && (sourceKind === "document" || sourceKind === "implementation-output")) ||
    evidenceStep
  );
  if (!producing) return reference === undefined;
  if (reference === undefined) return false;
  return reference.phase_instance === input.target.phase_instance &&
    reference.step === input.target.step &&
    reference.input_fingerprint === input.recomputed_input_fingerprint;
}

function withResultReference(
  current: readonly AuthoritativeResultRef[],
  reference: AuthoritativeResultRef | undefined,
): readonly AuthoritativeResultRef[] {
  if (reference === undefined) return current;
  const next = current.filter((entry) =>
    entry.phase_instance !== reference.phase_instance || entry.step !== reference.step);
  next.push(reference);
  next.sort((left, right) => {
    const leftKey = `${left.phase_instance}\u0000${left.step}`;
    const rightKey = `${right.phase_instance}\u0000${right.step}`;
    return leftKey < rightKey ? -1 : leftKey > rightKey ? 1 : 0;
  });
  return Object.freeze(next);
}

function hasAuthenticatedCommittedOutput(input: TransitionPlanInput): boolean {
  const decoded = decodePhaseInstance(input.current.phase_instance);
  if (
    decoded.kind !== "phase-impl" ||
    input.current.step !== "adjudicate" ||
    input.current.status !== "succeeded" ||
    input.current.terminal !== undefined ||
    input.current.open_gate !== undefined ||
    input.completion_subject_digest === undefined ||
    input.commit_observed !== true ||
    input.artifact !== undefined ||
    input.result_reference !== undefined
  ) return false;
  for (const authenticated of input.authenticated_gate_approvals ?? []) {
    assertAuthenticatedGateApproval(authenticated);
    if (
      authenticated.approval.gate_kind === "commit-authorization" &&
      authenticated.approval.subject_digest === input.completion_subject_digest &&
      authenticated.request.kind === "commit-authorization" &&
      authenticated.request.phase_instance === input.current.phase_instance &&
      authenticated.request.subject_digest === input.completion_subject_digest
    ) return true;
  }
  return false;
}

/** Plans one fixed-workflow move. It is pure and performs no receipt or state write. */
export function planStateTransition(value: TransitionPlanInput): ProjectResult<NextStateDraft> {
  const { authenticated_gate_approvals: authenticatedApprovals, ...plainValue } = value;
  assertPlainJson(plainValue, "transition plan input");
  const input = {
    ...structuredClone(plainValue),
    ...(authenticatedApprovals === undefined ? {} : { authenticated_gate_approvals: authenticatedApprovals }),
  } as TransitionPlanInput;
  const from = `${input.current.step}-${input.current.status}`;
  const to = `${input.target.step}-${input.target.status}`;
  if (input.target.input_fingerprint !== input.recomputed_input_fingerprint) {
    return fingerprintFailure(input.recomputed_input_fingerprint, input.target.input_fingerprint);
  }
  const committedOutput = hasAuthenticatedCommittedOutput(input);
  const decodedCurrent = decodePhaseInstance(input.current.phase_instance);
  const completesFinalPhase = committedOutput &&
    decodedCurrent.kind === "phase-impl" &&
    input.current.planned_final_phase !== undefined &&
    Number(decodedCurrent.phase) === Number(input.current.planned_final_phase) &&
    input.target.phase_instance === input.current.phase_instance &&
    input.target.step === input.current.step &&
    input.target.status === input.current.status &&
    input.target.attempt === input.current.attempt &&
    input.target.input_fingerprint === input.current.input_fingerprint;
  if (completesFinalPhase) {
    const { revision: _revision, committed_intent: _intent, ...preserved } = input.current;
    return ok(Object.freeze({ ...preserved, terminal: "complete" }));
  }
  if (
    decodedCurrent.kind === "phase-impl" &&
    input.current.step === "adjudicate" &&
    input.current.status === "succeeded" &&
    input.target.phase_instance !== input.current.phase_instance &&
    !committedOutput
  ) return invalid(input, from, to);
  if (!legalMovement(input) || !artifactMatches(input) || !resultReferenceMatches(input)) {
    return invalid(input, from, to);
  }

  const { revision: _revision, committed_intent: _intent, ...preserved } = input.current;
  const draft: NextStateDraft = Object.freeze({
    ...preserved,
    phase_instance: input.target.phase_instance,
    step: input.target.step,
    status: input.target.status,
    attempt: input.target.attempt,
    input_fingerprint: input.target.input_fingerprint,
    authoritative_results: withResultReference(preserved.authoritative_results, input.result_reference),
  });
  if (input.result_reference === undefined && !isDeepStrictEqual(draft.authoritative_results, input.current.authoritative_results)) {
    throw new TypeError("transition planning changed authoritative results");
  }
  return ok(draft);
}

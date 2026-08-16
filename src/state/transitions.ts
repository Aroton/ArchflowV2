import { isDeepStrictEqual } from "node:util";

import type { DurableArtifact } from "../contracts/durable.js";
import type {
  AuthoritativeResultRef,
  HumanRevisionRecord,
  PlanningRestartRecord,
  TaskStateV1,
} from "../contracts/durable-state.js";
import { createProjectError, type ProjectResult } from "../contracts/errors.js";
import { parseSafeInteger, type SafeInteger, type Sha256Digest } from "../contracts/evidence.js";
import {
  comparePhaseInstances,
  decodePhaseInstance,
  isStrictlyEarlierPlanningPhase,
  nextPhaseInstance,
} from "../contracts/phase-instance.js";
import type { PhaseInstanceId } from "../contracts/phase-instance.js";
import { assertPlainJson } from "../contracts/plain-json.js";
import { WORKFLOW_V1 } from "../contracts/workflow.js";
import type { PipelineStep } from "../contracts/vocabulary.js";
import type { HumanRevisionDeclaration } from "../contracts/mcp-tools.js";
import {
  assertAuthenticatedGateApproval,
  type AuthenticatedGateApproval,
} from "./gate-approvals.js";
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
  /**
   * The constitution-review evidence reference archflow_counter_review installs alongside its
   * review reference — one atomic transaction, so no durable state can hold the rubric review
   * without the constitution verdict it was dispatched with. Legal only on a succeeded
   * counter_review target; the reference itself is retained under the "adjudicate" evidence slot.
   */
  constitution_result_reference?: AuthoritativeResultRef;
  completion_subject_digest?: Sha256Digest;
  authenticated_gate_approvals?: readonly AuthenticatedGateApproval[];
  commit_observed?: boolean;
  legacy_resume_phase?: PhaseInstanceId;
  human_revision?: HumanRevisionDeclaration;
  resulting_subject_digest?: Sha256Digest;
  /** Internal gate boundary: human-requested bytes begin without consuming a review attempt. */
  human_revision_reentry?: boolean;
}>;

export type PlanningRestartPlanInput = Readonly<{
  current: TaskStateV1;
  restart_id: PlanningRestartRecord["restart_id"];
  target_phase_instance: PhaseInstanceId;
  reason: string;
  recomputed_input_fingerprint: Sha256Digest;
  human_provenance: PlanningRestartRecord["human_provenance"];
}>;

const ok = <T>(value: T): ProjectResult<T> => Object.freeze({ schema_version: "1", ok: true, value });

function restartInvalid(input: PlanningRestartPlanInput, issue: string): ProjectResult<never> {
  void issue;
  return Object.freeze({
    schema_version: "1",
    ok: false,
    error: createProjectError("TRANSITION_INVALID", {
      phase_instance: input.target_phase_instance,
      from: `${input.current.step}-${input.current.status}`,
      to: "planning-restart",
    }),
  });
}

/**
 * Plans the one exceptional backward edge. It archives, rather than deletes, every invalidated
 * authority root and lands directly in the existing target produce window.
 */
export function planPlanningRestart(value: PlanningRestartPlanInput): ProjectResult<NextStateDraft> {
  assertPlainJson(value, "planning restart input");
  const input = structuredClone(value);
  const current = input.current;
  if (
    current.terminal !== undefined || current.open_gate !== undefined || input.reason.trim() === "" ||
    !isStrictlyEarlierPlanningPhase(input.target_phase_instance, current.phase_instance)
  ) return restartInvalid(input, "target-not-strictly-earlier-planning-phase");
  if ((current.restart_history ?? []).some((record) => record.restart_id === input.restart_id)) {
    return restartInvalid(input, "restart-id-already-recorded");
  }

  const retained = current.authoritative_results.filter((reference) =>
    comparePhaseInstances(reference.phase_instance, input.target_phase_instance) < 0);
  const superseded = current.authoritative_results.filter((reference) =>
    comparePhaseInstances(reference.phase_instance, input.target_phase_instance) >= 0);
  const restartedAtRevision = parseSafeInteger(current.revision + 1);
  const record: PlanningRestartRecord = Object.freeze({
    restart_id: input.restart_id,
    source_phase_instance: current.phase_instance,
    target_phase_instance: input.target_phase_instance,
    reason: input.reason,
    restarted_at_revision: restartedAtRevision,
    superseded_results: Object.freeze(superseded),
    cleared_waivers: Object.freeze([...current.waivers]),
    ...(current.pending_human_revision === undefined
      ? {}
      : { cleared_pending_human_revision: current.pending_human_revision }),
    human_provenance: input.human_provenance,
  });
  const history = Object.freeze(
    [...(current.restart_history ?? []), record]
      .sort((left, right) => left.restart_id.localeCompare(right.restart_id)),
  );
  const targetKind = decodePhaseInstance(input.target_phase_instance).kind;
  const {
    revision: _revision,
    last_transition: _lastTransition,
    pending_human_revision: _pendingHumanRevision,
    planned_final_phase: plannedFinalPhase,
    ...preserved
  } = current;
  return ok(Object.freeze({
    ...preserved,
    phase_instance: input.target_phase_instance,
    step: "produce",
    status: "running",
    attempt: parseSafeInteger(1),
    input_fingerprint: input.recomputed_input_fingerprint,
    authoritative_results: Object.freeze(retained),
    waivers: Object.freeze([]),
    restart_history: history,
    ...(targetKind === "prd" || targetKind === "design" || plannedFinalPhase === undefined
      ? {}
      : { planned_final_phase: plannedFinalPhase }),
  }));
}

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

function sameSubject(current: TaskStateV1, target: TransitionTarget): boolean {
  return current.phase_instance === target.phase_instance && current.step === target.step;
}

function artifactApprovalKind(
  instance: TaskStateV1["phase_instance"],
): "prd" | "design" | "phase-design" | undefined {
  const kind = decodePhaseInstance(instance).kind;
  return kind === "phase-impl" ? undefined : kind;
}

function hasAuthenticatedArtifactApproval(input: TransitionPlanInput): boolean {
  const artifactKind = artifactApprovalKind(input.current.phase_instance);
  if (artifactKind === undefined || input.completion_subject_digest === undefined) return false;
  const designArtifact = artifactKind === "design" || artifactKind === "phase-design";
  for (const authenticated of input.authenticated_gate_approvals ?? []) {
    assertAuthenticatedGateApproval(authenticated);
    if (
      authenticated.request.kind !== "artifact-approval" &&
      !(designArtifact && authenticated.request.kind === "design-approval")
    ) continue;
    if (
      authenticated.approval.gate_kind === authenticated.request.kind &&
      authenticated.approval.subject_digest === input.completion_subject_digest &&
      authenticated.request.phase_instance === input.current.phase_instance &&
      authenticated.request.subject_digest === input.completion_subject_digest &&
      authenticated.request.context.artifact_kind === artifactKind &&
      authenticated.decision.envelope.payload.decision === "approve"
    ) return true;
  }
  return false;
}

function hasAuthenticatedCombinedDesignApproval(input: TransitionPlanInput): boolean {
  return (input.authenticated_gate_approvals ?? []).some((authenticated) =>
    authenticated.request.kind === "design-approval" &&
    authenticated.approval.gate_kind === "design-approval" &&
    authenticated.approval.subject_digest === input.completion_subject_digest &&
    authenticated.decision.envelope.payload.decision === "approve");
}

/**
 * The status a same-phase run-step request may legally target for `step` from `current`, derived
 * from the same movement rules `legalMovement` enforces: mid-step work records its terminal
 * result, a failed step re-enters running, a succeeded step hands off to its pipeline successor
 * (or back to produce from any succeeded step — the author-initiated re-entry). `undefined`
 * means no run-step request from this state can legally target `step`, so no request template
 * may honestly be emitted for it.
 */
export function legalRunStepStatus(
  current: Pick<TaskStateV1, "phase_instance" | "step" | "status" | "terminal" | "open_gate">,
  step: PipelineStep,
): "running" | "succeeded" | undefined {
  if (current.terminal !== undefined || current.open_gate !== undefined) return undefined;
  if (current.step === step) {
    if (current.status === "running") return "succeeded";
    if (current.status === "failed") return "running";
    // Withdraw-and-redo: a succeeded produce may re-enter its own running state (attempt + 1).
    return step === "produce" && current.status === "succeeded" ? "running" : undefined;
  }
  if (current.status !== "succeeded") return undefined;
  if (step === "produce") return "running";
  const steps = pipeline(current.phase_instance);
  const index = steps.indexOf(current.step);
  return index >= 0 && steps[index + 1] === step ? "running" : undefined;
}

function hasAuthenticatedMigrationAudit(input: TransitionPlanInput): boolean {
  if (input.commit_observed !== true || input.legacy_resume_phase === undefined || input.target.phase_instance !== input.legacy_resume_phase) return false;
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
    if (current.status === "failed") {
      return target.status === "running" && target.attempt === current.attempt + 1;
    }
    // A succeeded step re-entering itself is legal only through the backward-to-produce rule
    // below (produce-succeeded -> produce-running, withdraw-and-redo); fall through to it.
  }
  if (current.status !== "succeeded" || target.status !== "running") return false;
  if (target.phase_instance === current.phase_instance && target.step === "produce") {
    // Author-initiated produce re-entry from any succeeded pipeline step (attempt + 1): the
    // triage case is the accepted-finding re-entry, the produce/counter_review cases are the
    // sanctioned new-information door — downstream evidence simply goes stale.
    return input.human_revision_reentry === true
      ? target.attempt === current.attempt
      : target.attempt === current.attempt + 1;
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
    target.phase_instance !== nextPhaseInstance(current.phase_instance) &&
    hasAuthenticatedMigrationAudit(input)
  ) return true;
  const following = nextPhaseInstance(current.phase_instance);
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
  const artifactTaskId = artifact.artifact_kind === "triage"
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
  if (artifact.artifact_kind === "triage") {
    return artifact.evidence.phase_instance === input.target.phase_instance &&
      artifact.evidence.step === input.target.step &&
      artifact.evidence.input_fingerprint === input.recomputed_input_fingerprint;
  }
  return input.target.phase_instance === input.current.phase_instance && input.target.step === input.current.step;
}

function resultReferenceMatches(input: TransitionPlanInput): boolean {
  const reference = input.result_reference;
  const sourceKind = input.artifact?.artifact_kind;
  const evidenceStep = input.target.step === "counter_review" ||
    input.target.step === "triage";
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

function constitutionReferenceMatches(input: TransitionPlanInput): boolean {
  const reference = input.constitution_result_reference;
  if (reference === undefined) return true;
  return input.target.status === "succeeded" &&
    input.target.step === "counter_review" &&
    reference.step === "adjudicate" &&
    reference.phase_instance === input.target.phase_instance &&
    reference.input_fingerprint === input.recomputed_input_fingerprint;
}

function pendingHumanRevisionMatches(input: TransitionPlanInput): boolean {
  const pending = input.current.pending_human_revision;
  const declaration = input.human_revision;
  if (pending === undefined) return declaration === undefined;
  if (input.current.phase_instance !== input.target.phase_instance ||
      input.current.step !== "produce" || input.target.step !== "produce") return false;
  if (input.current.attempt !== pending.attempt) return false;
  if (input.target.status !== "succeeded") return declaration === undefined;
  if (declaration === undefined || input.result_reference === undefined ||
      input.resulting_subject_digest === undefined ||
      input.resulting_subject_digest === pending.predecessor_subject_digest) return false;
  return pending.evidence.every((expected) => input.current.authoritative_results.some((observed) =>
    isDeepStrictEqual(expected, observed)));
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
    input.current.step !== "triage" ||
    input.current.status !== "succeeded" ||
    input.current.terminal !== undefined ||
    input.current.open_gate !== undefined ||
    input.completion_subject_digest === undefined ||
    input.commit_observed !== true ||
    input.artifact !== undefined ||
    input.result_reference !== undefined ||
    input.constitution_result_reference !== undefined
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
  const crossesPhase = input.target.phase_instance !== input.current.phase_instance;
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
    const { revision: _revision, last_transition: _transition, ...preserved } = input.current;
    return ok(Object.freeze({ ...preserved, terminal: "complete" }));
  }
  if (
    decodedCurrent.kind === "phase-impl" &&
    input.current.step === "triage" &&
    input.current.status === "succeeded" &&
    input.target.phase_instance !== input.current.phase_instance &&
    !committedOutput
  ) return invalid(input, from, to);
  if (
    decodedCurrent.kind !== "phase-impl" &&
    crossesPhase &&
    !hasAuthenticatedArtifactApproval(input)
  ) return invalid(input, from, to);
  if (
    (decodedCurrent.kind === "design" || decodedCurrent.kind === "phase-design") &&
    crossesPhase &&
    hasAuthenticatedCombinedDesignApproval(input) &&
    input.commit_observed !== true
  ) return invalid(input, from, to);
  if (
    !legalMovement(input) ||
    !artifactMatches(input) ||
    !resultReferenceMatches(input) ||
    !constitutionReferenceMatches(input) ||
    !pendingHumanRevisionMatches(input)
  ) {
    return invalid(input, from, to);
  }

  const {
    revision: _revision,
    last_transition: _transition,
    pending_human_revision: pendingHumanRevision,
    ...preserved
  } = input.current;
  const completingHumanRevision = pendingHumanRevision !== undefined &&
    input.target.step === "produce" && input.target.status === "succeeded";
  const significantHumanRevision = completingHumanRevision && input.human_revision?.classification === "significant";
  const currentReferences = significantHumanRevision
    ? preserved.authoritative_results.filter((entry) =>
        entry.phase_instance !== input.target.phase_instance ||
        (entry.step !== "counter_review" && entry.step !== "adjudicate" && entry.step !== "triage"))
    : preserved.authoritative_results;
  const authoritativeResults = withResultReference(
    withResultReference(currentReferences, input.result_reference),
    input.constitution_result_reference,
  );
  let humanRevisionHistory = preserved.human_revision_history;
  if (completingHumanRevision) {
    const declaration = input.human_revision!;
    const record: HumanRevisionRecord = Object.freeze({
      phase_instance: input.target.phase_instance,
      gate_id: pendingHumanRevision.gate_id,
      gate_kind: pendingHumanRevision.gate_kind,
      predecessor_subject_digest: pendingHumanRevision.predecessor_subject_digest,
      predecessor_input_fingerprint: pendingHumanRevision.predecessor_input_fingerprint,
      resulting_subject_digest: input.resulting_subject_digest!,
      resulting_result_digest: input.result_reference!.result_digest,
      classification: declaration.classification,
      rationale: declaration.rationale,
      ...(declaration.user_override === undefined ? {} : { user_override: declaration.user_override }),
      previous_attempt: pendingHumanRevision.attempt,
      resulting_attempt: declaration.classification === "significant"
        ? parseSafeInteger(1)
        : pendingHumanRevision.attempt,
      evidence: pendingHumanRevision.evidence,
    });
    humanRevisionHistory = Object.freeze(
      [...(humanRevisionHistory ?? []), record].sort((left, right) => left.gate_id.localeCompare(right.gate_id)),
    );
  }
  const draft: NextStateDraft = Object.freeze({
    ...preserved,
    phase_instance: input.target.phase_instance,
    step: input.target.step,
    status: input.target.status,
    attempt: significantHumanRevision ? parseSafeInteger(1) : input.target.attempt,
    input_fingerprint: input.target.input_fingerprint,
    authoritative_results: authoritativeResults,
    ...(humanRevisionHistory === undefined ? {} : { human_revision_history: humanRevisionHistory }),
    ...(!completingHumanRevision && pendingHumanRevision !== undefined
      ? { pending_human_revision: pendingHumanRevision }
      : {}),
  });
  if (
    input.result_reference === undefined &&
    input.constitution_result_reference === undefined &&
    !isDeepStrictEqual(draft.authoritative_results, input.current.authoritative_results)
  ) {
    throw new TypeError("transition planning changed authoritative results");
  }
  return ok(draft);
}

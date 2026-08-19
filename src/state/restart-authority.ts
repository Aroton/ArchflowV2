import { isDeepStrictEqual } from "node:util";

import type { ApprovalRef, TaskStateV1 } from "../contracts/durable-state.js";
import { comparePhaseInstances, decodePhaseInstance, type PhaseInstanceId } from "../contracts/phase-instance.js";
import type { AuthenticatedGateApproval } from "./gate-approvals.js";

export function compareWorkflowPositions(left: PhaseInstanceId, right: PhaseInstanceId): number {
  return comparePhaseInstances(left, right);
}

/** Latest restart whose target invalidates authority produced at `authorityPhase`. */
export function latestRestartRevisionAffectingPhase(
  state: TaskStateV1,
  authorityPhase: PhaseInstanceId,
): number | undefined {
  let latest: number | undefined;
  for (const restart of state.restart_history ?? []) {
    if (compareWorkflowPositions(restart.target_phase_instance, authorityPhase) > 0) continue;
    if (latest === undefined || restart.restarted_at_revision > latest) {
      latest = restart.restarted_at_revision;
    }
  }
  return latest;
}

export function approvalIsEligibleAfterLatestRestart(
  state: TaskStateV1,
  approval: ApprovalRef,
  authorityPhase: PhaseInstanceId,
): boolean {
  const cutoff = latestRestartRevisionAffectingPhase(state, authorityPhase);
  return cutoff === undefined || approval.resolved_at_revision > cutoff;
}

/**
 * Resolves the phase explicitly bound by an authenticated gate request. Consumers that load an
 * imported or compound upstream must first authenticate that subject and pass its actual producer
 * phase instead; a later consuming phase must never be substituted here.
 */
export function approvalRequestAuthorityPhase(
  authenticated: AuthenticatedGateApproval,
): PhaseInstanceId {
  return authenticated.request.phase_instance;
}

export function authenticatedApprovalIsEligibleAfterLatestRestart(
  state: TaskStateV1,
  authenticated: AuthenticatedGateApproval,
  authorityPhase: PhaseInstanceId = approvalRequestAuthorityPhase(authenticated),
): boolean {
  return approvalIsEligibleAfterLatestRestart(state, authenticated.approval, authorityPhase);
}

type StateDraft = Omit<TaskStateV1, "revision" | "last_transition"> & {
  readonly revision?: never;
  readonly last_transition?: never;
};

/** Independent transaction-kernel check for the only mutation allowed to clear gate authority. */
export function isExactPlanningRestartDraft(current: TaskStateV1, next: StateDraft): boolean {
  if (current.terminal !== undefined || current.open_gate !== undefined || next.open_gate !== undefined) return false;
  const previous = current.restart_history ?? [];
  const following = next.restart_history ?? [];
  if (following.length !== previous.length + 1) return false;
  const previousById = new Map(previous.map((record) => [record.restart_id, record]));
  const additions = following.filter((record) => !previousById.has(record.restart_id));
  if (additions.length !== 1 || previous.some((record) =>
    !isDeepStrictEqual(record, following.find((candidate) => candidate.restart_id === record.restart_id)))) return false;
  const restart = additions[0]!;
  if (
    restart.source_phase_instance !== current.phase_instance ||
    restart.target_phase_instance !== next.phase_instance ||
    restart.restarted_at_revision !== current.revision + 1 ||
    restart.reason.trim() === "" ||
    comparePhaseInstances(restart.target_phase_instance, current.phase_instance) >= 0 ||
    decodePhaseInstance(restart.target_phase_instance).kind === "phase-impl" ||
    next.step !== "produce" || next.status !== "running" || next.attempt !== 1 ||
    !isDeepStrictEqual(restart.cleared_waivers, current.waivers) || next.waivers.length !== 0 ||
    !isDeepStrictEqual(restart.cleared_pending_human_revision, current.pending_human_revision) ||
    next.pending_human_revision !== undefined ||
    !isDeepStrictEqual(next.approvals, current.approvals)
  ) return false;
  const retained = current.authoritative_results.filter((reference) =>
    comparePhaseInstances(reference.phase_instance, restart.target_phase_instance) < 0);
  const superseded = current.authoritative_results.filter((reference) =>
    comparePhaseInstances(reference.phase_instance, restart.target_phase_instance) >= 0);
  if (!isDeepStrictEqual(next.authoritative_results, retained) ||
      !isDeepStrictEqual(restart.superseded_results, superseded)) return false;
  const targetKind = decodePhaseInstance(restart.target_phase_instance).kind;
  if (targetKind === "prd" || targetKind === "design"
    ? next.planned_final_phase !== undefined
    : next.planned_final_phase !== current.planned_final_phase) return false;

  const {
    revision: _revision,
    last_transition: _lastTransition,
    pending_human_revision: _pendingHumanRevision,
    planned_final_phase: plannedFinalPhase,
    ...preserved
  } = current;
  const expectedHistory = Object.freeze(
    [...previous, restart].sort((left, right) => left.restart_id.localeCompare(right.restart_id)),
  );
  if (!isDeepStrictEqual(following, expectedHistory)) return false;
  const expected: StateDraft = {
    ...preserved,
    phase_instance: restart.target_phase_instance,
    step: "produce",
    status: "running",
    attempt: 1 as TaskStateV1["attempt"],
    input_fingerprint: next.input_fingerprint,
    authoritative_results: retained,
    waivers: [],
    restart_history: expectedHistory,
    ...(targetKind === "prd" || targetKind === "design" || plannedFinalPhase === undefined
      ? {}
      : { planned_final_phase: plannedFinalPhase }),
  };
  return isDeepStrictEqual(next, expected);
}

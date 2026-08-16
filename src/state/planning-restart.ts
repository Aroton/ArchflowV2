import type { TaskStateV1 } from "../contracts/durable-state.js";
import { parsePathSafeId, type PathSafeId, type Sha256Digest } from "../contracts/evidence.js";
import { encodePhaseInstance, parsePhaseInstanceId, parsePositiveSafePhaseNumber, type PhaseInstanceId } from "../contracts/phase-instance.js";
import type { WorkflowInvocationV1 } from "../contracts/semantic-workflow.js";

export function planningRestartTarget(invocation: WorkflowInvocationV1): PhaseInstanceId {
  if (invocation.intent !== "reopen") throw new TypeError("planning restart requires explicit reopen intent");
  switch (invocation.skill) {
    case "archflow-prd": return parsePhaseInstanceId("prd");
    case "archflow-design": return parsePhaseInstanceId("design");
    case "archflow-phase-design": return encodePhaseInstance({ kind: "phase-design", phase: parsePositiveSafePhaseNumber(invocation.phase) });
  }
}

const SEMANTIC_REOPEN_INTENT = /^afop-([0-9a-f]{64})-reopen$/u;

export function semanticPlanningRestartId(intentId: string): PathSafeId | undefined {
  const match = SEMANTIC_REOPEN_INTENT.exec(intentId);
  return match === null ? undefined : parsePathSafeId(`planning-restart-${match[1]!.slice(0, 32)}`);
}

export function planningRestartId(requestDigest: Sha256Digest, intentId?: string): PathSafeId {
  return intentId === undefined
    ? parsePathSafeId(`planning-restart-${requestDigest.slice(0, 32)}`)
    : semanticPlanningRestartId(intentId) ?? parsePathSafeId(`planning-restart-${requestDigest.slice(0, 32)}`);
}

export function completedPlanningRestartMatches(
  state: TaskStateV1,
  input: Readonly<{
    restart_id: PathSafeId;
    source_phase_instance: PhaseInstanceId;
    target_phase_instance: PhaseInstanceId;
    reason: string;
    input_fingerprint: Sha256Digest;
  }>,
): boolean {
  const restart = state.restart_history?.find((record) => record.restart_id === input.restart_id);
  return restart !== undefined &&
    restart.source_phase_instance === input.source_phase_instance &&
    restart.target_phase_instance === input.target_phase_instance &&
    restart.reason === input.reason &&
    state.revision === restart.restarted_at_revision &&
    state.phase_instance === restart.target_phase_instance &&
    state.step === "produce" && state.status === "running" && state.attempt === 1 &&
    state.input_fingerprint === input.input_fingerprint;
}

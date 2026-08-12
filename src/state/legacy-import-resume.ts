import type { TaskStateV1 } from "../contracts/durable-state.js";
import type { ProjectResult } from "../contracts/errors.js";
import { parseLegacyImportInitialization } from "../contracts/durable-legacy-import.js";
import { decodePhaseInstance, encodePhaseInstance, parsePositiveSafePhaseNumber, type PhaseInstanceId } from "../contracts/phase-instance.js";
import { initializationAuthorityClaim, resolveTaskPath } from "../repository/paths.js";
import type { TransactionAuthority } from "./authority.js";
import { issue, ok, readCanonical, type GateLifecycleDependencies } from "./gate-core.js";

/** Finds the initialization manifest whose canonical digest authenticates a legacy import. */
export async function findLegacyImportResumePhase(
  dependencies: Pick<GateLifecycleDependencies, "runner">,
  authority: TransactionAuthority,
  state: TaskStateV1,
): Promise<ProjectResult<PhaseInstanceId | undefined>> {
  const resolved = await resolveTaskPath({
    runner: dependencies.runner,
    taskId: authority.task_id,
    claim: initializationAuthorityClaim(),
    expectedClass: "authority-initialization",
    context: authority.context,
  });
  if (!resolved.ok) return resolved;
  const document = await readCanonical(
    resolved.value,
    "legacy import initialization authority",
    parseLegacyImportInitialization,
  );
  if (document === "missing" || document === "invalid" || document.digest !== state.initialization_digest) {
    return ok(undefined);
  }
  let highest = 0;
  for (const entry of document.value.mapping) {
    const decoded = decodePhaseInstance(entry.phase_instance);
    if (decoded.kind === "phase-impl") highest = Math.max(highest, Number(decoded.phase));
  }
  return ok(encodePhaseInstance({
    kind: "phase-design",
    phase: parsePositiveSafePhaseNumber(highest + 1),
  }));
}

export async function loadLegacyImportResumePhase(
  dependencies: Pick<GateLifecycleDependencies, "runner">,
  authority: TransactionAuthority,
  state: TaskStateV1,
): Promise<ProjectResult<PhaseInstanceId>> {
  const found = await findLegacyImportResumePhase(dependencies, authority, state);
  if (!found.ok) return found;
  return found.value === undefined
    ? issue("STATE_INVALID", state, "legacy-import-manifest-missing")
    : ok(found.value);
}

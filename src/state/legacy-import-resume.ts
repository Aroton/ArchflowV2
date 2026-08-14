import type { TaskStateV1 } from "../contracts/durable-state.js";
import type { ProjectResult } from "../contracts/errors.js";
import { parseLegacyImportInitialization, type LegacyImportInitializationV1 } from "../contracts/durable-legacy-import.js";
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
  const loaded = await loadLegacyImportInitialization(dependencies, authority, state);
  if (!loaded.ok) return loaded;
  if (loaded.value === undefined) return ok(undefined);
  const document = loaded.value;
  if (document.resume_phase !== undefined) return ok(document.resume_phase);
  const designs = new Set<number>();
  const implementations = new Set<number>();
  for (const entry of document.mapping) {
    const decoded = decodePhaseInstance(entry.phase_instance);
    if (decoded.kind === "phase-design") designs.add(Number(decoded.phase));
    if (decoded.kind === "phase-impl") implementations.add(Number(decoded.phase));
  }
  let highest = 0;
  while (implementations.has(highest + 1)) highest += 1;
  const next = highest + 1;
  return ok(encodePhaseInstance({
    kind: designs.has(next) ? "phase-impl" : "phase-design",
    phase: parsePositiveSafePhaseNumber(next),
  }));
}

export async function loadLegacyImportInitialization(
  dependencies: Pick<GateLifecycleDependencies, "runner">,
  authority: TransactionAuthority,
  state: TaskStateV1,
): Promise<ProjectResult<LegacyImportInitializationV1 | undefined>> {
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
  return ok(document.value);
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

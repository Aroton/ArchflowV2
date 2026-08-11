import { readdir } from "node:fs/promises";
import { join } from "node:path";

import type { CanonicalDocument } from "../contracts/canonical.js";
import type { TaskStateV1 } from "../contracts/durable-state.js";
import type { ProjectResult } from "../contracts/errors.js";
import { parseLegacyImportInitialization } from "../contracts/durable-legacy-import.js";
import { decodePhaseInstance, encodePhaseInstance, parsePositiveSafePhaseNumber, type PhaseInstanceId } from "../contracts/phase-instance.js";
import { resolveTaskPath } from "../repository/paths.js";
import { parseTaskPathClaim } from "../contracts/path-claims.js";
import type { TransactionAuthority } from "./authority.js";
import { issue, ok, readCanonical, type GateLifecycleDependencies } from "./gate-core.js";

/** Finds the initialization manifest whose canonical digest authenticates a legacy import. */
export async function findLegacyImportResumePhase(
  dependencies: Pick<GateLifecycleDependencies, "runner">,
  authority: TransactionAuthority,
  state: TaskStateV1,
): Promise<ProjectResult<PhaseInstanceId | undefined>> {
  let names: string[];
  try {
    names = await readdir(join(authority.task_root, "imports"));
  } catch (error) {
    return (error as { code?: unknown } | null)?.code === "ENOENT"
      ? ok(undefined)
      : issue("STATE_INVALID", state, "legacy-import-manifest-missing");
  }
  const matches: CanonicalDocument<ReturnType<typeof parseLegacyImportInitialization>>[] = [];
  for (const name of names.filter((entry) => /^[a-f0-9]{64}$/u.test(entry)).sort()) {
    const resolved = await resolveTaskPath({
      runner: dependencies.runner,
      taskId: authority.task_id,
      claim: parseTaskPathClaim(`imports/${name}/manifest.json`),
      expectedClass: "import",
      context: authority.context,
    });
    if (!resolved.ok) return resolved;
    const document = await readCanonical(
      resolved.value,
      "legacy import initialization manifest",
      parseLegacyImportInitialization,
    );
    if (document !== "missing" && document !== "invalid" && document.digest === state.initialization_digest) {
      matches.push(document);
    }
  }
  if (matches.length === 0) return ok(undefined);
  if (matches.length > 1) return issue("STATE_INVALID", state, "legacy-import-manifest-ambiguous");
  let highest = 0;
  for (const entry of matches[0]!.value.mapping) {
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

import { readFile } from "node:fs/promises";

import { canonicalJsonBytes } from "../contracts/canonical.js";
import {
  DISPATCH_FAILURE_CODES,
  dispatchFailureObservationV1Schema,
  type DispatchFailureCodeV1,
  type DispatchFailureObservationV1,
  type DispatchFailureRoleV1,
} from "../contracts/dispatch-failure.js";
import { parseProjectError, type ProjectError } from "../contracts/errors.js";
import type { SafeInteger } from "../contracts/evidence.js";
import type { PhaseInstanceId } from "../contracts/phase-instance.js";
import type { PlainJsonValue } from "../contracts/plain-json.js";
import { parseWorkspacePathClaim, resolveTaskWorkspacePath } from "../repository/paths.js";
import type { TransactionAuthority } from "../state/authority.js";
import { ensureAttemptDirectory } from "../state/layout.js";
import type { TransactionDependencies } from "../state/transaction.js";
import type { TaskStateV1 } from "../contracts/durable-state.js";
import type { SelectedRouteCandidate } from "./routing.js";

const supportedCodes = new Set<string>(DISPATCH_FAILURE_CODES);

const SAFE_MESSAGES: Readonly<Record<DispatchFailureCodeV1, string>> = Object.freeze({
  CONFIG_INVALID: "The selected reviewer route configuration is invalid.",
  CONFIG_MODEL_UNSUPPORTED: "The selected reviewer model is not supported by the dispatcher.",
  CLI_MISSING: "The required reviewer CLI is not installed or is not available on PATH.",
  AUTH_UNAVAILABLE: "The required reviewer authentication is unavailable.",
  RATE_LIMITED: "The reviewer service rate limit prevented this dispatch.",
  UNSUPPORTED_MODEL: "The reviewer service does not support the selected model.",
  CLI_VERSION_UNSUPPORTED: "The installed reviewer CLI version is not supported.",
  PROCESS_FAILED: "The reviewer process failed before producing a usable result.",
  REPOSITORY_VIEW_UNAVAILABLE: "A required read-only repository snapshot is unavailable. Repair repository access and resume the unchanged review.",
});

export type DispatchFailureObserver = (
  role: DispatchFailureRoleV1,
  selected: SelectedRouteCandidate | undefined,
  error: unknown,
) => Promise<void>;

export type DispatchFailureObserverContext = Readonly<{
  authority: TransactionAuthority;
  dependencies: TransactionDependencies;
  phase_instance: PhaseInstanceId;
  attempt: SafeInteger;
  observed_at_revision: SafeInteger;
}>;

export type DispatchFailureObservationInput = Readonly<{
  role: DispatchFailureRoleV1;
  selected?: SelectedRouteCandidate;
  error: unknown;
}>;

function carriedProjectError(error: unknown): ProjectError | undefined {
  if (error === null || typeof error !== "object") return undefined;
  const descriptor = Object.getOwnPropertyDescriptor(error, "project_error");
  if (descriptor?.enumerable !== true || !("value" in descriptor)) return undefined;
  try {
    return parseProjectError(descriptor.value);
  } catch {
    return undefined;
  }
}

export function classifiedDispatchFailure(error: unknown): Readonly<{
  code: DispatchFailureCodeV1;
  message: string;
  repository_name?: string;
}> | undefined {
  const projectError = carriedProjectError(error);
  if (projectError === undefined || !supportedCodes.has(projectError.code)) return undefined;
  const code = projectError.code as DispatchFailureCodeV1;
  const repositoryName = code === "REPOSITORY_VIEW_UNAVAILABLE"
    ? (projectError.diagnostic.parameters as Readonly<Record<string, unknown>>).repository_name
    : undefined;
  return Object.freeze({ code, message: SAFE_MESSAGES[code], ...(typeof repositoryName === "string" ? { repository_name: repositoryName } : {}) });
}

function observationClaim(phaseInstance: PhaseInstanceId, attempt: SafeInteger) {
  return parseWorkspacePathClaim(
    `diagnostics/attempts/${phaseInstance}/dispatch-counter-review-${String(attempt)}.json`,
  );
}

/**
 * Creates the role-labeled best-effort callback used around route selection and dispatch. The
 * callback deliberately resolves to void for every diagnostic failure so callers always rethrow
 * or return the original classified project error unchanged.
 */
export async function writeDispatchFailureObservation(
  context: DispatchFailureObserverContext,
  input: DispatchFailureObservationInput,
): Promise<boolean> {
  const classified = classifiedDispatchFailure(input.error);
  const writer = context.dependencies.projection_writer;
  if (classified === undefined || writer === undefined) return false;
  await ensureAttemptDirectory(context.authority, context.phase_instance);
  const target = await resolveTaskWorkspacePath({
    runner: context.dependencies.runner,
    taskId: context.authority.task_id,
    claim: observationClaim(context.phase_instance, context.attempt),
    expectedClass: "workspace-attempt",
    context: context.authority.context,
  });
  if (!target.ok) return false;
  const observation = dispatchFailureObservationV1Schema.parse({
    schema_version: "1",
    task_id: context.authority.task_id,
    phase_instance: context.phase_instance,
    step: "counter_review",
    attempt: context.attempt,
    role: input.role,
    code: classified.code,
    message: classified.message,
    ...(classified.repository_name === undefined ? {} : { repository_name: classified.repository_name }),
    ...(input.selected === undefined ? {} : {
      route: {
        model: input.selected.raw_route.model,
        effort: input.selected.raw_route.effort,
        ...(input.selected.raw_route.provider === undefined ? {} : { provider: input.selected.raw_route.provider }),
        source: input.selected.source.provenance,
      },
    }),
    observed_at_revision: context.observed_at_revision,
  } satisfies PlainJsonValue);
  await writer.replaceRegular(target.value, canonicalJsonBytes(observation), false);
  return true;
}

export function createDispatchFailureObserver(
  context: DispatchFailureObserverContext,
): DispatchFailureObserver {
  return async (role, selected, error) => {
    try {
      await writeDispatchFailureObservation(context, {
        role,
        ...(selected === undefined ? {} : { selected }),
        error,
      });
    } catch {
      // This ignored diagnostic must never replace or mask dispatch's original failure.
    }
  };
}

/**
 * Reads only the deterministic slot and returns it only for the exact canonical running attempt.
 * Malformed, stale, missing, terminal, or cross-task bytes have no status visibility.
 */
export async function readCurrentDispatchFailure(
  dependencies: Pick<TransactionDependencies, "runner">,
  authority: TransactionAuthority,
  state: TaskStateV1,
): Promise<DispatchFailureObservationV1 | undefined> {
  if (
    state.terminal !== undefined ||
    state.task_id !== authority.task_id ||
    state.step !== "counter_review" ||
    state.status !== "running"
  ) return undefined;
  try {
    const target = await resolveTaskWorkspacePath({
      runner: dependencies.runner,
      taskId: authority.task_id,
      claim: observationClaim(state.phase_instance, state.attempt),
      expectedClass: "workspace-attempt",
      context: authority.context,
    });
    if (!target.ok) return undefined;
    const parsed = dispatchFailureObservationV1Schema.parse(JSON.parse(
      await readFile(target.value.absolute, "utf8"),
    ));
    return parsed.task_id === state.task_id &&
      parsed.phase_instance === state.phase_instance &&
      parsed.step === state.step &&
      parsed.attempt === state.attempt &&
      parsed.observed_at_revision === state.revision
      ? Object.freeze(parsed)
      : undefined;
  } catch {
    return undefined;
  }
}

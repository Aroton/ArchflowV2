import { randomUUID } from "node:crypto";

import { canonicalJsonBytes } from "../contracts/canonical.js";
import type { RepositoryName } from "../contracts/config.js";
import { createProjectError, type ProjectError } from "../contracts/errors.js";
import type { HostIdentity } from "../contracts/hosts.js";
import type { PhaseInstanceId } from "../contracts/phase-instance.js";
import type { PlainJsonValue } from "../contracts/plain-json.js";
import type { DispatchEnvelope } from "../review/envelopes.js";
import { parseWorkspacePathClaim, resolveTaskWorkspacePath } from "../repository/paths.js";
import {
  CliAdapterError,
  exitClass,
  memoizedCliPreflight,
  selectCliAdapter,
  type CliPreflight,
} from "./cli.js";
import {
  DispatchProcessError,
  runDispatchChild,
  type DispatchChildResult,
  type DispatchChildSpec,
  type DispatchFailureChannels,
} from "./process.js";
import type { DispatchRoute } from "./routing.js";
import {
  createDispatchWorkspace,
  materializeRepositoryViews,
  RepositoryViewMaterializationError,
  type DispatchRepositoryViewPlan,
  type SharedRepositoryViewWorkspace,
} from "./workspace.js";
import { assertInternalTransactionAuthority, type TransactionAuthority } from "../state/authority.js";
import { ensureAttemptDirectory } from "../state/layout.js";
import type { TransactionDependencies } from "../state/transaction.js";

export type DispatchCoordinatorInput = Readonly<{
  authority: TransactionAuthority;
  dependencies: TransactionDependencies;
  host: HostIdentity;
  repository_root: string;
  phase_instance: PhaseInstanceId;
  signal: AbortSignal;
  cancellation_source: NonNullable<DispatchChildSpec["cancellation_source"]>;
  /** Ordered, validated server-owned snapshots. When absent the child receives no repository. */
  repository_views?: DispatchRepositoryViewPlan;
  /**
   * Caller-owned lazily materialized workspace lent to every dispatch of one review. When
   * present it replaces per-dispatch creation and materialization; the coordinator borrows it
   * and never disposes it — the owner disposes it after every child of the call has settled.
   */
  shared_workspace?: SharedRepositoryViewWorkspace;
}>;

export type DispatchCoordinatorResult = Readonly<{
  cli_version: string;
  extracted_output_bytes: Uint8Array;
}>;

function failureCode(error: unknown): string | undefined {
  if (error instanceof CliAdapterError || error instanceof DispatchProcessError) {
    return error.project_error.code;
  }
  if (error instanceof RepositoryViewUnavailableError) return error.project_error.code;
  return undefined;
}

/** Safe classified carrier: the source exception and live root never cross this boundary. */
export class RepositoryViewUnavailableError extends Error {
  readonly project_error: ProjectError;

  constructor(repositoryName: "primary" | RepositoryName) {
    super(`The read-only snapshot for repository ${repositoryName} is unavailable. Repair repository access and resume the unchanged review.`);
    this.name = "RepositoryViewUnavailableError";
    this.project_error = createProjectError("REPOSITORY_VIEW_UNAVAILABLE", { repository_name: repositoryName });
  }
}

const CHANNEL_TAIL_BYTE_CAP = 4096;

function channelTail(channel: Uint8Array): string {
  const bytes = channel.byteLength > CHANNEL_TAIL_BYTE_CAP
    ? channel.subarray(channel.byteLength - CHANNEL_TAIL_BYTE_CAP)
    : channel;
  return new TextDecoder("utf-8").decode(bytes);
}

type AttemptTelemetry = Readonly<{
  started_at: string;
  duration_ms: number;
  failure_stage: DispatchFailureStage;
  child_result: DispatchChildResult | undefined;
}>;

type DispatchFailureStage =
  | "workspace-create"
  | "repository-view-materialization"
  | "cli-preflight"
  | "invocation-build"
  | "child-run"
  | "child-failure-classification"
  | "output-parse";

/**
 * Persists the forensic record of one FAILED dispatch. Successful dispatches write nothing:
 * their evidence is the retained result itself, and per-success telemetry was pure
 * write-only ceremony that grew without bound. The failure record is what canary/leak
 * forensics reads (see docs/LIMITATIONS.md), so its shape is unchanged.
 */
async function writeAttemptRecord(
  input: DispatchCoordinatorInput,
  attemptId: string,
  route: DispatchRoute,
  preflight: CliPreflight | undefined,
  error: unknown,
  telemetry: AttemptTelemetry,
): Promise<void> {
  const writer = input.dependencies.projection_writer;
  if (writer === undefined || error === undefined) return;

  await ensureAttemptDirectory(input.authority, input.phase_instance);
  const target = await resolveTaskWorkspacePath({
    runner: input.dependencies.runner,
    taskId: input.authority.task_id,
    claim: parseWorkspacePathClaim(`diagnostics/attempts/${input.phase_instance}/${attemptId}.json`),
    expectedClass: "workspace-attempt",
    context: input.authority.context,
  });
  if (!target.ok) return;

  const code = failureCode(error);
  const unclassified = code === undefined && error instanceof Error;
  const systemCode = unclassified && "code" in error && typeof error.code === "string"
    ? error.code
    : undefined;
  const channels: DispatchFailureChannels | DispatchChildResult | undefined = telemetry.child_result
    ?? (error instanceof DispatchProcessError ? error.channels : undefined);
  const stdoutTail = channels === undefined ? "" : channelTail(channels.stdout);
  const stderrTail = channels === undefined ? "" : channelTail(channels.stderr);
  const record = {
    schema_version: "1",
    attempt_id: attemptId,
    task_id: input.authority.task_id,
    phase_instance: input.phase_instance,
    adapter: route.adapter,
    family: route.family,
    model: route.model,
    effort: route.effort,
    ...(route.provider === undefined ? {} : { provider: route.provider }),
    status: "failed",
    failure_stage: telemetry.failure_stage,
    started_at: telemetry.started_at,
    duration_ms: telemetry.duration_ms,
    ...(preflight === undefined ? {} : {
      cli_version: preflight.cli_version,
      managed_policy_present: preflight.managed_policy_present,
      managed_policy_paths: [...preflight.managed_policy_paths],
    }),
    ...(code === undefined ? {} : { failure_code: code }),
    ...(unclassified ? { error_name: error.name, error_message: error.message } : {}),
    ...(systemCode === undefined ? {} : { system_code: systemCode }),
    ...(code === "CANCELLED" ? { cancellation_source: input.cancellation_source } : {}),
    ...(telemetry.child_result === undefined ? {} : { exit_class: exitClass(telemetry.child_result) }),
    ...(stdoutTail === "" ? {} : { stdout_tail: stdoutTail }),
    ...(stderrTail === "" ? {} : { stderr_tail: stderrTail }),
  } satisfies PlainJsonValue;
  await writer.replaceRegular(target.value, canonicalJsonBytes(record), false);
}

/** Assembles one fresh CLI dispatch without acquiring the process-wide queue. */
export function createDispatchCoordinator(input: DispatchCoordinatorInput): (
  route: DispatchRoute,
  envelope: DispatchEnvelope,
  outputSchema: PlainJsonValue,
) => Promise<DispatchCoordinatorResult> {
  assertInternalTransactionAuthority(input.authority, {
    runner: input.dependencies.runner,
    environment: input.dependencies.environment,
  });
  if (input.shared_workspace !== undefined && input.repository_views !== undefined) {
    throw new TypeError("shared_workspace replaces repository_views; pass one, not both");
  }

  return async (route, envelope, outputSchema) => {
    const adapter = selectCliAdapter(input.host, route);
    const attemptId = randomUUID();
    const startedAt = new Date();
    let preflight: CliPreflight | undefined;
    let primaryError: unknown;
    let childResult: DispatchChildResult | undefined;
    let workspace: Awaited<ReturnType<typeof createDispatchWorkspace>> | undefined;
    let ownsWorkspace = true;
    let failureStage: DispatchFailureStage = "workspace-create";

    try {
      if (input.shared_workspace !== undefined) {
        // A borrowed workspace is materialized once per review; its owner disposes it after
        // every child of the call has settled. Failure-stage attribution is preserved so the
        // attempt record cannot tell the two paths apart.
        ownsWorkspace = false;
        failureStage = "repository-view-materialization";
        try {
          workspace = await input.shared_workspace.acquire();
        } catch (error) {
          if (error instanceof RepositoryViewMaterializationError) {
            throw new RepositoryViewUnavailableError(error.repository_name);
          }
          throw error;
        }
      } else {
        workspace = await createDispatchWorkspace(adapter.id, input.repository_root);
        if (input.repository_views !== undefined) {
          failureStage = "repository-view-materialization";
          try {
            workspace = await materializeRepositoryViews(workspace, input.repository_views);
          } catch (error) {
            if (error instanceof RepositoryViewMaterializationError) {
              throw new RepositoryViewUnavailableError(error.repository_name);
            }
            throw error;
          }
        }
      }
      failureStage = "cli-preflight";
      preflight = await memoizedCliPreflight(adapter, workspace, input.signal, input.cancellation_source);
      failureStage = "invocation-build";
      const invocation = await adapter.buildInvocation(envelope, route, workspace, outputSchema);
      failureStage = "child-run";
      childResult = await runDispatchChild({
        ...invocation,
        signal: input.signal,
        cancellation_source: input.cancellation_source,
      });
      failureStage = "child-failure-classification";
      const failure = adapter.classifyFailure(childResult);
      if (failure !== undefined) throw new CliAdapterError(failure);
      failureStage = "output-parse";
      return Object.freeze({
        cli_version: preflight.cli_version,
        extracted_output_bytes: adapter.parseOutput(childResult),
      });
    } catch (error) {
      primaryError = error;
      throw error;
    } finally {
      if (ownsWorkspace) await workspace?.dispose().catch(() => undefined);
      if (primaryError !== undefined) {
        await writeAttemptRecord(input, attemptId, route, preflight, primaryError, {
          started_at: startedAt.toISOString(),
          duration_ms: Date.now() - startedAt.getTime(),
          failure_stage: failureStage,
          child_result: childResult,
        }).catch(() => undefined);
      }
    }
  };
}

import { writeDispatchUsageRecord } from "./usage-log.js";
import type { DispatchUsage } from "../contracts/dispatch-usage.js";
import { claudeDispatchUsage } from "./usage.js";
import { randomUUID } from "node:crypto";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";

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
} from "./process.js";
import type { DispatchRoute } from "./routing.js";
import { antigravityOutputDiagnostics } from "./antigravity-output.js";
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
  /** Optional local destination for embedders/tests; installed bundles resolve their own home. */
  usage_directory?: string;
  usage_context?: { task_id: string; phase_instance: string; attempt: number };
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
  usage?: DispatchUsage;
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
  result_kind: DispatchEnvelope["result_kind"];
  envelope_digest: DispatchEnvelope["digest"];
  input_byte_count: number;
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
 * Failures retain forensic diagnostics; successful Claude dispatches retain numeric usage only.
 * These ignored records follow existing phase cleanup. Accepted reviewer feedback also keeps
 * its measurements durably, without raw CLI transcripts.
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
  if (writer === undefined) return;
  const channels = telemetry.child_result ?? (error instanceof DispatchProcessError ? error.channels : undefined);
  const usage = route.adapter === "claude-cli" && channels !== undefined ? claudeDispatchUsage(channels.stdout) : undefined;
  if (error === undefined && usage === undefined) return;

  await ensureAttemptDirectory(input.authority, input.phase_instance);
  const target = await resolveTaskWorkspacePath({
    runner: input.dependencies.runner,
    taskId: input.authority.task_id,
    claim: parseWorkspacePathClaim(`diagnostics/attempts/${input.phase_instance}/${attemptId}.json`),
    expectedClass: "workspace-attempt",
    context: input.authority.context,
  });
  if (!target.ok) return;

  // Successful dispatches retain only small measurements, never channel transcripts.
  if (error === undefined) {
    await writer.replaceRegular(target.value, canonicalJsonBytes({
      schema_version: "1", attempt_id: attemptId, task_id: input.authority.task_id,
      phase_instance: input.phase_instance, attempt: input.authority.context.attempt,
      adapter: route.adapter, model: route.model, effort: route.effort,
      started_at: telemetry.started_at, duration_ms: telemetry.duration_ms,
      status: "succeeded", usage: usage!,
      result_kind: telemetry.result_kind, envelope_digest: telemetry.envelope_digest, input_byte_count: telemetry.input_byte_count,
    }), false);
    return;
  }
  const code = failureCode(error);
  const parameters = error instanceof CliAdapterError || error instanceof DispatchProcessError
    ? error.project_error.diagnostic.parameters : undefined;
  const unclassified = code === undefined && error instanceof Error;
  const systemCode = unclassified && "code" in error && typeof error.code === "string"
    ? error.code
    : undefined;
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
    result_kind: telemetry.result_kind, envelope_digest: telemetry.envelope_digest, input_byte_count: telemetry.input_byte_count,
    ...(usage === undefined ? {} : { usage }),
    failure_stage: telemetry.failure_stage,
    started_at: telemetry.started_at,
    duration_ms: telemetry.duration_ms,
    ...(preflight === undefined ? {} : {
      cli_version: preflight.cli_version,
      managed_policy_present: preflight.managed_policy_present,
      managed_policy_paths: [...preflight.managed_policy_paths],
    }),
    ...(code === undefined ? {} : { failure_code: code }),
    ...(parameters !== undefined && "issue_code" in parameters && typeof parameters.issue_code === "string"
      ? { failure_issue_code: parameters.issue_code } : {}),
    ...(parameters !== undefined && "exit_class" in parameters && typeof parameters.exit_class === "string"
      ? { failure_exit_class: parameters.exit_class } : {}),
    ...(route.adapter !== "antigravity-cli" || channels === undefined ? {} : {
      adapter_result: antigravityOutputDiagnostics(channels.stdout),
    }),
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
  return createReviewDispatcher({ ...input, usage_context: {
    task_id: input.authority.task_id, phase_instance: input.phase_instance, attempt: input.authority.context.attempt,
  } }, (attemptId, route, preflight, error, telemetry) =>
    writeAttemptRecord(input, attemptId, route, preflight, error, telemetry));
}

/** CLI execution and disposable snapshots, independent of workflow authority or persistence. */
export function createReviewDispatcher(
  input: Pick<DispatchCoordinatorInput, "host" | "repository_root" | "signal" | "cancellation_source" | "repository_views" | "shared_workspace" | "usage_directory" | "usage_context">,
  observeAttempt?: (attemptId: string, route: DispatchRoute, preflight: CliPreflight | undefined,
    error: unknown, telemetry: AttemptTelemetry) => Promise<void>,
): ReturnType<typeof createDispatchCoordinator> {
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
      const childRoot = join(workspace.root, "children", attemptId);
      await mkdir(childRoot, { recursive: true, mode: 0o700 });
      const childWorkspace = Object.freeze({
        ...workspace,
        root: childRoot,
        env: Object.freeze({ ...workspace.env, TMPDIR: childRoot }),
      });
      const invocation = await adapter.buildInvocation(envelope, route, childWorkspace, outputSchema);
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
      const usage = route.adapter === "claude-cli" ? claudeDispatchUsage(childResult.stdout) : undefined;
      return Object.freeze({
        cli_version: preflight.cli_version,
        extracted_output_bytes: adapter.parseOutput(childResult),
        ...(usage === undefined ? {} : { usage }),
      });
    } catch (error) {
      primaryError = error;
      throw error;
    } finally {
      if (ownsWorkspace) await workspace?.dispose().catch(() => undefined);
      const channels = childResult ?? (primaryError instanceof DispatchProcessError ? primaryError.channels : undefined);
      const usage = route.adapter === "claude-cli" && channels !== undefined ? claudeDispatchUsage(channels.stdout) : undefined;
      const completedAt = new Date();
      await writeDispatchUsageRecord({
        schema_version: "1", dispatch_id: attemptId,
        started_at: startedAt.toISOString(), completed_at: completedAt.toISOString(),
        duration_ms: completedAt.getTime() - startedAt.getTime(), repository: input.repository_root,
        ...input.usage_context,
        adapter: route.adapter, model: route.model, effort: route.effort,
        ...(route.provider === undefined ? {} : { provider: route.provider }),
        ...(preflight === undefined ? {} : { cli_version: preflight.cli_version }),
        result_kind: envelope.result_kind, envelope_digest: envelope.digest, input_byte_count: envelope.byte_count,
        status: primaryError === undefined ? "succeeded" : "failed",
        ...(primaryError === undefined ? {} : { failure_stage: failureStage, failure_code: failureCode(primaryError) ?? "UNCLASSIFIED" }),
        ...(usage === undefined ? {} : { usage }),
      }, input.usage_directory);
      await observeAttempt?.(attemptId, route, preflight, primaryError, {
        started_at: startedAt.toISOString(),
        duration_ms: Date.now() - startedAt.getTime(),
        failure_stage: failureStage,
        child_result: childResult,
        result_kind: envelope.result_kind,
        envelope_digest: envelope.digest,
        input_byte_count: envelope.byte_count,
      })?.catch(() => undefined);
    }
  };
}

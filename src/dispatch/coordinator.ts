import { randomUUID } from "node:crypto";

import { canonicalJsonBytes, type GitOid } from "../contracts/canonical.js";
import type { HostIdentity } from "../contracts/hosts.js";
import { parseTaskPathClaim } from "../contracts/path-claims.js";
import type { PhaseInstanceId } from "../contracts/phase-instance.js";
import type { PlainJsonValue } from "../contracts/plain-json.js";
import type { DispatchEnvelope } from "../review/envelopes.js";
import { resolveTaskPath } from "../repository/paths.js";
import {
  CliAdapterError,
  exitClass,
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
import { createDispatchWorkspace, materializeRepositoryView } from "./workspace.js";
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
  allow_claude_dispatch: boolean;
  /**
   * When present, review dispatches get a read-only repository checkout at this commit as their
   * working directory. Adjudication envelopes never materialize a view: the adjudicator judges
   * exactly the sealed envelope.
   */
  repository_view_commit?: GitOid;
}>;

export type DispatchCoordinatorResult = Readonly<{
  cli_version: string;
  extracted_output_bytes: Uint8Array;
}>;

function failureCode(error: unknown): string | undefined {
  if (error instanceof CliAdapterError || error instanceof DispatchProcessError) {
    return error.project_error.code;
  }
  return undefined;
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
  child_result: DispatchChildResult | undefined;
}>;

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
  const target = await resolveTaskPath({
    runner: input.dependencies.runner,
    taskId: input.authority.task_id,
    claim: parseTaskPathClaim(`attempts/${input.phase_instance}/${attemptId}.json`),
    expectedClass: "attempt",
    context: input.authority.context,
  });
  if (!target.ok) return;

  const code = failureCode(error);
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
    status: "failed",
    started_at: telemetry.started_at,
    duration_ms: telemetry.duration_ms,
    ...(preflight === undefined ? {} : {
      cli_version: preflight.cli_version,
      managed_policy_present: preflight.managed_policy_present,
      managed_policy_paths: [...preflight.managed_policy_paths],
    }),
    ...(code === undefined ? {} : { failure_code: code }),
    ...(code === "CANCELLED" ? { cancellation_source: input.cancellation_source } : {}),
    ...(telemetry.child_result === undefined ? {} : { exit_class: exitClass(telemetry.child_result) }),
    ...(stdoutTail === "" ? {} : { stdout_tail: stdoutTail }),
    ...(stderrTail === "" ? {} : { stderr_tail: stderrTail }),
  } satisfies PlainJsonValue;
  await writer.replaceRegular(target.value, canonicalJsonBytes(record), false);
}

/** Assembles one fresh opposite-family CLI dispatch without acquiring the process-wide queue. */
export function createDispatchCoordinator(input: DispatchCoordinatorInput): (
  route: DispatchRoute,
  envelope: DispatchEnvelope,
  outputSchema: PlainJsonValue,
) => Promise<DispatchCoordinatorResult> {
  assertInternalTransactionAuthority(input.authority, {
    runner: input.dependencies.runner,
    environment: input.dependencies.environment,
  });

  return async (route, envelope, outputSchema) => {
    const adapter = selectCliAdapter(input.host, {
      allow_claude_dispatch: input.allow_claude_dispatch,
    });
    const attemptId = randomUUID();
    const startedAt = new Date();
    let preflight: CliPreflight | undefined;
    let primaryError: unknown;
    let childResult: DispatchChildResult | undefined;
    let workspace: Awaited<ReturnType<typeof createDispatchWorkspace>> | undefined;

    try {
      workspace = await createDispatchWorkspace(adapter.id, input.repository_root);
      if (input.repository_view_commit !== undefined && envelope.result_kind === "review") {
        workspace = await materializeRepositoryView(
          workspace,
          input.repository_root,
          input.repository_view_commit,
        );
      }
      preflight = await adapter.preflight(
        workspace,
        input.signal,
        input.cancellation_source,
      );
      const invocation = await adapter.buildInvocation(envelope, route, workspace, outputSchema);
      childResult = await runDispatchChild({
        ...invocation,
        signal: input.signal,
        cancellation_source: input.cancellation_source,
      });
      const failure = adapter.classifyFailure(childResult);
      if (failure !== undefined) throw new CliAdapterError(failure);
      return Object.freeze({
        cli_version: preflight.cli_version,
        extracted_output_bytes: adapter.parseOutput(childResult),
      });
    } catch (error) {
      primaryError = error;
      throw error;
    } finally {
      await workspace?.dispose().catch(() => undefined);
      if (primaryError !== undefined) {
        await writeAttemptRecord(input, attemptId, route, preflight, primaryError, {
          started_at: startedAt.toISOString(),
          duration_ms: Date.now() - startedAt.getTime(),
          child_result: childResult,
        }).catch(() => undefined);
      }
    }
  };
}

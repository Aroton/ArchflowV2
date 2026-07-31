import { randomUUID } from "node:crypto";

import { canonicalJsonBytes } from "../contracts/canonical.js";
import type { HostIdentity } from "../contracts/hosts.js";
import { parseTaskPathClaim } from "../contracts/path-claims.js";
import type { PhaseInstanceId } from "../contracts/phase-instance.js";
import type { PlainJsonValue } from "../contracts/plain-json.js";
import type { DispatchEnvelope } from "../review/envelopes.js";
import { resolveTaskPath } from "../repository/paths.js";
import {
  CliAdapterError,
  selectCliAdapter,
  type CliPreflight,
} from "./cli.js";
import {
  DispatchProcessError,
  runDispatchChild,
  type DispatchChildSpec,
} from "./process.js";
import type { DispatchRoute } from "./routing.js";
import { createDispatchWorkspace } from "./workspace.js";
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

async function writeAttemptRecord(
  input: DispatchCoordinatorInput,
  attemptId: string,
  route: DispatchRoute,
  preflight: CliPreflight | undefined,
  error: unknown,
): Promise<void> {
  const writer = input.dependencies.projection_writer;
  if (writer === undefined) return;

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
  const record = {
    schema_version: "1",
    attempt_id: attemptId,
    task_id: input.authority.task_id,
    phase_instance: input.phase_instance,
    adapter: route.adapter,
    family: route.family,
    model: route.model,
    effort: route.effort,
    cancellation_source: input.cancellation_source,
    status: error === undefined ? "succeeded" : "failed",
    ...(preflight === undefined ? {} : {
      cli_version: preflight.cli_version,
      managed_policy_present: preflight.managed_policy_present,
      managed_policy_paths: [...preflight.managed_policy_paths],
    }),
    ...(code === undefined ? {} : { failure_code: code }),
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
    let preflight: CliPreflight | undefined;
    let primaryError: unknown;
    let workspace: Awaited<ReturnType<typeof createDispatchWorkspace>> | undefined;

    try {
      workspace = await createDispatchWorkspace(adapter.id, input.repository_root);
      preflight = await adapter.preflight(
        workspace,
        input.signal,
        input.cancellation_source,
      );
      const invocation = await adapter.buildInvocation(envelope, route, workspace, outputSchema);
      const result = await runDispatchChild({
        ...invocation,
        signal: input.signal,
        cancellation_source: input.cancellation_source,
      });
      const failure = adapter.classifyFailure(result);
      if (failure !== undefined) throw new CliAdapterError(failure);
      return Object.freeze({
        cli_version: preflight.cli_version,
        extracted_output_bytes: adapter.parseOutput(result),
      });
    } catch (error) {
      primaryError = error;
      throw error;
    } finally {
      await workspace?.dispose().catch(() => undefined);
      await writeAttemptRecord(input, attemptId, route, preflight, primaryError).catch(() => undefined);
    }
  };
}

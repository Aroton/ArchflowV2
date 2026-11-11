import { writeDispatchUsageRecord } from "./usage-log.js";
import type { DispatchUsage } from "../contracts/dispatch-usage.js";
import { claudeDispatchUsage } from "./usage.js";
import { randomUUID } from "node:crypto";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";

import type { RepositoryName } from "../contracts/config.js";
import { createProjectError, type ProjectError } from "../contracts/errors.js";
import type { HostIdentity } from "../contracts/hosts.js";
import type { PlainJsonValue } from "../contracts/plain-json.js";
import type { DispatchEnvelope } from "../review/envelopes.js";
import {
  CliAdapterError,
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
import {
  createDispatchWorkspace,
  RepositoryViewMaterializationError,
  type SharedRepositoryViewWorkspace,
} from "./workspace.js";

export type ReviewDispatcherInput = Readonly<{
  host: HostIdentity;
  repository_root: string;
  /** Optional local destination for embedders/tests; installed bundles resolve their own home. */
  usage_directory?: string;
  signal: AbortSignal;
  cancellation_source: NonNullable<DispatchChildSpec["cancellation_source"]>;
  /**
   * Caller-owned lazily materialized workspace lent to every dispatch of one review; the
   * dispatcher borrows it and never disposes it — the owner disposes it after every child of the
   * call has settled. When absent each dispatch gets a fresh workspace with no repository.
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

type DispatchFailureStage =
  | "workspace-create"
  | "repository-view-materialization"
  | "cli-preflight"
  | "invocation-build"
  | "child-run"
  | "child-failure-classification"
  | "output-parse";

/** One fresh CLI dispatch of a sealed envelope against a route, returning the extracted output. */
export type ReviewDispatch = (
  route: DispatchRoute,
  envelope: DispatchEnvelope,
  outputSchema: PlainJsonValue,
) => Promise<DispatchCoordinatorResult>;

/** CLI execution and disposable snapshots, independent of workflow authority or persistence. */
export function createReviewDispatcher(
  input: ReviewDispatcherInput,
  // Test seam: the real-host tests record each failed attempt's route, preflight, and error.
  observeAttempt?: (attemptId: string, route: DispatchRoute, preflight: CliPreflight | undefined, error: unknown) => Promise<void>,
): ReviewDispatch {
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
        // every child of the call has settled.
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
        adapter: route.adapter, model: route.model, effort: route.effort,
        ...(route.provider === undefined ? {} : { provider: route.provider }),
        ...(preflight === undefined ? {} : { cli_version: preflight.cli_version }),
        result_kind: envelope.result_kind, envelope_digest: envelope.digest, input_byte_count: envelope.byte_count,
        status: primaryError === undefined ? "succeeded" : "failed",
        ...(primaryError === undefined ? {} : { failure_stage: failureStage, failure_code: failureCode(primaryError) ?? "UNCLASSIFIED" }),
        ...(usage === undefined ? {} : { usage }),
      }, input.usage_directory);
      await observeAttempt?.(attemptId, route, preflight, primaryError)?.catch(() => undefined);
    }
  };
}

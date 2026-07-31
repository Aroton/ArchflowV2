import { canonicalJsonDigest, sha256Bytes } from "../../contracts/canonical.js";
import type { InvocationContext } from "../../contracts/contexts.js";
import { createProjectError, type ProjectResult } from "../../contracts/errors.js";
import { parseSafeId } from "../../contracts/evidence.js";
import type { ParsedToolCall, ToolSuccess } from "../../contracts/mcp-tools.js";
import type { PlainJsonValue } from "../../contracts/plain-json.js";
import { createDispatchCoordinator } from "../../dispatch/coordinator.js";
import { openResolved, resolveTaskPath } from "../../repository/paths.js";
import { runCounterReview } from "../../review/counter-review.js";
import { prepareEvidenceResult } from "../../state/evidence-results.js";
import { mapHandlerErrors } from "./errors.js";
import { resolvePreDispatchReplay } from "./replay.js";
import { openHandlerSession } from "./session.js";

const fail = <T>(error: ReturnType<typeof createProjectError>): ProjectResult<T> =>
  Object.freeze({ schema_version: "1", ok: false, error });

function dispatchId(prefix: string, value: string): ReturnType<typeof parseSafeId> {
  return parseSafeId(`${prefix}-${sha256Bytes(new TextEncoder().encode(value)).slice(0, 32)}`);
}

export async function handleCounterReview(
  call: Extract<ParsedToolCall, { name: "archflow_counter_review" }>,
  context: InvocationContext,
): Promise<ProjectResult<ToolSuccess<"archflow_counter_review">>> {
  return mapHandlerErrors<"archflow_counter_review">(context.invocation_id, async () => {
    const session = await openHandlerSession(call, context);
    if (!session.ok) return session;
    const { services } = session.value;
    const state = services.state;
    if (state === undefined) {
      return fail(createProjectError("STATE_MISSING", { phase_instance: "prd" }));
    }
    const replay = await resolvePreDispatchReplay(
      services.dependencies,
      services.authority,
      call,
    );
    if (!replay.ok) return replay;
    if (replay.value !== undefined) {
      return Object.freeze({ schema_version: "1", ok: true, value: replay.value });
    }

    const artifactTarget = await resolveTaskPath({
      runner: services.runner,
      taskId: services.authority.task_id,
      claim: call.input.artifact_path,
      context: services.authority.context,
    });
    if (!artifactTarget.ok) return artifactTarget;
    let artifactBytes: Uint8Array;
    try {
      const handle = await openResolved(artifactTarget.value.absolute, 0);
      artifactBytes = new Uint8Array(await handle.readFile().finally(() => handle.close()));
    } catch {
      return fail(createProjectError("IO_ERROR", {
        operation: "counter-review-artifact-read",
        attempt: services.authority.context.attempt,
      }));
    }
    let artifact: string;
    try {
      artifact = new TextDecoder("utf-8", { fatal: true }).decode(artifactBytes);
    } catch {
      return fail(createProjectError("CONTRACT_INVALID", {
        tool: call.name,
        issue_code: "artifact-not-utf8",
      }));
    }

    const resultId = dispatchId("result", call.input.intent_id);
    const coordinator = createDispatchCoordinator({
      authority: services.authority,
      dependencies: services.dependencies,
      host: session.value.host,
      repository_root: services.runner.location.worktreeRoot,
      phase_instance: state.value.phase_instance,
      signal: context.signal,
      cancellation_source: "client",
      // Both producer directions are implemented; release authorization remains a separate gate.
      allow_claude_dispatch: true,
    });
    const retainedBytes = services.dependencies.read_retained_task_bytes;
    if (retainedBytes === undefined) throw new TypeError("retained byte accounting is unavailable");
    const result = await runCounterReview({
      transaction: services.dependencies,
      dispatch: coordinator,
      prepare_evidence: async (evidence, measuredAtRevision) => prepareEvidenceResult({
        authority: services.authority,
        runner: services.runner,
        result_id: resultId,
        retained_task_bytes: await retainedBytes(),
        measured_at_revision: measuredAtRevision,
        scanner: services.dependencies.gate_secret_scanner!,
        value: { kind: "review", evidence },
      }),
    }, {
      authority: services.authority,
      call,
      config: session.value.config,
      phase_kind: session.value.phase_kind,
      producer_family: session.value.producer_family,
      measured_at_revision: session.value.measured_at_revision,
      envelope: {
        artifact,
        rubric: call.input.rubric,
        subject: {
          task_id: services.authority.task_id,
          phase_instance: state.value.phase_instance,
          role: "counter-review",
          step: "counter_review",
          subject_digest: sha256Bytes(artifactBytes),
          input_fingerprint: call.input.input_fingerprint,
          rubric_digest: canonicalJsonDigest(call.input.rubric as unknown as PlainJsonValue),
          producer_family: session.value.producer_family,
          invocation_id: dispatchId("invocation", context.invocation_id),
          result_id: resultId,
        },
      },
    });
    if (!result.ok) return result;
    return Object.freeze({
      schema_version: "1",
      ok: true,
      value: result.value.transaction.outcome,
    });
  });
}

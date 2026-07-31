import { readFile } from "node:fs/promises";

import { describe, expect, it } from "vitest";

import { canonicalDocument, canonicalJsonDigest } from "../../src/contracts/canonical.js";
import {
  checkpointSelfDigest,
  parseManualCheckpointImport,
  type ManualCheckpointImportV1,
  type ManualCheckpointV1,
} from "../../src/contracts/durable-checkpoint.js";
import type { TaskStateV1 } from "../../src/contracts/durable-state.js";
import {
  createInternalResultExpectation,
  parseToolCall,
  validateProjectResultStructure,
} from "../../src/contracts/mcp-tools.js";
import { parseTaskPathClaim } from "../../src/contracts/path-claims.js";
import { planCheckpointAdoption } from "../../src/state/checkpoints.js";

const load = async <T>(name: string): Promise<T> => JSON.parse(
  await readFile(new URL(`../fixtures/contracts/durable/${name}`, import.meta.url), "utf8"),
) as T;

async function fixture(): Promise<{
  state: TaskStateV1;
  artifact: ManualCheckpointImportV1;
}> {
  const state = await load<TaskStateV1>("task-state.valid.json");
  delete (state as { adopted_checkpoint?: unknown }).adopted_checkpoint;
  delete (state as { committed_intent?: unknown }).committed_intent;
  delete (state as { open_gate?: unknown }).open_gate;
  const initial = await load<ManualCheckpointImportV1>("manual-checkpoint-import.valid.json");
  const template = structuredClone(initial.chain[1]!);
  delete (template as { predecessor?: unknown }).predecessor;
  const stateAnchor = {
    anchor_kind: "state" as const,
    state_revision: state.revision,
    state_digest: canonicalJsonDigest(state),
  };
  const first = {
    ...template,
    task_id: state.task_id,
    repository_identity_digest: state.repository_identity_digest,
    revision: state.revision + 1,
    initialization_digest: state.initialization_digest,
    phase_instance: state.phase_instance,
    step: state.step,
    status: "succeeded",
    attempt: state.attempt,
    input_fingerprint: state.input_fingerprint,
    authoritative_results: [
      ...state.authoritative_results,
      {
        phase_instance: state.phase_instance,
        step: state.step,
        result_digest: "d".repeat(64),
        result_id: "checkpoint-self-review",
        input_fingerprint: state.input_fingerprint,
        manifest_path: `.archflow/tasks/${state.task_id}/results/sha256/${"d".repeat(64)}/manifest.json`,
      },
    ],
    state_anchor: stateAnchor,
  } as unknown as ManualCheckpointV1;
  const second = {
    ...structuredClone(initial.chain[1]!),
    task_id: state.task_id,
    repository_identity_digest: state.repository_identity_digest,
    revision: first.revision + 1,
    initialization_digest: state.initialization_digest,
    phase_instance: state.phase_instance,
    step: "counter_review",
    status: "running",
    attempt: state.attempt,
    input_fingerprint: state.input_fingerprint,
    authoritative_results: structuredClone(first.authoritative_results),
    predecessor: { revision: first.revision, checkpoint_digest: checkpointSelfDigest(first) },
  } as ManualCheckpointV1;
  return {
    state,
    artifact: parseManualCheckpointImport({
      schema_version: "1",
      artifact_kind: "manual-checkpoint-import",
      task_id: state.task_id,
      repository_identity_digest: state.repository_identity_digest,
      import_mode: "state-anchored",
      state_anchor: stateAnchor,
      chain: [first, second],
    }),
  };
}

describe("whole-chain checkpoint adoption planner", () => {
  it("selects the exact head and advances state only once", async () => {
    const { state, artifact } = await fixture();
    const head = artifact.chain.at(-1)!;
    const call = parseToolCall("archflow_state", {
      schema_version: "1",
      task_id: state.task_id,
      intent_id: "checkpoint-adoption",
      expected_revision: state.revision,
      input_fingerprint: head.input_fingerprint,
      phase_instance: head.phase_instance,
      step: head.step,
      status: head.status,
      artifact,
    });
    const success = { path: parseTaskPathClaim("state.json"), revision: state.revision + 1, status: head.status };
    const expectation = createInternalResultExpectation({
      schema_version: "1",
      tool: "archflow_state",
      task_id: state.task_id,
      intent_id: call.input.intent_id,
      input_fingerprint: call.input.input_fingerprint,
      request_digest: "a".repeat(64) as never,
      result_id: "checkpoint-adoption",
      resulting_revision: success.revision,
      success,
    });
    const result = validateProjectResultStructure(call, { schema_version: "1", ok: true, value: success });
    const planned = planCheckpointAdoption({ current: canonicalDocument(state), call, expectation, result });
    expect(planned.ok, planned.ok ? undefined : JSON.stringify(planned.error.diagnostic)).toBe(true);
    if (!planned.ok) return;
    expect(planned.value.next_state.adopted_checkpoint).toEqual({
      revision: head.revision,
      checkpoint_digest: checkpointSelfDigest(head),
    });
    expect(success.revision).toBe(state.revision + 1);
    expect(head.revision).toBeGreaterThan(success.revision);
  });

  it("rejects stale state-anchor evidence", async () => {
    const { state, artifact } = await fixture();
    if (artifact.import_mode !== "state-anchored") throw new Error("expected state anchor");
    const staleFirst = { ...artifact.chain[0], state_anchor: { ...artifact.state_anchor, state_digest: "0".repeat(64) } } as ManualCheckpointV1;
    const staleSecond = {
      ...artifact.chain[1],
      predecessor: { revision: staleFirst.revision, checkpoint_digest: checkpointSelfDigest(staleFirst) },
    } as ManualCheckpointV1;
    const stale = parseManualCheckpointImport({
      ...artifact,
      state_anchor: { ...artifact.state_anchor, state_digest: "0".repeat(64) },
      chain: [staleFirst, staleSecond],
    });
    const head = stale.chain.at(-1)!;
    const call = parseToolCall("archflow_state", {
      schema_version: "1", task_id: state.task_id, intent_id: "stale-adoption",
      expected_revision: state.revision, input_fingerprint: head.input_fingerprint,
      phase_instance: head.phase_instance, step: head.step, status: head.status, artifact: stale,
    });
    const success = { path: parseTaskPathClaim("state.json"), revision: state.revision + 1, status: head.status };
    const expectation = createInternalResultExpectation({
      schema_version: "1", tool: "archflow_state", task_id: state.task_id,
      intent_id: call.input.intent_id, input_fingerprint: call.input.input_fingerprint,
      request_digest: "b".repeat(64) as never, result_id: "stale-adoption",
      resulting_revision: success.revision, success,
    });
    const result = validateProjectResultStructure(call, { schema_version: "1", ok: true, value: success });
    const planned = planCheckpointAdoption({ current: canonicalDocument(state), call, expectation, result });
    expect(planned.ok).toBe(false);
    if (!planned.ok) expect(planned.error.diagnostic.parameters).toMatchObject({ issue_code: "import-state-digest-mismatch" });
  });

  it("rejects the old per-step attempt reset during state-anchored adoption", async () => {
    const { state, artifact } = await fixture();
    const first = artifact.chain[0]!;
    const resetHead = {
      ...artifact.chain[1]!,
      attempt: 1,
      predecessor: {
        revision: first.revision,
        checkpoint_digest: checkpointSelfDigest(first),
      },
    } as ManualCheckpointV1;
    const reset = parseManualCheckpointImport({
      ...artifact,
      chain: [first, resetHead],
    });
    const call = parseToolCall("archflow_state", {
      schema_version: "1", task_id: state.task_id, intent_id: "attempt-reset-adoption",
      expected_revision: state.revision, input_fingerprint: resetHead.input_fingerprint,
      phase_instance: resetHead.phase_instance, step: resetHead.step,
      status: resetHead.status, artifact: reset,
    });
    const success = {
      path: parseTaskPathClaim("state.json"),
      revision: state.revision + 1,
      status: resetHead.status,
    };
    const expectation = createInternalResultExpectation({
      schema_version: "1", tool: "archflow_state", task_id: state.task_id,
      intent_id: call.input.intent_id, input_fingerprint: call.input.input_fingerprint,
      request_digest: "c".repeat(64) as never, result_id: "attempt-reset-adoption",
      resulting_revision: success.revision, success,
    });
    const result = validateProjectResultStructure(
      call,
      { schema_version: "1", ok: true, value: success },
    );
    const planned = planCheckpointAdoption({
      current: canonicalDocument(state), call, expectation, result,
    });
    expect(planned.ok).toBe(false);
    if (!planned.ok) {
      expect(planned.error).toMatchObject({
        code: "TRANSITION_INVALID",
        diagnostic: {
          parameters: {
            phase_instance: state.phase_instance,
            from: "self_review-succeeded",
            to: "counter_review-running",
          },
        },
      });
    }
  });
});

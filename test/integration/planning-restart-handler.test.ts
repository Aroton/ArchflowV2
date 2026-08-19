import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { canonicalDocument, sha256Bytes } from "../../src/contracts/canonical.js";
import { connectionContextFactory, createInvocationContext } from "../../src/contracts/contexts.js";
import { parseToolCall } from "../../src/contracts/mcp-tools.js";
import { parseSafeCode, parseSafeInteger } from "../../src/contracts/evidence.js";
import { handleState } from "../../src/mcp/handlers/state.js";
import { createProductionServices } from "../../src/state/production.js";
import { composeRequest } from "../../src/state/request-composition.js";
import { createTaskWorkspace, type TaskWorkspace } from "../helpers/task-workspace.js";

const workspaces: TaskWorkspace[] = [];
afterEach(() => { for (const workspace of workspaces.splice(0)) workspace.dispose(); });

function invocation(root: string, id: string) {
  const connection = connectionContextFactory.captureStartup({
    connection_id: `connection-${id}`,
    startup_repository_candidate: { working_directory: root },
  }).initialize({ client: { name: "Codex", version: "1" }, host: "codex", protocol_version: "2025-11-25" });
  return createInvocationContext(connection, {
    invocation_id: `invocation-${id}`,
    transport_metadata: { request_id: `request-${id}`, operation: "tools/call" },
  }, new AbortController().signal);
}

describe("planning restart state handler", () => {
  it("rejects stale calls without editing ask, restarts once, and authenticates exact replay", async () => {
    const workspace = await createTaskWorkspace({ taskId: "restart-handler", label: "restart-handler" });
    workspaces.push(workspace);
    const askPath = join(workspace.root, ".archflow", "tasks", String(workspace.taskId), "ask.md");
    writeFileSync(askPath, "Original ask\n");
    const originalAsk = readFileSync(askPath);
    const source = workspace.services.state!.value;
    const { last_transition: _lastTransition, ...sourceWithoutTransition } = source;
    const prepared = canonicalDocument({
      ...sourceWithoutTransition,
      revision: parseSafeInteger(10),
      phase_instance: "phase-impl-2",
      step: "triage",
      status: "succeeded",
      attempt: parseSafeInteger(1),
      planned_final_phase: parseSafeInteger(2),
      authoritative_results: [],
      approvals: [],
      waivers: [],
    });
    await workspace.services.dependencies.atomic.replace(workspace.services.authority.state, prepared.bytes);
    const servicesResult = await createProductionServices({ working_directory: workspace.root, task_id: workspace.taskId, operation: parseSafeCode("restart-test") });
    if (!servicesResult.ok || servicesResult.value.state === undefined) throw new Error("services unavailable");
    const services = servicesResult.value;
    const base = {
      schema_version: "1" as const,
      task_id: workspace.taskId,
      expected_revision: 10,
      input_fingerprint: "0".repeat(64),
      phase_instance: "phase-impl-2" as const,
      step: "produce" as const,
      status: "running" as const,
      operation: "planning_restart" as const,
      target_phase_instance: "prd" as const,
      reason: "Reconsider the public API boundary.",
      ask_base_digest: sha256Bytes(originalAsk),
    };
    const composed = await composeRequest(services, {
      kind: "planning-restart",
      intent_id: "restart-first",
      invocation: { skill: "archflow-prd", intent: "reopen" },
      reason: base.reason,
    });
    if (!composed.ok) throw new Error(composed.error.code);
    const envelope = composed.value.envelope;
    expect(envelope.request.input).toMatchObject({
      target_phase_instance: "prd",
      reason: base.reason,
      ask_base_digest: base.ask_base_digest,
    });

    const stale = parseToolCall("archflow_state", { ...base, intent_id: "restart-stale", expected_revision: 9, input_fingerprint: envelope.input_fingerprint });
    const staleResult = await handleState(stale, invocation(workspace.root, "stale"));
    expect(staleResult.ok).toBe(false);
    expect(readFileSync(askPath)).toEqual(originalAsk);

    const call = parseToolCall("archflow_state", envelope.request.input);
    const result = await handleState(call, invocation(workspace.root, "first"));
    expect(result.ok, JSON.stringify(result)).toBe(true);
    const appendedAsk = readFileSync(askPath);
    expect(appendedAsk.subarray(0, originalAsk.byteLength)).toEqual(originalAsk);
    expect(appendedAsk.toString("utf8")).toContain(base.reason);

    const replay = parseToolCall("archflow_state", { ...base, intent_id: "restart-replay", input_fingerprint: envelope.input_fingerprint });
    const replayResult = await handleState(replay, invocation(workspace.root, "replay"));
    expect(replayResult.ok).toBe(true);
    expect(readFileSync(askPath)).toEqual(appendedAsk);

    writeFileSync(askPath, Buffer.concat([appendedAsk, Buffer.from("unrelated tail\n")]));
    const changedAskReplay = await handleState(replay, invocation(workspace.root, "changed-ask"));
    expect(changedAskReplay.ok).toBe(false);
    writeFileSync(askPath, appendedAsk);

    const after = await createProductionServices({ working_directory: workspace.root, task_id: workspace.taskId, operation: parseSafeCode("restart-after") });
    if (!after.ok || after.value.state === undefined) throw new Error("restarted state unavailable");
    await after.value.dependencies.atomic.replace(after.value.authority.state, canonicalDocument({
      ...after.value.state.value,
      revision: parseSafeInteger(after.value.state.value.revision + 1),
    }).bytes);
    const lateReplay = await handleState(replay, invocation(workspace.root, "late"));
    expect(lateReplay.ok).toBe(false);
  });
});

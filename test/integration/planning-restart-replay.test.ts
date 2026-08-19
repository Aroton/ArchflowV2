import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { canonicalDocument, sha256Bytes } from "../../src/contracts/canonical.js";
import { connectionContextFactory, createInvocationContext } from "../../src/contracts/contexts.js";
import { parseSafeCode, parseSafeInteger } from "../../src/contracts/evidence.js";
import { parseToolCall } from "../../src/contracts/mcp-tools.js";
import { computeCallEnvelope } from "../../src/local/call-envelope.js";
import { handleState } from "../../src/mcp/handlers/state.js";
import { createProductionServices, type ProductionServices } from "../../src/state/production.js";
import { composeRequest } from "../../src/state/request-composition.js";
import { installPlanningRestartAskAppend } from "../../src/state/phase-documents.js";
import { planningRestartId } from "../../src/state/planning-restart.js";
import { resolveTaskPath } from "../../src/repository/paths.js";
import { parseTaskPathClaim } from "../../src/contracts/path-claims.js";
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

async function restartFixture(taskId: string): Promise<Readonly<{
  workspace: TaskWorkspace;
  services: ProductionServices;
  ask_path: string;
  original_ask: Buffer;
}>> {
  const workspace = await createTaskWorkspace({ taskId, label: taskId });
  workspaces.push(workspace);
  const askPath = join(workspace.root, ".archflow", "tasks", String(workspace.taskId), "ask.md");
  writeFileSync(askPath, "Original ask\n");
  const originalAsk = readFileSync(askPath);
  const source = workspace.services.state!.value;
  const { last_transition: _transition, ...withoutTransition } = source;
  await workspace.services.dependencies.atomic.replace(workspace.services.authority.state, canonicalDocument({
    ...withoutTransition,
    revision: parseSafeInteger(10),
    phase_instance: "phase-impl-2",
    step: "triage",
    status: "succeeded",
    attempt: parseSafeInteger(1),
    planned_final_phase: parseSafeInteger(2),
    authoritative_results: [],
    approvals: [],
    waivers: [],
  }).bytes);
  const reopened = await createProductionServices({
    working_directory: workspace.root,
    task_id: workspace.taskId,
    operation: parseSafeCode("restart-replay-test"),
  });
  if (!reopened.ok || reopened.value.state === undefined) throw new Error("restart services unavailable");
  return Object.freeze({ workspace, services: reopened.value, ask_path: askPath, original_ask: originalAsk });
}

describe("planning restart replay boundaries", () => {
  it("rejects stale PRD authority before editing ask, then authenticates exact state-and-ask replay", async () => {
    const fixture = await restartFixture("restart-prd-fingerprint");
    const draft = {
      schema_version: "1" as const,
      task_id: fixture.workspace.taskId,
      intent_id: `afop-${"a".repeat(64)}-reopen`,
      expected_revision: 10,
      input_fingerprint: "0".repeat(64),
      phase_instance: "phase-impl-2" as const,
      step: "produce" as const,
      status: "running" as const,
      operation: "planning_restart" as const,
      target_phase_instance: "prd" as const,
      reason: "Reconsider the public API boundary.",
      ask_base_digest: sha256Bytes(fixture.original_ask),
    };
    const envelope = await computeCallEnvelope(fixture.services, { tool: "archflow_state", input: draft });
    if (!envelope.ok) throw new Error(JSON.stringify(envelope.error));
    const call = parseToolCall("archflow_state", envelope.value.request.input);

    const stale = parseToolCall("archflow_state", {
      ...envelope.value.request.input as Record<string, unknown>,
      intent_id: "restart-prd-stale",
      expected_revision: 9,
    });
    const staleResult = await handleState(stale, invocation(fixture.workspace.root, "prd-stale"));
    expect(staleResult).toMatchObject({ ok: false, error: { code: "STATE_CONFLICT" } });
    expect(readFileSync(fixture.ask_path)).toEqual(fixture.original_ask);

    // Crash cut: the exact operation-bound ask append landed, but state/receipt did not.
    const askTarget = await resolveTaskPath({ runner: fixture.services.runner, taskId: fixture.workspace.taskId,
      claim: parseTaskPathClaim("ask.md"), expectedClass: "task-ask", context: fixture.services.authority.context });
    if (!askTarget.ok) throw new Error(askTarget.error.code);
    await installPlanningRestartAskAppend(fixture.services.dependencies.atomic, {
      target: askTarget.value,
      expected_base_digest: draft.ask_base_digest,
      restart_id: planningRestartId(envelope.value.request_digest, draft.intent_id),
      request: draft.reason,
    });

    const recomposed = await composeRequest(fixture.services, {
      kind: "planning-restart",
      intent_id: draft.intent_id,
      invocation: { skill: "archflow-prd", intent: "reopen" },
      reason: draft.reason,
    });
    if (!recomposed.ok) throw new Error(JSON.stringify(recomposed.error));
    expect(recomposed.value.envelope.request_digest).toBe(envelope.value.request_digest);
    const recomposedCall = parseToolCall("archflow_state", recomposed.value.envelope.request.input);
    const result = await handleState(recomposedCall, invocation(fixture.workspace.root, "prd"));
    expect(result.ok, JSON.stringify(result)).toBe(true);
    const appendedAsk = readFileSync(fixture.ask_path);
    expect(appendedAsk.subarray(0, fixture.original_ask.byteLength)).toEqual(fixture.original_ask);
    expect(appendedAsk.toString("utf8")).toContain(draft.reason);

    const after = await createProductionServices({
      working_directory: fixture.workspace.root,
      task_id: fixture.workspace.taskId,
      operation: parseSafeCode("restart-prd-after"),
    });
    if (!after.ok || after.value.state === undefined) throw new Error("restarted state unavailable");
    expect(after.value.state.value).toMatchObject({
      revision: 11,
      phase_instance: "prd",
      step: "produce",
      status: "running",
      attempt: 1,
      restart_history: [{
        source_phase_instance: "phase-impl-2",
        target_phase_instance: "prd",
        reason: draft.reason,
        restarted_at_revision: 11,
      }],
    });
    expect(after.value.state.value.planned_final_phase).toBeUndefined();

    const replayResult = await handleState(recomposedCall, invocation(fixture.workspace.root, "prd-replay"));
    expect(replayResult.ok, JSON.stringify(replayResult)).toBe(true);
    expect(readFileSync(fixture.ask_path)).toEqual(appendedAsk);
    const replayedState = await createProductionServices({
      working_directory: fixture.workspace.root,
      task_id: fixture.workspace.taskId,
      operation: parseSafeCode("restart-prd-replayed-state"),
    });
    if (!replayedState.ok || replayedState.value.state === undefined) throw new Error("replayed state unavailable");
    expect(replayedState.value.state.value.revision).toBe(11);

    for (const changed of [
      { ask_base_digest: "f".repeat(64) },
      { reason: "A different restart request." },
    ]) {
      const changedCall = parseToolCall("archflow_state", {
        ...envelope.value.request.input as Record<string, unknown>,
        ...changed,
      });
      const conflict = await handleState(changedCall, invocation(fixture.workspace.root, `changed-${Object.keys(changed)[0]}`));
      expect(conflict).toMatchObject({ ok: false, error: { code: "STATE_INVALID" } });
      expect(readFileSync(fixture.ask_path)).toEqual(appendedAsk);
    }

    const current = replayedState.value.state;
    await replayedState.value.dependencies.atomic.replace(replayedState.value.authority.state, canonicalDocument({
      ...current.value,
      revision: parseSafeInteger(12),
    }).bytes);
    const lateReplay = await handleState(call, invocation(fixture.workspace.root, "prd-late-replay"));
    expect(lateReplay).toMatchObject({
      ok: false,
      error: { code: "STATE_INVALID", diagnostic: { parameters: { issue_code: "planning-restart-replay-mismatch" } } },
    });
    expect(readFileSync(fixture.ask_path)).toEqual(appendedAsk);
  });

  it("restarts directly to design without changing ask and clears the stale final-phase plan", async () => {
    const fixture = await restartFixture("restart-design-handler");
    const draft = {
      schema_version: "1" as const,
      task_id: fixture.workspace.taskId,
      intent_id: "restart-design",
      expected_revision: 10,
      input_fingerprint: "0".repeat(64),
      phase_instance: "phase-impl-2" as const,
      step: "produce" as const,
      status: "running" as const,
      operation: "planning_restart" as const,
      target_phase_instance: "design" as const,
      reason: "Rework the internal service boundary.",
    };
    const envelope = await computeCallEnvelope(fixture.services, { tool: "archflow_state", input: draft });
    if (!envelope.ok) throw new Error(JSON.stringify(envelope.error));
    const result = await handleState(
      parseToolCall("archflow_state", envelope.value.request.input),
      invocation(fixture.workspace.root, "design"),
    );
    expect(result.ok, JSON.stringify(result)).toBe(true);
    expect(readFileSync(fixture.ask_path)).toEqual(fixture.original_ask);

    const after = await createProductionServices({
      working_directory: fixture.workspace.root,
      task_id: fixture.workspace.taskId,
      operation: parseSafeCode("restart-design-after"),
    });
    if (!after.ok || after.value.state === undefined) throw new Error("design restart state unavailable");
    expect(after.value.state.value).toMatchObject({
      revision: 11,
      phase_instance: "design",
      step: "produce",
      status: "running",
      attempt: 1,
      restart_history: [{ target_phase_instance: "design", reason: draft.reason }],
    });
    expect(after.value.state.value.planned_final_phase).toBeUndefined();
  });

});

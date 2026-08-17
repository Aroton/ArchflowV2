import { afterEach, describe, expect, it } from "vitest";

import { connectionContextFactory, createInvocationContext } from "../../src/contracts/contexts.js";
import { handleSemanticApply, handleSemanticStatus } from "../../src/mcp/handlers/semantic.js";
import { createTaskWorkspace, type TaskWorkspace } from "../helpers/task-workspace.js";

const workspaces: TaskWorkspace[] = [];
afterEach(() => { for (const workspace of workspaces.splice(0)) workspace.dispose(); });

function context(root: string) {
  const connection = connectionContextFactory.captureStartup({
    connection_id: "semantic-handler-connection",
    startup_repository_candidate: { working_directory: root },
  }).initialize({
    client: { name: "codex-mcp-client", version: "0.146.0" },
    host: "codex",
    protocol_version: "2025-11-25",
  });
  return createInvocationContext(connection, {
    invocation_id: "semantic-handler-invocation",
    transport_metadata: { request_id: "semantic-handler-request", operation: "tools/call" },
  }, new AbortController().signal);
}

describe("live semantic handlers", () => {
  it("keeps phase implementation descriptive and returns a fresh parity view on rejected apply", async () => {
    const workspace = await createTaskWorkspace({ taskId: "semantic-handler", label: "semantic-handler" });
    workspaces.push(workspace);
    const invocation = { skill: "archflow-phase-impl" as const, phase: 1, intent: "resume" as const };
    const authenticated = context(workspace.root);
    const status = await handleSemanticStatus({
      schema_version: "1", task_id: workspace.taskId, invocation,
    }, authenticated);
    expect(status.ok).toBe(true);
    if (!status.ok) return;
    expect(status.value.next_action.offer).toBeUndefined();
    expect(status.value.detail).toContain("legacy skill workflow");

    const applied = await handleSemanticApply({
      schema_version: "1", task_id: workspace.taskId, invocation,
      action: { offer: `af1_${"a".repeat(64)}` },
    }, authenticated);
    expect(applied).toMatchObject({
      ok: false,
      error: { code: "SEMANTIC_ACTION_UNSUPPORTED" },
      view: status.value,
    });
  });
});

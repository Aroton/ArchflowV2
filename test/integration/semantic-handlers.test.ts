import { afterEach, describe, expect, it } from "vitest";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

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
  it("preserves repository repair guidance through status and apply and resumes after correction", async () => {
    const workspace = await createTaskWorkspace({ taskId: "semantic-repair" });
    workspaces.push(workspace);
    const authenticated = context(workspace.root);
    const invocation = { skill: "archflow-prd", intent: "resume" } as const;
    const input = { schema_version: "1", task_id: workspace.taskId, invocation } as const;
    const before = await handleSemanticStatus(input, authenticated);
    expect(before.ok).toBe(true);
    if (!before.ok) return;
    const configPath = join(workspace.services.authority.task_root, "config.yaml");
    const statePath = join(workspace.services.authority.task_root, "state.json");
    const config = readFileSync(configPath, "utf8");
    const state = readFileSync(statePath, "utf8");
    writeFileSync(configPath, `${config}\nrepositories:\n  api:\n    path: ./missing-repository\n`);
    const refused = [
      await handleSemanticStatus(input, authenticated),
      await handleSemanticApply({ ...input, action: { offer: before.value.next_action.offer! } }, authenticated),
    ];
    for (const result of refused) {
      expect(result).toMatchObject({ ok: false, error: { code: "CONFIG_INVALID", retryable: false, recovery: { kind: "repair" } } });
      if (!result.ok) expect(result.error.message).toContain("repositories.api.path");
    }
    // Follow the returned repair: fix that config declaration, then read fresh status.
    writeFileSync(configPath, config);
    const resumed = await handleSemanticStatus(input, authenticated);
    expect(resumed).toEqual(before);
    expect(readFileSync(statePath, "utf8")).toBe(state);
    const diagnostic = await handleSemanticStatus({ ...input, detail: "diagnostic" }, authenticated);
    expect(diagnostic.ok).toBe(true);
    if (diagnostic.ok) {
      expect(diagnostic.value.next_action).toEqual(before.value.next_action);
      expect(diagnostic.value.progress).toBeDefined();
    }
  });

  it("admits the implementation invocation semantically and fails its unowned apply with a fresh parity view", async () => {
    const workspace = await createTaskWorkspace({ taskId: "semantic-handler", label: "semantic-handler" });
    workspaces.push(workspace);
    const invocation = { skill: "archflow-phase-impl" as const, phase: 1, intent: "resume" as const };
    const authenticated = context(workspace.root);
    const status = await handleSemanticStatus({
      schema_version: "1", task_id: workspace.taskId, invocation,
    }, authenticated);
    expect(status.ok).toBe(true);
    if (!status.ok) return;
    // The workspace sits at the PRD position, so this invocation owns nothing here — but the
    // refusal is ordinary non-ownership, never the removed legacy-workflow fence.
    expect(status.value.next_action.offer).toBeUndefined();
    expect(status.value.detail).not.toContain("legacy skill workflow");

    const applied = await handleSemanticApply({
      schema_version: "1", task_id: workspace.taskId, invocation,
      action: { offer: `af1_${"a".repeat(64)}` },
    }, authenticated);
    expect(applied).toMatchObject({
      ok: false,
      error: { code: "SEMANTIC_OFFER_STALE" },
      view: status.value,
    });
    if (applied.ok) return;
    expect(applied.error.message).not.toContain("legacy workflow");
  });
});

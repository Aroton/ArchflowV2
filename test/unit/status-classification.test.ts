import { rmSync, writeFileSync } from "node:fs";

import { afterEach, describe, expect, it } from "vitest";

import { runLocalCommand } from "../../src/local/commands.js";
import { createTaskWorkspace, type TaskWorkspace } from "../helpers/task-workspace.js";

/**
 * The manual-status command is the read-only outage window onto durable truth: it classifies the
 * durable state's readability and never invents progress. Three modes exist — normal (state
 * readable: delegate to the computed task status), degraded (state absent: wait for the server,
 * nothing records offline), and repair-required (state unreadable: report position, recommend
 * repair). The classification never throws; a broken state file is a classified answer, not a
 * crash.
 */

const workspaces: TaskWorkspace[] = [];
afterEach(() => { for (const workspace of workspaces.splice(0)) workspace.dispose(); });

async function classify(workspace: TaskWorkspace): Promise<Record<string, any>> {
  return await runLocalCommand({
    command: "manual-status",
    working_directory: workspace.root,
    task_id: workspace.taskId,
  }) as Record<string, any>;
}

describe("status classification", () => {
  it("status classification delegates to task status when durable state is readable", async () => {
    const workspace = await createTaskWorkspace({ taskId: "status-classify-normal", label: "status-classify-normal" });
    workspaces.push(workspace);

    const result = await classify(workspace);
    expect(result).toMatchObject({ ok: true, value: { mode: "normal" } });
    expect(result.value.task_status).toMatchObject({ task_id: workspace.taskId });
    // Exactly one server-derived next action, mirrored from the computed task status.
    expect(result.value.next_action).toMatchObject({ code: result.value.task_status.next_action.code });
    expect(result.value.next_action.commands).toEqual({
      claude: `/archflow-prd ${workspace.taskId}`,
      codex: `$archflow-prd ${workspace.taskId}`,
    });
  });

  it("status classification reports read-only wait guidance when durable state is absent", async () => {
    const workspace = await createTaskWorkspace({ taskId: "status-classify-absent", label: "status-classify-absent" });
    workspaces.push(workspace);
    rmSync(workspace.services.authority.state.absolute);

    const result = await classify(workspace);
    expect(result).toMatchObject({
      ok: true,
      value: {
        mode: "degraded",
        next_action: {
          code: "wait-for-server",
          detail: "No durable task state exists. The MCP server records all progress; when it is available, proceed through the workflow skills. No offline recording exists.",
          human_required: false,
        },
      },
    });
  });

  it("status classification reports repair-required when durable state is unreadable", async () => {
    const workspace = await createTaskWorkspace({ taskId: "status-classify-unreadable", label: "status-classify-unreadable" });
    workspaces.push(workspace);
    writeFileSync(workspace.services.authority.state.absolute, "{not canonical json");

    // Never throws: an unreadable state is a classified answer, not a crash.
    const result = await classify(workspace);
    expect(result).toMatchObject({ ok: true, value: { mode: "repair-required" } });
    expect(result.value.next_action).toBeDefined();
  });
});

import { afterEach, describe, expect, it } from "vitest";

import { canonicalDocument } from "../../src/contracts/canonical.js";
import { parseSafeCode } from "../../src/contracts/evidence.js";
import { createProductionServices } from "../../src/state/production.js";
import { computeAuthoritativeSemanticStatus } from "../../src/state/semantic-status.js";
import { createTaskWorkspace, type TaskWorkspace } from "../helpers/task-workspace.js";

const workspaces: TaskWorkspace[] = [];
afterEach(() => { for (const workspace of workspaces.splice(0)) workspace.dispose(); });

describe("authoritative semantic status", () => {
  it("assembles repository identity, durable state, and reopen facts from one owned read", async () => {
    const workspace = await createTaskWorkspace({ taskId: "semantic-status", label: "semantic-status" });
    workspaces.push(workspace);
    const result = await computeAuthoritativeSemanticStatus(workspace.services.dependencies, workspace.services.authority);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.repository_identity_digest).toBe(workspace.services.authority.repository_identity_digest);
    expect(result.value.state?.repository_identity_digest).toBe(result.value.repository_identity_digest);
    expect(result.value.full_findings).toEqual([]);
    expect(JSON.stringify(result.value.reopen_impacts)).not.toContain("request_digest");
  });

  it("fails closed when durable state is forged for another repository", async () => {
    const workspace = await createTaskWorkspace({ taskId: "semantic-forged", label: "semantic-forged" });
    workspaces.push(workspace);
    const state = workspace.services.state!;
    await workspace.services.dependencies.atomic.replace(workspace.services.authority.state, canonicalDocument({
      ...state.value,
      repository_identity_digest: "f".repeat(64),
    }).bytes);
    const reopened = await createProductionServices({
      working_directory: workspace.root,
      task_id: workspace.taskId,
      operation: parseSafeCode("semantic-status-test"),
    });
    expect(reopened.ok).toBe(true);
    if (!reopened.ok) return;
    await expect(computeAuthoritativeSemanticStatus(reopened.value.dependencies, reopened.value.authority))
      .rejects.toThrow(/repository identity/u);
  });
});

import { execFileSync } from "node:child_process";
import { writeFileSync } from "node:fs";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { connectionContextFactory, createInvocationContext } from "../../src/contracts/contexts.js";
import { parseToolCall } from "../../src/contracts/mcp-tools.js";
import { handleState } from "../../src/mcp/handlers/state.js";
import { runLocalCommand } from "../../src/local/commands.js";
import { createTaskWorkspace, type TaskWorkspace } from "../helpers/task-workspace.js";

const workspaces: TaskWorkspace[] = [];
afterEach(() => {
  for (const workspace of workspaces.splice(0)) workspace.dispose();
});

function invocation(root: string, id: string) {
  const connection = connectionContextFactory.captureStartup({
    connection_id: `commit-auth-${id}`,
    startup_repository_candidate: { working_directory: root },
  }).initialize({
    client: { name: "test-client", version: "1.0.0" },
    host: "codex",
    protocol_version: "2025-11-25",
  });
  return createInvocationContext(connection, {
    invocation_id: `commit-auth-${id}-invocation`,
    transport_metadata: { request_id: `commit-auth-${id}-request`, operation: "tools/call" },
  }, new AbortController().signal);
}

describe("archflow_state set_commit_authority operation", () => {
  it("updates milestone baseline and target head when specifying target_commit HEAD", async () => {
    const workspace = await createTaskWorkspace({ taskId: "set-commit-test", label: "set-commit-test" });
    workspaces.push(workspace);

    // Create a new commit in the workspace repository
    writeFileSync(join(workspace.root, "new-file.txt"), "external changes\n");
    execFileSync("git", ["add", "--", "new-file.txt"], { cwd: workspace.root });
    execFileSync("git", ["commit", "-m", "External merge commit"], { cwd: workspace.root });
    const newHead = execFileSync("git", ["rev-parse", "HEAD"], { cwd: workspace.root, encoding: "utf8" }).trim();

    const call = parseToolCall("archflow_state", {
      schema_version: "1",
      task_id: workspace.taskId,
      intent_id: "set-auth-1",
      expected_revision: workspace.services.state!.value.revision,
      input_fingerprint: workspace.services.state!.value.input_fingerprint,
      phase_instance: workspace.services.state!.value.phase_instance,
      step: "produce",
      status: "running",
      operation: "set_commit_authority",
      target_commit: "HEAD",
      reason: "Merged main branch into task working branch",
      scope: ["milestone"],
    });

    const result = await handleState(call, invocation(workspace.root, "set-auth-1"));
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(result.value.status).toBe("running");
    expect(result.value.revision).toBe(workspace.services.state!.value.revision + 1);

    // Read back durable state
    const reloaded = await workspace.services.dependencies.read_state(workspace.services.authority.state);
    expect(reloaded.kind).toBe("canonical");
    if (reloaded.kind !== "canonical") return;
    expect(reloaded.document.value.revision).toBe(result.value.revision);
  });

  it("updates policy_base_commit and constitution_digest when policy scope is specified", async () => {
    const workspace = await createTaskWorkspace({ taskId: "set-policy-test", label: "set-policy-test" });
    workspaces.push(workspace);

    // Create a commit
    writeFileSync(join(workspace.root, "policy-update.txt"), "policy changes\n");
    execFileSync("git", ["add", "--", "policy-update.txt"], { cwd: workspace.root });
    execFileSync("git", ["commit", "-m", "Policy commit update"], { cwd: workspace.root });
    const newHead = execFileSync("git", ["rev-parse", "HEAD"], { cwd: workspace.root, encoding: "utf8" }).trim();

    const call = parseToolCall("archflow_state", {
      schema_version: "1",
      task_id: workspace.taskId,
      intent_id: "set-policy-1",
      expected_revision: workspace.services.state!.value.revision,
      input_fingerprint: workspace.services.state!.value.input_fingerprint,
      phase_instance: workspace.services.state!.value.phase_instance,
      step: "produce",
      status: "running",
      operation: "set_commit_authority",
      target_commit: newHead,
      reason: "Updated constitution baseline commit",
      scope: ["policy"],
    });

    const result = await handleState(call, invocation(workspace.root, "set-policy-1"));
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const reloaded = await workspace.services.dependencies.read_state(workspace.services.authority.state);
    expect(reloaded.kind).toBe("canonical");
    if (reloaded.kind !== "canonical") return;
    expect(reloaded.document.value.policy_base_commit).toBe(newHead);
    expect(reloaded.document.value.constitution_digest).toBeDefined();
  });

  it("fails with target-commit-unresolvable if commit does not exist", async () => {
    const workspace = await createTaskWorkspace({ taskId: "set-bad-commit-test", label: "set-bad-commit-test" });
    workspaces.push(workspace);

    const call = parseToolCall("archflow_state", {
      schema_version: "1",
      task_id: workspace.taskId,
      intent_id: "set-bad-1",
      expected_revision: workspace.services.state!.value.revision,
      input_fingerprint: workspace.services.state!.value.input_fingerprint,
      phase_instance: workspace.services.state!.value.phase_instance,
      step: "produce",
      status: "running",
      operation: "set_commit_authority",
      target_commit: "0".repeat(40),
      reason: "Invalid non-existent commit",
    });

    const result = await handleState(call, invocation(workspace.root, "set-bad-1"));
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.diagnostic.parameters).toMatchObject({
      issue_code: "target-commit-unresolvable",
    });
  });

  it("replays the exact set_commit_authority intent idempotently", async () => {
    const workspace = await createTaskWorkspace({ taskId: "set-replay-test", label: "set-replay-test" });
    workspaces.push(workspace);

    const call = parseToolCall("archflow_state", {
      schema_version: "1",
      task_id: workspace.taskId,
      intent_id: "set-replay-1",
      expected_revision: workspace.services.state!.value.revision,
      input_fingerprint: workspace.services.state!.value.input_fingerprint,
      phase_instance: workspace.services.state!.value.phase_instance,
      step: "produce",
      status: "running",
      operation: "set_commit_authority",
      target_commit: "HEAD",
      reason: "Re-anchor to current HEAD",
    });

    const first = await handleState(call, invocation(workspace.root, "first"));
    expect(first.ok).toBe(true);
    if (!first.ok) return;

    const replay = await handleState(call, invocation(workspace.root, "replay"));
    expect(replay.ok).toBe(true);
    if (!replay.ok) return;
    expect(replay.value.revision).toBe(first.value.revision);
    expect(replay.value.request_digest).toBe(first.value.request_digest);
  });

  it("executes set-commit-authority via archflow-local runLocalCommand", async () => {
    const workspace = await createTaskWorkspace({ taskId: "set-cli-test", label: "set-cli-test" });
    workspaces.push(workspace);

    const result = await runLocalCommand({
      command: "set-commit-authority",
      working_directory: workspace.root,
      task_id: workspace.taskId,
      value: {
        target_commit: "HEAD",
        reason: "Re-anchor from CLI",
        scope: ["milestone"],
      },
    }) as { ok: boolean; value: { revision: number; status: string } };

    expect(result.ok).toBe(true);
    expect(result.value.status).toBe("running");
  });
});

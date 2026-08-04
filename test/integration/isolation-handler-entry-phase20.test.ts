import { existsSync, mkdirSync, renameSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { connectionContextFactory, createInvocationContext } from "../../src/contracts/contexts.js";
import { parseSafeId } from "../../src/contracts/evidence.js";
import { parseTaskPathClaim } from "../../src/contracts/path-claims.js";
import { buildDocumentArtifact } from "../../src/state/document-artifact.js";
import { createToolHandlers } from "../../src/mcp/handlers/index.js";
import { createToolBoundary } from "../../src/mcp/server.js";
import { createTaskWorkspace, type TaskWorkspace } from "../helpers/task-workspace.js";

const workspaces: TaskWorkspace[] = [];
const escapedTargets: string[] = [];
afterEach(() => {
  for (const workspace of workspaces.splice(0)) workspace.dispose();
  for (const target of escapedTargets.splice(0)) rmSync(target, { force: true });
});

const RUBRIC = {
  schema_version: "1",
  kind: "implementation",
  mode: "adversarial",
  criteria: [{ id: "isolation", text: "The artifact remains task-contained.", blocking: true }],
} as const;

function invocation(root: string, id: string) {
  const connection = connectionContextFactory.captureStartup({
    connection_id: `phase20-${id}`,
    startup_repository_candidate: { working_directory: root },
  }).initialize({
    client: { name: "codex-mcp-client", version: "0.146.0" },
    host: "codex",
    protocol_version: "2025-11-25",
  });
  return createInvocationContext(connection, {
    invocation_id: `phase20-${id}-invocation`,
    transport_metadata: { request_id: `phase20-${id}-request`, operation: "tools/call" },
  }, new AbortController().signal);
}

async function fixture(): Promise<Readonly<{
  workspace: TaskWorkspace;
  args: Record<string, unknown>;
}>> {
  const workspace = await createTaskWorkspace({ taskId: "handler-isolation", label: "handler-isolation" });
  workspaces.push(workspace);
  const state = workspace.services.state;
  if (state === undefined) throw new Error("initialized state unavailable");
  const documentPath = parseTaskPathClaim("prd.md");
  writeFileSync(join(workspace.services.authority.task_root, documentPath), "Approved PRD\n");
  const artifact = await buildDocumentArtifact(workspace.services.runner, workspace.services.authority, {
    phase_instance: state.value.phase_instance,
    step: "produce",
    document_path: documentPath,
    declared_inputs: [],
    input_fingerprint: state.value.input_fingerprint,
  });
  if (!artifact.ok) throw new Error(artifact.error.code);
  const boundary = createToolBoundary(createToolHandlers());
  const produced = await boundary.invoke("archflow_state", {
    schema_version: "1",
    task_id: workspace.taskId,
    intent_id: "handler-isolation-produce",
    expected_revision: state.value.revision,
    input_fingerprint: state.value.input_fingerprint,
    phase_instance: state.value.phase_instance,
    step: "produce",
    status: "succeeded",
    artifact: artifact.value,
  }, invocation(workspace.root, "produce"));
  expect(produced).toMatchObject({ kind: "project-result", result: { ok: true } });
  return {
    workspace,
    args: {
      schema_version: "1",
      task_id: workspace.taskId,
      intent_id: "handler-isolation-review",
      expected_revision: state.value.revision + 1,
      input_fingerprint: state.value.input_fingerprint,
      artifact_path: "prd.md",
      rubric: RUBRIC,
    },
  };
}

describe("Phase 20 isolation through the real MCP handler entry", () => {
  it.each([
    ["traversal", "../outside.md"],
    ["absolute", "/tmp/outside.md"],
  ] as const)("rejects a %s claim at the contract boundary before task reads or dispatch", async (_label, artifactPath) => {
    const { workspace, args } = await fixture();
    const config = join(workspace.services.authority.task_root, "config.yaml");
    renameSync(config, `${config}.hidden`);
    const outcome = await createToolBoundary(createToolHandlers()).invoke(
      "archflow_counter_review",
      { ...args, artifact_path: artifactPath },
      invocation(workspace.root, artifactPath.startsWith("/") ? "absolute" : "traversal"),
    );
    expect(outcome).toMatchObject({
      kind: "project-result",
      result: { ok: false, error: { code: "CONTRACT_INVALID", diagnostic: { parameters: { issue_code: "input-invalid" } } } },
    });
    expect(existsSync(join(workspace.services.authority.task_root, "attempts"))).toBe(false);
  });

  it.each([
    ["symlink escape", "phases/1/design.md", "outside.md", "PATH_ESCAPE"],
    ["cross-task access", "phases/2/design.md", ".archflow/tasks/other-task/secret.md", "TASK_SCOPE_VIOLATION"],
  ] as const)("rejects %s before reading the target or dispatching", async (_label, artifactPath, target, code) => {
    const { workspace, args } = await fixture();
    if (code === "PATH_ESCAPE") {
      const escapedTarget = `${workspace.root}-${target}`;
      escapedTargets.push(escapedTarget);
      writeFileSync(escapedTarget, "outside canary\n");
      mkdirSync(join(workspace.services.authority.task_root, "phases", "1"), { recursive: true });
      symlinkSync(escapedTarget, join(workspace.services.authority.task_root, artifactPath));
    } else {
      const sibling = join(workspace.root, ".archflow", "tasks", "other-task");
      mkdirSync(sibling, { recursive: true });
      writeFileSync(join(sibling, "secret.md"), "sibling canary\n");
      mkdirSync(join(workspace.services.authority.task_root, "phases", "2"), { recursive: true });
      symlinkSync(join(workspace.root, target), join(workspace.services.authority.task_root, artifactPath));
    }
    const outcome = await createToolBoundary(createToolHandlers()).invoke(
      "archflow_counter_review",
      { ...args, intent_id: parseSafeId(`handler-${code.toLowerCase().replaceAll("_", "-")}`), artifact_path: artifactPath },
      invocation(workspace.root, code.toLowerCase().replaceAll("_", "-")),
    );
    expect(outcome).toMatchObject({ kind: "project-result", result: { ok: false, error: { code } } });
    expect(existsSync(join(workspace.services.authority.task_root, "attempts"))).toBe(false);
  });
});

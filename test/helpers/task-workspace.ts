/**
 * The reusable real task-workspace harness for focused service and integration tests.
 *
 * Test helpers normally know nothing about `src/**`, so fixture defects cannot be mistaken for
 * source defects. This is the deliberate second exception (after `resolved-constitution.ts`): it
 * builds a real initialized task capability from `src/**` and returns the production services that
 * capability authorizes.
 */

import { execFileSync } from "node:child_process";
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { TaskInitializationV1 } from "../../src/contracts/durable-task-initialization.js";
import { parseSafeCode, parseSha256Digest, parseTaskSlug, type TaskSlug } from "../../src/contracts/evidence.js";
import { parseToolCall } from "../../src/contracts/mcp-tools.js";
import { scaffoldRepositoryAssets } from "../../src/init/assets.js";
import { stageTaskInitialization } from "../../src/init/task-initialization.js";
import { computeCallEnvelope } from "../../src/local/envelope.js";
import { runStateInitialization } from "../../src/state/initialization.js";
import { createProductionServices, type ProductionServices } from "../../src/state/production.js";

export type TaskWorkspaceOptions = Readonly<{
  taskId: string;
  label?: string;
  operation?: string;
}>;

export type TaskWorkspace = Readonly<{
  root: string;
  taskId: TaskSlug;
  initialization: TaskInitializationV1;
  services: ProductionServices;
  dispose: () => void;
}>;

const GIT_ENVIRONMENT: NodeJS.ProcessEnv = {
  ...process.env,
  GIT_CONFIG_GLOBAL: "/dev/null",
  GIT_CONFIG_SYSTEM: "/dev/null",
  GIT_AUTHOR_NAME: "ArchFlow Test",
  GIT_AUTHOR_EMAIL: "test@example.invalid",
  GIT_COMMITTER_NAME: "ArchFlow Test",
  GIT_COMMITTER_EMAIL: "test@example.invalid",
};

function git(root: string, ...arguments_: readonly string[]): string {
  return execFileSync("git", [...arguments_], {
    cwd: root,
    env: GIT_ENVIRONMENT,
    encoding: "utf8",
  }).trim();
}

/** Creates a committed policy base, initializes its task, and opens production services. */
export async function createTaskWorkspace(options: TaskWorkspaceOptions): Promise<TaskWorkspace> {
  const taskId = parseTaskSlug(options.taskId);
  const operation = parseSafeCode(options.operation ?? "task-workspace");
  const label = parseSafeCode(options.label ?? "task-workspace");
  const root = realpathSync(mkdtempSync(join(tmpdir(), `archflow-${label}-`)));
  const dispose = (): void => rmSync(root, { recursive: true, force: true });

  try {
    git(root, "-c", "init.defaultBranch=main", "init", "-q");
    writeFileSync(join(root, "README.md"), "repository\n");
    git(root, "add", "--", "README.md");
    git(root, "commit", "-q", "-m", "root");

    const scaffolded = await scaffoldRepositoryAssets({ working_directory: root });
    if (!scaffolded.ok) throw new Error(scaffolded.error.code);
    git(root, "add", "--", ".gitattributes", ".archflow/workflow.yaml", ".archflow/constitution", ".archflow/config.yaml");
    git(root, "commit", "-q", "-m", "approve policy");

    const staged = await stageTaskInitialization({ working_directory: root, task_id: taskId });
    if (!staged.ok) throw new Error(staged.error.code);
    const bootstrap = await createProductionServices({ working_directory: root, task_id: taskId, operation });
    if (!bootstrap.ok) throw new Error(bootstrap.error.code);
    const draft = {
      schema_version: "1" as const,
      task_id: taskId,
      intent_id: "initialize-task-workspace",
      expected_revision: 0,
      input_fingerprint: parseSha256Digest("0".repeat(64)),
      phase_instance: "prd" as const,
      step: "produce" as const,
      status: "running" as const,
      artifact: staged.value,
    };
    const envelope = await computeCallEnvelope(bootstrap.value, { tool: "archflow_state", input: draft });
    if (!envelope.ok) throw new Error(envelope.error.code);
    const call = parseToolCall("archflow_state", {
      ...draft,
      input_fingerprint: envelope.value.input_fingerprint,
    });
    const initialized = await runStateInitialization(bootstrap.value.dependencies, {
      authority: bootstrap.value.authority,
      call,
    });
    if (!initialized.ok) throw new Error(initialized.error.code);

    const production = await createProductionServices({ working_directory: root, task_id: taskId, operation });
    if (!production.ok || production.value.state === undefined) {
      throw new Error(production.ok ? "initialized task state unavailable" : production.error.code);
    }
    return Object.freeze({ root, taskId, initialization: staged.value, services: production.value, dispose });
  } catch (error) {
    dispose();
    throw error;
  }
}

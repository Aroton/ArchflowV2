import { spawn, spawnSync, execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";

import { scaffoldRepositoryAssets } from "../../src/init/assets.js";
import { stageTaskInitialization } from "../../src/init/task-initialization.js";
import {
  buildAutomationLocalBundle,
  runAutomationStatus,
  snapshotDirectory,
} from "../helpers/automation-status.js";
import { createTaskWorkspace, type TaskWorkspace } from "../helpers/task-workspace.js";

const TIMEOUT = 60_000;
const PROCESS_TIMEOUT = 5_000;
const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const gitEnvironment: NodeJS.ProcessEnv = {
  ...process.env,
  GIT_CONFIG_GLOBAL: "/dev/null",
  GIT_CONFIG_SYSTEM: "/dev/null",
  GIT_AUTHOR_NAME: "ArchFlow Test",
  GIT_AUTHOR_EMAIL: "test@example.invalid",
  GIT_COMMITTER_NAME: "ArchFlow Test",
  GIT_COMMITTER_EMAIL: "test@example.invalid",
};

let bundleRoot = "";
let localBundle = "";
const roots: string[] = [];
const workspaces: TaskWorkspace[] = [];

beforeAll(async () => {
  bundleRoot = await mkdtemp(join(tmpdir(), "archflow-automation-cli-bundle-"));
  localBundle = join(bundleRoot, "archflow-local.mjs");
  buildAutomationLocalBundle(repositoryRoot, localBundle);
}, TIMEOUT);

afterEach(() => {
  for (const workspace of workspaces.splice(0)) workspace.dispose();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

afterAll(async () => {
  if (bundleRoot !== "") await rm(bundleRoot, { recursive: true, force: true });
});

function git(root: string, ...arguments_: readonly string[]): string {
  return execFileSync("git", [...arguments_], { cwd: root, env: gitEnvironment, encoding: "utf8" }).trim();
}

async function stagedNewTask(taskId: string): Promise<string> {
  const root = mkdtempSync(join(tmpdir(), "archflow-automation-new-task-"));
  roots.push(root);
  git(root, "-c", "init.defaultBranch=main", "init", "-q");
  writeFileSync(join(root, "README.md"), "repository\n");
  git(root, "add", "--", "README.md");
  git(root, "commit", "-q", "-m", "root");
  const scaffolded = await scaffoldRepositoryAssets({ working_directory: root });
  if (!scaffolded.ok) throw new Error(scaffolded.error.code);
  git(root, "add", "--", ".gitattributes", ".archflow/.gitignore", ".archflow/workflow.yaml", ".archflow/constitution", ".archflow/config.yaml");
  git(root, "commit", "-q", "-m", "policy");
  const staged = await stageTaskInitialization({ working_directory: root, task_id: taskId });
  if (!staged.ok) throw new Error(staged.error.code);
  return root;
}

describe("automation status CLI", { timeout: TIMEOUT }, () => {
  it("classifies the first poll as PRD-owned without creating durable state", async () => {
    const taskId = "automation-first-poll";
    const root = await stagedNewTask(taskId);
    const before = snapshotDirectory(join(root, ".archflow"));

    const result = runAutomationStatus(localBundle, root, taskId, gitEnvironment);

    expect(result.status, result.stderr).toBe(0);
    expect(result.observation).toMatchObject({
      schema_version: "1",
      task_id: taskId,
      state_revision: null,
      condition: "awaiting-client",
      position: { kind: "prd" },
      next_action: {
        actor: "skill",
        kind: "continue-skill",
        skill: "archflow-prd",
        task_id: taskId,
        skill_args: [],
      },
    });
    expect(result.observation?.observation_id).toMatch(/^[a-f0-9]{64}$/u);
    expect(result.observation).not.toHaveProperty("human_boundary");
    expect(result.observation).not.toHaveProperty("blocked");
    expect(snapshotDirectory(join(root, ".archflow"))).toEqual(before);

    const configPath = join(root, ".archflow", "tasks", taskId, "config.yaml");
    writeFileSync(configPath, `${readFileSync(configPath, "utf8")}# before-state controller edit\n`);
    const afterEdit = snapshotDirectory(join(root, ".archflow"));
    const changed = runAutomationStatus(localBundle, root, taskId, gitEnvironment);
    expect(changed.status, changed.stderr).toBe(0);
    expect(changed.observation?.observation_id).not.toBe(result.observation?.observation_id);
    expect(changed.observation?.state_revision).toBeNull();
    expect(snapshotDirectory(join(root, ".archflow"))).toEqual(afterEdit);
  });

  it("keeps identical polls byte-for-byte inert and changes identity for live config", async () => {
    const workspace = await createTaskWorkspace({
      taskId: "automation-poll-safety",
      label: "automation-poll-safety",
    });
    workspaces.push(workspace);
    const archflowRoot = join(workspace.root, ".archflow");
    const before = snapshotDirectory(archflowRoot);

    const first = runAutomationStatus(localBundle, workspace.root, workspace.taskId, gitEnvironment);
    const second = runAutomationStatus(localBundle, workspace.root, workspace.taskId, gitEnvironment);

    expect(first.status, first.stderr).toBe(0);
    expect(second.status, second.stderr).toBe(0);
    expect(second.observation).toEqual(first.observation);
    expect(snapshotDirectory(archflowRoot)).toEqual(before);

    const configPath = workspace.services.authority.config.absolute;
    writeFileSync(configPath, `${readFileSync(configPath, "utf8")}# controller-relevant live edit\n`);
    const afterEdit = snapshotDirectory(archflowRoot);
    const changed = runAutomationStatus(localBundle, workspace.root, workspace.taskId, gitEnvironment);

    expect(changed.status, changed.stderr).toBe(0);
    expect(changed.observation?.observation_id).not.toBe(first.observation?.observation_id);
    expect(changed.observation?.state_revision).toBe(first.observation?.state_revision);
    expect(snapshotDirectory(archflowRoot)).toEqual(afterEdit);
  });

  it("keeps current and incompatible legacy import staging as distinct operator blocks", async () => {
    const taskId = "automation-import-stage";
    const root = await stagedNewTask(taskId);
    const digest = "a".repeat(64);
    const stageRoot = join(root, ".archflow", "runtime", "tasks", taskId, "cache", "imports", digest);
    const descriptor = join(stageRoot, "stage.json");
    mkdirSync(stageRoot, { recursive: true });
    writeFileSync(descriptor, JSON.stringify({
      schema_version: "1",
      task_id: taskId,
      import_digest: digest,
      preview_digest: "b".repeat(64),
      manifest_path: `.archflow/runtime/tasks/${taskId}/cache/imports/${digest}/manifest.json`,
      resume_phase: "phase-impl-2",
    }));

    const current = runAutomationStatus(localBundle, root, taskId, gitEnvironment);
    expect(current.status, current.stderr).toBe(0);
    expect(current.observation).toMatchObject({
      condition: "blocked",
      state_revision: null,
      position: null,
      next_action: { actor: "operator", kind: "repair" },
      blocked: { category: "legacy-upgrade-staged" },
    });
    expect(current.observation).not.toHaveProperty("ok");

    const configPath = join(root, ".archflow", "tasks", taskId, "config.yaml");
    writeFileSync(configPath, `${readFileSync(configPath, "utf8")}# staged-task controller edit\n`);
    const afterEdit = snapshotDirectory(join(root, ".archflow"));
    const changed = runAutomationStatus(localBundle, root, taskId, gitEnvironment);
    expect(changed.status, changed.stderr).toBe(0);
    expect(changed.observation).toMatchObject({
      condition: "blocked",
      state_revision: null,
      blocked: { category: "legacy-upgrade-staged" },
    });
    expect(changed.observation?.observation_id).not.toBe(current.observation?.observation_id);
    expect(snapshotDirectory(join(root, ".archflow"))).toEqual(afterEdit);

    const injection = `phase-impl-2-${"INJECTED".repeat(2_000)}`;
    const malformed = [
      {
        schema_version: "2", task_id: taskId, import_digest: digest,
        preview_digest: "b".repeat(64),
        manifest_path: `.archflow/runtime/tasks/${taskId}/cache/imports/${digest}/manifest.json`,
        resume_phase: "phase-impl-2",
      },
      {
        schema_version: "1", task_id: taskId, import_digest: digest,
        preview_digest: "bad-preview",
        manifest_path: "/absolute/manifest.json",
        resume_phase: injection,
      },
    ];
    for (const value of malformed) {
      writeFileSync(descriptor, JSON.stringify(value));
      const before = snapshotDirectory(join(root, ".archflow"));
      const rejected = runAutomationStatus(localBundle, root, taskId, gitEnvironment);
      expect(rejected.status, rejected.stderr).toBe(0);
      expect(rejected.observation).toMatchObject({
        condition: "blocked",
        state_revision: null,
        position: null,
        next_action: { actor: "operator", kind: "repair" },
        blocked: { category: "legacy-upgrade-restart-required" },
      });
      expect(rejected.stdout).not.toContain("INJECTED");
      expect(rejected.stdout.length).toBeLessThan(2_000);
      expect(snapshotDirectory(join(root, ".archflow"))).toEqual(before);
    }

    rmSync(descriptor);
    const incompatible = runAutomationStatus(localBundle, root, taskId, gitEnvironment);
    expect(incompatible.status, incompatible.stderr).toBe(0);
    expect(incompatible.observation).toMatchObject({
      condition: "blocked",
      state_revision: null,
      position: null,
      next_action: { actor: "operator", kind: "repair" },
      blocked: { category: "legacy-upgrade-restart-required" },
    });
    expect(incompatible.observation?.observation_id).not.toBe(current.observation?.observation_id);
  });

  it("returns unreadable durable state as a valid positionless blocked observation", async () => {
    const workspace = await createTaskWorkspace({
      taskId: "automation-unreadable-state",
      label: "automation-unreadable-state",
    });
    workspaces.push(workspace);
    writeFileSync(workspace.services.authority.state.absolute, JSON.stringify({
      revision: 71,
      phase_instance: "phase-impl-9",
      step: "review",
      status: "running",
    }));

    const result = runAutomationStatus(localBundle, workspace.root, workspace.taskId, gitEnvironment);
    expect(result.status, result.stderr).toBe(0);
    expect(result.observation).toMatchObject({
      condition: "blocked",
      state_revision: null,
      position: null,
      next_action: { actor: "operator", kind: "repair" },
      blocked: {
        category: "state-unreadable",
        reasons: ["Durable task state exists but is not readable canonical authority."],
      },
    });
    expect(result.observation).not.toHaveProperty("ok");
  });

  it("never waits for stdin and emits one structured failure document for bad arguments", async () => {
    const child = spawn(process.execPath, [localBundle, "automation-status"], {
      cwd: repositoryRoot,
      stdio: ["pipe", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => { stdout += chunk; });
    child.stderr.on("data", (chunk: string) => { stderr += chunk; });

    const result = await new Promise<Readonly<{ code: number | null; signal: NodeJS.Signals | null }>>((resolveResult, reject) => {
      const timer = setTimeout(() => {
        child.kill("SIGKILL");
        reject(new Error("automation-status waited for stdin"));
      }, PROCESS_TIMEOUT);
      child.once("error", reject);
      child.once("exit", (code, signal) => {
        clearTimeout(timer);
        resolveResult({ code, signal });
      });
    });

    expect(result).toEqual({ code: 1, signal: null });
    expect(JSON.parse(stdout)).toMatchObject({ schema_version: "1", ok: false, error: { code: expect.any(String) } });
    expect(stderr).toContain("automation-status requires --task <task>");
    child.stdin.destroy();

    const payload = spawnSync(process.execPath, [
      localBundle,
      "automation-status",
      "--task",
      "automation-no-payload",
      "--input",
      join(repositoryRoot, "does-not-exist.json"),
    ], { cwd: repositoryRoot, env: gitEnvironment, encoding: "utf8", timeout: TIMEOUT });
    expect(payload.status).toBe(1);
    expect(JSON.parse(payload.stdout)).toMatchObject({
      schema_version: "1", ok: false, error: { code: "CONTRACT_INVALID" },
    });
    expect(payload.stderr).toContain("automation-status accepts no input payload");
  });

  it("reserves nonzero exit for repository authority failures, not blocked workflow status", () => {
    const outsideRepository = mkdtempSync(join(tmpdir(), "archflow-automation-outside-repo-"));
    roots.push(outsideRepository);
    const result = spawnSync(process.execPath, [localBundle, "automation-status", "--task", "missing-task"], {
      cwd: outsideRepository,
      env: gitEnvironment,
      encoding: "utf8",
      timeout: TIMEOUT,
    });

    expect(result.status).toBe(1);
    expect(JSON.parse(result.stdout)).toMatchObject({ schema_version: "1", ok: false, error: { code: expect.any(String) } });
    expect(result.stderr.trim()).not.toBe("");
  });
});

import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { sha256Bytes } from "../../src/contracts/canonical.js";
import { parseTaskInitialization } from "../../src/contracts/durable-task-initialization.js";
import { computePinnedConfigDigest } from "../../src/contracts/fingerprints.js";
import { scaffoldRepositoryAssets } from "../../src/init/assets.js";
import { stageTaskInitialization } from "../../src/init/task-initialization.js";

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

const gitEnv: NodeJS.ProcessEnv = {
  ...process.env,
  GIT_CONFIG_GLOBAL: "/dev/null",
  GIT_CONFIG_SYSTEM: "/dev/null",
  GIT_AUTHOR_NAME: "ArchFlow Test",
  GIT_AUTHOR_EMAIL: "test@example.invalid",
  GIT_COMMITTER_NAME: "ArchFlow Test",
  GIT_COMMITTER_EMAIL: "test@example.invalid",
};

function git(root: string, ...argv: string[]): string {
  return execFileSync("git", argv, { cwd: root, env: gitEnv, encoding: "utf8" }).trim();
}

async function initializedRepository(): Promise<string> {
  const root = mkdtempSync(join(tmpdir(), "archflow-task-init-"));
  roots.push(root);
  git(root, "-c", "init.defaultBranch=main", "init", "-q");
  writeFileSync(join(root, "README.md"), "repository\n");
  git(root, "add", "--", "README.md");
  git(root, "commit", "-q", "-m", "root");
  const scaffold = await scaffoldRepositoryAssets({ working_directory: root });
  if (!scaffold.ok) throw new Error(scaffold.error.code);
  return root;
}

describe("task initialization staging", () => {
  it("refuses uncommitted policy, then emits commit-tree-pinned schema-valid authority", async () => {
    const root = await initializedRepository();

    const beforeCommit = await stageTaskInitialization({ working_directory: root, task_id: "demo-task" });
    expect(beforeCommit.ok).toBe(false);
    if (!beforeCommit.ok) expect(beforeCommit.error.code).toBe("POLICY_BASE_INVALID");
    const copiedConfig = readFileSync(join(root, ".archflow", "tasks", "demo-task", "config.yaml"));
    expect(copiedConfig).toEqual(readFileSync(join(root, ".archflow", "config.yaml")));

    git(root, "add", "--", ".gitattributes", ".archflow/workflow.yaml", ".archflow/constitution", ".archflow/config.yaml");
    git(root, "commit", "-q", "-m", "approve policy");
    const head = git(root, "rev-parse", "HEAD");
    const staged = await stageTaskInitialization({ working_directory: root, task_id: "demo-task" });
    expect(staged.ok).toBe(true);
    if (!staged.ok) return;
    expect(parseTaskInitialization(staged.value)).toEqual(staged.value);
    expect(staged.value.code_baseline_commit).toBe(head);
    expect(staged.value.policy_base_commit).toBe(head);
    expect(staged.value.config_digest).toBe(computePinnedConfigDigest(copiedConfig));
    expect(staged.value.canonical_paths).toEqual({
      task_root: ".archflow/tasks/demo-task",
      config: ".archflow/tasks/demo-task/config.yaml",
      state: ".archflow/tasks/demo-task/state.json",
      workflow: ".archflow/workflow.yaml",
      constitution_root: ".archflow/constitution",
    });

    const pinnedWorkflowDigest = staged.value.workflow_digest;
    const pinnedConstitutionDigest = staged.value.constitution_digest;
    writeFileSync(join(root, ".archflow", "workflow.yaml"), "dirty workflow\n");
    writeFileSync(join(root, ".archflow", "constitution", "00-process.md"), "dirty constitution\n");
    const dirty = await stageTaskInitialization({ working_directory: root, task_id: "demo-task" });
    expect(dirty.ok).toBe(true);
    if (dirty.ok) {
      expect(dirty.value.workflow_digest).toBe(pinnedWorkflowDigest);
      expect(dirty.value.constitution_digest).toBe(pinnedConstitutionDigest);
    }
  });

  it("preserves and digests a valid pre-existing per-task routing override", async () => {
    const root = await initializedRepository();
    git(root, "add", "--", ".gitattributes", ".archflow/workflow.yaml", ".archflow/constitution", ".archflow/config.yaml");
    git(root, "commit", "-q", "-m", "approve policy");
    const taskRoot = join(root, ".archflow", "tasks", "override-task");
    const { mkdirSync } = await import("node:fs");
    mkdirSync(taskRoot, { recursive: true });
    const override = Buffer.from('schema_version: "1"\nroles:\n  counter-reviewer:\n    model: gpt-5.6-sol\n    effort: max\n');
    writeFileSync(join(taskRoot, "config.yaml"), override);

    const result = await stageTaskInitialization({ working_directory: root, task_id: "override-task" });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(readFileSync(join(taskRoot, "config.yaml"))).toEqual(override);
    expect(result.value.config_digest).toBe(sha256Bytes(override));
  });
});

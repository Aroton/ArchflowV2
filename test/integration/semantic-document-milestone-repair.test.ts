import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { ApplySubmissionV1, WorkflowViewV1 } from "../../src/contracts/semantic-workflow.js";
import { ignoredMilestonePaths } from "../../src/state/milestone-repair.js";
import { clientCommit, installSemanticReviewStub, semanticJourneyHarness } from "../helpers/semantic-journeys.js";
import { createTaskWorkspace, type TaskWorkspace } from "../helpers/task-workspace.js";

const cleanups: (() => void)[] = [];
afterEach(() => { for (const cleanup of cleanups.splice(0).reverse()) cleanup(); });
const invocation = { skill: "archflow-prd", intent: "resume" } as const;
const git = (workspace: TaskWorkspace, ...args: string[]) => execFileSync("git", args, { cwd: workspace.root, encoding: "utf8" }).trim();

async function approvedPrd(autonomous = false, precommitted = false) {
  const workspace = await createTaskWorkspace({ taskId: "milestone-repair", configBytes: new TextEncoder().encode(`schema_version: "1"
roles:
  counter-reviewer: { model: gpt-5.6-sol, effort: xhigh }
  adjudicator: { model: gpt-5.6-sol, effort: xhigh }
approval_rules:
  subjects: ${autonomous ? "[]" : "[prd, design]"}
  content: []
`) });
  cleanups.push(workspace.dispose, installSemanticReviewStub(workspace.root, [[]]));
  const taskRoot = workspace.services.authority.task_root;
  writeFileSync(join(taskRoot, "ask.md"), "Test milestone repair.\n");
  writeFileSync(join(taskRoot, "prd.md"), "# Requirements\n\nKeep approval when repairing Git staging.\n");
  if (precommitted) {
    git(workspace, "add", "--", `.archflow/tasks/${workspace.taskId}/prd.md`);
    git(workspace, "-c", "user.name=ArchFlow Test", "-c", "user.email=test@example.invalid", "commit", "-q", "-m", "existing requirements", "--", `.archflow/tasks/${workspace.taskId}/prd.md`);
  }
  const h = semanticJourneyHarness(workspace, false);
  let view = await h.status(invocation);
  const apply = async (submission?: ApplySubmissionV1) => {
    const result = await h.applyAndAssertFreshStatus(invocation, view, submission);
    if (!result.ok) throw new Error(JSON.stringify(result.error));
    view = result.value;
  };
  await apply({ kind: "work-result", outcome: "succeeded" });
  await apply();
  expect(view.next_action.kind).toBe("triage");
  await apply({ kind: "triage", response: { decision: "finish", rationale: "The reports identify no concerns." } });
  if (!autonomous) {
    await apply({ kind: "gate-summary", summary: "Requirements are ready." });
    await apply({ kind: "decision", choice: "approve", reason: "Approved requirements." });
  }
  expect(view.next_action.kind).toBe("commit");
  return { workspace, view, taskRoot };
}

async function stableStatus(workspace: TaskWorkspace, kind: string): Promise<WorkflowViewV1> {
  const statePath = join(workspace.services.authority.task_root, "state.json");
  const before = readFileSync(statePath, "utf8");
  const reviews = readFileSync(join(workspace.root, "semantic-review-count"), "utf8");
  let view!: WorkflowViewV1;
  for (let repeat = 0; repeat < 2; repeat++) {
    view = await semanticJourneyHarness(workspace).status(invocation);
    expect(view.next_action.kind, JSON.stringify(view.next_action)).toBe(kind);
    expect(view.next_action.offer).toBeUndefined();
  }
  expect(readFileSync(statePath, "utf8")).toBe(before);
  expect(readFileSync(join(workspace.root, "semantic-review-count"), "utf8")).toBe(reviews);
  return view;
}

describe("document milestone repair", { timeout: 180_000 }, () => {
  it.each(["state.json", "decisions/"])("stops before committing ignored %s and resumes the same approval", async (ignored) => {
    const { workspace, taskRoot } = await approvedPrd();
    // Root rules reproduce real project policy; leave their correction out of the task commit.
    writeFileSync(join(workspace.root, ".gitignore"), `${ignored}\n`);
    writeFileSync(join(taskRoot, "scratch.log"), "ignored scratch\n");
    writeFileSync(join(workspace.root, ".git", "info", "exclude"), "*.log\n");
    const blocked = await stableStatus(workspace, "inspect");
    expect(blocked.next_action.instruction).toContain("Git ignore rules");
    expect(blocked.next_action.instruction).toContain(ignored);
    expect(blocked.next_action.instruction).not.toContain("scratch.log");
    expect(blocked.next_action.commit).toBeUndefined();
    writeFileSync(join(workspace.root, ".gitignore"), "");
    const ready = await stableStatus(workspace, "commit");
    // Unrelated staged/worktree bytes survive the task-scoped commit.
    writeFileSync(join(workspace.root, "sentinel.txt"), "staged\n");
    git(workspace, "add", "--", "sentinel.txt");
    writeFileSync(join(workspace.root, "sentinel.txt"), "unstaged\n");
    await clientCommit(workspace, ready);
    expect(git(workspace, "show", ":sentinel.txt")).toBe("staged");
    expect(readFileSync(join(workspace.root, "sentinel.txt"), "utf8")).toBe("unstaged\n");
    expect((await stableStatus(workspace, "start-next-skill")).next_action.skill).toBe("archflow-design");
    // Tracked authority remains stageable even when a later ignore rule matches it.
    writeFileSync(join(workspace.root, ".gitignore"), `${ignored}\n`);
    expect(await ignoredMilestonePaths(workspace.services.dependencies.runner, workspace.taskId)).toEqual([]);
    await stableStatus(workspace, "start-next-skill");
  });

  it.each([
    { autonomous: false, precommitted: false },
    { autonomous: true, precommitted: false },
    { autonomous: false, precommitted: true },
  ])("repairs an incomplete commit without repeating authority ($autonomous, unchanged document=$precommitted)", async ({ autonomous, precommitted }) => {
    const { workspace, view, taskRoot } = await approvedPrd(autonomous, precommitted);
    writeFileSync(join(workspace.root, ".gitignore"), "state.json\n");
    // Simulate an older client executing previously returned commit facts without fresh preflight.
    await clientCommit(workspace, view);
    const incomplete = git(workspace, "rev-parse", "HEAD");
    expect(git(workspace, "ls-files", "--", `.archflow/tasks/${workspace.taskId}/state.json`)).toBe("");
    expect((await stableStatus(workspace, "inspect")).next_action.instruction).toContain("missing required task state");
    writeFileSync(join(workspace.root, ".gitignore"), "");
    expect((await stableStatus(workspace, "inspect")).next_action.instruction).toContain("Adding a later commit does not repair");
    const state = readFileSync(join(taskRoot, "state.json"), "utf8");
    git(workspace, "add", "--", `.archflow/tasks/${workspace.taskId}/state.json`);
    git(workspace, "-c", "user.name=ArchFlow Test", "-c", "user.email=test@example.invalid", "commit", "--amend", "--no-edit", "-q", "--", `.archflow/tasks/${workspace.taskId}`);
    expect(git(workspace, "rev-parse", "HEAD")).not.toBe(incomplete);
    expect(readFileSync(join(taskRoot, "state.json"), "utf8")).toBe(state);
    expect((await stableStatus(workspace, "start-next-skill")).next_action.skill).toBe("archflow-design");
  });
});

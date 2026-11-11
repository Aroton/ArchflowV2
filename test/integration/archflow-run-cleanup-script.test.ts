import { spawnSync } from "node:child_process";
import { existsSync, lstatSync, mkdtempSync, readFileSync, readdirSync, symlinkSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { afterAll, describe, expect, it } from "vitest";

import {
  cleanupTemporaryRepositories,
  createTempRepository,
  temporaryRoot,
  type TempRepository,
} from "../helpers/temp-repository.js";

const script = fileURLToPath(new URL("../../skills/archflow-run/scripts/cleanup.sh", import.meta.url));

afterAll(() => {
  cleanupTemporaryRepositories();
});

function cleanup(repository: TempRepository, ...args: readonly string[]): { status: number | null; stdout: string } {
  const result = spawnSync("bash", [script, repository.path, ...args], {
    encoding: "utf8",
    env: {
      ...process.env,
      GIT_CONFIG_GLOBAL: "/dev/null",
      GIT_CONFIG_SYSTEM: "/dev/null",
      GIT_AUTHOR_NAME: "ArchFlow Test",
      GIT_AUTHOR_EMAIL: "test@example.invalid",
      GIT_COMMITTER_NAME: "ArchFlow Test",
      GIT_COMMITTER_EMAIL: "test@example.invalid",
    },
  });
  return { status: result.status, stdout: result.stdout };
}

/** A generated agent as the planner writes it: the name matches the file, the description names the run. */
function agent(repository: TempRepository, name: string, run: string): void {
  repository.write(
    `.claude/agents/${name}.md`,
    `---\nname: ${name}\ndescription: Demo agent. Spawned only by the ${run} orchestrator, one job per spawn.\nmodel: opus\neffort: high\n---\n\nBody.\n`,
  );
}

/** A committed run named `demo` with a general pair, one domain agent, and gitignored packets. */
function repositoryWithRun(label: string): TempRepository {
  const repository = createTempRepository({ label, attributes: undefined });
  repository.write("src/app.ts", "export const app = 1;\n");
  repository.write(".archflow/runs/demo/PLAN.md", "plan\n");
  repository.write(".archflow/runs/demo/reviews/T1-impl.md", "review\n");
  repository.write(".archflow/runs/demo/.gitignore", "packets/\n");
  agent(repository, "demo-implementer", "demo");
  agent(repository, "demo-reviewer", "demo");
  agent(repository, "demo-ui-implementer", "demo");
  repository.commitAll("base");
  repository.write(".archflow/runs/demo/packets/T1-cr1/result.json", "{}\n");
  return repository;
}

describe("archflow-run cleanup script", () => {
  it("removes the run directory and the run's agents in one commit and touches nothing else", () => {
    const repository = repositoryWithRun("run-cleanup-removes");
    repository.write(".archflow/runs/other/PLAN.md", "another run\n");
    repository.commitAll("another run");
    repository.write("src/staged.ts", "export const staged = 1;\n");
    repository.git("add", "src/staged.ts");

    const result = cleanup(repository, "demo");

    expect(result.status, result.stdout).toBe(0);
    expect(result.stdout).toMatch(/^cleanup demo: commit [0-9a-f]+ \(undo: git revert [0-9a-f]+\)$/mu);
    expect(existsSync(join(repository.path, ".archflow/runs/demo"))).toBe(false);
    expect(existsSync(join(repository.path, ".claude/agents"))).toBe(false);
    expect(readFileSync(join(repository.path, ".archflow/runs/other/PLAN.md"), "utf8")).toBe("another run\n");
    expect(repository.git("show", "--format=%s", "--name-status", "HEAD").split("\n")).toEqual([
      "Remove the demo run's working files",
      "",
      "D\t.archflow/runs/demo/.gitignore",
      "D\t.archflow/runs/demo/PLAN.md",
      "D\t.archflow/runs/demo/reviews/T1-impl.md",
      "D\t.claude/agents/demo-implementer.md",
      "D\t.claude/agents/demo-reviewer.md",
      "D\t.claude/agents/demo-ui-implementer.md",
    ]);
    // A change someone else had staged is neither committed nor unstaged.
    expect(repository.git("status", "--porcelain")).toBe("A  src/staged.ts");

    const again = cleanup(repository, "demo");
    expect(again.status, again.stdout).toBe(0);
    expect(again.stdout).toContain("cleanup demo: nothing to remove");
    expect(repository.git("log", "--oneline").split("\n")).toHaveLength(3);
  });

  it("keeps and reports agent files that are not provably this run's", () => {
    const repository = repositoryWithRun("run-cleanup-keeps");
    // Run `demo-api` owns these two, although their names also fit run `demo` with a domain called `api`.
    agent(repository, "demo-api-implementer", "demo-api");
    agent(repository, "demo-api-reviewer", "demo-api");
    repository.write(".claude/agents/demo-notes-reviewer.md", "A person's own file.\n");
    const outside = join(repository.root, "outside.md");
    repository.write("../outside.md", "outside the repository\n");
    symlinkSync(outside, join(repository.path, ".claude/agents/demo-linked-implementer.md"));
    repository.commitAll("other agents");

    const result = cleanup(repository, "demo");

    expect(result.status, result.stdout).toBe(0);
    expect(readdirSync(join(repository.path, ".claude/agents")).sort()).toEqual([
      "demo-api-implementer.md",
      "demo-api-reviewer.md",
      "demo-linked-implementer.md",
      "demo-notes-reviewer.md",
    ]);
    expect(result.stdout).toContain('kept: .claude/agents/demo-api-implementer.md (its description does not say "Spawned only by the demo orchestrator")');
    expect(result.stdout).toContain("kept: .claude/agents/demo-notes-reviewer.md (its frontmatter name is not demo-notes-reviewer)");
    expect(result.stdout).toContain("kept: .claude/agents/demo-linked-implementer.md (a symbolic link)");
    expect(lstatSync(join(repository.path, ".claude/agents/demo-linked-implementer.md")).isSymbolicLink()).toBe(true);
    expect(readFileSync(outside, "utf8")).toBe("outside the repository\n");
  });

  it("refuses while a run file has uncommitted changes, and removes nothing", () => {
    const repository = repositoryWithRun("run-cleanup-refuses");
    repository.write(".archflow/runs/demo/PLAN.md", "plan, edited\n");
    repository.write(".archflow/runs/demo/reviews/T2-impl.md", "not committed yet\n");
    const head = repository.git("rev-parse", "HEAD");

    const result = cleanup(repository, "demo");

    expect(result.status, result.stdout).toBe(1);
    expect(result.stdout).toContain("refused, nothing was removed");
    expect(result.stdout).toContain(" M .archflow/runs/demo/PLAN.md");
    expect(result.stdout).toContain("?? .archflow/runs/demo/reviews/T2-impl.md");
    expect(repository.git("rev-parse", "HEAD")).toBe(head);
    expect(readFileSync(join(repository.path, ".archflow/runs/demo/reviews/T2-impl.md"), "utf8")).toBe("not committed yet\n");
    expect(existsSync(join(repository.path, ".archflow/runs/demo/packets/T1-cr1/result.json"))).toBe(true);
    expect(existsSync(join(repository.path, ".claude/agents/demo-implementer.md"))).toBe(true);
  });

  it("rejects a run name that could leave the runs directory", () => {
    const repository = repositoryWithRun("run-cleanup-name");

    for (const name of ["../demo", "demo/..", ".", "Demo", ""]) {
      const result = cleanup(repository, name);
      expect(result.status, `${name}: ${result.stdout}`).toBe(2);
    }
    expect(existsSync(join(repository.path, ".archflow/runs/demo/PLAN.md"))).toBe(true);
  });

  it("changes nothing on a dry run", () => {
    const repository = repositoryWithRun("run-cleanup-dry-run");
    const head = repository.git("rev-parse", "HEAD");

    const result = cleanup(repository, "demo", "--dry-run");

    expect(result.status, result.stdout).toBe(0);
    expect(result.stdout).toContain("would remove: .archflow/runs/demo");
    expect(result.stdout).toContain("would remove: .claude/agents/demo-ui-implementer.md");
    expect(repository.git("rev-parse", "HEAD")).toBe(head);
    expect(repository.git("status", "--porcelain")).toBe("");
    expect(existsSync(join(repository.path, ".archflow/runs/demo/packets/T1-cr1/result.json"))).toBe(true);
  });

  it("removes the run's scratch review worktrees and leaves every other worktree alone", () => {
    const repository = repositoryWithRun("run-cleanup-worktrees");
    const temp = temporaryRoot("run-cleanup-temp");
    const scratchParent = mkdtempSync(join(temp, "archflow-run-demo."));
    const otherRunParent = mkdtempSync(join(temp, "archflow-run-demo-api."));
    repository.git("worktree", "add", "-q", "--detach", join(scratchParent, "wt"), "HEAD");
    repository.git("worktree", "add", "-q", "--detach", join(otherRunParent, "wt"), "HEAD");
    const task = repository.addWorktree("task-worktree", "task-branch");
    repository.git("-C", task, "commit", "-q", "--allow-empty", "-m", "unmerged work");

    const result = cleanup(repository, "demo");

    expect(result.status, result.stdout).toBe(0);
    expect(result.stdout).toContain(`removed: scratch worktree ${join(scratchParent, "wt")}`);
    expect(existsSync(scratchParent)).toBe(false);
    expect(existsSync(join(otherRunParent, "wt", "src/app.ts"))).toBe(true);
    expect(existsSync(join(task, "src/app.ts"))).toBe(true);
    expect(result.stdout).toContain(`left alone: worktree ${task} [task-branch], 0 uncommitted files`);
    expect(result.stdout).toContain(`left alone: worktree ${join(otherRunParent, "wt")} [detached]`);
    expect(repository.git("branch", "--list", "task-branch")).toContain("task-branch");
  });
});

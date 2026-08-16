import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import { parseGitOid } from "../../src/contracts/canonical.js";
import { parseSafeCode, parseSafeInteger, parseTaskSlug } from "../../src/contracts/evidence.js";
import { parsePhaseInstanceId } from "../../src/contracts/phase-instance.js";
import { createGitRunner } from "../../src/repository/git.js";
import { discoverWorktree } from "../../src/repository/identity.js";

const mocks = vi.hoisted(() => ({ status: vi.fn() }));
vi.mock("../../src/state/status.js", () => ({ computeTaskStatus: mocks.status }));

import { commitCurrentAuthorizedAction } from "../../src/local/commit.js";
import type { ProductionServices } from "../../src/state/production.js";

const roots: string[] = [];
afterEach(() => {
  mocks.status.mockReset();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function git(root: string, args: readonly string[]): string {
  return execFileSync("git", args, { cwd: root, encoding: "utf8" }).trim();
}

describe("local authorized commit", () => {
  it("commits only server-derived paths and preserves unrelated index and worktree changes", async () => {
    const root = mkdtempSync(join(tmpdir(), "archflow-local-commit-"));
    roots.push(root);
    git(root, ["init", "-q", "-b", "main"]);
    git(root, ["config", "user.name", "ArchFlow Test"]);
    git(root, ["config", "user.email", "test@example.invalid"]);
    writeFileSync(join(root, "authorized.txt"), "before\n");
    writeFileSync(join(root, "staged-elsewhere.txt"), "before\n");
    writeFileSync(join(root, "worktree-elsewhere.txt"), "before\n");
    git(root, ["add", "."]);
    git(root, ["commit", "-qm", "baseline"]);
    const baseline = parseGitOid(git(root, ["rev-parse", "HEAD"]));

    writeFileSync(join(root, "authorized.txt"), "authorized after\n");
    writeFileSync(join(root, "authorized-added.txt"), "authorized new file\n");
    writeFileSync(join(root, "staged-elsewhere.txt"), "staged after\n");
    git(root, ["add", "--", "staged-elsewhere.txt"]);
    writeFileSync(join(root, "worktree-elsewhere.txt"), "worktree after\n");

    mocks.status.mockResolvedValue({
      schema_version: "1",
      ok: true,
      value: {
        next_action: {
          code: "commit-phase",
          commit_paths: ["authorized-added.txt", "authorized.txt"],
          commit_message: "ArchFlow: Implement local-commit phase 1",
          commit_target_ref: "refs/heads/main",
          commit_baseline: baseline,
        },
      },
    });
    const context = {
      task_id: parseTaskSlug("local-commit"),
      phase_instance: parsePhaseInstanceId("phase-impl-1"),
      operation: parseSafeCode("test-local-commit"),
      attempt: parseSafeInteger(1),
    };
    const discovered = await discoverWorktree(createGitRunner({ cwd: root }), context);
    if (!discovered.ok) throw new Error(discovered.error.code);
    const services = {
      runner: discovered.value,
      dependencies: {},
      state: { value: { phase_instance: "phase-impl-1" } },
      authority: { context },
    } as unknown as ProductionServices;

    const result = await commitCurrentAuthorizedAction(services);

    expect(result).toMatchObject({
      ok: true,
      value: {
        action: "commit-phase",
        target_ref: "refs/heads/main",
        message: "ArchFlow: Implement local-commit phase 1",
        paths: ["authorized-added.txt", "authorized.txt"],
      },
    });
    expect(git(root, ["show", "--format=", "--name-only", "HEAD"])).toBe("authorized-added.txt\nauthorized.txt");
    expect(git(root, ["diff", "--cached", "--name-only"])).toBe("staged-elsewhere.txt");
    expect(git(root, ["diff", "--name-only"])).toBe("worktree-elsewhere.txt");
  });

  it("commits both sides of an authorized rename", async () => {
    const root = mkdtempSync(join(tmpdir(), "archflow-local-rename-"));
    roots.push(root);
    git(root, ["init", "-q", "-b", "main"]);
    git(root, ["config", "user.name", "ArchFlow Test"]);
    git(root, ["config", "user.email", "test@example.invalid"]);
    writeFileSync(join(root, "old-name.txt"), "content\n");
    git(root, ["add", "."]);
    git(root, ["commit", "-qm", "baseline"]);
    const baseline = parseGitOid(git(root, ["rev-parse", "HEAD"]));
    git(root, ["mv", "old-name.txt", "new-name.txt"]);

    mocks.status.mockResolvedValue({
      schema_version: "1",
      ok: true,
      value: {
        next_action: {
          code: "commit-phase",
          commit_paths: ["new-name.txt", "old-name.txt"],
          commit_message: "ArchFlow: Implement local-rename phase 1",
          commit_target_ref: "refs/heads/main",
          commit_baseline: baseline,
        },
      },
    });
    const context = {
      task_id: parseTaskSlug("local-rename"),
      phase_instance: parsePhaseInstanceId("phase-impl-1"),
      operation: parseSafeCode("test-local-rename"),
      attempt: parseSafeInteger(1),
    };
    const discovered = await discoverWorktree(createGitRunner({ cwd: root }), context);
    if (!discovered.ok) throw new Error(discovered.error.code);

    const result = await commitCurrentAuthorizedAction({
      runner: discovered.value,
      dependencies: {},
      state: { value: { phase_instance: "phase-impl-1" } },
      authority: { context },
    } as unknown as ProductionServices);

    if (!result.ok) throw new Error(JSON.stringify(result.error));
    expect(result).toMatchObject({ ok: true, value: { paths: ["new-name.txt", "old-name.txt"] } });
    expect(git(root, ["show", "--format=", "--name-status", "HEAD"])).toMatch(/R100\s+old-name\.txt\s+new-name\.txt/u);
  });

  it("commits the whole authorized task directory for the design milestone", async () => {
    const root = mkdtempSync(join(tmpdir(), "archflow-local-milestone-"));
    roots.push(root);
    git(root, ["init", "-q", "-b", "main"]);
    git(root, ["config", "user.name", "ArchFlow Test"]);
    git(root, ["config", "user.email", "test@example.invalid"]);
    const taskId = parseTaskSlug("local-milestone");
    const taskPath = `.archflow/tasks/${taskId}`;
    mkdirSync(join(root, taskPath, "phases", "2"), { recursive: true });
    writeFileSync(join(root, "unrelated.txt"), "before\n");
    writeFileSync(join(root, taskPath, "prd.md"), "# Requirements\n");
    git(root, ["add", "."]);
    git(root, ["commit", "-qm", "baseline"]);
    const baseline = parseGitOid(git(root, ["rev-parse", "HEAD"]));

    // Exactly the shape the milestone commit takes: a new document plus durable recovery authority,
    // all reached through the single task-directory path rather than an enumerated file list.
    writeFileSync(join(root, taskPath, "phases", "2", "design.md"), "# Phase 2\n");
    writeFileSync(join(root, taskPath, "state.json"), "{}\n");
    mkdirSync(join(root, taskPath, "authority", "decisions", "gate-1"), { recursive: true });
    writeFileSync(join(root, taskPath, "authority", "decisions", "gate-1", "request.json"), "{}\n");
    writeFileSync(join(root, "unrelated.txt"), "after\n");

    mocks.status.mockResolvedValue({
      schema_version: "1",
      ok: true,
      value: {
        next_action: {
          code: "commit-artifacts",
          commit_path: taskPath,
          commit_message: "ArchFlow: Approve local-milestone phase 2 design",
          commit_target_ref: "refs/heads/main",
          commit_baseline: baseline,
        },
      },
    });
    const context = {
      task_id: taskId,
      phase_instance: parsePhaseInstanceId("phase-design-2"),
      operation: parseSafeCode("test-local-milestone"),
      attempt: parseSafeInteger(1),
    };
    const discovered = await discoverWorktree(createGitRunner({ cwd: root }), context);
    if (!discovered.ok) throw new Error(discovered.error.code);

    const result = await commitCurrentAuthorizedAction({
      runner: discovered.value,
      dependencies: {},
      state: { value: { phase_instance: "phase-design-2" } },
      authority: { context },
    } as unknown as ProductionServices);

    if (!result.ok) throw new Error(JSON.stringify(result.error));
    expect(result).toMatchObject({ ok: true, value: { action: "commit-artifacts", paths: [taskPath] } });
    expect(git(root, ["show", "--format=", "--name-only", "HEAD"]).split("\n")).toEqual([
      `${taskPath}/authority/decisions/gate-1/request.json`,
      `${taskPath}/phases/2/design.md`,
      `${taskPath}/state.json`,
    ]);
    expect(git(root, ["diff", "--name-only"])).toBe("unrelated.txt");
  });
});

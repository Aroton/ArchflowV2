import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import type { TaskStateV1 } from "../../src/contracts/durable-state.js";
import { parseSafeCode, parseSafeId, parseSafeInteger, parseSha256Digest, parseTaskSlug } from "../../src/contracts/evidence.js";
import { parsePhaseInstanceId } from "../../src/contracts/phase-instance.js";
import { createGitRunner, preflightGit } from "../../src/repository/git.js";
import { discoverWorktree } from "../../src/repository/identity.js";
import { createInternalTransactionAuthority } from "../../src/state/authority.js";
import type { TransactionDependencies } from "../../src/state/transaction.js";
import { cleanTaskWorkspace, cleanTerminalTaskWorkspace, inspectWorkspaceCleanup } from "../../src/state/workspace-cleanup.js";

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

describe("task workspace cleanup", () => {
  it("retains only current-phase work and state-referenced authority, then removes all work at terminal state", async () => {
    const root = mkdtempSync(join(tmpdir(), "archflow-cleanup-"));
    roots.push(root);
    execFileSync("git", ["init", "-q", "-b", "main"], { cwd: root, env: gitEnv });
    writeFileSync(join(root, "tracked.txt"), "base\n");
    execFileSync("git", ["add", "tracked.txt"], { cwd: root, env: gitEnv });
    execFileSync("git", ["commit", "-qm", "base"], { cwd: root, env: gitEnv });

    const taskId = parseTaskSlug("cleanup-task");
    const phase = parsePhaseInstanceId("phase-impl-2");
    const context = {
      task_id: taskId,
      phase_instance: phase,
      operation: parseSafeCode("clean-test"),
      attempt: parseSafeInteger(1),
    };
    const discovered = await discoverWorktree(createGitRunner({ cwd: root }), context);
    if (!discovered.ok) throw discovered.error;
    const environment = await preflightGit(discovered.value, context);
    if (!environment.ok) throw environment.error;
    const authority = await createInternalTransactionAuthority({ runner: discovered.value, environment: environment.value, task_id: taskId, context });
    if (!authority.ok) throw authority.error;
    const dependencies = { runner: discovered.value, environment: environment.value } as TransactionDependencies;

    const liveDigest = parseSha256Digest("a".repeat(64));
    const staleDigest = parseSha256Digest("b".repeat(64));
    const taskRoot = join(root, ".archflow", "tasks", taskId);
    const workRoot = join(root, ".archflow", "work", "tasks", taskId);
    const files = [
      [join(workRoot, "cache", "results", liveDigest, "payload", "prd.md"), "live payload"],
      [join(workRoot, "cache", "results", staleDigest, "payload", "prd.md"), "stale payload"],
      [join(workRoot, "cache", "phases", "1", "verification.txt"), "old verify"],
      [join(workRoot, "cache", "phases", "2", "verification.txt"), "current verify"],
      [join(workRoot, "diagnostics", "attempts", "phase-impl-1", "old.json"), "{}"],
      [join(workRoot, "diagnostics", "attempts", "phase-impl-2", "current.json"), "{}"],
      [join(workRoot, "cache", "scratch", "stale.tmp"), "scratch"],
      [join(taskRoot, "authority", "results", `${liveDigest}.json`), "{}"],
      [join(taskRoot, "authority", "results", `${staleDigest}.json`), "{}"],
      [join(taskRoot, "authority", "decisions", "live-gate", "request.json"), "{}"],
      [join(taskRoot, "authority", "decisions", "stale-gate", "request.json"), "{}"],
    ] as const;
    for (const [path, contents] of files) {
      mkdirSync(join(path, ".."), { recursive: true });
      writeFileSync(path, contents);
    }

    const state: TaskStateV1 = {
      schema_version: "1",
      task_id: taskId,
      repository_identity_digest: authority.value.repository_identity_digest,
      revision: parseSafeInteger(8),
      phase_instance: phase,
      step: "produce",
      status: "succeeded",
      attempt: parseSafeInteger(1),
      input_fingerprint: parseSha256Digest("1".repeat(64)),
      initialization_digest: parseSha256Digest("2".repeat(64)),
      config_digest: parseSha256Digest("3".repeat(64)),
      workflow_digest: parseSha256Digest("4".repeat(64)),
      constitution_digest: parseSha256Digest("5".repeat(64)),
      policy_base_commit: "1234567890abcdef1234567890abcdef12345678" as TaskStateV1["policy_base_commit"],
      authoritative_results: [{ phase_instance: phase, step: "produce", result_digest: liveDigest, result_id: parseSafeId("live-result"), input_fingerprint: parseSha256Digest("1".repeat(64)) }],
      approvals: [{ gate_id: "live-gate" as never, gate_kind: "artifact-approval", subject_digest: parseSha256Digest("6".repeat(64)), decision_digest: parseSha256Digest("7".repeat(64)), resolved_at_revision: parseSafeInteger(7) }],
      waivers: [],
    };

    const before = await inspectWorkspaceCleanup(dependencies, authority.value, state);
    expect(before).toMatchObject({ ok: true, value: { cleanup_pending: true } });
    const cleaned = await cleanTaskWorkspace(dependencies, authority.value, state);
    expect(cleaned).toMatchObject({ ok: true, value: { cleanup_pending: false } });
    expect(existsSync(join(workRoot, "cache", "results", liveDigest, "payload", "prd.md"))).toBe(true);
    expect(existsSync(join(workRoot, "cache", "results", staleDigest))).toBe(false);
    expect(existsSync(join(workRoot, "cache", "phases", "1"))).toBe(false);
    expect(existsSync(join(workRoot, "cache", "phases", "2", "verification.txt"))).toBe(true);
    expect(existsSync(join(taskRoot, "authority", "results", `${liveDigest}.json`))).toBe(true);
    expect(existsSync(join(taskRoot, "authority", "results", `${staleDigest}.json`))).toBe(false);
    expect(existsSync(join(taskRoot, "authority", "decisions", "live-gate", "request.json"))).toBe(true);
    expect(existsSync(join(taskRoot, "authority", "decisions", "stale-gate"))).toBe(false);

    const terminal = await cleanTerminalTaskWorkspace(dependencies, authority.value);
    expect(terminal).toMatchObject({ ok: true, value: { cleanup_pending: false, retained_files: 0 } });
    expect(existsSync(workRoot)).toBe(false);
  });
});

import { execFileSync } from "node:child_process";
import {
  mkdirSync,
  mkdtempSync,
  renameSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { canonicalDocument, parseGitOid, sha256Bytes } from "../../src/contracts/canonical.js";
import type { TaskStateV1 } from "../../src/contracts/durable-state.js";
import { parseSafeInteger, parseSha256Digest, parseTaskSlug } from "../../src/contracts/evidence.js";
import { encodePhaseInstance, parsePositiveSafePhaseNumber } from "../../src/contracts/phase-instance.js";
import { parseRepositoryPathClaim, parseTaskPathClaim } from "../../src/contracts/path-claims.js";
import { createGitRunner, preflightGit, type GitCommandSpec, type RepositoryOperationContext } from "../../src/repository/git.js";
import { discoverWorktree } from "../../src/repository/identity.js";
import { createInternalTransactionAuthority } from "../../src/state/authority.js";
import type { GateLifecycleDependencies } from "../../src/state/gates.js";
import {
  buildImplementationOutput,
  implementationOutputCommittedAtCurrentTarget,
  verifyImplementationManifest,
} from "../../src/state/implementation-manifest.js";

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

describe("Phase 17 implementation-output builder", () => {
  it("derives operations, identities, undeclared changes, secret scan, and successive accounting", async () => {
    const root = mkdtempSync(join(tmpdir(), "archflow-implementation-builder-"));
    roots.push(root);
    execFileSync("git", ["init", "-q", "-b", "main"], { cwd: root, env: gitEnv });
    const taskId = parseTaskSlug("builder-task");
    const taskRoot = join(root, ".archflow", "tasks", taskId);
    mkdirSync(taskRoot, { recursive: true });
    writeFileSync(join(taskRoot, "prd.md"), "requirements\n");
    writeFileSync(join(root, "input.txt"), "declared input\n");
    writeFileSync(join(root, "modify.txt"), "before\n");
    writeFileSync(join(root, "delete.txt"), "delete me\n");
    writeFileSync(join(root, "rename-old.txt"), "rename me\n");
    execFileSync("git", ["add", "."], { cwd: root, env: gitEnv });
    execFileSync("git", ["commit", "-qm", "base"], { cwd: root, env: gitEnv });
    const baseCommit = parseGitOid(execFileSync("git", ["rev-parse", "HEAD"], {
      cwd: root, env: gitEnv, encoding: "utf8",
    }).trim());

    writeFileSync(join(root, "modify.txt"), "after\n");
    rmSync(join(root, "delete.txt"));
    renameSync(join(root, "rename-old.txt"), join(root, "rename-new.txt"));
    writeFileSync(join(root, "added.txt"), "added\n");
    symlinkSync("modify.txt", join(root, "added-link"));
    writeFileSync(join(root, "scratch.txt"), "undeclared\n");

    const phase = encodePhaseInstance({ kind: "phase-impl", phase: parsePositiveSafePhaseNumber(17) });
    const context: RepositoryOperationContext = {
      task_id: taskId,
      phase_instance: phase,
      operation: "build-implementation-output" as never,
      attempt: parseSafeInteger(1),
    };
    const discovered = await discoverWorktree(createGitRunner({ cwd: root }), context);
    if (!discovered.ok) throw discovered.error;
    const environment = await preflightGit(discovered.value, context);
    if (!environment.ok) throw environment.error;
    const authority = await createInternalTransactionAuthority({
      runner: discovered.value, environment: environment.value, task_id: taskId, context,
    });
    if (!authority.ok) throw authority.error;
    const fingerprint = parseSha256Digest("1".repeat(64));
    const makeState = (revision: number) => canonicalDocument<TaskStateV1>({
      schema_version: "1",
      task_id: taskId,
      repository_identity_digest: authority.value.repository_identity_digest,
      revision: parseSafeInteger(revision),
      phase_instance: phase,
      step: "produce",
      status: "running",
      attempt: parseSafeInteger(1),
      input_fingerprint: fingerprint,
      initialization_digest: parseSha256Digest("2".repeat(64)),
      config_digest: parseSha256Digest("3".repeat(64)),
      workflow_digest: parseSha256Digest("4".repeat(64)),
      constitution_digest: parseSha256Digest("5".repeat(64)),
      policy_base_commit: baseCommit,
      authoritative_results: [], approvals: [], waivers: [],
    });
    let retained = parseSafeInteger(0);
    const dependencies = {
      runner: discovered.value,
      environment: environment.value,
      read_retained_task_bytes: async () => retained,
    } as GateLifecycleDependencies;
    const paths = ["added-link", "added.txt", "delete.txt", "modify.txt", "rename-new.txt"]
      .map(parseRepositoryPathClaim);
    const input = {
      phase_instance: phase,
      step: "produce" as const,
      base_commit: baseCommit,
      outputs: paths,
      restore_targets: paths,
      parent_documents: [{ document_path: parseTaskPathClaim("prd.md"), role: "prd" as const }],
      declared_inputs: [{ input_id: "requirements" as never, path: parseRepositoryPathClaim("input.txt") }],
      input_fingerprint: fingerprint,
    };

    const first = await buildImplementationOutput(dependencies, authority.value, makeState(1), input);
    expect(first.ok).toBe(true);
    if (!first.ok) return;
    expect(Object.fromEntries(first.value.outputs.map((output) => [output.path, output.operation])))
      .toEqual({
        "added-link": "add",
        "added.txt": "add",
        "delete.txt": "delete",
        "modify.txt": "modify",
        "rename-new.txt": "rename",
      });
    const renamed = first.value.outputs.find((output) => output.operation === "rename");
    expect(renamed).toMatchObject({ previous_path: "rename-old.txt", storage: "git-object" });
    expect(first.value.outputs.find((output) => output.path === "added-link"))
      .toMatchObject({ file_type: "symlink", after: { mode: "120000" } });
    expect(first.value.undeclared_changes).toEqual({
      scanned: true, undeclared_paths: ["scratch.txt"], unrepresentable_count: 0,
    });
    expect(first.value.parent_documents[0]?.content_digest)
      .toBe(sha256Bytes(new TextEncoder().encode("requirements\n")));
    expect(first.value.declared_inputs[0]?.digest)
      .toBe(sha256Bytes(new TextEncoder().encode("declared input\n")));
    expect(first.value.secret_scan.outcome).toBe("clean");
    await expect(verifyImplementationManifest(discovered.value, first.value, context)).resolves.toBeDefined();
    await expect(implementationOutputCommittedAtCurrentTarget(
      discovered.value, first.value, "refs/heads/main",
    )).resolves.toBe(false);
    execFileSync("git", ["add", "-A", "--", "added-link", "added.txt", "delete.txt", "modify.txt", "rename-new.txt", "rename-old.txt"], {
      cwd: root, env: gitEnv,
    });
    execFileSync("git", ["commit", "-qm", "authorized output"], { cwd: root, env: gitEnv });
    const authorizedCommit = execFileSync("git", ["rev-parse", "HEAD"], {
      cwd: root, env: gitEnv, encoding: "utf8",
    }).trim();
    await expect(implementationOutputCommittedAtCurrentTarget(
      discovered.value, first.value, "refs/heads/main",
    )).resolves.toBe(true);
    await expect(implementationOutputCommittedAtCurrentTarget(
      discovered.value, first.value, "refs/heads/wrong",
    )).resolves.toBe(false);

    let movedTarget = false;
    const targetMismatchRunner = Object.freeze({
      ...discovered.value,
      runText: async (spec: GitCommandSpec) => {
        const result = await discovered.value.runText(spec);
        if (!movedTarget && spec.argv.join("\0") === "rev-parse\0--verify\0HEAD^{commit}") {
          execFileSync("git", ["update-ref", "refs/heads/main", baseCommit], { cwd: root, env: gitEnv });
          movedTarget = true;
        }
        return result;
      },
    }) as typeof discovered.value;
    await expect(implementationOutputCommittedAtCurrentTarget(
      targetMismatchRunner, first.value, "refs/heads/main",
    )).resolves.toBe(false);
    expect(movedTarget).toBe(true);
    execFileSync("git", ["update-ref", "refs/heads/main", authorizedCommit], { cwd: root, env: gitEnv });

    execFileSync("git", ["switch", "--detach", "-q", authorizedCommit], { cwd: root, env: gitEnv });
    await expect(implementationOutputCommittedAtCurrentTarget(
      discovered.value, first.value, "HEAD",
    )).resolves.toBe(true);
    execFileSync("git", ["switch", "-q", "main"], { cwd: root, env: gitEnv });

    writeFileSync(join(root, "modify.txt"), "wrong late entry\n");
    execFileSync("git", ["add", "modify.txt"], { cwd: root, env: gitEnv });
    execFileSync("git", ["commit", "-qm", "mixed tree one"], { cwd: root, env: gitEnv });
    const mixedTreeOne = execFileSync("git", ["rev-parse", "HEAD"], {
      cwd: root, env: gitEnv, encoding: "utf8",
    }).trim();
    writeFileSync(join(root, "added.txt"), "wrong early entry\n");
    writeFileSync(join(root, "modify.txt"), "after\n");
    execFileSync("git", ["add", "added.txt", "modify.txt"], { cwd: root, env: gitEnv });
    execFileSync("git", ["commit", "-qm", "mixed tree two"], { cwd: root, env: gitEnv });
    const mixedTreeTwo = execFileSync("git", ["rev-parse", "HEAD"], {
      cwd: root, env: gitEnv, encoding: "utf8",
    }).trim();
    execFileSync("git", ["update-ref", "refs/heads/main", mixedTreeOne], { cwd: root, env: gitEnv });
    let movedDuringTreeProof = false;
    const movingHeadRunner = Object.freeze({
      ...discovered.value,
      runNulFields: async (spec: GitCommandSpec) => {
        const result = await discovered.value.runNulFields(spec);
        if (!movedDuringTreeProof && spec.argv[0] === "ls-tree" && spec.argv.at(-1) === "added.txt") {
          execFileSync("git", ["update-ref", "refs/heads/main", mixedTreeTwo], { cwd: root, env: gitEnv });
          movedDuringTreeProof = true;
        }
        return result;
      },
    }) as typeof discovered.value;
    await expect(implementationOutputCommittedAtCurrentTarget(
      movingHeadRunner, first.value, "refs/heads/main",
    )).resolves.toBe(false);
    expect(movedDuringTreeProof).toBe(true);
    execFileSync("git", ["reset", "--hard", "-q", authorizedCommit], { cwd: root, env: gitEnv });

    retained = first.value.accounting.result_bytes;
    writeFileSync(join(root, "added.txt"), "second generation\n");
    const second = await buildImplementationOutput(dependencies, authority.value, makeState(2), input);
    expect(second.ok).toBe(true);
    if (!second.ok) return;
    expect(second.value.accounting.measured_at_revision).toBe(2);
    expect(second.value.accounting.task_bytes)
      .toBe(retained + second.value.accounting.result_bytes);
    await expect(verifyImplementationManifest(discovered.value, second.value, context)).resolves.toBeDefined();
  });
});

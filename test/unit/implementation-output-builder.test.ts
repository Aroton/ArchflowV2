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

import { canonicalDocument, gitBlobOid, parseGitOid, sha256Bytes } from "../../src/contracts/canonical.js";
import type { DocumentArtifactV1 } from "../../src/contracts/durable-document.js";
import type { OutputEntry } from "../../src/contracts/durable-primitives.js";
import type { TaskStateV1 } from "../../src/contracts/durable-state.js";
import type { GateContext } from "../../src/contracts/gates.js";
import { parseSafeInteger, parseSha256Digest, parseTaskSlug } from "../../src/contracts/evidence.js";
import { encodePhaseInstance, parsePositiveSafePhaseNumber } from "../../src/contracts/phase-instance.js";
import { parseRepositoryPathClaim, parseTaskPathClaim } from "../../src/contracts/path-claims.js";
import { createGitRunner, preflightGit, type GitCommandSpec, type RepositoryOperationContext } from "../../src/repository/git.js";
import { discoverWorktree } from "../../src/repository/identity.js";
import { createInternalTransactionAuthority } from "../../src/state/authority.js";
import type { GateLifecycleDependencies } from "../../src/state/gates.js";
import {
  buildImplementationOutput,
  designArtifactCommittedAtCurrentTarget,
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

describe("implementation-output builder", () => {
  it("proves only the exact task-local design milestone authorized by approval", async () => {
    const root = mkdtempSync(join(tmpdir(), "archflow-design-commit-"));
    roots.push(root);
    execFileSync("git", ["init", "-q", "-b", "main"], { cwd: root, env: gitEnv });
    const taskId = parseTaskSlug("design-commit-task");
    const taskPath = `.archflow/tasks/${taskId}`;
    const taskRoot = join(root, taskPath);
    mkdirSync(join(taskRoot, "phases", "1"), { recursive: true });
    const prdBytes = new TextEncoder().encode("# Approved requirements\n");
    writeFileSync(join(taskRoot, "prd.md"), prdBytes);
    writeFileSync(join(taskRoot, "phases", "1", "design.md"), "# Prior phase\n");
    writeFileSync(join(root, "tracked.txt"), "base\n");
    execFileSync("git", ["add", "tracked.txt", taskPath], { cwd: root, env: gitEnv });
    execFileSync("git", ["commit", "-qm", "base"], { cwd: root, env: gitEnv });
    const baseline = parseGitOid(execFileSync("git", ["rev-parse", "HEAD"], {
      cwd: root, env: gitEnv, encoding: "utf8",
    }).trim());

    const decisionRoot = join(taskRoot, "authority", "decisions", "gate-1");
    mkdirSync(decisionRoot, { recursive: true });
    const designBytes = new TextEncoder().encode("# Approved design\n");
    writeFileSync(join(taskRoot, "design.md"), designBytes);
    writeFileSync(join(taskRoot, "state.json"), "{}\n");
    writeFileSync(join(decisionRoot, "request.json"), "{}\n");
    writeFileSync(join(decisionRoot, "decision.json"), "{}\n");

    const projectionTarget = parseRepositoryPathClaim(`${taskPath}/design.md`);
    const artifact: DocumentArtifactV1 = {
      schema_version: "1",
      artifact_kind: "document",
      task_id: taskId,
      phase_instance: encodePhaseInstance({ kind: "design" }),
      step: "produce",
      document_path: parseTaskPathClaim("design.md"),
      path_class: "document",
      byte_count: parseSafeInteger(designBytes.byteLength),
      content_digest: sha256Bytes(designBytes),
      declared_inputs: [],
      input_fingerprint: parseSha256Digest("1".repeat(64)),
      snapshot_digest: parseSha256Digest("2".repeat(64)),
      projection_target: projectionTarget,
      additional_documents: [{
        document_path: parseTaskPathClaim("prd.md"),
        byte_count: parseSafeInteger(prdBytes.byteLength),
        content_digest: sha256Bytes(prdBytes),
        projection_target: parseRepositoryPathClaim(`${taskPath}/prd.md`),
      }],
    };
    const outputs: readonly OutputEntry[] = [{
      path: projectionTarget,
      path_class: "document",
      operation: "add",
      storage: "git-object",
      file_type: "regular",
      after: { oid: gitBlobOid(designBytes), mode: "100644", size_bytes: parseSafeInteger(designBytes.byteLength) },
    }, {
      path: parseRepositoryPathClaim(`${taskPath}/prd.md`),
      path_class: "document",
      operation: "modify",
      storage: "git-object",
      file_type: "regular",
      before: { oid: gitBlobOid(prdBytes), mode: "100644", size_bytes: parseSafeInteger(prdBytes.byteLength) },
      after: { oid: gitBlobOid(prdBytes), mode: "100644", size_bytes: parseSafeInteger(prdBytes.byteLength) },
    }];
    const context: GateContext<"design-approval"> = {
      artifact_kind: "design",
      constitution: "pass",
      policy_findings: [],
      eligible_waivers: [],
      target_ref: "refs/heads/main",
      baseline_commit: baseline,
      commit_message: "ArchFlow: Approve design-commit-task design",
    };
    const operation: RepositoryOperationContext = {
      task_id: taskId,
      phase_instance: encodePhaseInstance({ kind: "design" }),
      operation: "prove-design-commit" as never,
      attempt: parseSafeInteger(1),
    };
    const discovered = await discoverWorktree(createGitRunner({ cwd: root }), operation);
    if (!discovered.ok) throw discovered.error;

    await expect(designArtifactCommittedAtCurrentTarget(
      discovered.value, taskId, artifact, outputs, context,
    )).resolves.toBe(false);
    writeFileSync(join(taskRoot, "phases", "1", "design.md"), "# Illegally changed prior phase\n");
    execFileSync("git", ["add", "-A", "--", taskPath], { cwd: root, env: gitEnv });
    execFileSync("git", ["commit", "-qm", context.commit_message, "--", taskPath], { cwd: root, env: gitEnv });
    await expect(designArtifactCommittedAtCurrentTarget(
      discovered.value, taskId, artifact, outputs, context,
    )).resolves.toBe(false);
    writeFileSync(join(taskRoot, "phases", "1", "design.md"), "# Prior phase\n");
    execFileSync("git", ["add", "-A", "--", taskPath], { cwd: root, env: gitEnv });
    execFileSync("git", ["commit", "--amend", "--no-edit", "-q"], { cwd: root, env: gitEnv });
    await expect(designArtifactCommittedAtCurrentTarget(
      discovered.value, taskId, artifact, outputs, context,
    )).resolves.toBe(true);

    writeFileSync(join(taskRoot, "late-change.txt"), "dirty\n");
    await expect(designArtifactCommittedAtCurrentTarget(
      discovered.value, taskId, artifact, outputs, context,
    )).resolves.toBe(false);
  });

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
    const transcriptPath = join(root, ".archflow", "runtime", "tasks", taskId, "cache", "phases", "17");
    mkdirSync(transcriptPath, { recursive: true });
    writeFileSync(join(transcriptPath, "verification.txt"), "npm test\nall passed\n");
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
    expect(first.value.verification_evidence).toEqual({
      transcript_digest: sha256Bytes(new TextEncoder().encode("npm test\nall passed\n")),
      byte_count: 20,
    });
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

import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { canonicalDocument, canonicalJsonDigest, gitBlobOid, type CanonicalDocument } from "../../src/contracts/canonical.js";
import type { DocumentArtifactV1 } from "../../src/contracts/durable-document.js";
import type { ResultManifestV1 } from "../../src/contracts/durable-result-manifest.js";
import type { TaskStateV1 } from "../../src/contracts/durable-state.js";
import { parsePathSafeId, parseSafeCode, parseSafeId, parseSafeInteger, parseSha256Digest, parseTaskSlug } from "../../src/contracts/evidence.js";
import { parseRepositoryPathClaim, parseTaskPathClaim } from "../../src/contracts/path-claims.js";
import { parsePhaseInstanceId } from "../../src/contracts/phase-instance.js";
import { createGitRunner, preflightGit } from "../../src/repository/git.js";
import { discoverWorktree } from "../../src/repository/identity.js";
import { createInternalTransactionAuthority } from "../../src/state/authority.js";
import type { TransactionDependencies } from "../../src/state/transaction.js";
import { cleanTaskWorkspace, cleanTerminalTaskWorkspace, inspectWorkspaceCleanup, removeSupersededPhaseDocuments } from "../../src/state/workspace-cleanup.js";

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

function resultManifest(input: Readonly<{
  taskId: ReturnType<typeof parseTaskSlug>;
  phase: ReturnType<typeof parsePhaseInstanceId>;
  repositoryIdentityDigest: ReturnType<typeof parseSha256Digest>;
  resultId: string;
  incidentalDigest: ReturnType<typeof parseSha256Digest>;
}>): CanonicalDocument<ResultManifestV1> {
  const snapshotDigest = parseSha256Digest("9".repeat(64));
  const fingerprint = parseSha256Digest("8".repeat(64));
  const projectionTarget = parseRepositoryPathClaim(`.archflow/tasks/${input.taskId}/design.md`);
  const source: DocumentArtifactV1 = {
    schema_version: "1",
    artifact_kind: "document",
    task_id: input.taskId,
    phase_instance: input.phase,
    step: "produce",
    document_path: parseTaskPathClaim("design.md"),
    path_class: "document",
    byte_count: parseSafeInteger(0),
    content_digest: input.incidentalDigest,
    declared_inputs: [],
    input_fingerprint: fingerprint,
    snapshot_digest: snapshotDigest,
    projection_target: projectionTarget,
  };
  const output = {
    path: projectionTarget,
    path_class: "document" as const,
    operation: "add" as const,
    storage: "raw-payload" as const,
    payload_bytes: parseSafeInteger(0),
    payload_digest: input.incidentalDigest,
    file_type: "regular" as const,
    after: { oid: gitBlobOid(new Uint8Array()), mode: "100644" as const, size_bytes: parseSafeInteger(0) },
  };
  return canonicalDocument({
    schema_version: "1",
    task_id: input.taskId,
    repository_identity_digest: input.repositoryIdentityDigest,
    result_id: parseSafeId(input.resultId),
    phase_instance: input.phase,
    step: "produce",
    artifact_digest: canonicalJsonDigest(source),
    source_artifact: source,
    input_fingerprint: fingerprint,
    snapshot_digest: snapshotDigest,
    outputs: [output],
    projections: [{ path: projectionTarget, content_digest: input.incidentalDigest }],
    accounting: {
      schema_version: "1",
      result_bytes: parseSafeInteger(0),
      task_bytes: parseSafeInteger(0),
      result_byte_cap: 26_214_400,
      task_byte_cap: 262_144_000,
      counted_entries: [{ path: projectionTarget, storage: "raw-payload", stored_bytes: parseSafeInteger(0) }],
      measured_at_revision: parseSafeInteger(1),
    },
    secret_scan: {
      schema_version: "1",
      outcome: "clean",
      detector_set_id: parseSafeId("test"),
      scanned_paths: [projectionTarget],
    },
  });
}

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
    const staleManifest = resultManifest({
      taskId,
      phase,
      repositoryIdentityDigest: authority.value.repository_identity_digest,
      resultId: "stale-result",
      incidentalDigest: parseSha256Digest("b".repeat(64)),
    });
    const staleDigest = staleManifest.digest;
    const taskRoot = join(root, ".archflow", "tasks", taskId);
    const runtimeRoot = join(root, ".archflow", "runtime", "tasks", taskId);
    const files = [
      [join(runtimeRoot, "cache", "results", liveDigest, "payload", "prd.md"), "live payload"],
      [join(runtimeRoot, "cache", "results", staleDigest, "payload", "prd.md"), "stale payload"],
      [join(runtimeRoot, "cache", "phases", "1", "verification.txt"), "old verify"],
      [join(runtimeRoot, "cache", "phases", "2", "verification.txt"), "current verify"],
      [join(runtimeRoot, "diagnostics", "attempts", "phase-impl-1", "old.json"), "{}"],
      [join(runtimeRoot, "diagnostics", "attempts", "phase-impl-2", "current.json"), "{}"],
      [join(runtimeRoot, "cache", "scratch", "stale.tmp"), "scratch"],
      [join(taskRoot, "authority", "results", `${liveDigest}.json`), "{}"],
      [join(taskRoot, "authority", "results", `${staleDigest}.json`), staleManifest.bytes],
      [join(taskRoot, "authority", "decisions", "live-gate", "request.json"), "{}"],
      [join(taskRoot, "authority", "decisions", "restart-gate", "request.json"), "{}"],
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
      restart_history: [{
        restart_id: parsePathSafeId("restart-gate"),
        source_phase_instance: phase,
        target_phase_instance: parsePhaseInstanceId("phase-design-2"),
        reason: "Implementation exposed an upstream design flaw.",
        restarted_at_revision: parseSafeInteger(8),
        superseded_results: [],
        cleared_waivers: [],
        human_provenance: {
          schema_version: "1",
          actor_class: "human",
          assurance: "connected-request-trace",
          channel: "connected-host",
          connection_id: parseSafeId("connection-1"),
          invocation_id: parseSafeId("invocation-1"),
          request_id_digest: parseSha256Digest("9".repeat(64)),
          request_digest: parseSha256Digest("8".repeat(64)),
        },
      }],
    };

    const before = await inspectWorkspaceCleanup(dependencies, authority.value, state);
    expect(before).toMatchObject({ ok: true, value: { cleanup_pending: true } });
    const cleaned = await cleanTaskWorkspace(dependencies, authority.value, state);
    expect(cleaned).toMatchObject({ ok: true, value: { cleanup_pending: false } });
    expect(existsSync(join(runtimeRoot, "cache", "results", liveDigest, "payload", "prd.md"))).toBe(true);
    expect(existsSync(join(runtimeRoot, "cache", "results", staleDigest))).toBe(false);
    expect(existsSync(join(runtimeRoot, "cache", "phases", "1"))).toBe(false);
    expect(existsSync(join(runtimeRoot, "cache", "phases", "2", "verification.txt"))).toBe(true);
    expect(existsSync(join(taskRoot, "authority", "results", `${liveDigest}.json`))).toBe(true);
    expect(existsSync(join(taskRoot, "authority", "results", `${staleDigest}.json`))).toBe(false);
    expect(existsSync(join(taskRoot, "authority", "decisions", "live-gate", "request.json"))).toBe(true);
    expect(existsSync(join(taskRoot, "authority", "decisions", "restart-gate", "request.json"))).toBe(true);
    expect(existsSync(join(taskRoot, "authority", "decisions", "stale-gate"))).toBe(false);

    const terminal = await cleanTerminalTaskWorkspace(dependencies, authority.value);
    expect(terminal).toMatchObject({ ok: true, value: { cleanup_pending: false, retained_files: 0 } });
    expect(existsSync(runtimeRoot)).toBe(false);
  });

  it("protects only authenticated result identities referenced by durable decisions", async () => {
    const root = mkdtempSync(join(tmpdir(), "archflow-cleanup-identity-"));
    roots.push(root);
    execFileSync("git", ["init", "-q", "-b", "main"], { cwd: root, env: gitEnv });
    writeFileSync(join(root, "tracked.txt"), "base\n");
    execFileSync("git", ["add", "tracked.txt"], { cwd: root, env: gitEnv });
    execFileSync("git", ["commit", "-qm", "base"], { cwd: root, env: gitEnv });

    const taskId = parseTaskSlug("cleanup-identity");
    const phase = parsePhaseInstanceId("design");
    const context = {
      task_id: taskId,
      phase_instance: phase,
      operation: parseSafeCode("clean-identity-test"),
      attempt: parseSafeInteger(1),
    };
    const discovered = await discoverWorktree(createGitRunner({ cwd: root }), context);
    if (!discovered.ok) throw discovered.error;
    const environment = await preflightGit(discovered.value, context);
    if (!environment.ok) throw environment.error;
    const authority = await createInternalTransactionAuthority({ runner: discovered.value, environment: environment.value, task_id: taskId, context });
    if (!authority.ok) throw authority.error;
    const dependencies = { runner: discovered.value, environment: environment.value } as TransactionDependencies;

    const directResult = resultManifest({
      taskId, phase, repositoryIdentityDigest: authority.value.repository_identity_digest,
      resultId: "direct-result", incidentalDigest: parseSha256Digest("a".repeat(64)),
    });
    const directArtifact = resultManifest({
      taskId, phase, repositoryIdentityDigest: authority.value.repository_identity_digest,
      resultId: "direct-artifact", incidentalDigest: parseSha256Digest("b".repeat(64)),
    });
    const incidentalDigest = parseSha256Digest("c".repeat(64));
    const incidental = resultManifest({
      taskId, phase, repositoryIdentityDigest: authority.value.repository_identity_digest,
      resultId: "incidental", incidentalDigest,
    });
    const malformedDigest = parseSha256Digest("d".repeat(64));
    const resultsRoot = join(authority.value.task_root, "authority", "results");
    mkdirSync(resultsRoot, { recursive: true });
    writeFileSync(join(resultsRoot, `${directResult.digest}.json`), directResult.bytes);
    writeFileSync(join(resultsRoot, `${directArtifact.digest}.json`), directArtifact.bytes);
    writeFileSync(join(resultsRoot, `${incidental.digest}.json`), incidental.bytes);
    writeFileSync(join(resultsRoot, `${malformedDigest}.json`), "{ malformed");

    const gateId = "identity-gate";
    const decisionRoot = join(authority.value.task_root, "authority", "decisions", gateId);
    mkdirSync(decisionRoot, { recursive: true });
    writeFileSync(join(decisionRoot, "request.json"), JSON.stringify({
      direct_result_digest: directResult.digest,
      direct_artifact_digest: directArtifact.value.artifact_digest,
      incidental_nested_digest: incidentalDigest,
    }));

    const state: TaskStateV1 = {
      schema_version: "1",
      task_id: taskId,
      repository_identity_digest: authority.value.repository_identity_digest,
      revision: parseSafeInteger(2),
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
      authoritative_results: [],
      approvals: [{
        gate_id: gateId as never,
        gate_kind: "artifact-approval",
        subject_digest: directArtifact.value.artifact_digest,
        decision_digest: parseSha256Digest("7".repeat(64)),
        resolved_at_revision: parseSafeInteger(1),
      }],
      waivers: [],
    };

    const cleaned = await cleanTaskWorkspace(dependencies, authority.value, state);
    expect(cleaned).toMatchObject({ ok: true, value: { cleanup_pending: false } });
    expect(existsSync(join(resultsRoot, `${directResult.digest}.json`))).toBe(true);
    expect(existsSync(join(resultsRoot, `${directArtifact.digest}.json`))).toBe(true);
    expect(existsSync(join(resultsRoot, `${incidental.digest}.json`))).toBe(false);
    expect(existsSync(join(resultsRoot, `${malformedDigest}.json`))).toBe(true);
  });

  it("clears the untracked phase documents a backward restart supersedes", async () => {
    const root = mkdtempSync(join(tmpdir(), "archflow-restart-documents-"));
    roots.push(root);
    execFileSync("git", ["init", "-q", "-b", "main"], { cwd: root, env: gitEnv });

    const taskId = parseTaskSlug("restart-task");
    const taskPath = `.archflow/tasks/${taskId}`;
    const taskRoot = join(root, taskPath);
    mkdirSync(join(taskRoot, "phases", "1"), { recursive: true });
    mkdirSync(join(taskRoot, "phases", "2"), { recursive: true });
    mkdirSync(join(taskRoot, "phases", "3"), { recursive: true });
    writeFileSync(join(taskRoot, "phases", "1", "design.md"), "# Phase 1\n");
    writeFileSync(join(taskRoot, "phases", "1", "impl-notes.md"), "# Phase 1 log\n");
    writeFileSync(join(taskRoot, "phases", "2", "design.md"), "# Phase 2\n");
    execFileSync("git", ["add", "--", taskPath], { cwd: root, env: gitEnv });
    execFileSync("git", ["commit", "-qm", "base"], { cwd: root, env: gitEnv });
    // Left behind by the abandoned phase-impl-2 attempt and a speculative later phase design.
    writeFileSync(join(taskRoot, "phases", "2", "impl-notes.md"), "# Abandoned attempt\n");
    writeFileSync(join(taskRoot, "phases", "3", "design.md"), "# Never approved\n");

    const context = {
      task_id: taskId,
      phase_instance: parsePhaseInstanceId("phase-design-2"),
      operation: parseSafeCode("restart-documents-test"),
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
    const dependencies = { runner: discovered.value, environment: environment.value } as TransactionDependencies;

    expect(await removeSupersededPhaseDocuments(dependencies, authority.value, "phase-design-2"))
      .toEqual(["phases/2/impl-notes.md", "phases/3/design.md"]);
    expect(existsSync(join(taskRoot, "phases", "2", "impl-notes.md"))).toBe(false);
    expect(existsSync(join(taskRoot, "phases", "3"))).toBe(false);
    // The phase the restart returns to keeps its design, and committed history is never touched.
    expect(existsSync(join(taskRoot, "phases", "2", "design.md"))).toBe(true);
    expect(existsSync(join(taskRoot, "phases", "1", "impl-notes.md"))).toBe(true);

    // A tracked document is already in history; removing it would only move the same unauthorized
    // change into the next commit as a deletion.
    expect(await removeSupersededPhaseDocuments(dependencies, authority.value, "design")).toEqual([]);
    expect(existsSync(join(taskRoot, "phases", "1", "impl-notes.md"))).toBe(true);
  });
});

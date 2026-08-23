import { execFileSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, renameSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterAll, describe, expect, it } from "vitest";

import { gitBlobOid, parseGitOid, sha256Bytes } from "../../src/contracts/canonical.js";
import type { ImplementationOutputV1 } from "../../src/contracts/durable-implementation-output.js";
import { parseSafeId, parseSafeInteger, parseSha256Digest, parseTaskSlug } from "../../src/contracts/evidence.js";
import { encodePhaseInstance, parsePositiveSafePhaseNumber } from "../../src/contracts/phase-instance.js";
import { parseRepositoryPathClaim } from "../../src/contracts/path-claims.js";
import {
  createGitRunner,
  hashGitBlob,
  hashGitBlobIdentity,
  isCommitAncestorOfHead,
  readFirstParentChildAfter,
  readGitBlobBytes,
  readCommitTreeBlob,
  readChangedGitPaths,
  readGitBlobSize,
} from "../../src/repository/git.js";
import { discoverWorktree } from "../../src/repository/identity.js";
import {
  deriveImplementationDiffDigest,
  deriveIndexIdentityDigest,
  deriveSnapshotDigest,
  deriveWorktreeIdentityDigest,
  verifyImplementationManifest,
  type SnapshotObservation,
} from "../../src/state/implementation-manifest.js";

const roots: string[] = [];
afterAll(() => roots.forEach((root) => rmSync(root, { recursive: true, force: true })));

function verificationEvidence(root: string, taskId: string): ImplementationOutputV1["verification_evidence"] {
  const bytes = new TextEncoder().encode("$ npm test\nall tests passed\n");
  const directory = join(root, ".archflow", "runtime", "tasks", taskId, "cache", "phases", "11");
  mkdirSync(directory, { recursive: true });
  writeFileSync(join(directory, "verification.txt"), bytes);
  return { transcript_digest: sha256Bytes(bytes), byte_count: parseSafeInteger(bytes.byteLength) };
}

describe("Git object proofs", () => {
  it("selects only the first child after an exact first-parent baseline", async () => {
    const root = mkdtempSync(join(tmpdir(), "archflow-first-parent-proof-"));
    roots.push(root);
    execFileSync("git", ["init", "-q", "-b", "main"], { cwd: root });
    execFileSync("git", ["config", "user.email", "test@example.com"], { cwd: root });
    execFileSync("git", ["config", "user.name", "Test"], { cwd: root });
    writeFileSync(join(root, "value.txt"), "root\n");
    execFileSync("git", ["add", "."], { cwd: root });
    execFileSync("git", ["commit", "-qm", "root"], { cwd: root });
    writeFileSync(join(root, "value.txt"), "base\n");
    execFileSync("git", ["commit", "-qam", "base"], { cwd: root });
    const baseline = execFileSync("git", ["rev-parse", "HEAD"], { cwd: root, encoding: "utf8" }).trim();
    writeFileSync(join(root, "value.txt"), "candidate\n");
    execFileSync("git", ["commit", "-qam", "candidate"], { cwd: root });
    const candidate = execFileSync("git", ["rev-parse", "HEAD"], { cwd: root, encoding: "utf8" }).trim();
    execFileSync("git", ["commit", "--allow-empty", "-qm", "descendant"], { cwd: root });
    const descendant = execFileSync("git", ["rev-parse", "HEAD"], { cwd: root, encoding: "utf8" }).trim();
    const runner = createGitRunner({ cwd: root });

    await expect(readFirstParentChildAfter(runner, baseline, descendant)).resolves.toBe(candidate);
    await expect(readFirstParentChildAfter(runner, descendant, descendant)).resolves.toBeUndefined();

    // The baseline is reachable only through the merge's second parent, so it is not on the
    // authorized target first-parent path and cannot nominate a candidate.
    execFileSync("git", ["switch", "-qc", "other", `${baseline}^`], { cwd: root });
    execFileSync("git", ["commit", "--allow-empty", "-qm", "other root"], { cwd: root });
    execFileSync("git", ["merge", "--no-ff", "-qm", "merge baseline second", baseline], { cwd: root });
    const secondParentOnly = execFileSync("git", ["rev-parse", "HEAD"], { cwd: root, encoding: "utf8" }).trim();
    await expect(readFirstParentChildAfter(runner, baseline, secondParentOnly)).resolves.toBeUndefined();
  });

  it("uses path conversion for regular bytes and no conversion for symlink target bytes", async () => {
    const root = mkdtempSync(join(tmpdir(), "archflow-git-proofs-"));
    roots.push(root);
    execFileSync("git", ["init", "-q", "-b", "main"], { cwd: root });
    execFileSync("git", ["config", "user.email", "test@example.com"], { cwd: root });
    execFileSync("git", ["config", "user.name", "Test"], { cwd: root });
    writeFileSync(join(root, ".gitattributes"), "*.txt text eol=lf\n");
    writeFileSync(join(root, "value.txt"), "a\r\nb\r\n");
    symlinkSync("value.txt", join(root, "link"));
    execFileSync("git", ["add", "."], { cwd: root });
    execFileSync("git", ["commit", "-qm", "base"], { cwd: root });
    const head = execFileSync("git", ["rev-parse", "HEAD"], { cwd: root, encoding: "utf8" }).trim();
    const runner = createGitRunner({ cwd: root });

    const regularBytes = new TextEncoder().encode("a\r\nb\r\n");
    expect(await hashGitBlob(runner, regularBytes, "value.txt")).not.toBe(gitBlobOid(regularBytes));
    const target = new TextEncoder().encode("value.txt");
    expect(await hashGitBlob(runner, target)).toBe(gitBlobOid(target));
    expect(await isCommitAncestorOfHead(runner, head)).toBe(true);
    const tree = await readCommitTreeBlob(runner, head, "link");
    expect(tree?.mode).toBe("120000");
    expect(tree === undefined ? -1 : await readGitBlobSize(runner, tree.oid)).toBe(target.byteLength);
    expect(tree === undefined ? undefined : await readGitBlobBytes(runner, tree.oid)).toEqual(target);
    expect(await readChangedGitPaths(runner)).toEqual({ paths: [], unrepresentable_count: 0 });
    writeFileSync(join(root, "unrelated.txt"), "dirty\n");
    expect(await readChangedGitPaths(runner)).toEqual({ paths: ["unrelated.txt"], unrepresentable_count: 0 });
  });

  it("authenticates a raw add and rejects forged identity and undeclared-change facts", async () => {
    const root = mkdtempSync(join(tmpdir(), "archflow-git-manifest-"));
    roots.push(root);
    execFileSync("git", ["init", "-q", "-b", "main"], { cwd: root });
    execFileSync("git", ["config", "user.email", "test@example.com"], { cwd: root });
    execFileSync("git", ["config", "user.name", "Test"], { cwd: root });
    writeFileSync(join(root, "base.txt"), "base\n");
    execFileSync("git", ["add", "."], { cwd: root });
    execFileSync("git", ["commit", "-qm", "base"], { cwd: root });
    const taskId = parseTaskSlug("task-1");
    const phase = encodePhaseInstance({ kind: "phase-impl", phase: parsePositiveSafePhaseNumber(11) });
    const context = { task_id: taskId, phase_instance: phase, operation: "verify-implementation" as never, attempt: parseSafeInteger(1) };
    mkdirSync(join(root, ".archflow", "tasks", taskId), { recursive: true });
    const runnerResult = await discoverWorktree(createGitRunner({ cwd: root }), context);
    if (!runnerResult.ok) throw new Error("worktree discovery failed");
    const runner = runnerResult.value;
    const baseCommit = execFileSync("git", ["rev-parse", "HEAD"], { cwd: root, encoding: "utf8" }).trim() as ImplementationOutputV1["base_commit"];
    const path = parseRepositoryPathClaim("new-output.txt");
    const bytes = new TextEncoder().encode("new output\n");
    writeFileSync(join(root, path), bytes);
    chmodSync(join(root, path), 0o755);
    const oid = await hashGitBlob(runner, bytes, path) as never;
    const size = parseSafeInteger(bytes.byteLength);
    const contentDigest = sha256Bytes(bytes);
    const output = { path, path_class: "repository-source" as const, operation: "add" as const,
      storage: "raw-payload" as const, payload_bytes: size, payload_digest: contentDigest,
      file_type: "regular" as const, after: { oid, mode: "100755" as const, size_bytes: size } };
    const observation: SnapshotObservation = { path, path_class: "repository-source", state: "present",
      file_type: "regular", mode: "100755", size_bytes: size, oid, content_digest: contentDigest };
    const undeclared = { scanned: true, undeclared_paths: [], unrepresentable_count: parseSafeInteger(0) };
    const artifact = { schema_version: "1", artifact_kind: "implementation-output", task_id: taskId,
      phase_instance: phase, step: "produce", base_commit: baseCommit,
      outputs: [output], parent_documents: [], diff_digest: deriveImplementationDiffDigest(baseCommit, [output]),
      snapshot_digest: deriveSnapshotDigest([observation]), restore_targets: [path],
      index_identity_digest: deriveIndexIdentityDigest([{ path, state: "absent" }], undeclared),
      worktree_identity_digest: deriveWorktreeIdentityDigest([observation], undeclared),
      accounting: { schema_version: "1", result_bytes: size, task_bytes: size, result_byte_cap: 26214400,
        task_byte_cap: 262144000, counted_entries: [{ path, storage: "raw-payload", stored_bytes: size }], measured_at_revision: parseSafeInteger(1) },
      secret_scan: { schema_version: "1", outcome: "clean", detector_set_id: parseSafeId("test"), scanned_paths: [path] },
      undeclared_changes: undeclared, verification_evidence: verificationEvidence(root, taskId),
      declared_inputs: [], input_fingerprint: parseSha256Digest("1".repeat(64)) } as const satisfies ImplementationOutputV1;
    await expect(verifyImplementationManifest(runner, artifact, context)).resolves.toMatchObject({ raw_payloads: expect.any(Map) });
    await expect(verifyImplementationManifest(runner, { ...artifact, diff_digest: parseSha256Digest("2".repeat(64)) }, context)).rejects.toThrow(/digest/u);
    writeFileSync(join(root, "unrelated.txt"), "dirty\n");
    await expect(verifyImplementationManifest(runner, artifact, context)).rejects.toThrow(/undeclared change report/u);
  });

  it("uses converted blob size and retained base proof for a pure rename under autocrlf", async () => {
    const root = mkdtempSync(join(tmpdir(), "archflow-git-rename-"));
    roots.push(root);
    execFileSync("git", ["init", "-q", "-b", "main"], { cwd: root });
    execFileSync("git", ["config", "user.email", "test@example.com"], { cwd: root });
    execFileSync("git", ["config", "user.name", "Test"], { cwd: root });
    execFileSync("git", ["config", "core.autocrlf", "true"], { cwd: root });
    writeFileSync(join(root, ".gitattributes"), "*.txt text\n");
    const projectedBytes = new TextEncoder().encode("a\r\nb\r\n");
    writeFileSync(join(root, "old.txt"), projectedBytes);
    execFileSync("git", ["add", "."], { cwd: root });
    execFileSync("git", ["commit", "-qm", "base"], { cwd: root });

    const taskId = parseTaskSlug("task-1");
    const phase = encodePhaseInstance({ kind: "phase-impl", phase: parsePositiveSafePhaseNumber(11) });
    const context = { task_id: taskId, phase_instance: phase, operation: "verify-implementation" as never, attempt: parseSafeInteger(1) };
    mkdirSync(join(root, ".archflow", "tasks", taskId), { recursive: true });
    const runnerResult = await discoverWorktree(createGitRunner({ cwd: root }), context);
    if (!runnerResult.ok) throw new Error("worktree discovery failed");
    const runner = runnerResult.value;
    const baseCommit = parseGitOid(execFileSync("git", ["rev-parse", "HEAD"], { cwd: root, encoding: "utf8" }).trim());
    const previousPath = parseRepositoryPathClaim("old.txt");
    const path = parseRepositoryPathClaim("new.txt");
    const tree = await readCommitTreeBlob(runner, baseCommit, previousPath);
    if (tree === undefined) throw new Error("base tree entry missing");
    const convertedSize = parseSafeInteger(await readGitBlobSize(runner, tree.oid));
    expect(convertedSize).toBe(4);
    expect(projectedBytes.byteLength).toBe(6);
    renameSync(join(root, previousPath), join(root, path));
    const observedIdentity = await hashGitBlobIdentity(runner, projectedBytes, path);
    expect(observedIdentity).toEqual({ oid: tree.oid, size_bytes: convertedSize });

    const identity = { oid: parseGitOid(tree.oid), mode: tree.mode as "100644", size_bytes: convertedSize };
    const output = { path, path_class: "repository-source" as const, operation: "rename" as const,
      previous_path: previousPath, storage: "git-object" as const, file_type: "regular" as const,
      before: identity, after: identity };
    const after: SnapshotObservation = { path, path_class: "repository-source", state: "present",
      file_type: "regular", mode: "100644", size_bytes: convertedSize, oid: identity.oid,
      content_digest: sha256Bytes(projectedBytes) };
    const absent: SnapshotObservation = { path: previousPath, path_class: "repository-source", state: "absent" };
    const undeclared = { scanned: true, undeclared_paths: [], unrepresentable_count: parseSafeInteger(0) };
    const artifact = { schema_version: "1", artifact_kind: "implementation-output", task_id: taskId,
      phase_instance: phase, step: "produce", base_commit: baseCommit, outputs: [output], parent_documents: [],
      diff_digest: deriveImplementationDiffDigest(baseCommit, [output]),
      snapshot_digest: deriveSnapshotDigest([after, absent]), restore_targets: [path, previousPath].sort(),
      index_identity_digest: deriveIndexIdentityDigest([
        { path, state: "absent" },
        { path: previousPath, state: "present", stage: 0, mode: "100644", oid: identity.oid },
      ], undeclared),
      worktree_identity_digest: deriveWorktreeIdentityDigest([after, absent], undeclared),
      accounting: { schema_version: "1", result_bytes: parseSafeInteger(0), task_bytes: parseSafeInteger(0),
        result_byte_cap: 26214400, task_byte_cap: 262144000, counted_entries: [], measured_at_revision: parseSafeInteger(1) },
      secret_scan: { schema_version: "1", outcome: "clean", detector_set_id: parseSafeId("test"), scanned_paths: [path] },
      undeclared_changes: undeclared, verification_evidence: verificationEvidence(root, taskId),
      declared_inputs: [], input_fingerprint: parseSha256Digest("1".repeat(64)) } as const satisfies ImplementationOutputV1;

    const facts = await verifyImplementationManifest(runner, artifact, context);
    expect(facts.snapshot_entries).toEqual([after, absent]);
    expect(facts.raw_payloads.size).toBe(0);
    execFileSync("git", ["prune", "--expire=now"], { cwd: root });
    expect(await readGitBlobBytes(runner, identity.oid)).toEqual(new TextEncoder().encode("a\nb\n"));
  });

  it("authenticates modified binary and symlink payloads plus deletion of a prior raw generation", async () => {
    const root = mkdtempSync(join(tmpdir(), "archflow-git-operations-"));
    roots.push(root);
    execFileSync("git", ["init", "-q", "-b", "main"], { cwd: root });
    execFileSync("git", ["config", "user.email", "test@example.com"], { cwd: root });
    execFileSync("git", ["config", "user.name", "Test"], { cwd: root });
    writeFileSync(join(root, "modify.bin"), new Uint8Array([0, 1, 2]));
    execFileSync("git", ["add", "."], { cwd: root });
    execFileSync("git", ["commit", "-qm", "base"], { cwd: root });

    const taskId = parseTaskSlug("task-1");
    const phase = encodePhaseInstance({ kind: "phase-impl", phase: parsePositiveSafePhaseNumber(11) });
    const context = { task_id: taskId, phase_instance: phase, operation: "verify-implementation" as never, attempt: parseSafeInteger(1) };
    mkdirSync(join(root, ".archflow", "tasks", taskId), { recursive: true });
    const runnerResult = await discoverWorktree(createGitRunner({ cwd: root }), context);
    if (!runnerResult.ok) throw new Error("worktree discovery failed");
    const runner = runnerResult.value;
    const baseCommit = parseGitOid(execFileSync("git", ["rev-parse", "HEAD"], { cwd: root, encoding: "utf8" }).trim());
    const modifyPath = parseRepositoryPathClaim("modify.bin");
    const linkPath = parseRepositoryPathClaim("new-link");
    const deletedPath = parseRepositoryPathClaim("prior.bin");
    const baseTree = await readCommitTreeBlob(runner, baseCommit, modifyPath);
    if (baseTree === undefined) throw new Error("base tree entry missing");
    const beforeModify = { oid: parseGitOid(baseTree.oid), mode: "100644" as const,
      size_bytes: parseSafeInteger(await readGitBlobSize(runner, baseTree.oid)) };

    const modifiedBytes = new Uint8Array([0, 255, 10, 13, 1]);
    writeFileSync(join(root, modifyPath), modifiedBytes);
    const modifiedGit = await hashGitBlobIdentity(runner, modifiedBytes, modifyPath);
    const afterModify = { oid: parseGitOid(modifiedGit.oid), mode: "100644" as const,
      size_bytes: parseSafeInteger(modifiedGit.size_bytes) };
    const linkBytes = new TextEncoder().encode("modify.bin");
    symlinkSync("modify.bin", join(root, linkPath));
    const linkIdentity = { oid: parseGitOid(gitBlobOid(linkBytes)), mode: "120000" as const,
      size_bytes: parseSafeInteger(linkBytes.byteLength) };
    const priorBytes = new Uint8Array([9, 0, 8, 255]);
    const priorGit = await hashGitBlobIdentity(runner, priorBytes, deletedPath);
    const priorIdentity = { oid: parseGitOid(priorGit.oid), mode: "100644" as const,
      size_bytes: parseSafeInteger(priorGit.size_bytes) };
    const outputs = [
      { path: modifyPath, path_class: "repository-source" as const, operation: "modify" as const,
        storage: "raw-payload" as const, payload_bytes: parseSafeInteger(modifiedBytes.byteLength),
        payload_digest: sha256Bytes(modifiedBytes), file_type: "regular" as const,
        before: beforeModify, after: afterModify },
      { path: linkPath, path_class: "repository-source" as const, operation: "add" as const,
        storage: "raw-payload" as const, payload_bytes: parseSafeInteger(linkBytes.byteLength),
        payload_digest: sha256Bytes(linkBytes), file_type: "symlink" as const, after: linkIdentity },
      { path: deletedPath, path_class: "repository-source" as const, operation: "delete" as const,
        storage: "git-object" as const, file_type: "regular" as const, before: priorIdentity },
    ];
    const linkObservation: SnapshotObservation = { path: linkPath, path_class: "repository-source", state: "present",
      file_type: "symlink", mode: "120000", size_bytes: linkIdentity.size_bytes, oid: linkIdentity.oid,
      content_digest: sha256Bytes(linkBytes) };
    const modifyObservation: SnapshotObservation = { path: modifyPath, path_class: "repository-source", state: "present",
      file_type: "regular", mode: "100644", size_bytes: afterModify.size_bytes, oid: afterModify.oid,
      content_digest: sha256Bytes(modifiedBytes) };
    const deletedObservation: SnapshotObservation = { path: deletedPath, path_class: "repository-source", state: "absent" };
    const observations = [modifyObservation, linkObservation, deletedObservation] as const;
    const undeclared = { scanned: true, undeclared_paths: [], unrepresentable_count: parseSafeInteger(0) };
    const resultBytes = parseSafeInteger(linkBytes.byteLength + modifiedBytes.byteLength);
    const artifact = { schema_version: "1", artifact_kind: "implementation-output", task_id: taskId,
      phase_instance: phase, step: "produce", base_commit: baseCommit, outputs, parent_documents: [],
      diff_digest: deriveImplementationDiffDigest(baseCommit, outputs),
      snapshot_digest: deriveSnapshotDigest(observations), restore_targets: [modifyPath, linkPath, deletedPath],
      index_identity_digest: deriveIndexIdentityDigest([
        { path: modifyPath, state: "present", stage: 0, mode: "100644", oid: beforeModify.oid },
        { path: linkPath, state: "absent" },
        { path: deletedPath, state: "absent" },
      ], undeclared),
      worktree_identity_digest: deriveWorktreeIdentityDigest(observations, undeclared),
      accounting: { schema_version: "1", result_bytes: resultBytes, task_bytes: resultBytes,
        result_byte_cap: 26214400, task_byte_cap: 262144000,
        counted_entries: [
          { path: modifyPath, storage: "raw-payload", stored_bytes: parseSafeInteger(modifiedBytes.byteLength) },
          { path: linkPath, storage: "raw-payload", stored_bytes: parseSafeInteger(linkBytes.byteLength) },
        ], measured_at_revision: parseSafeInteger(1) },
      secret_scan: { schema_version: "1", outcome: "clean", detector_set_id: parseSafeId("test"),
        scanned_paths: [modifyPath, linkPath] }, undeclared_changes: undeclared,
      verification_evidence: verificationEvidence(root, taskId), declared_inputs: [],
      input_fingerprint: parseSha256Digest("1".repeat(64)) } as const satisfies ImplementationOutputV1;

    execFileSync("git", ["prune", "--expire=now"], { cwd: root });
    const facts = await verifyImplementationManifest(runner, artifact, context, [
      { path: deletedPath, state: "present", identity: priorIdentity, bytes: priorBytes },
    ]);
    expect(facts.raw_payloads.get(modifyPath)).toEqual(modifiedBytes);
    expect(facts.raw_payloads.get(linkPath)).toEqual(linkBytes);
    expect(facts.snapshot_entries).toEqual(observations);
  });
});

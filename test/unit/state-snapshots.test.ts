import { execFileSync } from "node:child_process";
import { mkdtemp, mkdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { canonicalDocument, canonicalJsonDigest, gitBlobOid, sha256Bytes } from "../../src/contracts/canonical.js";
import type { ImplementationOutputV1 } from "../../src/contracts/durable-implementation-output.js";
import type { DocumentArtifactV1 } from "../../src/contracts/durable-document.js";
import type { ResultManifestV1 } from "../../src/contracts/durable-result-manifest.js";
import { parseSafeId, parseSafeInteger, parseSha256Digest, parseTaskSlug, type SafeId, type SafeInteger } from "../../src/contracts/evidence.js";
import { encodePhaseInstance, parsePositiveSafePhaseNumber } from "../../src/contracts/phase-instance.js";
import type { RepositoryPathClaim } from "../../src/contracts/path-claims.js";
import type { SecretScanner } from "../../src/contracts/secret-scan.js";
import type {
  ResolvedPath,
  ResolvedTaskPath,
  ResolvedTaskWorkspacePath,
  ResolvedWorkspacePath,
  WorkspacePathClaim,
} from "../../src/repository/paths.js";
import { createGitRunner, hashGitBlobIdentity } from "../../src/repository/git.js";
import { createAtomicWriter, createProjectionWriter, type ProjectionWriter } from "../../src/state/atomic.js";
import { deriveImplementationDiffDigest } from "../../src/state/implementation-manifest.js";
import {
  applyProjectionPlan,
  deriveDeclaredSnapshotDigest,
  installSnapshot,
  prepareDocumentSnapshot,
  prepareProjectionPlan,
  prepareSnapshot,
  readSnapshotPayload,
  readSnapshot,
  resolveExistingSnapshot,
  restoreSnapshotOutput,
  RESULT_BYTE_CAP,
  TASK_BYTE_CAP,
} from "../../src/state/snapshots.js";

const roots: string[] = [];
afterEach(async () => Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))));

const P = (value: string): RepositoryPathClaim => value as RepositoryPathClaim;
function resolved(absolute: string, path_class: ResolvedPath["path_class"], claim = P("file.txt")): ResolvedPath {
  return Object.freeze({ absolute: absolute as ResolvedTaskPath, path_class, repositoryRelative: claim });
}
function workspaceResolved(
  absolute: string,
  claim = P("cache/results/" + "a".repeat(64) + "/payload/file.txt"),
): ResolvedWorkspacePath {
  return Object.freeze({
    absolute: absolute as ResolvedTaskWorkspacePath,
    path_class: "workspace-result-payload",
    repositoryRelative: claim,
    workspaceRelative: claim as unknown as WorkspacePathClaim,
  });
}

async function root(): Promise<string> {
  const value = await mkdtemp(join(tmpdir(), "archflow-snapshot-"));
  roots.push(value);
  return value;
}

async function documentSnapshotFixture(directory: string, bytes: Uint8Array): Promise<Readonly<{
  manifest: ResultManifestV1;
  payload: { path: RepositoryPathClaim; bytes: Uint8Array; target: ResolvedWorkspacePath };
  manifestTarget: ResolvedPath;
}>> {
  const task = parseTaskSlug("demo");
  const path = P(".archflow/tasks/demo/phases/phase-1-setup.md");
  const payloadTarget = workspaceResolved(join(directory, "payload.md"), P("payload.md"));
  const phase = encodePhaseInstance({ kind: "phase-design", phase: parsePositiveSafePhaseNumber(1) });
  const identity = await hashGitBlobIdentity(createGitRunner({ cwd: directory }), bytes, path);
  const contentDigest = sha256Bytes(bytes);
  const output = { path, path_class: "document" as const, operation: "add" as const, storage: "raw-payload" as const,
    payload_bytes: parseSafeInteger(bytes.byteLength), payload_digest: contentDigest, file_type: "regular" as const,
    after: { oid: identity.oid as never, mode: "100644" as const, size_bytes: parseSafeInteger(identity.size_bytes) } };
  const projections = [{ path, content_digest: contentDigest }];
  const snapshotDigest = deriveDeclaredSnapshotDigest([output], projections);
  const artifact: DocumentArtifactV1 = { schema_version: "1", artifact_kind: "document", task_id: task,
    phase_instance: phase, step: "produce", document_path: P("phases/phase-1-setup.md") as never,
    path_class: "document", byte_count: parseSafeInteger(bytes.byteLength), content_digest: contentDigest,
    declared_inputs: [], input_fingerprint: parseSha256Digest("4".repeat(64)), snapshot_digest: snapshotDigest,
    projection_target: path };
  const manifest: ResultManifestV1 = { schema_version: "1", task_id: task,
    repository_identity_digest: parseSha256Digest("f".repeat(64)), result_id: parseSafeId("result-1"),
    phase_instance: phase, step: "produce", artifact_digest: canonicalJsonDigest(artifact), source_artifact: artifact,
    input_fingerprint: artifact.input_fingerprint, snapshot_digest: snapshotDigest, outputs: [output], projections,
    accounting: { schema_version: "1", result_bytes: parseSafeInteger(bytes.byteLength), task_bytes: parseSafeInteger(bytes.byteLength),
      result_byte_cap: 26214400, task_byte_cap: 262144000,
      counted_entries: [{ path, storage: "raw-payload", stored_bytes: parseSafeInteger(bytes.byteLength) }], measured_at_revision: parseSafeInteger(1) },
    secret_scan: { schema_version: "1", outcome: "clean", detector_set_id: parseSafeId("test"), scanned_paths: [path] } };
  return { manifest, payload: { path, bytes, target: payloadTarget },
    manifestTarget: resolved(join(directory, "manifest.json"), "authority-result", P("manifest.json")) };
}

const cleanScanner: SecretScanner = {
  scan: async (candidates) => ({ schema_version: "1", outcome: "clean", detector_set_id: "test" as SafeId, scanned_paths: candidates.map((item) => item.virtual_path) }),
};

describe("snapshot storage", () => {
  it("preflights payload identities and reuses only identical immutable bytes", async () => {
    const directory = await root();
    const payloadDirectory = join(directory, "payload");
    await mkdir(payloadDirectory);
    const bytes = Buffer.from("retained");
    const byteCount = parseSafeInteger(bytes.byteLength);
    const payloadDigest = sha256Bytes(bytes);
    const output = {
      path: P("file.txt"), path_class: "repository-source", operation: "add", storage: "raw-payload",
      payload_bytes: byteCount, payload_digest: payloadDigest, file_type: "regular",
      after: { oid: gitBlobOid(bytes), mode: "100644", size_bytes: byteCount },
    } as const;
    const projections = [{ path: output.path, content_digest: payloadDigest }];
    const manifest = {
      schema_version: "1", snapshot_digest: deriveDeclaredSnapshotDigest([output], projections), outputs: [output], projections,
      accounting: { schema_version: "1", result_bytes: bytes.byteLength, task_bytes: bytes.byteLength, result_byte_cap: 26214400, task_byte_cap: 262144000, counted_entries: [{ path: output.path, storage: "raw-payload", stored_bytes: bytes.byteLength }], measured_at_revision: 1 },
      secret_scan: { schema_version: "1", outcome: "clean", detector_set_id: "test", scanned_paths: [] },
    } as unknown as ResultManifestV1;
    const payloadTarget = workspaceResolved(join(payloadDirectory, "file.txt"), P("payload/file.txt"));
    const prepared = prepareSnapshot({ manifest, payloads: [{ path: output.path, bytes, target: payloadTarget }], retained_task_bytes: 0 as SafeInteger, validate_manifest: (value) => value as ResultManifestV1 });
    expect(prepared.ok).toBe(true);
    expect(prepareSnapshot({
      manifest: { ...manifest, snapshot_digest: "1".repeat(64) as never },
      payloads: [{ path: output.path, bytes, target: payloadTarget }],
      retained_task_bytes: 0 as SafeInteger,
      validate_manifest: (value) => value as ResultManifestV1,
    })).toMatchObject({ ok: false, error: { code: "SNAPSHOT_INVALID" } });
    if (!prepared.ok) return;
    const manifestTarget = resolved(join(directory, "manifest.json"), "authority-result", P("manifest.json"));
    await expect(installSnapshot(createAtomicWriter(), prepared.value, manifestTarget, directory as ResolvedTaskPath)).resolves.toMatchObject({ ok: true, value: { manifest: "created" } });
    await expect(installSnapshot(createAtomicWriter(), prepared.value, manifestTarget, directory as ResolvedTaskPath)).resolves.toMatchObject({ ok: true, value: { manifest: "reused", payloads_created: 0 } });
    expect(await readFile(payloadTarget.absolute)).toEqual(bytes);
    const symlinkTarget = resolved(join(directory, "manifest-link.json"), "authority-result", P("manifest-link.json"));
    await symlink(manifestTarget.absolute, symlinkTarget.absolute);
    await expect(installSnapshot(createAtomicWriter(), prepared.value, symlinkTarget, directory as ResolvedTaskPath)).resolves.toMatchObject({ ok: false, error: { code: "SNAPSHOT_INVALID" } });
  });

  it("scans tracked bytes before planning and classifies divergent before-images", async () => {
    const directory = await root();
    const target = resolved(join(directory, "file.txt"), "repository-source");
    await writeFile(target.absolute, "human edit");
    const desired = Buffer.from("generated");
    const plan = await prepareProjectionPlan([{ path: P("file.txt"), target, desired: { state: "present", file_type: "regular", mode: "100644", bytes: desired }, authenticated_before: { state: "absent" }, git_tracked: true }], cleanScanner, directory as ResolvedTaskPath);
    expect(plan).toMatchObject({ ok: true, value: { collisions: [{ path: "file.txt" }] } });
    expect(await readFile(target.absolute, "utf8")).toBe("human edit");
  });

  it("rejects the first byte above either copied-byte cap before installation", async () => {
    const directory = await root();
    const payloadTarget = workspaceResolved(join(directory, "payload.bin"), P("payload.bin"));
    const check = (bytes: Uint8Array, retained: number) => {
      const byteCount = parseSafeInteger(bytes.byteLength);
      const digest = sha256Bytes(bytes);
      const output = { path: P("payload.bin"), path_class: "repository-source" as const, operation: "add" as const,
        storage: "raw-payload" as const, payload_bytes: byteCount, payload_digest: digest, file_type: "regular" as const,
        after: { oid: gitBlobOid(bytes), mode: "100644" as const, size_bytes: byteCount } };
      const projections = [{ path: output.path, content_digest: digest }];
      const manifest = { schema_version: "1", snapshot_digest: deriveDeclaredSnapshotDigest([output], projections),
        outputs: [output], projections,
        accounting: { schema_version: "1", result_bytes: byteCount, task_bytes: parseSafeInteger(Math.min(TASK_BYTE_CAP, retained + bytes.byteLength)),
          result_byte_cap: RESULT_BYTE_CAP, task_byte_cap: TASK_BYTE_CAP,
          counted_entries: [{ path: output.path, storage: "raw-payload", stored_bytes: byteCount }], measured_at_revision: 1 },
        secret_scan: { schema_version: "1", outcome: "clean", detector_set_id: "test", scanned_paths: [] } } as unknown as ResultManifestV1;
      return prepareSnapshot({ manifest, payloads: [{ path: output.path, bytes, target: payloadTarget }],
        retained_task_bytes: parseSafeInteger(retained), validate_manifest: (value) => value as ResultManifestV1 });
    };
    expect(check(new Uint8Array(RESULT_BYTE_CAP + 1), 0)).toMatchObject({ ok: false, error: { code: "SNAPSHOT_LIMIT" } });
    expect(check(new Uint8Array(1), TASK_BYTE_CAP)).toMatchObject({ ok: false, error: { code: "SNAPSHOT_LIMIT" } });
    expect(check(new Uint8Array(RESULT_BYTE_CAP), 0)).toMatchObject({ ok: true });
    expect(check(new Uint8Array(1), TASK_BYTE_CAP - 1)).toMatchObject({ ok: true });
    await expect(readFile(payloadTarget.absolute)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("derives a document OID with the projection path's Git conversion and reuses its existing fingerprint unchanged", async () => {
    const directory = await root();
    execFileSync("git", ["init", "-q", "-b", "main"], { cwd: directory });
    await writeFile(join(directory, ".gitattributes"), "*.md text eol=lf\n");
    const bytes = new TextEncoder().encode("a\r\nb\r\n");
    const fixture = await documentSnapshotFixture(directory, bytes);
    const prepared = await prepareDocumentSnapshot({ runner: createGitRunner({ cwd: directory }), manifest: fixture.manifest,
      payloads: [fixture.payload], retained_task_bytes: 0 as SafeInteger });
    expect(prepared).toMatchObject({ ok: true });
    if (!prepared.ok) return;
    const documentOutput = fixture.manifest.outputs[0];
    if (documentOutput === undefined || documentOutput.operation === "delete") throw new TypeError("document output changed");
    expect(documentOutput.after.size_bytes).toBe(4);
    await expect(installSnapshot(createAtomicWriter(), prepared.value, fixture.manifestTarget, directory as ResolvedTaskPath)).resolves.toMatchObject({ ok: true });
    const reference = { phase_instance: fixture.manifest.phase_instance, step: fixture.manifest.step,
      result_digest: prepared.value.result_digest, result_id: fixture.manifest.result_id,
      input_fingerprint: fixture.manifest.input_fingerprint };
    const reused = await resolveExistingSnapshot({ reference, target: fixture.manifestTarget,
      phase_instance: reference.phase_instance, step: reference.step, input_fingerprint: reference.input_fingerprint,
      runner: createGitRunner({ cwd: directory }), worktree_root: directory as ResolvedTaskPath });
    expect(reused).toMatchObject({ ok: true, value: { outcome: "reused", snapshot: { digest: prepared.value.result_digest,
      value: { accounting: { task_bytes: bytes.byteLength, measured_at_revision: 1 } } } } });
    const forged = structuredClone(fixture.manifest);
    const forgedOutput = forged.outputs[0];
    if (forgedOutput === undefined || forgedOutput.operation === "delete") throw new TypeError("document output changed");
    (forgedOutput.after as { oid: string }).oid = "1".repeat(40);
    await expect(prepareDocumentSnapshot({ runner: createGitRunner({ cwd: directory }), manifest: forged,
      payloads: [fixture.payload], retained_task_bytes: 0 as SafeInteger })).resolves.toMatchObject({ ok: false, error: { code: "SNAPSHOT_INVALID" } });
  });

  it("rejects immutable symlink reuse and validates payload bytes on read", async () => {
    const directory = await root();
    const real = join(directory, "real.bin");
    const target = workspaceResolved(join(directory, "payload.bin"), P("payload.bin"));
    const bytes = new TextEncoder().encode("retained");
    await writeFile(real, bytes);
    await symlink(real, target.absolute);
    await expect(readSnapshotPayload({ target, expected_digest: sha256Bytes(bytes), expected_bytes: parseSafeInteger(bytes.byteLength),
      snapshot_digest: parseSha256Digest("a".repeat(64)), worktree_root: directory as ResolvedTaskPath })).resolves.toMatchObject({ ok: false, error: { code: "SNAPSHOT_INVALID" } });
    await rm(target.absolute);
    await writeFile(target.absolute, bytes);
    await expect(readSnapshotPayload({ target, expected_digest: sha256Bytes(bytes), expected_bytes: parseSafeInteger(bytes.byteLength),
      snapshot_digest: parseSha256Digest("a".repeat(64)), worktree_root: directory as ResolvedTaskPath })).resolves.toEqual(expect.objectContaining({ ok: true, value: bytes }));
  });

  it("requires reciprocal rename pairs and classifies a present destination as a collision", async () => {
    const directory = await root();
    const source = resolved(join(directory, "old.txt"), "repository-source", P("old.txt"));
    const destination = resolved(join(directory, "new.txt"), "repository-source", P("new.txt"));
    const original = Buffer.from("original");
    await writeFile(source.absolute, original);
    await writeFile(destination.absolute, "occupied");
    const before = { state: "present" as const, file_type: "regular" as const, mode: "100644" as const,
      size_bytes: original.byteLength, content_digest: sha256Bytes(original) };
    const plan = await prepareProjectionPlan([
      { path: P("old.txt"), target: source, desired: { state: "absent" }, authenticated_before: before,
        rollback: { state: "present", file_type: "regular", mode: "100644", bytes: original }, git_tracked: false,
        rename_pair: { role: "source", peer_path: P("new.txt") } },
      { path: P("new.txt"), target: destination, desired: { state: "present", file_type: "regular", mode: "100644", bytes: original },
        authenticated_before: { state: "absent" }, git_tracked: false,
        rename_pair: { role: "destination", peer_path: P("old.txt") } },
    ], cleanScanner, directory as ResolvedTaskPath);
    expect(plan).toMatchObject({ ok: true, value: { collisions: [{ path: "new.txt" }] } });
  });

  it("re-proves Git-backed bytes on read and restore, then fails after base ancestry is lost", async () => {
    const directory = await root();
    execFileSync("git", ["init", "-q", "-b", "main"], { cwd: directory });
    execFileSync("git", ["config", "user.email", "test@example.com"], { cwd: directory });
    execFileSync("git", ["config", "user.name", "Test"], { cwd: directory });
    await mkdir(join(directory, "src"));
    const bytes = Buffer.from("retained from tree\n");
    await writeFile(join(directory, "src", "index.ts"), bytes);
    execFileSync("git", ["add", "."], { cwd: directory });
    execFileSync("git", ["commit", "-qm", "base"], { cwd: directory });
    const base = execFileSync("git", ["rev-parse", "HEAD"], { cwd: directory, encoding: "utf8" }).trim();
    const oid = execFileSync("git", ["rev-parse", "HEAD:src/index.ts"], { cwd: directory, encoding: "utf8" }).trim();
    const source = JSON.parse(await readFile(new URL("../fixtures/contracts/durable/implementation-output.valid.json", import.meta.url), "utf8")) as ImplementationOutputV1;
    const outputs = structuredClone(source.outputs) as [...ImplementationOutputV1["outputs"]];
    const gitOutput = outputs[1]!;
    if (gitOutput.operation !== "modify" || gitOutput.storage !== "git-object" || gitOutput.file_type !== "regular") throw new TypeError("fixture Git output changed");
    const identity = { oid: oid as never, mode: "100644" as const, size_bytes: parseSafeInteger(bytes.byteLength) };
    outputs[1] = { ...gitOutput, before: identity, after: identity };
    const projections = [
      { path: outputs[0]!.path, content_digest: outputs[0]!.storage === "raw-payload" ? outputs[0]!.payload_digest : parseSha256Digest("d".repeat(64)) },
      { path: gitOutput.path, content_digest: sha256Bytes(bytes) },
    ];
    const snapshotDigest = deriveDeclaredSnapshotDigest(outputs, projections);
    const adjustedSource = { ...source, base_commit: base as never, outputs,
      diff_digest: deriveImplementationDiffDigest(base as never, outputs), snapshot_digest: snapshotDigest };
    const manifest = { schema_version: "1", task_id: source.task_id,
      repository_identity_digest: parseSha256Digest("f".repeat(64)), result_id: parseSafeId("result-git"),
      phase_instance: source.phase_instance, step: source.step, artifact_digest: canonicalJsonDigest(adjustedSource),
      source_artifact: adjustedSource, input_fingerprint: source.input_fingerprint, snapshot_digest: snapshotDigest,
      outputs, projections, accounting: adjustedSource.accounting, secret_scan: adjustedSource.secret_scan } as ResultManifestV1;
    const document = canonicalDocument(manifest);
    const target = resolved(join(directory, "manifest.json"), "authority-result", P("manifest.json"));
    await writeFile(target.absolute, document.bytes);
    const runner = createGitRunner({ cwd: directory });
    await expect(readSnapshot({ target, expected_result_digest: document.digest, runner, worktree_root: directory as ResolvedTaskPath })).resolves.toMatchObject({ ok: true });
    const restored = await restoreSnapshotOutput({ target, expected_result_digest: document.digest, runner,
      output_path: gitOutput.path, worktree_root: directory as ResolvedTaskPath });
    expect(restored).toMatchObject({ ok: true, value: { state: "present" } });
    if (!restored.ok || restored.value.state !== "present") throw new TypeError("restore failed");
    expect(restored.value.bytes).toEqual(new Uint8Array(bytes));
    execFileSync("git", ["checkout", "--orphan", "unrelated"], { cwd: directory, stdio: "ignore" });
    execFileSync("git", ["rm", "-rf", "."], { cwd: directory, stdio: "ignore" });
    await writeFile(join(directory, "other.txt"), "other\n");
    execFileSync("git", ["add", "."], { cwd: directory });
    execFileSync("git", ["commit", "-qm", "unrelated"], { cwd: directory });
    await expect(readSnapshot({ target, expected_result_digest: document.digest, runner, worktree_root: directory as ResolvedTaskPath })).resolves.toMatchObject({ ok: false, error: { code: "SNAPSHOT_INVALID" } });
  });

  it("rechecks each target and rolls back earlier absent writes on a mid-apply race", async () => {
    const directory = await root();
    const first = resolved(join(directory, "a.txt"), "repository-source", P("a.txt"));
    const second = resolved(join(directory, "b.txt"), "repository-source", P("b.txt"));
    const planResult = await prepareProjectionPlan([
      { path: P("a.txt"), target: first, desired: { state: "present", file_type: "regular", mode: "100644", bytes: Buffer.from("a") }, authenticated_before: { state: "absent" }, git_tracked: false },
      { path: P("b.txt"), target: second, desired: { state: "present", file_type: "regular", mode: "100644", bytes: Buffer.from("b") }, authenticated_before: { state: "absent" }, git_tracked: false },
    ], cleanScanner, directory as ResolvedTaskPath);
    if (!planResult.ok) throw new Error("plan failed");
    const real = createProjectionWriter();
    const racing: ProjectionWriter = { ...real, replaceRegular: async (path, bytes, executable) => { await real.replaceRegular(path, bytes, executable); if (path.absolute === first.absolute) await writeFile(second.absolute, "race"); } };
    await expect(applyProjectionPlan(racing, planResult.value)).resolves.toEqual({ outcome: "rolled-back", path: P("b.txt") });
    await expect(readFile(first.absolute)).rejects.toMatchObject({ code: "ENOENT" });
    expect(await readFile(second.absolute, "utf8")).toBe("race");
  });

  it("observes and replaces the validated lexical symlink leaf rather than its referent", async () => {
    const directory = await root();
    const referent = join(directory, "referent.txt");
    const lexical = join(directory, "link.txt");
    await writeFile(referent, "referent bytes");
    await symlink("referent.txt", lexical);
    const target = resolved(referent, "repository-source", P("link.txt"));
    const targetBytes = Buffer.from("referent.txt");
    const plan = await prepareProjectionPlan([{ path: P("link.txt"), target,
      desired: { state: "present", file_type: "symlink", mode: "120000", bytes: targetBytes },
      authenticated_before: { state: "present", file_type: "symlink", mode: "120000",
        size_bytes: targetBytes.byteLength, content_digest: sha256Bytes(targetBytes) },
      rollback: { state: "present", file_type: "symlink", mode: "120000", bytes: targetBytes }, git_tracked: false }],
    cleanScanner, directory as ResolvedTaskPath);
    expect(plan).toMatchObject({ ok: true, value: { entries: [{ disposition: "exact" }], collisions: [] } });
    expect(await readFile(referent, "utf8")).toBe("referent bytes");
  });
});

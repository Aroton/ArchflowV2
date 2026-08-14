import { chmod, lstat, readlink } from "node:fs/promises";
import { resolve as resolvePath } from "node:path";
import { isDeepStrictEqual } from "node:util";

import {
  canonicalDocument,
  canonicalJsonDigest,
  parseCanonicalDocument,
  sha256Bytes,
  type CanonicalDocument,
} from "../contracts/canonical.js";
import type { ProjectionDigestRef } from "../contracts/durable-primitives.js";
import type { ResultManifestV1 } from "../contracts/durable-result-manifest.js";
import { parseResultManifest } from "../contracts/durable-result-manifest.js";
import type { OutputEntry, SnapshotAccountingV1 } from "../contracts/durable-primitives.js";
import type { AuthoritativeResultRef } from "../contracts/durable-state.js";
import { validateDurableSemantics } from "../contracts/durable.js";
import { createProjectError, type ProjectError, type ProjectResult } from "../contracts/errors.js";
import type { SafeInteger, Sha256Digest } from "../contracts/evidence.js";
import type { PathClass, RepositoryPathClaim } from "../contracts/path-claims.js";
import { assertPlainJson } from "../contracts/plain-json.js";
import type { SecretScanResult, SecretScanner } from "../contracts/secret-scan.js";
import { openResolved, type ResolvedPath, type ResolvedTaskPath, type ResolvedWorkspacePath } from "../repository/paths.js";
import {
  isCommitAncestorOfHead,
  hashGitBlobIdentity,
  readCommitTreeBlob,
  readGitBlobBytes,
  readGitBlobProjectedBytes,
  type GitRunner,
} from "../repository/git.js";
import type { AtomicWriter, ProjectionWriter } from "./atomic.js";
import { deriveSnapshotDigest, type SnapshotObservation as DurableSnapshotObservation } from "./implementation-manifest.js";
import { secretScanCandidateFromBytes } from "./secret-scan.js";

export const RESULT_BYTE_CAP = 25 * 1024 * 1024;
export const TASK_BYTE_CAP = 250 * 1024 * 1024;

export type SnapshotManifest = ResultManifestV1;
export type SnapshotStoragePath = ResolvedPath | ResolvedWorkspacePath;

export type SnapshotPayloadInput = Readonly<{
  path: RepositoryPathClaim;
  bytes: Uint8Array;
  target: SnapshotStoragePath;
}>;

export type PreparedSnapshot<M extends SnapshotManifest = SnapshotManifest> = Readonly<{
  manifest: CanonicalDocument<M>;
  result_digest: Sha256Digest;
  payloads: readonly Readonly<{ path: RepositoryPathClaim; bytes: Uint8Array; target: SnapshotStoragePath }>[];
}>;

const ok = <T>(value: T): ProjectResult<T> => Object.freeze({ schema_version: "1", ok: true, value });
const fail = <T = never>(error: ProjectError): ProjectResult<T> => Object.freeze({ schema_version: "1", ok: false, error });

/** Re-derives the normalized final declared scope from manifest operations, independent of retention. */
export function deriveDeclaredSnapshotDigest(
  outputs: readonly OutputEntry[],
  projections: readonly ProjectionDigestRef[],
): Sha256Digest {
  const projectionDigests = new Map(projections.map((projection) => [projection.path, projection.content_digest]));
  if (projectionDigests.size !== projections.length) throw new TypeError("duplicate snapshot projection path");
  const entries = new Map<RepositoryPathClaim, DurableSnapshotObservation>();
  for (const output of outputs) {
    if (entries.has(output.path)) throw new TypeError("duplicate snapshot output path");
    if (output.operation === "delete") {
      entries.set(output.path, { path: output.path, path_class: output.path_class, state: "absent" });
    } else {
      const contentDigest = projectionDigests.get(output.path);
      if (contentDigest === undefined) throw new TypeError("snapshot output lacks its projection digest");
      entries.set(output.path, {
        path: output.path, path_class: output.path_class, state: "present",
        file_type: output.file_type, mode: output.after.mode, size_bytes: output.after.size_bytes,
        oid: output.after.oid, content_digest: contentDigest,
      });
    }
    if (output.operation === "rename") {
      if (entries.has(output.previous_path)) throw new TypeError("duplicate snapshot rename source");
      entries.set(output.previous_path, { path: output.previous_path, path_class: output.path_class, state: "absent" });
    }
  }
  return deriveSnapshotDigest([...entries.values()]);
}

function snapshotInvalid(digest: Sha256Digest, issue_code: string): ProjectResult<never> {
  return fail(createProjectError("SNAPSHOT_INVALID", { snapshot_digest: digest, issue_code }));
}

function ownEnumerableData(value: object, key: string): unknown {
  const descriptor = Object.getOwnPropertyDescriptor(value, key);
  if (descriptor === undefined || !("value" in descriptor) || !descriptor.enumerable) {
    throw new TypeError(`${key} must be an own enumerable data property`);
  }
  return descriptor.value;
}

function cloneBytes(value: unknown, label: string): Uint8Array {
  if (!(value instanceof Uint8Array)) throw new TypeError(`${label} must be bytes`);
  return new Uint8Array(value);
}

function atLexicalLeaf(path: SnapshotStoragePath, worktreeRoot: ResolvedTaskPath): SnapshotStoragePath {
  const absolute = resolvePath(worktreeRoot, path.repositoryRelative);
  return "workspaceRelative" in path
    ? Object.freeze({ ...path, absolute: absolute as ResolvedWorkspacePath["absolute"] })
    : Object.freeze({ ...path, absolute: absolute as ResolvedTaskPath });
}

/** Validates/materializes caller-owned inputs once and preflights both storage caps. */
export function prepareSnapshot<M extends SnapshotManifest>(input: Readonly<{
  manifest: M;
  payloads: readonly SnapshotPayloadInput[];
  retained_task_bytes: SafeInteger;
  validate_manifest: (value: unknown) => M;
}>): ProjectResult<PreparedSnapshot<M>> {
  const rawManifest = ownEnumerableData(input, "manifest");
  assertPlainJson(rawManifest, "result manifest");
  const manifest = structuredClone(rawManifest) as M;
  input.validate_manifest(manifest);
  if (deriveDeclaredSnapshotDigest(manifest.outputs, manifest.projections) !== manifest.snapshot_digest) {
    return snapshotInvalid(manifest.snapshot_digest, "snapshot-digest-mismatch");
  }
  const document = canonicalDocument(manifest);

  const rawPayloads = ownEnumerableData(input, "payloads");
  if (!Array.isArray(rawPayloads)) throw new TypeError("payloads must be an array");
  const payloads = rawPayloads.map((item, index) => {
    if (item === null || typeof item !== "object") throw new TypeError(`payloads[${index}] must be an object`);
    const path = ownEnumerableData(item, "path");
    const target = ownEnumerableData(item, "target");
    const bytes = cloneBytes(ownEnumerableData(item, "bytes"), `payloads[${index}].bytes`);
    if (typeof path !== "string" || target === null || typeof target !== "object") {
      throw new TypeError(`payloads[${index}] has invalid path or target`);
    }
    return Object.freeze({ path: path as RepositoryPathClaim, target: target as SnapshotStoragePath, bytes });
  });

  const byPath = new Map(payloads.map((payload) => [payload.path, payload]));
  if (byPath.size !== payloads.length) return snapshotInvalid(manifest.snapshot_digest, "duplicate-payload-path");
  let resultBytes = 0;
  for (const output of manifest.outputs) {
    if (output.storage === "raw-payload") {
      const payload = byPath.get(output.path);
      if (payload === undefined || payload.target.path_class !== "workspace-result-payload") {
        return snapshotInvalid(manifest.snapshot_digest, "missing-payload");
      }
      if (payload.bytes.byteLength !== output.payload_bytes || sha256Bytes(payload.bytes) !== output.payload_digest) {
        return snapshotInvalid(manifest.snapshot_digest, "payload-identity-mismatch");
      }
      resultBytes += payload.bytes.byteLength;
    } else if (byPath.has(output.path)) {
      return snapshotInvalid(manifest.snapshot_digest, "unexpected-payload");
    }
  }
  if (resultBytes > RESULT_BYTE_CAP) {
    return fail(createProjectError("SNAPSHOT_LIMIT", {
      limit_scope: "result", offending_paths: [...byPath.keys()].sort(), current_bytes: resultBytes, byte_cap: RESULT_BYTE_CAP,
    }));
  }
  const taskBytes = input.retained_task_bytes + resultBytes;
  if (taskBytes > TASK_BYTE_CAP) {
    return fail(createProjectError("SNAPSHOT_LIMIT", {
      limit_scope: "task", offending_paths: [...byPath.keys()].sort(), current_bytes: taskBytes, byte_cap: TASK_BYTE_CAP,
    }));
  }
  if (manifest.accounting.result_bytes !== resultBytes || manifest.accounting.task_bytes !== taskBytes) {
    return snapshotInvalid(manifest.snapshot_digest, "accounting-mismatch");
  }
  return ok(Object.freeze({ manifest: document, result_digest: document.digest, payloads: Object.freeze(payloads) }));
}

/** Adds the path-aware Git identity proof required for every document projection. */
export async function prepareDocumentSnapshot(input: Readonly<{
  runner: GitRunner;
  manifest: ResultManifestV1;
  payloads: readonly SnapshotPayloadInput[];
  retained_task_bytes: SafeInteger;
}>): Promise<ProjectResult<PreparedSnapshot<ResultManifestV1>>> {
  const manifestValue = ownEnumerableData(input, "manifest");
  const payloadValue = ownEnumerableData(input, "payloads");
  if (manifestValue === null || typeof manifestValue !== "object" || !Array.isArray(payloadValue)) {
    throw new TypeError("document snapshot input is invalid");
  }
  const prepared = prepareSnapshot({
    manifest: manifestValue as ResultManifestV1,
    payloads: payloadValue,
    retained_task_bytes: input.retained_task_bytes,
    validate_manifest: parseResultManifest,
  });
  if (!prepared.ok) return prepared;
  const manifest = prepared.value.manifest.value;
  if (manifest.source_artifact.artifact_kind !== "document") throw new TypeError("document snapshot requires a document artifact");
  const expectedCount = 1 + (manifest.source_artifact.additional_documents?.length ?? 0);
  if (manifest.outputs.length !== expectedCount || prepared.value.payloads.length !== expectedCount) {
    return snapshotInvalid(manifest.snapshot_digest, "document-output-shape-mismatch");
  }
  const payloads = new Map(prepared.value.payloads.map((payload) => [payload.path, payload]));
  for (const output of manifest.outputs) {
    const payload = payloads.get(output.path);
    if (output.operation === "delete" || payload === undefined) {
      return snapshotInvalid(manifest.snapshot_digest, "document-output-shape-mismatch");
    }
    const identity = await hashGitBlobIdentity(input.runner, payload.bytes, output.path);
    if (output.after.oid !== identity.oid || output.after.size_bytes !== identity.size_bytes) {
      return snapshotInvalid(manifest.snapshot_digest, "document-git-identity-mismatch");
    }
  }
  return prepared;
}

async function installOne(atomic: AtomicWriter, target: SnapshotStoragePath, bytes: Uint8Array): Promise<"created" | "reused"> {
  const created = await atomic.createExclusive(target, bytes);
  if (created === "created") return "created";
  let existing: Uint8Array;
  try {
    const handle = await openResolved(target.absolute, 0);
    existing = new Uint8Array(await handle.readFile().finally(() => handle.close()));
  } catch {
    throw new TypeError("immutable snapshot target became unreadable");
  }
  if (!Buffer.from(existing).equals(Buffer.from(bytes))) throw new TypeError("immutable snapshot target disagrees");
  return "reused";
}

/** Installs payloads first and the manifest last; existing identical bytes are reused, never clobbered. */
export async function installSnapshot<M extends SnapshotManifest>(
  atomic: AtomicWriter,
  prepared: PreparedSnapshot<M>,
  manifestTarget: ResolvedPath,
  worktreeRoot: ResolvedTaskPath,
): Promise<ProjectResult<Readonly<{ manifest: "created" | "reused"; payloads_created: number }>>> {
  if (manifestTarget.path_class !== "authority-result") throw new TypeError("manifest target has wrong class");
  try {
    let payloadsCreated = 0;
    for (const payload of prepared.payloads) {
      if (await installOne(atomic, atLexicalLeaf(payload.target, worktreeRoot), payload.bytes) === "created") payloadsCreated += 1;
    }
    const manifest = await installOne(atomic, atLexicalLeaf(manifestTarget, worktreeRoot), prepared.manifest.bytes);
    return ok(Object.freeze({ manifest, payloads_created: payloadsCreated }));
  } catch {
    return snapshotInvalid(prepared.manifest.value.snapshot_digest, "immutable-install-disagreement");
  }
}

export async function readSnapshot(input: Readonly<{
  target: ResolvedPath;
  expected_result_digest: Sha256Digest;
  runner: GitRunner;
  worktree_root: ResolvedTaskPath;
}>): Promise<ProjectResult<CanonicalDocument<ResultManifestV1>>> {
  if (input.target.path_class !== "authority-result") throw new TypeError("manifest target has wrong class");
  let document: CanonicalDocument<ResultManifestV1>;
  try {
    const handle = await openResolved(atLexicalLeaf(input.target, input.worktree_root).absolute, 0);
    const bytes = await handle.readFile().finally(() => handle.close());
    document = parseCanonicalDocument<ResultManifestV1>(bytes, "result manifest");
    parseResultManifest(document.value);
  } catch {
    return snapshotInvalid(input.expected_result_digest, "manifest-unreadable");
  }
  if (document.digest !== input.expected_result_digest) {
    return snapshotInvalid(document.value.snapshot_digest, "result-digest-mismatch");
  }
  const semantics = validateDurableSemantics({ result_manifest: document });
  if (!semantics.ok) return snapshotInvalid(document.value.snapshot_digest, "manifest-semantics-invalid");
  if (deriveDeclaredSnapshotDigest(document.value.outputs, document.value.projections) !== document.value.snapshot_digest) {
    return snapshotInvalid(document.value.snapshot_digest, "snapshot-digest-mismatch");
  }
  const source = document.value.source_artifact;
  if (source.artifact_kind === "implementation-output") {
    const projections = new Map(document.value.projections.map((projection) => [projection.path, projection.content_digest]));
    const gitOutputs = document.value.outputs.filter((output) => output.storage === "git-object");
    if (gitOutputs.length !== 0) {
      try {
        if (!await isCommitAncestorOfHead(input.runner, source.base_commit)) {
          return snapshotInvalid(document.value.snapshot_digest, "base-commit-not-retained");
        }
        for (const output of gitOutputs) {
          const proofPath = output.operation === "rename" ? output.previous_path : output.path;
          const expected = output.operation === "delete" ? output.before : output.after;
          const proof = await readCommitTreeBlob(input.runner, source.base_commit, proofPath);
          if (proof?.oid !== expected.oid || proof.mode !== expected.mode) {
            return snapshotInvalid(document.value.snapshot_digest, "git-object-tree-proof-mismatch");
          }
          const blobBytes = await readGitBlobBytes(input.runner, expected.oid);
          if (blobBytes.byteLength !== expected.size_bytes) {
            return snapshotInvalid(document.value.snapshot_digest, "git-object-size-mismatch");
          }
          if (output.operation !== "delete") {
            const projectedBytes = output.file_type === "regular"
              ? await readGitBlobProjectedBytes(input.runner, expected.oid, output.path)
              : blobBytes;
            if (sha256Bytes(projectedBytes) !== projections.get(output.path)) {
              return snapshotInvalid(document.value.snapshot_digest, "projection-digest-mismatch");
            }
          }
        }
      } catch {
        return snapshotInvalid(document.value.snapshot_digest, "git-object-proof-unavailable");
      }
    }
  }
  return ok(document);
}

/** Reloads one retained after-image; Git-backed outputs are re-proved by `readSnapshot` first. */
export async function restoreSnapshotOutput(input: Readonly<{
  target: ResolvedPath;
  expected_result_digest: Sha256Digest;
  runner: GitRunner;
  worktree_root: ResolvedTaskPath;
  output_path: RepositoryPathClaim;
  payload_target?: SnapshotStoragePath;
}>): Promise<ProjectResult<ProjectionDesired>> {
  const read = await readSnapshot({
    target: input.target,
    expected_result_digest: input.expected_result_digest,
    runner: input.runner,
    worktree_root: input.worktree_root,
  });
  if (!read.ok) return read;
  const output = read.value.value.outputs.find((candidate) => candidate.path === input.output_path);
  if (output === undefined) return snapshotInvalid(read.value.value.snapshot_digest, "output-not-declared");
  if (output.operation === "delete") return ok(Object.freeze({ state: "absent" }));
  let bytes: Uint8Array;
  if (output.storage === "git-object") {
    try {
      bytes = output.file_type === "regular"
        ? await readGitBlobProjectedBytes(input.runner, output.after.oid, output.path)
        : await readGitBlobBytes(input.runner, output.after.oid);
    }
    catch { return snapshotInvalid(read.value.value.snapshot_digest, "git-object-proof-unavailable"); }
  } else {
    const manifestMatch = /^\.archflow\/tasks\/([^/]+)\/authority\/results\/([0-9a-f]{64})\.json$/u
      .exec(input.target.repositoryRelative);
    if (manifestMatch === null) {
      return snapshotInvalid(read.value.value.snapshot_digest, "manifest-path-mismatch");
    }
    const expectedPayloadPath = `.archflow/runtime/tasks/${manifestMatch[1]}/cache/results/${manifestMatch[2]}/payload/${output.path}`;
    if (input.payload_target === undefined || input.payload_target.repositoryRelative !== expectedPayloadPath) {
      return snapshotInvalid(read.value.value.snapshot_digest, "payload-path-mismatch");
    }
    const payload = await readSnapshotPayload({
      target: input.payload_target,
      expected_digest: output.payload_digest,
      expected_bytes: output.payload_bytes,
      snapshot_digest: read.value.value.snapshot_digest,
      worktree_root: input.worktree_root,
    });
    if (!payload.ok) return payload;
    bytes = payload.value;
  }
  if (output.file_type === "symlink") {
    return ok(Object.freeze({ state: "present", file_type: "symlink", mode: "120000", bytes }));
  }
  return ok(Object.freeze({ state: "present", file_type: "regular", mode: output.after.mode, bytes }));
}

export type ExistingSnapshotResolution =
  | Readonly<{ outcome: "miss" }>
  | Readonly<{ outcome: "reused"; snapshot: CanonicalDocument<ResultManifestV1> }>;

/** Resolves the current logical result before minting new accounting or a new content address. */
export async function resolveExistingSnapshot(input: Readonly<{
  reference: AuthoritativeResultRef | undefined;
  target: ResolvedPath | undefined;
  phase_instance: ResultManifestV1["phase_instance"];
  step: ResultManifestV1["step"];
  input_fingerprint: Sha256Digest;
  runner: GitRunner;
  worktree_root: ResolvedTaskPath;
}>): Promise<ProjectResult<ExistingSnapshotResolution>> {
  const referenceValue = ownEnumerableData(input, "reference");
  const targetValue = ownEnumerableData(input, "target");
  if (referenceValue === undefined || targetValue === undefined) return ok(Object.freeze({ outcome: "miss" }));
  assertPlainJson(referenceValue, "authoritative result reference");
  const reference = structuredClone(referenceValue) as AuthoritativeResultRef;
  if (
    reference.phase_instance !== input.phase_instance || reference.step !== input.step ||
    reference.input_fingerprint !== input.input_fingerprint
  ) return ok(Object.freeze({ outcome: "miss" }));
  if (targetValue === null || typeof targetValue !== "object") throw new TypeError("snapshot target must be resolved");
  assertPlainJson(targetValue, "resolved snapshot target");
  const target = structuredClone(targetValue) as unknown as ResolvedPath;
  if (target.path_class !== "authority-result") return snapshotInvalid(reference.result_digest, "manifest-path-mismatch");
  const read = await readSnapshot({ target, expected_result_digest: reference.result_digest, runner: input.runner, worktree_root: input.worktree_root });
  if (!read.ok) return read;
  const manifest = read.value.value;
  if (
    manifest.phase_instance !== reference.phase_instance || manifest.step !== reference.step ||
    manifest.input_fingerprint !== reference.input_fingerprint || manifest.result_id !== reference.result_id
  ) return snapshotInvalid(manifest.snapshot_digest, "result-reference-mismatch");
  return ok(Object.freeze({ outcome: "reused", snapshot: read.value }));
}

/** Reads one manifest-named raw payload and re-establishes its exact byte identity. */
export async function readSnapshotPayload(input: Readonly<{
  target: SnapshotStoragePath;
  expected_digest: Sha256Digest;
  expected_bytes: SafeInteger;
  snapshot_digest: Sha256Digest;
  worktree_root: ResolvedTaskPath;
}>): Promise<ProjectResult<Uint8Array>> {
  if (input.target.path_class !== "workspace-result-payload") throw new TypeError("payload target has wrong class");
  try {
    const handle = await openResolved(atLexicalLeaf(input.target, input.worktree_root).absolute, 0);
    const bytes = new Uint8Array(await handle.readFile().finally(() => handle.close()));
    if (bytes.byteLength !== input.expected_bytes || sha256Bytes(bytes) !== input.expected_digest) {
      return snapshotInvalid(input.snapshot_digest, "payload-identity-mismatch");
    }
    return ok(bytes);
  } catch {
    return snapshotInvalid(input.snapshot_digest, "payload-unreadable");
  }
}

export type ProjectionObservation =
  | Readonly<{ state: "absent" }>
  | Readonly<{ state: "present"; file_type: "regular" | "symlink"; mode: "100644" | "100755" | "120000"; size_bytes: number; content_digest: Sha256Digest }>;

export type ProjectionDesired =
  | Readonly<{ state: "absent" }>
  | Readonly<{ state: "present"; file_type: "regular"; mode: "100644" | "100755"; bytes: Uint8Array }>
  | Readonly<{ state: "present"; file_type: "symlink"; mode: "120000"; bytes: Uint8Array }>;

export type ProjectionSource = Readonly<{
  path: RepositoryPathClaim;
  target: SnapshotStoragePath;
  desired: ProjectionDesired;
  authenticated_before: ProjectionObservation;
  /** Required when a present before-image may need rollback; bytes are authenticated below. */
  rollback?: ProjectionDesired;
  git_tracked: boolean;
  rename_pair?: Readonly<{ role: "source" | "destination"; peer_path: RepositoryPathClaim }>;
}>;

export type ProjectionPlanEntry = Readonly<{
  path: RepositoryPathClaim;
  target: SnapshotStoragePath;
  observed_before: ProjectionObservation;
  desired: ProjectionDesired;
  rollback?: ProjectionDesired;
  /** Preserved from the authenticated source so a restore gate can re-run projection preparation. */
  git_tracked?: boolean;
  disposition: "exact" | "restore-ready" | "collision";
  rename_pair?: Readonly<{ role: "source" | "destination"; peer_path: RepositoryPathClaim }>;
}>;

export type ProjectionPlan = Readonly<{
  entries: readonly ProjectionPlanEntry[];
  collisions: readonly Readonly<{ path: RepositoryPathClaim; path_class: SnapshotStoragePath["path_class"] }>[];
  collision_choices: readonly ["discard-and-restore", "adopt-as-new-generation", "abort"];
}>;

export type CapturedProjectionTarget = Readonly<{
  observation: ProjectionObservation;
  rollback: ProjectionDesired;
}>;

/** Captures one target generation once, retaining the exact bytes needed for safe rollback. */
export async function captureProjectionTarget(path: SnapshotStoragePath): Promise<CapturedProjectionTarget> {
  try {
    const stat = await lstat(path.absolute);
    if (stat.isSymbolicLink()) {
      const bytes = Buffer.from(await readlink(path.absolute), "utf8");
      return Object.freeze({
        observation: Object.freeze({ state: "present", file_type: "symlink", mode: "120000", size_bytes: bytes.byteLength, content_digest: sha256Bytes(bytes) }),
        rollback: Object.freeze({ state: "present", file_type: "symlink", mode: "120000", bytes }),
      });
    }
    if (!stat.isFile()) throw new TypeError("declared target is not a regular file or symlink");
    const handle = await openResolved(path.absolute, 0);
    const bytes = new Uint8Array(await handle.readFile().finally(() => handle.close()));
    const mode = (stat.mode & 0o111) === 0 ? "100644" as const : "100755" as const;
    return Object.freeze({
      observation: Object.freeze({ state: "present", file_type: "regular", mode, size_bytes: bytes.byteLength, content_digest: sha256Bytes(bytes) }),
      rollback: Object.freeze({ state: "present", file_type: "regular", mode, bytes }),
    });
  } catch (error) {
    if ((error as { code?: unknown }).code === "ENOENT") {
      const absent = Object.freeze({ state: "absent" } as const);
      return Object.freeze({ observation: absent, rollback: absent });
    }
    throw error;
  }
}

/** Domain-separated identity of the complete present/absent projection generation. */
export function projectionGenerationDigest(observation: ProjectionObservation): Sha256Digest {
  return canonicalJsonDigest({ schema_version: "1", digest_kind: "projection-generation", observation });
}

async function observe(path: SnapshotStoragePath): Promise<ProjectionObservation> {
  return (await captureProjectionTarget(path)).observation;
}

function desiredObservation(value: ProjectionDesired): ProjectionObservation {
  return value.state === "absent" ? value : Object.freeze({
    state: "present", file_type: value.file_type, mode: value.mode,
    size_bytes: value.bytes.byteLength, content_digest: sha256Bytes(value.bytes),
  });
}

export async function prepareProjectionPlan(
  sources: readonly ProjectionSource[],
  scanner: SecretScanner,
  worktreeRoot: ResolvedTaskPath,
): Promise<ProjectResult<ProjectionPlan>> {
  if (!Array.isArray(sources)) throw new TypeError("projection sources must be an array");
  const materialized = sources.map((source, index): ProjectionSource => {
    if (source === null || typeof source !== "object") throw new TypeError(`projection source ${index} must be an object`);
    const path = ownEnumerableData(source, "path");
    const targetValue = ownEnumerableData(source, "target");
    const desiredValue = ownEnumerableData(source, "desired");
    const beforeValue = ownEnumerableData(source, "authenticated_before");
    const tracked = ownEnumerableData(source, "git_tracked");
    assertPlainJson(beforeValue, `projection source ${index} before-image`);
    if (typeof path !== "string" || targetValue === null || typeof targetValue !== "object" || typeof tracked !== "boolean" || desiredValue === null || typeof desiredValue !== "object") {
      throw new TypeError(`projection source ${index} has invalid fields`);
    }
    assertPlainJson(targetValue, `projection source ${index} target`);
    const suppliedTarget = structuredClone(targetValue) as unknown as SnapshotStoragePath;
    if (suppliedTarget.repositoryRelative !== path) throw new TypeError(`projection source ${index} target path disagrees`);
    // ResolvedPath.absolute is containment-normalized and therefore names a symlink's referent.
    // Mutation and leaf observation use the already-validated lexical worktree location instead.
    const target = Object.freeze({ ...suppliedTarget,
      absolute: resolvePath(worktreeRoot, suppliedTarget.repositoryRelative) as ResolvedTaskPath });
    const desiredState = ownEnumerableData(desiredValue, "state");
    let desired: ProjectionDesired;
    if (desiredState === "absent") desired = Object.freeze({ state: "absent" });
    else {
      const fileType = ownEnumerableData(desiredValue, "file_type");
      const mode = ownEnumerableData(desiredValue, "mode");
      const bytes = cloneBytes(ownEnumerableData(desiredValue, "bytes"), `projection source ${index} desired bytes`);
      if (fileType === "regular" && (mode === "100644" || mode === "100755")) desired = Object.freeze({ state: "present", file_type: fileType, mode, bytes });
      else if (fileType === "symlink" && mode === "120000") desired = Object.freeze({ state: "present", file_type: fileType, mode, bytes });
      else throw new TypeError(`projection source ${index} has invalid desired identity`);
    }
    const rollbackDescriptor = Object.getOwnPropertyDescriptor(source, "rollback");
    let rollback: ProjectionDesired | undefined;
    if (rollbackDescriptor !== undefined) {
      if (!("value" in rollbackDescriptor) || !rollbackDescriptor.enumerable) throw new TypeError("rollback must be an own enumerable data property");
      const value = rollbackDescriptor.value;
      if (value === null || typeof value !== "object") throw new TypeError("rollback must be a projection image");
      const state = ownEnumerableData(value, "state");
      if (state === "absent") rollback = Object.freeze({ state: "absent" });
      else {
        const fileType = ownEnumerableData(value, "file_type");
        const mode = ownEnumerableData(value, "mode");
        const bytes = cloneBytes(ownEnumerableData(value, "bytes"), `projection source ${index} rollback bytes`);
        if (fileType === "regular" && (mode === "100644" || mode === "100755")) rollback = Object.freeze({ state: "present", file_type: fileType, mode, bytes });
        else if (fileType === "symlink" && mode === "120000") rollback = Object.freeze({ state: "present", file_type: fileType, mode, bytes });
        else throw new TypeError(`projection source ${index} has invalid rollback identity`);
      }
    }
    const renameDescriptor = Object.getOwnPropertyDescriptor(source, "rename_pair");
    let renamePair: ProjectionSource["rename_pair"];
    if (renameDescriptor !== undefined) {
      if (!("value" in renameDescriptor) || !renameDescriptor.enumerable) throw new TypeError("rename_pair must be an own enumerable data property");
      const value = renameDescriptor.value;
      if (value === null || typeof value !== "object") throw new TypeError("rename_pair must be an object");
      const role = ownEnumerableData(value, "role");
      const peerPath = ownEnumerableData(value, "peer_path");
      if ((role !== "source" && role !== "destination") || typeof peerPath !== "string") throw new TypeError("rename_pair is invalid");
      renamePair = Object.freeze({ role, peer_path: peerPath as RepositoryPathClaim });
    }
    return Object.freeze({
      path: path as RepositoryPathClaim, target: target as SnapshotStoragePath, desired,
      authenticated_before: structuredClone(beforeValue) as ProjectionObservation, git_tracked: tracked,
      ...(rollback === undefined ? {} : { rollback }),
      ...(renamePair === undefined ? {} : { rename_pair: renamePair }),
    });
  });
  const paths = materialized.map((source) => source.path);
  if (new Set(paths).size !== paths.length) throw new TypeError("projection sources must have unique paths");
  const byPath = new Map(materialized.map((source) => [source.path, source]));
  for (const source of materialized) {
    if (source.rename_pair === undefined) continue;
    const peer = byPath.get(source.rename_pair.peer_path);
    if (
      peer?.rename_pair?.peer_path !== source.path || peer.rename_pair.role === source.rename_pair.role ||
      (source.rename_pair.role === "source" && source.desired.state !== "absent") ||
      (source.rename_pair.role === "destination" && (source.desired.state !== "present" || source.authenticated_before.state !== "absent"))
    ) throw new TypeError("rename projection pair is inconsistent");
  }
  const scan = await scanner.scan(materialized.flatMap((source) =>
    source.git_tracked && source.desired.state === "present"
      ? [secretScanCandidateFromBytes({ virtual_path: source.path, path_class: source.target.path_class as PathClass, bytes: source.desired.bytes })]
      : []));
  if (scan.outcome === "detected") {
    const finding = scan.findings[0];
    if (finding === undefined) throw new TypeError("detected scan must contain a finding");
    return fail(createProjectError("SECRET_DETECTED", { path_class: finding.path_class, detector_id: finding.detector_id }));
  }
  if (scan.outcome === "unavailable") {
    const first = materialized.find((source) => source.git_tracked);
    return fail(createProjectError("SECRET_DETECTED", { path_class: (first?.target.path_class as PathClass | undefined) ?? "repository-source", detector_id: "scanner-unavailable" }));
  }
  const entries: ProjectionPlanEntry[] = [];
  for (const source of materialized) {
    const observed = await observe(source.target);
    if (source.authenticated_before.state === "present") {
      if (source.rollback === undefined || !isDeepStrictEqual(desiredObservation(source.rollback), source.authenticated_before)) {
        throw new TypeError("present authenticated before-image requires matching rollback bytes");
      }
    } else if (source.rollback !== undefined && source.rollback.state !== "absent") {
      throw new TypeError("absent authenticated before-image cannot carry present rollback bytes");
    }
    const exact = isDeepStrictEqual(observed, desiredObservation(source.desired));
    const before = isDeepStrictEqual(observed, source.authenticated_before);
    const renameDestinationBlocked = source.rename_pair?.role === "destination" && observed.state !== "absent" && !exact;
    entries.push(Object.freeze({
      path: source.path, target: source.target, observed_before: observed, desired: source.desired,
      ...(source.rollback === undefined ? {} : { rollback: source.rollback }),
      git_tracked: source.git_tracked,
      ...(source.rename_pair === undefined ? {} : { rename_pair: source.rename_pair }),
      disposition: exact ? "exact" : before && !renameDestinationBlocked ? "restore-ready" : "collision",
    }));
  }
  const collisions = entries.filter((entry) => entry.disposition === "collision")
    .map((entry) => Object.freeze({ path: entry.path, path_class: entry.target.path_class }));
  return ok(Object.freeze({
    entries: Object.freeze(entries), collisions: Object.freeze(collisions),
    collision_choices: Object.freeze(["discard-and-restore", "adopt-as-new-generation", "abort"] as const),
  }));
}

async function applyDesired(writer: ProjectionWriter, entry: ProjectionPlanEntry): Promise<void> {
  if (entry.desired.state === "absent") return writer.remove(entry.target);
  if (entry.desired.file_type === "symlink") return writer.replaceSymlink(entry.target, new TextDecoder().decode(entry.desired.bytes));
  await writer.replaceRegular(entry.target, entry.desired.bytes, entry.desired.mode === "100755");
  await chmod(entry.target.absolute, entry.desired.mode === "100755" ? 0o755 : 0o644);
}

export type ProjectionApplyResult =
  | Readonly<{ outcome: "applied" }>
  | Readonly<{ outcome: "collision"; path: RepositoryPathClaim; writes: 0 }>
  | Readonly<{ outcome: "rolled-back"; path: RepositoryPathClaim }>
  | Readonly<{ outcome: "repair-required"; path: RepositoryPathClaim }>;

/** Revalidates the full set, then each target; rollback itself authenticates each after-image. */
export async function applyProjectionPlan(writer: ProjectionWriter, plan: ProjectionPlan): Promise<ProjectionApplyResult> {
  if (plan.collisions.length !== 0) return Object.freeze({ outcome: "collision", path: plan.collisions[0]!.path, writes: 0 });
  for (const entry of plan.entries) {
    if (!isDeepStrictEqual(await observe(entry.target), entry.observed_before)) {
      return Object.freeze({ outcome: "collision", path: entry.path, writes: 0 });
    }
  }
  const applied: ProjectionPlanEntry[] = [];
  for (const entry of plan.entries) {
    if (entry.disposition === "exact") continue;
    if (!isDeepStrictEqual(await observe(entry.target), entry.observed_before)) {
      return rollback(writer, applied, entry.path);
    }
    if (entry.rename_pair?.role === "destination" && (await observe(entry.target)).state !== "absent") {
      return rollback(writer, applied, entry.path);
    }
    await applyDesired(writer, entry);
    applied.push(entry);
  }
  return Object.freeze({ outcome: "applied" });
}

async function rollback(writer: ProjectionWriter, applied: readonly ProjectionPlanEntry[], collisionPath: RepositoryPathClaim): Promise<ProjectionApplyResult> {
  for (const entry of [...applied].reverse()) {
    if (!isDeepStrictEqual(await observe(entry.target), desiredObservation(entry.desired))) {
      return Object.freeze({ outcome: "repair-required", path: entry.path });
    }
    if (entry.observed_before.state === "absent") await writer.remove(entry.target);
    else if (entry.rollback !== undefined) await applyDesired(writer, { ...entry, desired: entry.rollback });
    else return Object.freeze({ outcome: "repair-required", path: entry.path });
  }
  return Object.freeze({ outcome: "rolled-back", path: collisionPath });
}

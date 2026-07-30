import { lstat, readlink } from "node:fs/promises";
import { resolve as resolvePath } from "node:path";
import { isDeepStrictEqual } from "node:util";

import {
  canonicalJsonDigest,
  gitBlobOid,
  parseGitOid,
  sha256Bytes,
  type GitOid,
} from "../contracts/canonical.js";
import type {
  ImplementationOutputV1,
  UndeclaredChangeReport,
} from "../contracts/durable-implementation-output.js";
import type {
  BlobIdentity,
  ClaimableOutputPathClass,
  OutputEntry,
} from "../contracts/durable-primitives.js";
import { parseSafeInteger, type Sha256Digest } from "../contracts/evidence.js";
import { rawGitPath, type PathClass, type RepositoryPathClaim } from "../contracts/path-claims.js";
import { assertPlainJson } from "../contracts/plain-json.js";
import {
  hashGitBlobIdentity,
  isCommitAncestorOfHead,
  readCommitTreeBlob,
  readGitBlobBytes,
  readGitBlobProjectedBytes,
  readGitBlobSize,
  readChangedGitPaths,
  type RepositoryOperationContext,
} from "../repository/git.js";
import type { RootBoundGitRunner } from "../repository/identity.js";
import { readIndexEntries } from "../repository/index-entries.js";
import {
  resolveDeclaredOutputPath,
  resolveDeclaredRename,
  openResolved,
  type ResolvedPath,
} from "../repository/paths.js";

export type SnapshotObservation =
  | Readonly<{ path: RepositoryPathClaim; path_class: PathClass; state: "absent" }>
  | Readonly<{
      path: RepositoryPathClaim;
      path_class: PathClass;
      state: "present";
      file_type: "regular" | "symlink";
      mode: "100644" | "100755" | "120000";
      size_bytes: number;
      oid: GitOid;
      content_digest: Sha256Digest;
    }>;

export type IndexObservation =
  | Readonly<{ path: RepositoryPathClaim; state: "absent" }>
  | Readonly<{
      path: RepositoryPathClaim;
      state: "present";
      stage: 0;
      mode: string;
      oid: GitOid;
    }>;

export type ImplementationManifestFacts = Readonly<{
  snapshot_digest: Sha256Digest;
  diff_digest: Sha256Digest;
  index_identity_digest: Sha256Digest;
  worktree_identity_digest: Sha256Digest;
  snapshot_entries: readonly SnapshotObservation[];
  index_entries: readonly IndexObservation[];
  worktree_entries: readonly SnapshotObservation[];
  raw_payloads: ReadonlyMap<RepositoryPathClaim, Uint8Array>;
}>;

export type CurrentAuthoritativeOutputSource =
  | Readonly<{ path: RepositoryPathClaim; state: "absent" }>
  | Readonly<{ path: RepositoryPathClaim; state: "present"; identity: BlobIdentity; bytes?: Uint8Array }>;

const ordinal = (left: string, right: string): number => left < right ? -1 : left > right ? 1 : 0;

function ownEnumerableData(value: object, key: string): unknown {
  const descriptor = Object.getOwnPropertyDescriptor(value, key);
  if (descriptor === undefined || !("value" in descriptor) || !descriptor.enumerable) {
    throw new TypeError(`${key} must be an own enumerable data property`);
  }
  return descriptor.value;
}

function sortedUniquePaths(output: ImplementationOutputV1): readonly RepositoryPathClaim[] {
  const paths = new Set<RepositoryPathClaim>();
  for (const entry of output.outputs) {
    if (paths.has(entry.path)) throw new TypeError("duplicate declared output path");
    paths.add(entry.path);
    if (entry.operation === "rename") {
      if (entry.previous_path === entry.path || paths.has(entry.previous_path)) {
        throw new TypeError("duplicate or conflicting declared rename path");
      }
      paths.add(entry.previous_path);
    }
  }
  return Object.freeze([...paths].sort(ordinal));
}

export function deriveSnapshotDigest(entries: readonly SnapshotObservation[]): Sha256Digest {
  return canonicalJsonDigest({
    schema_version: "1",
    digest_kind: "declared-output-snapshot",
    entries: [...entries].sort((left, right) => ordinal(left.path, right.path)),
  });
}

export function deriveImplementationDiffDigest(
  baseCommit: GitOid,
  outputs: readonly OutputEntry[]
): Sha256Digest {
  const entries = outputs.map((entry) => {
    const common = {
      path: entry.path,
      path_class: entry.path_class,
      operation: entry.operation,
      file_type: entry.file_type,
    };
    if (entry.operation === "add") return { ...common, after: entry.after };
    if (entry.operation === "delete") return { ...common, before: entry.before };
    if (entry.operation === "rename") {
      return { ...common, previous_path: entry.previous_path, before: entry.before, after: entry.after };
    }
    return { ...common, before: entry.before, after: entry.after };
  });
  return canonicalJsonDigest({
    schema_version: "1",
    digest_kind: "implementation-diff",
    base_commit: baseCommit,
    entries: entries.sort((left, right) => ordinal(left.path, right.path)),
  });
}

export function deriveIndexIdentityDigest(
  entries: readonly IndexObservation[],
  undeclaredChanges: UndeclaredChangeReport
): Sha256Digest {
  return canonicalJsonDigest({
    schema_version: "1",
    digest_kind: "declared-index-identity",
    entries: [...entries].sort((left, right) => ordinal(left.path, right.path)),
    undeclared_changes: undeclaredChanges,
  });
}

export function deriveWorktreeIdentityDigest(
  entries: readonly SnapshotObservation[],
  undeclaredChanges: UndeclaredChangeReport
): Sha256Digest {
  return canonicalJsonDigest({
    schema_version: "1",
    digest_kind: "declared-worktree-identity",
    entries: [...entries].sort((left, right) => ordinal(left.path, right.path)),
    undeclared_changes: undeclaredChanges,
  });
}

function sameIdentity(observed: SnapshotObservation, expected: BlobIdentity): boolean {
  return observed.state === "present" &&
    observed.oid === expected.oid &&
    observed.mode === expected.mode &&
    observed.size_bytes === expected.size_bytes;
}

async function observePath(
  runner: RootBoundGitRunner,
  resolved: ResolvedPath
): Promise<{ readonly observation: SnapshotObservation; readonly bytes?: Uint8Array }> {
  // `ResolvedPath.absolute` is realpath-normalized for containment. Observe the validated lexical
  // leaf so a declared symlink is authenticated as a symlink rather than as its target file.
  const lexicalPath = resolvePath(runner.location.worktreeRoot, resolved.repositoryRelative);
  let stat;
  try {
    stat = await lstat(lexicalPath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return { observation: Object.freeze({ path: resolved.repositoryRelative, path_class: resolved.path_class, state: "absent" }) };
    }
    throw error;
  }
  let bytes: Uint8Array;
  let fileType: "regular" | "symlink";
  let mode: "100644" | "100755" | "120000";
  let oid: GitOid;
  if (stat.isSymbolicLink()) {
    bytes = new Uint8Array(await readlink(lexicalPath, { encoding: "buffer" }));
    fileType = "symlink";
    mode = "120000";
    oid = gitBlobOid(bytes);
  } else if (stat.isFile()) {
    const handle = await openResolved(lexicalPath as typeof resolved.absolute, 0);
    try {
      bytes = new Uint8Array(await handle.readFile());
    } finally {
      await handle.close();
    }
    fileType = "regular";
    mode = (stat.mode & 0o111) === 0 ? "100644" : "100755";
    const identity = await hashGitBlobIdentity(runner, bytes, resolved.repositoryRelative);
    oid = parseGitOid(identity.oid);
    return {
      observation: Object.freeze({
        path: resolved.repositoryRelative,
        path_class: resolved.path_class,
        state: "present",
        file_type: fileType,
        mode,
        size_bytes: parseSafeInteger(identity.size_bytes),
        oid,
        content_digest: sha256Bytes(bytes),
      }),
      bytes,
    };
  } else {
    throw new TypeError("declared output is not a regular file or symlink");
  }
  return {
    observation: Object.freeze({
      path: resolved.repositoryRelative,
      path_class: resolved.path_class,
      state: "present",
      file_type: fileType,
      mode,
      size_bytes: parseSafeInteger(bytes.byteLength),
      oid,
      content_digest: sha256Bytes(bytes),
    }),
    bytes,
  };
}

async function resolveAll(
  runner: RootBoundGitRunner,
  output: ImplementationOutputV1,
  context: RepositoryOperationContext
): Promise<ReadonlyMap<RepositoryPathClaim, ResolvedPath>> {
  const resolved = new Map<RepositoryPathClaim, ResolvedPath>();
  for (const entry of output.outputs) {
    if (entry.operation === "rename") {
      const result = await resolveDeclaredRename({ runner, taskId: output.task_id, previousPath: entry.previous_path, path: entry.path, pathClass: entry.path_class, context });
      if (!result.ok) throw result.error;
      resolved.set(entry.previous_path, result.value.previous);
      resolved.set(entry.path, result.value.next);
    } else {
      const result = await resolveDeclaredOutputPath({ runner, taskId: output.task_id, claim: entry.path, pathClass: entry.path_class, context });
      if (!result.ok) throw result.error;
      resolved.set(entry.path, result.value);
    }
  }
  return resolved;
}

async function baseIdentity(
  runner: RootBoundGitRunner,
  commit: GitOid,
  path: RepositoryPathClaim
): Promise<BlobIdentity | undefined> {
  const entry = await readCommitTreeBlob(runner, commit, path);
  if (entry === undefined) return undefined;
  return Object.freeze({ oid: parseGitOid(entry.oid), mode: entry.mode, size_bytes: parseSafeInteger(await readGitBlobSize(runner, entry.oid)) }) as BlobIdentity;
}

/**
 * Authenticates an implementation output against its base tree, index, and current declared paths.
 * The caller-owned durable value is validated and cloned once before any repeated observation.
 */
export async function verifyImplementationManifest(
  runner: RootBoundGitRunner,
  supplied: ImplementationOutputV1,
  context: RepositoryOperationContext,
  suppliedCurrentSources: readonly CurrentAuthoritativeOutputSource[] = [],
): Promise<ImplementationManifestFacts> {
  assertPlainJson(supplied, "implementation output");
  const output = structuredClone(supplied);
  const currentSources = new Map<RepositoryPathClaim, CurrentAuthoritativeOutputSource>();
  for (const suppliedSource of suppliedCurrentSources) {
    if (suppliedSource === null || typeof suppliedSource !== "object") {
      throw new TypeError("current authoritative output source must be an object");
    }
    const state = ownEnumerableData(suppliedSource, "state");
    const path = ownEnumerableData(suppliedSource, "path") as RepositoryPathClaim;
    let source: CurrentAuthoritativeOutputSource;
    if (state === "absent") {
      source = Object.freeze({ path, state });
    } else if (state === "present") {
      const suppliedIdentity = ownEnumerableData(suppliedSource, "identity");
      assertPlainJson(suppliedIdentity, "current authoritative output identity");
      const bytesDescriptor = Object.getOwnPropertyDescriptor(suppliedSource, "bytes");
      if (bytesDescriptor !== undefined && (!("value" in bytesDescriptor) || !bytesDescriptor.enumerable)) {
        throw new TypeError("bytes must be an own enumerable data property");
      }
      const suppliedBytes = bytesDescriptor?.value;
      if (suppliedBytes !== undefined && !(suppliedBytes instanceof Uint8Array)) {
        throw new TypeError("current authoritative output bytes must be bytes");
      }
      source = Object.freeze({ path, state, identity: structuredClone(suppliedIdentity) as BlobIdentity,
        ...(suppliedBytes === undefined ? {} : { bytes: new Uint8Array(suppliedBytes) }) });
    } else {
      throw new TypeError("current authoritative output source state is invalid");
    }
    if (currentSources.has(source.path)) throw new TypeError("duplicate current authoritative output source");
    if (source.state === "present" && source.bytes !== undefined) {
      const identity = source.identity.mode === "120000"
        ? { oid: gitBlobOid(source.bytes), size_bytes: source.bytes.byteLength }
        : await hashGitBlobIdentity(runner, source.bytes, source.path);
      if (identity.oid !== source.identity.oid || identity.size_bytes !== source.identity.size_bytes) {
        throw new TypeError("current authoritative output bytes disagree with their identity");
      }
    }
    currentSources.set(source.path, source);
  }
  const scope = sortedUniquePaths(output);
  const changed = await readChangedGitPaths(runner);
  const scopeSet = new Set<string>(scope);
  const undeclaredChanges: UndeclaredChangeReport = {
    scanned: true,
    undeclared_paths: changed.paths.filter((path) => !scopeSet.has(path)).map(rawGitPath),
    unrepresentable_count: parseSafeInteger(changed.unrepresentable_count),
  };
  if (!isDeepStrictEqual(undeclaredChanges, output.undeclared_changes)) {
    throw new TypeError("undeclared change report does not match the live Git working set");
  }
  const resolved = await resolveAll(runner, output, context);
  const observed = new Map<RepositoryPathClaim, Awaited<ReturnType<typeof observePath>>>();
  for (const path of scope) {
    const target = resolved.get(path);
    if (target === undefined) throw new TypeError("declared scope path was not resolved");
    observed.set(path, await observePath(runner, target));
  }

  const ancestryRetained = await isCommitAncestorOfHead(runner, output.base_commit);
  const rawPayloads = new Map<RepositoryPathClaim, Uint8Array>();
  const snapshot = new Map<RepositoryPathClaim, SnapshotObservation>();

  for (const entry of output.outputs) {
    const after = observed.get(entry.path);
    if (after === undefined) throw new TypeError("missing output observation");
    const beforePath = entry.operation === "rename" ? entry.previous_path : entry.path;
    const currentBefore = currentSources.get(beforePath);
    const baseBefore = await baseIdentity(runner, output.base_commit, beforePath);
    const before = currentBefore === undefined
      ? baseBefore
      : currentBefore.state === "present" ? currentBefore.identity : undefined;
    const currentDestination = currentSources.get(entry.path);
    const destinationBefore = entry.operation === "rename"
      ? currentDestination === undefined
        ? await baseIdentity(runner, output.base_commit, entry.path)
        : currentDestination.state === "present" ? currentDestination.identity : undefined
      : before;

    if (entry.operation === "add") {
      if (before !== undefined || after.observation.state !== "present") throw new TypeError("add does not match base/worktree state");
    } else if (entry.operation === "modify") {
      if (before === undefined || !sameIdentity({ ...after.observation, path: beforePath }, entry.after) ||
          before.oid !== entry.before.oid || before.mode !== entry.before.mode || before.size_bytes !== entry.before.size_bytes) {
        throw new TypeError("modify identity does not match base/worktree state");
      }
    } else if (entry.operation === "delete") {
      if (before === undefined || after.observation.state !== "absent" ||
          before.oid !== entry.before.oid || before.mode !== entry.before.mode || before.size_bytes !== entry.before.size_bytes) {
        throw new TypeError("delete identity does not match base/worktree state");
      }
    } else {
      const previous = observed.get(entry.previous_path)?.observation;
      if (before === undefined || destinationBefore !== undefined || previous?.state !== "absent" ||
          !sameIdentity(after.observation, entry.after) || before.oid !== entry.before.oid ||
          before.mode !== entry.before.mode || before.size_bytes !== entry.before.size_bytes) {
        throw new TypeError("rename identity or non-overwrite condition does not match base/worktree state");
      }
      snapshot.set(entry.previous_path, previous);
    }
    if (entry.operation !== "delete" && !sameIdentity(after.observation, entry.after)) {
      throw new TypeError(`after identity does not match projected bytes for ${entry.path}`);
    }
    if (entry.storage === "raw-payload") {
      if (after.bytes === undefined || entry.payload_bytes !== after.bytes.byteLength || entry.payload_digest !== sha256Bytes(after.bytes)) {
        throw new TypeError("raw payload facts do not match projected bytes");
      }
      rawPayloads.set(entry.path, new Uint8Array(after.bytes));
    } else if (entry.operation !== "delete") {
      const proofPath = entry.operation === "rename" ? entry.previous_path : entry.path;
      const proof = await baseIdentity(runner, output.base_commit, proofPath);
      if (!ancestryRetained || proof === undefined || !sameIdentity(after.observation, proof)) {
        throw new TypeError("git-object storage lacks a reachable base-tree proof");
      }
      const projected = entry.file_type === "regular"
        ? await readGitBlobProjectedBytes(runner, proof.oid, entry.path)
        : await readGitBlobBytes(runner, proof.oid);
      if (after.bytes === undefined || sha256Bytes(projected) !== sha256Bytes(after.bytes)) {
        throw new TypeError("git-object storage cannot reproduce the projected worktree bytes");
      }
    }
    snapshot.set(entry.path, after.observation);
  }

  const worktreeEntries = Object.freeze(scope.map((path) => observed.get(path)?.observation as SnapshotObservation));
  const snapshotEntries = Object.freeze(scope.map((path) => snapshot.get(path) ?? observed.get(path)?.observation as SnapshotObservation));
  const indexResult = await readIndexEntries(runner, scope, context);
  if (!indexResult.ok) throw indexResult.error;
  const byIndexPath = new Map(indexResult.value.map((entry) => [entry.path, entry]));
  const indexEntries: IndexObservation[] = scope.map((path) => {
    const entry = byIndexPath.get(path);
    if (entry === undefined) return Object.freeze({ path, state: "absent" });
    if (entry.stage !== 0) throw new TypeError("declared index path is unmerged");
    return Object.freeze({ path, state: "present", stage: 0, mode: entry.mode, oid: entry.oid });
  });

  const facts: ImplementationManifestFacts = Object.freeze({
    snapshot_digest: deriveSnapshotDigest(snapshotEntries),
    diff_digest: deriveImplementationDiffDigest(output.base_commit, output.outputs),
    index_identity_digest: deriveIndexIdentityDigest(indexEntries, undeclaredChanges),
    worktree_identity_digest: deriveWorktreeIdentityDigest(worktreeEntries, undeclaredChanges),
    snapshot_entries: snapshotEntries,
    index_entries: Object.freeze(indexEntries),
    worktree_entries: worktreeEntries,
    raw_payloads: rawPayloads,
  });
  if (facts.snapshot_digest !== output.snapshot_digest || facts.diff_digest !== output.diff_digest ||
      facts.index_identity_digest !== output.index_identity_digest || facts.worktree_identity_digest !== output.worktree_identity_digest) {
    throw new TypeError("implementation identity digest does not match authenticated observations");
  }
  return facts;
}

import { lstat, readFile, readlink } from "node:fs/promises";
import { resolve as resolvePath } from "node:path";
import { isDeepStrictEqual } from "node:util";

import {
  canonicalJsonDigest,
  gitBlobOid,
  parseGitOid,
  sha256Bytes,
  type CanonicalDocument,
  type GitOid,
} from "../contracts/canonical.js";
import type {
  ImplementationOutputV1,
  ParentDocumentRef,
  UndeclaredChangeReport,
} from "../contracts/durable-implementation-output.js";
import type {
  BlobIdentity,
  ClaimableOutputPathClass,
  OutputEntry,
  SnapshotAccountingEntry,
} from "../contracts/durable-primitives.js";
import type { TaskStateV1 } from "../contracts/durable-state.js";
import type { ProjectResult } from "../contracts/errors.js";
import type { DeclaredInputRef } from "../contracts/fingerprints.js";
import { parseSafeInteger, type PathSafeId, type SafeCode, type SafeId, type Sha256Digest } from "../contracts/evidence.js";
import type { PhaseInstanceId } from "../contracts/phase-instance.js";
import { parseRepositoryPathClaim, parseTaskPathClaim, rawGitPath, type PathClass, type RepositoryPathClaim, type TaskPathClaim } from "../contracts/path-claims.js";
import { assertPlainJson } from "../contracts/plain-json.js";
import type { PipelineStep } from "../contracts/vocabulary.js";
import {
  hashGitBlobIdentity,
  isCommitAncestor,
  isCommitAncestorOfHead,
  readCommitTreeBlob,
  readGitBlobBytes,
  readGitBlobProjectedBytes,
  readGitBlobSize,
  readChangedGitPaths,
  resolveCommit,
  type RepositoryOperationContext,
} from "../repository/git.js";
import type { RootBoundGitRunner } from "../repository/identity.js";
import { readIndexEntries } from "../repository/index-entries.js";
import {
  classifyRepositoryPath,
  classifyTaskPath,
  resolveDeclaredOutputPath,
  resolveDeclaredRename,
  resolveRepositoryPath,
  resolveTaskPath,
  openResolved,
  type ResolvedPath,
} from "../repository/paths.js";
import { assertInternalTransactionAuthority, type TransactionAuthority } from "./authority.js";
import type { GateLifecycleDependencies } from "./gates.js";
import { createSecretlintScanner, secretScanCandidateFromBytes } from "./secret-scan.js";

export type ImplementationOutputInput = Readonly<{
  phase_instance: PhaseInstanceId;
  step: PipelineStep;
  base_commit: GitOid;
  outputs: readonly RepositoryPathClaim[];
  restore_targets: readonly RepositoryPathClaim[];
  parent_documents: readonly Readonly<{
    document_path: TaskPathClaim;
    role: "prd" | "design" | "phase-design" | "impl-notes";
  }>[];
  declared_inputs: readonly Readonly<{ input_id: SafeId; path: RepositoryPathClaim }>[];
  input_fingerprint: Sha256Digest;
  constitution_edit_gate_id?: PathSafeId;
}>;

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

/**
 * Proves that the authenticated commit gate's target is still current and that the immutable
 * current HEAD tree contains every after-image (and every required absence) retained by the
 * implementation output. Worktree and index state are deliberately irrelevant after commit.
 */
export async function implementationOutputCommittedAtCurrentTarget(
  runner: RootBoundGitRunner,
  output: ImplementationOutputV1,
  targetRef: string,
): Promise<boolean> {
  const symbolicRef = await runner.runText({
    argv: ["symbolic-ref", "--quiet", "HEAD"],
    operation: "git-current-commit-target" as SafeCode,
    expectedAbsence: [{ code: 1, stderrIncludes: "" }],
  });
  if (targetRef === "HEAD" ? symbolicRef !== "" : symbolicRef !== targetRef) return false;
  const headCommit = await resolveCommit(runner, "HEAD");
  const targetCommit = await resolveCommit(runner, targetRef);
  if (headCommit !== targetCommit) return false;
  if (!await isCommitAncestor(runner, output.base_commit, headCommit)) return false;

  for (const entry of output.outputs) {
    const committed = await readCommitTreeBlob(runner, headCommit, entry.path);
    if (entry.operation === "delete") {
      if (committed !== undefined) return false;
      continue;
    }
    if (committed?.mode !== entry.after.mode || committed.oid !== entry.after.oid) return false;
    if (entry.operation === "rename" &&
        await readCommitTreeBlob(runner, headCommit, entry.previous_path) !== undefined) return false;
  }
  return true;
}

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

const claimableOutputClasses: ReadonlySet<PathClass> = new Set([
  "document", "import", "manual-checkpoint", "repository-source", "result-payload", "review",
  "task-branch-constitution",
]);

function classifyOutputPath(
  authority: TransactionAuthority,
  path: RepositoryPathClaim,
): ProjectResult<ClaimableOutputPathClass> {
  const prefix = `.archflow/tasks/${authority.task_id}/`;
  if (path.startsWith(prefix)) {
    const classified = classifyTaskPath(authority.task_id, parseTaskPathClaim(path.slice(prefix.length)));
    if (!classified.ok) return classified;
    if (!claimableOutputClasses.has(classified.value)) throw new TypeError("declared output path is server-owned");
    return Object.freeze({ schema_version: "1", ok: true, value: classified.value as ClaimableOutputPathClass });
  }
  const classified = classifyRepositoryPath(path);
  if (!classified.ok) return classified;
  const pathClass = classified.value === "shared-constitution"
    ? "task-branch-constitution"
    : classified.value;
  if (!claimableOutputClasses.has(pathClass)) throw new TypeError("declared output path is read-only");
  return Object.freeze({ schema_version: "1", ok: true, value: pathClass as ClaimableOutputPathClass });
}

async function resolveReadablePath(
  dependencies: GateLifecycleDependencies,
  authority: TransactionAuthority,
  path: RepositoryPathClaim,
): Promise<ProjectResult<ResolvedPath>> {
  const prefix = `.archflow/tasks/${authority.task_id}/`;
  if (path.startsWith(prefix)) {
    return resolveTaskPath({
      runner: dependencies.runner,
      taskId: authority.task_id,
      claim: parseTaskPathClaim(path.slice(prefix.length)),
      context: authority.context,
    });
  }
  return resolveRepositoryPath({
    runner: dependencies.runner,
    claim: path,
    context: authority.context,
  });
}

async function readRegularBytes(path: ResolvedPath, label: string): Promise<Uint8Array> {
  const stat = await lstat(path.absolute);
  if (!stat.isFile()) throw new TypeError(`${label} is not a regular file`);
  return new Uint8Array(await readFile(path.absolute));
}

/** Maps a rename destination to its source in the live worktree relative to the selected base. */
async function readRenameSources(
  runner: RootBoundGitRunner,
  baseCommit: GitOid,
): Promise<Readonly<{
  renames: ReadonlyMap<string, RepositoryPathClaim>;
  deleted: readonly RepositoryPathClaim[];
}>> {
  const fields = await runner.runNulFields({
    argv: ["diff", "--name-status", "-z", "--find-renames", baseCommit, "--"],
    operation: "git-diff-implementation-output" as SafeCode,
  });
  const renames = new Map<string, RepositoryPathClaim>();
  const deleted: RepositoryPathClaim[] = [];
  for (let index = 0; index < fields.length;) {
    const status = fields[index++];
    if (status === undefined) throw new TypeError("git diff name-status output is malformed");
    if (/^R[0-9]+$/u.test(status)) {
      const previous = fields[index++];
      const next = fields[index++];
      if (previous === undefined || next === undefined) throw new TypeError("git diff rename output is malformed");
      renames.set(next, parseRepositoryPathClaim(previous));
    } else {
      const path = fields[index++];
      if (path === undefined) throw new TypeError("git diff name-status output is malformed");
      if (status === "D") deleted.push(parseRepositoryPathClaim(path));
    }
  }
  return Object.freeze({ renames, deleted: Object.freeze(deleted.sort(ordinal)) });
}

function identityOf(observation: Extract<SnapshotObservation, { state: "present" }>): BlobIdentity {
  return Object.freeze({
    oid: observation.oid,
    mode: observation.mode,
    size_bytes: parseSafeInteger(observation.size_bytes),
  }) as BlobIdentity;
}

/**
 * Builds the exact caller-supplied implementation artifact from live repository observations.
 * Every identity and digest checked by the server is derived here rather than accepted as input.
 */
export async function buildImplementationOutput(
  dependencies: GateLifecycleDependencies,
  authority: TransactionAuthority,
  state: CanonicalDocument<TaskStateV1>,
  suppliedInput: ImplementationOutputInput,
): Promise<ProjectResult<ImplementationOutputV1>> {
  assertInternalTransactionAuthority(authority, {
    runner: dependencies.runner,
    environment: dependencies.environment,
  });
  assertPlainJson(suppliedInput, "implementation output builder input");
  const input = structuredClone(suppliedInput);
  if (state.value.task_id !== authority.task_id) throw new TypeError("state task does not match transaction authority");
  if (dependencies.read_retained_task_bytes === undefined) {
    throw new TypeError("retained byte accounting is unavailable");
  }
  const outputPaths = [...input.outputs].sort(ordinal);
  if (outputPaths.length === 0 || new Set(outputPaths).size !== outputPaths.length) {
    throw new TypeError("implementation outputs must be non-empty and unique");
  }
  const renameChanges = await readRenameSources(dependencies.runner, input.base_commit);
  const outputs: OutputEntry[] = [];
  const observations = new Map<RepositoryPathClaim, Awaited<ReturnType<typeof observePath>>>();

  const resolveOutput = async (path: RepositoryPathClaim, pathClass: ClaimableOutputPathClass) => {
    const resolved = await resolveDeclaredOutputPath({
      runner: dependencies.runner,
      taskId: authority.task_id,
      claim: path,
      pathClass,
      context: authority.context,
    });
    if (!resolved.ok) return resolved;
    observations.set(path, await observePath(dependencies.runner, resolved.value));
    return resolved;
  };

  for (const path of outputPaths) {
    const classified = classifyOutputPath(authority, path);
    if (!classified.ok) return classified;
    const pathClass = classified.value;
    const resolved = await resolveOutput(path, pathClass);
    if (!resolved.ok) return resolved;
    const after = observations.get(path)!;
    const before = await baseIdentity(dependencies.runner, input.base_commit, path);
    let previousPath = before === undefined && after.observation.state === "present"
      ? renameChanges.renames.get(path)
      : undefined;
    // An unstaged rename appears to Git as a tracked deletion plus an untracked destination, so
    // `git diff --find-renames` cannot pair it. A unique byte-identical deleted base blob supplies
    // the same fact without asking the caller to author the previous path.
    if (previousPath === undefined && before === undefined && after.observation.state === "present") {
      const afterIdentity = identityOf(after.observation);
      const candidates: RepositoryPathClaim[] = [];
      for (const deletedPath of renameChanges.deleted) {
        const deletedIdentity = await baseIdentity(dependencies.runner, input.base_commit, deletedPath);
        if (deletedIdentity !== undefined && isDeepStrictEqual(deletedIdentity, afterIdentity)) {
          candidates.push(deletedPath);
        }
      }
      if (candidates.length === 1) previousPath = candidates[0];
    }

    if (previousPath !== undefined) {
      const previousClass = classifyOutputPath(authority, previousPath);
      if (!previousClass.ok) return previousClass;
      if (previousClass.value !== pathClass) throw new TypeError("rename endpoints have different path classes");
      const previousResolved = await resolveOutput(previousPath, pathClass);
      if (!previousResolved.ok) return previousResolved;
      const previousIdentity = await baseIdentity(dependencies.runner, input.base_commit, previousPath);
      if (previousIdentity === undefined || after.observation.state !== "present") {
        throw new TypeError("rename does not match base/worktree state");
      }
      const afterIdentity = identityOf(after.observation);
      const retainedByGit = isDeepStrictEqual(previousIdentity, afterIdentity) &&
        await isCommitAncestorOfHead(dependencies.runner, input.base_commit);
      outputs.push(Object.freeze(retainedByGit ? {
        path, path_class: pathClass, operation: "rename", storage: "git-object",
        file_type: after.observation.file_type, before: previousIdentity, after: afterIdentity,
        previous_path: previousPath,
      } : {
        path, path_class: pathClass, operation: "rename", storage: "raw-payload",
        payload_bytes: parseSafeInteger(after.bytes!.byteLength), payload_digest: sha256Bytes(after.bytes!),
        file_type: after.observation.file_type, before: previousIdentity, after: afterIdentity,
        previous_path: previousPath,
      }) as OutputEntry);
    } else if (before === undefined && after.observation.state === "present") {
      outputs.push(Object.freeze({
        path, path_class: pathClass, operation: "add", storage: "raw-payload",
        payload_bytes: parseSafeInteger(after.bytes!.byteLength), payload_digest: sha256Bytes(after.bytes!),
        file_type: after.observation.file_type, after: identityOf(after.observation),
      }) as OutputEntry);
    } else if (before !== undefined && after.observation.state === "absent") {
      outputs.push(Object.freeze({
        path, path_class: pathClass, operation: "delete", storage: "git-object",
        file_type: before.mode === "120000" ? "symlink" : "regular", before,
      }) as OutputEntry);
    } else if (before !== undefined && after.observation.state === "present") {
      outputs.push(Object.freeze({
        path, path_class: pathClass, operation: "modify", storage: "raw-payload",
        payload_bytes: parseSafeInteger(after.bytes!.byteLength), payload_digest: sha256Bytes(after.bytes!),
        file_type: after.observation.file_type, before, after: identityOf(after.observation),
      }) as OutputEntry);
    } else {
      throw new TypeError("declared output is absent from both base and worktree");
    }
  }

  outputs.sort((left, right) => ordinal(left.path, right.path));
  const restoreTargets = [...input.restore_targets].sort(ordinal);
  if (new Set(restoreTargets).size !== restoreTargets.length ||
      restoreTargets.some((path) => !outputPaths.includes(path))) {
    throw new TypeError("restore targets must be unique declared output paths");
  }
  const scope = [...new Set(outputs.flatMap((output) => output.operation === "rename"
    ? [output.path, output.previous_path]
    : [output.path]))].sort(ordinal) as RepositoryPathClaim[];
  const changed = await readChangedGitPaths(dependencies.runner);
  const scopeSet = new Set<string>(scope);
  const undeclaredChanges: UndeclaredChangeReport = Object.freeze({
    scanned: true,
    undeclared_paths: Object.freeze(changed.paths.filter((path) => !scopeSet.has(path)).map(rawGitPath)),
    unrepresentable_count: parseSafeInteger(changed.unrepresentable_count),
  });
  const snapshotEntries = Object.freeze(scope.map((path) => observations.get(path)!.observation));
  const indexResult = await readIndexEntries(dependencies.runner, scope, authority.context);
  if (!indexResult.ok) return indexResult;
  const indexByPath = new Map(indexResult.value.map((entry) => [entry.path, entry]));
  const indexEntries: IndexObservation[] = scope.map((path) => {
    const entry = indexByPath.get(path);
    if (entry === undefined) return Object.freeze({ path, state: "absent" });
    if (entry.stage !== 0) throw new TypeError("declared index path is unmerged");
    return Object.freeze({ path, state: "present", stage: 0, mode: entry.mode, oid: entry.oid });
  });

  const parentDocuments: ParentDocumentRef[] = [];
  for (const parent of [...input.parent_documents].sort((left, right) => ordinal(left.document_path, right.document_path))) {
    const resolved = await resolveTaskPath({
      runner: dependencies.runner,
      taskId: authority.task_id,
      claim: parent.document_path,
      expectedClass: "document",
      context: authority.context,
    });
    if (!resolved.ok) return resolved;
    parentDocuments.push(Object.freeze({
      document_path: parent.document_path,
      content_digest: sha256Bytes(await readRegularBytes(resolved.value, "parent document")),
      role: parent.role,
    }));
  }
  if (new Set(parentDocuments.map((parent) => parent.document_path)).size !== parentDocuments.length) {
    throw new TypeError("parent documents must be unique");
  }

  const declaredInputs: DeclaredInputRef[] = [];
  for (const declared of [...input.declared_inputs].sort((left, right) => ordinal(left.input_id, right.input_id))) {
    const resolved = await resolveReadablePath(dependencies, authority, declared.path);
    if (!resolved.ok) return resolved;
    declaredInputs.push(Object.freeze({
      input_id: declared.input_id,
      digest: sha256Bytes(await readRegularBytes(resolved.value, "declared input")),
    }));
  }
  if (new Set(declaredInputs.map((declared) => declared.input_id)).size !== declaredInputs.length) {
    throw new TypeError("declared input ids must be unique");
  }

  const scanCandidates = outputs.flatMap((output) => {
    if (output.operation === "delete") return [];
    const observed = observations.get(output.path)!;
    if (observed.observation.state !== "present" || observed.bytes === undefined) {
      throw new TypeError("present output bytes are unavailable");
    }
    return [secretScanCandidateFromBytes({
      virtual_path: output.path,
      path_class: output.path_class,
      bytes: observed.bytes,
    })];
  });
  const secretScan = await createSecretlintScanner().scan(scanCandidates);
  const countedEntries: SnapshotAccountingEntry[] = outputs.map((output) => Object.freeze(output.storage === "raw-payload"
    ? { path: output.path, storage: "raw-payload", stored_bytes: output.payload_bytes }
    : { path: output.path, storage: "git-object", stored_bytes: 0 }));
  const resultBytes = parseSafeInteger(countedEntries.reduce((total, entry) => total + entry.stored_bytes, 0));
  const retainedBytes = await dependencies.read_retained_task_bytes();
  const artifact: ImplementationOutputV1 = Object.freeze({
    schema_version: "1",
    artifact_kind: "implementation-output",
    task_id: authority.task_id,
    phase_instance: input.phase_instance,
    step: input.step,
    base_commit: input.base_commit,
    index_identity_digest: deriveIndexIdentityDigest(indexEntries, undeclaredChanges),
    worktree_identity_digest: deriveWorktreeIdentityDigest(snapshotEntries, undeclaredChanges),
    outputs: Object.freeze(outputs),
    parent_documents: Object.freeze(parentDocuments),
    diff_digest: deriveImplementationDiffDigest(input.base_commit, outputs),
    snapshot_digest: deriveSnapshotDigest(snapshotEntries),
    restore_targets: Object.freeze(restoreTargets),
    accounting: Object.freeze({
      schema_version: "1",
      result_bytes: resultBytes,
      task_bytes: parseSafeInteger(retainedBytes + resultBytes),
      result_byte_cap: 26_214_400,
      task_byte_cap: 262_144_000,
      counted_entries: Object.freeze(countedEntries),
      measured_at_revision: state.value.revision,
    }),
    secret_scan: secretScan,
    undeclared_changes: undeclaredChanges,
    declared_inputs: Object.freeze(declaredInputs),
    input_fingerprint: input.input_fingerprint,
    ...(input.constitution_edit_gate_id === undefined ? {} : {
      constitution_edit_gate_id: input.constitution_edit_gate_id,
    }),
  });
  await verifyImplementationManifest(dependencies.runner, artifact, authority.context);
  return Object.freeze({ schema_version: "1", ok: true, value: artifact });
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

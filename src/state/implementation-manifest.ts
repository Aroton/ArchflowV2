import { lstat, readFile, readlink } from "node:fs/promises";
import { resolve as resolvePath } from "node:path";
import { isDeepStrictEqual } from "node:util";

import {
  canonicalJsonDigest,
  canonicalJsonBytes,
  gitBlobOid,
  parseGitOid,
  sha256Bytes,
  type CanonicalDocument,
  type GitOid,
} from "../contracts/canonical.js";
import type {
  ImplementationOutputV1,
  ImplementationRepositorySectionV1,
  ParentDocumentRef,
  SecondaryDeclaredInputRefV1,
  UndeclaredChangeReport,
} from "../contracts/durable-implementation-output.js";
import type { DocumentArtifactV1 } from "../contracts/durable-document.js";
import type { GateContext, LegacyExactCommitAuthorizationContextV1, SecondaryCommitAuthorizationV1 } from "../contracts/gates.js";
import type { RepositoryName } from "../contracts/config.js";
import type { RepositoryCommitMilestoneV1 } from "../contracts/durable-state.js";
import type {
  BlobIdentity,
  ClaimableOutputPathClass,
  OutputEntry,
  SnapshotAccountingEntry,
} from "../contracts/durable-primitives.js";
import { taskStateV1Schema, type TaskStateV1 } from "../contracts/durable-state.js";
import { createProjectError, type ProjectResult } from "../contracts/errors.js";
import type { DeclaredInputRef } from "../contracts/fingerprints.js";
import { parseSafeInteger, type PathSafeId, type SafeCode, type SafeId, type SafeInteger, type Sha256Digest } from "../contracts/evidence.js";
import { decodePhaseInstance, type PhaseInstanceId } from "../contracts/phase-instance.js";
import { parseRepositoryPathClaim, parseTaskPathClaim, rawGitPath, type PathClass, type RepositoryPathClaim, type TaskPathClaim } from "../contracts/path-claims.js";
import { assertPlainJson } from "../contracts/plain-json.js";
import type { PipelineStep } from "../contracts/vocabulary.js";
import {
  hashGitBlobIdentity,
  isCommitAncestor,
  isCommitAncestorOfHead,
  readFirstParentChildAfter,
  readCommitTreeBlob,
  readGitBlobBytes,
  readGitBlobProjectedBytes,
  readGitBlobSize,
  readChangedGitPaths,
  resolveCommit,
  GitInvocationError,
  type RepositoryOperationContext,
} from "../repository/git.js";
import type { RootBoundGitRunner } from "../repository/identity.js";
import type { RepositoryMember, RepositorySet } from "../repository/repository-set.js";
import { readIndexEntries } from "../repository/index-entries.js";
import {
  classifyRepositoryPath,
  classifyTaskPath,
  isTaskDocumentPath,
  resolveDeclaredOutputPath,
  resolveDeclaredRename,
  resolveRepositoryPath,
  resolveTaskPath,
  resolveTaskWorkspacePath,
  verificationTranscriptClaim,
  openResolved,
  type ResolvedPath,
  type ResolvedWorkspacePath,
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
  repositories?: readonly Readonly<{
    name: RepositoryName;
    base_commit: GitOid;
    outputs: readonly RepositoryPathClaim[];
    restore_targets: readonly RepositoryPathClaim[];
    declared_inputs: readonly Readonly<{ input_id: SafeId; path: RepositoryPathClaim }>[];
  }>[];
  input_fingerprint: Sha256Digest;
  constitution_edit_gate_id?: PathSafeId;
}>;

type BuiltSecondarySection = Readonly<{
  section: ImplementationRepositorySectionV1;
  observations: ReadonlyMap<RepositoryPathClaim, Awaited<ReturnType<typeof observePath>>>;
}>;

export type ImplementationRepositoryManifestFacts = Readonly<{
  snapshot_entries: readonly SnapshotObservation[];
  raw_payloads: ReadonlyMap<RepositoryPathClaim, Uint8Array>;
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

/** One exact historical-milestone predicate that the selected immutable candidate failed. */
export type MilestoneMiss =
  | "target-moved"
  | "baseline-not-ancestor"
  | "candidate-not-found"
  | "base-commit-mismatch"
  | "parent-not-baseline"
  | "message-mismatch"
  | "paths-mismatch"
  | "tree-mismatch"
  | "paths-outside-task"
  | "missing-recovery-authority"
  | "approved-document-mismatch"
  | "unauthorized-task-document";

/**
 * Shared proof vocabulary for document and implementation milestones. `proven.commit` is always
 * the original candidate, never a later descendant. Target facts are the fresh pin against which
 * the immutable candidate was inspected.
 */
export type MilestoneProof =
  | Readonly<{ kind: "proven"; commit: GitOid; target_ref: string; target_head: GitOid }>
  | Readonly<{ kind: "not-created"; target_ref: string; target_head: GitOid }>
  | Readonly<{
      kind: "missing-from-history";
      reason: MilestoneMiss;
      target_ref: string;
      target_head: GitOid;
      paths?: readonly string[];
    }>
  | Readonly<{ kind: "unverifiable"; reason: "git-unavailable" | "repository-observation-failed" }>;

function missing(
  targetRef: string,
  targetHead: GitOid,
  reason: MilestoneMiss,
  paths?: readonly string[],
): MilestoneProof {
  return Object.freeze({
    kind: "missing-from-history",
    reason,
    target_ref: targetRef,
    target_head: targetHead,
    ...(paths === undefined ? {} : { paths: Object.freeze([...paths]) }),
  });
}

type PinnedMilestoneTarget = Readonly<{
  target_ref: string;
  target_head: GitOid;
  candidate?: GitOid;
}>;

async function pinMilestoneTarget(
  runner: RootBoundGitRunner,
  targetRef: string,
  baseline: GitOid,
): Promise<MilestoneProof | PinnedMilestoneTarget> {
  try {
    const symbolicRef = await runner.runText({
      argv: ["symbolic-ref", "--quiet", "HEAD"],
      operation: "git-current-milestone-target" as SafeCode,
      expectedAbsence: [{ code: 1, stderrIncludes: "" }],
    });
    const head = await resolveCommit(runner, "HEAD");
    const targetHead = await resolveCommit(runner, targetRef);
    if ((targetRef === "HEAD" ? symbolicRef !== "" : symbolicRef !== targetRef) || head !== targetHead) {
      return missing(targetRef, targetHead, "target-moved");
    }
    if (targetHead === baseline) return Object.freeze({ target_ref: targetRef, target_head: targetHead });
    if (!await isCommitAncestor(runner, baseline, targetHead)) {
      return missing(targetRef, targetHead, "baseline-not-ancestor");
    }
    const candidate = await readFirstParentChildAfter(runner, baseline, targetHead);
    if (candidate === undefined) return missing(targetRef, targetHead, "candidate-not-found");
    return Object.freeze({ target_ref: targetRef, target_head: targetHead, candidate });
  } catch (error) {
    return Object.freeze({
      kind: "unverifiable",
      reason: error instanceof GitInvocationError ? "git-unavailable" : "repository-observation-failed",
    });
  }
}

function isMilestoneProof(value: MilestoneProof | PinnedMilestoneTarget): value is MilestoneProof {
  return "kind" in value;
}

async function candidateStillPinned(
  runner: RootBoundGitRunner,
  pin: Required<PinnedMilestoneTarget>,
  baseline: GitOid,
): Promise<boolean> {
  const symbolicRef = await runner.runText({
    argv: ["symbolic-ref", "--quiet", "HEAD"],
    operation: "git-current-milestone-target" as SafeCode,
    expectedAbsence: [{ code: 1, stderrIncludes: "" }],
  });
  if ((pin.target_ref === "HEAD" ? symbolicRef !== "" : symbolicRef !== pin.target_ref) ||
      await resolveCommit(runner, "HEAD") !== pin.target_head ||
      await resolveCommit(runner, pin.target_ref) !== pin.target_head ||
      !await isCommitAncestor(runner, baseline, pin.target_head)) return false;
  return await readFirstParentChildAfter(runner, baseline, pin.target_head) === pin.candidate;
}

type MilestoneCommitFacts = Readonly<{
  target_ref: string;
  baseline_commit: GitOid;
  commit_message: string;
  paths: readonly string[];
}>;

/**
 * Shared proof of one exact authorized implementation commit on a target's first-parent history.
 * Primary and secondary repositories differ only in which authenticated facts must agree with the
 * durable output before inspection, whether a moved target without a candidate is itself a miss,
 * and the Git operation vocabulary reported on failure.
 */
async function proveImplementationCommit(
  runner: RootBoundGitRunner,
  subject: ImplementationCommitSection,
  facts: MilestoneCommitFacts,
  options: Readonly<{ facts_match_output: boolean; expected_target_head?: GitOid; operation_prefix: "git" | "git-secondary" }>,
): Promise<MilestoneProof> {
  if (!options.facts_match_output) {
    try {
      return missing(facts.target_ref, await resolveCommit(runner, facts.target_ref), "base-commit-mismatch");
    } catch (error) {
      return Object.freeze({ kind: "unverifiable", reason: error instanceof GitInvocationError ? "git-unavailable" : "repository-observation-failed" });
    }
  }
  const pinned = await pinMilestoneTarget(runner, facts.target_ref, facts.baseline_commit);
  if (isMilestoneProof(pinned)) return pinned;
  if (pinned.candidate === undefined) {
    if (options.expected_target_head !== undefined && pinned.target_head !== options.expected_target_head) {
      return missing(pinned.target_ref, pinned.target_head, "target-moved");
    }
    return Object.freeze({ kind: "not-created", target_ref: pinned.target_ref, target_head: pinned.target_head });
  }
  const pin = pinned as Required<PinnedMilestoneTarget>;
  try {
    if (await resolveCommit(runner, `${pin.candidate}^`) !== facts.baseline_commit) {
      return missing(pin.target_ref, pin.target_head, "parent-not-baseline");
    }
    const message = await runner.runText({
      argv: ["log", "-1", "--format=%s", pin.candidate],
      operation: `${options.operation_prefix}-implementation-commit-message` as SafeCode,
    });
    if (message !== facts.commit_message) return missing(pin.target_ref, pin.target_head, "message-mismatch");
    const authorizedPaths = [...facts.paths].sort(ordinal);
    if (JSON.stringify(authorizedPaths) !== JSON.stringify(sortedUniqueImplementationPaths(subject))) {
      return missing(pin.target_ref, pin.target_head, "paths-mismatch");
    }
    const changedPaths = [...new Set(await runner.runNulFields({
      argv: ["diff-tree", "--no-commit-id", "--name-only", "--no-renames", "-z", "-r", facts.baseline_commit, pin.candidate, "--"],
      operation: `${options.operation_prefix}-implementation-commit-paths` as SafeCode,
    }))].sort(ordinal);
    if (JSON.stringify(changedPaths) !== JSON.stringify(authorizedPaths)) {
      return missing(pin.target_ref, pin.target_head, "paths-mismatch", changedPaths);
    }
    for (const entry of subject.outputs) {
      const committed = await readCommitTreeBlob(runner, pin.candidate, entry.path);
      if (entry.operation === "delete") {
        if (committed !== undefined) return missing(pin.target_ref, pin.target_head, "tree-mismatch", [entry.path]);
        continue;
      }
      if (committed?.mode !== entry.after.mode || committed.oid !== entry.after.oid) {
        return missing(pin.target_ref, pin.target_head, "tree-mismatch", [entry.path]);
      }
      if (entry.operation === "rename" &&
          await readCommitTreeBlob(runner, pin.candidate, entry.previous_path) !== undefined) {
        return missing(pin.target_ref, pin.target_head, "tree-mismatch", [entry.previous_path]);
      }
    }
    if (!await candidateStillPinned(runner, pin, facts.baseline_commit)) {
      return missing(pin.target_ref, pin.target_head, "target-moved");
    }
    return Object.freeze({ kind: "proven", commit: pin.candidate, target_ref: pin.target_ref, target_head: pin.target_head });
  } catch (error) {
    return Object.freeze({ kind: "unverifiable", reason: error instanceof GitInvocationError ? "git-unavailable" : "repository-observation-failed" });
  }
}

/** Resolves and proves the exact implementation milestone on the target's first-parent history. */
export async function resolveImplementationMilestoneProof(
  runner: RootBoundGitRunner,
  output: ImplementationOutputV1,
  context: GateContext<"commit-authorization"> | LegacyExactCommitAuthorizationContextV1,
): Promise<MilestoneProof> {
  return proveImplementationCommit(runner, output, context, {
    facts_match_output: context.baseline_commit === output.base_commit,
    operation_prefix: "git",
  });
}

/** Proves one secondary repository's exact authorized implementation commit. */
export async function resolveImplementationRepositoryMilestoneProof(
  runner: RootBoundGitRunner,
  section: ImplementationRepositorySectionV1,
  facts: SecondaryCommitAuthorizationV1 | RepositoryCommitMilestoneV1,
): Promise<MilestoneProof> {
  return proveImplementationCommit(runner, section, facts, {
    facts_match_output: facts.repository === section.repository &&
      facts.repository_identity_digest === section.repository_identity_digest &&
      facts.baseline_commit === section.base_commit &&
      facts.diff_digest === section.diff_digest &&
      facts.snapshot_digest === section.snapshot_digest,
    expected_target_head: facts.target_head,
    operation_prefix: "git-secondary",
  });
}

export type ImplementationCommitAction = Readonly<{
  paths: readonly string[];
  message: string;
  target_ref: string;
  baseline_commit: string;
  repository?: Readonly<{ name: string; location: string }>;
}>;

export type SecondaryCommitProgress =
  | Readonly<{ kind: "proven" }>
  | Readonly<{ kind: "not-created"; action: ImplementationCommitAction }>
  | Readonly<{ kind: "missing-from-history"; repository: string; proof: Extract<MilestoneProof, { kind: "missing-from-history" }> }>
  | Readonly<{ kind: "unverifiable"; repository: string; reason: Extract<MilestoneProof, { kind: "unverifiable" }>["reason"] }>;

/**
 * Observes the ordered set of changed secondary repository milestones. The durable output and
 * authenticated authority must name the same repositories in the same canonical order; an omitted,
 * extra, reordered, unavailable, or identity-mismatched repository therefore cannot be mistaken for
 * completed work. Stops at the first repository that is not proven.
 */
export async function observeSecondaryCommitProgress(
  output: ImplementationOutputV1,
  facts: readonly (SecondaryCommitAuthorizationV1 | RepositoryCommitMilestoneV1)[],
  repositories: RepositorySet | undefined,
): Promise<SecondaryCommitProgress> {
  const sections = (output.secondary_repositories ?? []).filter((section) => section.outputs.length > 0);
  if (sections.length === 0) return Object.freeze({ kind: "proven" });
  if (repositories === undefined || facts.length !== sections.length) {
    return Object.freeze({ kind: "unverifiable", repository: sections[0]!.repository, reason: "repository-observation-failed" });
  }
  const members = new Map(repositories.members.map((member) => [member.name, member]));
  for (let index = 0; index < sections.length; index += 1) {
    const section = sections[index]!;
    const fact = facts[index];
    const member = members.get(section.repository);
    if (fact === undefined || fact.repository !== section.repository || member === undefined ||
        member.mode !== "writable" || member.identity.digest !== section.repository_identity_digest) {
      return Object.freeze({ kind: "unverifiable", repository: section.repository, reason: "repository-observation-failed" });
    }
    const proof = await resolveImplementationRepositoryMilestoneProof(member.binding.runner, section, fact);
    if (proof.kind === "proven") continue;
    if (proof.kind === "not-created") {
      return Object.freeze({
        kind: "not-created",
        action: Object.freeze({
          paths: fact.paths,
          message: fact.commit_message,
          target_ref: fact.target_ref,
          baseline_commit: fact.baseline_commit,
          repository: Object.freeze({ name: section.repository, location: member.binding.runner.location.worktreeRoot }),
        }),
      });
    }
    if (proof.kind === "missing-from-history") {
      return Object.freeze({ kind: "missing-from-history", repository: section.repository, proof });
    }
    return Object.freeze({ kind: "unverifiable", repository: section.repository, reason: proof.reason });
  }
  return Object.freeze({ kind: "proven" });
}

/** Whether every changed secondary repository milestone is proven (see `observeSecondaryCommitProgress`). */
export async function secondaryImplementationMilestonesProven(
  output: ImplementationOutputV1,
  facts: readonly (SecondaryCommitAuthorizationV1 | RepositoryCommitMilestoneV1)[],
  repositories: RepositorySet,
): Promise<boolean> {
  const sections = (output.secondary_repositories ?? []).filter((section) => section.outputs.length > 0);
  if (facts.length !== sections.length) return false;
  return (await observeSecondaryCommitProgress(output, facts, repositories)).kind === "proven";
}

export async function resolveAutonomousImplementationMilestoneProof(
  runner: RootBoundGitRunner,
  output: ImplementationOutputV1,
  targetRef: string,
  commitMessage: string,
): Promise<MilestoneProof> {
  return resolveImplementationMilestoneProof(runner, output, {
    target_ref: targetRef,
    baseline_commit: output.base_commit,
    commit_message: commitMessage,
    paths: sortedUniqueImplementationPaths(output),
    diff_digest: output.diff_digest,
    current_artifact_digests: Object.freeze([]),
    parent_document_digests: Object.freeze(output.parent_documents.map((entry) => entry.content_digest).sort()),
  });
}

/**
 * Proves the design milestone commit authorized by the human gate. The commit
 * must be the direct child of the approved baseline, touch only this task, contain the reviewed
 * document plus durable recovery authority, and leave the task root clean.
 *
 * The same unauthorized-document rule is also applied *before* the commit exists. A superseded task
 * document left in the worktree — an abandoned phase's `impl-notes.md`, say — would otherwise be
 * swept into the whole-task-directory commit and only be rejected afterwards, at a point where the
 * commit can no longer be retried. Reporting it up front keeps the failure fixable.
 */
async function resolveDesignMilestoneProofUnchecked(
  runner: RootBoundGitRunner,
  taskId: string,
  artifact: DocumentArtifactV1,
  outputs: readonly OutputEntry[],
  context: Pick<GateContext<"design-approval">, "target_ref" | "baseline_commit" | "commit_message"> &
    Readonly<{
      authorized_document_paths?: readonly RepositoryPathClaim[];
    }>,
): Promise<MilestoneProof> {
  const prefix = `.archflow/tasks/${taskId}/`;
  const additional = artifact.additional_documents ?? [];
  const approvedDocumentPaths = new Set<RepositoryPathClaim>([
    artifact.projection_target,
    ...additional.map((entry) => entry.projection_target),
  ]);
  const authorizedDocumentPaths = new Set<RepositoryPathClaim>([
    ...approvedDocumentPaths,
    ...(context.authorized_document_paths ?? []),
  ]);
  const unauthorizedDocuments = (paths: readonly string[]): readonly string[] =>
    paths.filter((path) =>
      path.startsWith(prefix) &&
      isTaskDocumentPath(path.slice(prefix.length)) &&
      !authorizedDocumentPaths.has(path as RepositoryPathClaim));

  const pinned = await pinMilestoneTarget(runner, context.target_ref, context.baseline_commit);
  if (isMilestoneProof(pinned)) return pinned;
  if (pinned.candidate === undefined) {
    const pending = await readChangedGitPaths(runner, [`:(top,literal)${prefix.slice(0, -1)}`]);
    const unauthorized = unauthorizedDocuments(pending.paths);
    if (unauthorized.length > 0) return missing(pinned.target_ref, pinned.target_head, "unauthorized-task-document", unauthorized);
    return Object.freeze({ kind: "not-created", target_ref: pinned.target_ref, target_head: pinned.target_head });
  }
  const pin = pinned as Required<PinnedMilestoneTarget>;
  if (await resolveCommit(runner, `${pin.candidate}^`) !== context.baseline_commit) {
    return missing(pin.target_ref, pin.target_head, "parent-not-baseline");
  }
  const message = await runner.runText({
    argv: ["log", "-1", "--format=%s", pin.candidate],
    operation: "git-design-commit-message" as SafeCode,
  });
  if (message !== context.commit_message) return missing(pin.target_ref, pin.target_head, "message-mismatch");

  const changed = await runner.runNulFields({
    argv: ["diff-tree", "--no-commit-id", "--name-only", "-z", "-r", context.baseline_commit, pin.candidate, "--"],
    operation: "git-design-commit-paths" as SafeCode,
  });
  if (changed.length === 0) return missing(pin.target_ref, pin.target_head, "paths-outside-task");
  const outsideTask = changed.filter((path) => !path.startsWith(prefix));
  if (outsideTask.length > 0) return missing(pin.target_ref, pin.target_head, "paths-outside-task", outsideTask);
  if (!changed.includes(`${prefix}state.json`)) return missing(pin.target_ref, pin.target_head, "missing-recovery-authority");
  const archivedDecisionPair =
    changed.some((path) => path.startsWith(`${prefix}authority/decisions/`) && path.endsWith("/request.json")) &&
    changed.some((path) => path.startsWith(`${prefix}authority/decisions/`) && path.endsWith("/decision.json"));
  if (!archivedDecisionPair) return missing(pin.target_ref, pin.target_head, "missing-recovery-authority");

  for (const path of approvedDocumentPaths) {
    const output = outputs.find((entry) => entry.path === path);
    if (output === undefined || output.operation === "delete") return missing(pin.target_ref, pin.target_head, "approved-document-mismatch", [path]);
    const committed = await readCommitTreeBlob(runner, pin.candidate, path);
    if (committed?.mode !== output.after.mode || committed.oid !== output.after.oid) {
      return missing(pin.target_ref, pin.target_head, "approved-document-mismatch", [path]);
    }
    const baseline = await readCommitTreeBlob(runner, context.baseline_commit, path);
    const differsFromBaseline = baseline?.mode !== output.after.mode || baseline.oid !== output.after.oid;
    if (differsFromBaseline && !changed.includes(path)) return missing(pin.target_ref, pin.target_head, "approved-document-mismatch", [path]);
  }
  const unauthorized = unauthorizedDocuments(changed);
  if (unauthorized.length > 0) return missing(pin.target_ref, pin.target_head, "unauthorized-task-document", unauthorized);
  if (!await candidateStillPinned(runner, pin, context.baseline_commit)) {
    return missing(pin.target_ref, pin.target_head, "target-moved");
  }
  return Object.freeze({ kind: "proven", commit: pin.candidate, target_ref: pin.target_ref, target_head: pin.target_head });
}

export async function resolveDesignMilestoneProof(
  runner: RootBoundGitRunner,
  taskId: string,
  artifact: DocumentArtifactV1,
  outputs: readonly OutputEntry[],
  context: Pick<GateContext<"design-approval">, "target_ref" | "baseline_commit" | "commit_message"> &
    Readonly<{ authorized_document_paths?: readonly RepositoryPathClaim[] }>,
): Promise<MilestoneProof> {
  try {
    return await resolveDesignMilestoneProofUnchecked(runner, taskId, artifact, outputs, context);
  } catch (error) {
    return Object.freeze({
      kind: "unverifiable",
      reason: error instanceof GitInvocationError ? "git-unavailable" : "repository-observation-failed",
    });
  }
}

/**
 * Proves an autonomous design milestone from its durable settlement baseline. Unlike the human
 * gate path, there is no decision archive: the canonical state containing the accepted settlement
 * is the recovery authority, and the commit may change exactly that file plus the reviewed docs.
 */
async function resolveAutonomousDesignMilestoneProofUnchecked(
  runner: RootBoundGitRunner,
  state: TaskStateV1,
  artifact: DocumentArtifactV1,
  outputs: readonly OutputEntry[],
  targetRef: string,
  baselineCommit: string,
  commitMessage: string,
  context: RepositoryOperationContext,
): Promise<MilestoneProof> {
  if (!await approvedDesignWorktreeMatchesRetainedArtifact(runner, state.task_id, artifact, outputs, context)) {
    try {
      return missing(targetRef, await resolveCommit(runner, targetRef), "approved-document-mismatch");
    } catch (error) {
      return Object.freeze({ kind: "unverifiable", reason: error instanceof GitInvocationError ? "git-unavailable" : "repository-observation-failed" });
    }
  }
  const pinned = await pinMilestoneTarget(runner, targetRef, parseGitOid(baselineCommit));
  if (isMilestoneProof(pinned)) return pinned;
  const prefix = `.archflow/tasks/${state.task_id}/`;
  const approvedPaths = [artifact.projection_target, ...(artifact.additional_documents ?? []).map((entry) => entry.projection_target)];
  const approvedPathSet = new Set<string>(approvedPaths);
  const unauthorizedDocuments = (paths: readonly string[]): readonly string[] => paths.filter((path) =>
    path.startsWith(prefix) && isTaskDocumentPath(path.slice(prefix.length)) && !approvedPathSet.has(path));
  if (pinned.candidate === undefined) {
    const pending = await readChangedGitPaths(runner, [`:(top,literal)${prefix.slice(0, -1)}`]);
    const unexpected = unauthorizedDocuments(pending.paths);
    return unexpected.length === 0
      ? Object.freeze({ kind: "not-created", target_ref: pinned.target_ref, target_head: pinned.target_head })
      : missing(pinned.target_ref, pinned.target_head, "unauthorized-task-document", unexpected);
  }
  const pin = pinned as Required<PinnedMilestoneTarget>;
  if (await resolveCommit(runner, `${pin.candidate}^`) !== baselineCommit) return missing(pin.target_ref, pin.target_head, "parent-not-baseline");
  const message = await runner.runText({
    argv: ["log", "-1", "--format=%s", pin.candidate],
    operation: "git-autonomous-design-commit-message" as SafeCode,
  });
  if (message !== commitMessage) return missing(pin.target_ref, pin.target_head, "message-mismatch");
  const changed = [...new Set(await runner.runNulFields({
    argv: ["diff-tree", "--no-commit-id", "--name-only", "--no-renames", "-z", "-r", baselineCommit, pin.candidate, "--"],
    operation: "git-autonomous-design-commit-paths" as SafeCode,
  }))].sort(ordinal);
  if (changed.length === 0 || changed.some((path) => !path.startsWith(prefix))) return missing(pin.target_ref, pin.target_head, "paths-outside-task", changed);
  if (!changed.includes(`${prefix}state.json`)) return missing(pin.target_ref, pin.target_head, "missing-recovery-authority");
  for (const path of approvedPaths) {
    const output = outputs.find((entry) => entry.path === path);
    if (output === undefined || output.operation === "delete") return missing(pin.target_ref, pin.target_head, "approved-document-mismatch", [path]);
    const committed = await readCommitTreeBlob(runner, pin.candidate, path);
    if (committed?.mode !== output.after.mode || committed.oid !== output.after.oid) {
      return missing(pin.target_ref, pin.target_head, "approved-document-mismatch", [path]);
    }
  }
  const unauthorized = unauthorizedDocuments(changed);
  if (unauthorized.length !== 0) return missing(pin.target_ref, pin.target_head, "unauthorized-task-document", unauthorized);
  const committedState = await readCommitTreeBlob(runner, pin.candidate, `${prefix}state.json`);
  if (committedState === undefined) return missing(pin.target_ref, pin.target_head, "missing-recovery-authority");
  const committedStateBytes = await readGitBlobBytes(runner, committedState.oid);
  let historicalState: TaskStateV1;
  try {
    const decoded = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(committedStateBytes)) as unknown;
    historicalState = taskStateV1Schema.parse(decoded);
    if (!isDeepStrictEqual(canonicalJsonBytes(historicalState), committedStateBytes)) {
      return missing(pin.target_ref, pin.target_head, "missing-recovery-authority");
    }
  } catch {
    return missing(pin.target_ref, pin.target_head, "missing-recovery-authority");
  }
  const subjectDigest = canonicalJsonDigest(artifact);
  const historicalSettlement = historicalState.rule_settlements?.find((settlement) =>
    settlement.task_id === state.task_id &&
    settlement.phase_instance === artifact.phase_instance &&
    settlement.subject_digest === subjectDigest &&
    settlement.conclusion.wait === false &&
    settlement.milestone_baseline_commit === baselineCommit);
  const currentSettlement = state.rule_settlements?.find((settlement) =>
    historicalSettlement !== undefined && isDeepStrictEqual(settlement, historicalSettlement));
  if (historicalSettlement === undefined || currentSettlement === undefined) {
    return missing(pin.target_ref, pin.target_head, "missing-recovery-authority");
  }
  if (!await candidateStillPinned(runner, pin, parseGitOid(baselineCommit))) {
    return missing(pin.target_ref, pin.target_head, "target-moved");
  }
  return Object.freeze({ kind: "proven", commit: pin.candidate, target_ref: pin.target_ref, target_head: pin.target_head });
}

export async function resolveAutonomousDesignMilestoneProof(
  runner: RootBoundGitRunner,
  state: TaskStateV1,
  artifact: DocumentArtifactV1,
  outputs: readonly OutputEntry[],
  targetRef: string,
  baselineCommit: string,
  commitMessage: string,
  context: RepositoryOperationContext,
): Promise<MilestoneProof> {
  try {
    return await resolveAutonomousDesignMilestoneProofUnchecked(
      runner, state, artifact, outputs, targetRef, baselineCommit, commitMessage, context,
    );
  } catch (error) {
    return Object.freeze({
      kind: "unverifiable",
      reason: error instanceof GitInvocationError ? "git-unavailable" : "repository-observation-failed",
    });
  }
}

/** @deprecated Callers selecting workflow authority must consume `MilestoneProof` directly. */
export async function implementationOutputCommittedAtCurrentTarget(
  runner: RootBoundGitRunner,
  output: ImplementationOutputV1,
  context: GateContext<"commit-authorization">,
): Promise<boolean> {
  return (await resolveImplementationMilestoneProof(runner, output, context)).kind === "proven";
}

/** @deprecated Callers selecting workflow authority must consume `MilestoneProof` directly. */
export async function autonomousImplementationOutputCommittedAtCurrentTarget(
  runner: RootBoundGitRunner,
  output: ImplementationOutputV1,
  targetRef: string,
  commitMessage: string,
): Promise<boolean> {
  return (await resolveAutonomousImplementationMilestoneProof(runner, output, targetRef, commitMessage)).kind === "proven";
}

export type DesignMilestoneMiss = "target-moved" | "not-committed" | MilestoneMiss;
export type DesignMilestoneObservation =
  | Readonly<{ observed: true }>
  | Readonly<{ observed: false; reason: DesignMilestoneMiss; blocking: boolean; paths?: readonly string[] }>;

function legacyDesignObservation(proof: MilestoneProof): DesignMilestoneObservation {
  if (proof.kind === "proven") return Object.freeze({ observed: true });
  if (proof.kind === "not-created") {
    return Object.freeze({ observed: false, reason: "not-committed", blocking: false });
  }
  if (proof.kind === "unverifiable") {
    throw new TypeError(`milestone proof unavailable: ${proof.reason}`);
  }
  return Object.freeze({
    observed: false,
    reason: proof.reason,
    blocking: true,
    ...(proof.paths === undefined ? {} : { paths: proof.paths }),
  });
}

/** @deprecated Callers selecting workflow authority must consume `MilestoneProof` directly. */
export async function designArtifactCommittedAtCurrentTarget(
  runner: RootBoundGitRunner,
  taskId: string,
  artifact: DocumentArtifactV1,
  outputs: readonly OutputEntry[],
  context: Pick<GateContext<"design-approval">, "target_ref" | "baseline_commit" | "commit_message"> &
    Readonly<{ authorized_document_paths?: readonly RepositoryPathClaim[] }>,
): Promise<DesignMilestoneObservation> {
  return legacyDesignObservation(await resolveDesignMilestoneProof(runner, taskId, artifact, outputs, context));
}

/** @deprecated Callers selecting workflow authority must consume `MilestoneProof` directly. */
export async function autonomousDesignArtifactCommittedAtCurrentTarget(
  runner: RootBoundGitRunner,
  state: TaskStateV1,
  artifact: DocumentArtifactV1,
  outputs: readonly OutputEntry[],
  targetRef: string,
  baselineCommit: string,
  commitMessage: string,
  context: RepositoryOperationContext,
): Promise<DesignMilestoneObservation> {
  return legacyDesignObservation(await resolveAutonomousDesignMilestoneProof(
    runner, state, artifact, outputs, targetRef, baselineCommit, commitMessage, context,
  ));
}

/**
 * Compares the live approved documents to the original retained produce identities. This is
 * deliberately independent of reconciliation generations: adopting later bytes as a projection
 * baseline cannot turn them into the bytes that the rule settlement reviewed.
 */
export async function approvedDesignWorktreeMatchesRetainedArtifact(
  runner: RootBoundGitRunner,
  taskId: string,
  artifact: DocumentArtifactV1,
  outputs: readonly OutputEntry[],
  context: RepositoryOperationContext,
): Promise<boolean> {
  if (artifact.task_id !== taskId) return false;
  const approvedPaths = [
    artifact.projection_target,
    ...(artifact.additional_documents ?? []).map((entry) => entry.projection_target),
  ];
  for (const path of approvedPaths) {
    const output = outputs.find((entry) => entry.path === path);
    if (output === undefined || output.operation === "delete") return false;
    const resolved = await resolveDeclaredOutputPath({
      runner,
      taskId: artifact.task_id,
      claim: output.path,
      pathClass: output.path_class,
      context,
    });
    if (!resolved.ok) return false;
    const live = await observePath(runner, resolved.value);
    if (!sameIdentity(live.observation, output.after)) return false;
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

export type ImplementationCommitSection = Pick<ImplementationOutputV1, "outputs"> |
  Pick<ImplementationRepositorySectionV1, "outputs">;

/** Exact sorted commit scope for either the primary output or one secondary section. */
export function sortedUniqueImplementationPaths(output: ImplementationCommitSection): readonly RepositoryPathClaim[] {
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

export function deriveOverallImplementationDiffDigest(
  primaryDigest: Sha256Digest,
  sections: readonly ImplementationRepositorySectionV1[],
): Sha256Digest {
  if (sections.length === 0) return primaryDigest;
  return canonicalJsonDigest({
    schema_version: "1",
    digest_kind: "multi-repository-implementation-diff",
    primary_diff_digest: primaryDigest,
    secondary_repositories: [...sections].sort((a, b) => ordinal(a.repository, b.repository)).map((section) => ({
      repository: section.repository,
      repository_identity_digest: section.repository_identity_digest,
      base_commit: section.base_commit,
      diff_digest: section.diff_digest,
    })),
  });
}

export function deriveOverallImplementationSnapshotDigest(
  primaryDigest: Sha256Digest,
  sections: readonly ImplementationRepositorySectionV1[],
): Sha256Digest {
  if (sections.length === 0) return primaryDigest;
  return canonicalJsonDigest({
    schema_version: "1",
    digest_kind: "multi-repository-implementation-snapshot",
    primary_snapshot_digest: primaryDigest,
    secondary_repositories: [...sections].sort((a, b) => ordinal(a.repository, b.repository)).map((section) => ({
      repository: section.repository,
      repository_identity_digest: section.repository_identity_digest,
      base_commit: section.base_commit,
      snapshot_digest: section.snapshot_digest,
    })),
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
  "document", "repository-source", "task-branch-constitution",
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

async function readRegularBytes(path: ResolvedPath | ResolvedWorkspacePath, label: string): Promise<Uint8Array> {
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
 * Resolves the commit the caller says it started from to its canonical object id.
 *
 * Callers name that commit in whatever form they hold it, and an abbreviated hash is the common
 * one. Git accepts abbreviations, so an unresolved prefix satisfies every observation here and
 * only fails much later, when the durable artifact is parsed against the full-length `GitOid`
 * shape — by then the failure is an opaque internal error with nothing to correct. Resolving up
 * front makes the artifact name one unambiguous commit and turns an unusable reference into a
 * contract failure the caller can act on.
 */
async function resolveBaseCommit(
  runner: RootBoundGitRunner,
  revision: string,
): Promise<ProjectResult<GitOid>> {
  try {
    return Object.freeze({ schema_version: "1", ok: true, value: await resolveCommit(runner, revision) });
  } catch {
    return Object.freeze({
      schema_version: "1",
      ok: false,
      error: createProjectError("CONTRACT_INVALID", { issue_code: "base-commit-unresolvable" }),
    });
  }
}

async function buildSecondaryRepositorySection(
  authority: TransactionAuthority,
  member: RepositoryMember,
  declaration: NonNullable<ImplementationOutputInput["repositories"]>[number],
  measuredAtRevision: SafeInteger,
): Promise<ProjectResult<BuiltSecondarySection>> {
  const runner = member.binding.runner;
  const base = await resolveBaseCommit(runner, declaration.base_commit);
  if (!base.ok) return base;
  if (base.value !== member.head) {
    return Object.freeze({
      schema_version: "1",
      ok: false,
      error: createProjectError("CONTRACT_INVALID", { issue_code: "secondary-base-commit-mismatch" }),
    });
  }
  const outputPaths = [...declaration.outputs].sort(ordinal);
  if (new Set(outputPaths).size !== outputPaths.length) throw new TypeError(`secondary repository ${member.name} outputs must be unique`);
  const renameChanges = await readRenameSources(runner, base.value);
  const observations = new Map<RepositoryPathClaim, Awaited<ReturnType<typeof observePath>>>();
  const resolvedPaths = new Map<RepositoryPathClaim, ResolvedPath>();
  const resolveOutput = async (path: RepositoryPathClaim): Promise<ProjectResult<ResolvedPath>> => {
    const classified = classifyRepositoryPath(path);
    if (!classified.ok) return classified;
    if (classified.value !== "repository-source" || path === ".archflow" || path.startsWith(".archflow/")) {
      throw new TypeError(`secondary repository ${member.name} path is not repository source`);
    }
    const resolved = await resolveRepositoryPath({ runner, claim: path, context: authority.context });
    if (!resolved.ok) return resolved;
    resolvedPaths.set(path, resolved.value);
    observations.set(path, await observePath(runner, resolved.value));
    return resolved;
  };
  const outputs: OutputEntry[] = [];
  for (const path of outputPaths) {
    const resolved = await resolveOutput(path);
    if (!resolved.ok) return resolved;
    const after = observations.get(path)!;
    const before = await baseIdentity(runner, base.value, path);
    let previousPath = before === undefined && after.observation.state === "present" ? renameChanges.renames.get(path) : undefined;
    if (previousPath === undefined && before === undefined && after.observation.state === "present") {
      const candidates: RepositoryPathClaim[] = [];
      for (const deletedPath of renameChanges.deleted) {
        const deletedIdentity = await baseIdentity(runner, base.value, deletedPath);
        if (deletedIdentity !== undefined && isDeepStrictEqual(deletedIdentity, identityOf(after.observation))) candidates.push(deletedPath);
      }
      if (candidates.length === 1) previousPath = candidates[0];
    }
    if (previousPath !== undefined) {
      const previous = await resolveOutput(previousPath);
      if (!previous.ok) return previous;
      const previousIdentity = await baseIdentity(runner, base.value, previousPath);
      if (previousIdentity === undefined || after.observation.state !== "present") throw new TypeError("secondary rename does not match base/worktree state");
      const afterIdentity = identityOf(after.observation);
      const retainedByGit = isDeepStrictEqual(previousIdentity, afterIdentity) && await isCommitAncestorOfHead(runner, base.value);
      outputs.push(Object.freeze(retainedByGit ? {
        path, path_class: "repository-source", operation: "rename", storage: "git-object",
        file_type: after.observation.file_type, before: previousIdentity, after: afterIdentity, previous_path: previousPath,
      } : {
        path, path_class: "repository-source", operation: "rename", storage: "raw-payload",
        payload_bytes: parseSafeInteger(after.bytes!.byteLength), payload_digest: sha256Bytes(after.bytes!),
        file_type: after.observation.file_type, before: previousIdentity, after: afterIdentity, previous_path: previousPath,
      }) as OutputEntry);
    } else if (before === undefined && after.observation.state === "present") {
      outputs.push(Object.freeze({ path, path_class: "repository-source", operation: "add", storage: "raw-payload",
        payload_bytes: parseSafeInteger(after.bytes!.byteLength), payload_digest: sha256Bytes(after.bytes!),
        file_type: after.observation.file_type, after: identityOf(after.observation) }) as OutputEntry);
    } else if (before !== undefined && after.observation.state === "absent") {
      outputs.push(Object.freeze({ path, path_class: "repository-source", operation: "delete", storage: "git-object",
        file_type: before.mode === "120000" ? "symlink" : "regular", before }) as OutputEntry);
    } else if (before !== undefined && after.observation.state === "present") {
      outputs.push(Object.freeze({ path, path_class: "repository-source", operation: "modify", storage: "raw-payload",
        payload_bytes: parseSafeInteger(after.bytes!.byteLength), payload_digest: sha256Bytes(after.bytes!),
        file_type: after.observation.file_type, before, after: identityOf(after.observation) }) as OutputEntry);
    } else throw new TypeError("secondary declared output is absent from both base and worktree");
  }
  outputs.sort((a, b) => ordinal(a.path, b.path));
  const restoreTargets = [...declaration.restore_targets].sort(ordinal);
  if (new Set(restoreTargets).size !== restoreTargets.length || restoreTargets.some((path) => !outputPaths.includes(path))) {
    throw new TypeError(`secondary repository ${member.name} restore targets must be unique declared outputs`);
  }
  const scope = [...new Set(outputs.flatMap((output) => output.operation === "rename" ? [output.path, output.previous_path] : [output.path]))].sort(ordinal) as RepositoryPathClaim[];
  const changed = await readChangedGitPaths(runner);
  const scopeSet = new Set<string>(scope);
  // Parity with the primary scan: undeclared dirt is recorded in the section's report (attributed
  // to the repository by the section itself) and surfaces through review, never rejected here.
  const callerChanges = changed.paths.filter((path) => !path.startsWith(".archflow/runtime/"));
  const undeclaredChanges: UndeclaredChangeReport = Object.freeze({
    scanned: true,
    undeclared_paths: Object.freeze(callerChanges.filter((path) => !scopeSet.has(path)).map(rawGitPath)),
    unrepresentable_count: parseSafeInteger(changed.unrepresentable_count),
  });
  const snapshotEntries = Object.freeze(scope.map((path) => observations.get(path)!.observation));
  const indexResult = await readIndexEntries(runner, scope, authority.context);
  if (!indexResult.ok) return indexResult;
  const indexByPath = new Map(indexResult.value.map((entry) => [entry.path, entry]));
  const indexEntries: IndexObservation[] = scope.map((path) => {
    const entry = indexByPath.get(path);
    if (entry === undefined) return Object.freeze({ path, state: "absent" });
    if (entry.stage !== 0) throw new TypeError("secondary declared index path is unmerged");
    return Object.freeze({ path, state: "present", stage: 0, mode: entry.mode, oid: entry.oid });
  });
  const declaredInputs: SecondaryDeclaredInputRefV1[] = [];
  for (const declared of [...declaration.declared_inputs].sort((a, b) => ordinal(a.input_id, b.input_id))) {
    if (declared.path === ".archflow" || declared.path.startsWith(".archflow/")) throw new TypeError(`secondary repository ${member.name} input is not repository source`);
    const resolved = await resolveRepositoryPath({ runner, claim: declared.path, context: authority.context });
    if (!resolved.ok) return resolved;
    declaredInputs.push(Object.freeze({ input_id: declared.input_id, path: declared.path, digest: sha256Bytes(await readRegularBytes(resolved.value, "secondary declared input")) }));
  }
  const countedEntries: SnapshotAccountingEntry[] = outputs.map((output) => Object.freeze(output.storage === "raw-payload"
    ? { path: output.path, storage: "raw-payload", stored_bytes: output.payload_bytes }
    : { path: output.path, storage: "git-object", stored_bytes: 0 }));
  const resultBytes = parseSafeInteger(countedEntries.reduce((sum, entry) => sum + entry.stored_bytes, 0));
  return Object.freeze({ schema_version: "1", ok: true, value: Object.freeze({
    section: Object.freeze({
      repository: declaration.name,
      repository_identity_digest: member.identity.digest,
      base_commit: base.value,
      index_identity_digest: deriveIndexIdentityDigest(indexEntries, undeclaredChanges),
      worktree_identity_digest: deriveWorktreeIdentityDigest(snapshotEntries, undeclaredChanges),
      outputs: Object.freeze(outputs), diff_digest: deriveImplementationDiffDigest(base.value, outputs),
      snapshot_digest: deriveSnapshotDigest(snapshotEntries), restore_targets: Object.freeze(restoreTargets),
      accounting: Object.freeze({ schema_version: "1", result_bytes: resultBytes, task_bytes: resultBytes,
        result_byte_cap: 26_214_400, task_byte_cap: 262_144_000, counted_entries: Object.freeze(countedEntries), measured_at_revision: measuredAtRevision }),
      undeclared_changes: undeclaredChanges, declared_inputs: Object.freeze(declaredInputs),
    }),
    observations,
  }) });
}

/** Rebuilds one durable secondary section through its bound member and compares every fact. */
export async function verifyImplementationRepositorySection(
  authority: TransactionAuthority,
  member: RepositoryMember,
  section: ImplementationRepositorySectionV1,
): Promise<ImplementationRepositoryManifestFacts> {
  const built = await buildSecondaryRepositorySection(authority, member, {
    name: section.repository,
    base_commit: section.base_commit,
    outputs: section.outputs.map((output) => output.path),
    restore_targets: section.restore_targets,
    declared_inputs: section.declared_inputs.map((input) => ({ input_id: input.input_id, path: input.path })),
  }, section.accounting.measured_at_revision);
  if (!built.ok) throw built.error;
  if (!isDeepStrictEqual(built.value.section, section)) {
    throw new TypeError(`secondary repository ${section.repository} manifest disagrees with authenticated observations`);
  }
  const snapshotEntries = sortedUniqueImplementationPaths(section).map((path) =>
    built.value.observations.get(path)?.observation as SnapshotObservation);
  const rawPayloads = new Map<RepositoryPathClaim, Uint8Array>();
  for (const output of section.outputs) {
    if (output.storage !== "raw-payload") continue;
    const bytes = built.value.observations.get(output.path)?.bytes;
    if (bytes === undefined) throw new TypeError("secondary raw payload bytes unavailable");
    rawPayloads.set(output.path, new Uint8Array(bytes));
  }
  return Object.freeze({ snapshot_entries: Object.freeze(snapshotEntries), raw_payloads: rawPayloads });
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
  repositorySet?: RepositorySet,
): Promise<ProjectResult<ImplementationOutputV1>> {
  assertInternalTransactionAuthority(authority, {
    runner: dependencies.runner,
    environment: dependencies.environment,
  });
  assertPlainJson(suppliedInput, "implementation output builder input");
  const supplied = structuredClone(suppliedInput);
  const baseCommit = await resolveBaseCommit(dependencies.runner, supplied.base_commit);
  if (!baseCommit.ok) return baseCommit;
  const input: ImplementationOutputInput = { ...supplied, base_commit: baseCommit.value };
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
  const callerChanges = changed.paths.filter((path) => !path.startsWith(".archflow/runtime/"));
  const undeclaredChanges: UndeclaredChangeReport = Object.freeze({
    scanned: true,
    undeclared_paths: Object.freeze(callerChanges.filter((path) => !scopeSet.has(path)).map(rawGitPath)),
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

  const writableSecondaries = repositorySet?.members.filter((member, index) => index > 0 && member.mode === "writable") ?? [];
  const declarations = input.repositories ?? [];
  if (declarations.length !== writableSecondaries.length ||
      declarations.some((declaration, index) => declaration.name !== writableSecondaries[index]?.name)) {
    throw new TypeError("implementation secondary sections must exactly match writable repositories in ordinal order");
  }
  const builtSecondaries: BuiltSecondarySection[] = [];
  for (let index = 0; index < declarations.length; index += 1) {
    const built = await buildSecondaryRepositorySection(
      authority, writableSecondaries[index]!, declarations[index]!, state.value.revision,
    );
    if (!built.ok) return built;
    builtSecondaries.push(built.value);
  }
  const allInputIds = [
    ...declaredInputs.map((entry) => entry.input_id),
    ...builtSecondaries.flatMap((entry) => entry.section.declared_inputs.map((declared) => declared.input_id)),
  ];
  if (new Set(allInputIds).size !== allInputIds.length) throw new TypeError("declared input ids must be task-wide unique");

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
  for (const built of builtSecondaries) {
    for (const output of built.section.outputs) {
      if (output.operation === "delete") continue;
      const observed = built.observations.get(output.path);
      if (observed?.observation.state !== "present" || observed.bytes === undefined) {
        throw new TypeError("secondary present output bytes are unavailable");
      }
      // The scanner keys candidates by virtual path. A plain `<name>/<path>` join can collide with
      // a primary path (`api/src/x.ts` vs. secondary `api` at `src/x.ts`), so secondaries are
      // keyed under a `.archflow/repositories/` prefix, which primary source outputs never use.
      scanCandidates.push(secretScanCandidateFromBytes({
        virtual_path: parseRepositoryPathClaim(`.archflow/repositories/${built.section.repository}/${output.path}`),
        path_class: "repository-source",
        bytes: observed.bytes,
      }));
    }
  }
  const secretScan = await createSecretlintScanner().scan(scanCandidates);
  const decodedPhase = decodePhaseInstance(input.phase_instance);
  if (decodedPhase.kind !== "phase-impl") throw new TypeError("implementation output phase must be phase-impl");
  const transcript = await resolveTaskWorkspacePath({
    runner: dependencies.runner,
    taskId: authority.task_id,
    claim: verificationTranscriptClaim(decodedPhase.phase),
    expectedClass: "workspace-verification-transcript",
    context: authority.context,
  });
  if (!transcript.ok) return transcript;
  const transcriptBytes = await readRegularBytes(transcript.value, "verification transcript");
  const countedEntries: SnapshotAccountingEntry[] = outputs.map((output) => Object.freeze(output.storage === "raw-payload"
    ? { path: output.path, storage: "raw-payload", stored_bytes: output.payload_bytes }
    : { path: output.path, storage: "git-object", stored_bytes: 0 }));
  const resultBytes = parseSafeInteger(countedEntries.reduce((total, entry) => total + entry.stored_bytes, 0));
  const aggregateResultBytes = parseSafeInteger(resultBytes + builtSecondaries.reduce(
    (total, entry) => total + entry.section.accounting.result_bytes, 0,
  ));
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
    diff_digest: deriveOverallImplementationDiffDigest(
      deriveImplementationDiffDigest(input.base_commit, outputs), builtSecondaries.map((entry) => entry.section),
    ),
    snapshot_digest: deriveOverallImplementationSnapshotDigest(
      deriveSnapshotDigest(snapshotEntries), builtSecondaries.map((entry) => entry.section),
    ),
    restore_targets: Object.freeze(restoreTargets),
    accounting: Object.freeze({
      schema_version: "1",
      result_bytes: resultBytes,
      task_bytes: parseSafeInteger(retainedBytes + aggregateResultBytes),
      result_byte_cap: 26_214_400,
      task_byte_cap: 262_144_000,
      counted_entries: Object.freeze(countedEntries),
      measured_at_revision: state.value.revision,
    }),
    secret_scan: secretScan,
    undeclared_changes: undeclaredChanges,
    verification_evidence: Object.freeze({
      transcript_digest: sha256Bytes(transcriptBytes),
      byte_count: parseSafeInteger(transcriptBytes.byteLength),
    }),
    declared_inputs: Object.freeze(declaredInputs),
    ...(builtSecondaries.length === 0 ? {} : {
      secondary_repositories: Object.freeze(builtSecondaries.map((entry) => entry.section)),
    }),
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
  const decodedPhase = decodePhaseInstance(output.phase_instance);
  if (decodedPhase.kind !== "phase-impl") throw new TypeError("implementation output phase must be phase-impl");
  const transcript = await resolveTaskWorkspacePath({
    runner,
    taskId: output.task_id,
    claim: verificationTranscriptClaim(decodedPhase.phase),
    expectedClass: "workspace-verification-transcript",
    context,
  });
  if (!transcript.ok) throw transcript.error;
  const transcriptBytes = await readRegularBytes(transcript.value, "verification transcript");
  if (sha256Bytes(transcriptBytes) !== output.verification_evidence.transcript_digest ||
      transcriptBytes.byteLength !== output.verification_evidence.byte_count) {
    throw new TypeError("verification transcript disagrees with durable verification evidence");
  }
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
  const scope = sortedUniqueImplementationPaths(output);
  const changed = await readChangedGitPaths(runner);
  const scopeSet = new Set<string>(scope);
  const callerChanges = changed.paths.filter((path) => !path.startsWith(".archflow/runtime/"));
  const undeclaredChanges: UndeclaredChangeReport = {
    scanned: true,
    undeclared_paths: callerChanges.filter((path) => !scopeSet.has(path)).map(rawGitPath),
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
    snapshot_digest: deriveOverallImplementationSnapshotDigest(
      deriveSnapshotDigest(snapshotEntries), output.secondary_repositories ?? [],
    ),
    diff_digest: deriveOverallImplementationDiffDigest(
      deriveImplementationDiffDigest(output.base_commit, output.outputs), output.secondary_repositories ?? [],
    ),
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

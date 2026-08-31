import { readFile } from "node:fs/promises";
import { join } from "node:path";

import { canonicalJsonDigest, parseCanonicalDocument, type CanonicalDocument, type GitOid } from "../contracts/canonical.js";
import type { ProjectionDigestRef } from "../contracts/durable-primitives.js";
import type { ConfigV1, RepositoryName, TaskConfigSnapshot } from "../contracts/config.js";
import type { ImplementationOutputV1 } from "../contracts/durable-implementation-output.js";
import { exactCommitAuthorizationContext, parseActiveGate, parsePersistedGateRequest, type ActiveGateV1, type GateRequestV1 } from "../contracts/durable-gate.js";
import type { ConfigChangeEntry, RepositoryCommitMilestoneV1, RuleSettlementV1, TaskStateV1 } from "../contracts/durable-state.js";
export type { ConfigChangeEntry } from "../contracts/durable-state.js";
import type { AdjudicationEvidence } from "../contracts/adjudication.js";
import {
  projectDispatchFailureObservation,
  type PublicDispatchFailureV1,
} from "../contracts/dispatch-failure.js";
import type { ProjectError, ProjectResult } from "../contracts/errors.js";
import { baselineAdoptionDriftDigest, computeGateContextDigest } from "../contracts/fingerprints.js";
import type { PathSafeId, SafeCode, SafeInteger, Sha256Digest, TaskSlug } from "../contracts/evidence.js";
import type { RepositoryPathClaim } from "../contracts/path-claims.js";
import { decodePhaseInstance, type PhaseInstanceId } from "../contracts/phase-instance.js";
import type {
  BaselineObservationRef,
  GateContext,
  LegacyDesignApprovalContextV1,
  SecondaryCommitAuthorizationV1,
} from "../contracts/gates.js";
import type { PlainJsonValue } from "../contracts/plain-json.js";
import type { ReviewerRunV1, ReviewEvidence, RouteOverrideRecord, RouteSourceRecord } from "../contracts/review.js";
import type { RepositoryStatusV1 } from "../contracts/semantic-workflow.js";
import type { CurrentEvidenceSetRef } from "../contracts/trust.js";
import { configuredRoute, resolveDispatchRoute, type DispatchRoute } from "../dispatch/routing.js";
import { designApprovalPolicyContext, selectAdjudicationGates } from "../review/adjudication.js";
import { assessCurrentEvidence, DEFAULT_MAX_ATTEMPTS, waiverInForce, type EvidenceAssessment } from "../review/fixed-point.js";
import { loadCanonicalRubricForPhaseKind, type CanonicalRubric } from "../review/rubrics.js";
import { createGitRunner, preflightGit, readChangedGitPaths, readCommitTreeBlob, readFirstParentChildAfter, resolveCommit } from "../repository/git.js";
import { discoverWorktree, type RootBoundGitRunner } from "../repository/identity.js";
import { resolveRepositorySet, type RepositorySet } from "../repository/repository-set.js";
import { readTaskConfig, readTaskState } from "./read.js";
import { computeConfigChange, validateRepositorySetContinuity } from "./config-change.js";
import type { TransactionAuthority } from "./authority.js";
import { assertInternalTransactionAuthority, createInternalTransactionAuthority } from "./authority.js";
import { authenticateRuleAcceptancePolicy, resolvePinnedConstitution, type ResolvedConstitution } from "./constitution.js";
import { deriveCurrentEvidenceSet, loadRetainedEvidence, retainedReviewEnvelopeDigest, type RetainedEvidenceSet } from "./evidence-results.js";
import { loadAuthenticatedGateApproval, type AuthenticatedGateApproval } from "./gate-approvals.js";
import {
  acceptedNoWaitSettlementWithoutOrdinaryApproval,
  authenticatedApprovalIsEligibleAfterLatestRestart,
  latestEligibleRuleSettlement,
  matchingOrdinaryApproval,
} from "./restart-authority.js";
import {
  buildGateDecisionTemplates,
  buildHumanGatePresentation,
  type HumanGatePresentation,
  type HumanGatePresentationDetails,
} from "./gate-decision-interface.js";
import { activeProjection, type GateLifecycleDependencies } from "./gate-core.js";
import { deriveNextAction, type NextAction, type PolicyReentryFindings } from "./next-action.js";
import { changedCoProducedDocumentPaths, expectedProduceUpstreamBindings, loadCurrentProduceSubject, loadProduceUpstreamSubject, produceOwnedTaskDocumentPaths, produceProjectionPins, produceUpstreamBindingsForSubject, readProduceProjection, readProduceProjectionSet } from "./produce-subject.js";
import type { CurrentProduceSubject } from "./produce-subject.js";
import { approvalRuleContext, evaluateApprovalRules } from "./approval-rules.js";
import {
  resolveAutonomousDesignMilestoneProof,
  resolveAutonomousImplementationMilestoneProof,
  resolveDesignMilestoneProof,
  observeSecondaryCommitProgress,
  resolveImplementationMilestoneProof,
  sortedUniqueImplementationPaths,
  type DesignMilestoneMiss,
  type ImplementationCommitAction,
  type MilestoneProof,
} from "./implementation-manifest.js";
import { phaseStatusResources, type StatusResource } from "./phase-documents.js";
import { inspectWorkspaceCleanup, type WorkspaceCleanupReport } from "./workspace-cleanup.js";
import { discoverReconciliationInput } from "./reconciliation-discovery.js";
import {
  activeGateHead,
  assessBaselineSubjectFreshness,
  baselinePresentedTargets,
  reconcileCurrentAuthority,
  type ReconciliationFinding,
  type ReconciliationResult,
} from "./reconciliation.js";
import { gateRequestClaim, parseWorkspacePathClaim, resolveTaskPath, resolveTaskWorkspacePath } from "../repository/paths.js";
import { loadLegacyImportInitialization } from "./legacy-import-resume.js";
import { readCurrentDispatchFailure } from "../dispatch/failure-observation.js";

const ok = <T>(value: T): ProjectResult<T> => Object.freeze({ schema_version: "1", ok: true, value });

type ConfigVerification = Readonly<{
  verified: boolean;
  issue?: string;
  issues?: readonly string[];
}>;

type StatusEvidence = Readonly<{
  available: false;
  reason: string;
  assessment?: EvidenceAssessment;
}> | Readonly<{
  available: true;
  subject_digest: Sha256Digest;
  current_evidence: CurrentEvidenceSetRef;
  /**
   * Every finding in the current review, joined to its recorded triage disposition when one
   * exists. `severity`/`summary` are reviewer-authored; `disposition`/`rationale` are the
   * producer's recorded answer. The join is keyed on the review evidence digest as well as the
   * finding id, so a triage bound to superseded review bytes contributes nothing rather than
   * mislabelling a current finding. Gate presentation reads this to show the human which
   * blocking findings were rejected as immaterial rather than fixed.
   */
  findings: readonly Readonly<{
    review_evidence_digest: Sha256Digest;
    finding_id: string;
    blocking: boolean;
    severity: ReviewEvidence["findings"][number]["severity"];
    summary: string;
    disposition?: string;
    rationale?: string;
  }>[];
  counter_review_provenance: Readonly<{
    assurance: string;
    producer_family: string;
    model_family: string;
    model: string;
    effort: string;
    adapter?: string;
    provider?: string;
    route_source?: RouteSourceRecord;
    route_override?: RouteOverrideRecord;
    reviewer_runs?: readonly ReviewerRunV1[];
  }>;
  assessment: EvidenceAssessment;
}>;

type ReviewedRepositoryPin = Readonly<{
  name: string;
  commit: GitOid;
}>;

/**
 * Projects only the repository claim made by a fresh server-attested review at the current
 * workflow position. Archived evidence without the optional field and every weaker assurance
 * deliberately project no reviewed commit.
 */
export function currentReviewedRepositoryPins(
  review: ReviewEvidence | undefined,
  taskId: TaskSlug,
  phaseInstance: PhaseInstanceId,
): readonly ReviewedRepositoryPin[] | undefined {
  if (
    review === undefined ||
    review.assurance !== "server-attested" ||
    review.task_id !== taskId ||
    review.phase_instance !== phaseInstance ||
    !("repositories" in review) ||
    review.repositories === undefined
  ) return undefined;
  return Object.freeze(review.repositories.map((repository) => Object.freeze({
    name: repository.name,
    commit: repository.commit,
  })));
}

/** Adds current-position reviewed commits to the already resolved live repository projection. */
export function projectReviewedRepositoryStatus(
  repositories: readonly RepositoryStatusV1[] | undefined,
  reviewed: readonly ReviewedRepositoryPin[] | undefined,
): readonly RepositoryStatusV1[] | undefined {
  if (repositories === undefined || reviewed === undefined) return repositories;
  const commits = new Map(reviewed.map((repository) => [repository.name, repository.commit]));
  return Object.freeze(repositories.map((repository) => {
    const commit = commits.get(repository.name);
    return Object.freeze({
      ...repository,
      ...(commit === undefined ? {} : { last_reviewed_commit: commit }),
    });
  }));
}

/**
 * Renders review coverage only when the gate binds the exact retained current evidence set.
 * Live HEAD comparison is informational; it changes neither the gate nor its authority.
 */
export function reviewedRepositoryGateDetails(
  active: ActiveGateV1,
  currentEvidence: CurrentEvidenceSetRef,
  reviewed: readonly ReviewedRepositoryPin[] | undefined,
  repositories: readonly RepositoryStatusV1[] | undefined,
): readonly string[] | undefined {
  if (
    active.kind === "baseline-adoption" ||
    !("current_evidence" in active) ||
    active.current_evidence.set_digest !== currentEvidence.set_digest ||
    reviewed === undefined ||
    // A single-repository task's evidence pins only `primary`; its gate presentation stays exactly
    // what it was before repository sets existed, so the lines appear only with a secondary.
    reviewed.every((repository) => repository.name === "primary")
  ) return undefined;
  const live = new Map((repositories ?? []).map((repository) => [repository.name, repository.head]));
  return Object.freeze(reviewed.map((repository) => {
    const reviewedCommit = repository.commit.slice(0, 12);
    const currentCommit = live.get(repository.name);
    return currentCommit === repository.commit
      ? `Repository ${repository.name} was reviewed at ${reviewedCommit}.`
      : currentCommit === undefined
        ? `Repository ${repository.name} was reviewed at ${reviewedCommit}; its current commit is unavailable.`
        : `Repository ${repository.name} was reviewed at ${reviewedCommit}; current commit ${currentCommit.slice(0, 12)} differs.`;
  }));
}

type OpenGateStatus = Readonly<{
  gate_id: PathSafeId;
  kind: ActiveGateV1["kind"];
  decision_path: string;
  archive_decision_path: string;
  request_path: string;
  decision_templates: readonly PlainJsonValue[];
  /** The default human-facing rendering. Binding templates and ids are diagnostic detail only. */
  presentation: HumanGatePresentation;
}>;

export type ApprovalIssue = Readonly<{
  gate_id: PathSafeId;
  gate_kind: TaskStateV1["approvals"][number]["gate_kind"];
  error: ProjectError | Readonly<{
    code: "APPROVAL_LOAD_EXCEPTION";
    message: string;
  }>;
}>;

/**
 * The reconciliation report status publishes: raw reconciliation truth minus any drift the
 * current produce write window authorizes. `archflow-local reconcile` keeps reporting the
 * unfiltered result; only status — which alone can see durable pipeline position and re-entry
 * assessment — reclassifies. Suppressed paths stay visible in `expected_reentry_edits`, so the
 * report never hides drift.
 */
export type StatusReconciliation = ReconciliationResult & Readonly<{
  expected_reentry_edits?: readonly ProjectionDigestRef["path"][];
}>;

export type CommitAuthorizationInput = Readonly<{
  kind: "commit-authorization";
  subject_digest: Sha256Digest;
  current_evidence: CurrentEvidenceSetRef;
  context: Readonly<{
    target_ref: string;
    baseline_commit: string;
    commit_message: string;
    paths: readonly string[];
    diff_digest: Sha256Digest;
    current_artifact_digests: readonly Sha256Digest[];
    parent_document_digests: readonly Sha256Digest[];
    secondary_commits?: readonly SecondaryCommitAuthorizationV1[];
  }>;
  target_ref_guidance: string;
}>;

export type DesignApprovalInput = Readonly<{
  kind: "design-approval";
  context: LegacyDesignApprovalContextV1;
  target_ref_guidance: string;
}>;

/**
 * The mechanically complete baseline-adoption gate subject: every live projection mismatch, bound
 * by digest, plus the drift observation that serves as the gate's evidence. Unlike the approval
 * inputs it exists without any review of the current phase — the drift set is the subject.
 */
export type BaselineAdoptionInput = Readonly<{
  kind: "baseline-adoption";
  subject_digest: Sha256Digest;
  current_evidence: BaselineObservationRef;
  context: GateContext<"baseline-adoption">;
}>;

export type BaselineAdoptionTargetFacts = Readonly<{
  target_ref: string;
  target_head: GitOid;
  uncommitted_paths: readonly RepositoryPathClaim[];
  secondary_targets?: readonly Readonly<{
    repository: string;
    repository_identity_digest: Sha256Digest;
    target_ref: string;
    target_head: GitOid;
    uncommitted_paths: readonly RepositoryPathClaim[];
  }>[];
}>;

/** Proves first-parent continuity for every repository head authenticated by a baseline gate. */
export async function baselinePresentedTargetsOnCurrentFirstParent(
  dependencies: Pick<GateLifecycleDependencies, "runner">,
  context: GateContext<"baseline-adoption">,
  live: BaselineAdoptionTargetFacts,
  repositorySet: RepositorySet | undefined,
): Promise<boolean> {
  const presented = baselinePresentedTargets(context);
  if (presented.length === 0) return false;
  return (await Promise.all(presented.map(async (target) => {
    const liveTarget = target.repository === "primary"
      ? live
      : live.secondary_targets?.find((candidate) => candidate.repository === target.repository);
    const runner = target.repository === "primary"
      ? dependencies.runner
      : repositorySet?.members.find((member) => member.name === target.repository)?.binding.runner;
    return liveTarget !== undefined && runner !== undefined && (
      target.target_head === liveTarget.target_head ||
      await readFirstParentChildAfter(runner, target.target_head, liveTarget.target_head) !== undefined
    );
  }))).every(Boolean);
}

/** Builds the baseline-adoption gate subject from the blocking reconciliation findings, or nothing. */
export function baselineAdoptionInputFromFindings(
  task_id: TaskSlug,
  state: TaskStateV1,
  findings: readonly ReconciliationFinding[],
  target?: BaselineAdoptionTargetFacts,
): BaselineAdoptionInput | undefined {
  const mismatches = findings.filter((finding): finding is Extract<ReconciliationFinding, { kind: "projection-mismatch" }> => finding.kind === "projection-mismatch");
  // The drift set splits into live-byte mismatches the human can adopt or restore, and committed
  // deletions — missing, unrestorable (adoption-sourced), and already absent from HEAD, so no
  // produce can re-declare them either. Any other missing projection (restorable, or deleted only
  // in the worktree) routes to restore or produce re-entry instead, and its presence makes the
  // set unrepresentable here.
  const primaryMismatches = mismatches.filter((finding) => finding.repository === undefined);
  const drifted = primaryMismatches.filter((finding) => finding.observed_digest !== undefined);
  const deleted = primaryMismatches.filter((finding) =>
    finding.observed_digest === undefined && finding.restore_unavailable === true && finding.committed_absent === true);
  const secondaryTargets = [...new Set(mismatches.flatMap((finding) => finding.repository === undefined ? [] : [finding.repository]))]
    .sort()
    .map((repository) => {
      const repositoryMismatches = mismatches.filter((finding) => finding.repository === repository);
      const repositoryDrifted = repositoryMismatches.filter((finding) => finding.observed_digest !== undefined);
      const repositoryDeleted = repositoryMismatches.filter((finding) =>
        finding.observed_digest === undefined && finding.restore_unavailable === true && finding.committed_absent === true);
      const facts = target?.secondary_targets?.find((candidate) => candidate.repository === repository);
      if (facts === undefined || repositoryDrifted.length + repositoryDeleted.length !== repositoryMismatches.length) return undefined;
      return Object.freeze({
        ...facts,
        repository: repository as RepositoryName,
        drifted_projections: Object.freeze(repositoryDrifted.map((finding) => Object.freeze({
          path: finding.path, recorded_digest: finding.recorded_digest, observed_digest: finding.observed_digest!,
        })).sort((left, right) => left.path.localeCompare(right.path))),
        deleted_projections: Object.freeze(repositoryDeleted.map((finding) => Object.freeze({
          path: finding.path, recorded_digest: finding.recorded_digest,
        })).sort((left, right) => left.path.localeCompare(right.path))),
      });
    });
  if (secondaryTargets.some((item) => item === undefined) ||
      drifted.length + deleted.length + secondaryTargets.reduce((count, item) => count + item!.drifted_projections.length + item!.deleted_projections.length, 0) !== mismatches.length) return undefined;
  if (drifted.length + deleted.length + secondaryTargets.length === 0) return undefined;
  const context: GateContext<"baseline-adoption"> = Object.freeze({
    drifted_projections: Object.freeze(drifted
      .map((finding) => Object.freeze({ path: finding.path, recorded_digest: finding.recorded_digest, observed_digest: finding.observed_digest! }))
      .sort((left, right) => left.path.localeCompare(right.path))),
    deleted_projections: Object.freeze(deleted
      .map((finding) => Object.freeze({ path: finding.path, recorded_digest: finding.recorded_digest }))
      .sort((left, right) => left.path.localeCompare(right.path))),
    ...(target === undefined || primaryMismatches.length === 0 ? {} : {
      target_ref: target.target_ref,
      target_head: target.target_head,
      uncommitted_paths: Object.freeze([...target.uncommitted_paths].sort((left, right) => left.localeCompare(right))),
    }),
    ...(secondaryTargets.length === 0 ? {} : { secondary_targets: Object.freeze(secondaryTargets as NonNullable<GateContext<"baseline-adoption">["secondary_targets"]>) }),
  });
  const subjectDigest = baselineAdoptionDriftDigest(context);
  return Object.freeze({
    kind: "baseline-adoption",
    subject_digest: subjectDigest,
    current_evidence: Object.freeze({
      schema_version: "1",
      observation_kind: "projection-drift",
      task_id,
      phase_instance: state.phase_instance,
      observed_at_revision: state.revision,
      drift_digest: subjectDigest,
    }),
    context,
  });
}

export async function currentBaselineTargetFacts(
  dependencies: GateLifecycleDependencies,
  findings: readonly ReconciliationFinding[],
  repositorySet?: RepositorySet,
): Promise<BaselineAdoptionTargetFacts> {
  const target = await currentTargetRef(dependencies);
  const targetHead = await resolveCommit(dependencies.runner, target.value);
  const changed = await readChangedGitPaths(dependencies.runner);
  const driftPaths = findings
    .filter((finding): finding is Extract<ReconciliationFinding, { kind: "projection-mismatch" }> =>
      finding.kind === "projection-mismatch" && finding.repository === undefined)
    .map((finding) => finding.path);
  const changedPaths = new Set(changed.paths);
  const secondaryTargets = [];
  for (const repository of [...new Set(findings.flatMap((finding) =>
    finding.kind === "projection-mismatch" && finding.repository !== undefined ? [finding.repository] : []))].sort()) {
    const member = repositorySet?.members.find((candidate) => candidate.name === repository);
    if (member === undefined || member.mode !== "writable") throw new BaselineRepositoryUnavailableError(repository);
    const memberTarget = await currentTargetRefForRunner(member.binding.runner);
    const memberHead = await resolveCommit(member.binding.runner, memberTarget.value);
    const memberChanged = await readChangedGitPaths(member.binding.runner);
    const memberChangedPaths = new Set(memberChanged.paths);
    const memberDriftPaths = findings.flatMap((finding) =>
      finding.kind === "projection-mismatch" && finding.repository === repository ? [finding.path] : []);
    secondaryTargets.push(Object.freeze({
      repository,
      repository_identity_digest: member.identity.digest,
      target_ref: memberTarget.value,
      target_head: memberHead,
      uncommitted_paths: Object.freeze(memberDriftPaths.filter((path) => memberChangedPaths.has(path)).sort((left, right) => left.localeCompare(right))),
    }));
  }
  // uncommitted_paths must carry the exact ordering the baseline-adoption context schema enforces
  // (localeCompare — default .sort() diverges on mixed-case sets and fails composition with an
  // internal error). The durable adoption record re-sorts code-unit by design; see
  // baselineAdoptionRecord in state/gates.ts.
  return Object.freeze({
    target_ref: target.value,
    target_head: targetHead,
    uncommitted_paths: Object.freeze(driftPaths.filter((path) => changedPaths.has(path)).sort((left, right) => left.localeCompare(right))),
    ...(secondaryTargets.length === 0 ? {} : { secondary_targets: Object.freeze(secondaryTargets) }),
  });
}

/**
 * A rewritten implementation milestone cannot enter fresh production when the retained reviewed
 * after-images are already the clean current target tree: that cycle has no commit subject and
 * could only manufacture an empty milestone. Git failures propagate so status treats the proof as
 * unavailable rather than guessing that a delta exists.
 */
async function implementationRecoveryHasNoDelta(
  dependencies: GateLifecycleDependencies,
  output: ImplementationOutputV1,
  targetHead: GitOid,
): Promise<boolean> {
  const paths = [...new Set(output.outputs.flatMap((entry) =>
    entry.operation === "rename" ? [entry.previous_path, entry.path] : [entry.path]))].sort();
  const changed = await readChangedGitPaths(
    dependencies.runner,
    paths.map((path) => `:(top,literal)${path}`),
  );
  if (changed.paths.length !== 0 || changed.unrepresentable_count !== 0) return false;
  for (const entry of output.outputs) {
    const current = await readCommitTreeBlob(dependencies.runner, targetHead, entry.path);
    if (entry.operation === "delete") {
      if (current !== undefined) return false;
      continue;
    }
    if (current?.mode !== entry.after.mode || current.oid !== entry.after.oid) return false;
    if (entry.operation === "rename" &&
        await readCommitTreeBlob(dependencies.runner, targetHead, entry.previous_path) !== undefined) {
      return false;
    }
  }
  return true;
}

export type TaskStatusV1 = Readonly<{
  task_id: TaskSlug;
  state: "missing" | "active" | "complete" | "abandoned";
  revision?: number;
  phase_instance?: PhaseInstanceId;
  step?: TaskStateV1["step"];
  status?: TaskStateV1["status"];
  open_gate_id?: PathSafeId;
  blocking_reasons: readonly string[];
  attempt?: number;
  input_fingerprint?: Sha256Digest;
  /** Canonical task and runtime paths the current phase reads or writes. */
  resources?: readonly StatusResource[];
  /** Immutable workflow review policy selected from the durable phase kind. */
  review_policy?: CanonicalRubric;
  /**
   * The current review subject: the canonical digest of the whole retained produce artifact
   * (`manifest.artifact_digest`), never the document's inner `content_digest`. Present whenever
   * the current phase has an authoritative produce result — in particular at `counter_review`
   * time, so review artifacts are never built from a hand-derived subject.
   */
  subject_digest?: Sha256Digest;
  config: ConfigVerification;
  /**
   * Live repository set resolved from the task config, each member with its mode, location, and
   * HEAD, plus `last_reviewed_commit` from the newest server-attested review at this position.
   * Absent when configuration is invalid.
   */
  repositories?: readonly RepositoryStatusV1[];
  /**
   * Field-level changes between the live parsed config and `state.last_seen_config`. Informational
   * only — never a blocker and never an action-kind change. Absent `last_seen_config`
   * (pre-cutover tasks) notices nothing: the first transaction after upgrade establishes the
   * baseline silently.
   */
  config_change?: readonly ConfigChangeEntry[];
  /** The dispatched review routes for the current phase kind; the producer is the host, never routed. */
  routes?: Readonly<{ counter_reviewer: DispatchRoute; test_reviewer?: DispatchRoute; effort_reviewer?: DispatchRoute; adjudicator: DispatchRoute }>;
  /** Safe exact-current dispatch outage facts; carries no runtime path or state join identifiers. */
  dispatch_failure?: PublicDispatchFailureV1;
  constitution?: Readonly<{
    digest: Sha256Digest;
    active_rules: readonly Readonly<{
      id: string;
      version: number;
      text: string;
      review_trigger?: string;
      enforced_by?: readonly string[];
    }>[];
  }>;
  open_gate?: OpenGateStatus;
  /** Exact approval archive failures for diagnostics; intentionally omitted from brief status. */
  approval_issues?: readonly ApprovalIssue[];
  reconciliation?: StatusReconciliation;
  evidence?: StatusEvidence;
  /**
   * Present when the current produce artifact declares an editorial predecessor: the gate
   * presenter uses it to show the editorial diff alongside the disclosure that the retained
   * reviews evaluated the predecessor bytes.
   */
  editorial_revision?: Readonly<{
    predecessor_subject_digest: Sha256Digest;
    dispositions: readonly Readonly<{
      finding_id: string;
      rationale: string;
      revision_intent: string;
    }>[];
  }>;
  gate_input?: CommitAuthorizationInput;
  /** The complete baseline-adoption gate subject when status routes to that decision. */
  baseline_adoption_gate?: BaselineAdoptionInput;
  /** Internal server-observed subject for the no-submission same-position recovery. */
  milestone_recovery?: Readonly<{
    cause: "milestone-proof-missing" | "governing-document-drift";
    target_ref: string;
    target_head: GitOid;
    subject_digest: Sha256Digest;
  }>;
  /** Derived cleanup state. Cleanup debt is non-blocking and never changes workflow routing. */
  workspace?: WorkspaceCleanupReport;
  next_action: NextAction;
}>;

/**
 * Authenticated inputs retained by the detailed status read for internal semantic projection.
 * This is intentionally not part of the serialized legacy status contract.
 */
export type DetailedTaskStatusV1 = Readonly<{
  status: TaskStatusV1;
  state?: TaskStateV1;
  state_document_digest?: Sha256Digest;
  live_config_digest?: Sha256Digest;
  legacy_import_initialization?: true;
  retained: RetainedEvidenceSet;
}>;

/**
 * The routine-loop projection of {@link TaskStatusV1}: position, blockers, and the one next
 * action, with every rendered body stripped — no constitution rule text, no counter-review
 * prompt, no decision-template bodies, no evidence detail. Everything here is derived from the
 * full status by {@link projectBriefStatus}; the computation is never forked.
 */
export type BriefTaskStatusV1 = Readonly<{
  task_id: TaskSlug;
  state: TaskStatusV1["state"];
  revision?: number;
  phase_instance?: PhaseInstanceId;
  step?: TaskStateV1["step"];
  status?: TaskStateV1["status"];
  attempt?: number;
  blocking_reasons: readonly string[];
  open_gate?: HumanGatePresentation;
  reconciliation?: Readonly<{
    classification: ReconciliationResult["classification"];
    findings: readonly Readonly<{ kind: string; path?: string }>[];
  }>;
  constitution?: Readonly<{
    digest: Sha256Digest;
    active_rule_ids: readonly string[];
  }>;
  /** Included in the routine view only when cleanup work remains. */
  workspace?: WorkspaceCleanupReport;
  next_action: Omit<NextAction, "gate_id">;
}>;

/** Keep routing identity in brief status without gate-internal material. */
function projectBriefNextAction(next: NextAction): Omit<NextAction, "gate_id"> {
  const { gate_id: _gateId, ...identity } = next;
  return Object.freeze(identity);
}

/** Projects the routine-loop brief view from an already-computed full status. */
export function projectBriefStatus(full: TaskStatusV1): BriefTaskStatusV1 {
  return Object.freeze({
    task_id: full.task_id,
    state: full.state,
    ...(full.revision === undefined ? {} : { revision: full.revision }),
    ...(full.phase_instance === undefined ? {} : { phase_instance: full.phase_instance }),
    ...(full.step === undefined ? {} : { step: full.step }),
    ...(full.status === undefined ? {} : { status: full.status }),
    ...(full.attempt === undefined ? {} : { attempt: full.attempt }),
    blocking_reasons: full.blocking_reasons,
    ...(full.open_gate === undefined ? {} : {
      open_gate: full.open_gate.presentation,
    }),
    ...(full.reconciliation === undefined || full.reconciliation.findings.length === 0 ? {} : {
      reconciliation: Object.freeze({
        classification: full.reconciliation.classification,
        findings: Object.freeze(full.reconciliation.findings.map((finding) => Object.freeze({
          kind: finding.kind,
          ...("path" in finding && finding.path !== undefined ? { path: finding.path } : {}),
        }))),
      }),
    }),
    ...(full.constitution === undefined ? {} : {
      constitution: Object.freeze({
        digest: full.constitution.digest,
        active_rule_ids: Object.freeze(full.constitution.active_rules.map((rule) => rule.id)),
      }),
    }),
    ...(full.workspace?.cleanup_pending === true ? { workspace: full.workspace } : {}),
    next_action: projectBriefNextAction(full.next_action),
  });
}

/**
 * Splits reconciliation findings into drift the current re-entry authorizes and everything else.
 *
 * Before a produce entry exists, fixed-point re-entry authorization tolerates only edits to the
 * retained current-phase produce projections. Once state durably sits at produce running/failed,
 * the write window itself authorizes implementation work: every projection mismatch is expected,
 * including edits to files projected by an earlier phase when the current phase has no produce
 * result yet. The terminal produce builder, not reconciliation, then seals the declared outputs,
 * base commit, index/worktree identities, undeclared-change report, and exact bytes. Receipt and
 * gate findings remain blocking throughout, and projection drift is strict again after produce.
 */
export function partitionExpectedReentryEdits(
  findings: readonly ReconciliationFinding[],
  assessment: EvidenceAssessment | undefined,
  produceSubject: CurrentProduceSubject | undefined,
  state: Pick<TaskStateV1, "step" | "status">,
): Readonly<{
  remaining: readonly ReconciliationFinding[];
  expected_reentry_edits: readonly ProjectionDigestRef["path"][];
}> {
  const activeProduce = state.step === "produce" && state.status !== "succeeded";
  const editAuthorized = assessment?.reentry_required === true ||
    assessment?.editorial_revision_required === true ||
    activeProduce;
  if (!editAuthorized) {
    return Object.freeze({ remaining: findings, expected_reentry_edits: Object.freeze([]) });
  }
  const producePaths = produceSubject === undefined
    ? undefined
    : new Set<string>(
        produceSubject.retained.manifest.value.projections.map((projection) => projection.path),
      );
  const remaining: ReconciliationFinding[] = [];
  const expected: ProjectionDigestRef["path"][] = [];
  for (const finding of findings) {
    if (finding.kind === "projection-mismatch" && (activeProduce || producePaths?.has(finding.path) === true)) {
      expected.push(finding.path);
    } else {
      remaining.push(finding);
    }
  }
  return Object.freeze({
    remaining: Object.freeze(remaining),
    expected_reentry_edits: Object.freeze(expected),
  });
}

function unavailableConfig(issue?: string, issues?: readonly string[]): ConfigVerification {
  return Object.freeze({
    verified: false,
    ...(issue === undefined ? {} : { issue }),
    ...(issues === undefined ? {} : { issues: Object.freeze([...issues]) }),
  });
}

async function readActiveGateProjection(
  dependencies: GateLifecycleDependencies,
  authority: TransactionAuthority,
): Promise<ActiveGateV1 | undefined> {
  try {
    const target = await resolveTaskWorkspacePath({
      runner: dependencies.runner,
      taskId: authority.task_id,
      claim: parseWorkspacePathClaim("cache/gates/gate.json"),
      expectedClass: "workspace-gate-interface",
      context: authority.context,
    });
    if (!target.ok) return undefined;
    const bytes = new Uint8Array(await readFile(target.value.absolute));
    return parseActiveGate(parseCanonicalDocument(bytes, "active gate").value);
  } catch {
    // The projection is disposable. Durable request authority remains sufficient to reconstruct
    // the base interface after a fresh clone or corrupt/missing cache.
    return undefined;
  }
}

async function readArchivedGateRequest(
  dependencies: GateLifecycleDependencies,
  authority: TransactionAuthority,
  gateId: PathSafeId,
): Promise<GateRequestV1 | undefined> {
  try {
    const target = await resolveTaskPath({
      runner: dependencies.runner,
      taskId: authority.task_id,
      claim: gateRequestClaim(gateId),
      expectedClass: "authority-decision",
      context: authority.context,
    });
    if (!target.ok) return undefined;
    const bytes = new Uint8Array(await readFile(target.value.absolute));
    // Every read of a persisted gate request goes through the tolerant archived parser: an open
    // gate written by an older bundle (for example a pre-deletion-adoption baseline tuple) must
    // keep projecting and resolving after switchover. Only composing a NEW request uses the
    // strict writer shape.
    return parsePersistedGateRequest(parseCanonicalDocument(bytes, "gate request").value);
  } catch (error) {
    if ((error as { code?: unknown }).code === "ENOENT") return undefined;
    throw error;
  }
}

/**
 * The review predecessor the fixed-point assessor must see: the current produce artifact's
 * declared editorial predecessor, or — when a one-hop simple human revision reused the prior
 * review — the predecessor that revision recorded. Shared by the status projection and the gate
 * composer so both assess exactly the same subject.
 */
export function currentReviewPredecessor(
  state: TaskStateV1,
  produceSubject: CurrentProduceSubject | undefined,
): Readonly<{ subject_digest: Sha256Digest; input_fingerprint: Sha256Digest }> | undefined {
  const midProduce = state.step === "produce" && state.status !== "succeeded";
  const declaredPredecessor = !midProduce && produceSubject?.artifact.artifact_kind === "document"
    ? produceSubject.artifact.editorial_predecessor
    : undefined;
  const currentProduceReference = state.authoritative_results.find((reference) =>
    reference.phase_instance === state.phase_instance && reference.step === "produce");
  const simpleHumanRevision = currentProduceReference === undefined
    ? undefined
    : [...(state.human_revision_history ?? [])].reverse().find((revision) =>
        revision.phase_instance === state.phase_instance &&
        revision.classification === "simple" &&
        revision.resulting_result_digest === currentProduceReference.result_digest);
  return declaredPredecessor === undefined
    ? simpleHumanRevision === undefined
      ? undefined
      : Object.freeze({
          subject_digest: simpleHumanRevision.predecessor_subject_digest,
          input_fingerprint: simpleHumanRevision.predecessor_input_fingerprint,
        })
    : Object.freeze({
        subject_digest: declaredPredecessor.subject_digest,
        input_fingerprint: declaredPredecessor.input_fingerprint,
      });
}

export async function currentApprovedUpstreams(
  dependencies: GateLifecycleDependencies,
  authority: TransactionAuthority,
  state: TaskStateV1,
  authenticated: readonly AuthenticatedGateApproval[],
  subject: CurrentProduceSubject | undefined,
): Promise<readonly Sha256Digest[]> {
  let settlementPolicy: ReturnType<typeof authenticateRuleAcceptancePolicy>;
  let settlementPolicyLoaded = false;
  const bindings = subject === undefined
    ? expectedProduceUpstreamBindings(state)
    : produceUpstreamBindingsForSubject(state, subject.artifact);
  const digests = new Set<Sha256Digest>();
  for (const binding of bindings) {
    const loaded = await loadProduceUpstreamSubject(dependencies, authority, state, binding);
    if (!loaded.ok) throw new TypeError("current upstream produced authority invalid");
    if ("imported_projection" in loaded.value) {
      if (state.phase_instance !== "design" && !authenticated.some((item) =>
        item.request.kind === "migration-audit" && item.decision.envelope.payload.decision === "accept-import-audit")) {
        throw new TypeError("imported upstream lacks accepted migration audit");
      }
      digests.add(loaded.value.artifact_digest);
      continue;
    }
    const ownerKind = decodePhaseInstance(loaded.value.artifact.phase_instance).kind;
    const approval = [...authenticated]
      .filter((item) => {
        if (item.approval.subject_digest !== loaded.value.artifact_digest) return false;
        if (!authenticatedApprovalIsEligibleAfterLatestRestart(
          state, item, loaded.value.artifact.phase_instance,
        )) return false;
        return (item.approval.gate_kind === "design-approval" &&
            item.request.kind === "design-approval" &&
            item.request.context.artifact_kind === ownerKind) ||
          (item.approval.gate_kind === "artifact-approval" &&
            item.request.kind === "artifact-approval" &&
            item.request.context.artifact_kind === ownerKind);
      })
      .sort((left, right) => right.approval.resolved_at_revision - left.approval.resolved_at_revision)[0];
    if (!settlementPolicyLoaded && approval === undefined) {
      settlementPolicyLoaded = true;
      if (state.policy_base_commit !== undefined && state.constitution_digest !== undefined) {
        const resolvedConstitution = await resolvePinnedConstitution(
          dependencies.runner, state.policy_base_commit, authority.context,
        );
        settlementPolicy = resolvedConstitution.ok
          ? authenticateRuleAcceptancePolicy(state, resolvedConstitution.value)
          : undefined;
      }
    }
    const settled = settlementPolicy === undefined ? undefined : acceptedNoWaitSettlementWithoutOrdinaryApproval(
      settlementPolicy,
      state,
      loaded.value.artifact_digest,
      loaded.value.artifact.phase_instance,
      authenticated,
    );
    if (approval === undefined && settled === undefined) {
      throw new TypeError("current upstream produced authority lacks approval or accepted settlement");
    }
    digests.add(loaded.value.artifact_digest);
  }
  return Object.freeze([...digests].sort());
}

export async function resolveStatusEvidenceAssessment(
  loadApprovedUpstreams: () => Promise<readonly Sha256Digest[]>,
  assess: (approvedUpstreamDigests: readonly Sha256Digest[]) => EvidenceAssessment,
): Promise<Readonly<{
  assessment?: EvidenceAssessment;
  blocking_reason?: "approved-upstream-authority-unavailable" | "fixed-point-disagreement";
}>> {
  let approvedUpstreamDigests: readonly Sha256Digest[];
  try {
    approvedUpstreamDigests = await loadApprovedUpstreams();
  } catch {
    return Object.freeze({ blocking_reason: "approved-upstream-authority-unavailable" });
  }
  try {
    return Object.freeze({ assessment: assess(approvedUpstreamDigests) });
  } catch {
    return Object.freeze({ blocking_reason: "fixed-point-disagreement" });
  }
}

/**
 * Every unresolved constitution-review gate, derived mechanically from retained adjudication
 * evidence: the gates the selector demands that are neither approved for the current evidence set
 * nor fully covered by in-force waivers, in selector order. Shared by status and build-request so
 * the composed gate request and the fixed point can never disagree about which gate is pending.
 *
 * Only one gate can be open at a time, so the caller acts on the first. The rest are reported so a
 * human learns up front how many decisions one review costs, rather than discovering the next gate
 * only after answering the previous one. This is disclosure only: each gate is still opened and
 * decided separately.
 */
export function pendingAdjudicationGates(
  state: TaskStateV1,
  constitution: ResolvedConstitution,
  retained: RetainedEvidenceSet,
  authenticated: readonly AuthenticatedGateApproval[],
): readonly ReturnType<typeof selectAdjudicationGates>[number][] {
  const source = retained.get("adjudicate")?.manifest.source_artifact;
  if (source?.artifact_kind !== "adjudication-evidence") return [];
  const pending: ReturnType<typeof selectAdjudicationGates>[number][] = [];
  let currentSet: CurrentEvidenceSetRef | undefined;
  try { currentSet = deriveCurrentEvidenceSet(retained).current_evidence_set; } catch { /* degraded below */ }
  for (const gate of selectAdjudicationGates(constitution.rules, source.evidence)) {
    const contextDigest = computeGateContextDigest(gate.kind, gate.context);
    const exactGateApproved = currentSet !== undefined && authenticated.some((item) =>
      item.approval.gate_kind === gate.kind &&
      item.approval.subject_digest === gate.subject_digest &&
      item.request.phase_instance === state.phase_instance &&
      item.request.context_digest === contextDigest &&
      item.request.kind !== "baseline-adoption" && // narrowed: a drift observation is not an evidence set
      item.request.current_evidence.set_digest === currentSet.set_digest &&
      source.evidence.source_review_envelope_digest === retainedReviewEnvelopeDigest(retained));
    const designPhase = state.phase_instance === "design" || state.phase_instance.startsWith("phase-design-");
    const ordinaryKind = state.phase_instance === "prd"
      ? "artifact-approval"
      : designPhase
        ? "design-approval"
        : state.phase_instance.startsWith("phase-impl-")
          ? "commit-authorization"
          : undefined;
    const ordinaryApproval = gate.kind === "constitution-review" && currentSet !== undefined &&
      ordinaryKind !== undefined && authenticated.some((item) => {
        const decision = item.decision.envelope.payload.decision;
        return item.approval.gate_kind === ordinaryKind &&
          item.approval.subject_digest === gate.subject_digest &&
          item.request.kind === ordinaryKind &&
          item.request.phase_instance === state.phase_instance &&
          item.request.subject_digest === gate.subject_digest &&
          item.request.current_evidence.set_digest === currentSet!.set_digest &&
          source.evidence.source_review_envelope_digest === retainedReviewEnvelopeDigest(retained) &&
          (decision === "approve" || decision === "authorize-commit");
      });
    const approved = exactGateApproved || ordinaryApproval;
    let waived = false;
    if (gate.kind === "constitution-review" && "eligible_waivers" in gate.context) {
      const eligible = gate.context.eligible_waivers;
      waived = eligible.length > 0 && eligible.every((item) =>
        waiverInForce(state, item.rule, gate.subject_digest, item.scope) !== undefined);
    }
    if (!approved && !waived) pending.push(gate);
  }
  return Object.freeze(pending);
}

/** The next unresolved constitution-review gate: the one the caller may act on now. */
export function pendingAdjudicationGate(
  state: TaskStateV1,
  constitution: ResolvedConstitution,
  retained: RetainedEvidenceSet,
  authenticated: readonly AuthenticatedGateApproval[],
): ReturnType<typeof selectAdjudicationGates>[number] | undefined {
  return pendingAdjudicationGates(state, constitution, retained, authenticated)[0];
}

function compareCodeUnits(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function sizeChange(before: number, after: number): string {
  const delta = after - before;
  return `${before} → ${after} bytes (${delta >= 0 ? "+" : ""}${delta} bytes)`;
}

/**
 * Reconstructs the complete disposable explanation of a frozen content-rule match.
 *
 * The settlement and retained implementation output are the entire authority surface: callers
 * cannot pass live config, Git state, or filesystem observations. Persisted match order is kept,
 * while all endpoints for one path are rendered in the contract's deterministic source/current
 * order. A missing endpoint is an authority disagreement, not a skippable presentation detail.
 */
export function contentTriggerDetails(
  settlement: RuleSettlementV1 | undefined,
  output: ImplementationOutputV1,
): readonly string[] | undefined {
  const conclusion = settlement?.conclusion;
  if (conclusion === undefined || conclusion.wait === false || conclusion.match.kind !== "content") {
    return undefined;
  }

  const details: string[] = [];
  const appendDetails = (
    outputs: ImplementationOutputV1["outputs"],
    matchedPaths: readonly string[],
    repository?: string,
  ): void => {
    const displayPath = (path: string) => repository === undefined ? path : `${repository}/${path}`;
    for (const matchedPath of matchedPaths) {
      const renameSources = outputs
        .filter((entry): entry is Extract<ImplementationOutputV1["outputs"][number], { operation: "rename" }> =>
          entry.operation === "rename" && entry.previous_path === matchedPath)
        .sort((left, right) => compareCodeUnits(left.path, right.path));
      const currentPaths = outputs
        .filter((entry) => entry.path === matchedPath)
        .sort((left, right) => compareCodeUnits(left.path, right.path));

      if (renameSources.length + currentPaths.length === 0) {
        throw new TypeError(`content-trigger path has no retained implementation endpoint: ${displayPath(matchedPath)}`);
      }

      for (const entry of renameSources) {
        details.push(
          `${displayPath(matchedPath)}: renamed to ${displayPath(entry.path)} (${sizeChange(entry.before.size_bytes, entry.after.size_bytes)})`,
        );
      }
      for (const entry of currentPaths) {
        if (entry.operation === "add") {
          details.push(`${displayPath(matchedPath)}: added (${sizeChange(0, entry.after.size_bytes)})`);
        } else if (entry.operation === "delete") {
          details.push(`${displayPath(matchedPath)}: deleted (${sizeChange(entry.before.size_bytes, 0)})`);
        } else if (entry.operation === "modify") {
          details.push(`${displayPath(matchedPath)}: modified (${sizeChange(entry.before.size_bytes, entry.after.size_bytes)})`);
        } else {
          details.push(
            `${displayPath(matchedPath)}: renamed from ${displayPath(entry.previous_path)} (${sizeChange(entry.before.size_bytes, entry.after.size_bytes)})`,
          );
        }
      }
    }
  };

  appendDetails(output.outputs, conclusion.match.paths);
  for (const matchedSection of conclusion.match.secondary_paths ?? []) {
    const outputSection = output.secondary_repositories?.find(
      (section) => section.repository === matchedSection.repository,
    );
    if (outputSection === undefined) {
      throw new TypeError(`content-trigger repository has no retained implementation section: ${matchedSection.repository}`);
    }
    appendDetails(outputSection.outputs, matchedSection.paths, matchedSection.repository);
  }
  return Object.freeze(details);
}

function gateStatus(active: ActiveGateV1, details?: HumanGatePresentationDetails): OpenGateStatus {
  return Object.freeze({
    gate_id: active.gate_id,
    kind: active.kind,
    decision_path: `.archflow/runtime/tasks/${active.task_id}/cache/gates/gate.decision`,
    archive_decision_path: `.archflow/tasks/${active.task_id}/authority/decisions/${active.gate_id}/decision.json`,
    request_path: `.archflow/tasks/${active.task_id}/authority/decisions/${active.gate_id}/request.json`,
    decision_templates: buildGateDecisionTemplates(active),
    presentation: buildHumanGatePresentation(active, details),
  });
}

async function currentTargetRefForRunner(runner: RootBoundGitRunner): Promise<Readonly<{
  value: string;
  guidance: string;
}>> {
  try {
    const branch = await runner.runText({
      argv: ["symbolic-ref", "--quiet", "HEAD"],
      operation: "status-target-ref" as SafeCode,
      expectedAbsence: [{ code: 1, stderrIncludes: "" }],
    });
    if (branch !== "") return Object.freeze({
      value: branch,
      guidance: "Current symbolic branch ref observed from repository authority.",
    });
  } catch { /* detached or unavailable: HEAD remains an explicit, valid target description */ }
  return Object.freeze({
    value: "HEAD",
    guidance: "Repository HEAD is detached or its symbolic branch ref is unavailable; confirm this target before authorizing commit.",
  });
}

export async function currentTargetRef(dependencies: GateLifecycleDependencies): Promise<Readonly<{
  value: string;
  guidance: string;
}>> {
  return currentTargetRefForRunner(dependencies.runner);
}

function implementationCommitMessage(output: ImplementationOutputV1): string {
  const phase = decodePhaseInstance(output.phase_instance);
  return `ArchFlow: Implement ${output.task_id} phase ${phase.kind === "phase-impl" ? String(phase.phase) : output.phase_instance}`;
}

export async function buildSecondaryCommitAuthorizationFacts(
  output: ImplementationOutputV1,
  repositories: RepositorySet,
): Promise<readonly SecondaryCommitAuthorizationV1[]> {
  const members = new Map(repositories.members.map((member) => [member.name, member]));
  const facts: SecondaryCommitAuthorizationV1[] = [];
  for (const section of output.secondary_repositories ?? []) {
    if (section.outputs.length === 0) continue;
    const member = members.get(section.repository);
    if (member === undefined || member.mode !== "writable" || member.identity.digest !== section.repository_identity_digest) {
      throw new SecondaryCommitObservationError(section.repository, "repository-observation-failed");
    }
    let target: Awaited<ReturnType<typeof currentTargetRefForRunner>>;
    let targetHead: GitOid;
    try {
      target = await currentTargetRefForRunner(member.binding.runner);
      targetHead = await resolveCommit(member.binding.runner, target.value);
    } catch (error) {
      if (error instanceof SecondaryCommitObservationError) throw error;
      throw new SecondaryCommitObservationError(section.repository, "repository-observation-failed");
    }
    if (targetHead !== section.base_commit) throw new SecondaryCommitObservationError(section.repository, "target-moved");
    facts.push(Object.freeze({
      repository: section.repository,
      repository_identity_digest: section.repository_identity_digest,
      target_ref: target.value,
      target_head: targetHead,
      baseline_commit: section.base_commit,
      commit_message: implementationCommitMessage(output),
      paths: sortedUniqueImplementationPaths(section),
      diff_digest: section.diff_digest,
      snapshot_digest: section.snapshot_digest,
    }));
  }
  return Object.freeze(facts);
}

/** A drift finding names a repository that is no longer a live writable member. */
export class BaselineRepositoryUnavailableError extends TypeError {
  constructor(readonly repository: string) {
    super(`baseline repository ${repository} is unavailable`);
  }
}

export class SecondaryCommitObservationError extends TypeError {
  constructor(
    readonly repository: string,
    readonly reason: "target-moved" | "repository-observation-failed",
  ) {
    super(`secondary commit repository ${repository} ${reason === "target-moved" ? "moved from its reviewed base" : "is unavailable"}`);
  }
}

/** Materializes the checked commit-gate resume facts from authenticated retained output. */
export function buildCommitAuthorizationInput(
  subject: CurrentProduceSubject,
  currentEvidence: CurrentEvidenceSetRef,
  target: Readonly<{ value: string; guidance: string }>,
  baselineCommit: string,
  secondaryCommits: readonly SecondaryCommitAuthorizationV1[] = [],
): CommitAuthorizationInput {
  if (subject.artifact.artifact_kind !== "implementation-output") {
    throw new TypeError("commit authorization requires retained implementation output");
  }
  const manifest = subject.retained.manifest.value;
  if (manifest.artifact_digest !== subject.artifact_digest) {
    throw new TypeError("commit authorization manifest subject disagrees");
  }
  const paths = new Set<string>();
  for (const output of subject.artifact.outputs) {
    paths.add(output.path);
    if (output.operation === "rename") paths.add(output.previous_path);
  }
  const phase = decodePhaseInstance(subject.artifact.phase_instance);
  return Object.freeze({
    kind: "commit-authorization",
    subject_digest: subject.artifact_digest,
    current_evidence: currentEvidence,
    context: Object.freeze({
      target_ref: target.value,
      baseline_commit: baselineCommit,
      commit_message: `ArchFlow: Implement ${subject.artifact.task_id} phase ${phase.kind === "phase-impl" ? String(phase.phase) : subject.artifact.phase_instance}`,
      paths: Object.freeze([...paths].sort()),
      diff_digest: subject.artifact.diff_digest,
      current_artifact_digests: Object.freeze([manifest.artifact_digest]),
      parent_document_digests: Object.freeze(subject.artifact.parent_documents
        .map((item) => item.content_digest).sort()),
      ...(secondaryCommits.length === 0 ? {} : { secondary_commits: Object.freeze([...secondaryCommits]) }),
    }),
    target_ref_guidance: target.guidance,
  });
}

/** Exact client commit facts for an authenticated implementation no-wait settlement. */
export function buildAutonomousImplementationCommitInput(
  output: ImplementationOutputV1,
  targetRef: string,
): Readonly<{ paths: readonly string[]; message: string; target_ref: string; baseline_commit: string }> {
  const paths = new Set<string>();
  for (const entry of output.outputs) {
    paths.add(entry.path);
    if (entry.operation === "rename") paths.add(entry.previous_path);
  }
  const phase = decodePhaseInstance(output.phase_instance);
  return Object.freeze({
    paths: Object.freeze([...paths].sort()),
    message: `ArchFlow: Implement ${output.task_id} phase ${phase.kind === "phase-impl" ? String(phase.phase) : output.phase_instance}`,
    target_ref: targetRef,
    baseline_commit: output.base_commit,
  });
}

/** Exact task-local milestone facts bound by an authenticated design no-wait settlement. */
export function buildAutonomousDesignCommitInput(
  state: TaskStateV1,
  settlement: RuleSettlementV1,
  targetRef: string,
): Readonly<{ path: string; message: string; target_ref: string; baseline_commit: string }> {
  const phase = decodePhaseInstance(state.phase_instance);
  if ((phase.kind !== "design" && phase.kind !== "phase-design") ||
      settlement.phase_instance !== state.phase_instance ||
      settlement.milestone_baseline_commit === undefined) {
    throw new TypeError("autonomous design commit requires a phase-bound milestone baseline");
  }
  const phaseLabel = phase.kind === "design" ? "design" : `phase ${String(phase.phase)} design`;
  return Object.freeze({
    path: `.archflow/tasks/${state.task_id}`,
    message: `ArchFlow: Approve ${state.task_id} ${phaseLabel}`,
    target_ref: targetRef,
    baseline_commit: settlement.milestone_baseline_commit,
  });
}

/** Builds the combined design/policy approval and the exact task-local commit it authorizes. */
export async function buildDesignApprovalInput(
  dependencies: GateLifecycleDependencies,
  state: TaskStateV1,
  retained: RetainedEvidenceSet,
  target: Readonly<{ value: string; guidance: string }>,
): Promise<DesignApprovalInput> {
  const phase = decodePhaseInstance(state.phase_instance);
  if (phase.kind !== "design" && phase.kind !== "phase-design") {
    throw new TypeError("design approval requires a design phase");
  }
  const retainedAdjudication = retained.get("adjudicate");
  const adjudicationArtifact = retainedAdjudication?.manifest.source_artifact;
  let adjudication: AdjudicationEvidence | undefined;
  if (retainedAdjudication !== undefined) {
    if (adjudicationArtifact?.artifact_kind !== "adjudication-evidence") {
      throw new TypeError("retained adjudication result has the wrong artifact kind");
    }
    adjudication = adjudicationArtifact.evidence;
  }
  const policy = adjudication === undefined
    ? Object.freeze({ constitution: "pass" as const, policy_findings: Object.freeze([]), eligible_waivers: Object.freeze([]) })
    : designApprovalPolicyContext(adjudication);
  const phaseLabel = phase.kind === "design" ? "design" : `phase ${String(phase.phase)} design`;
  return Object.freeze({
    kind: "design-approval",
    context: Object.freeze({
      artifact_kind: phase.kind,
      ...policy,
      target_ref: target.value,
      baseline_commit: await resolveCommit(dependencies.runner, "HEAD"),
      commit_message: `ArchFlow: Approve ${state.task_id} ${phaseLabel}`,
    }),
    target_ref_guidance: target.guidance,
  });
}

/** Computes reconciled normal-mode status without mutating any durable authority. */
async function computeTaskStatusDetailedInternal(
  dependencies: GateLifecycleDependencies,
  authority: TransactionAuthority,
): Promise<ProjectResult<DetailedTaskStatusV1>> {
  const blockers: string[] = [];
  let stateRead: Awaited<ReturnType<typeof readTaskState>>;
  try {
    assertInternalTransactionAuthority(authority, dependencies);
    stateRead = await readTaskState(authority.state);
  } catch {
    const next = deriveNextAction({ repository_initialized: true });
    const status = Object.freeze({
      task_id: authority.task_id,
      state: "missing" as const,
      config: unavailableConfig("status-authority-invalid"),
      blocking_reasons: Object.freeze(["status-authority-invalid"]),
      next_action: next,
    });
    return ok(Object.freeze({ status, retained: new Map() }));
  }

  if (stateRead.kind !== "canonical") {
    const reason = stateRead.kind === "missing" ? "state-missing" : `state-${stateRead.kind}`;
    let liveConfigDigest: Sha256Digest | undefined;
    try {
      const read = await dependencies.read_config(authority.config);
      if (read.kind === "valid") liveConfigDigest = read.snapshot.digest;
      else if (read.kind === "invalid") liveConfigDigest = read.digest;
    } catch {
      // Missing-state status remains observable when config identity cannot be established; null
      // in the automation authority records that exact classification without a second read.
    }
    const next = deriveNextAction({ repository_initialized: true });
    const status = Object.freeze({
      task_id: authority.task_id,
      state: "missing" as const,
      config: unavailableConfig("state-unavailable"),
      blocking_reasons: Object.freeze([reason]),
      next_action: next,
    });
    return ok(Object.freeze({
      status,
      ...(liveConfigDigest === undefined ? {} : { live_config_digest: liveConfigDigest }),
      retained: new Map(),
    }));
  }
  const stateDocument = stateRead.document;
  const state = stateDocument.value;

  let config: ConfigVerification;
  let parsedConfig: ConfigV1 | undefined;
  let repositories: TaskStatusV1["repositories"];
  let repositorySet: RepositorySet | undefined;
  let liveConfigDigest: Sha256Digest | undefined;
  try {
    const read = await dependencies.read_config(authority.config);
    if (read.kind !== "valid") {
      config = unavailableConfig(
        `config-${read.kind}`,
        read.kind === "invalid" ? read.issues : undefined,
      );
      blockers.push(`config-${read.kind}`);
      if (read.kind === "invalid") liveConfigDigest = read.digest;
    } else {
      liveConfigDigest = read.snapshot.digest;
      const resolved = await resolveRepositorySet(
        { runner: dependencies.runner, environment: dependencies.environment },
        read.snapshot.parsed,
        authority.context,
      );
      const continuity = resolved.ok
        ? validateRepositorySetContinuity(state, resolved.value)
        : resolved;
      if (!continuity.ok) {
        const issues = continuity.error.code === "CONFIG_INVALID"
          ? continuity.error.diagnostic.parameters.issues
          : undefined;
        config = unavailableConfig("config-invalid", issues);
        blockers.push("config-invalid");
      } else if (!resolved.ok) {
        throw new TypeError("repository-set continuity unexpectedly succeeded after resolution failed");
      } else {
        config = Object.freeze({ verified: true });
        parsedConfig = read.snapshot.parsed as unknown as ConfigV1;
        repositorySet = resolved.value;
        repositories = Object.freeze(resolved.value.members.map((member) => Object.freeze({
          name: member.name,
          mode: member.mode,
          location: member.binding.runner.location.worktreeRoot,
          head: member.head,
        })));
      }
    }
  } catch {
    config = unavailableConfig("config-unresolvable");
    blockers.push("config-unresolvable");
  }

  let routes: TaskStatusV1["routes"];
  if (parsedConfig !== undefined) {
    try {
      const decodedPhase = decodePhaseInstance(state.phase_instance);
      const phaseKind = decodedPhase.kind;
      const counterReviewer = resolveDispatchRoute(parsedConfig, phaseKind, "counter-reviewer");
      const testReviewer = configuredRoute(parsedConfig, phaseKind, "test-reviewer") === undefined
        ? undefined
        : resolveDispatchRoute(parsedConfig, phaseKind, "test-reviewer");
      const effortReviewer = configuredRoute(parsedConfig, phaseKind, "effort-reviewer") === undefined
        ? undefined
        : resolveDispatchRoute(parsedConfig, phaseKind, "effort-reviewer");
      const adjudicator = resolveDispatchRoute(parsedConfig, phaseKind, "adjudicator");
      routes = Object.freeze({
        counter_reviewer: counterReviewer,
        ...(testReviewer === undefined ? {} : { test_reviewer: testReviewer }),
        ...(effortReviewer === undefined ? {} : { effort_reviewer: effortReviewer }),
        adjudicator,
      });
    } catch {
      blockers.push("dispatch-routes-invalid");
    }
  }

  // The change notice: diffed only when a recorded baseline exists. A pre-cutover task (no
  // `last_seen_config`) records nothing and notices nothing until its next config-observing commit.
  let configChange: readonly ConfigChangeEntry[] | undefined;
  if (parsedConfig !== undefined && state.last_seen_config !== undefined) {
    const entries = computeConfigChange(state.last_seen_config, parsedConfig as TaskConfigSnapshot);
    if (entries.length > 0) configChange = entries;
  }

  let constitution: ResolvedConstitution | undefined;
  let constitutionStatus: TaskStatusV1["constitution"];
  try {
    const resolved = await resolvePinnedConstitution(dependencies.runner, state.policy_base_commit, authority.context);
    if (resolved.ok) {
      constitution = resolved.value;
      constitutionStatus = Object.freeze({
        digest: resolved.value.digest,
        active_rules: Object.freeze([...resolved.value.rules.values()]
          .filter((rule) => rule.status === "active")
          .sort((left, right) => left.id.localeCompare(right.id))
          .map((rule) => Object.freeze({
            id: rule.id,
            version: rule.version,
            text: rule.text,
            ...(rule.review_trigger === undefined ? {} : { review_trigger: rule.review_trigger }),
            ...(rule.enforced_by === undefined ? {} : { enforced_by: Object.freeze([...rule.enforced_by]) }),
          }))),
      });
      if (resolved.value.digest !== state.constitution_digest) blockers.push("constitution-pin-disagreement");
    } else {
      blockers.push("constitution-unresolvable");
    }
  } catch {
    blockers.push("constitution-unresolvable");
  }

  let reconciliation: ReconciliationResult | undefined;
  let reconciliationBlockers: readonly string[] = Object.freeze([]);
  try {
    const discovered = await discoverReconciliationInput(dependencies, authority, stateDocument, repositorySet);
    if (discovered.ok) {
      reconciliation = reconcileCurrentAuthority(discovered.value);
      reconciliationBlockers = discovered.value.blocking_reasons ?? Object.freeze([]);
      blockers.push(...reconciliationBlockers);
      // Finding kinds join `blockers` only after the fixed-point assessment below exists, so
      // expected produce-window edits can be recognized before they are treated as blocking drift.
    } else {
      blockers.push("reconciliation-unavailable");
    }
  } catch {
    blockers.push("reconciliation-unavailable");
  }

  let retained: RetainedEvidenceSet = new Map();
  if (dependencies.load_retained_manifest === undefined) {
    blockers.push("retained-evidence-unavailable");
  } else {
    try {
      const loaded = await loadRetainedEvidence(
        { load_retained_manifest: dependencies.load_retained_manifest }, state, state.phase_instance,
      );
      if (loaded.ok) retained = loaded.value;
      else blockers.push("retained-evidence-unavailable");
    } catch {
      blockers.push("retained-evidence-unavailable");
    }
  }

  const retainedCounterReview = retained.get("counter_review")?.manifest.source_artifact;
  const reviewedRepositories = currentReviewedRepositoryPins(
    retainedCounterReview?.artifact_kind === "review-evidence" ? retainedCounterReview.evidence : undefined,
    state.task_id,
    state.phase_instance,
  );
  repositories = projectReviewedRepositoryStatus(repositories, reviewedRepositories);

  let subjectDigest: Sha256Digest | undefined;
  let produceSubject: CurrentProduceSubject | undefined;
  // Mid-produce (running or failed) the artifact is being rewritten: the retained produce
  // result is no longer the review subject, so `subject_digest` and the evidence assessment
  // stay unset exactly as before, but the predecessor result is still loaded when it exists —
  // its projection paths are what classifies the in-progress rewrite as an expected re-entry
  // edit rather than blocking drift.
  const midProduce = state.step === "produce" && state.status !== "succeeded";
  const hasRetainedProduce = state.authoritative_results.some((reference) =>
    reference.phase_instance === state.phase_instance && reference.step === "produce");
  if (!midProduce || hasRetainedProduce) {
    try {
      const produced = await loadCurrentProduceSubject(dependencies, state);
      if (produced.ok) {
        produceSubject = produced.value;
        if (!midProduce) subjectDigest = produced.value.artifact_digest;
      }
      else if (!midProduce) blockers.push("current-subject-unavailable");
    } catch {
      if (!midProduce) blockers.push("current-subject-unavailable");
    }
  }

  const authenticatedApprovals: AuthenticatedGateApproval[] = [];
  const approvalFacts: Array<Readonly<{
    gate_kind: TaskStateV1["approvals"][number]["gate_kind"];
    subject_digest: Sha256Digest;
  }>> = [];
  const approvalIssues: ApprovalIssue[] = [];
  for (const approval of state.approvals) {
    try {
      const loaded = await loadAuthenticatedGateApproval(dependencies, authority, approval);
      if (loaded.ok) {
        if (!authenticatedApprovalIsEligibleAfterLatestRestart(state, loaded.value)) continue;
        authenticatedApprovals.push(loaded.value);
        approvalFacts.push(Object.freeze({ gate_kind: approval.gate_kind, subject_digest: approval.subject_digest }));
      } else {
        blockers.push("approval-authority-unavailable");
        approvalIssues.push(Object.freeze({
          gate_id: approval.gate_id,
          gate_kind: approval.gate_kind,
          error: loaded.error,
        }));
      }
    } catch (error) {
      blockers.push("approval-authority-unavailable");
      approvalIssues.push(Object.freeze({
        gate_id: approval.gate_id,
        gate_kind: approval.gate_kind,
        error: Object.freeze({
          code: "APPROVAL_LOAD_EXCEPTION" as const,
          message: error instanceof Error && error.message !== ""
            ? error.message.slice(0, 256)
            : "Unexpected failure while loading approval authority.",
        }),
      }));
    }
  }

  const settlementPolicy = constitution === undefined
    ? undefined
    : authenticateRuleAcceptancePolicy(state, constitution);
  const acceptedSettlement = settlementPolicy === undefined || produceSubject === undefined
    ? undefined
    : acceptedNoWaitSettlementWithoutOrdinaryApproval(
      settlementPolicy,
      state,
      produceSubject.artifact_digest,
      produceSubject.artifact.phase_instance,
      authenticatedApprovals,
    );

  let commitObserved = false;
  let commitBlockedReason: DesignMilestoneMiss | undefined;
  let milestoneRecoveryRequired = false;
  let milestoneRecoveryNoDelta = false;
  let governingDocumentRecoveryRequired = false;
  let milestoneProofUnverifiableReason: string | undefined;
  let milestoneRecoveryFacts: TaskStatusV1["milestone_recovery"];
  const recordMissingMilestone = (proof: Readonly<{ target_ref: string; target_head: GitOid }>) => {
    if (subjectDigest === undefined) throw new TypeError("milestone recovery requires the current subject");
    milestoneRecoveryRequired = true;
    milestoneRecoveryFacts = Object.freeze({
      cause: "milestone-proof-missing",
      target_ref: proof.target_ref,
      target_head: proof.target_head,
      subject_digest: subjectDigest,
    });
  };
  let implementationCommit: ImplementationCommitAction | undefined;
  let humanImplementationCommitAuthority = false;
  /**
   * Folds one primary milestone proof, then the secondary repositories it fans out to, into the
   * commit facts above. Shared by the human-authorized and no-wait-settlement arms below; only the
   * authenticated secondary facts and the commit offered when nothing was created differ.
   */
  const settleImplementationProof = async (
    output: ImplementationOutputV1,
    proof: MilestoneProof,
    secondaryFacts: readonly (SecondaryCommitAuthorizationV1 | RepositoryCommitMilestoneV1)[],
    notCreatedCommit: ImplementationCommitAction | undefined,
  ): Promise<void> => {
    if (proof.kind === "proven") {
      const secondary = await observeSecondaryCommitProgress(output, secondaryFacts, repositorySet);
      if (secondary.kind === "proven") {
        commitObserved = true;
      } else if (secondary.kind === "not-created") {
        implementationCommit = secondary.action;
      } else {
        implementationCommit = undefined;
        milestoneProofUnverifiableReason = secondary.kind === "unverifiable"
          ? `${secondary.repository}-${secondary.reason}`
          : `${secondary.repository}-${secondary.proof.reason}`;
        blockers.push(`implementation-milestone-${milestoneProofUnverifiableReason}`);
      }
    } else if (proof.kind === "not-created") {
      implementationCommit = notCreatedCommit;
    } else if (proof.kind === "missing-from-history") {
      recordMissingMilestone(proof);
      implementationCommit = undefined;
      try {
        milestoneRecoveryNoDelta = await implementationRecoveryHasNoDelta(dependencies, output, proof.target_head);
      } catch {
        milestoneRecoveryRequired = false;
        milestoneRecoveryFacts = undefined;
        milestoneProofUnverifiableReason = "repository-observation-failed";
        blockers.push("commit-observation-unavailable");
      }
    } else {
      milestoneProofUnverifiableReason = proof.reason;
      blockers.push("commit-observation-unavailable");
    }
  };
  if (produceSubject?.artifact.artifact_kind === "implementation-output") {
    for (const authenticated of authenticatedApprovals) {
      if (
        authenticated.request.kind !== "commit-authorization" ||
        authenticated.request.phase_instance !== state.phase_instance ||
        authenticated.request.subject_digest !== produceSubject.artifact_digest ||
        authenticated.decision.envelope.payload.decision !== "authorize-commit"
      ) continue;
      // An approval archived before commit authorization bound an exact baseline, message and
      // path set cannot attest one now; it stays authentic authority, just not commit evidence.
      const exact = exactCommitAuthorizationContext(authenticated.request.context);
      if (exact === undefined) continue;
      humanImplementationCommitAuthority = true;
      implementationCommit = Object.freeze({
        paths: exact.paths,
        message: exact.commit_message,
        target_ref: exact.target_ref,
        baseline_commit: exact.baseline_commit,
      });
      try {
        const proof = await resolveImplementationMilestoneProof(
          dependencies.runner,
          produceSubject.artifact,
          exact,
        );
        await settleImplementationProof(produceSubject.artifact, proof, exact.secondary_commits ?? [], implementationCommit);
        if (proof.kind === "proven" || proof.kind === "not-created") break;
      } catch {
        blockers.push("commit-observation-unavailable");
      }
    }
    if (milestoneRecoveryRequired) implementationCommit = undefined;
    if (!commitObserved && !humanImplementationCommitAuthority && implementationCommit === undefined && acceptedSettlement !== undefined) {
      const legacyTarget = acceptedSettlement.milestone_target_ref === undefined;
      const target = legacyTarget
        ? await currentTargetRef(dependencies)
        : Object.freeze({ value: acceptedSettlement.milestone_target_ref, guidance: "Pinned autonomous milestone target." });
      const autonomousCommit = buildAutonomousImplementationCommitInput(
        produceSubject.artifact, target.value,
      );
      try {
        const observedProof = await resolveAutonomousImplementationMilestoneProof(
          dependencies.runner, produceSubject.artifact, target.value, autonomousCommit.message,
        );
        const proof = legacyTarget && observedProof.kind === "proven" && observedProof.commit !== observedProof.target_head
          ? Object.freeze({
              kind: "missing-from-history" as const,
              reason: "target-moved" as const,
              target_ref: observedProof.target_ref,
              target_head: observedProof.target_head,
            })
          : observedProof;
        commitObserved = false;
        await settleImplementationProof(produceSubject.artifact, proof, acceptedSettlement.secondary_milestones ?? [], autonomousCommit);
      } catch {
        blockers.push("commit-observation-unavailable");
      }
    }
  }
  let designCommit: Readonly<{ path: string; message: string; target_ref: string; baseline_commit: string }> | undefined;
  if (
    produceSubject?.artifact.artifact_kind === "document" &&
    (decodePhaseInstance(state.phase_instance).kind === "design" || decodePhaseInstance(state.phase_instance).kind === "phase-design")
  ) {
    const authenticated = authenticatedApprovals.find((item) =>
      item.request.kind === "design-approval" &&
      item.request.phase_instance === state.phase_instance &&
      item.request.subject_digest === produceSubject!.artifact_digest &&
      item.decision.envelope.payload.decision === "approve");
    if (authenticated?.request.kind === "design-approval") {
      designCommit = Object.freeze({
        path: `.archflow/tasks/${state.task_id}`,
        message: authenticated.request.context.commit_message,
        target_ref: authenticated.request.context.target_ref,
        baseline_commit: authenticated.request.context.baseline_commit,
      });
      try {
        const observation = await resolveDesignMilestoneProof(
          dependencies.runner,
          state.task_id,
          produceSubject.artifact,
          produceSubject.retained.manifest.value.outputs,
          authenticated.request.context,
        );
        commitObserved = observation.kind === "proven";
        if (observation.kind === "missing-from-history") {
          commitBlockedReason = observation.reason;
          recordMissingMilestone(observation);
          blockers.push(`design-milestone-${observation.reason}`);
        } else if (observation.kind === "unverifiable") {
          milestoneProofUnverifiableReason = observation.reason;
          blockers.push("commit-observation-unavailable");
        }
      } catch {
        blockers.push("commit-observation-unavailable");
      }
    }
    // Only consulted when the design-approval arm above did not already prove the milestone; a
    // migration audit for the same subject must not overwrite an observed commit with its own miss.
    const migration = commitObserved ? undefined : authenticatedApprovals.find((item) =>
      item.request.kind === "migration-audit" &&
      item.request.phase_instance === state.phase_instance &&
      item.request.subject_digest === produceSubject!.artifact_digest &&
      item.decision.envelope.payload.decision === "accept-import-audit");
    if (
      migration?.request.kind === "migration-audit" &&
      migration.request.context.target_ref !== undefined &&
      migration.request.context.baseline_commit !== undefined &&
      migration.request.context.commit_message !== undefined
    ) {
      designCommit = Object.freeze({
        path: `.archflow/tasks/${state.task_id}`,
        message: migration.request.context.commit_message,
        target_ref: migration.request.context.target_ref,
        baseline_commit: migration.request.context.baseline_commit,
      });
      try {
        const observation = await resolveDesignMilestoneProof(
          dependencies.runner,
          state.task_id,
          produceSubject.artifact,
          produceSubject.retained.manifest.value.outputs,
          {
            target_ref: migration.request.context.target_ref,
            baseline_commit: migration.request.context.baseline_commit,
            commit_message: migration.request.context.commit_message,
            ...(migration.request.context.imported_documents === undefined ? {} : {
              authorized_document_paths: migration.request.context.imported_documents.map((document) => document.path),
            }),
          },
        );
        commitObserved = observation.kind === "proven";
        if (observation.kind === "missing-from-history") {
          recordMissingMilestone(observation);
          commitBlockedReason = observation.reason;
          blockers.push(`design-milestone-${observation.reason}`);
        } else if (observation.kind === "unverifiable") {
          milestoneProofUnverifiableReason = observation.reason;
          blockers.push("commit-observation-unavailable");
        }
      } catch {
        blockers.push("commit-observation-unavailable");
      }
    }
    if (!commitObserved && designCommit === undefined &&
        acceptedSettlement?.milestone_baseline_commit !== undefined) {
      const legacyTarget = acceptedSettlement.milestone_target_ref === undefined;
      const target = legacyTarget
        ? await currentTargetRef(dependencies)
        : Object.freeze({ value: acceptedSettlement.milestone_target_ref, guidance: "Pinned autonomous milestone target." });
      designCommit = buildAutonomousDesignCommitInput(state, acceptedSettlement, target.value);
      try {
        const observedProof = await resolveAutonomousDesignMilestoneProof(
          dependencies.runner,
          state,
          produceSubject.artifact,
          produceSubject.retained.manifest.value.outputs,
          target.value,
          acceptedSettlement.milestone_baseline_commit,
          designCommit.message,
          authority.context,
        );
        const observation = legacyTarget && observedProof.kind === "proven" && observedProof.commit !== observedProof.target_head
          ? Object.freeze({
              kind: "missing-from-history" as const,
              reason: "target-moved" as const,
              target_ref: observedProof.target_ref,
              target_head: observedProof.target_head,
            })
          : observedProof;
        commitObserved = observation.kind === "proven";
        if (observation.kind === "missing-from-history") {
          const boundedRefresh = observation.reason !== "approved-document-mismatch" &&
            observation.target_head !== acceptedSettlement.milestone_baseline_commit;
          commitBlockedReason = boundedRefresh ? "target-moved" : observation.reason;
          if (!boundedRefresh) recordMissingMilestone(observation);
          blockers.push(`design-milestone-${observation.reason}`);
        } else if (observation.kind === "unverifiable") {
          milestoneProofUnverifiableReason = observation.reason;
          blockers.push("commit-observation-unavailable");
        }
      } catch {
        blockers.push("commit-observation-unavailable");
      }
    }
  }

  const declaredPredecessor = !midProduce && produceSubject?.artifact.artifact_kind === "document"
    ? produceSubject.artifact.editorial_predecessor
    : undefined;
  const reviewPredecessor = currentReviewPredecessor(state, produceSubject);
  let assessment: EvidenceAssessment | undefined;
  if (constitution !== undefined && subjectDigest !== undefined) {
    const resolvedAssessment = await resolveStatusEvidenceAssessment(
      () => currentApprovedUpstreams(dependencies, authority, state, authenticatedApprovals, produceSubject),
      (approvedUpstreamDigests) => assessCurrentEvidence(state, retained, {
        subject_digest: subjectDigest,
        input_fingerprint: state.input_fingerprint,
        constitution,
        ...(reviewPredecessor === undefined ? {} : { review_predecessor: reviewPredecessor }),
        approved_upstream_digests: approvedUpstreamDigests,
        authenticated_gate_approvals: authenticatedApprovals,
        ...(parsedConfig?.max_attempts === undefined ? {} : { max_attempts: parsedConfig.max_attempts }),
      }),
    );
    assessment = resolvedAssessment.assessment;
    if (resolvedAssessment.blocking_reason !== undefined) blockers.push(resolvedAssessment.blocking_reason);
  }

  let editorialRevision: TaskStatusV1["editorial_revision"];
  if (declaredPredecessor !== undefined) {
    const triageSource = retained.get("triage")?.manifest.source_artifact;
    const dispositions = triageSource?.artifact_kind === "triage"
      ? triageSource.evidence.dispositions
          .filter((item) => item.disposition === "accepted-editorial")
          .map((item) => Object.freeze({
            finding_id: item.finding_id,
            rationale: item.rationale,
            revision_intent: item.revision_intent,
          }))
      : [];
    editorialRevision = Object.freeze({
      predecessor_subject_digest: declaredPredecessor.subject_digest,
      dispositions: Object.freeze(dispositions),
    });
  }

  // Documents a still-pending review must re-read from the worktree that no longer hold the
  // bytes durable authority recorded for them.
  //
  // Only a review dispatch reads these; every other consumer of a produce result works from its
  // manifest. So the check runs exactly when the fixed point still owes a review, and drift that
  // appears after the review is already current stays the human baseline decision's business —
  // which is what that decision was built for.
  //
  // Reconciliation cannot answer this question. It asks "which bytes are authoritative for this
  // path", and a human baseline adoption re-answers it — silencing the drift finding while the
  // recorded result the review is dispatched over stays pinned to the bytes it recorded. Left
  // unsaid, that combination offers a review that refuses to run, forever.
  const produceSubjectDrift: string[] = [];
  const upstreamDocumentDrift: string[] = [];
  if (!midProduce && produceSubject !== undefined && assessment?.next === "counter_review") {
    // Reported repository-relative: these reach a human who is about to look for the file.
    const repositoryPath = (claim: string) => `.archflow/tasks/${state.task_id}/${claim}`;
    try {
      for (const pin of produceProjectionPins(produceSubject.artifact)) {
        const projection = await readProduceProjection(
          dependencies.runner, authority, produceSubject, pin.path,
        );
        if (!projection.ok) produceSubjectDrift.push(repositoryPath(pin.path));
      }
      const coProduced = produceOwnedTaskDocumentPaths(produceSubject.artifact);
      for (const binding of produceUpstreamBindingsForSubject(state, produceSubject.artifact)) {
        const upstream = await loadProduceUpstreamSubject(dependencies, authority, state, binding);
        if (!upstream.ok) continue;
        const projections = await readProduceProjectionSet(
          dependencies.runner, authority, upstream.value, binding.path, coProduced,
        );
        if (!projections.ok) upstreamDocumentDrift.push(repositoryPath(binding.path));
      }
    } catch {
      blockers.push("review-projection-unavailable");
    }
  }

  // Agent-resolvable constitution findings travel with the produce re-entry, named by rule and
  // by the document drifted from, so the revise offer says what to fix rather than just "revise".
  let policyFindings: PolicyReentryFindings | undefined;
  if (assessment?.policy_reentry_required === true) {
    const source = retained.get("adjudicate")?.manifest.source_artifact;
    if (source?.artifact_kind === "adjudication-evidence") {
      const upstreamPaths = new Map<Sha256Digest, string>();
      if (produceSubject !== undefined) {
        try {
          for (const binding of produceUpstreamBindingsForSubject(state, produceSubject.artifact)) {
            const upstream = await loadProduceUpstreamSubject(dependencies, authority, state, binding);
            if (upstream.ok) {
              upstreamPaths.set(upstream.value.artifact_digest, `.archflow/tasks/${state.task_id}/${binding.path}`);
            }
          }
        } catch { /* unmapped drift below still names the finding */ }
      }
      policyFindings = Object.freeze({
        rules: Object.freeze(source.evidence.rule_findings
          .filter((finding) => finding.compliance !== "pass")
          .map((finding) => Object.freeze({
            rule_id: finding.rule_id,
            rule_version: finding.rule_version,
            compliance: finding.compliance as "fail" | "uncertain",
            rationale: finding.rationale,
          }))),
        drift: Object.freeze(source.evidence.drift_findings
          .filter((finding) => finding.drift === "material")
          .map((finding) => Object.freeze({
            path: upstreamPaths.get(finding.upstream_digest) ?? "an approved upstream document",
            affected_claim_ids: Object.freeze([...finding.affected_claim_ids]),
            rationale: finding.rationale,
          }))),
      });
    }
  }

  let statusReconciliation: StatusReconciliation | undefined;
  if (reconciliation !== undefined) {
    const partitioned = partitionExpectedReentryEdits(
      reconciliation.findings, assessment, produceSubject, state,
    );
    blockers.push(...partitioned.remaining.map((finding) => finding.kind));
    statusReconciliation = Object.freeze({
      ...reconciliation,
      // Mirrors reconcileCurrentAuthority's classification derivation over the filtered set.
      classification: partitioned.remaining.length === 0
        ? "consistent" as const
        : "reconciliation-required" as const,
      findings: partitioned.remaining,
      ...(partitioned.expected_reentry_edits.length === 0
        ? {}
        : { expected_reentry_edits: partitioned.expected_reentry_edits }),
    });

    const taskRoot = `.archflow/tasks/${state.task_id}/`;
    const governingPaths = partitioned.remaining
      .filter((finding): finding is Extract<ReconciliationFinding, { kind: "projection-mismatch" }> =>
        finding.kind === "projection-mismatch")
      .map((finding) => finding.path)
      .filter((path) => path === `${taskRoot}prd.md` || path === `${taskRoot}design.md` ||
        (path.startsWith(`${taskRoot}phases/`) && path.endsWith("/design.md")));
    if (governingPaths.length !== 0 && !midProduce && state.open_gate === undefined) {
      const decodedPhase = decodePhaseInstance(state.phase_instance);
      const phaseKind = decodedPhase.kind;
      const ownedPath = phaseKind === "prd"
        ? `${taskRoot}prd.md`
        : phaseKind === "design"
          ? `${taskRoot}design.md`
          : phaseKind === "phase-design"
            ? `${taskRoot}phases/${decodedPhase.phase}/design.md`
            : undefined;
      const ownedGoverningPaths = ownedPath === undefined
        ? []
        : governingPaths.filter((path) => path === ownedPath);
      const recoverableOwnedGoverningPaths = ownedGoverningPaths.filter((path) =>
        !produceSubjectDrift.includes(path));
      const dependentGoverningPaths = governingPaths.filter((path) => path !== ownedPath);
      const governingRecoverySubjectDigest = subjectDigest ?? retained.get("produce")?.manifest.artifact_digest;

      // Only bytes a later position would consume are upstream governing drift. Once the current
      // planning position has a produced subject, changing its own governing document requires a
      // fresh significant production/review boundary: adopting those bytes as a baseline would
      // let the existing review evidence describe bytes it never reviewed.
      upstreamDocumentDrift.push(...dependentGoverningPaths.filter((path) => !upstreamDocumentDrift.includes(path)));
      if (
        recoverableOwnedGoverningPaths.length !== 0 &&
        (phaseKind === "prd" || phaseKind === "design" || phaseKind === "phase-design") &&
        governingRecoverySubjectDigest !== undefined
      ) {
        try {
          const target = await currentTargetRef(dependencies);
          governingDocumentRecoveryRequired = true;
          milestoneRecoveryRequired = true;
          milestoneRecoveryFacts = Object.freeze({
            cause: "governing-document-drift",
            target_ref: target.value,
            target_head: await resolveCommit(dependencies.runner, target.value),
            subject_digest: governingRecoverySubjectDigest,
          });
        } catch {
          blockers.push("commit-observation-unavailable");
        }
      }
    }
  }

  let evidence: StatusEvidence;
  try {
    const derived = deriveCurrentEvidenceSet(retained);
    if (assessment === undefined) throw new TypeError("evidence assessment unavailable");
    // Recorded dispositions, keyed by the review bytes they answered. A stale triage keys on a
    // superseded evidence digest and therefore joins to nothing.
    const recordedTriage = retained.get("triage")?.manifest.source_artifact;
    const dispositions = new Map<string, Readonly<{ disposition: string; rationale: string }>>();
    if (recordedTriage?.artifact_kind === "triage") {
      for (const item of recordedTriage.evidence.dispositions) {
        dispositions.set(`${item.review_evidence_digest}:${item.finding_id}`, Object.freeze({
          disposition: item.disposition as string,
          rationale: item.rationale,
        }));
      }
    }
    const findings = derived.reviews.flatMap((review) => review.evidence.findings.map((finding) => {
      const recorded = dispositions.get(`${review.evidence_digest}:${finding.finding_id}`);
      return Object.freeze({
        review_evidence_digest: review.evidence_digest,
        finding_id: finding.finding_id,
        blocking: finding.blocking,
        severity: finding.severity,
        summary: finding.summary,
        ...(recorded === undefined ? {} : { disposition: recorded.disposition, rationale: recorded.rationale }),
      });
    }));
    const counter = derived.reviews[0]!.evidence;
    evidence = Object.freeze({
      available: true,
      subject_digest: derived.subject_digest,
      current_evidence: derived.current_evidence_set,
      findings: Object.freeze(findings),
      counter_review_provenance: Object.freeze({
        assurance: counter.assurance,
        producer_family: counter.producer_family,
        model_family: counter.model_family,
        model: counter.model,
        effort: counter.effort,
        ...(counter.assurance === "server-attested" ? { adapter: counter.adapter } : {}),
        ...(counter.assurance === "server-attested" && counter.provider !== undefined
          ? { provider: counter.provider }
          : {}),
        ...(counter.assurance === "server-attested" && counter.route_source !== undefined
          ? { route_source: counter.route_source }
          : {}),
        // Present only when a human substituted this review's route for the pinned one. It travels
        // with the provenance because the gate correspondence is built from this block: without it
        // the human sees which model reviewed but never that it was not the configured one.
        ...(counter.assurance === "server-attested" && counter.route_override !== undefined
          ? { route_override: counter.route_override }
          : {}),
        ...(counter.assurance === "server-attested" && counter.reviewer_runs !== undefined
          ? { reviewer_runs: counter.reviewer_runs }
          : {}),
      }),
      assessment,
    });
  } catch {
    evidence = Object.freeze({
      available: false,
      reason: retained.has("counter_review")
        ? "review-set-invalid"
        : "review-set-incomplete",
      ...(assessment === undefined ? {} : { assessment }),
    });
  }

  let activeGate: ActiveGateV1 | undefined;
  let openGate: OpenGateStatus | undefined;
  let gateBindingBlocker: string | undefined;
  let staleBaselineRefreshRequired = false;
  if (state.open_gate !== undefined) {
    blockers.push("gate-decision-required");
    try {
      const request = await readArchivedGateRequest(dependencies, authority, state.open_gate.gate_id);
      activeGate = await readActiveGateProjection(dependencies, authority) ??
        (request === undefined ? undefined : parseActiveGate(activeProjection(request)));
      const stateBindingMatches = activeGate !== undefined &&
        activeGate.task_id === state.task_id &&
        activeGate.phase_instance === state.phase_instance &&
        activeGate.gate_id === state.open_gate.gate_id &&
        activeGate.kind === state.open_gate.gate_kind &&
        activeGate.subject_digest === state.open_gate.subject_digest &&
        activeGate.context_digest === state.open_gate.context_digest &&
        activeGate.opened_at_revision === state.open_gate.opened_at_revision;
      let requestBindingMatches = false;
      if (activeGate !== undefined && request !== undefined) {
        try {
          activeGateHead(activeGate, request);
          requestBindingMatches = true;
        } catch { /* mismatch remains blocking */ }
      }
      if (activeGate === undefined || !stateBindingMatches || !requestBindingMatches) {
        blockers.push("active-gate-mismatch");
        gateBindingBlocker = "active-gate-mismatch";
      } else {
        if (request?.kind === "baseline-adoption" && statusReconciliation !== undefined) {
          const target = await currentBaselineTargetFacts(dependencies, statusReconciliation.findings, repositorySet);
          const live = baselineAdoptionInputFromFindings(
            authority.task_id, state, statusReconciliation.findings, target,
          );
          if (live !== undefined) {
            const continuous = await baselinePresentedTargetsOnCurrentFirstParent(
              dependencies, request.context, target, repositorySet,
            );
            staleBaselineRefreshRequired = assessBaselineSubjectFreshness(
              request, live.context, continuous,
            ).classification === "stale";
          }
        }
        try {
          let triggerDetails: readonly string[] | undefined;
          if (activeGate.kind === "commit-authorization") {
            if (
              produceSubject?.artifact.artifact_kind !== "implementation-output" ||
              produceSubject.artifact_digest !== activeGate.subject_digest
            ) {
              throw new TypeError("commit-authorization presentation requires its exact retained implementation output");
            }
            triggerDetails = contentTriggerDetails(
              latestEligibleRuleSettlement(
                state,
                produceSubject.artifact_digest,
                produceSubject.artifact.phase_instance,
              ),
              produceSubject.artifact,
            );
          }
          let reviewedRepositoryDetails: readonly string[] | undefined;
          if (evidence.available) {
            reviewedRepositoryDetails = reviewedRepositoryGateDetails(
              activeGate,
              evidence.current_evidence,
              reviewedRepositories,
              repositories,
            );
          }
          openGate = gateStatus(activeGate, {
            ...(triggerDetails === undefined ? {} : { content_trigger: triggerDetails }),
            ...(reviewedRepositoryDetails === undefined
              ? {}
              : { reviewed_repositories: reviewedRepositoryDetails }),
          });
        } catch {
          // A disposable decision interface must never make an incomplete authority join look
          // plausible. Keep the durable gate open, withhold its human choices, and route status
          // to inspection until the retained output/settlement disagreement is resolved.
          blockers.push("content-trigger-presentation-invalid");
          gateBindingBlocker = "content-trigger-presentation-invalid";
        }
      }
    } catch {
      blockers.push("active-gate-invalid");
      gateBindingBlocker = "active-gate-invalid";
    }
  }

  let pendingGates: ReturnType<typeof pendingAdjudicationGates> = [];
  if (assessment?.next === "adjudication-gate" && constitution !== undefined) {
    pendingGates = pendingAdjudicationGates(state, constitution, retained, authenticatedApprovals);
  }
  const adjudicationGateKind = pendingGates[0]?.kind;
  let eligibleTriggerSettlement = produceSubject === undefined
    ? undefined
    : (latestEligibleRuleSettlement(
        state, produceSubject.artifact_digest, produceSubject.artifact.phase_instance,
      ) ?? (produceSubject.artifact.artifact_kind === "document" && produceSubject.artifact.editorial_predecessor !== undefined
        ? latestEligibleRuleSettlement(
            state,
            produceSubject.artifact.editorial_predecessor.subject_digest,
            produceSubject.artifact.phase_instance,
          )
        : undefined));
  if (
    eligibleTriggerSettlement === undefined && produceSubject !== undefined &&
    config.verified === true && parsedConfig !== undefined && liveConfigDigest !== undefined
  ) {
    const changedDocs = await changedCoProducedDocumentPaths(dependencies, state, produceSubject);
    const changedPaths = changedDocs.ok ? changedDocs.value : [];
    const ruleContext = approvalRuleContext(state, produceSubject, parsedConfig, changedPaths);
    const conclusion = evaluateApprovalRules(
      ruleContext.config, ruleContext.subject, ruleContext.changedPaths, ruleContext.secondaryChangedPaths,
    );
    eligibleTriggerSettlement = Object.freeze({
      schema_version: "1",
      task_id: state.task_id,
      phase_instance: state.phase_instance,
      step: produceSubject.artifact.step,
      subject_digest: produceSubject.artifact_digest,
      config_digest: liveConfigDigest,
      settled_at_revision: state.revision,
      conclusion,
    });
  }
  const currentSimpleRevision = produceSubject === undefined
    ? undefined
    : [...(state.human_revision_history ?? [])]
      .filter((record) =>
        record.phase_instance === state.phase_instance &&
        record.classification === "simple" &&
        record.resulting_subject_digest === produceSubject.artifact_digest &&
        record.resulting_result_digest === produceSubject.reference.result_digest)
      .sort((left, right) => right.resulting_attempt - left.resulting_attempt)[0];
  const currentOrdinaryApproval = produceSubject === undefined
    ? undefined
    : matchingOrdinaryApproval(
      state,
      authenticatedApprovals,
      produceSubject.artifact_digest,
      produceSubject.artifact.phase_instance,
    );
  const legacyInitialization = await loadLegacyImportInitialization(dependencies, authority, state);
  const migrationAuditRequired = legacyInitialization.ok && legacyInitialization.value !== undefined &&
    state.phase_instance === "design" &&
    !authenticatedApprovals.some((item) => item.request.kind === "migration-audit" && item.decision.envelope.payload.decision === "accept-import-audit");
  const approvalTriggerRecoveryRequired =
    !migrationAuditRequired && state.terminal === undefined && state.open_gate === undefined &&
    state.pending_human_revision === undefined && state.step === "triage" &&
    state.status === "succeeded" && assessment?.next === "adjudication-gate" &&
    adjudicationGateKind === "constitution-review" && eligibleTriggerSettlement === undefined &&
    currentSimpleRevision === undefined && currentOrdinaryApproval === undefined;
  // Once the audit is accepted, the design phase exits to the import's authenticated resume
  // point, so status reports the server-derived resume skill instead of a phase-1 hand-off.
  const migrationAuditAccepted = legacyInitialization.ok && legacyInitialization.value !== undefined &&
    state.phase_instance === "design" &&
    authenticatedApprovals.some((item) => item.request.kind === "migration-audit" && item.decision.envelope.payload.decision === "accept-import-audit");
  const nextActionInput = {
    repository_initialized: true,
    state,
    config_verified: config.verified,
    ...(config.verified !== true && config.issue !== undefined ? { config_issue: config.issue } : {}),
    ...(statusReconciliation === undefined ? {} : { reconciliation_findings: statusReconciliation.findings }),
    reconciliation_blocking_reasons: Object.freeze([
      ...reconciliationBlockers,
      ...(gateBindingBlocker === undefined ? [] : [gateBindingBlocker]),
    ]),
    ...(assessment === undefined ? {} : { assessment }),
    ...(produceSubjectDrift.length === 0
      ? {}
      : { produce_subject_drift: Object.freeze([...produceSubjectDrift]) }),
    ...(upstreamDocumentDrift.length === 0
      ? {}
      : { upstream_document_drift: Object.freeze([...upstreamDocumentDrift]) }),
    ...(policyFindings === undefined ? {} : { policy_findings: policyFindings }),
    evidence_available: evidence.available,
    ...(subjectDigest === undefined ? {} : { subject_digest: subjectDigest }),
    authenticated_approvals: approvalFacts,
    ...(acceptedSettlement === undefined ? {} : { accepted_no_wait_settlement: acceptedSettlement }),
    ...(acceptedSettlement?.milestone_baseline_commit === undefined ? {} : {
      milestone_refresh_config_matches: liveConfigDigest === acceptedSettlement.config_digest,
    }),
    commit_observed: commitObserved,
    ...(commitBlockedReason === undefined ? {} : { commit_blocked_reason: commitBlockedReason }),
    ...(milestoneRecoveryRequired ? { milestone_recovery_required: true } : {}),
    ...(approvalTriggerRecoveryRequired ? { approval_trigger_recovery_required: true } : {}),
    ...(governingDocumentRecoveryRequired ? { governing_document_recovery_required: true } : {}),
    ...(milestoneRecoveryNoDelta ? { milestone_recovery_no_delta: true } : {}),
    ...(milestoneProofUnverifiableReason === undefined ? {} : {
      milestone_proof_unverifiable_reason: milestoneProofUnverifiableReason,
    }),
    ...(staleBaselineRefreshRequired ? { stale_baseline_refresh_required: true } : {}),
    ...(designCommit === undefined ? {} : { design_commit: designCommit }),
    ...(implementationCommit === undefined ? {} : { implementation_commit: implementationCommit }),
    ...(adjudicationGateKind === undefined ? {} : { adjudication_gate_kind: adjudicationGateKind }),
    ...(pendingGates.length === 0 ? {} : { pending_adjudication_gate_kinds: pendingGates.map((gate) => gate.kind) }),
    migration_audit_required: migrationAuditRequired,
    ...(migrationAuditAccepted && legacyInitialization.value?.resume_phase !== undefined
      ? { legacy_resume_phase: legacyInitialization.value.resume_phase }
      : {}),
  };
  let nextAction = deriveNextAction(nextActionInput);

  let gateInput: CommitAuthorizationInput | undefined;
  let baselineAdoptionInput: BaselineAdoptionInput | undefined;
  if (
    nextAction.code === "open-gate" && nextAction.gate_kind === "commit-authorization" &&
    produceSubject?.artifact.artifact_kind === "implementation-output" && evidence.available
  ) {
    try {
      const target = await currentTargetRef(dependencies);
      const secondaryCommits = repositorySet === undefined
        ? Object.freeze([])
        : await buildSecondaryCommitAuthorizationFacts(produceSubject.artifact, repositorySet);
      gateInput = buildCommitAuthorizationInput(
        produceSubject,
        evidence.current_evidence,
        target,
        await resolveCommit(dependencies.runner, "HEAD"),
        secondaryCommits,
      );
    } catch (error) {
      if (!(error instanceof SecondaryCommitObservationError)) throw error;
      milestoneProofUnverifiableReason = `${error.repository}-${error.reason}`;
      blockers.push(`implementation-milestone-${milestoneProofUnverifiableReason}`);
      nextAction = deriveNextAction({
        ...nextActionInput,
        milestone_proof_unverifiable_reason: milestoneProofUnverifiableReason,
      });
    }
  }
  if (
    nextAction.code === "open-gate" && nextAction.gate_kind === "baseline-adoption" &&
    statusReconciliation !== undefined
  ) {
    try {
      const target = await currentBaselineTargetFacts(dependencies, statusReconciliation.findings, repositorySet);
      baselineAdoptionInput = baselineAdoptionInputFromFindings(
        authority.task_id, state, statusReconciliation.findings, target,
      );
    } catch (error) {
      // Read-only status must report, not throw, when a drifted secondary left the writable set.
      if (!(error instanceof BaselineRepositoryUnavailableError)) throw error;
      blockers.push(`baseline-repository-${error.repository}-unavailable`);
    }
  }

  let workspace: WorkspaceCleanupReport;
  try {
    const inspected = await inspectWorkspaceCleanup(dependencies, authority, state);
    workspace = inspected.ok
      ? inspected.value
      : Object.freeze({
          removed_files: 0 as WorkspaceCleanupReport["removed_files"],
          removed_bytes: 0 as WorkspaceCleanupReport["removed_bytes"],
          retained_files: 0 as WorkspaceCleanupReport["retained_files"],
          retained_bytes: 0 as WorkspaceCleanupReport["retained_bytes"],
          cleanup_pending: true,
        });
  } catch {
    workspace = Object.freeze({
      removed_files: 0 as WorkspaceCleanupReport["removed_files"],
      removed_bytes: 0 as WorkspaceCleanupReport["removed_bytes"],
      retained_files: 0 as WorkspaceCleanupReport["retained_files"],
      retained_bytes: 0 as WorkspaceCleanupReport["retained_bytes"],
      cleanup_pending: true,
    });
  }

  let dispatchFailure: PublicDispatchFailureV1 | undefined;
  try {
    const observed = await readCurrentDispatchFailure(dependencies, authority, state);
    if (observed !== undefined) dispatchFailure = projectDispatchFailureObservation(observed);
  } catch {
    // A disposable diagnostic projection never blocks or changes canonical workflow status.
  }

  const reviewPolicy = await loadCanonicalRubricForPhaseKind(
    decodePhaseInstance(state.phase_instance).kind,
  );
  if (!reviewPolicy.ok) return reviewPolicy;
  const status: TaskStatusV1 = Object.freeze({
    task_id: authority.task_id,
    state: state.terminal ?? "active",
    revision: state.revision,
    phase_instance: state.phase_instance,
    step: state.step,
    status: state.status,
    attempt: state.attempt,
    input_fingerprint: state.input_fingerprint,
    resources: phaseStatusResources(authority.task_id, state.phase_instance),
    review_policy: reviewPolicy.value,
    ...(subjectDigest === undefined ? {} : { subject_digest: subjectDigest }),
    config,
    ...(repositories === undefined ? {} : { repositories }),
    ...(configChange === undefined ? {} : { config_change: configChange }),
    ...(routes === undefined ? {} : { routes }),
    ...(dispatchFailure === undefined ? {} : { dispatch_failure: dispatchFailure }),
    ...(constitutionStatus === undefined ? {} : { constitution: constitutionStatus }),
    ...(state.open_gate === undefined ? {} : { open_gate_id: state.open_gate.gate_id }),
    ...(openGate === undefined ? {} : { open_gate: openGate }),
    ...(approvalIssues.length === 0 ? {} : { approval_issues: Object.freeze(approvalIssues) }),
    ...(statusReconciliation === undefined ? {} : { reconciliation: statusReconciliation }),
    evidence,
    ...(editorialRevision === undefined ? {} : { editorial_revision: editorialRevision }),
    ...(gateInput === undefined ? {} : { gate_input: gateInput }),
    ...(baselineAdoptionInput === undefined ? {} : { baseline_adoption_gate: baselineAdoptionInput }),
    ...(milestoneRecoveryFacts === undefined ? {} : { milestone_recovery: milestoneRecoveryFacts }),
    workspace,
    blocking_reasons: Object.freeze([...new Set(blockers)]),
    next_action: nextAction,
  });
  return ok(Object.freeze({
    status,
    state,
    state_document_digest: stateDocument.digest,
    ...(liveConfigDigest === undefined ? {} : { live_config_digest: liveConfigDigest }),
    ...(legacyInitialization.ok && legacyInitialization.value !== undefined
      ? { legacy_import_initialization: true as const }
      : {}),
    retained,
  }));
}

/** Computes status and exposes the exact authenticated state/evidence read to internal consumers. */
export async function computeTaskStatusDetailed(
  dependencies: GateLifecycleDependencies,
  authority: TransactionAuthority,
): Promise<ProjectResult<DetailedTaskStatusV1>> {
  return computeTaskStatusDetailedInternal(dependencies, authority);
}

/** Computes reconciled normal-mode status without exposing internal authority material. */
export async function computeTaskStatus(
  dependencies: GateLifecycleDependencies,
  authority: TransactionAuthority,
): Promise<ProjectResult<TaskStatusV1>> {
  const detailed = await computeTaskStatusDetailedInternal(dependencies, authority);
  return detailed.ok ? ok(detailed.value.status) : detailed;
}

type UnreadableStateDetails = Readonly<{
  reason: "state-unreadable" | "state-noncanonical" | "status-authority-invalid";
  /** Best-effort position fields recovered from the noncanonical bytes; never authoritative. */
  position?: Readonly<{
    revision?: number;
    phase_instance?: string;
    step?: string;
    status?: string;
  }>;
}>;

export type DurableStateReadability =
  | Readonly<{ readability: "readable"; state: CanonicalDocument<TaskStateV1> }>
  | Readonly<{ readability: "absent" }>
  | Readonly<{
      readability: "unreadable";
      /** Human-readable description of where the task last stood, as far as it can be recovered. */
      summary: string;
      details: UnreadableStateDetails;
      /** Present when repository authority was established before state parsing failed. */
      repository_identity_digest?: Sha256Digest;
      /** Exact live config-byte identity when readable, otherwise null. */
      live_config_digest?: Sha256Digest | null;
    }>;

/** Best-effort position fields from noncanonical state bytes; any failure yields undefined. */
async function recoverStatePosition(
  statePath: string,
): Promise<NonNullable<UnreadableStateDetails["position"]> | undefined> {
  try {
    const raw: unknown = JSON.parse(new TextDecoder("utf-8", { fatal: true })
      .decode(new Uint8Array(await readFile(statePath))));
    if (raw === null || typeof raw !== "object" || Array.isArray(raw)) return undefined;
    const candidate = raw as Record<string, unknown>;
    const position = Object.freeze({
      ...(typeof candidate.revision === "number" ? { revision: candidate.revision } : {}),
      ...(typeof candidate.phase_instance === "string" ? { phase_instance: candidate.phase_instance } : {}),
      ...(typeof candidate.step === "string" ? { step: candidate.step } : {}),
      ...(typeof candidate.status === "string" ? { status: candidate.status } : {}),
    });
    return Object.keys(position).length === 0 ? undefined : position;
  } catch {
    return undefined;
  }
}

function unreadableState(
  taskId: TaskSlug,
  reason: UnreadableStateDetails["reason"],
  position?: UnreadableStateDetails["position"],
  identity?: Readonly<{
    repository_identity_digest: Sha256Digest;
    live_config_digest: Sha256Digest | null;
  }>,
): Extract<DurableStateReadability, { readability: "unreadable" }> {
  const located = position === undefined
    ? "its last recorded position could not be recovered"
    : `it last recorded ${[
        position.phase_instance === undefined ? undefined : `phase ${position.phase_instance}`,
        position.step === undefined ? undefined : `step ${position.step}`,
        position.status === undefined ? undefined : `status ${position.status}`,
        position.revision === undefined ? undefined : `revision ${position.revision}`,
      ].filter((part) => part !== undefined).join(", ")}`;
  const problem = reason === "status-authority-invalid"
    ? "repository authority for durable state could not be established, so state.json was not consulted"
    : reason === "state-unreadable"
      ? "state.json exists but could not be read"
      : "state.json exists but is not canonical durable state";
  return Object.freeze({
    readability: "unreadable" as const,
    summary: `Task ${taskId}: ${problem}; ${located}.`,
    details: Object.freeze({ reason, ...(position === undefined ? {} : { position }) }),
    ...(identity === undefined ? {} : identity),
  });
}

/**
 * Classifies whether durable task state is readable, without judging or repairing it. Never
 * throws: an unreadable state is reported as a described position rather than a failure, so a
 * read-only status classifier can still tell the human where the task stands.
 */
export async function classifyDurableStateReadability(input: Readonly<{
  working_directory: string;
  task_id: TaskSlug;
}>): Promise<DurableStateReadability> {
  let stateRead: Awaited<ReturnType<typeof readTaskState>>;
  let statePath: string;
  let readabilityAuthority: TransactionAuthority;
  try {
    const context = Object.freeze({
      task_id: input.task_id,
      phase_instance: "prd" as PhaseInstanceId,
      operation: "status-readability" as SafeCode,
      attempt: 1 as SafeInteger,
    });
    const discovered = await discoverWorktree(createGitRunner({ cwd: input.working_directory }), context);
    if (!discovered.ok) return unreadableState(input.task_id, "status-authority-invalid");
    const environment = await preflightGit(discovered.value, context);
    if (!environment.ok) return unreadableState(input.task_id, "status-authority-invalid");
    const authority = await createInternalTransactionAuthority({
      runner: discovered.value,
      environment: environment.value,
      task_id: input.task_id,
      context,
    });
    if (!authority.ok) return unreadableState(input.task_id, "status-authority-invalid");
    readabilityAuthority = authority.value;
    statePath = authority.value.state.absolute;
    stateRead = await readTaskState(authority.value.state);
  } catch {
    return unreadableState(input.task_id, "status-authority-invalid");
  }
  if (stateRead.kind === "canonical") {
    return Object.freeze({ readability: "readable" as const, state: stateRead.document });
  }
  if (stateRead.kind === "missing") return Object.freeze({ readability: "absent" as const });
  const reason = stateRead.kind === "unreadable"
    ? "state-unreadable" as const
    : "state-noncanonical" as const;
  const position = reason === "state-noncanonical" ? await recoverStatePosition(statePath) : undefined;
  const config = await readTaskConfig(readabilityAuthority.config);
  const liveConfigDigest = config.kind === "valid" ? config.snapshot.digest
    : config.kind === "invalid" ? config.digest
    : null;
  return unreadableState(input.task_id, reason, position, Object.freeze({
    repository_identity_digest: readabilityAuthority.repository_identity_digest,
    live_config_digest: liveConfigDigest,
  }));
}

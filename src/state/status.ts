import { readFile } from "node:fs/promises";
import { join } from "node:path";

import { canonicalJsonDigest, parseCanonicalDocument, type CanonicalDocument } from "../contracts/canonical.js";
import type { ProjectionDigestRef } from "../contracts/durable-primitives.js";
import { parseConfigYaml } from "../contracts/config.js";
import { exactCommitAuthorizationContext, parseActiveGate, parseGateRequest, type ActiveGateV1, type GateRequestV1 } from "../contracts/durable-gate.js";
import type { TaskStateV1 } from "../contracts/durable-state.js";
import type { AdjudicationEvidence } from "../contracts/adjudication.js";
import type { ProjectError, ProjectResult } from "../contracts/errors.js";
import { computeGateContextDigest, verifyPinnedConfig } from "../contracts/fingerprints.js";
import type { PathSafeId, Sha256Digest, TaskSlug } from "../contracts/evidence.js";
import { decodePhaseInstance, type PhaseInstanceId } from "../contracts/phase-instance.js";
import type { GateContext } from "../contracts/gates.js";
import type { PlainJsonValue } from "../contracts/plain-json.js";
import type { ReviewEvidence } from "../contracts/review.js";
import type { CurrentEvidenceSetRef } from "../contracts/trust.js";
import { resolveDispatchRoute, type DispatchRoute } from "../dispatch/routing.js";
import { designApprovalPolicyContext, selectAdjudicationGates } from "../review/adjudication.js";
import { assessCurrentEvidence, DEFAULT_MAX_ATTEMPTS, waiverInForce, type EvidenceAssessment } from "../review/fixed-point.js";
import { canonicalRubricForPhaseKind, type CanonicalRubric } from "../review/rubrics.js";
import { createGitRunner, preflightGit, resolveCommit } from "../repository/git.js";
import { discoverWorktree } from "../repository/identity.js";
import { readTaskState } from "./read.js";
import type { TransactionAuthority } from "./authority.js";
import { assertInternalTransactionAuthority, createInternalTransactionAuthority } from "./authority.js";
import { resolvePinnedConstitution, type ResolvedConstitution } from "./constitution.js";
import { deriveCurrentEvidenceSet, loadRetainedEvidence, type RetainedEvidenceSet } from "./evidence-results.js";
import { loadAuthenticatedGateApproval, type AuthenticatedGateApproval } from "./gate-approvals.js";
import {
  buildGateDecisionTemplates,
  buildHumanGatePresentation,
  type HumanGatePresentation,
} from "./gate-decision-interface.js";
import { activeProjection, type GateLifecycleDependencies } from "./gate-core.js";
import { deriveNextAction, type NextAction } from "./next-action.js";
import { buildNextActionRequest } from "./request-templates.js";
import { expectedProduceUpstreamBindings, loadCurrentProduceSubject, loadProduceUpstreamSubject, produceUpstreamBindingsForSubject } from "./produce-subject.js";
import type { CurrentProduceSubject } from "./produce-subject.js";
import { designArtifactCommittedAtCurrentTarget, implementationOutputCommittedAtCurrentTarget, type DesignMilestoneMiss } from "./implementation-manifest.js";
import { phaseStatusResources, type StatusResource } from "./phase-documents.js";
import { inspectWorkspaceCleanup, type WorkspaceCleanupReport } from "./workspace-cleanup.js";
import { discoverReconciliationInput } from "./reconciliation-discovery.js";
import {
  activeGateHead,
  reconcileCurrentAuthority,
  type ReconciliationFinding,
  type ReconciliationResult,
} from "./reconciliation.js";
import { gateRequestClaim, parseWorkspacePathClaim, resolveTaskPath, resolveTaskWorkspacePath } from "../repository/paths.js";
import { loadLegacyImportInitialization } from "./legacy-import-resume.js";

const ok = <T>(value: T): ProjectResult<T> => Object.freeze({ schema_version: "1", ok: true, value });

type ConfigVerification = Readonly<{
  verified: boolean;
  expected_digest?: Sha256Digest;
  observed_digest?: Sha256Digest;
  issue?: string;
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
  }>;
  assessment: EvidenceAssessment;
}>;

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
  }>;
  target_ref_guidance: string;
}>;

export type DesignApprovalInput = Readonly<{
  kind: "design-approval";
  context: GateContext<"design-approval">;
  target_ref_guidance: string;
}>;

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
  /** The dispatched review routes for the current phase kind; the producer is the host, never routed. */
  routes?: Readonly<{ counter_reviewer: DispatchRoute; adjudicator: DispatchRoute }>;
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
  /** Derived cleanup state. Cleanup debt is non-blocking and never changes workflow routing. */
  workspace?: WorkspaceCleanupReport;
  next_action: NextAction;
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
  next_action: Omit<NextAction, "request" | "guidance" | "gate_id">;
}>;

/** Keep routing identity in brief status without carrying request templates or their prose. */
function projectBriefNextAction(next: NextAction): Omit<NextAction, "request" | "guidance" | "gate_id"> {
  const { request: _request, guidance: _guidance, gate_id: _gateId, ...identity } = next;
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

function unavailableConfig(expected?: Sha256Digest, observed?: Sha256Digest, issue?: string): ConfigVerification {
  return Object.freeze({
    verified: false,
    ...(expected === undefined ? {} : { expected_digest: expected }),
    ...(observed === undefined ? {} : { observed_digest: observed }),
    ...(issue === undefined ? {} : { issue }),
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
    return parseGateRequest(parseCanonicalDocument(bytes, "gate request").value);
  } catch (error) {
    if ((error as { code?: unknown }).code === "ENOENT") return undefined;
    throw error;
  }
}

async function currentApprovedUpstreams(
  dependencies: GateLifecycleDependencies,
  authority: TransactionAuthority,
  state: TaskStateV1,
  authenticated: readonly AuthenticatedGateApproval[],
  subject: CurrentProduceSubject | undefined,
): Promise<readonly Sha256Digest[]> {
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
        return (item.approval.gate_kind === "design-approval" &&
            item.request.kind === "design-approval" &&
            item.request.context.artifact_kind === ownerKind) ||
          (item.approval.gate_kind === "artifact-approval" &&
            item.request.kind === "artifact-approval" &&
            item.request.context.artifact_kind === ownerKind);
      })
      .sort((left, right) => right.approval.resolved_at_revision - left.approval.resolved_at_revision)[0];
    if (approval === undefined) throw new TypeError("current upstream produced authority lacks approval");
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
    const approved = currentSet !== undefined && authenticated.some((item) =>
      item.approval.gate_kind === gate.kind &&
      item.approval.subject_digest === gate.subject_digest &&
      item.request.phase_instance === state.phase_instance &&
      item.request.context_digest === contextDigest &&
      item.request.current_evidence.set_digest === currentSet.set_digest &&
      source.evidence.source_evidence_set_digest === currentSet.set_digest);
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

function gateStatus(active: ActiveGateV1): OpenGateStatus {
  return Object.freeze({
    gate_id: active.gate_id,
    kind: active.kind,
    decision_path: `.archflow/runtime/tasks/${active.task_id}/cache/gates/gate.decision`,
    archive_decision_path: `.archflow/tasks/${active.task_id}/authority/decisions/${active.gate_id}/decision.json`,
    request_path: `.archflow/tasks/${active.task_id}/authority/decisions/${active.gate_id}/request.json`,
    decision_templates: buildGateDecisionTemplates(active),
    presentation: buildHumanGatePresentation(active),
  });
}

export async function currentTargetRef(dependencies: GateLifecycleDependencies): Promise<Readonly<{
  value: string;
  guidance: string;
}>> {
  try {
    const branch = await dependencies.runner.runText({
      argv: ["symbolic-ref", "--quiet", "HEAD"],
      operation: "status-target-ref" as import("../contracts/evidence.js").SafeCode,
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

/** Materializes the checked commit-gate resume facts from authenticated retained output. */
export function buildCommitAuthorizationInput(
  subject: CurrentProduceSubject,
  currentEvidence: CurrentEvidenceSetRef,
  target: Readonly<{ value: string; guidance: string }>,
  baselineCommit: string,
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
    }),
    target_ref_guidance: target.guidance,
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
export async function computeTaskStatus(
  dependencies: GateLifecycleDependencies,
  authority: TransactionAuthority,
): Promise<ProjectResult<TaskStatusV1>> {
  const blockers: string[] = [];
  let stateRead: Awaited<ReturnType<typeof readTaskState>>;
  try {
    assertInternalTransactionAuthority(authority, dependencies);
    stateRead = await readTaskState(authority.state);
  } catch {
    const next = deriveNextAction({ repository_initialized: true });
    return ok(Object.freeze({
      task_id: authority.task_id,
      state: "missing" as const,
      config: unavailableConfig(undefined, undefined, "status-authority-invalid"),
      blocking_reasons: Object.freeze(["status-authority-invalid"]),
      next_action: attachNextActionRequest(next, { task_id: authority.task_id }),
    }));
  }

  if (stateRead.kind !== "canonical") {
    const reason = stateRead.kind === "missing" ? "state-missing" : `state-${stateRead.kind}`;
    const next = deriveNextAction({ repository_initialized: true });
    return ok(Object.freeze({
      task_id: authority.task_id,
      state: "missing" as const,
      config: unavailableConfig(undefined, undefined, "state-unavailable"),
      blocking_reasons: Object.freeze([reason]),
      next_action: attachNextActionRequest(next, { task_id: authority.task_id }),
    }));
  }
  const stateDocument = stateRead.document;
  const state = stateDocument.value;

  let config: ConfigVerification;
  let parsedConfig: ReturnType<typeof parseConfigYaml> | undefined;
  try {
    const read = await dependencies.read_config(authority.config);
    if (read.kind === "invalid" && read.digest === state.config_digest) {
      // The bytes are exactly the pinned ones, so restoring or editing the file cannot help:
      // this build's schema no longer accepts what the task pinned. That is a different
      // situation from a changed config and must not be reported as one.
      config = unavailableConfig(state.config_digest, read.digest, "pinned-config-schema-unsupported");
      blockers.push("pinned-config-schema-unsupported");
    } else if (read.kind !== "valid") {
      config = unavailableConfig(
        state.config_digest,
        read.kind === "invalid" ? read.digest : undefined,
        `config-${read.kind}`,
      );
      blockers.push(`config-${read.kind}`);
    } else {
      const verified = verifyPinnedConfig(state.config_digest, read.snapshot.bytes);
      config = verified.ok
        ? Object.freeze({ verified: true, expected_digest: state.config_digest, observed_digest: verified.value })
        : unavailableConfig(state.config_digest, read.snapshot.digest, "pinned-config-mismatch");
      if (!verified.ok) blockers.push("pinned-config-mismatch");
      parsedConfig = parseConfigYaml(new TextDecoder("utf-8", { fatal: true }).decode(read.snapshot.bytes), "task config");
    }
  } catch {
    config = unavailableConfig(state.config_digest, undefined, "config-unresolvable");
    blockers.push("config-unresolvable");
  }

  let routes: TaskStatusV1["routes"];
  if (parsedConfig !== undefined) {
    try {
      const phaseKind = decodePhaseInstance(state.phase_instance).kind;
      const counterReviewer = resolveDispatchRoute(parsedConfig, phaseKind, "counter-reviewer");
      const adjudicator = resolveDispatchRoute(parsedConfig, phaseKind, "adjudicator");
      routes = Object.freeze({ counter_reviewer: counterReviewer, adjudicator });
    } catch {
      blockers.push("dispatch-routes-invalid");
    }
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
    const discovered = await discoverReconciliationInput(dependencies, authority, stateDocument);
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

  let commitObserved = false;
  let commitBlockedReason: DesignMilestoneMiss | undefined;
  let implementationCommit: Readonly<{
    paths: readonly string[];
    message: string;
    target_ref: string;
    baseline_commit: string;
  }> | undefined;
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
      implementationCommit = Object.freeze({
        paths: exact.paths,
        message: exact.commit_message,
        target_ref: exact.target_ref,
        baseline_commit: exact.baseline_commit,
      });
      try {
        if (await implementationOutputCommittedAtCurrentTarget(
          dependencies.runner,
          produceSubject.artifact,
          exact,
        )) {
          commitObserved = true;
          break;
        }
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
        const observation = await designArtifactCommittedAtCurrentTarget(
          dependencies.runner,
          state.task_id,
          produceSubject.artifact,
          produceSubject.retained.manifest.value.outputs,
          authenticated.request.context,
        );
        commitObserved = observation.observed;
        if (!observation.observed && observation.blocking) {
          commitBlockedReason = observation.reason;
          blockers.push(`design-milestone-${observation.reason}`);
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
        const observation = await designArtifactCommittedAtCurrentTarget(
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
        commitObserved = observation.observed;
        if (!observation.observed && observation.blocking) {
          commitBlockedReason = observation.reason;
          blockers.push(`design-milestone-${observation.reason}`);
        }
      } catch {
        blockers.push("commit-observation-unavailable");
      }
    }
  }

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
  const reviewPredecessor = declaredPredecessor === undefined
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
        openGate = gateStatus(activeGate);
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
  const adjudicationGate = pendingGates[0];
  const adjudicationGateKind = adjudicationGate?.kind;
  const legacyInitialization = await loadLegacyImportInitialization(dependencies, authority, state);
  const migrationAuditRequired = legacyInitialization.ok && legacyInitialization.value !== undefined &&
    state.phase_instance === "design" &&
    !authenticatedApprovals.some((item) => item.request.kind === "migration-audit" && item.decision.envelope.payload.decision === "accept-import-audit");
  const migrationAuditContext: GateContext<"migration-audit"> | undefined =
    migrationAuditRequired && legacyInitialization.ok && legacyInitialization.value?.resume_phase !== undefined &&
    legacyInitialization.value.planned_final_phase !== undefined && legacyInitialization.value.target_ref !== undefined &&
    legacyInitialization.value.commit_message !== undefined
      ? Object.freeze({
          source_identity_digest: legacyInitialization.value.source_identity_digest,
          destination_identity_digest: authority.task_identity_digest,
          import_digest: legacyInitialization.value.import_digest,
          code_baseline_digest: canonicalJsonDigest({ schema_version: "1", digest_kind: "code-baseline-commit", commit: legacyInitialization.value.code_baseline_commit }),
          policy_baseline_digest: canonicalJsonDigest({ schema_version: "1", digest_kind: "policy-base-commit", commit: legacyInitialization.value.policy_base_commit }),
          resume_phase: legacyInitialization.value.resume_phase,
          planned_final_phase: legacyInitialization.value.planned_final_phase,
          imported_documents: Object.freeze(legacyInitialization.value.mapping.map((entry) => Object.freeze({
            path: entry.destination_path,
            content_digest: legacyInitialization.value!.staged_payload_refs.find((reference) => reference.legacy_path === entry.legacy_path)!.digest,
          })).sort((left, right) => left.path.localeCompare(right.path))),
          target_ref: legacyInitialization.value.target_ref,
          baseline_commit: legacyInitialization.value.code_baseline_commit,
          commit_message: legacyInitialization.value.commit_message,
        })
      : undefined;
  const nextAction = deriveNextAction({
    repository_initialized: true,
    state,
    config_verified: config.verified,
    ...(config.verified !== true && config.issue === "pinned-config-schema-unsupported"
      ? { config_schema_unsupported: true }
      : {}),
    ...(statusReconciliation === undefined ? {} : { reconciliation_findings: statusReconciliation.findings }),
    reconciliation_blocking_reasons: Object.freeze([
      ...reconciliationBlockers,
      ...(gateBindingBlocker === undefined ? [] : [gateBindingBlocker]),
    ]),
    ...(assessment === undefined ? {} : { assessment }),
    evidence_available: evidence.available,
    ...(subjectDigest === undefined ? {} : { subject_digest: subjectDigest }),
    authenticated_approvals: approvalFacts,
    commit_observed: commitObserved,
    ...(commitBlockedReason === undefined ? {} : { commit_blocked_reason: commitBlockedReason }),
    ...(designCommit === undefined ? {} : { design_commit: designCommit }),
    ...(implementationCommit === undefined ? {} : { implementation_commit: implementationCommit }),
    ...(adjudicationGateKind === undefined ? {} : { adjudication_gate_kind: adjudicationGateKind }),
    ...(pendingGates.length === 0 ? {} : { pending_adjudication_gate_kinds: pendingGates.map((gate) => gate.kind) }),
    migration_audit_required: migrationAuditRequired,
  });

  let gateInput: CommitAuthorizationInput | undefined;
  let designGateInput: DesignApprovalInput | undefined;
  if (
    nextAction.code === "open-gate" && nextAction.gate_kind === "commit-authorization" &&
    produceSubject?.artifact.artifact_kind === "implementation-output" && evidence.available
  ) {
    const target = await currentTargetRef(dependencies);
    gateInput = buildCommitAuthorizationInput(
      produceSubject,
      evidence.current_evidence,
      target,
      await resolveCommit(dependencies.runner, "HEAD"),
    );
  }
  if (
    nextAction.code === "open-gate" && nextAction.gate_kind === "design-approval" && evidence.available
  ) {
    const target = await currentTargetRef(dependencies);
    designGateInput = await buildDesignApprovalInput(dependencies, state, retained, target);
  }
  const nextActionWithRequest = attachNextActionRequest(nextAction, {
    task_id: authority.task_id,
    state,
    // Gate templates bind the retained produce artifact digest. After an editorial revision the
    // derived review set stays bound to the predecessor bytes, so the review-set subject would
    // name the wrong artifact.
    ...(evidence.available
      ? {
          subject_digest: subjectDigest ?? evidence.subject_digest,
          current_evidence: evidence.current_evidence,
        }
      : {}),
    ...(gateInput === undefined ? {} : { commit_authorization: gateInput }),
    ...(designGateInput === undefined ? {} : { design_approval: designGateInput }),
    ...(migrationAuditContext === undefined ? {} : { migration_audit: migrationAuditContext }),
    ...(adjudicationGate === undefined ? {} : { adjudication_gate: adjudicationGate }),
    maximum_attempts: parsedConfig?.max_attempts ?? DEFAULT_MAX_ATTEMPTS,
  });

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

  return ok(Object.freeze({
    task_id: authority.task_id,
    state: state.terminal ?? "active",
    revision: state.revision,
    phase_instance: state.phase_instance,
    step: state.step,
    status: state.status,
    attempt: state.attempt,
    input_fingerprint: state.input_fingerprint,
    resources: phaseStatusResources(authority.task_id, state.phase_instance),
    review_policy: canonicalRubricForPhaseKind(decodePhaseInstance(state.phase_instance).kind),
    ...(subjectDigest === undefined ? {} : { subject_digest: subjectDigest }),
    config,
    ...(routes === undefined ? {} : { routes }),
    ...(constitutionStatus === undefined ? {} : { constitution: constitutionStatus }),
    ...(state.open_gate === undefined ? {} : { open_gate_id: state.open_gate.gate_id }),
    ...(openGate === undefined ? {} : { open_gate: openGate }),
    ...(approvalIssues.length === 0 ? {} : { approval_issues: Object.freeze(approvalIssues) }),
    ...(statusReconciliation === undefined ? {} : { reconciliation: statusReconciliation }),
    evidence,
    ...(editorialRevision === undefined ? {} : { editorial_revision: editorialRevision }),
    ...(gateInput === undefined ? {} : { gate_input: gateInput }),
    workspace,
    blocking_reasons: Object.freeze([...new Set(blockers)]),
    next_action: nextActionWithRequest,
  }));
}

function attachNextActionRequest(
  next: NextAction,
  facts: Parameters<typeof buildNextActionRequest>[1],
): NextAction {
  const built = buildNextActionRequest(next, facts);
  return built === undefined
    ? next
    : Object.freeze({ ...next, request: built.request, guidance: built.guidance });
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
  try {
    const context = Object.freeze({
      task_id: input.task_id,
      phase_instance: "prd" as PhaseInstanceId,
      operation: "status-readability" as import("../contracts/evidence.js").SafeCode,
      attempt: 1 as import("../contracts/evidence.js").SafeInteger,
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
  return unreadableState(input.task_id, reason, position);
}

import { readFile } from "node:fs/promises";
import { join } from "node:path";

import { canonicalJsonDigest, parseCanonicalDocument, type CanonicalDocument } from "../contracts/canonical.js";
import type { ProjectionDigestRef } from "../contracts/durable-primitives.js";
import { parseConfigYaml } from "../contracts/config.js";
import { parseActiveGate, parseGateRequest, type ActiveGateV1, type GateRequestV1 } from "../contracts/durable-gate.js";
import type { TaskStateV1 } from "../contracts/durable-state.js";
import type { ProjectResult } from "../contracts/errors.js";
import { computeGateContextDigest, verifyPinnedConfig } from "../contracts/fingerprints.js";
import type { PathSafeId, Sha256Digest, TaskSlug } from "../contracts/evidence.js";
import { decodePhaseInstance, type PhaseInstanceId } from "../contracts/phase-instance.js";
import type { PlainJsonValue } from "../contracts/plain-json.js";
import type { ReviewEvidence } from "../contracts/review.js";
import type { CurrentEvidenceSetRef } from "../contracts/trust.js";
import type { SupplementalReviewOutcome, SupplementalReviewRef } from "../contracts/supplemental.js";
import { resolveDispatchRoute, type DispatchRoute } from "../dispatch/routing.js";
import { renderGateCounterPrompt } from "../local/call-envelope.js";
import { selectAdjudicationGates } from "../review/adjudication.js";
import { assessCurrentEvidence, DEFAULT_MAX_ATTEMPTS, waiverInForce, type EvidenceAssessment } from "../review/fixed-point.js";
import { createGitRunner, preflightGit } from "../repository/git.js";
import { discoverWorktree } from "../repository/identity.js";
import { readTaskState } from "./read.js";
import type { TransactionAuthority } from "./authority.js";
import { assertInternalTransactionAuthority, createInternalTransactionAuthority } from "./authority.js";
import { resolvePinnedConstitution, type ResolvedConstitution } from "./constitution.js";
import { deriveCurrentEvidenceSet, loadRetainedEvidence, type RetainedEvidenceSet } from "./evidence-results.js";
import { loadAuthenticatedGateApproval, type AuthenticatedGateApproval } from "./gate-approvals.js";
import { buildGateDecisionTemplates } from "./gate-decision-interface.js";
import type { GateLifecycleDependencies } from "./gate-core.js";
import { deriveNextAction, type NextAction } from "./next-action.js";
import { buildNextActionRequest } from "./request-templates.js";
import { expectedProduceUpstreamBindings, loadCurrentProduceSubject, loadProduceUpstreamSubject } from "./produce-subject.js";
import type { CurrentProduceSubject } from "./produce-subject.js";
import { implementationOutputCommittedAtCurrentTarget } from "./implementation-manifest.js";
import { discoverReconciliationInput } from "./reconciliation-discovery.js";
import {
  activeGateHead,
  reconcileCurrentAuthority,
  type ReconciliationFinding,
  type ReconciliationResult,
} from "./reconciliation.js";
import { gateCounterReviewClaim } from "../repository/paths.js";

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
  decision_path: "gate.decision";
  archive_decision_path: string;
  request_path: string;
  gate_counter_review_path: string;
  decision_templates: readonly PlainJsonValue[];
  counter_review_prompt: string;
  supplemental_outcomes: readonly SupplementalReviewOutcome[];
  supplemental_supersession?: Readonly<{
    action: "supersede";
    review: SupplementalReviewRef;
    accepted_triage_digest: Sha256Digest;
    old_subject_digest: Sha256Digest;
    new_subject_digest_from: "envelope.artifact_digest";
    reason: string;
  }>;
}>;

/**
 * The reconciliation report status publishes: raw reconciliation truth minus any drift the
 * current fixed-point re-entry authorizes. `archflow-local reconcile` keeps reporting the
 * unfiltered result; only status — which alone can see the re-entry assessment — reclassifies.
 * Suppressed paths stay visible in `expected_reentry_edits`, so the report never hides drift.
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
    diff_digest: Sha256Digest;
    current_artifact_digests: readonly Sha256Digest[];
    parent_document_digests: readonly Sha256Digest[];
  }>;
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
  /**
   * The current review subject: the canonical digest of the whole retained produce artifact
   * (`manifest.artifact_digest`), never the document's inner `content_digest`. Present whenever
   * the current phase has an authoritative produce result — in particular at `counter_review`
   * time, so review artifacts are never built from a hand-derived subject.
   */
  subject_digest?: Sha256Digest;
  config: ConfigVerification;
  routes?: Readonly<{ producer: DispatchRoute }>;
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
  open_gate?: Readonly<{
    gate_id: PathSafeId;
    kind: ActiveGateV1["kind"];
    decision_template_names: readonly string[];
  }>;
  open_gate_id?: PathSafeId;
  reconciliation?: Readonly<{
    classification: ReconciliationResult["classification"];
    findings: readonly Readonly<{ kind: string; path?: string }>[];
  }>;
  constitution?: Readonly<{
    digest: Sha256Digest;
    active_rule_ids: readonly string[];
  }>;
  next_action: NextAction;
}>;

/** Names one decision template by its selective fields without carrying its body. */
function decisionTemplateName(template: PlainJsonValue): string {
  if (template === null || typeof template !== "object" || Array.isArray(template)) return "unknown";
  const value = template as Record<string, PlainJsonValue>;
  if (value.cancelled === true) return "cancel";
  if (typeof value.granted === "boolean") return value.granted ? "waiver-grant" : "waiver-deny";
  if (typeof value.decision === "string") return value.decision;
  return "unknown";
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
      open_gate: Object.freeze({
        gate_id: full.open_gate.gate_id,
        kind: full.open_gate.kind,
        decision_template_names: Object.freeze(full.open_gate.decision_templates.map(decisionTemplateName)),
      }),
    }),
    ...(full.open_gate_id === undefined ? {} : { open_gate_id: full.open_gate_id }),
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
    next_action: full.next_action,
  });
}

/**
 * Splits reconciliation findings into drift the current re-entry authorizes and everything else.
 *
 * A finding is an expected re-entry edit only when the fixed point authorizes revising the
 * produce artifact (`assessment.reentry_required` — accepted triage findings or a stale
 * adjudication — or `assessment.editorial_revision_required`, the evidence-preserving editorial
 * re-entry), or a produce re-entry is already durably recorded (`state` sits at produce
 * running/failed — the running entry itself is the declaration of intent, covering both the
 * fixed-point re-entries above once entered and the author-initiated new-information door from
 * any succeeded step), the finding is a `projection-mismatch`, and
 * the drifted path is one of the retained produce manifest's own projection paths. The last
 * test is deliberately broad: if a produce manifest ever projects more than the document
 * itself, every one of its projections becomes edit-tolerated during re-entry. Any other path
 * or finding kind keeps blocking exactly as before.
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
  const editAuthorized = assessment?.reentry_required === true ||
    assessment?.editorial_revision_required === true ||
    (state.step === "produce" && state.status !== "succeeded");
  if (!editAuthorized || produceSubject === undefined) {
    return Object.freeze({ remaining: findings, expected_reentry_edits: Object.freeze([]) });
  }
  const producePaths = new Set<string>(
    produceSubject.retained.prepared.manifest.value.projections.map((projection) => projection.path),
  );
  const remaining: ReconciliationFinding[] = [];
  const expected: ProjectionDigestRef["path"][] = [];
  for (const finding of findings) {
    if (finding.kind === "projection-mismatch" && producePaths.has(finding.path)) {
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

async function readActiveGate(authority: TransactionAuthority): Promise<ActiveGateV1 | undefined> {
  try {
    const bytes = new Uint8Array(await readFile(join(authority.task_root, "gate.json")));
    return parseActiveGate(parseCanonicalDocument(bytes, "active gate").value);
  } catch (error) {
    if ((error as { code?: unknown }).code === "ENOENT") return undefined;
    throw error;
  }
}

async function readArchivedGateRequest(
  authority: TransactionAuthority,
  active: ActiveGateV1,
): Promise<GateRequestV1 | undefined> {
  try {
    const bytes = new Uint8Array(await readFile(join(
      authority.task_root, "decisions", active.gate_id, "request.json",
    )));
    return parseGateRequest(parseCanonicalDocument(bytes, "gate request").value);
  } catch (error) {
    if ((error as { code?: unknown }).code === "ENOENT") return undefined;
    throw error;
  }
}

async function currentApprovedUpstreams(
  dependencies: GateLifecycleDependencies,
  state: TaskStateV1,
  authenticated: readonly AuthenticatedGateApproval[],
): Promise<readonly Sha256Digest[]> {
  const bindings = expectedProduceUpstreamBindings(state);
  const digests: Sha256Digest[] = [];
  for (const binding of bindings) {
    const loaded = await loadProduceUpstreamSubject(dependencies, state, binding);
    if (!loaded.ok) throw new TypeError("current upstream produced authority invalid");
    const approval = [...authenticated]
      .filter((item) => item.approval.gate_kind === "artifact-approval" &&
        item.approval.subject_digest === loaded.value.artifact_digest &&
        item.request.kind === "artifact-approval" &&
        item.request.context.artifact_kind === binding.artifact_kind)
      .sort((left, right) => right.approval.resolved_at_revision - left.approval.resolved_at_revision)[0];
    if (approval === undefined) throw new TypeError("current upstream produced authority lacks approval");
    digests.push(loaded.value.artifact_digest);
  }
  return Object.freeze(digests.sort());
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

function supplementalReviewRef(
  active: ActiveGateV1,
  inputFingerprint: Sha256Digest,
  evidence: ReviewEvidence,
): SupplementalReviewRef {
  if (evidence.model_family !== "claude" && evidence.model_family !== "codex") {
    throw new TypeError("supplemental reviewer family is unavailable");
  }
  return Object.freeze({
    prior_gate_id: active.gate_id,
    task_id: active.task_id,
    phase_instance: active.phase_instance,
    subject_digest: active.subject_digest,
    input_fingerprint: inputFingerprint,
    evidence_slot: Object.freeze({
      role: "gate-counter-review",
      evidence_digest: canonicalJsonDigest(evidence),
      assurance: "degraded",
      producer_family: evidence.producer_family,
      reviewer_family: evidence.model_family,
      independence: "opposite-family",
      gate_id: active.gate_id,
    }),
  });
}

async function supplementalOutcomeTemplates(
  dependencies: GateLifecycleDependencies,
  authority: TransactionAuthority,
  active: ActiveGateV1,
  inputFingerprint: Sha256Digest,
  currentSubjectDigest?: Sha256Digest,
): Promise<Readonly<{
  outcomes: readonly SupplementalReviewOutcome[];
  supersession?: NonNullable<OpenGateStatus["supplemental_supersession"]>;
}>> {
  const gate = Object.freeze({
    prior_gate_id: active.gate_id,
    task_id: active.task_id,
    phase_instance: active.phase_instance,
    subject_digest: active.subject_digest,
    input_fingerprint: inputFingerprint,
  });
  const outcomes: SupplementalReviewOutcome[] = [Object.freeze({
    action: "decline",
    gate,
    reason: "Human explicitly declined the optional gate counter-review.",
  })];
  if (dependencies.resolve_supplemental_review === undefined) return Object.freeze({ outcomes: Object.freeze(outcomes) });
  const retained = await dependencies.resolve_supplemental_review({ authority, request: active });
  if (!retained.ok) return Object.freeze({ outcomes: Object.freeze(outcomes) });
  let review: SupplementalReviewRef;
  try {
    review = supplementalReviewRef(active, inputFingerprint, retained.value.evidence);
  } catch {
    return Object.freeze({ outcomes: Object.freeze(outcomes) });
  }
  const ingested = active.supplemental.some((entry) => entry.action === "ingest" && entry.review.evidence_slot.evidence_digest === review.evidence_slot.evidence_digest);
  if (!ingested) {
    outcomes.push(Object.freeze({
      action: "ingest", review,
      reason: "Install the retained supplemental gate counter-review for human triage.",
    }));
    return Object.freeze({ outcomes: Object.freeze(outcomes) });
  }
  if (retained.value.triage_outcome === "no-change" && retained.value.triage_digest !== undefined) {
    outcomes.push(Object.freeze({
      action: "triage-no-change", review, triage_digest: retained.value.triage_digest,
      reason: "Human triaged the retained supplemental review with no accepted artifact change.",
    }));
  } else if (retained.value.triage_outcome === "accepted-change" && retained.value.triage_digest !== undefined) {
    const facts = Object.freeze({
      action: "supersede", review,
      accepted_triage_digest: retained.value.triage_digest,
      old_subject_digest: active.subject_digest,
      new_subject_digest_from: "envelope.artifact_digest",
      reason: "Human accepted supplemental triage and revised the bound subject.",
    } as const);
    if (currentSubjectDigest !== undefined && currentSubjectDigest !== active.subject_digest) {
      outcomes.push(Object.freeze({
        action: "supersede", review,
        accepted_triage_digest: retained.value.triage_digest,
        old_subject_digest: active.subject_digest,
        new_subject_digest: currentSubjectDigest,
        reason: facts.reason,
      }));
    }
    return Object.freeze({ outcomes: Object.freeze(outcomes), supersession: facts });
  }
  return Object.freeze({ outcomes: Object.freeze(outcomes) });
}

async function gateStatus(
  dependencies: GateLifecycleDependencies,
  authority: TransactionAuthority,
  active: ActiveGateV1,
  inputFingerprint: Sha256Digest,
  currentSubjectDigest?: Sha256Digest,
): Promise<OpenGateStatus> {
  const supplemental = await supplementalOutcomeTemplates(
    dependencies, authority, active, inputFingerprint, currentSubjectDigest,
  );
  return Object.freeze({
    gate_id: active.gate_id,
    kind: active.kind,
    decision_path: "gate.decision",
    archive_decision_path: `decisions/${active.gate_id}/decision.json`,
    request_path: `decisions/${active.gate_id}/request.json`,
    gate_counter_review_path: gateCounterReviewClaim(active.phase_instance, active.gate_id),
    decision_templates: buildGateDecisionTemplates(active),
    counter_review_prompt: renderGateCounterPrompt({
      tool: active.context !== null && typeof active.context === "object" && "origin" in active.context
        ? "archflow_waiver"
        : "archflow_gate",
      gate_id: active.gate_id,
      request_digest: active.request_digest,
      task_id: active.task_id,
      phase_instance: active.phase_instance,
      kind: active.kind,
      subject_digest: active.subject_digest,
      context_digest: active.context_digest,
      input_fingerprint: inputFingerprint,
      current_evidence: active.current_evidence,
    }),
    supplemental_outcomes: supplemental.outcomes,
    ...(supplemental.supersession === undefined ? {} : { supplemental_supersession: supplemental.supersession }),
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
): CommitAuthorizationInput {
  if (subject.artifact.artifact_kind !== "implementation-output") {
    throw new TypeError("commit authorization requires retained implementation output");
  }
  const manifest = subject.retained.prepared.manifest.value;
  if (manifest.artifact_digest !== subject.artifact_digest) {
    throw new TypeError("commit authorization manifest subject disagrees");
  }
  return Object.freeze({
    kind: "commit-authorization",
    subject_digest: subject.artifact_digest,
    current_evidence: currentEvidence,
    context: Object.freeze({
      target_ref: target.value,
      diff_digest: subject.artifact.diff_digest,
      current_artifact_digests: Object.freeze([manifest.artifact_digest]),
      parent_document_digests: Object.freeze(subject.artifact.parent_documents
        .map((item) => item.content_digest).sort()),
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
    if (read.kind !== "valid") {
      config = unavailableConfig(state.config_digest, undefined, `config-${read.kind}`);
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
      const producer = resolveDispatchRoute(parsedConfig, phaseKind, "producer", "claude");
      routes = Object.freeze({ producer });
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
      // expected re-entry edits can be recognized before they are treated as blocking drift.
    } else {
      blockers.push("reconciliation-unavailable");
    }
  } catch {
    blockers.push("reconciliation-unavailable");
  }

  let retained: RetainedEvidenceSet = new Map();
  if (dependencies.load_retained_result === undefined) {
    blockers.push("retained-evidence-unavailable");
  } else {
    try {
      const loaded = await loadRetainedEvidence(
        { load_retained_result: dependencies.load_retained_result }, state, state.phase_instance,
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

  const authenticatedApprovals = [];
  const approvalFacts = [];
  for (const approval of state.approvals) {
    try {
      const loaded = await loadAuthenticatedGateApproval(dependencies, authority, approval);
      if (loaded.ok) {
        authenticatedApprovals.push(loaded.value);
        approvalFacts.push(Object.freeze({ gate_kind: approval.gate_kind, subject_digest: approval.subject_digest }));
      } else {
        blockers.push(`approval-${approval.gate_id}-unavailable`);
      }
    } catch {
      blockers.push(`approval-${approval.gate_id}-unavailable`);
    }
  }

  let commitObserved = false;
  if (produceSubject?.artifact.artifact_kind === "implementation-output") {
    for (const authenticated of authenticatedApprovals) {
      if (
        authenticated.request.kind !== "commit-authorization" ||
        authenticated.request.phase_instance !== state.phase_instance ||
        authenticated.request.subject_digest !== produceSubject.artifact_digest
      ) continue;
      try {
        if (await implementationOutputCommittedAtCurrentTarget(
          dependencies.runner,
          produceSubject.artifact,
          authenticated.request.context.target_ref,
        )) {
          commitObserved = true;
          break;
        }
      } catch {
        blockers.push("commit-observation-unavailable");
      }
    }
  }

  const declaredPredecessor = !midProduce && produceSubject?.artifact.artifact_kind === "document"
    ? produceSubject.artifact.editorial_predecessor
    : undefined;
  let assessment: EvidenceAssessment | undefined;
  if (constitution !== undefined && subjectDigest !== undefined) {
    try {
      const approvedUpstreamDigests = await currentApprovedUpstreams(
        dependencies, state, authenticatedApprovals,
      );
      assessment = assessCurrentEvidence(state, retained, {
        subject_digest: subjectDigest,
        input_fingerprint: state.input_fingerprint,
        constitution,
        ...(declaredPredecessor === undefined ? {} : {
          editorial_predecessor: Object.freeze({
            subject_digest: declaredPredecessor.subject_digest,
            input_fingerprint: declaredPredecessor.input_fingerprint,
          }),
        }),
        approved_upstream_digests: approvedUpstreamDigests,
        authenticated_gate_approvals: authenticatedApprovals,
        ...(parsedConfig?.max_attempts === undefined ? {} : { max_attempts: parsedConfig.max_attempts }),
      });
    } catch {
      blockers.push("fixed-point-disagreement");
    }
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
      activeGate = await readActiveGate(authority);
      const request = activeGate === undefined ? undefined : await readArchivedGateRequest(authority, activeGate);
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
        openGate = await gateStatus(
          dependencies, authority, activeGate, state.input_fingerprint, subjectDigest,
        );
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
  const nextAction = deriveNextAction({
    repository_initialized: true,
    state,
    config_verified: config.verified,
    ...(statusReconciliation === undefined ? {} : { reconciliation_findings: statusReconciliation.findings }),
    reconciliation_blocking_reasons: Object.freeze([
      ...reconciliationBlockers,
      ...(gateBindingBlocker === undefined ? [] : [gateBindingBlocker]),
    ]),
    ...(activeGate === undefined ? {} : {
      untriaged_supplemental_review: activeGate.supplemental.some((item) => item.action === "ingest"),
    }),
    ...(assessment === undefined ? {} : { assessment }),
    evidence_available: evidence.available,
    ...(subjectDigest === undefined ? {} : { subject_digest: subjectDigest }),
    authenticated_approvals: approvalFacts,
    commit_observed: commitObserved,
    ...(adjudicationGateKind === undefined ? {} : { adjudication_gate_kind: adjudicationGateKind }),
    ...(pendingGates.length === 0 ? {} : { pending_adjudication_gate_kinds: pendingGates.map((gate) => gate.kind) }),
  });

  let gateInput: CommitAuthorizationInput | undefined;
  if (
    nextAction.code === "open-gate" && nextAction.gate_kind === "commit-authorization" &&
    produceSubject?.artifact.artifact_kind === "implementation-output" && evidence.available
  ) {
    const target = await currentTargetRef(dependencies);
    gateInput = buildCommitAuthorizationInput(produceSubject, evidence.current_evidence, target);
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
    ...(adjudicationGate === undefined ? {} : { adjudication_gate: adjudicationGate }),
    maximum_attempts: parsedConfig?.max_attempts ?? DEFAULT_MAX_ATTEMPTS,
  });

  return ok(Object.freeze({
    task_id: authority.task_id,
    state: state.terminal ?? "active",
    revision: state.revision,
    phase_instance: state.phase_instance,
    step: state.step,
    status: state.status,
    attempt: state.attempt,
    input_fingerprint: state.input_fingerprint,
    ...(subjectDigest === undefined ? {} : { subject_digest: subjectDigest }),
    config,
    ...(routes === undefined ? {} : { routes }),
    ...(constitutionStatus === undefined ? {} : { constitution: constitutionStatus }),
    ...(state.open_gate === undefined ? {} : { open_gate_id: state.open_gate.gate_id }),
    ...(openGate === undefined ? {} : { open_gate: openGate }),
    ...(statusReconciliation === undefined ? {} : { reconciliation: statusReconciliation }),
    evidence,
    ...(editorialRevision === undefined ? {} : { editorial_revision: editorialRevision }),
    ...(gateInput === undefined ? {} : { gate_input: gateInput }),
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

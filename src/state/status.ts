import { readFile } from "node:fs/promises";
import { join } from "node:path";

import { canonicalJsonDigest, parseCanonicalDocument } from "../contracts/canonical.js";
import { selectGreatestValidChain, type ChainAnchor } from "../contracts/durable-checkpoint.js";
import { parseConfigYaml } from "../contracts/config.js";
import { parseActiveGate, parseGateRequest, type ActiveGateV1, type GateRequestV1 } from "../contracts/durable-gate.js";
import type { TaskStateV1 } from "../contracts/durable-state.js";
import { createProjectError, type ProjectResult } from "../contracts/errors.js";
import { computeGateContextDigest, verifyPinnedConfig } from "../contracts/fingerprints.js";
import type { PathSafeId, Sha256Digest, TaskSlug } from "../contracts/evidence.js";
import { decodePhaseInstance, type PhaseInstanceId } from "../contracts/phase-instance.js";
import type { PlainJsonValue } from "../contracts/plain-json.js";
import type { ReviewEvidence } from "../contracts/review.js";
import type { CurrentEvidenceSetRef } from "../contracts/trust.js";
import type { SupplementalReviewOutcome, SupplementalReviewRef } from "../contracts/supplemental.js";
import { resolveDispatchRoute, type DispatchRoute } from "../dispatch/routing.js";
import { renderGateCounterPrompt } from "../local/envelope.js";
import { selectAdjudicationGates } from "../review/adjudication.js";
import { assessCurrentEvidence, waiverInForce, type EvidenceAssessment } from "../review/fixed-point.js";
import { readTaskState } from "./read.js";
import type { TransactionAuthority } from "./authority.js";
import { assertInternalTransactionAuthority } from "./authority.js";
import { resolvePinnedConstitution, type ResolvedConstitution } from "./constitution.js";
import { deriveCurrentEvidenceSet, loadRetainedEvidence, type RetainedEvidenceSet } from "./evidence-results.js";
import {
  buildGateDecisionTemplates,
  loadAuthenticatedGateApproval,
  type AuthenticatedGateApproval,
  type GateLifecycleDependencies,
} from "./gates.js";
import { readManualCheckpoints } from "./manual-checkpoints.js";
import { deriveNextAction, type NextAction } from "./next-action.js";
import { expectedProduceUpstreamBindings, loadCurrentProduceSubject, loadProduceUpstreamSubject } from "./produce-subject.js";
import type { CurrentProduceSubject } from "./produce-subject.js";
import { implementationOutputCommittedAtCurrentTarget } from "./implementation-manifest.js";
import { discoverReconciliationInput } from "./reconciliation-discovery.js";
import { activeGateHead, reconcileCurrentAuthority, type ReconciliationResult } from "./reconciliation.js";
import type { TransactionDependencies } from "./transaction.js";
import { gateCounterReviewClaim } from "../repository/paths.js";

export type DegradedStatus = Readonly<{
  task_id: TaskSlug;
  state: "missing" | "active" | "complete" | "abandoned";
  revision?: number;
  phase_instance?: PhaseInstanceId;
  step?: TaskStateV1["step"];
  status?: TaskStateV1["status"];
  checkpoint_head_revision?: number;
  open_gate_id?: PathSafeId;
  blocking_reasons: readonly string[];
}>;

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
  findings: readonly Readonly<{
    review_evidence_digest: Sha256Digest;
    finding_id: string;
    blocking: boolean;
  }>[];
  self_review_provenance: Readonly<{
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

export type TaskStatusV1 = DegradedStatus & Readonly<{
  attempt?: number;
  input_fingerprint?: Sha256Digest;
  config: ConfigVerification;
  routes?: Readonly<{ producer: DispatchRoute; self_review: DispatchRoute }>;
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
  reconciliation?: ReconciliationResult;
  evidence?: StatusEvidence;
  gate_input?: CommitAuthorizationInput;
  next_action: NextAction;
}>;

/** Checkpoint revisions continue from adopted checkpoint authority, not from state CAS revisions. */
export function manualCheckpointHeadIsPending(
  state: Pick<TaskStateV1, "revision" | "adopted_checkpoint">,
  checkpointHead: number | undefined,
): boolean {
  return checkpointHead !== undefined &&
    checkpointHead > (state.adopted_checkpoint?.revision ?? state.revision);
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

function pendingAdjudicationGateKind(
  state: TaskStateV1,
  constitution: ResolvedConstitution,
  retained: RetainedEvidenceSet,
  authenticated: readonly AuthenticatedGateApproval[],
): ActiveGateV1["kind"] | undefined {
  const source = retained.get("adjudicate")?.manifest.source_artifact;
  if (source?.artifact_kind !== "adjudication-evidence") return undefined;
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
    if ((gate.kind === "review-trigger" || gate.kind === "adjudication-failure") &&
        "eligible_waiver_rules" in gate.context && "waiver_scope" in gate.context) {
      const waiverContext = gate.context;
      waived = waiverContext.eligible_waiver_rules.length > 0 &&
        waiverContext.eligible_waiver_rules.every((rule) =>
          waiverInForce(state, rule, gate.subject_digest, waiverContext.waiver_scope) !== undefined);
    }
    if (!approved && !waived) return gate.kind;
  }
  return undefined;
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

async function currentTargetRef(dependencies: GateLifecycleDependencies): Promise<Readonly<{
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
      next_action: next,
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
      next_action: next,
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
      const selfReview = resolveDispatchRoute(parsedConfig, phaseKind, "self-reviewer", producer.family);
      if (producer.family !== selfReview.family) throw new TypeError("producer and self-review routes must share a family");
      routes = Object.freeze({ producer, self_review: selfReview });
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
      blockers.push(...reconciliation.findings.map((finding) => finding.kind));
    } else {
      blockers.push("reconciliation-unavailable");
    }
  } catch {
    blockers.push("reconciliation-unavailable");
  }

  let checkpointHead: number | undefined;
  try {
    const checkpoints = await readManualCheckpoints(dependencies, authority);
    if (checkpoints.ok) {
      const checkpointAnchor: ChainAnchor = state.adopted_checkpoint === undefined
        ? Object.freeze({
            mode: "state" as const,
            task_id: authority.task_id,
            repository_identity_digest: authority.repository_identity_digest,
            state_anchor: Object.freeze({
              anchor_kind: "state" as const,
              state_revision: state.revision,
              state_digest: stateDocument.digest,
            }),
          })
        : Object.freeze({
            mode: "continuation" as const,
            task_id: authority.task_id,
            repository_identity_digest: authority.repository_identity_digest,
            predecessor: state.adopted_checkpoint,
          });
      const selected = selectGreatestValidChain(
        checkpointAnchor,
        checkpoints.value.map((checkpoint) => checkpoint.value),
      );
      if (selected.kind === "chain") checkpointHead = selected.chain.at(-1)?.revision;
      else blockers.push(`checkpoint-${selected.outcome}`);
    } else blockers.push("checkpoint-inventory-unavailable");
  } catch {
    blockers.push("checkpoint-inventory-unavailable");
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
  if (state.step !== "produce" || state.status === "succeeded") {
    try {
      const produced = await loadCurrentProduceSubject(dependencies, state);
      if (produced.ok) {
        produceSubject = produced.value;
        subjectDigest = produced.value.artifact_digest;
      }
      else blockers.push("current-subject-unavailable");
    } catch {
      blockers.push("current-subject-unavailable");
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
        approved_upstream_digests: approvedUpstreamDigests,
        authenticated_gate_approvals: authenticatedApprovals,
        ...(parsedConfig?.max_attempts === undefined ? {} : { max_attempts: parsedConfig.max_attempts }),
      });
    } catch {
      blockers.push("fixed-point-disagreement");
    }
  }

  let evidence: StatusEvidence;
  try {
    const derived = deriveCurrentEvidenceSet(retained);
    if (assessment === undefined) throw new TypeError("evidence assessment unavailable");
    const findings = derived.reviews.flatMap((review) => review.evidence.findings.map((finding) => Object.freeze({
      review_evidence_digest: review.evidence_digest,
      finding_id: finding.finding_id,
      blocking: finding.blocking,
    })));
    const self = derived.reviews[0]!.evidence;
    evidence = Object.freeze({
      available: true,
      subject_digest: derived.subject_digest,
      current_evidence: derived.current_evidence_set,
      findings: Object.freeze(findings),
      self_review_provenance: Object.freeze({
        assurance: self.assurance,
        producer_family: self.producer_family,
        model_family: self.model_family,
        model: self.model,
        effort: self.effort,
      }),
      assessment,
    });
  } catch {
    evidence = Object.freeze({
      available: false,
      reason: retained.has("self_review") && retained.has("counter_review")
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
  if (manualCheckpointHeadIsPending(state, checkpointHead)) blockers.push("checkpoint-import-available");

  let adjudicationGateKind: Parameters<typeof deriveNextAction>[0]["adjudication_gate_kind"];
  if (assessment?.next === "adjudication-gate" && constitution !== undefined) {
    adjudicationGateKind = pendingAdjudicationGateKind(state, constitution, retained, authenticatedApprovals);
  }
  const nextAction = deriveNextAction({
    repository_initialized: true,
    state,
    config_verified: config.verified,
    ...(reconciliation === undefined ? {} : { reconciliation_findings: reconciliation.findings }),
    reconciliation_blocking_reasons: Object.freeze([
      ...reconciliationBlockers,
      ...(gateBindingBlocker === undefined ? [] : [gateBindingBlocker]),
    ]),
    ...(activeGate === undefined ? {} : {
      untriaged_supplemental_review: activeGate.supplemental.some((item) => item.action === "ingest"),
    }),
    ...(checkpointHead === undefined ? {} : { checkpoint_head_revision: checkpointHead }),
    ...(assessment === undefined ? {} : { assessment }),
    evidence_available: evidence.available,
    ...(subjectDigest === undefined ? {} : { subject_digest: subjectDigest }),
    authenticated_approvals: approvalFacts,
    commit_observed: commitObserved,
    ...(adjudicationGateKind === undefined ? {} : { adjudication_gate_kind: adjudicationGateKind }),
  });

  let gateInput: CommitAuthorizationInput | undefined;
  if (
    nextAction.code === "open-gate" && nextAction.gate_kind === "commit-authorization" &&
    produceSubject?.artifact.artifact_kind === "implementation-output" && evidence.available
  ) {
    const target = await currentTargetRef(dependencies);
    gateInput = buildCommitAuthorizationInput(produceSubject, evidence.current_evidence, target);
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
    config,
    ...(routes === undefined ? {} : { routes }),
    ...(constitutionStatus === undefined ? {} : { constitution: constitutionStatus }),
    ...(checkpointHead === undefined ? {} : { checkpoint_head_revision: checkpointHead }),
    ...(state.open_gate === undefined ? {} : { open_gate_id: state.open_gate.gate_id }),
    ...(openGate === undefined ? {} : { open_gate: openGate }),
    ...(reconciliation === undefined ? {} : { reconciliation }),
    evidence,
    ...(gateInput === undefined ? {} : { gate_input: gateInput }),
    blocking_reasons: Object.freeze([...new Set(blockers)]),
    next_action: nextAction,
  }));
}

/** Computes a read-only, explicitly degraded summary from durable local authority. */
export async function computeDegradedStatus(
  dependencies: TransactionDependencies,
  authority: TransactionAuthority,
): Promise<ProjectResult<DegradedStatus>> {
  assertInternalTransactionAuthority(authority, dependencies);
  const stateRead = await readTaskState(authority.state);
  if (stateRead.kind === "unreadable" || stateRead.kind === "noncanonical") {
    return Object.freeze({
      schema_version: "1",
      ok: false,
      error: createProjectError("STATE_INVALID", {
        phase_instance: authority.context.phase_instance,
        issue_code: stateRead.kind === "unreadable" ? "state-unreadable" : "state-noncanonical",
      }),
    });
  }
  const checkpoints = await readManualCheckpoints(dependencies, authority);
  if (!checkpoints.ok) return checkpoints;
  const candidates = checkpoints.value.map((checkpoint) => checkpoint.value);
  let anchor: ChainAnchor;
  if (stateRead.kind === "missing") {
    anchor = Object.freeze({
      mode: "initial",
      task_id: authority.task_id,
      repository_identity_digest: authority.repository_identity_digest,
    });
  } else if (stateRead.kind === "canonical" && stateRead.document.value.adopted_checkpoint !== undefined) {
    anchor = Object.freeze({
      mode: "continuation",
      task_id: authority.task_id,
      repository_identity_digest: authority.repository_identity_digest,
      predecessor: stateRead.document.value.adopted_checkpoint,
    });
  } else if (stateRead.kind === "canonical") {
    anchor = Object.freeze({
      mode: "state",
      task_id: authority.task_id,
      repository_identity_digest: authority.repository_identity_digest,
      state_anchor: Object.freeze({
        anchor_kind: "state",
        state_revision: stateRead.document.value.revision,
        state_digest: stateRead.document.digest,
      }),
    });
  } else {
    throw new TypeError("unreachable state read classification");
  }
  const selected = selectGreatestValidChain(anchor, candidates);
  const head = selected.kind === "chain" ? selected.chain.at(-1)?.revision : undefined;
  const chainBlocker = selected.kind === "stop" ? `checkpoint-${selected.outcome}` : undefined;
  if (stateRead.kind === "missing") {
    return ok(Object.freeze({
      task_id: authority.task_id,
      state: "missing" as const,
      ...(head === undefined ? {} : { checkpoint_head_revision: head }),
      blocking_reasons: Object.freeze(["state-missing", ...(chainBlocker === undefined ? [] : [chainBlocker])]),
    }));
  }
  if (stateRead.kind !== "canonical") throw new TypeError("unreachable state read classification");
  const state = stateRead.document.value;
  const blockers: string[] = [];
  if (chainBlocker !== undefined) blockers.push(chainBlocker);
  if (state.open_gate !== undefined) blockers.push("gate-decision-required");
  if (manualCheckpointHeadIsPending(state, head)) blockers.push("checkpoint-import-available");
  return ok(Object.freeze({
    task_id: authority.task_id,
    state: state.terminal ?? "active",
    revision: state.revision,
    phase_instance: state.phase_instance,
    step: state.step,
    status: state.status,
    ...(head === undefined ? {} : { checkpoint_head_revision: head }),
    ...(state.open_gate === undefined ? {} : { open_gate_id: state.open_gate.gate_id }),
    blocking_reasons: Object.freeze(blockers),
  }));
}

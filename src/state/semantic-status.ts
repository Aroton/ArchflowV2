import { isDeepStrictEqual } from "node:util";

import { canonicalJsonDigest, type CanonicalDocument } from "../contracts/canonical.js";
import { parseArchivedGateDecisionRecord, parseArchivedGateRequest, type ArchivedGateDecisionRecordV1, type ArchivedGateRequestV1 } from "../contracts/durable-gate.js";
import type { TaskStateV1 } from "../contracts/durable-state.js";
import { validateDurableSemantics } from "../contracts/durable.js";
import type { ProjectResult } from "../contracts/errors.js";
import { parsePathSafeId, parseSha256Digest, type PathSafeId, type Sha256Digest } from "../contracts/evidence.js";
import { comparePhaseInstances, decodePhaseInstance, encodePhaseInstance, parsePositiveSafePhaseNumber, type PhaseInstanceId } from "../contracts/phase-instance.js";
import { assertPlainJson, type PlainJsonValue } from "../contracts/plain-json.js";
import {
  publicFindingV1Schema,
  type PublicFindingV1,
  type SemanticStatusSnapshotV1,
  type WorkflowReopenImpactV1,
  type PublicReviewRoundV1,
  type TaxonomyDenialRates,
  publicReviewRoundV1Schema,
  defaultImplementationRecommendation,
  implementationRecommendationFromAssessment,
  implementationRecommendationV1Schema,
  unavailableImplementationRecommendation,
  type ImplementationRecommendationV1,
  publicReviewPushThroughAuditV1Schema,
  publicValidationOverrideAuditV1Schema,
  type PublicReviewPushThroughAuditV1,
  type PublicValidationOverrideAuditV1,
} from "../contracts/semantic-workflow.js";
import {
  CLAIM_TYPES,
  CONFIDENCE_LEVELS,
  type ClaimType,
  type ConfidenceLevel,
} from "../contracts/review.js";
import {
  triageDispositionLedgerEntrySchema,
  type TriageDispositionLedgerEntry,
} from "../contracts/triage.js";
import { gateDecisionClaim, gateRequestClaim, resolveTaskPath } from "../repository/paths.js";
import type { TransactionAuthority } from "./authority.js";
import { deriveCurrentEvidenceSet, loadGoverningPhaseDesignEffortEvidence } from "./evidence-results.js";
import { readCanonical, type GateLifecycleDependencies } from "./gate-core.js";
import { computeTaskStatusDetailed, type DetailedTaskStatusV1, type TaskStatusV1 } from "./status.js";
import { isWaiverOriginRequest } from "./waiver-origin.js";

/**
 * Enrichments that detailed status obtains while it still owns the canonical read. They are
 * deliberately explicit: callers may not recover review prose, restart eligibility, or decision
 * authority from the smaller serialized status projection after the read lock has been released.
 */
export type SemanticStatusEnrichmentsV1 = Readonly<{
  repository_identity_digest: Sha256Digest;
  state?: TaskStateV1;
  state_document_digest?: Sha256Digest;
  live_config_digest?: Sha256Digest;
  legacy_import_initialization?: true;
  full_findings: readonly PublicFindingV1[];
  review_rounds?: readonly PublicReviewRoundV1[];
  taxonomy_denial_rates: TaxonomyDenialRates;
  implementation_recommendation: ImplementationRecommendationV1;
  validation_overrides?: readonly PublicValidationOverrideAuditV1[];
  review_push_throughs?: readonly PublicReviewPushThroughAuditV1[];
  pending_waiver_origin?: PlainJsonValue;
  archived_decision?: PlainJsonValue;
  revision_checkpoint?: PlainJsonValue;
  reopen_impacts?: readonly WorkflowReopenImpactV1[];
}>;

const ok = <T>(value: T): ProjectResult<T> => Object.freeze({ schema_version: "1", ok: true, value });

/** Selects only the phase design that governs effort advice at the current durable position. */
export function governingRecommendationPhase(state: TaskStateV1 | undefined): number | undefined {
  if (state === undefined) return undefined;
  const decoded = decodePhaseInstance(state.phase_instance);
  if (decoded.kind === "phase-design" || decoded.kind === "phase-impl") return Number(decoded.phase);
  if (state.terminal === "complete" && state.planned_final_phase !== undefined) {
    return Number(state.planned_final_phase);
  }
  return undefined;
}

/** Internal semantic-status enrichment seam; exported for direct authority/read-path verification. */
export async function currentImplementationRecommendation(
  dependencies: GateLifecycleDependencies,
  authority: TransactionAuthority,
  details: DetailedTaskStatusV1,
): Promise<ImplementationRecommendationV1> {
  const phase = governingRecommendationPhase(details.state);
  if (details.state === undefined || phase === undefined) {
    return unavailableImplementationRecommendation(
      "not-applicable",
      "Implementation effort advice does not apply at the current workflow position.",
    );
  }
  const phaseInstance = encodePhaseInstance({
    kind: "phase-design",
    phase: parsePositiveSafePhaseNumber(phase),
  });
  const hasProduce = details.state.authoritative_results.some((reference) =>
    reference.phase_instance === phaseInstance && reference.step === "produce");
  const hasReview = details.state.authoritative_results.some((reference) =>
    reference.phase_instance === phaseInstance && reference.step === "counter_review");
  if (!hasProduce || !hasReview) {
    return unavailableImplementationRecommendation(
      "not-produced",
      "No authenticated effort assessment has been produced for the governing phase design.",
      phase,
    );
  }
  if (dependencies.load_retained_manifest === undefined) {
    throw new TypeError("governing effort evidence loading is unavailable");
  }
  const loaded = await loadGoverningPhaseDesignEffortEvidence(
    { load_retained_manifest: dependencies.load_retained_manifest },
    details.state,
    phaseInstance,
  );
  if (!loaded.ok) throw new TypeError("governing effort evidence is unavailable or invalid");
  const { produce, review, assessment } = loaded.value;
  if (review === undefined) {
    return unavailableImplementationRecommendation(
      "not-produced",
      "No authenticated effort assessment has been produced for the governing phase design.",
      phase,
    );
  }
  if (review.subject_digest !== produce.artifact_digest) {
    return unavailableImplementationRecommendation(
      "subject-stale",
      "The retained effort assessment describes earlier phase-design bytes and is not current.",
      phase,
    );
  }
  if (review.assurance !== "server-attested" || assessment === undefined) return defaultImplementationRecommendation();
  return implementationRecommendationFromAssessment(assessment, phase);
}

function workflowPosition(phase: PhaseInstanceId): WorkflowReopenImpactV1["target"] {
  const decoded = decodePhaseInstance(phase);
  return decoded.kind === "prd" || decoded.kind === "design"
    ? Object.freeze({ kind: decoded.kind })
    : Object.freeze({ kind: decoded.kind, phase: Number(decoded.phase) });
}

function planningTargetsBefore(current: PhaseInstanceId): readonly PhaseInstanceId[] {
  const decoded = decodePhaseInstance(current);
  const candidates: PhaseInstanceId[] = [
    encodePhaseInstance({ kind: "prd" }),
    encodePhaseInstance({ kind: "design" }),
  ];
  const maximum = decoded.kind === "phase-design" || decoded.kind === "phase-impl" ? decoded.phase : 0;
  for (let phase = 1; phase <= maximum; phase += 1) {
    const target = encodePhaseInstance({ kind: "phase-design", phase: parsePositiveSafePhaseNumber(phase) });
    if (comparePhaseInstances(target, current) < 0) candidates.push(target);
  }
  return Object.freeze(candidates.filter((target) => comparePhaseInstances(target, current) < 0));
}

function reopenImpacts(state: TaskStateV1, status: TaskStatusV1): readonly WorkflowReopenImpactV1[] {
  if (state.terminal !== undefined || state.open_gate !== undefined || status.blocking_reasons.length !== 0) return Object.freeze([]);
  return Object.freeze(planningTargetsBefore(state.phase_instance).map((target) => {
    const affected = new Set<PhaseInstanceId>([state.phase_instance]);
    for (const reference of state.authoritative_results) {
      if (comparePhaseInstances(reference.phase_instance, target) >= 0) affected.add(reference.phase_instance);
    }
    const targetKind = decodePhaseInstance(target).kind;
    const authorityEffects: WorkflowReopenImpactV1["authority_effects"][number][] = [];
    if (state.authoritative_results.some((reference) => comparePhaseInstances(reference.phase_instance, target) >= 0)) authorityEffects.push("supersede-results");
    if (state.waivers.length !== 0) authorityEffects.push("clear-active-waivers");
    if (state.pending_human_revision !== undefined) authorityEffects.push("clear-pending-human-revision");
    if ((targetKind === "prd" || targetKind === "design") && state.planned_final_phase !== undefined) authorityEffects.push("clear-planned-final-phase");
    return Object.freeze({
      target: workflowPosition(target),
      affected_positions: Object.freeze([...affected]
        .filter((phase) => comparePhaseInstances(phase, target) >= 0)
        .sort(comparePhaseInstances)
        .map(workflowPosition)),
      authority_effects: Object.freeze(authorityEffects),
      planned_final_phase: targetKind === "prd" || targetKind === "design" ? "clear" : "retain",
      preserves_existing_git_index_and_worktree_bytes: true as const,
      appends_prd_ask_history: targetKind === "prd",
      requires_fresh_review_and_approval: true as const,
    });
  }));
}

async function archivedGate(
  dependencies: GateLifecycleDependencies,
  authority: TransactionAuthority,
  gateId: PathSafeId,
): Promise<Readonly<{
  request: "missing" | "invalid" | CanonicalDocument<ArchivedGateRequestV1>;
  decision: "missing" | "invalid" | CanonicalDocument<ArchivedGateDecisionRecordV1>;
}>> {
  const requestPath = await resolveTaskPath({ runner: dependencies.runner, taskId: authority.task_id, claim: gateRequestClaim(gateId), expectedClass: "authority-decision", context: authority.context });
  const decisionPath = await resolveTaskPath({ runner: dependencies.runner, taskId: authority.task_id, claim: gateDecisionClaim(gateId), expectedClass: "authority-decision", context: authority.context });
  if (!requestPath.ok || !decisionPath.ok) return Object.freeze({ request: "invalid" as const, decision: "invalid" as const });
  return Object.freeze({
    request: await readCanonical(requestPath.value, "semantic gate request", parseArchivedGateRequest),
    decision: await readCanonical(decisionPath.value, "semantic gate decision", parseArchivedGateDecisionRecord),
  });
}

function materializeJson<T>(value: T, label: string): T {
  assertPlainJson(value, label);
  return structuredClone(value);
}

/**
 * Per-attempt review history of the current phase instance. Earlier rounds come from the retained
 * triage's carried disposition ledger (every finding of a round is dispositioned, so the ledger is
 * the round); the current attempt is read from the current review evidence itself, joined to the
 * current triage when one is installed, so a round whose triage has not yet landed still counts.
 */
export type TaxonomyDenialRateKey = `${ClaimType}:${ConfidenceLevel}`;

/** Rejected / dispositioned occurrences for every native V2 taxonomy cell. */
export function computeTaxonomyDenialRates(
  ledger: readonly TriageDispositionLedgerEntry[],
): TaxonomyDenialRates {
  const occurrences = new Map<string, TriageDispositionLedgerEntry>();
  for (const candidate of ledger) {
    const entry = triageDispositionLedgerEntrySchema.parse(candidate);
    occurrences.set(`${entry.review_evidence_digest}:${entry.finding_id}`, entry);
  }
  const rates: Record<string, number> = {};
  for (const claimType of CLAIM_TYPES) {
    for (const confidence of CONFIDENCE_LEVELS) {
      const key: TaxonomyDenialRateKey = `${claimType}:${confidence}`;
      const cell = [...occurrences.values()].filter((entry) =>
        "claim_type" in entry && entry.claim_type === claimType && entry.confidence === confidence);
      rates[key] = cell.length === 0
        ? 0
        : cell.filter((entry) => entry.disposition === "rejected").length / cell.length;
    }
  }
  return Object.freeze(rates as TaxonomyDenialRates);
}

function reviewRounds(details: DetailedTaskStatusV1): readonly PublicReviewRoundV1[] {
  if (details.status.evidence?.available !== true) return Object.freeze([]);
  const current = deriveCurrentEvidenceSet(details.retained);
  const triage = details.retained.get("triage")?.manifest.source_artifact;
  type RoundAccumulator = {
    version?: "1" | "2";
    findings: number;
    blocking: number;
    accepted: number;
    partitions: Record<string, number>;
  };
  const emptyPartitions = (): Record<string, number> => Object.fromEntries(
    CLAIM_TYPES.flatMap((claimType) => CONFIDENCE_LEVELS.map((confidence) =>
      [`${claimType}:${confidence}`, 0])),
  );
  const rounds = new Map<number, RoundAccumulator>();
  const roundAt = (attempt: number): RoundAccumulator => {
    const round = rounds.get(attempt) ?? {
      findings: 0, blocking: 0, accepted: 0, partitions: emptyPartitions(),
    };
    rounds.set(attempt, round);
    return round;
  };
  const setVersion = (round: RoundAccumulator, version: "1" | "2", label: string): void => {
    if (round.version !== undefined && round.version !== version) {
      throw new TypeError(`${label} mixes V1 and V2 review findings`);
    }
    round.version = version;
  };
  const isAccepted = (disposition: string): boolean =>
    disposition === "accepted" || disposition === "accepted-editorial";
  const currentAttempt = details.status.attempt;
  if (triage?.artifact_kind === "triage") {
    // Seed every completed round before counting its findings. The separate history is what keeps
    // finding-free rounds and byte-identical recurring feedback visible after older result
    // manifests leave the active authority set.
    for (const entry of triage.evidence.review_round_history ?? []) {
      roundAt(entry.attempt);
    }
    for (const entry of triage.evidence.disposition_ledger ?? []) {
      if (currentAttempt !== undefined && entry.attempt === currentAttempt) continue;
      const round = roundAt(entry.attempt);
      round.findings += 1;
      if (isAccepted(entry.disposition)) round.accepted += 1;
      if ("claim_type" in entry) {
        setVersion(round, "2", `review attempt ${entry.attempt}`);
        const key = `${entry.claim_type}:${entry.confidence}`;
        round.partitions[key] = (round.partitions[key] ?? 0) + 1;
      } else {
        // Detail-less archived occurrences retain their known finding/disposition facts without
        // inventing a lost severity classification.
        setVersion(round, "1", `review attempt ${entry.attempt}`);
        if ("blocking" in entry && entry.blocking) round.blocking += 1;
      }
    }
  }
  if (currentAttempt !== undefined) {
    const dispositions = new Map<string, string>();
    if (triage?.artifact_kind === "triage") {
      for (const disposition of triage.evidence.dispositions) {
        dispositions.set(`${disposition.review_evidence_digest}:${disposition.finding_id}`, disposition.disposition);
      }
    }
    const versions = new Set(current.reviews.map((review) => review.evidence.schema_version));
    if (versions.size !== 1) throw new TypeError(`active review attempt ${currentAttempt} mixes V1 and V2 evidence`);
    const round = roundAt(currentAttempt);
    setVersion(round, current.reviews[0]!.evidence.schema_version, `active review attempt ${currentAttempt}`);
    for (const review of current.reviews) {
      for (const finding of review.evidence.findings) {
        const disposition = dispositions.get(`${review.evidence_digest}:${finding.finding_id}`);
        round.findings += 1;
        if (disposition !== undefined && isAccepted(disposition)) round.accepted += 1;
        if ("claim_type" in finding) {
          if (round.version !== "2") throw new TypeError(`active review attempt ${currentAttempt} mixes V1 and V2 findings`);
          const key = `${finding.claim_type}:${finding.confidence}`;
          round.partitions[key] = (round.partitions[key] ?? 0) + 1;
        } else {
          if (round.version !== "1") throw new TypeError(`active review attempt ${currentAttempt} mixes V1 and V2 findings`);
          if (finding.blocking) round.blocking += 1;
        }
      }
    }
  }
  return Object.freeze([...rounds.entries()]
    .sort(([left], [right]) => left - right)
    .map(([attempt, round]) => Object.freeze(round.version === "2"
      ? { attempt, findings: round.findings, partition_counts: Object.freeze(round.partitions), accepted: round.accepted }
      : { attempt, findings: round.findings, blocking: round.blocking, accepted: round.accepted }) as PublicReviewRoundV1));
}

function fullFindings(details: DetailedTaskStatusV1): readonly PublicFindingV1[] {
  if (details.status.evidence?.available !== true) return Object.freeze([]);
  const current = deriveCurrentEvidenceSet(details.retained);
  const triage = details.retained.get("triage")?.manifest.source_artifact;
  const dispositions = new Map<string, NonNullable<PublicFindingV1["current_disposition"]>>();
  if (triage?.artifact_kind === "triage") {
    for (const disposition of triage.evidence.dispositions) {
      const key = `${disposition.review_evidence_digest}:${disposition.finding_id}`;
      dispositions.set(key,
        disposition.disposition === "rejected"
          ? Object.freeze({ disposition: "rejected", rationale: disposition.rationale, evidence: disposition.evidence })
          : disposition.disposition === "accepted" || disposition.disposition === "accepted-editorial"
            ? Object.freeze({ disposition: disposition.disposition, rationale: disposition.rationale, revision_intent: disposition.revision_intent })
            : disposition.disposition === "deferred" && disposition.evidence !== undefined
              ? Object.freeze({ disposition: "deferred", rationale: disposition.rationale, evidence: disposition.evidence })
              : Object.freeze({ disposition: disposition.disposition, rationale: disposition.rationale }));
    }
  }
  return Object.freeze(current.reviews.flatMap((review) => review.evidence.findings.map((finding) =>
    Object.freeze(publicFindingV1Schema.parse({
      ...finding,
      ...(dispositions.get(`${review.evidence_digest}:${finding.finding_id}`) === undefined ? {} : {
        current_disposition: dispositions.get(`${review.evidence_digest}:${finding.finding_id}`),
      }),
    })) as PublicFindingV1)));
}

/** Cross-authenticates a readable request/decision pair; false means corrupt or forged bytes. */
function archiveAuthenticates(
  request: CanonicalDocument<ArchivedGateRequestV1>,
  decision: CanonicalDocument<ArchivedGateDecisionRecordV1>,
): boolean {
  return validateDurableSemantics({ gate_request: request, gate_decision: decision }).ok;
}

function archiveBinds(
  state: TaskStateV1,
  request: CanonicalDocument<ArchivedGateRequestV1>,
  decision: CanonicalDocument<ArchivedGateDecisionRecordV1>,
): boolean {
  return archiveAuthenticates(request, decision) &&
    request.value.task_id === state.task_id && request.value.phase_instance === state.phase_instance &&
    decision.value.task_id === state.task_id && decision.value.phase_instance === state.phase_instance;
}

function transitionCarriesDecision(outcome: PlainJsonValue, decision: ArchivedGateDecisionRecordV1): boolean {
  if (decision.outcome !== "decided" || outcome === null || Array.isArray(outcome) || typeof outcome !== "object") return false;
  const descriptor = Object.getOwnPropertyDescriptor(outcome, "decision");
  return descriptor?.enumerable === true && "value" in descriptor && isDeepStrictEqual(descriptor.value, decision.envelope);
}

function decisionReenters(record: ArchivedGateDecisionRecordV1): boolean {
  if (record.outcome !== "decided") return false;
  const choice = record.envelope.payload.decision;
  return (record.kind === "artifact-approval" && choice === "revise") ||
    (record.kind === "design-approval" && choice === "revise") ||
    (record.kind === "constitution-review" && choice === "revise") ||
    (record.kind === "material-drift" && choice === "revise-current") ||
    (record.kind === "attempts-exhausted" && (choice === "retry-once" || choice === "revise")) ||
    (record.kind === "commit-authorization" && choice === "revise") ||
    (record.kind === "migration-audit" && choice === "revise");
}

function directDecisionRequestDigest(
  operationDigest: Sha256Digest,
  request: CanonicalDocument<ArchivedGateRequestV1>,
  decision: CanonicalDocument<ArchivedGateDecisionRecordV1>,
): Sha256Digest {
  return canonicalJsonDigest({
    schema_version: "1",
    digest_kind: "direct-semantic-decision-settlement",
    operation_digest: operationDigest,
    gate_request_digest: request.digest,
    gate_decision_digest: decision.digest,
  });
}

function semanticDecisionOperation(decision: ArchivedGateDecisionRecordV1): Sha256Digest | undefined {
  if (decision.outcome === "superseded" || decision.outcome === "superseded-stale-baseline") return undefined;
  const provenance = decision.outcome === "decided" ? decision.envelope.human_provenance : decision.human_provenance;
  if (provenance.channel !== "connected-host") return undefined;
  const match = /^afdecision-([0-9a-f]{64})$/u.exec(provenance.decision_event_id);
  return match?.[1] as Sha256Digest | undefined;
}

function decisionProvenance(decision: ArchivedGateDecisionRecordV1) {
  if (decision.outcome === "superseded" || decision.outcome === "superseded-stale-baseline") return undefined;
  return decision.outcome === "decided" ? decision.envelope.human_provenance : decision.human_provenance;
}

function legacyLocalDecisionSettlementOperation(
  request: CanonicalDocument<ArchivedGateRequestV1>,
  decision: CanonicalDocument<ArchivedGateDecisionRecordV1>,
): Sha256Digest {
  return canonicalJsonDigest({
    schema_version: "1",
    digest_kind: "legacy-local-decision-settlement",
    gate_request_digest: request.digest,
    gate_decision_digest: decision.digest,
  });
}

async function deriveArchiveEnrichments(
  dependencies: GateLifecycleDependencies,
  authority: TransactionAuthority,
  details: DetailedTaskStatusV1,
): Promise<Pick<SemanticStatusEnrichmentsV1, "pending_waiver_origin" | "archived_decision" | "revision_checkpoint">> {
  const state = details.state;
  if (state === undefined) return Object.freeze({});

  if (state.open_gate !== undefined) {
    const archive = await archivedGate(dependencies, authority, state.open_gate.gate_id);
    if (archive.decision === "missing") return Object.freeze({});
    if (archive.request === "missing" || archive.request === "invalid" || archive.decision === "invalid" ||
        !archiveBinds(state, archive.request, archive.decision) ||
        archive.request.value.gate_id !== state.open_gate.gate_id ||
        archive.request.value.kind !== state.open_gate.gate_kind ||
        archive.request.value.subject_digest !== state.open_gate.subject_digest ||
        archive.request.value.context_digest !== state.open_gate.context_digest ||
        archive.request.value.opened_at_revision !== state.open_gate.opened_at_revision ||
        archive.decision.value.outcome === "superseded") {
      return Object.freeze({ archived_decision: Object.freeze({ status: "invalid" }) });
    }
    const provenance = decisionProvenance(archive.decision.value);
    const semanticOperation = semanticDecisionOperation(archive.decision.value);
    if (provenance === undefined || (provenance.channel === "connected-host" && semanticOperation === undefined)) {
      return Object.freeze({ archived_decision: Object.freeze({ status: "invalid" }) });
    }
    const operationDigest = semanticOperation ?? legacyLocalDecisionSettlementOperation(archive.request, archive.decision);
    return Object.freeze({ archived_decision: Object.freeze({
      status: "exact",
      gate_id: archive.request.value.gate_id,
      request_digest: archive.request.digest,
      decision_digest: archive.decision.digest,
      operation_digest: operationDigest,
      ...(semanticOperation === undefined ? { provenance: "pre-facade" } : {}),
    }) });
  }

  const transition = state.last_transition;
  if (transition === undefined || transition.tool !== "archflow_gate" || transition.resulting_revision !== state.revision) return Object.freeze({});
  let transitionGateId: PathSafeId;
  try { transitionGateId = parsePathSafeId(transition.result_id); }
  catch { return Object.freeze({}); }
  const archive = await archivedGate(dependencies, authority, transitionGateId);
  const unreadable = archive.request === "missing" || archive.request === "invalid" || archive.decision === "missing" || archive.decision === "invalid";
  // Bytes that cannot be authenticated at all — unreadable, or a readable pair whose request and
  // decision do not validate against each other (corrupt or forged cross-binding) — keep the
  // conservative invalid classification.
  const invalidArchive = () =>
    transition.operation === "semantic-revision-requested"
      ? Object.freeze({ revision_checkpoint: Object.freeze({ status: "invalid" }) })
      : transition.operation === "gate"
        ? Object.freeze({ pending_waiver_origin: Object.freeze({ status: "invalid" }) })
        : Object.freeze({});
  if (unreadable) return invalidArchive();
  const request = (archive.request as CanonicalDocument<ArchivedGateRequestV1>);
  const decision = (archive.decision as CanonicalDocument<ArchivedGateDecisionRecordV1>);
  if (!archiveAuthenticates(request, decision)) return invalidArchive();
  // A readable, authenticated archive that no longer binds to the current position was
  // consumed and superseded by a later authority change — most commonly the planning restart an
  // amend-upstream choice performs in the same revision the settlement recorded. It is not a
  // pending waiver origin or an open revision checkpoint for the restarted position; treating it
  // as invalid would wedge the reopened boundary behind an inspection that cannot resolve it.
  if (!archiveBinds(state, request, decision)) return Object.freeze({});
  if (decision.value.outcome !== "decided") return Object.freeze({});
  const commonTransitionBinding = request.value.gate_id === transitionGateId && decision.value.gate_id === transitionGateId &&
    canonicalJsonDigest(transition.outcome) === transition.outcome_digest && decision.value.outcome === "decided" &&
    transitionCarriesDecision(transition.outcome, decision.value);
  const payload = decision.value.envelope.payload;
  if (transition.operation === "semantic-revision-requested") {
    const intent = /^afop-([0-9a-f]{64})-decision-settle$/u.exec(transition.intent_id);
    const operationDigest = intent?.[1] as Sha256Digest | undefined;
    const provenance = decisionProvenance(decision.value);
    const provenanceOperation = semanticDecisionOperation(decision.value);
    const directBinding = operationDigest !== undefined &&
      (provenance?.channel === "archflow-local" || provenanceOperation === operationDigest) &&
      transition.request_digest === directDecisionRequestDigest(operationDigest, request, decision) &&
      transition.input_fingerprint === state.input_fingerprint &&
      transition.prior_revision === request.value.opened_at_revision &&
      transition.resulting_revision === request.value.opened_at_revision + 1;
    const valid = commonTransitionBinding && decisionReenters(decision.value) && directBinding;
    return Object.freeze({ revision_checkpoint: Object.freeze({
      status: valid ? "valid" : "invalid",
      ...(valid ? {
        gate_id: transitionGateId,
        request_digest: request.digest,
        decision_digest: decision.digest,
        choice: payload.decision,
        ...(operationDigest === undefined ? {} : { operation_digest: operationDigest }),
        ...(provenance?.channel === "archflow-local" ? { provenance: "pre-facade" } : {}),
      } : {}),
    }) });
  }
  if (!commonTransitionBinding || request.value.request_digest !== transition.request_digest ||
      request.value.intent_id !== transition.intent_id || transition.operation !== "gate" || payload.decision !== "waiver-requested" ||
      !isWaiverOriginRequest(request.value) ||
      !("eligible_waivers" in request.value.context) ||
      !request.value.context.eligible_waivers.some((eligible) =>
        isDeepStrictEqual(eligible.rule, payload.rule) && eligible.scope.operation === payload.operation)) {
    return Object.freeze({});
  }
  const scope = request.value.context.eligible_waivers.find((eligible) =>
    isDeepStrictEqual(eligible.rule, payload.rule) && eligible.scope.operation === payload.operation)!.scope;
  return Object.freeze({ pending_waiver_origin: Object.freeze({
    origin_gate_id: request.value.gate_id,
    origin_decision_digest: decision.digest,
    origin_context_digest: request.value.context_digest,
    task_id: request.value.task_id,
    phase_instance: request.value.phase_instance,
    subject_digest: request.value.subject_digest,
    current_evidence_set_digest: request.value.current_evidence.set_digest,
    rule: payload.rule,
    scope,
    rationale: payload.rationale,
  }) });
}

/**
 * Direct server-internal semantic read. Every enrichment is derived from the state/evidence read
 * owned by detailed status plus immutable archives authenticated against that state.
 */
export async function computeAuthoritativeSemanticStatus(
  dependencies: GateLifecycleDependencies,
  authority: TransactionAuthority,
): Promise<ProjectResult<SemanticStatusSnapshotV1>> {
  const detailed = await computeTaskStatusDetailed(dependencies, authority);
  if (!detailed.ok) return detailed;
  const { state, status } = detailed.value;
  if (state !== undefined && state.repository_identity_digest !== authority.repository_identity_digest) {
    throw new TypeError("semantic status repository identity does not match durable state");
  }
  const archives = await deriveArchiveEnrichments(dependencies, authority, detailed.value);
  const implementationRecommendation = await currentImplementationRecommendation(
    dependencies, authority, detailed.value,
  );
  const triageArtifact = detailed.value.retained.get("triage")?.manifest.source_artifact;
  const ledger = triageArtifact?.artifact_kind === "triage"
    ? triageArtifact.evidence.disposition_ledger ?? []
    : [];
  return ok(computeSemanticStatusSnapshot(status, {
    repository_identity_digest: authority.repository_identity_digest,
    ...(state === undefined ? {} : { state }),
    ...(detailed.value.state_document_digest === undefined ? {} : {
      state_document_digest: detailed.value.state_document_digest,
    }),
    ...(detailed.value.live_config_digest === undefined ? {} : {
      live_config_digest: detailed.value.live_config_digest,
    }),
    ...(detailed.value.legacy_import_initialization !== true ? {} : {
      legacy_import_initialization: true,
    }),
    full_findings: fullFindings(detailed.value),
    review_rounds: reviewRounds(detailed.value),
    taxonomy_denial_rates: computeTaxonomyDenialRates(ledger),
    implementation_recommendation: implementationRecommendation,
    ...(status.validation_overrides === undefined ? {} : { validation_overrides: status.validation_overrides }),
    ...(status.review_push_throughs === undefined ? {} : { review_push_throughs: status.review_push_throughs }),
    ...archives,
    reopen_impacts: state === undefined ? Object.freeze([]) : reopenImpacts(state, status),
  }));
}

/**
 * Builds the semantic snapshot from the full detailed status and enrichments captured by the same
 * authenticated read. This function performs no filesystem reads, which lets status assembly call
 * it before releasing its consistent canonical view.
 */
export function computeSemanticStatusSnapshot(
  status: TaskStatusV1,
  enrichments: SemanticStatusEnrichmentsV1,
): SemanticStatusSnapshotV1 {
  const repositoryIdentity = parseSha256Digest(enrichments.repository_identity_digest);
  const statusJson = materializeJson(status, "full task status") as unknown as PlainJsonValue;
  const state = enrichments.state === undefined
    ? undefined
    : materializeJson(enrichments.state, "semantic status durable state");

  if (state !== undefined) {
    if (status.state === "missing") throw new TypeError("active semantic state cannot accompany missing status");
    if (state.repository_identity_digest !== repositoryIdentity) {
      throw new TypeError("semantic status repository identity does not match durable state");
    }
    if (
      status.revision !== state.revision ||
      status.phase_instance !== state.phase_instance ||
      status.step !== state.step ||
      status.status !== state.status ||
      status.attempt !== state.attempt ||
      status.input_fingerprint !== state.input_fingerprint
    ) {
      throw new TypeError("semantic status and durable state are not from the same canonical read");
    }
    if (enrichments.state_document_digest === undefined) {
      throw new TypeError("active semantic state requires its canonical document digest");
    }
  } else if (status.state !== "missing") {
    throw new TypeError("active semantic status requires its authenticated durable state");
  } else if (enrichments.state_document_digest !== undefined || enrichments.legacy_import_initialization === true) {
    throw new TypeError("missing semantic status cannot carry durable state identity");
  }

  const findings: readonly PublicFindingV1[] = enrichments.full_findings.map((finding) =>
    Object.freeze(publicFindingV1Schema.parse(materializeJson(finding, "semantic review finding"))) as PublicFindingV1);
  const snapshot: SemanticStatusSnapshotV1 = {
    schema_version: "1",
    repository_identity_digest: repositoryIdentity,
    ...(state === undefined ? {} : { state: Object.freeze(state) }),
    ...(enrichments.state_document_digest === undefined ? {} : {
      state_document_digest: parseSha256Digest(enrichments.state_document_digest),
    }),
    ...(enrichments.live_config_digest === undefined ? {} : {
      live_config_digest: parseSha256Digest(enrichments.live_config_digest),
    }),
    ...(enrichments.legacy_import_initialization !== true ? {} : {
      legacy_import_initialization: true,
    }),
    status: statusJson,
    full_findings: Object.freeze(findings),
    review_rounds: Object.freeze((enrichments.review_rounds ?? []).map((round) =>
      Object.freeze(publicReviewRoundV1Schema.parse(materializeJson(round, "semantic review round"))) as PublicReviewRoundV1)),
    taxonomy_denial_rates: Object.freeze({ ...enrichments.taxonomy_denial_rates }),
    implementation_recommendation: Object.freeze(implementationRecommendationV1Schema.parse(
      materializeJson(enrichments.implementation_recommendation, "implementation recommendation"),
    )),
    ...(enrichments.validation_overrides === undefined ? {} : {
      validation_overrides: Object.freeze(enrichments.validation_overrides.map((entry) =>
        Object.freeze(publicValidationOverrideAuditV1Schema.parse(
          materializeJson(entry, "validation override audit"),
        )) as PublicValidationOverrideAuditV1)),
    }),
    ...(enrichments.review_push_throughs === undefined ? {} : {
      review_push_throughs: Object.freeze(enrichments.review_push_throughs.map((entry) =>
        Object.freeze(publicReviewPushThroughAuditV1Schema.parse(
          materializeJson(entry, "review push-through audit"),
        )) as PublicReviewPushThroughAuditV1)),
    }),
    ...(enrichments.pending_waiver_origin === undefined ? {} : {
      pending_waiver_origin: materializeJson(enrichments.pending_waiver_origin, "pending waiver origin"),
    }),
    ...(enrichments.archived_decision === undefined ? {} : {
      archived_decision: materializeJson(enrichments.archived_decision, "archived decision enrichment"),
    }),
    ...(enrichments.revision_checkpoint === undefined ? {} : {
      revision_checkpoint: materializeJson(enrichments.revision_checkpoint, "revision checkpoint enrichment"),
    }),
    reopen_impacts: Object.freeze((enrichments.reopen_impacts ?? []).map((impact) =>
      Object.freeze(materializeJson(impact, "reopen impact")))),
  };
  return Object.freeze(snapshot);
}

import { isDeepStrictEqual } from "node:util";

import { canonicalDocument, canonicalJsonDigest, sha256Bytes, type CanonicalDocument } from "../contracts/canonical.js";
import { assertAuthenticInvocationContext, type InvocationContext } from "../contracts/contexts.js";
import {
  parseActiveGate,
  parseArchivedGateDecisionRecord,
  parseArchivedGateRequest,
  parseGateDecisionRecord,
  parseGateRequest,
  parsePersistedGateRequest,
  type GateDecisionRecordV1,
  type GateRequestV1,
  type StaleBaselineGateSupersessionV1,
  type WaiverGateContext,
} from "../contracts/durable-gate.js";
import {
  compareRuleSettlements,
  planningRestartHumanProvenanceV1Schema,
  type ApprovalRef,
  type AuthoritativeResultRef,
  type BaselineAdoptionRecord,
  type LastTransition,
  type ReviewPushThroughRecordV1,
  type TaskStateV1,
  type ValidationOverrideRecordV1,
  type WaiverRef,
} from "../contracts/durable-state.js";
import { intentOutcomeDigest, parseIntentReceipt, type IntentReceiptV1 } from "../contracts/durable-intent.js";
import { createCommittedIntentSubject, createPreparedIntentSubject, openGateFrozenStateDigest, validateDurableSemantics } from "../contracts/durable.js";
import { createProjectError, type ProjectResult } from "../contracts/errors.js";
import { parsePathSafeId, parseSafeCode, parseSafeId, parseSafeInteger, type PathSafeId, type Sha256Digest } from "../contracts/evidence.js";
import { decodePhaseInstance } from "../contracts/phase-instance.js";
import { parseToolCall } from "../contracts/mcp-tools.js";
import { baselineAdoptionDriftDigest, computeGateContextDigest, computeGateId } from "../contracts/fingerprints.js";
import { gateDecisionEffect, type BaselineObservationRef } from "../contracts/gates.js";
import { validationOverrideSubjectDigest, type ValidationOverrideRequestRefV1 } from "../contracts/gates.js";
import type { HumanDecisionProvenance } from "../contracts/gates.js";
import type { PlainJsonValue } from "../contracts/plain-json.js";
import type { RepositoryName, TaskConfigSnapshot } from "../contracts/config.js";
import {
  gateDecisionClaim,
  gateRequestClaim,
  intentReceiptClaim,
  resolveTaskWorkspacePath,
  type ResolvedTaskPath,
  type ResolvedTaskWorkspacePath,
} from "../repository/paths.js";
import { verifyRepositoryIdentity } from "../repository/identity.js";
import { resolveRepositorySet, type RepositorySet } from "../repository/repository-set.js";
import { resolveCommit } from "../repository/git.js";
import { assertInternalTransactionAuthority, type TransactionAuthority } from "./authority.js";
import { validateRepositorySetContinuity, withLastSeenConfig } from "./config-change.js";
import {
  DECISIONS,
  activeProjection,
  decisionsForGate,
  desiredGenerationDigest,
  fail,
  io,
  issue,
  ok,
  parseInterface,
  readCanonical,
  resolvePath,
  stateOrFailure,
  stateWithOpen,
  waiverContext,
  type GateLifecycleDependencies,
  type GateOpenInput,
  type GateOpenResult,
  type GateResolution,
} from "./gate-core.js";
import { buildHumanGatePresentation, selectGateDecisionTemplate } from "./gate-decision-interface.js";
import { ensureDecisionDirectory, ensureIntentDirectory, ensureWorkspaceProjectionParent } from "./layout.js";
import { loadLegacyImportInitialization, loadLegacyImportResumePhase } from "./legacy-import-resume.js";
import { TaskLockError } from "./lock.js";
import { loadApprovedDesignFinalPhase } from "./planned-final-phase.js";
import { planPlanningRestart, planStateTransition } from "./transitions.js";
import { isWaiverOriginRequest } from "./waiver-origin.js";
import {
  changedCoProducedDocumentPaths,
  expectedProduceUpstreamBindings,
  loadCurrentProduceSubject,
  loadProduceUpstreamSubject,
  produceUpstreamBindingsForSubject,
  type CurrentProduceSubject,
  type ProduceUpstreamSubject,
} from "./produce-subject.js";
import { assessBaselineSubjectFreshness, reconcileCurrentAuthority, type ReconciliationFinding } from "./reconciliation.js";
import { currentProjectionDigest, discoverNewestProjections, discoverReconciliationInput } from "./reconciliation-discovery.js";
import { applyProjectionPlan, applyRepositoryProjectionPlans, captureProjectionTarget, prepareProjectionPlan, projectionGenerationDigest, repositoryPathKey, type ProjectionSource } from "./snapshots.js";
import { readRetainedRepositoryOutput } from "./production.js";
import { cleanTaskWorkspace } from "./workspace-cleanup.js";
import {
  assessCurrentEvidence,
  DEFAULT_MAX_ATTEMPTS,
  deriveReviewPushThroughCandidate,
} from "../review/fixed-point.js";
import { resolvePinnedConstitution } from "./constitution.js";
import { loadRetainedEvidence } from "./evidence-results.js";
import {
  buildRuleSettlement,
  evaluateApprovalRules,
  approvalRuleContext,
} from "./approval-rules.js";
import {
  buildSecondaryCommitAuthorizationFacts,
  currentApprovedUpstreams,
  currentReviewPredecessor,
  SecondaryCommitObservationError,
} from "./status.js";
import {
  approvalIsEligibleAfterLatestRestart,
  authenticatedApprovalIsEligibleAfterLatestRestart,
} from "./restart-authority.js";
import {
  assertAuthenticatedGateApproval,
  loadAuthenticatedGateApproval,
  type AuthenticatedGateApproval,
} from "./gate-approvals.js";
import {
  loadAuthenticatedReviewPushThrough,
  reviewPushThroughAuthoritySource,
} from "./review-push-throughs.js";

export { loadAuthenticatedGateApproval } from "./gate-approvals.js";
export {
  buildGateDecisionTemplates,
  buildHumanGatePresentation,
  gateDecisionTemplateName,
  selectGateDecisionTemplate,
} from "./gate-decision-interface.js";
export type { HumanGateDecisionOption, HumanGatePresentation } from "./gate-decision-interface.js";
export type { GateLifecycleDependencies, GateOpenInput } from "./gate-core.js";
export { findLegacyImportResumePhase } from "./legacy-import-resume.js";

export type DirectSemanticDecisionInput = Readonly<{
  authority: TransactionAuthority;
  operation_digest: Sha256Digest;
  intent_id: PathSafeId;
  choice: string;
  reason: string;
  option_rationale?: string;
  invocation_context: InvocationContext;
}>;

export type DirectSemanticDecisionSettlementInput = Readonly<{
  authority: TransactionAuthority;
  operation_digest: Sha256Digest;
  intent_id: PathSafeId;
}>;

export type DirectSemanticDecisionArchiveResult = Readonly<{
  state: CanonicalDocument<TaskStateV1>;
  request: CanonicalDocument<GateRequestV1>;
  record: CanonicalDocument<GateDecisionRecordV1>;
  replayed: boolean;
}>;

/** Cleanup is derived work: a committed state must never be rolled back because it failed. */
async function cleanupCommittedGateWorkspace(
  dependencies: GateLifecycleDependencies,
  authority: TransactionAuthority,
  state: TaskStateV1,
): Promise<void> {
  try {
    await cleanTaskWorkspace(dependencies, authority, state);
  } catch {
    // Full status derives cleanup debt from the workspace and the next mutation retries it.
  }
}

async function validateLiveGateState(
  dependencies: GateLifecycleDependencies,
  authority: TransactionAuthority,
  current: CanonicalDocument<TaskStateV1>,
  inputFingerprint: Sha256Digest,
): Promise<ProjectResult<Readonly<{ config: TaskConfigSnapshot; repository_set: RepositorySet }>>> {
  const identity = verifyRepositoryIdentity(current.value.repository_identity_digest, authority.repository_identity);
  if (!identity.ok) return identity;
  if (!validateDurableSemantics({ state: current }).ok) return issue("STATE_INVALID", current.value, "gate-state-semantics-invalid");
  const config = await dependencies.read_config(authority.config);
  if (config.kind !== "valid") {
    return config.kind === "invalid"
      ? fail(createProjectError("CONFIG_INVALID", {
          issue_code: "task-config-invalid",
          ...(config.issues === undefined ? {} : { issues: config.issues }),
        }))
      : io(authority, "gate-config-read");
  }
  const repositorySet = await resolveRepositorySet(
    { runner: dependencies.runner, environment: dependencies.environment },
    config.snapshot.parsed,
    authority.context,
  );
  if (!repositorySet.ok) return repositorySet;
  const continuity = validateRepositorySetContinuity(current.value, repositorySet.value);
  if (!continuity.ok) return continuity;
  if (inputFingerprint !== current.value.input_fingerprint) return fail(createProjectError("INPUT_FINGERPRINT_MISMATCH", { expected_digest: current.value.input_fingerprint, observed_digest: inputFingerprint }));
  // The parsed live config rides back to the one caller that commits state in the same operation
  // (gate open); the settlement callers validated with it and deliberately change nothing.
  return ok(Object.freeze({ config: config.snapshot.parsed, repository_set: repositorySet.value }));
}

async function authenticateWaiverOrigin(
  dependencies: GateLifecycleDependencies,
  authority: TransactionAuthority,
  context: WaiverGateContext,
): Promise<ProjectResult<void>> {
  const requestPath = await resolvePath(dependencies, authority, gateRequestClaim(context.origin.origin_gate_id), "authority-decision");
  const decisionPath = await resolvePath(dependencies, authority, gateDecisionClaim(context.origin.origin_gate_id), "authority-decision");
  if (!requestPath.ok) return requestPath;
  if (!decisionPath.ok) return decisionPath;
  const request = await readCanonical(requestPath.value, "waiver origin request", parseArchivedGateRequest);
  const decision = await readCanonical(decisionPath.value, "waiver origin decision", parseArchivedGateDecisionRecord);
  if (request === "missing" || request === "invalid" || decision === "missing" || decision === "invalid") return issue("CONTRACT_INVALID", undefined, "waiver-origin-archive-invalid");
  // New waiver requests originate at the phase's ordinary approval gate. An archived policy
  // constitution gate remains consumable only because its old human interface offered the same
  // choice; the later grant/deny request still cannot originate another waiver.
  if (!isWaiverOriginRequest(request.value)) return issue("CONTRACT_INVALID", undefined, "waiver-origin-decision-invalid");
  if (!validateDurableSemantics({ gate_request: request, gate_decision: decision }).ok || decision.digest !== context.origin.origin_decision_digest || decision.value.outcome !== "decided" || decision.value.envelope.payload.decision !== "waiver-requested") return issue("CONTRACT_INVALID", undefined, "waiver-origin-decision-invalid");
  const payload = decision.value.envelope.payload as Extract<typeof decision.value.envelope.payload, { decision: "waiver-requested" }>;
  const requestContext = request.value.context;
  if (!("eligible_waivers" in requestContext) || request.value.gate_id !== context.origin.origin_gate_id || request.value.context_digest !== context.origin.origin_context_digest || request.value.task_id !== context.origin.task_id || request.value.phase_instance !== context.origin.phase_instance || request.value.subject_digest !== context.origin.subject_digest || request.value.current_evidence.set_digest !== context.origin.current_evidence_set_digest || !isDeepStrictEqual(payload.rule, context.origin.rule) || payload.operation !== context.origin.scope.operation || !requestContext.eligible_waivers.some((eligible) => isDeepStrictEqual(eligible.rule, context.origin.rule) && isDeepStrictEqual(eligible.scope, context.origin.scope))) return issue("CONTRACT_INVALID", undefined, "waiver-origin-binding-invalid");
  return ok(undefined);
}

export async function openDurableGate(
  dependencies: GateLifecycleDependencies,
  input: GateOpenInput,
): Promise<ProjectResult<GateOpenResult>> {
  assertInternalTransactionAuthority(input.authority, { runner: dependencies.runner, environment: dependencies.environment });
  try {
    await ensureIntentDirectory(input.authority);
    return await dependencies.lock.runExclusive(input.authority.workspace_root, async () => {
      const stateResult = await stateOrFailure(dependencies, input.authority);
      if (!stateResult.ok) return stateResult;
      const current = stateResult.value;
      // Archive replay may legitimately observe the new produce-entry fingerprint after an
      // atomically enacted retry. Authenticate repository/config first and compare the caller's
      // fingerprint only after ruling out that completed replay.
      const live = await validateLiveGateState(
        dependencies, input.authority, current, current.value.input_fingerprint,
      );
      if (!live.ok) return live;
      const gateId = computeGateId({ task_identity_digest: input.authority.task_identity_digest, intent_id: input.intent_id, request_digest: input.request_digest });
      await ensureDecisionDirectory(input.authority, gateId);
      const requestPath = await resolvePath(dependencies, input.authority, gateRequestClaim(gateId), "authority-decision");
      const decisionPath = await resolvePath(dependencies, input.authority, gateDecisionClaim(gateId), "authority-decision");
      if (!requestPath.ok) return requestPath;
      if (!decisionPath.ok) return decisionPath;
      const archived = await readCanonical(decisionPath.value, "gate decision record", parseGateDecisionRecord);
      const requestRead = await readCanonical(requestPath.value, "gate request", parsePersistedGateRequest);
      if (archived !== "missing") {
        if (archived === "invalid" || requestRead === "missing" || requestRead === "invalid") return issue("STATE_INVALID", current.value, "gate-archive-invalid");
        if (!validateDurableSemantics({ gate_request: requestRead, gate_decision: archived }).ok) return issue("STATE_INVALID", current.value, "gate-archive-binding-invalid");
        if (
          !enactsReentry(archived.value) &&
          !enactsPlanningRestart(archived.value) &&
          input.input_fingerprint !== current.value.input_fingerprint
        ) {
          return fail(createProjectError("INPUT_FINGERPRINT_MISMATCH", {
            expected_digest: current.value.input_fingerprint,
            observed_digest: input.input_fingerprint,
          }));
        }
        if (current.value.open_gate?.gate_id === gateId) {
          return ok({ gate_id: gateId, state: current, request: requestRead, replay: archived });
        }
        if (current.value.last_transition?.intent_id === input.intent_id) {
          const transition = current.value.last_transition;
          const expectedTool = archived.value.outcome === "waiver-decided" ? "archflow_waiver" : "archflow_gate";
          const expectedOperation = archived.value.outcome === "waiver-decided" ? "waiver" : "gate";
          const expectedOutcome = archived.value.outcome === "cancelled"
            ? undefined
            : receiptOutcome(archived.value, current.value.revision);
          if (
            expectedOutcome === undefined || transition.tool !== expectedTool ||
            transition.operation !== expectedOperation ||
            transition.request_digest !== requestRead.value.request_digest ||
            transition.input_fingerprint !== input.input_fingerprint ||
            String(transition.result_id) !== String(archived.value.gate_id) ||
            transition.resulting_revision !== current.value.revision ||
            transition.prior_revision + 1 !== transition.resulting_revision ||
            !isDeepStrictEqual(transition.outcome, expectedOutcome) ||
            transition.outcome_digest !== intentOutcomeDigest(expectedOutcome)
          ) {
            return issue("STATE_INVALID", current.value, "gate-replay-transition-invalid");
          }
          return ok({ gate_id: gateId, state: current, request: requestRead, replay: archived });
        }
        if (archived.value.outcome === "cancelled" && requestRead.value.intent_id === input.intent_id && requestRead.value.request_digest === input.request_digest) return ok({ gate_id: gateId, state: current, request: requestRead, replay: archived });
        if (
          (enactsReentry(archived.value) || enactsPlanningRestart(archived.value)) &&
          requestRead.value.intent_id === input.intent_id &&
          requestRead.value.request_digest === input.request_digest
        ) {
          const replay = enactsPlanningRestart(archived.value)
            ? await validateCompletedPlanningRestart(
                dependencies, input.authority, current, requestRead.value, archived.value,
              )
            : await validateCompletedReentry(
                dependencies, input.authority, current, requestRead.value, archived.value,
              );
          if (!replay.ok) return replay;
          return ok({ gate_id: gateId, state: current, request: requestRead, replay: archived });
        }
        return fail(createProjectError("INTENT_NOT_CURRENT", { intent_id: input.intent_id, receipt_revision: requestRead.value.opened_at_revision, current_revision: current.value.revision }));
      }
      if (input.input_fingerprint !== current.value.input_fingerprint) {
        return fail(createProjectError("INPUT_FINGERPRINT_MISMATCH", {
          expected_digest: current.value.input_fingerprint,
          observed_digest: input.input_fingerprint,
        }));
      }
      if (current.value.open_gate !== undefined) {
        const activeRequestPath = await resolvePath(dependencies, input.authority, gateRequestClaim(current.value.open_gate.gate_id), "authority-decision");
        if (!activeRequestPath.ok) return activeRequestPath;
        const activeRequest = await readCanonical(activeRequestPath.value, "active gate request", parsePersistedGateRequest);
        if (activeRequest === "missing" || activeRequest === "invalid") return issue("STATE_INVALID", current.value, "active-gate-request-invalid");
        if (activeRequest.value.intent_id === input.intent_id && activeRequest.value.request_digest !== input.request_digest) {
          return fail(createProjectError("INTENT_MISMATCH", { expected_digest: activeRequest.value.request_digest, observed_digest: input.request_digest }));
        }
        if (current.value.open_gate.gate_id !== gateId) return fail(createProjectError("GATE_ACTIVE", { gate_id: current.value.open_gate.gate_id, gate_kind: current.value.open_gate.gate_kind }));
        const gateJson = await resolvePath(dependencies, input.authority, "gate.json", "workspace-gate-interface"); if (!gateJson.ok) return gateJson;
        const projected = await readCanonical(gateJson.value, "active gate", parseActiveGate);
        if (projected === "missing" || projected === "invalid") {
          await ensureWorkspaceProjectionParent(input.authority, gateJson.value.absolute as ResolvedTaskWorkspacePath);
          await dependencies.atomic.replace(gateJson.value, canonicalDocument(parseActiveGate(activeProjection(activeRequest.value))).bytes);
        }
        return ok({ gate_id: gateId, state: current, request: activeRequest });
      }
      if (current.value.revision !== input.expected_revision) return fail(createProjectError("STATE_CONFLICT", { expected_revision: input.expected_revision, observed_revision: current.value.revision }));
      if (input.kind === "validation-override") {
        const pending = current.value.pending_validation_override;
        const transition = current.value.last_transition;
        if (
          pending === undefined || decodePhaseInstance(current.value.phase_instance).kind !== "phase-impl" ||
          current.value.step !== "produce" || current.value.status !== "failed" ||
          pending.phase_instance !== current.value.phase_instance ||
          pending.input_fingerprint !== current.value.input_fingerprint ||
          pending.request_revision !== current.value.revision ||
          transition?.tool !== "archflow_state" || transition.operation !== "request-validation-override" ||
          transition.request_digest !== pending.request_digest ||
          transition.input_fingerprint !== pending.input_fingerprint ||
          transition.resulting_revision !== pending.request_revision
        ) return issue("STATE_INVALID", current.value, "validation-override-pending-authority-invalid");
        const subjectDigest = validationOverrideSubjectDigest({
          task_id: current.value.task_id,
          phase_instance: pending.phase_instance,
          input_fingerprint: pending.input_fingerprint,
          governing_phase_design_digest: pending.governing_phase_design_digest,
          displaced_validations: pending.displaced_validations,
        });
        const expectedContext = {
          request_revision: pending.request_revision,
          input_fingerprint: pending.input_fingerprint,
          governing_phase_design_digest: pending.governing_phase_design_digest,
          displaced_validations: pending.displaced_validations,
          producer_reason: pending.producer_reason,
        } as const;
        const expectedEvidence: ValidationOverrideRequestRefV1 = {
          schema_version: "1",
          evidence_kind: "validation-override-request",
          task_id: current.value.task_id,
          phase_instance: pending.phase_instance,
          input_fingerprint: pending.input_fingerprint,
          governing_phase_design_digest: pending.governing_phase_design_digest,
          request_revision: pending.request_revision,
          validation_request_subject_digest: subjectDigest,
        };
        if (
          input.phase_instance !== pending.phase_instance || input.subject_digest !== subjectDigest ||
          !isDeepStrictEqual(input.context, expectedContext) ||
          !isDeepStrictEqual(input.current_evidence, expectedEvidence)
        ) return issue("STATE_INVALID", current.value, "validation-override-request-stale");
      }
      const attemptsContext = input.kind === "attempts-exhausted"
        ? input.context as Extract<GateRequestV1, { kind: "attempts-exhausted" }>["context"]
        : undefined;
      if (attemptsContext?.review_push_through !== undefined) {
        if (current.value.step !== "triage" || current.value.status !== "succeeded" ||
            dependencies.load_retained_manifest === undefined) {
          return issue("STATE_INVALID", current.value, "review-push-through-boundary-invalid");
        }
        const retained = await loadRetainedEvidence(
          { load_retained_manifest: dependencies.load_retained_manifest },
          current.value,
          current.value.phase_instance,
        );
        if (!retained.ok) return retained;
        const produce = await loadCurrentProduceSubject(dependencies, current.value);
        if (!produce.ok) return produce;
        const constitution = await resolvePinnedConstitution(
          dependencies.runner,
          current.value.policy_base_commit,
          input.authority.context,
        );
        if (!constitution.ok) return constitution;
        const predecessor = currentReviewPredecessor(current.value, produce.value);
        const subject = {
          subject_digest: produce.value.artifact_digest,
          input_fingerprint: current.value.input_fingerprint,
          constitution: constitution.value,
          ...(predecessor === undefined ? {} : { review_predecessor: predecessor }),
          ...(live.value.config.max_attempts === undefined ? {} : {
            max_attempts: live.value.config.max_attempts,
          }),
        };
        const candidate = deriveReviewPushThroughCandidate(current.value, retained.value, subject);
        const expectedMaximum = live.value.config.max_attempts ?? DEFAULT_MAX_ATTEMPTS;
        if (
          candidate === undefined || current.value.attempt < expectedMaximum ||
          input.phase_instance !== current.value.phase_instance ||
          input.subject_digest !== candidate.subject_digest ||
          attemptsContext.step !== current.value.step ||
          attemptsContext.attempts !== current.value.attempt ||
          attemptsContext.maximum_attempts !== expectedMaximum ||
          !isDeepStrictEqual(attemptsContext.review_push_through, candidate.context) ||
          !("set_digest" in input.current_evidence) ||
          input.current_evidence.set_digest !== candidate.context.current_evidence_set_digest
        ) return issue("STATE_INVALID", current.value, "review-push-through-context-stale");
      }
      if (input.kind === "commit-authorization") {
        const reference = [...current.value.authoritative_results].reverse().find((item) => item.phase_instance === input.phase_instance && item.step === "produce");
        if (reference === undefined || dependencies.load_retained_result === undefined) return issue("STATE_INVALID", current.value, "commit-authorization-result-missing");
        const retained = await dependencies.load_retained_result(reference);
        if (!retained.ok) return retained;
        const manifest = retained.value.prepared.manifest.value;
        const artifact = manifest.source_artifact;
        const context = input.context as Extract<GateRequestV1, { kind: "commit-authorization" }>["context"];
        if (
          artifact.artifact_kind !== "implementation-output" || artifact.diff_digest !== context.diff_digest ||
          !isDeepStrictEqual(context.current_artifact_digests, [manifest.artifact_digest]) ||
          !isDeepStrictEqual(context.parent_document_digests, artifact.parent_documents.map((item) => item.content_digest).sort())
        ) return issue("STATE_INVALID", current.value, "commit-authorization-manifest-mismatch");
      }
      if (input.kind === "restore-collision") {
        const reference = [...current.value.authoritative_results].reverse().find((item) => item.phase_instance === input.phase_instance && item.step === "produce");
        if (reference === undefined || dependencies.load_retained_result === undefined) return issue("STATE_INVALID", current.value, "restore-result-missing");
        const retained = await dependencies.load_retained_result(reference); if (!retained.ok) return retained;
        const context = input.context as Extract<GateRequestV1, { kind: "restore-collision" }>["context"];
        const repositoryPath = `.archflow/tasks/${input.authority.task_id}/${context.path}`;
        const entry = retained.value.projection_plan.entries.find((item) => item.path === repositoryPath);
        if (entry === undefined || desiredGenerationDigest(entry.desired) !== context.recorded_generation_digest) return issue("STATE_INVALID", current.value, "restore-recorded-generation-mismatch");
        if (projectionGenerationDigest((await captureProjectionTarget(entry.target)).observation) !== context.current_generation_digest) return issue("STATE_INVALID", current.value, "restore-current-generation-stale");
        if (entry.rename_pair !== undefined) {
          const peer = retained.value.projection_plan.entries.find((item) => item.path === entry.rename_pair!.peer_path && item.rename_pair?.peer_path === entry.path);
          if (peer === undefined || !isDeepStrictEqual((await captureProjectionTarget(peer.target)).observation, peer.observed_before)) return issue("STATE_INVALID", current.value, "restore-rename-peer-changed");
        }
        const changed = input.input_fingerprint !== reference.input_fingerprint;
        if ((!changed && context.adoption_candidate !== undefined) || (context.adoption_candidate !== undefined && (context.adoption_candidate.changed_input_fingerprint !== input.input_fingerprint || context.adoption_candidate.proposed_generation_digest !== context.current_generation_digest))) return issue("CONTRACT_INVALID", undefined, "restore-adoption-candidate-invalid");
      }
      if (input.kind === "baseline-adoption") {
        // Drift while a produce write window is open is expected producer work, already tolerated
        // by reconciliation; adopting a baseline mid-produce would re-baseline under the producer.
        if (current.value.step === "produce" && current.value.status !== "succeeded") {
          return issue("STATE_INVALID", current.value, "baseline-adoption-window-open");
        }
        if (dependencies.load_retained_manifest === undefined) {
          return issue("STATE_INVALID", current.value, "baseline-adoption-loader-unavailable");
        }
        // Truth is re-derived under the lock: the gate may only open on exactly the live drift set,
        // so a partial adoption or a context naming currently-clean paths fails closed here. The
        // live set splits into drifted (live bytes observed) and committed-deleted findings; a
        // missing projection that is restorable, or deleted only in the worktree, is not
        // representable and refuses the open.
        const liveConfig = await dependencies.read_config(input.authority.config);
        if (liveConfig.kind !== "valid") return issue("STATE_INVALID", current.value, "baseline-adoption-config-unavailable");
        const liveRepositories = await resolveRepositorySet(
          { runner: dependencies.runner, environment: dependencies.environment },
          liveConfig.snapshot.parsed,
          input.authority.context,
        );
        if (!liveRepositories.ok) return liveRepositories;
        const repositoryContinuity = validateRepositorySetContinuity(current.value, liveRepositories.value);
        if (!repositoryContinuity.ok) return repositoryContinuity;
        const discovered = await discoverReconciliationInput(dependencies, input.authority, current, liveRepositories.value);
        if (!discovered.ok) return discovered;
        const drift = reconcileCurrentAuthority(discovered.value).findings
          .filter((finding): finding is Extract<ReconciliationFinding, { kind: "projection-mismatch" }> => finding.kind === "projection-mismatch")
          .sort((left, right) => (left.repository ?? "primary").localeCompare(right.repository ?? "primary") || left.path.localeCompare(right.path));
        const context = input.context as Extract<GateRequestV1, { kind: "baseline-adoption" }>["context"];
        const contextTargets = baselineRepositoryTargets(context);
        const liveRepositoriesWithDrift = [...new Set(drift.map((finding) => finding.repository ?? "primary"))].sort();
        const declaredRepositories = contextTargets
          .filter((target) => target.drifted_projections.length + target.deleted_projections.length !== 0)
          .map((target) => target.repository).sort();
        const exact = isDeepStrictEqual(liveRepositoriesWithDrift, declaredRepositories) &&
          contextTargets.every((target) => {
            const member = liveRepositories.value.members.find((candidate) => candidate.name === target.repository);
            if (member === undefined || member.mode !== "writable") return false;
            const secondary = target.repository === "primary" ? undefined : context.secondary_targets?.find((item) => item.repository === target.repository);
            if (secondary !== undefined && (secondary.repository_identity_digest !== member.identity.digest || secondary.target_head !== member.head)) return false;
            if (target.repository === "primary" && context.target_head !== undefined && context.target_head !== member.head) return false;
            const repositoryDrift = drift.filter((finding) => (finding.repository ?? "primary") === target.repository);
            const liveDrifted = repositoryDrift.filter((finding) => finding.observed_digest !== undefined);
            const liveDeleted = repositoryDrift.filter((finding) =>
              finding.observed_digest === undefined && finding.restore_unavailable === true && finding.committed_absent === true);
            return liveDrifted.length + liveDeleted.length === repositoryDrift.length &&
              liveDrifted.length === target.drifted_projections.length &&
              liveDeleted.length === target.deleted_projections.length &&
              liveDrifted.every((finding, index) => {
                const declared = target.drifted_projections[index];
                return declared !== undefined && declared.path === finding.path &&
                  declared.recorded_digest === finding.recorded_digest && declared.observed_digest === finding.observed_digest;
              }) &&
              liveDeleted.every((finding, index) => {
                const declared = target.deleted_projections[index];
                return declared !== undefined && declared.path === finding.path &&
                  declared.recorded_digest === finding.recorded_digest;
              });
          });
        if (!exact) return issue("STATE_INVALID", current.value, drift.length === 0 ? "baseline-adoption-no-drift" : "baseline-adoption-context-mismatch");
        if (input.subject_digest !== baselineAdoptionDriftDigest(context)) {
          return issue("STATE_INVALID", current.value, "baseline-adoption-subject-mismatch");
        }
        const observation = input.current_evidence as BaselineObservationRef;
        if (observation.task_id !== input.authority.task_id ||
            observation.phase_instance !== current.value.phase_instance ||
            observation.observed_at_revision !== current.value.revision ||
            observation.drift_digest !== input.subject_digest) {
          return issue("STATE_INVALID", current.value, "baseline-adoption-observation-stale");
        }
      }
      if (input.kind === "migration-audit") {
        const reference = [...current.value.authoritative_results].reverse().find((item) =>
          item.phase_instance === "design" && item.step === "produce");
        if (
          input.phase_instance !== "design" ||
          current.value.phase_instance !== "design" ||
          current.value.step !== "triage" ||
          current.value.status !== "succeeded" ||
          reference === undefined ||
          dependencies.load_retained_result === undefined
        ) return issue("STATE_INVALID", current.value, "migration-audit-design-result-missing");
        const retained = await dependencies.load_retained_result(reference);
        if (!retained.ok) return retained;
        const subject = retained.value.prepared.manifest.value.artifact_digest;
        const context = input.context as Extract<GateRequestV1, { kind: "migration-audit" }>["context"];
        const reviewReference = [...current.value.authoritative_results].reverse().find((item) => item.phase_instance === "design" && item.step === "counter_review");
        const triageReference = [...current.value.authoritative_results].reverse().find((item) => item.phase_instance === "design" && item.step === "triage");
        let reviewedMigration =
          context.resume_phase !== undefined &&
          context.planned_final_phase !== undefined &&
          context.target_ref !== undefined && context.baseline_commit !== undefined && context.commit_message !== undefined &&
          context.imported_documents !== undefined && context.imported_documents.length >= 2 &&
          reviewReference !== undefined && triageReference !== undefined;
        if (reviewedMigration) {
          const [review, triage] = await Promise.all([
            dependencies.load_retained_result(reviewReference!),
            dependencies.load_retained_result(triageReference!),
          ]);
          if (!review.ok) return review;
          if (!triage.ok) return triage;
          const reviewArtifact = review.value.prepared.manifest.value.source_artifact;
          const triageArtifact = triage.value.prepared.manifest.value.source_artifact;
          reviewedMigration =
            reviewArtifact.artifact_kind === "review-evidence" && reviewArtifact.evidence.subject_digest === subject &&
            triageArtifact.artifact_kind === "triage" && triageArtifact.evidence.subject_digest === subject;
        }
        const traditionallyApproved = current.value.approvals.some((approval) =>
          (approval.gate_kind === "artifact-approval" || approval.gate_kind === "design-approval") &&
          approval.subject_digest === subject &&
          approvalIsEligibleAfterLatestRestart(current.value, approval, current.value.phase_instance));
        if (
          input.subject_digest !== subject ||
          (!traditionallyApproved && !reviewedMigration)
        ) return issue("STATE_INVALID", current.value, "migration-audit-design-not-approved");
        const resume = await loadLegacyImportResumePhase(dependencies, input.authority, current.value);
        if (!resume.ok) return resume;
        const imported = await loadLegacyImportInitialization(dependencies, input.authority, current.value);
        if (!imported.ok || imported.value === undefined) return imported.ok ? issue("STATE_INVALID", current.value, "legacy-import-manifest-missing") : imported;
        const expectedDocuments = imported.value.mapping.map((entry) => ({
          path: entry.destination_path,
          content_digest: imported.value!.staged_payload_refs.find((reference) => reference.legacy_path === entry.legacy_path)!.digest,
        })).sort((left, right) => left.path.localeCompare(right.path));
        const contextMatchesImport =
          context.source_identity_digest === imported.value.source_identity_digest &&
          context.import_digest === imported.value.import_digest &&
          context.destination_identity_digest === input.authority.task_identity_digest &&
          context.code_baseline_digest === canonicalJsonDigest({ schema_version: "1", digest_kind: "code-baseline-commit", commit: imported.value.code_baseline_commit }) &&
          context.policy_baseline_digest === canonicalJsonDigest({ schema_version: "1", digest_kind: "policy-base-commit", commit: imported.value.policy_base_commit }) &&
          context.baseline_commit === imported.value.code_baseline_commit &&
          context.resume_phase === imported.value.resume_phase &&
          context.planned_final_phase === imported.value.planned_final_phase &&
          context.target_ref === imported.value.target_ref &&
          context.commit_message === imported.value.commit_message &&
          isDeepStrictEqual(context.imported_documents, expectedDocuments);
        const decoded = decodePhaseInstance(resume.value);
        if (
          !contextMatchesImport ||
          (decoded.kind !== "phase-design" && decoded.kind !== "phase-impl") ||
          (context.resume_phase !== undefined && context.resume_phase !== resume.value) ||
          (context.planned_final_phase ?? current.value.planned_final_phase) === undefined ||
          Number(decoded.phase) > Number(context.planned_final_phase ?? current.value.planned_final_phase)
        ) return issue("STATE_INVALID", current.value, "migration-audit-phase-plan-insufficient");
      }
      const waiver = waiverContext(input.context);
      if (waiver !== undefined && input.waiver_origin_gate_id !== undefined && input.waiver_origin_gate_id !== waiver.origin.origin_gate_id) return issue("CONTRACT_INVALID", undefined, "waiver-origin-gate-mismatch");
      if (waiver !== undefined) {
        const origin = await authenticateWaiverOrigin(dependencies, input.authority, waiver);
        if (!origin.ok) return origin;
      }
      const contextDigest = waiver === undefined
        ? computeGateContextDigest(input.kind, input.context as never)
        : computeGateContextDigest("waiver", waiver);
      const openState = stateWithOpen(
        withLastSeenConfig(current.value, live.value.config, live.value.repository_set),
        { gate_id: gateId, kind: input.kind, subject_digest: input.subject_digest, context_digest: contextDigest, context: input.context } as Pick<GateRequestV1, "gate_id" | "kind" | "subject_digest" | "context_digest" | "context">,
      );
      let request = parseGateRequest({
        schema_version: "1", gate_id: gateId, intent_id: input.intent_id, request_digest: input.request_digest,
        task_id: input.authority.task_id, phase_instance: input.phase_instance, summary: input.summary,
        subject_digest: input.subject_digest, context_digest: contextDigest, current_evidence: input.current_evidence,
        kind: input.kind, context: input.context, allowed_decisions: waiver === undefined ? decisionsForGate(input.kind, input.context) : ["grant", "deny", "cancel"], opened_at_revision: current.value.revision + 1,
      });
      let requestDocument = canonicalDocument(request);
      const created = await dependencies.atomic.createExclusive(requestPath.value, requestDocument.bytes);
      if (created === "exists") {
        const existing = await readCanonical(requestPath.value, "gate request", parsePersistedGateRequest);
        if (existing === "missing" || existing === "invalid" || existing.value.gate_id !== gateId || existing.value.intent_id !== input.intent_id || existing.value.request_digest !== input.request_digest) return issue("STATE_INVALID", current.value, "gate-request-collision");
        request = existing.value;
        requestDocument = existing;
      }
      // A crash may leave a human-authored interface before state names the gate. Preserve it only
      // when it binds this exact immutable request; an unrelated stale interface is safe to remove.
      const pendingInterface = await resolvePath(dependencies, input.authority, "gate.decision", "workspace-gate-interface");
      if (!pendingInterface.ok) return pendingInterface;
      const pending = await readCanonical(pendingInterface.value, "gate decision interface", (value) => value as PlainJsonValue);
      if (pending !== "missing") {
        let bound = false;
        if (pending !== "invalid") {
          try { parseInterface(pending.value, request); bound = true; } catch { /* stale interface */ }
        }
        if (!bound) await dependencies.atomic.removeGateInterface(pendingInterface.value);
      }
      const gateJson = await resolvePath(dependencies, input.authority, "gate.json", "workspace-gate-interface");
      if (!gateJson.ok) return gateJson;
      await ensureWorkspaceProjectionParent(input.authority, gateJson.value.absolute as ResolvedTaskWorkspacePath);
      await dependencies.atomic.replace(gateJson.value, canonicalDocument(parseActiveGate(activeProjection(request))).bytes);
      await dependencies.atomic.replace(input.authority.state, openState.bytes);
      return ok({ gate_id: gateId, state: openState, request: requestDocument });
    });
  } catch (error) {
    return error instanceof TaskLockError ? io(input.authority, `gate-lock-${error.stage}`) : io(input.authority, "gate-open");
  }
}

function nextStateForRecord(
  state: TaskStateV1,
  record: GateDecisionRecordV1,
  digest: Sha256Digest,
  plannedFinalPhase?: number | null,
): CanonicalDocument<TaskStateV1> {
  const revision = parseSafeInteger(state.revision + 1);
  const approvals = [...state.approvals];
  const waivers = [...state.waivers];
  if (record.outcome === "decided" && gateDecisionEffect(record.envelope.payload) === "advance") {
    approvals.push({ gate_id: record.gate_id, gate_kind: record.kind, subject_digest: record.subject_digest, decision_digest: digest, resolved_at_revision: revision } as ApprovalRef);
    approvals.sort((a, b) => a.gate_id.localeCompare(b.gate_id));
  }
  if (record.outcome === "waiver-decided") {
    waivers.push({ gate_id: record.gate_id, rule_id: record.origin.rule.rule_id, rule_version: record.origin.rule.rule_version, subject_digest: record.origin.subject_digest, scope: record.scope, granted: record.granted, expires: "task-complete", granted_at_revision: revision } as WaiverRef);
    waivers.sort((a, b) => a.gate_id.localeCompare(b.gate_id));
  }
  const { open_gate: _open, last_transition: _transition, ...base } = state;
  const { planned_final_phase: existingPlannedFinalPhase, ...withoutPlannedFinalPhase } = base;
  const preserved = plannedFinalPhase === undefined
    ? { ...withoutPlannedFinalPhase, ...(existingPlannedFinalPhase === undefined ? {} : { planned_final_phase: existingPlannedFinalPhase }) }
    : { ...withoutPlannedFinalPhase, ...(plannedFinalPhase === null ? {} : { planned_final_phase: parseSafeInteger(plannedFinalPhase) }) };
  return canonicalDocument({ ...preserved, revision, approvals, waivers } as TaskStateV1);
}

/** Review predecessor reconstruction for the post-waiver fixed-point assessment. */
function waiverReviewPredecessor(
  state: TaskStateV1,
  produce: CurrentProduceSubject,
): Readonly<{ subject_digest: Sha256Digest; input_fingerprint: Sha256Digest }> | undefined {
  const declared = produce.artifact.artifact_kind === "document"
    ? produce.artifact.editorial_predecessor
    : undefined;
  if (declared !== undefined) return Object.freeze({
    subject_digest: declared.subject_digest,
    input_fingerprint: declared.input_fingerprint,
  });
  const reference = state.authoritative_results.find((candidate) =>
    candidate.phase_instance === state.phase_instance && candidate.step === "produce");
  const simple = reference === undefined ? undefined : [...(state.human_revision_history ?? [])]
    .reverse().find((revision) =>
      revision.phase_instance === state.phase_instance &&
      revision.classification === "simple" &&
      revision.resulting_result_digest === reference.result_digest);
  return simple === undefined ? undefined : Object.freeze({
    subject_digest: simple.predecessor_subject_digest,
    input_fingerprint: simple.predecessor_input_fingerprint,
  });
}

/**
 * Authenticates the one gate-resolution settlement seam: a granted waiver for the current policy
 * subject. It assesses the state after the waiver is installed and appends a settlement only when
 * that prospective state is otherwise a clean final-review fixed point. Other gate decisions never
 * reach this function.
 */
async function stateAfterPolicyWaiverSettlement(
  dependencies: GateLifecycleDependencies,
  authority: TransactionAuthority,
  current: CanonicalDocument<TaskStateV1>,
  request: GateRequestV1,
  record: Extract<GateDecisionRecordV1, { outcome: "waiver-decided" }>,
  digest: Sha256Digest,
): Promise<ProjectResult<CanonicalDocument<TaskStateV1>>> {
  const waiver = waiverContext(request.context);
  if (
    !record.granted || waiver === undefined ||
    record.origin.origin_gate_id !== waiver.origin.origin_gate_id ||
    record.origin.subject_digest !== request.subject_digest ||
    request.subject_digest !== current.value.open_gate?.subject_digest ||
    request.phase_instance !== current.value.phase_instance || current.value.status !== "succeeded"
  ) return issue("STATE_INVALID", current.value, "policy-waiver-settlement-boundary-invalid");
  const originAuthenticated = await authenticateWaiverOrigin(dependencies, authority, waiver);
  if (!originAuthenticated.ok) return originAuthenticated;

  const produce = await loadCurrentProduceSubject(dependencies, current.value);
  if (!produce.ok) return produce;
  if (produce.value.artifact_digest !== request.subject_digest) {
    return issue("STATE_INVALID", current.value, "policy-waiver-settlement-subject-stale");
  }
  const finalTriage = current.value.step === "triage";
  const editorialReentry = current.value.step === "produce" &&
    produce.value.artifact.artifact_kind === "document" &&
    produce.value.artifact.editorial_predecessor !== undefined &&
    current.value.pending_human_revision === undefined;
  if (!finalTriage && !editorialReentry) {
    // The waiver itself remains a valid human decision, but this cursor is not one of the two
    // authenticated settlement boundaries. In particular, a simple human revision never gains
    // a settlement from waiver resolution and still returns for approval of its final bytes.
    return ok(nextStateForRecord(current.value, record, digest));
  }
  if (dependencies.load_retained_manifest === undefined) {
    return issue("STATE_INVALID", current.value, "policy-waiver-settlement-evidence-unavailable");
  }
  const retained = await loadRetainedEvidence(
    { load_retained_manifest: dependencies.load_retained_manifest },
    current.value,
    current.value.phase_instance,
  );
  if (!retained.ok) return retained;
  const constitution = await resolvePinnedConstitution(
    dependencies.runner, current.value.policy_base_commit, authority.context,
  );
  if (!constitution.ok) return constitution;

  const authenticated: AuthenticatedGateApproval[] = [];
  for (const approval of current.value.approvals) {
    const loaded = await loadAuthenticatedGateApproval(dependencies, authority, approval);
    if (!loaded.ok) return loaded;
    if (!authenticatedApprovalIsEligibleAfterLatestRestart(current.value, loaded.value)) continue;
    assertAuthenticatedGateApproval(loaded.value);
    authenticated.push(loaded.value);
  }
  const authenticatedPushThroughs = [];
  for (const pushThrough of current.value.review_push_throughs ?? []) {
    const loaded = await loadAuthenticatedReviewPushThrough(dependencies, authority, pushThrough);
    if (loaded.ok) authenticatedPushThroughs.push(loaded.value);
  }
  const upstreamDigests = new Set<Sha256Digest>();
  for (const binding of produceUpstreamBindingsForSubject(current.value, produce.value.artifact)) {
    const upstream = await loadProduceUpstreamSubject(dependencies, authority, current.value, binding);
    if (!upstream.ok) return upstream;
    if ("imported_projection" in upstream.value) {
      if (current.value.phase_instance !== "design" && !authenticated.some((approval) =>
        approval.request.kind === "migration-audit" &&
        approval.decision.envelope.payload.decision === "accept-import-audit")) {
        return issue("STATE_INVALID", current.value, "policy-waiver-settlement-upstream-invalid");
      }
    } else {
      const humanApproved = authenticated.some((approval) =>
        approval.approval.subject_digest === upstream.value.artifact_digest &&
        (approval.request.kind === "artifact-approval" || approval.request.kind === "design-approval"));
      if (!humanApproved) {
        return issue("STATE_INVALID", current.value, "policy-waiver-settlement-upstream-invalid");
      }
    }
    upstreamDigests.add(upstream.value.artifact_digest);
  }

  const prospective = nextStateForRecord(current.value, record, digest);
  const config = await dependencies.read_config(authority.config);
  if (config.kind !== "valid") {
    return issue("STATE_INVALID", current.value, "policy-waiver-settlement-config-unavailable");
  }
  const predecessor = waiverReviewPredecessor(prospective.value, produce.value);
  let assessment;
  try {
    assessment = assessCurrentEvidence(prospective.value, retained.value, {
      subject_digest: produce.value.artifact_digest,
      input_fingerprint: prospective.value.input_fingerprint,
      constitution: constitution.value,
      approved_upstream_digests: Object.freeze([...upstreamDigests].sort()),
      authenticated_gate_approvals: authenticated,
      ...(authenticatedPushThroughs.length === 0 ? {} : {
        review_push_through_authority: reviewPushThroughAuthoritySource(authenticatedPushThroughs),
      }),
      ...(predecessor === undefined ? {} : { review_predecessor: predecessor }),
      ...(config.snapshot.parsed.max_attempts === undefined
        ? {}
        : { max_attempts: config.snapshot.parsed.max_attempts }),
    });
  } catch {
    return issue("STATE_INVALID", current.value, "policy-waiver-settlement-fixed-point-invalid");
  }
  if (assessment.escalated_human_findings === true || assessment.next !== "advance") return ok(prospective);

  const changedDocuments = await changedCoProducedDocumentPaths(dependencies, current.value, produce.value);
  if (!changedDocuments.ok) return changedDocuments;
  const ruleContext = approvalRuleContext(current.value, produce.value, config.snapshot.parsed, changedDocuments.value);
  const conclusion = evaluateApprovalRules(
    ruleContext.config, ruleContext.subject, ruleContext.changedPaths, ruleContext.secondaryChangedPaths,
  );
  const kind = decodePhaseInstance(current.value.phase_instance).kind;
  const milestoneBearing = !conclusion.wait &&
    (kind === "design" || kind === "phase-design" || kind === "phase-impl");
  const symbolicTarget = milestoneBearing
    ? await dependencies.runner.runText({
        argv: ["symbolic-ref", "--quiet", "HEAD"],
        operation: parseSafeCode("git-rule-settlement-target"),
        expectedAbsence: [{ code: 1, stderrIncludes: "" }],
      })
    : undefined;
  const milestoneTargetRef = symbolicTarget === undefined ? undefined : symbolicTarget === "" ? "HEAD" : symbolicTarget;
  const milestoneTargetHead = milestoneTargetRef === undefined
    ? undefined
    : await resolveCommit(dependencies.runner, milestoneTargetRef);
  const milestoneBaseline = milestoneTargetRef === undefined
    ? undefined
    : produce.value.artifact.artifact_kind === "implementation-output"
      ? produce.value.artifact.base_commit
      : milestoneTargetHead;
  const settled = nextStateForRecord(current.value, record, digest);
  let secondaryMilestones = Object.freeze([]) as Awaited<ReturnType<typeof buildSecondaryCommitAuthorizationFacts>>;
  // Secondary commit facts exist only on milestone-bearing wait:false settlements; a content-rule
  // wait settles nothing about commits, so no secondary observation happens for it.
  if (!conclusion.wait && produce.value.artifact.artifact_kind === "implementation-output") {
    const resolvedRepositories = await resolveRepositorySet(
      { runner: dependencies.runner, environment: dependencies.environment },
      config.snapshot.parsed,
      authority.context,
    );
    if (!resolvedRepositories.ok) return resolvedRepositories;
    const continuity = validateRepositorySetContinuity(current.value, resolvedRepositories.value);
    if (!continuity.ok) return continuity;
    try {
      secondaryMilestones = await buildSecondaryCommitAuthorizationFacts(
        produce.value.artifact,
        resolvedRepositories.value,
      );
    } catch (error) {
      if (!(error instanceof SecondaryCommitObservationError)) throw error;
      return issue(
        "STATE_INVALID", current.value, `policy-waiver-settlement-secondary-${error.repository}-${error.reason}`,
      );
    }
  }
  const settlement = buildRuleSettlement(
    current.value, produce.value.artifact_digest, config.snapshot.digest, conclusion, milestoneBaseline,
    milestoneTargetRef === undefined || milestoneTargetHead === undefined
      ? undefined
      : { ref: milestoneTargetRef, head: milestoneTargetHead },
    secondaryMilestones,
  );
  const ruleSettlements = Object.freeze([
    ...(settled.value.rule_settlements ?? []),
    settlement,
  ].sort(compareRuleSettlements));
  return ok(canonicalDocument({ ...settled.value, rule_settlements: ruleSettlements } as TaskStateV1));
}

function enactsReentry(record: GateDecisionRecordV1): boolean {
  if (record.outcome !== "decided") return false;
  const decision = record.envelope.payload.decision;
  return (record.kind === "artifact-approval" && decision === "revise") ||
    (record.kind === "design-approval" && decision === "revise") ||
    (record.kind === "constitution-review" && decision === "revise") ||
    (record.kind === "material-drift" && decision === "revise-current") ||
    (record.kind === "attempts-exhausted" && (decision === "retry-once" || decision === "revise")) ||
    (record.kind === "commit-authorization" && decision === "revise") ||
    (record.kind === "migration-audit" && decision === "revise");
}

function beginsHumanRevision(record: GateDecisionRecordV1): boolean {
  if (record.outcome !== "decided") return false;
  const decision = record.envelope.payload.decision;
  return (record.kind === "artifact-approval" && decision === "revise") ||
    (record.kind === "design-approval" && decision === "revise") ||
    (record.kind === "constitution-review" && decision === "revise") ||
    (record.kind === "material-drift" && decision === "revise-current") ||
    (record.kind === "attempts-exhausted" && decision === "revise") ||
    (record.kind === "commit-authorization" && decision === "revise") ||
    (record.kind === "migration-audit" && decision === "revise");
}

function enactsPlanningRestart(record: GateDecisionRecordV1): boolean {
  return record.outcome === "decided" && record.kind === "material-drift" &&
    record.envelope.payload.decision === "amend-upstream";
}

function exactOpenGateMatches(state: TaskStateV1, request: GateRequestV1): boolean {
  const open = state.open_gate;
  if (
    open === undefined ||
    open.gate_id !== request.gate_id ||
    open.gate_kind !== request.kind ||
    open.subject_digest !== request.subject_digest ||
    open.context_digest !== request.context_digest ||
    open.opened_at_revision !== request.opened_at_revision ||
    state.revision !== request.opened_at_revision ||
    state.phase_instance !== request.phase_instance
  ) return false;
  const { open_gate: _open, last_transition: _transition, ...base } = state;
  return open.frozen_state_digest === openGateFrozenStateDigest(base as TaskStateV1);
}

export type StaleBaselineRefreshPlan = Readonly<{
  state: CanonicalDocument<TaskStateV1>;
  supersession: CanonicalDocument<StaleBaselineGateSupersessionV1>;
}>;

export type LiveBaselineSubject = Readonly<{
  context: Extract<GateRequestV1, { readonly kind: "baseline-adoption" }>["context"];
  presented_head_on_current_first_parent: boolean;
}>;

export type StaleBaselineRefreshResult = Readonly<{
  state: CanonicalDocument<TaskStateV1>;
  supersession: CanonicalDocument<StaleBaselineGateSupersessionV1>;
  replayed: boolean;
}>;

/**
 * Plans the authority-only portion of `refresh-stale-baseline`. The caller owns repository
 * discovery and atomically archiving the returned record/removing the disposable projection.
 * This function deliberately does not open a replacement gate: fresh status must compose it from
 * the newly observed subject.
 */
export function planStaleBaselineGateRefresh(
  current: CanonicalDocument<TaskStateV1>,
  request: Extract<GateRequestV1, { readonly kind: "baseline-adoption" }>,
  liveContext: Extract<GateRequestV1, { readonly kind: "baseline-adoption" }>["context"],
): ProjectResult<StaleBaselineRefreshPlan> {
  if (!exactOpenGateMatches(current.value, request)) {
    return issue("STATE_INVALID", current.value, "stale-baseline-open-gate-mismatch");
  }
  const liveSubjectDigest = baselineAdoptionDriftDigest(liveContext);
  const liveContextDigest = computeGateContextDigest("baseline-adoption", liveContext);
  if (liveSubjectDigest === request.subject_digest && liveContextDigest === request.context_digest) {
    return issue("STATE_INVALID", current.value, "baseline-adoption-interface-current");
  }
  const resultingRevision = parseSafeInteger(current.value.revision + 1);
  const { open_gate: _openGate, last_transition: _lastTransition, ...preserved } = current.value;
  const next = canonicalDocument({ ...preserved, revision: resultingRevision } as TaskStateV1);
  const supersession = canonicalDocument({
    schema_version: "1",
    gate_id: request.gate_id,
    task_id: request.task_id,
    phase_instance: request.phase_instance,
    kind: "baseline-adoption",
    subject_digest: request.subject_digest,
    context_digest: request.context_digest,
    outcome: "superseded-stale-baseline",
    live_subject_digest: liveSubjectDigest,
    live_context_digest: liveContextDigest,
    superseded_at_revision: resultingRevision,
  } satisfies StaleBaselineGateSupersessionV1);
  return ok(Object.freeze({ state: next, supersession }));
}

/**
 * Locked, crash-resumable stale-interface mutation. Live discovery runs inside the task lock. The
 * immutable archive is installed before state is replaced, so a crash can only leave an archive
 * that the next call authenticates and completes; it can never clear the open authority without
 * preserving why. Disposable gate projections are removed only after durable state lands.
 */
export async function refreshStaleBaselineGate(
  dependencies: GateLifecycleDependencies,
  authority: TransactionAuthority,
  expectedRevision: number,
  discoverLiveSubject: (
    current: CanonicalDocument<TaskStateV1>,
    request: Extract<GateRequestV1, { readonly kind: "baseline-adoption" }>,
  ) => Promise<ProjectResult<LiveBaselineSubject>>,
): Promise<ProjectResult<StaleBaselineRefreshResult>> {
  try {
    return await dependencies.lock.runExclusive(authority.workspace_root, async () => {
      const stateResult = await stateOrFailure(dependencies, authority);
      if (!stateResult.ok) return stateResult;
      const current = stateResult.value;
      if (current.value.revision !== expectedRevision) {
        return issue("STATE_INVALID", current.value, "stale-baseline-revision-mismatch");
      }
      const open = current.value.open_gate;
      if (open === undefined || open.gate_kind !== "baseline-adoption") {
        return issue("STATE_INVALID", current.value, "stale-baseline-open-gate-missing");
      }
      const requestPath = await resolvePath(dependencies, authority, gateRequestClaim(open.gate_id), "authority-decision");
      const archivePath = await resolvePath(dependencies, authority, gateDecisionClaim(open.gate_id), "authority-decision");
      if (!requestPath.ok) return requestPath;
      if (!archivePath.ok) return archivePath;
      const loaded = await readCanonical(requestPath.value, "baseline gate request", parsePersistedGateRequest);
      if (loaded === "missing" || loaded === "invalid" || loaded.value.kind !== "baseline-adoption") {
        return issue("STATE_INVALID", current.value, "stale-baseline-request-invalid");
      }
      const request = loaded.value as Extract<GateRequestV1, { readonly kind: "baseline-adoption" }>;
      const existing = await readCanonical(archivePath.value, "stale baseline supersession", (value) => {
        const parsed = parseArchivedGateDecisionRecord(value);
        if (parsed.outcome !== "superseded-stale-baseline") throw new TypeError("not a stale baseline supersession");
        return parsed;
      });
      if (existing === "invalid") return issue("STATE_INVALID", current.value, "stale-baseline-archive-invalid");

      let plan: ProjectResult<StaleBaselineRefreshPlan>;
      if (existing === "missing") {
        const live = await discoverLiveSubject(current, request);
        if (!live.ok) return live;
        const freshness = assessBaselineSubjectFreshness(
          request, live.value.context, live.value.presented_head_on_current_first_parent,
        );
        if (freshness.classification !== "stale") {
          return issue("STATE_INVALID", current.value, "baseline-adoption-interface-current");
        }
        plan = planStaleBaselineGateRefresh(current, request, live.value.context);
        if (!plan.ok) return plan;
        if (await dependencies.atomic.createExclusive(archivePath.value, plan.value.supersession.bytes) !== "created") {
          return issue("STATE_INVALID", current.value, "stale-baseline-supersession-race");
        }
      } else {
        if (
          existing.value.gate_id !== request.gate_id ||
          existing.value.task_id !== request.task_id ||
          existing.value.phase_instance !== request.phase_instance ||
          existing.value.subject_digest !== request.subject_digest ||
          existing.value.context_digest !== request.context_digest ||
          existing.value.superseded_at_revision !== current.value.revision + 1
        ) return issue("STATE_INVALID", current.value, "stale-baseline-archive-binding-invalid");
        const { open_gate: _openGate, last_transition: _transition, ...preserved } = current.value;
        plan = ok({
          state: canonicalDocument({ ...preserved, revision: parseSafeInteger(current.value.revision + 1) } as TaskStateV1),
          supersession: existing,
        });
      }
      if (!plan.ok) return plan;
      await dependencies.atomic.replace(authority.state, plan.value.state.bytes);
      for (const projection of ["gate.json", "gate.decision"] as const) {
        const path = await resolvePath(dependencies, authority, projection, "workspace-gate-interface");
        if (path.ok) await dependencies.atomic.removeGateInterface(path.value);
      }
      return ok(Object.freeze({ ...plan.value, replayed: existing !== "missing" }));
    });
  } catch (error) {
    return error instanceof TaskLockError ? io(authority, `stale-baseline-lock-${error.stage}`) : io(authority, "stale-baseline-refresh");
  }
}

function completedMaterialDriftRestartMatches(
  state: TaskStateV1,
  request: GateRequestV1,
  record: GateDecisionRecordV1,
): boolean {
  if (
    request.kind !== "material-drift" || record.outcome !== "decided" ||
    record.kind !== "material-drift" || record.envelope.payload.decision !== "amend-upstream"
  ) return false;
  const restart = state.restart_history?.find((entry) => entry.restart_id === record.gate_id);
  return restart !== undefined &&
    restart.source_phase_instance === request.phase_instance &&
    restart.target_phase_instance === state.phase_instance &&
    restart.reason === record.envelope.payload.reason &&
    restart.restarted_at_revision === request.opened_at_revision + 1 &&
    state.revision >= restart.restarted_at_revision &&
    isDeepStrictEqual(restart.human_provenance, record.envelope.human_provenance);
}

/** One affected digest may authorize exactly one producer phase; conflicting ownership fails closed. */
export function uniqueMaterialDriftUpstream(
  subjects: readonly ProduceUpstreamSubject[],
  affectedDigest: Sha256Digest,
): ProduceUpstreamSubject | undefined {
  const matching = subjects.filter((subject) => subject.artifact_digest === affectedDigest);
  const phases = new Set(matching.map((subject) => subject.artifact.phase_instance));
  return phases.size === 1 ? matching[0] : undefined;
}

async function planGateAuthorizedReentry(
  dependencies: GateLifecycleDependencies,
  authority: TransactionAuthority,
  current: CanonicalDocument<TaskStateV1>,
  request: GateRequestV1,
  record: GateDecisionRecordV1,
): Promise<ProjectResult<CanonicalDocument<TaskStateV1>>> {
  if (!enactsReentry(record)) throw new TypeError("gate record does not authorize re-entry");
  if (!exactOpenGateMatches(current.value, request)) {
    return issue("STATE_INVALID", current.value, "gate-reentry-predecessor-mismatch");
  }
  if (
    current.value.status !== "succeeded" ||
    current.value.step !== "triage"
  ) return issue("STATE_INVALID", current.value, "gate-reentry-predecessor-mismatch");
  if (request.kind === "attempts-exhausted") {
    if (
      request.context.step !== current.value.step ||
      request.context.attempts !== current.value.attempt ||
      request.context.maximum_attempts > request.context.attempts
    ) return issue("STATE_INVALID", current.value, "gate-reentry-attempt-context-mismatch");
  }
  if (dependencies.resolve_gate_reentry_fingerprint === undefined) {
    return issue("STATE_INVALID", current.value, "gate-reentry-fingerprint-unavailable");
  }
  const fingerprint = await dependencies.resolve_gate_reentry_fingerprint({
    authority,
    request,
    current,
  });
  if (!fingerprint.ok) return fingerprint;
  const { open_gate: _open, last_transition: _transition, ...predecessor } = current.value;
  const transition = planStateTransition({
    current: predecessor as TaskStateV1,
    target: {
      phase_instance: current.value.phase_instance,
      step: "produce",
      status: "running",
      attempt: beginsHumanRevision(record)
        ? current.value.attempt
        : parseSafeInteger(current.value.attempt + 1),
      input_fingerprint: fingerprint.value,
    },
    recomputed_input_fingerprint: fingerprint.value,
    human_revision_reentry: beginsHumanRevision(record),
  });
  if (!transition.ok) return transition;
  const revision = parseSafeInteger(current.value.revision + 1);
  const evidence = current.value.authoritative_results.filter((entry) =>
    entry.phase_instance === current.value.phase_instance &&
    (entry.step === "counter_review" || entry.step === "adjudicate" || entry.step === "triage"));
  return ok(canonicalDocument({
    ...transition.value,
    revision,
    ...(beginsHumanRevision(record) ? {
      pending_human_revision: {
        gate_id: record.gate_id,
        gate_kind: record.kind,
        predecessor_subject_digest: record.subject_digest,
        predecessor_input_fingerprint: current.value.input_fingerprint,
        requested_at_revision: revision,
        attempt: current.value.attempt,
        evidence,
      },
    } : {}),
  } as TaskStateV1));
}

async function closedStateForRecord(
  dependencies: GateLifecycleDependencies,
  authority: TransactionAuthority,
  current: CanonicalDocument<TaskStateV1>,
  request: GateRequestV1,
  record: GateDecisionRecordV1,
  digest: Sha256Digest,
  repositorySet?: RepositorySet,
): Promise<ProjectResult<CanonicalDocument<TaskStateV1>>> {
  if (
    request.kind === "attempts-exhausted" && record.outcome === "decided" &&
    record.kind === "attempts-exhausted" &&
    record.envelope.payload.decision === "push-through-review"
  ) {
    if (
      !exactOpenGateMatches(current.value, request) ||
      current.value.step !== "triage" || current.value.status !== "succeeded" ||
      request.context.review_push_through === undefined ||
      request.context.attempts !== current.value.attempt ||
      request.context.maximum_attempts > request.context.attempts ||
      record.envelope.human_provenance.actor_class !== "human" ||
      record.envelope.human_provenance.channel !== "connected-host" ||
      dependencies.load_retained_manifest === undefined
    ) return issue("STATE_INVALID", current.value, "review-push-through-settlement-boundary-invalid");
    const retained = await loadRetainedEvidence(
      { load_retained_manifest: dependencies.load_retained_manifest },
      current.value,
      current.value.phase_instance,
    );
    if (!retained.ok) return retained;
    const produce = await loadCurrentProduceSubject(dependencies, current.value);
    if (!produce.ok) return produce;
    const constitution = await resolvePinnedConstitution(
      dependencies.runner,
      current.value.policy_base_commit,
      authority.context,
    );
    if (!constitution.ok) return constitution;
    const predecessor = currentReviewPredecessor(current.value, produce.value);
    const candidate = deriveReviewPushThroughCandidate(current.value, retained.value, {
      subject_digest: produce.value.artifact_digest,
      input_fingerprint: current.value.input_fingerprint,
      constitution: constitution.value,
      ...(predecessor === undefined ? {} : { review_predecessor: predecessor }),
    });
    if (
      candidate === undefined || request.subject_digest !== candidate.subject_digest ||
      !("set_digest" in request.current_evidence) ||
      request.current_evidence.set_digest !== candidate.context.current_evidence_set_digest ||
      !isDeepStrictEqual(request.context.review_push_through, candidate.context)
    ) return issue("STATE_INVALID", current.value, "review-push-through-settlement-stale");
    const settled = nextStateForRecord(current.value, record, digest);
    if ((settled.value.review_push_throughs ?? []).some((entry) => entry.gate_id === record.gate_id)) {
      return issue("STATE_INVALID", current.value, "review-push-through-gate-duplicate");
    }
    const ordinalOccurrences = [...candidate.context.accepted_occurrences].sort((left, right) =>
      left.review_evidence_digest < right.review_evidence_digest ? -1 :
        left.review_evidence_digest > right.review_evidence_digest ? 1 :
          left.finding_id < right.finding_id ? -1 : left.finding_id > right.finding_id ? 1 : 0);
    const pushThrough: ReviewPushThroughRecordV1 = Object.freeze({
      gate_id: record.gate_id,
      decision_digest: digest,
      phase_instance: current.value.phase_instance,
      subject_digest: candidate.subject_digest,
      current_evidence_set_digest: candidate.context.current_evidence_set_digest,
      triage_result_digest: candidate.context.triage_result_digest,
      accepted_occurrences: Object.freeze(ordinalOccurrences),
      attempt: current.value.attempt,
      human_reason: record.envelope.payload.reason,
      decided_at: record.envelope.human_provenance.recorded_at,
      resolved_at_revision: settled.value.revision,
    });
    const reviewPushThroughs = Object.freeze([
      ...(settled.value.review_push_throughs ?? []),
      pushThrough,
    ].sort((left, right) => left.phase_instance < right.phase_instance ? -1 :
      left.phase_instance > right.phase_instance ? 1 :
        left.gate_id < right.gate_id ? -1 : left.gate_id > right.gate_id ? 1 : 0));
    let prospective = canonicalDocument({
      ...settled.value,
      review_push_throughs: reviewPushThroughs,
    } as TaskStateV1);

    const authenticatedApprovals: AuthenticatedGateApproval[] = [];
    for (const approval of current.value.approvals) {
      const loaded = await loadAuthenticatedGateApproval(dependencies, authority, approval);
      if (!loaded.ok) return loaded;
      if (!authenticatedApprovalIsEligibleAfterLatestRestart(current.value, loaded.value)) continue;
      authenticatedApprovals.push(loaded.value);
    }
    const approvedUpstreams = await currentApprovedUpstreams(
      dependencies,
      authority,
      current.value,
      authenticatedApprovals,
      produce.value,
    );
    const config = await dependencies.read_config(authority.config);
    if (config.kind !== "valid") {
      return issue("STATE_INVALID", current.value, "review-push-through-settlement-config-unavailable");
    }
    const localAuthority = Object.freeze({
      values: Object.freeze([pushThrough] as const),
      authenticate(value: unknown) {
        if (value !== pushThrough) throw new TypeError("unknown settling review push-through authority");
        return Object.freeze({
          task_id: current.value.task_id,
          phase_instance: pushThrough.phase_instance,
          attempt: pushThrough.attempt,
          subject_digest: pushThrough.subject_digest,
          current_evidence_set_digest: pushThrough.current_evidence_set_digest,
          triage_result_digest: pushThrough.triage_result_digest,
          accepted_occurrences: pushThrough.accepted_occurrences,
        });
      },
    });
    let postPushAssessment;
    try {
      postPushAssessment = assessCurrentEvidence(prospective.value, retained.value, {
        subject_digest: produce.value.artifact_digest,
        input_fingerprint: prospective.value.input_fingerprint,
        constitution: constitution.value,
        approved_upstream_digests: approvedUpstreams,
        authenticated_gate_approvals: authenticatedApprovals,
        review_push_through_authority: localAuthority,
        ...(predecessor === undefined ? {} : { review_predecessor: predecessor }),
        ...(config.snapshot.parsed.max_attempts === undefined ? {} : {
          max_attempts: config.snapshot.parsed.max_attempts,
        }),
      });
    } catch {
      return issue("STATE_INVALID", current.value, "review-push-through-settlement-fixed-point-invalid");
    }
    if (postPushAssessment.escalated_human_findings === true || postPushAssessment.next !== "advance") {
      return ok(prospective);
    }
    const changedDocuments = await changedCoProducedDocumentPaths(
      dependencies,
      current.value,
      produce.value,
    );
    if (!changedDocuments.ok) return changedDocuments;
    const ruleContext = approvalRuleContext(
      current.value,
      produce.value,
      config.snapshot.parsed,
      changedDocuments.value,
    );
    const conclusion = evaluateApprovalRules(
      ruleContext.config,
      ruleContext.subject,
      ruleContext.changedPaths,
      ruleContext.secondaryChangedPaths,
    );
    const phaseKind = decodePhaseInstance(current.value.phase_instance).kind;
    const milestoneBearing = !conclusion.wait &&
      (phaseKind === "design" || phaseKind === "phase-design" || phaseKind === "phase-impl");
    const symbolicTarget = milestoneBearing
      ? await dependencies.runner.runText({
          argv: ["symbolic-ref", "--quiet", "HEAD"],
          operation: parseSafeCode("git-push-through-settlement-target"),
          expectedAbsence: [{ code: 1, stderrIncludes: "" }],
        })
      : undefined;
    const milestoneTargetRef = symbolicTarget === undefined
      ? undefined
      : symbolicTarget === "" ? "HEAD" : symbolicTarget;
    const milestoneTargetHead = milestoneTargetRef === undefined
      ? undefined
      : await resolveCommit(dependencies.runner, milestoneTargetRef);
    const milestoneBaseline = milestoneTargetRef === undefined
      ? undefined
      : produce.value.artifact.artifact_kind === "implementation-output"
        ? produce.value.artifact.base_commit
        : milestoneTargetHead;
    let secondaryMilestones = Object.freeze([]) as Awaited<ReturnType<typeof buildSecondaryCommitAuthorizationFacts>>;
    if (!conclusion.wait && produce.value.artifact.artifact_kind === "implementation-output") {
      const resolvedRepositories = await resolveRepositorySet(
        { runner: dependencies.runner, environment: dependencies.environment },
        config.snapshot.parsed,
        authority.context,
      );
      if (!resolvedRepositories.ok) return resolvedRepositories;
      const continuity = validateRepositorySetContinuity(current.value, resolvedRepositories.value);
      if (!continuity.ok) return continuity;
      try {
        secondaryMilestones = await buildSecondaryCommitAuthorizationFacts(
          produce.value.artifact,
          resolvedRepositories.value,
        );
      } catch (error) {
        if (!(error instanceof SecondaryCommitObservationError)) throw error;
        return issue("STATE_INVALID", current.value,
          `review-push-through-settlement-secondary-${error.repository}-${error.reason}`);
      }
    }
    const ruleSettlement = buildRuleSettlement(
      current.value,
      produce.value.artifact_digest,
      config.snapshot.digest,
      conclusion,
      milestoneBaseline,
      milestoneTargetRef === undefined || milestoneTargetHead === undefined
        ? undefined
        : { ref: milestoneTargetRef, head: milestoneTargetHead },
      secondaryMilestones,
    );
    const ruleSettlements = Object.freeze([
      ...(prospective.value.rule_settlements ?? []),
      ruleSettlement,
    ].sort(compareRuleSettlements));
    prospective = canonicalDocument({
      ...prospective.value,
      rule_settlements: ruleSettlements,
    } as TaskStateV1);
    return ok(prospective);
  }
  if (request.kind === "validation-override" && record.kind === "validation-override") {
    const pending = current.value.pending_validation_override;
    const provenance = record.outcome === "decided"
      ? record.envelope.human_provenance
      : record.human_provenance;
    const subjectDigest = pending === undefined ? undefined : validationOverrideSubjectDigest({
      task_id: current.value.task_id,
      phase_instance: pending.phase_instance,
      input_fingerprint: pending.input_fingerprint,
      governing_phase_design_digest: pending.governing_phase_design_digest,
      displaced_validations: pending.displaced_validations,
    });
    const evidence = request.current_evidence as ValidationOverrideRequestRefV1;
    if (
      !exactOpenGateMatches(current.value, request) || pending === undefined ||
      current.value.step !== "produce" || current.value.status !== "failed" ||
      current.value.phase_instance !== pending.phase_instance ||
      current.value.input_fingerprint !== pending.input_fingerprint ||
      pending.request_revision + 1 !== current.value.revision ||
      request.context.request_revision !== pending.request_revision ||
      request.context.input_fingerprint !== pending.input_fingerprint ||
      request.context.governing_phase_design_digest !== pending.governing_phase_design_digest ||
      !isDeepStrictEqual(request.context.displaced_validations, pending.displaced_validations) ||
      request.context.producer_reason !== pending.producer_reason ||
      request.subject_digest !== subjectDigest ||
      evidence.evidence_kind !== "validation-override-request" ||
      evidence.task_id !== current.value.task_id || evidence.phase_instance !== pending.phase_instance ||
      evidence.input_fingerprint !== pending.input_fingerprint ||
      evidence.governing_phase_design_digest !== pending.governing_phase_design_digest ||
      evidence.request_revision !== pending.request_revision ||
      evidence.validation_request_subject_digest !== subjectDigest ||
      provenance.actor_class !== "human" || provenance.channel !== "connected-host"
    ) return issue("STATE_INVALID", current.value, "validation-override-settlement-binding-invalid");
    if (record.outcome === "decided" &&
        record.envelope.payload.decision !== "grant-validation-override" &&
        record.envelope.payload.decision !== "deny-validation-override") {
      return issue("STATE_INVALID", current.value, "validation-override-decision-invalid");
    }
    const revision = parseSafeInteger(current.value.revision + 1);
    const {
      open_gate: _open,
      last_transition: _transition,
      pending_validation_override: _pending,
      ...preserved
    } = current.value;
    let validationOverrides = preserved.validation_overrides;
    if (record.outcome === "decided" &&
        record.envelope.payload.decision === "grant-validation-override") {
      if ((validationOverrides ?? []).some((entry) => entry.gate_id === record.gate_id)) {
        return issue("STATE_INVALID", current.value, "validation-override-gate-duplicate");
      }
      const override: ValidationOverrideRecordV1 = Object.freeze({
        gate_id: record.gate_id,
        decision_digest: digest,
        phase_instance: pending.phase_instance,
        input_fingerprint: pending.input_fingerprint,
        governing_phase_design_digest: pending.governing_phase_design_digest,
        subject_digest: subjectDigest!,
        displaced_validations: Object.freeze([...pending.displaced_validations].sort((left, right) =>
          left < right ? -1 : left > right ? 1 : 0)),
        human_reason: record.envelope.payload.reason,
        decided_at: provenance.recorded_at,
        granted_at_revision: revision,
      });
      validationOverrides = Object.freeze([...(validationOverrides ?? []), override].sort((left, right) =>
        left.phase_instance < right.phase_instance ? -1 : left.phase_instance > right.phase_instance ? 1 :
          left.gate_id < right.gate_id ? -1 : left.gate_id > right.gate_id ? 1 : 0));
    }
    return ok(canonicalDocument({
      ...preserved,
      revision,
      ...(validationOverrides === undefined ? {} : { validation_overrides: validationOverrides }),
    } as TaskStateV1));
  }
  if (
    record.outcome === "decided" && record.kind === "material-drift" &&
    record.envelope.payload.decision === "amend-upstream" && request.kind === "material-drift"
  ) {
    if (!exactOpenGateMatches(current.value, request)) {
      return issue("STATE_INVALID", current.value, "material-drift-restart-predecessor-mismatch");
    }
    const subjects: ProduceUpstreamSubject[] = [];
    for (const binding of expectedProduceUpstreamBindings(current.value)) {
      const loaded = await loadProduceUpstreamSubject(dependencies, authority, current.value, binding);
      if (!loaded.ok) return loaded;
      subjects.push(loaded.value);
    }
    const upstream = uniqueMaterialDriftUpstream(subjects, request.context.affected_upstream.digest);
    if (upstream === undefined) {
      return issue("STATE_INVALID", current.value, "material-drift-upstream-subject-unavailable");
    }
    if (record.envelope.human_provenance.actor_class !== "human") {
      return issue("STATE_INVALID", current.value, "material-drift-restart-human-provenance-required");
    }
    const humanProvenance = planningRestartHumanProvenanceV1Schema.safeParse(
      record.envelope.human_provenance,
    );
    if (!humanProvenance.success) {
      return issue("STATE_INVALID", current.value, "material-drift-restart-human-provenance-required");
    }
    const targetPhase = upstream.artifact.phase_instance;
    const { open_gate: _open, last_transition: _transition, ...predecessor } = current.value;
    const restartPredecessor = predecessor as TaskStateV1;
    const liveConfig = await dependencies.read_config(authority.config);
    if (liveConfig.kind !== "valid") return issue("STATE_INVALID", current.value, "material-drift-restart-config-unavailable");
    const repositorySet = await resolveRepositorySet(
      { runner: dependencies.runner, environment: dependencies.environment },
      liveConfig.snapshot.parsed,
      authority.context,
    );
    if (!repositorySet.ok) return repositorySet;
    const continuity = validateRepositorySetContinuity(current.value, repositorySet.value);
    if (!continuity.ok) return continuity;
    const targetCall = parseToolCall("archflow_state", {
      schema_version: "1",
      task_id: authority.task_id,
      intent_id: record.gate_id,
      expected_revision: current.value.revision,
      input_fingerprint: current.value.input_fingerprint,
      phase_instance: targetPhase,
      step: "produce",
      status: "running",
    });
    const fingerprintSubject = await dependencies.resolve_input_fingerprint({
      runner: dependencies.runner,
      authority,
      state: canonicalDocument(restartPredecessor),
      call: targetCall,
      live_config: liveConfig.snapshot,
      context: authority.context,
    });
    if (!fingerprintSubject.ok) return fingerprintSubject;
    const fingerprint = fingerprintSubject.value.fingerprint;
    const planned = planPlanningRestart({
      current: restartPredecessor,
      restart_id: record.gate_id,
      target_phase_instance: targetPhase,
      reason: record.envelope.payload.reason,
      recomputed_input_fingerprint: fingerprint,
      human_provenance: humanProvenance.data,
    });
    return planned.ok
      ? ok(canonicalDocument(withLastSeenConfig(
          { ...planned.value, revision: parseSafeInteger(current.value.revision + 1) } as TaskStateV1,
          liveConfig.snapshot.parsed,
          repositorySet.value,
        )))
      : planned;
  }
  if (enactsReentry(record)) {
    return planGateAuthorizedReentry(dependencies, authority, current, request, record);
  }
  if (
    record.outcome === "waiver-decided" && record.granted &&
    waiverContext(request.context) !== undefined &&
    (current.value.step === "triage" || current.value.step === "produce") &&
    current.value.status === "succeeded" &&
    request.phase_instance === current.value.phase_instance &&
    request.subject_digest === current.value.open_gate?.subject_digest &&
    record.origin.subject_digest === request.subject_digest
  ) {
    return stateAfterPolicyWaiverSettlement(
      dependencies, authority, current, request, record, digest,
    );
  }
  if (
    record.outcome === "decided" &&
    record.kind === "design-approval" &&
    record.envelope.payload.decision === "approve" &&
    request.kind === "design-approval"
  ) {
    const symbolicRef = await dependencies.runner.runText({
      argv: ["symbolic-ref", "--quiet", "HEAD"],
      operation: parseSafeCode("git-design-approval-target"),
      expectedAbsence: [{ code: 1, stderrIncludes: "" }],
    });
    if ((request.context.target_ref === "HEAD" ? symbolicRef !== "" : symbolicRef !== request.context.target_ref) ||
        await resolveCommit(dependencies.runner, "HEAD") !== request.context.baseline_commit) {
      return issue("STATE_INVALID", current.value, "design-approval-git-target-changed");
    }
  }
  if (
    record.outcome === "decided" && record.kind === "migration-audit" &&
    record.envelope.payload.decision === "accept-import-audit" && request.kind === "migration-audit"
  ) {
    if (request.context.target_ref === undefined || request.context.baseline_commit === undefined) {
      return issue("STATE_INVALID", current.value, "migration-audit-commit-authority-missing");
    }
    const symbolicRef = await dependencies.runner.runText({
      argv: ["symbolic-ref", "--quiet", "HEAD"],
      operation: parseSafeCode("git-migration-audit-target"),
      expectedAbsence: [{ code: 1, stderrIncludes: "" }],
    });
    if ((request.context.target_ref === "HEAD" ? symbolicRef !== "" : symbolicRef !== request.context.target_ref) ||
        await resolveCommit(dependencies.runner, "HEAD") !== request.context.baseline_commit) {
      return issue("STATE_INVALID", current.value, "migration-audit-git-target-changed");
    }
  }
  if (
    record.outcome === "decided" && record.kind === "baseline-adoption" &&
    record.envelope.payload.decision === "adopt-current-bytes" && request.kind === "baseline-adoption"
  ) {
    // The decision is bound to exact bytes observed at gate open; any change between the human's
    // choice and this commit voids it. Replay is naturally idempotent: the adopted bytes remain.
    if (repositorySet === undefined) return issue("STATE_INVALID", current.value, "baseline-adoption-repository-set-unavailable");
    const targets = await discoverNewestProjections(dependencies, authority, current, repositorySet);
    if (!targets.ok) return targets;
    for (const target of baselineRepositoryTargets(request.context)) {
      for (const drifted of target.drifted_projections) {
        const entry = targets.value.get(projectionLookup(target.repository, drifted.path));
        if (entry === undefined || entry.retired || entry.projection.content_digest !== drifted.recorded_digest) {
          return issue("STATE_INVALID", current.value, "baseline-adoption-current-stale");
        }
        if (await currentProjectionDigest(entry.target) !== drifted.observed_digest) {
          return issue("STATE_INVALID", current.value, "baseline-adoption-current-stale");
        }
      }
    }
    const plannedFinalPhase = await loadApprovedDesignFinalPhase(dependencies, current.value, record);
    if (!plannedFinalPhase.ok) return plannedFinalPhase;
    const next = nextStateForRecord(current.value, record, digest, plannedFinalPhase.value);
    const adoptedSecondaryBytes = (request.context.secondary_targets ?? []).map(({ deleted_projections: _deleted, ...target }) => target);
    const baseline_adoptions = [...(next.value.baseline_adoptions ?? []), baselineAdoptionRecord(record.gate_id, next.value.revision, request.context.drifted_projections, [], adoptedSecondaryBytes)]
      .sort((left, right) => left.gate_id.localeCompare(right.gate_id));
    return ok(canonicalDocument({ ...next.value, baseline_adoptions: Object.freeze(baseline_adoptions) } as TaskStateV1));
  }
  if (
    record.outcome === "decided" && record.kind === "baseline-adoption" &&
    record.envelope.payload.decision === "adopt-committed-deletions" && request.kind === "baseline-adoption"
  ) {
    // The decision is bound to the exact recorded presences the human saw retired; each must
    // still be the newest recorded projection for its path and still be absent from the worktree
    // at commit time, or the decision is stale. Replay is naturally idempotent: the retirement
    // of an already-retired path changes nothing.
    if (repositorySet === undefined) return issue("STATE_INVALID", current.value, "baseline-adoption-repository-set-unavailable");
    const targets = await discoverNewestProjections(dependencies, authority, current, repositorySet);
    if (!targets.ok) return targets;
    for (const target of baselineRepositoryTargets(request.context)) {
      for (const deleted of target.deleted_projections) {
        const entry = targets.value.get(projectionLookup(target.repository, deleted.path));
        if (entry === undefined || entry.retired || entry.projection.content_digest !== deleted.recorded_digest) {
          return issue("STATE_INVALID", current.value, "baseline-adoption-deletion-stale");
        }
        if (await currentProjectionDigest(entry.target) !== "missing") {
          return issue("STATE_INVALID", current.value, "baseline-adoption-deletion-stale");
        }
      }
    }
    const plannedFinalPhase = await loadApprovedDesignFinalPhase(dependencies, current.value, record);
    if (!plannedFinalPhase.ok) return plannedFinalPhase;
    const next = nextStateForRecord(current.value, record, digest, plannedFinalPhase.value);
    const baseline_adoptions = [...(next.value.baseline_adoptions ?? []), baselineAdoptionRecord(record.gate_id, next.value.revision, request.context.drifted_projections, request.context.deleted_projections ?? [], request.context.secondary_targets ?? [])]
      .sort((left, right) => left.gate_id.localeCompare(right.gate_id));
    return ok(canonicalDocument({ ...next.value, baseline_adoptions: Object.freeze(baseline_adoptions) } as TaskStateV1));
  }
  if (
    record.outcome === "decided" && record.kind === "baseline-adoption" &&
    record.envelope.payload.decision === "restore-recorded-bytes" && request.kind === "baseline-adoption"
  ) {
    // A restore decision must be applicable before it becomes durable. Every drifted path's
    // recorded bytes must come from a retained manifest that still carries a usable
    // projection-plan entry; refusing here leaves the still-open interface correctable instead of
    // archiving a decision that can never apply behind the open gate.
    if (dependencies.load_retained_result === undefined) {
      return issue("STATE_INVALID", current.value, "baseline-adoption-restore-unavailable");
    }
    if (repositorySet === undefined) return issue("STATE_INVALID", current.value, "baseline-adoption-repository-set-unavailable");
    const owners = await baselineRestoreOwners(dependencies, authority, current, request.context, repositorySet);
    if (!owners.ok) return owners;
    for (const owner of owners.value) {
      if (owner.repository === "primary") {
        const retained = await dependencies.load_retained_result(owner.reference);
        if (!retained.ok) return retained;
        for (const drifted of owner.drifted) {
          const entry = retained.value.projection_plan.entries.find((item) => item.path === drifted.path);
          if (entry === undefined || entry.git_tracked === undefined) {
            return issue("STATE_INVALID", current.value, "baseline-adoption-restore-path-missing");
          }
        }
      } else {
        for (const drifted of owner.drifted) {
          const source = await readRetainedRepositoryOutput({
            primary_runner: dependencies.runner, authority, reference: owner.reference,
            repository_set: repositorySet, repository: owner.repository, output_path: drifted.path,
          });
          if (!source.ok) return source;
        }
      }
    }
  }
  const plannedFinalPhase = await loadApprovedDesignFinalPhase(dependencies, current.value, record);
  if (
    plannedFinalPhase.ok && plannedFinalPhase.value === undefined &&
    record.outcome === "decided" && record.kind === "migration-audit" &&
    record.envelope.payload.decision === "accept-import-audit" && request.kind === "migration-audit" &&
    request.context.planned_final_phase !== undefined
  ) {
    return ok(nextStateForRecord(current.value, record, digest, request.context.planned_final_phase));
  }
  return plannedFinalPhase.ok
    ? ok(nextStateForRecord(current.value, record, digest, plannedFinalPhase.value))
    : plannedFinalPhase;
}

async function validateCompletedReentry(
  dependencies: GateLifecycleDependencies,
  authority: TransactionAuthority,
  current: CanonicalDocument<TaskStateV1>,
  request: GateRequestV1,
  record: GateDecisionRecordV1,
): Promise<ProjectResult<void>> {
  if (
    !enactsReentry(record) ||
    current.value.revision <= request.opened_at_revision
  ) return issue("STATE_INVALID", current.value, "gate-reentry-replay-state-mismatch");
  // At the first post-closure revision the exact enacted landing state and its freshly derived
  // fingerprint are still observable and must agree. Later revisions may have advanced steps,
  // phase instances, attempts, and fingerprints; the immutable archived record plus the fact
  // that durable state moved beyond its opened revision is then the replay authority.
  if (current.value.revision > request.opened_at_revision + 1) return ok(undefined);
  if (
    current.value.phase_instance !== request.phase_instance ||
    current.value.step !== "produce" ||
    current.value.status !== "running" ||
    (request.kind === "attempts-exhausted" &&
      current.value.attempt !== (beginsHumanRevision(record)
        ? request.context.attempts
        : request.context.attempts + 1)) ||
    (beginsHumanRevision(record) &&
      (current.value.pending_human_revision?.gate_id !== record.gate_id ||
        current.value.pending_human_revision.attempt !== current.value.attempt))
  ) return issue("STATE_INVALID", current.value, "gate-reentry-replay-state-mismatch");
  if (dependencies.resolve_gate_reentry_fingerprint === undefined) {
    return issue("STATE_INVALID", current.value, "gate-reentry-fingerprint-unavailable");
  }
  const fingerprint = await dependencies.resolve_gate_reentry_fingerprint({
    authority,
    request,
    current,
    expected_input_fingerprint: current.value.input_fingerprint,
  });
  if (!fingerprint.ok) return fingerprint;
  return current.value.input_fingerprint === fingerprint.value
    ? ok(undefined)
    : issue("STATE_INVALID", current.value, "gate-reentry-replay-fingerprint-mismatch");
}

async function validateCompletedPlanningRestart(
  dependencies: GateLifecycleDependencies,
  authority: TransactionAuthority,
  current: CanonicalDocument<TaskStateV1>,
  request: GateRequestV1,
  record: GateDecisionRecordV1,
): Promise<ProjectResult<void>> {
  if (!enactsPlanningRestart(record) || current.value.revision <= request.opened_at_revision) {
    return issue("STATE_INVALID", current.value, "gate-restart-replay-state-mismatch");
  }
  const restart = current.value.restart_history?.find((entry) => entry.restart_id === record.gate_id);
  if (restart === undefined || restart.source_phase_instance !== request.phase_instance) {
    return issue("STATE_INVALID", current.value, "gate-restart-replay-state-mismatch");
  }
  if (current.value.revision > request.opened_at_revision + 1) return ok(undefined);
  if (
    current.value.phase_instance !== restart.target_phase_instance ||
    current.value.step !== "produce" ||
    current.value.status !== "running" ||
    current.value.attempt !== 1
  ) return issue("STATE_INVALID", current.value, "gate-restart-replay-state-mismatch");
  if (dependencies.resolve_gate_reentry_fingerprint === undefined) {
    return issue("STATE_INVALID", current.value, "gate-reentry-fingerprint-unavailable");
  }
  const fingerprint = await dependencies.resolve_gate_reentry_fingerprint({
    authority,
    request,
    current,
    target_phase_instance: restart.target_phase_instance,
    expected_input_fingerprint: current.value.input_fingerprint,
  });
  if (!fingerprint.ok) return fingerprint;
  return current.value.input_fingerprint === fingerprint.value
    ? ok(undefined)
    : issue("STATE_INVALID", current.value, "gate-restart-replay-fingerprint-mismatch");
}

function earnsReceipt(record: GateDecisionRecordV1): boolean {
  return record.outcome === "decided"
    ? gateDecisionEffect(record.envelope.payload) === "advance"
    : record.outcome === "waiver-decided" && record.granted;
}

function receiptOutcome(record: GateDecisionRecordV1, revision: number): PlainJsonValue {
  if (record.outcome === "decided") return {
    kind: record.kind, decision: record.envelope, notes: record.envelope.payload.reason, revision,
  } as PlainJsonValue;
  if (record.outcome === "waiver-decided") return {
    origin_gate_id: record.origin.origin_gate_id, waiver_gate_id: record.gate_id, task_id: record.task_id,
    rule_id: record.origin.rule.rule_id, rule_version: record.origin.rule.rule_version,
    subject_digest: record.origin.subject_digest, current_evidence_set_digest: record.origin.current_evidence_set_digest,
    scope: record.scope, human_provenance: record.human_provenance, granted: record.granted,
    ...(record.granted ? { expires: "task-complete" } : {}), notes: record.notes, revision,
  } as PlainJsonValue;
  throw new TypeError("non-success gate record has no receipt outcome");
}

function withGateTransition(
  authority: TransactionAuthority,
  request: GateRequestV1,
  record: GateDecisionRecordV1,
  predecessor: CanonicalDocument<TaskStateV1>,
  prepared: CanonicalDocument<TaskStateV1>,
  inputFingerprint: Sha256Digest,
): ProjectResult<CanonicalDocument<TaskStateV1>> {
  if (record.outcome === "cancelled") return ok(prepared);
  const outcome = receiptOutcome(record, prepared.value.revision);
  const transition: LastTransition = {
    schema_version: "1",
    tool: record.outcome === "waiver-decided" ? "archflow_waiver" : "archflow_gate",
    operation: parseSafeCode(record.outcome === "waiver-decided" ? "waiver" : "gate"),
    intent_id: request.intent_id,
    request_digest: request.request_digest,
    input_fingerprint: inputFingerprint,
    result_id: parseSafeId(record.gate_id),
    outcome,
    outcome_digest: intentOutcomeDigest(outcome),
    prior_revision: predecessor.value.revision,
    resulting_revision: prepared.value.revision,
  };
  const final = canonicalDocument({ ...prepared.value, last_transition: transition });
  return validateDurableSemantics({ state: final }).ok
    ? ok(final)
    : issue("STATE_INVALID", predecessor.value, "gate-transition-invalid");
}

async function installReceipt(
  dependencies: GateLifecycleDependencies,
  authority: TransactionAuthority,
  request: GateRequestV1,
  record: GateDecisionRecordV1,
  predecessor: CanonicalDocument<TaskStateV1>,
  prepared: CanonicalDocument<TaskStateV1>,
  inputFingerprint: Sha256Digest,
): Promise<ProjectResult<Readonly<{ receipt: CanonicalDocument<IntentReceiptV1>; final: CanonicalDocument<TaskStateV1> }>>> {
  await ensureIntentDirectory(authority);
  const target = await resolveTaskWorkspacePath({
    runner: dependencies.runner,
    taskId: authority.task_id,
    claim: intentReceiptClaim(request.intent_id),
    expectedClass: "workspace-intent",
    context: authority.context,
  });
  if (!target.ok) return target;
  const outcome = receiptOutcome(record, prepared.value.revision);
  const receipt = canonicalDocument(parseIntentReceipt({
    schema_version: "1", intent_id: request.intent_id, task_id: request.task_id,
    repository_identity_digest: authority.repository_identity_digest,
    tool: record.outcome === "waiver-decided" ? "archflow_waiver" : "archflow_gate",
    operation: parseSafeCode(record.outcome === "waiver-decided" ? "waiver" : "gate"),
    request_digest: request.request_digest, input_fingerprint: inputFingerprint,
    prior_revision: parseSafeInteger(prepared.value.revision - 1), resulting_revision: prepared.value.revision,
    result_id: parseSafeId(record.gate_id), outcome_digest: intentOutcomeDigest(outcome), outcome,
    prepared_state_digest: prepared.digest, prepared_state: prepared.value,
  }));
  if (!validateDurableSemantics(createPreparedIntentSubject(predecessor, receipt)).ok) {
    return issue("STATE_INVALID", predecessor.value, "gate-receipt-prepared-invalid");
  }
  const created = await dependencies.atomic.createExclusive(target.value, receipt.bytes);
  if (created === "exists") {
    const existing = await dependencies.read_receipt(target.value);
    if (existing.kind !== "canonical" || existing.document.digest !== receipt.digest) {
      return issue("STATE_INVALID", prepared.value, "gate-receipt-collision");
    }
  }
  const reference: LastTransition = {
    schema_version: "1",
    tool: receipt.value.tool,
    operation: receipt.value.operation,
    intent_id: request.intent_id,
    request_digest: request.request_digest,
    input_fingerprint: receipt.value.input_fingerprint,
    result_id: receipt.value.result_id,
    outcome: receipt.value.outcome,
    outcome_digest: receipt.value.outcome_digest,
    prior_revision: receipt.value.prior_revision,
    resulting_revision: receipt.value.resulting_revision,
  };
  const final = canonicalDocument({ ...prepared.value, last_transition: reference });
  if (!validateDurableSemantics(createCommittedIntentSubject(final, receipt)).ok) {
    return issue("STATE_INVALID", predecessor.value, "gate-receipt-committed-invalid");
  }
  return ok({ receipt, final });
}

function directSemanticDecisionIntent(
  operationDigest: Sha256Digest,
  substep: "decision-archive" | "decision-settle" | "revise-enter",
): PathSafeId {
  return parsePathSafeId(`afop-${operationDigest}-${substep}`);
}

function directSemanticDecisionRequestDigest(
  operationDigest: Sha256Digest,
  request: CanonicalDocument<GateRequestV1>,
  decision: CanonicalDocument<GateDecisionRecordV1>,
): Sha256Digest {
  return canonicalJsonDigest({
    schema_version: "1",
    digest_kind: "direct-semantic-decision-settlement",
    operation_digest: operationDigest,
    gate_request_digest: request.digest,
    gate_decision_digest: decision.digest,
  });
}

function legacyLocalDecisionSettlementOperationDigest(
  request: CanonicalDocument<GateRequestV1>,
  decision: CanonicalDocument<GateDecisionRecordV1>,
): Sha256Digest {
  return canonicalJsonDigest({
    schema_version: "1",
    digest_kind: "legacy-local-decision-settlement",
    gate_request_digest: request.digest,
    gate_decision_digest: decision.digest,
  });
}

function directSemanticRevisionEntryRequestDigest(
  operationDigest: Sha256Digest,
  checkpointRequestDigest: Sha256Digest,
  request: CanonicalDocument<GateRequestV1>,
  record: CanonicalDocument<GateDecisionRecordV1>,
  inputFingerprint: Sha256Digest,
): Sha256Digest {
  return canonicalJsonDigest({
    schema_version: "1",
    digest_kind: "direct-semantic-revision-entry",
    operation_digest: operationDigest,
    checkpoint_request_digest: checkpointRequestDigest,
    gate_request_digest: request.digest,
    gate_decision_digest: record.digest,
    input_fingerprint: inputFingerprint,
  });
}

function equivalentDirectDecision(
  existing: GateDecisionRecordV1,
  candidate: GateDecisionRecordV1,
  operationDigest: Sha256Digest,
): boolean {
  const existingProvenance = existing.outcome === "decided"
    ? existing.envelope.human_provenance
    : existing.human_provenance;
  const candidateProvenance = candidate.outcome === "decided"
    ? candidate.envelope.human_provenance
    : candidate.human_provenance;
  const { human_provenance: _existing, ...existingBody } = existing.outcome === "decided"
    ? existing.envelope
    : existing;
  const { human_provenance: _candidate, ...candidateBody } = candidate.outcome === "decided"
    ? candidate.envelope
    : candidate;
  return existingProvenance.channel === "connected-host" &&
    existingProvenance.decision_event_id === `afdecision-${operationDigest}` &&
    candidateProvenance.channel === "connected-host" &&
    candidateProvenance.decision_event_id === existingProvenance.decision_event_id &&
    isDeepStrictEqual(existingBody, candidateBody);
}

/**
 * Creates the immutable server-owned decision archive for one authenticated semantic operation.
 * The disposable gate.decision projection is deliberately not consulted or written.
 */
export async function archiveDirectSemanticGateDecision(
  dependencies: GateLifecycleDependencies,
  input: DirectSemanticDecisionInput,
): Promise<ProjectResult<DirectSemanticDecisionArchiveResult>> {
  assertInternalTransactionAuthority(input.authority, { runner: dependencies.runner, environment: dependencies.environment });
  assertAuthenticInvocationContext(input.invocation_context);
  if (input.intent_id !== directSemanticDecisionIntent(input.operation_digest, "decision-archive")) {
    throw new TypeError("direct decision archive intent does not bind the semantic operation");
  }
  try {
    return await dependencies.lock.runExclusive(input.authority.workspace_root, async () => {
      const stateResult = await stateOrFailure(dependencies, input.authority);
      if (!stateResult.ok) return stateResult;
      const current = stateResult.value;
      const live = await validateLiveGateState(dependencies, input.authority, current, current.value.input_fingerprint);
      if (!live.ok) return live;
      const open = current.value.open_gate;
      if (open === undefined) return issue("STATE_INVALID", current.value, "direct-decision-open-gate-missing");
      const requestPath = await resolvePath(dependencies, input.authority, gateRequestClaim(open.gate_id), "authority-decision");
      const archivePath = await resolvePath(dependencies, input.authority, gateDecisionClaim(open.gate_id), "authority-decision");
      if (!requestPath.ok) return requestPath;
      if (!archivePath.ok) return archivePath;
      const request = await readCanonical(requestPath.value, "gate request", parsePersistedGateRequest);
      if (request === "missing" || request === "invalid" || !exactOpenGateMatches(current.value, request.value)) {
        return issue("STATE_INVALID", current.value, "direct-decision-request-invalid");
      }
      let selected: PlainJsonValue;
      try {
        const active = activeProjection(request.value);
        if (!buildHumanGatePresentation(active).options.some((option) => option.token === input.choice)) {
          throw new TypeError("semantic decisions require a server-issued choice token");
        }
        selected = selectGateDecisionTemplate(active, {
          choice: input.choice,
          reason: input.reason,
          ...(input.option_rationale === undefined ? {} : { rationale: input.option_rationale }),
        });
      } catch {
        return fail(createProjectError("GATE_DECISION_INVALID", {
          gate_id: open.gate_id,
          gate_kind: open.gate_kind,
          issue_code: "decision-choice-invalid",
        }));
      }
      // A restore that can never apply must be refused before the decision is archived: the
      // decided interface is immutable, so recording it would wedge the gate behind an
      // unapplicable decision. Adoption-sourced drift has no retained manifest to restore from.
      const selectedDecision = (selected as Readonly<{ payload?: Readonly<{ decision?: PlainJsonValue }> }>).payload?.decision;
      if (request.value.kind === "baseline-adoption" &&
          selectedDecision === "restore-recorded-bytes" &&
          !(await baselineRestoreOffered(dependencies, input.authority, current, request.value.context, live.value.repository_set))) {
        return issue("STATE_INVALID", current.value, "baseline-adoption-restore-source-unavailable");
      }
      const provenance: HumanDecisionProvenance = {
        schema_version: "1",
        actor_class: "human",
        assurance: "declared-local-trace",
        channel: "connected-host",
        decision_event_id: parseSafeId(`afdecision-${input.operation_digest}`),
        connection_id: input.invocation_context.connection.connection_id,
        request_id_digest: canonicalJsonDigest({
          schema_version: "1",
          request_id: input.invocation_context.transport_metadata.request_id,
        }),
        recorded_at: new Date().toISOString(),
      };
      const selectedRecord = selected as Record<string, PlainJsonValue>;
      let candidate: CanonicalDocument<GateDecisionRecordV1>;
      try {
        candidate = canonicalDocument(parseInterface({ ...selectedRecord, human_provenance: provenance }, request.value));
      } catch {
        return fail(createProjectError("GATE_DECISION_INVALID", {
          gate_id: open.gate_id,
          gate_kind: open.gate_kind,
          issue_code: "decision-binding-invalid",
        }));
      }
      if (!validateDurableSemantics({ gate_request: request, gate_decision: candidate }).ok) {
        return issue("STATE_INVALID", current.value, "direct-decision-archive-binding-invalid");
      }
      const existing = await readCanonical(archivePath.value, "gate decision record", parseGateDecisionRecord);
      if (existing === "invalid") return issue("STATE_INVALID", current.value, "direct-decision-archive-invalid");
      if (existing !== "missing") {
        if (!validateDurableSemantics({ gate_request: request, gate_decision: existing }).ok ||
            !equivalentDirectDecision(existing.value, candidate.value, input.operation_digest)) {
          return issue("STATE_INVALID", current.value, "direct-decision-archive-conflict");
        }
        return ok({ state: current, request, record: existing, replayed: true });
      }
      if (await dependencies.atomic.createExclusive(archivePath.value, candidate.bytes) !== "created") {
        const raced = await readCanonical(archivePath.value, "gate decision record", parseGateDecisionRecord);
        if (raced === "missing" || raced === "invalid" ||
            !equivalentDirectDecision(raced.value, candidate.value, input.operation_digest)) {
          return issue("STATE_INVALID", current.value, "direct-decision-archive-conflict");
        }
        return ok({ state: current, request, record: raced, replayed: true });
      }
      return ok({ state: current, request, record: candidate, replayed: false });
    });
  } catch (error) {
    return error instanceof TaskLockError ? io(input.authority, `direct-decision-lock-${error.stage}`) : io(input.authority, "direct-decision-archive");
  }
}

async function settleDirectReentryCheckpoint(
  dependencies: GateLifecycleDependencies,
  input: DirectSemanticDecisionSettlementInput,
): Promise<ProjectResult<GateResolution>> {
  try {
    return await dependencies.lock.runExclusive(input.authority.workspace_root, async () => {
      const stateResult = await stateOrFailure(dependencies, input.authority);
      if (!stateResult.ok) return stateResult;
      const current = stateResult.value;
      const live = await validateLiveGateState(
        dependencies,
        input.authority,
        current,
        current.value.input_fingerprint,
      );
      if (!live.ok) return live;
      const open = current.value.open_gate;
      if (open === undefined) return issue("STATE_INVALID", current.value, "direct-decision-open-gate-missing");
      const requestPath = await resolvePath(dependencies, input.authority, gateRequestClaim(open.gate_id), "authority-decision");
      const archivePath = await resolvePath(dependencies, input.authority, gateDecisionClaim(open.gate_id), "authority-decision");
      if (!requestPath.ok) return requestPath;
      if (!archivePath.ok) return archivePath;
      const request = await readCanonical(requestPath.value, "gate request", parsePersistedGateRequest);
      const record = await readCanonical(archivePath.value, "gate decision record", parseGateDecisionRecord);
      if (request === "missing" || request === "invalid" || record === "missing" || record === "invalid" ||
          !validateDurableSemantics({ gate_request: request, gate_decision: record }).ok ||
          !exactOpenGateMatches(current.value, request.value) || !enactsReentry(record.value)) {
        return issue("STATE_INVALID", current.value, "direct-decision-reentry-authority-invalid");
      }
      const provenance = record.value.outcome === "decided" ? record.value.envelope.human_provenance : record.value.human_provenance;
      const operationMatches = provenance.channel === "connected-host"
        ? provenance.decision_event_id === `afdecision-${input.operation_digest}`
        : input.operation_digest === legacyLocalDecisionSettlementOperationDigest(request, record);
      if (!operationMatches) {
        return issue("STATE_INVALID", current.value, "direct-decision-operation-mismatch");
      }
      const revision = parseSafeInteger(current.value.revision + 1);
      const outcome = receiptOutcome(record.value, revision);
      const requestDigest = directSemanticDecisionRequestDigest(input.operation_digest, request, record);
      const { open_gate: _open, last_transition: _transition, ...base } = current.value;
      const checkpointBase = withLastSeenConfig(
        { ...base, revision } as TaskStateV1,
        live.value.config,
        live.value.repository_set,
      );
      const checkpoint = canonicalDocument({
        ...checkpointBase,
        revision,
        last_transition: {
          schema_version: "1",
          tool: "archflow_gate",
          operation: parseSafeCode("semantic-revision-requested"),
          intent_id: input.intent_id,
          request_digest: requestDigest,
          input_fingerprint: current.value.input_fingerprint,
          result_id: parseSafeId(record.value.gate_id),
          outcome,
          outcome_digest: intentOutcomeDigest(outcome),
          prior_revision: current.value.revision,
          resulting_revision: revision,
        },
      } as TaskStateV1);
      if (!validateDurableSemantics({ state: checkpoint }).ok) {
        return issue("STATE_INVALID", current.value, "direct-decision-checkpoint-invalid");
      }
      await dependencies.atomic.replace(input.authority.state, checkpoint.bytes);
      await cleanupCommittedGateWorkspace(dependencies, input.authority, checkpoint.value);
      return ok({ state: checkpoint, record, effect: "retry", replayed: false });
    });
  } catch (error) {
    return error instanceof TaskLockError ? io(input.authority, `direct-decision-settle-lock-${error.stage}`) : io(input.authority, "direct-decision-settle");
  }
}

/** Settles an already archived semantic decision; no human submission is accepted here. */
export async function settleDirectSemanticGateDecision(
  dependencies: GateLifecycleDependencies,
  input: DirectSemanticDecisionSettlementInput,
): Promise<ProjectResult<GateResolution>> {
  assertInternalTransactionAuthority(input.authority, { runner: dependencies.runner, environment: dependencies.environment });
  if (input.intent_id !== directSemanticDecisionIntent(input.operation_digest, "decision-settle")) {
    throw new TypeError("direct decision settlement intent does not bind the semantic operation");
  }
  const currentResult = await stateOrFailure(dependencies, input.authority);
  if (!currentResult.ok) return currentResult;
  const open = currentResult.value.value.open_gate;
  if (open === undefined) {
    const transition = currentResult.value.value.last_transition;
    if (transition === undefined || transition.tool !== "archflow_gate" ||
        transition.operation !== "semantic-revision-requested" || transition.intent_id !== input.intent_id ||
        transition.resulting_revision !== currentResult.value.value.revision) {
      return issue("STATE_INVALID", currentResult.value.value, "direct-decision-open-gate-missing");
    }
    let gateId: PathSafeId;
    try { gateId = parsePathSafeId(transition.result_id); }
    catch { return issue("STATE_INVALID", currentResult.value.value, "direct-decision-checkpoint-invalid"); }
    const requestPath = await resolvePath(dependencies, input.authority, gateRequestClaim(gateId), "authority-decision");
    const archivePath = await resolvePath(dependencies, input.authority, gateDecisionClaim(gateId), "authority-decision");
    if (!requestPath.ok) return requestPath;
    if (!archivePath.ok) return archivePath;
    const request = await readCanonical(requestPath.value, "gate request", parsePersistedGateRequest);
    const record = await readCanonical(archivePath.value, "gate decision record", parseGateDecisionRecord);
    if (request === "missing" || request === "invalid" || record === "missing" || record === "invalid" ||
        !enactsReentry(record.value) || !validateDurableSemantics({ gate_request: request, gate_decision: record }).ok ||
        transition.request_digest !== directSemanticDecisionRequestDigest(input.operation_digest, request, record) ||
        transition.outcome_digest !== intentOutcomeDigest(transition.outcome)) {
      return issue("STATE_INVALID", currentResult.value.value, "direct-decision-checkpoint-invalid");
    }
    return ok({ state: currentResult.value, record, effect: "retry", replayed: true });
  }
  const archivePath = await resolvePath(dependencies, input.authority, gateDecisionClaim(open.gate_id), "authority-decision");
  if (!archivePath.ok) return archivePath;
  const record = await readCanonical(archivePath.value, "gate decision record", parseGateDecisionRecord);
  if (record === "missing" || record === "invalid") return issue("STATE_INVALID", currentResult.value.value, "direct-decision-archive-invalid");
  const provenance = record.value.outcome === "decided" ? record.value.envelope.human_provenance
    : record.value.human_provenance;
  if (provenance?.channel === "connected-host" && provenance.decision_event_id !== `afdecision-${input.operation_digest}`) {
    return issue("STATE_INVALID", currentResult.value.value, "direct-decision-operation-mismatch");
  }
  if (enactsReentry(record.value)) return settleDirectReentryCheckpoint(dependencies, input);
  return earnsReceipt(record.value)
    ? resolveAdvancingGate(dependencies, input.authority, open.gate_id, currentResult.value.value.input_fingerprint)
    : resolveDurableGate(dependencies, input.authority, open.gate_id, currentResult.value.value.input_fingerprint);
}

/** Enters production from an authenticated close-only semantic revision checkpoint. */
export async function enterDirectSemanticRevisionCheckpoint(
  dependencies: GateLifecycleDependencies,
  input: DirectSemanticDecisionSettlementInput,
): Promise<ProjectResult<CanonicalDocument<TaskStateV1>>> {
  assertInternalTransactionAuthority(input.authority, { runner: dependencies.runner, environment: dependencies.environment });
  if (input.intent_id !== directSemanticDecisionIntent(input.operation_digest, "revise-enter")) {
    throw new TypeError("direct revision entry intent does not bind the semantic operation");
  }
  try {
    return await dependencies.lock.runExclusive(input.authority.workspace_root, async () => {
      const stateResult = await stateOrFailure(dependencies, input.authority);
      if (!stateResult.ok) return stateResult;
      const current = stateResult.value;
      const live = await validateLiveGateState(
        dependencies,
        input.authority,
        current,
        current.value.input_fingerprint,
      );
      if (!live.ok) return live;
      const transition = current.value.last_transition;
      if (current.value.open_gate === undefined && current.value.step === "produce" && current.value.status === "running" &&
          transition !== undefined &&
          transition.tool === "archflow_gate" && transition.operation === "semantic-revision-enter" &&
          transition.intent_id === input.intent_id && transition.resulting_revision === current.value.revision &&
          transition.input_fingerprint === current.value.input_fingerprint &&
          transition.outcome_digest === intentOutcomeDigest(transition.outcome)) {
        let replayGateId: PathSafeId;
        try { replayGateId = parsePathSafeId(transition.result_id); }
        catch { return issue("STATE_INVALID", current.value, "direct-revision-entry-replay-invalid"); }
        const replayRequestPath = await resolvePath(dependencies, input.authority, gateRequestClaim(replayGateId), "authority-decision");
        const replayArchivePath = await resolvePath(dependencies, input.authority, gateDecisionClaim(replayGateId), "authority-decision");
        if (!replayRequestPath.ok) return replayRequestPath;
        if (!replayArchivePath.ok) return replayArchivePath;
        const replayRequest = await readCanonical(replayRequestPath.value, "gate request", parsePersistedGateRequest);
        const replayRecord = await readCanonical(replayArchivePath.value, "gate decision record", parseGateDecisionRecord);
        const checkpointRequestDigest = transition.outcome !== null && !Array.isArray(transition.outcome) &&
          typeof transition.outcome === "object"
          ? Object.getOwnPropertyDescriptor(transition.outcome, "checkpoint_request_digest")
          : undefined;
        const predecessorAttempt = transition.outcome !== null && !Array.isArray(transition.outcome) &&
          typeof transition.outcome === "object"
          ? Object.getOwnPropertyDescriptor(transition.outcome, "predecessor_attempt")
          : undefined;
        const checkpointDigestValue = checkpointRequestDigest?.enumerable === true && "value" in checkpointRequestDigest
          ? checkpointRequestDigest.value
          : undefined;
        const predecessorAttemptValue = predecessorAttempt?.enumerable === true && "value" in predecessorAttempt
          ? predecessorAttempt.value
          : undefined;
        if (replayRequest === "missing" || replayRequest === "invalid" || replayRecord === "missing" || replayRecord === "invalid" ||
            typeof checkpointDigestValue !== "string" || !/^[0-9a-f]{64}$/u.test(checkpointDigestValue) || !enactsReentry(replayRecord.value) ||
            !Number.isSafeInteger(predecessorAttemptValue) || Number(predecessorAttemptValue) < 1 ||
            predecessorAttemptValue !== (beginsHumanRevision(replayRecord.value)
              ? current.value.attempt
              : current.value.attempt - 1) ||
            !validateDurableSemantics({ state: current, gate_request: replayRequest, gate_decision: replayRecord }).ok ||
            transition.request_digest !== directSemanticRevisionEntryRequestDigest(
              input.operation_digest, checkpointDigestValue as Sha256Digest, replayRequest, replayRecord,
              current.value.input_fingerprint,
            )) {
          return issue("STATE_INVALID", current.value, "direct-revision-entry-replay-invalid");
        }
        return ok(current);
      }
      if (current.value.open_gate !== undefined || transition === undefined ||
          transition.tool !== "archflow_gate" || transition.operation !== "semantic-revision-requested" ||
          transition.resulting_revision !== current.value.revision || transition.input_fingerprint !== current.value.input_fingerprint ||
          transition.outcome_digest !== intentOutcomeDigest(transition.outcome)) {
        return issue("STATE_INVALID", current.value, "direct-revision-checkpoint-invalid");
      }
      let gateId: PathSafeId;
      try { gateId = parsePathSafeId(transition.result_id); }
      catch { return issue("STATE_INVALID", current.value, "direct-revision-checkpoint-invalid"); }
      const requestPath = await resolvePath(dependencies, input.authority, gateRequestClaim(gateId), "authority-decision");
      const archivePath = await resolvePath(dependencies, input.authority, gateDecisionClaim(gateId), "authority-decision");
      if (!requestPath.ok) return requestPath;
      if (!archivePath.ok) return archivePath;
      const request = await readCanonical(requestPath.value, "gate request", parsePersistedGateRequest);
      const record = await readCanonical(archivePath.value, "gate decision record", parseGateDecisionRecord);
      if (request === "missing" || request === "invalid" || record === "missing" || record === "invalid" ||
          !enactsReentry(record.value) || !validateDurableSemantics({ gate_request: request, gate_decision: record }).ok ||
          request.value.task_id !== current.value.task_id || request.value.phase_instance !== current.value.phase_instance ||
          request.value.opened_at_revision + 1 !== current.value.revision) {
        return issue("STATE_INVALID", current.value, "direct-revision-archive-invalid");
      }
      const checkpointIdentity = /^afop-([0-9a-f]{64})-decision-settle$/u.exec(transition.intent_id);
      if (checkpointIdentity === null || transition.request_digest !== directSemanticDecisionRequestDigest(
        checkpointIdentity[1] as Sha256Digest, request, record,
      )) return issue("STATE_INVALID", current.value, "direct-revision-operation-invalid");
      const provenance = record.value.outcome === "decided" ? record.value.envelope.human_provenance : record.value.human_provenance;
      if (provenance.channel === "connected-host" && provenance.decision_event_id !== `afdecision-${checkpointIdentity[1]}`) {
        return issue("STATE_INVALID", current.value, "direct-revision-operation-invalid");
      }
      if (dependencies.resolve_gate_reentry_fingerprint === undefined) {
        return issue("STATE_INVALID", current.value, "gate-reentry-fingerprint-unavailable");
      }
      const fingerprint = await dependencies.resolve_gate_reentry_fingerprint({ authority: input.authority, request: request.value, current });
      if (!fingerprint.ok) return fingerprint;
      const { last_transition: _last, ...predecessor } = current.value;
      const planned = planStateTransition({
        current: predecessor as TaskStateV1,
        target: {
          phase_instance: current.value.phase_instance,
          step: "produce",
          status: "running",
          attempt: beginsHumanRevision(record.value) ? current.value.attempt : parseSafeInteger(current.value.attempt + 1),
          input_fingerprint: fingerprint.value,
        },
        recomputed_input_fingerprint: fingerprint.value,
        human_revision_reentry: beginsHumanRevision(record.value),
      });
      if (!planned.ok) return planned;
      const revision = parseSafeInteger(current.value.revision + 1);
      const evidence = current.value.authoritative_results.filter((entry) =>
        entry.phase_instance === current.value.phase_instance &&
        (entry.step === "counter_review" || entry.step === "adjudicate" || entry.step === "triage"));
      const entryOutcome = {
        ok: true,
        checkpoint_request_digest: transition.request_digest,
        predecessor_attempt: current.value.attempt,
      } as const;
      const enteredBase = withLastSeenConfig(
        { ...planned.value, revision } as TaskStateV1,
        live.value.config,
        live.value.repository_set,
      );
      const entered = canonicalDocument({
        ...enteredBase,
        revision,
        ...(beginsHumanRevision(record.value) ? {
          pending_human_revision: {
            gate_id: record.value.gate_id,
            gate_kind: record.value.kind,
            predecessor_subject_digest: record.value.subject_digest,
            predecessor_input_fingerprint: current.value.input_fingerprint,
            requested_at_revision: revision,
            attempt: current.value.attempt,
            evidence,
          },
        } : {}),
        last_transition: {
          schema_version: "1",
          tool: "archflow_gate",
          operation: parseSafeCode("semantic-revision-enter"),
          intent_id: input.intent_id,
          request_digest: directSemanticRevisionEntryRequestDigest(
            input.operation_digest, transition.request_digest, request, record, fingerprint.value,
          ),
          input_fingerprint: fingerprint.value,
          result_id: parseSafeId(gateId),
          outcome: entryOutcome,
          outcome_digest: intentOutcomeDigest(entryOutcome),
          prior_revision: current.value.revision,
          resulting_revision: revision,
        },
      } as TaskStateV1);
      if (!validateDurableSemantics({ state: entered }).ok) return issue("STATE_INVALID", current.value, "direct-revision-entry-invalid");
      await dependencies.atomic.replace(input.authority.state, entered.bytes);
      return ok(entered);
    });
  } catch (error) {
    return error instanceof TaskLockError ? io(input.authority, `direct-revision-lock-${error.stage}`) : io(input.authority, "direct-revision-entry");
  }
}

export async function resolveDurableGate(
  dependencies: GateLifecycleDependencies,
  authority: TransactionAuthority,
  gateId: PathSafeId,
  inputFingerprint?: Sha256Digest,
): Promise<ProjectResult<GateResolution>> {
  assertInternalTransactionAuthority(authority, { runner: dependencies.runner, environment: dependencies.environment });
  try {
    await ensureIntentDirectory(authority);
    return await dependencies.lock.runExclusive(authority.workspace_root, async () => {
      const stateResult = await stateOrFailure(dependencies, authority);
      if (!stateResult.ok) return stateResult;
      const current = stateResult.value;
      const live = await validateLiveGateState(dependencies, authority, current, inputFingerprint ?? current.value.input_fingerprint);
      if (!live.ok) return live;
      const requestPath = await resolvePath(dependencies, authority, gateRequestClaim(gateId), "authority-decision");
      const archivePath = await resolvePath(dependencies, authority, gateDecisionClaim(gateId), "authority-decision");
      if (!requestPath.ok) return requestPath;
      if (!archivePath.ok) return archivePath;
      const request = await readCanonical(requestPath.value, "gate request", parsePersistedGateRequest);
      if (request === "missing" || request === "invalid") return issue("STATE_INVALID", current.value, "gate-request-invalid");
      const archived = await readCanonical(archivePath.value, "gate decision record", parseGateDecisionRecord);
      if (archived !== "missing") {
        if (archived === "invalid") return issue("STATE_INVALID", current.value, "gate-decision-record-invalid");
        if (!validateDurableSemantics({ gate_request: request, gate_decision: archived }).ok) return issue("STATE_INVALID", current.value, "gate-archive-binding-invalid");
        const effect = archived.value.outcome === "decided" ? gateDecisionEffect(archived.value.envelope.payload) : "non-advancing";
        if (current.value.open_gate?.gate_id !== gateId) {
          if (enactsReentry(archived.value)) {
            const replay = await validateCompletedReentry(
              dependencies, authority, current, request.value, archived.value,
            );
            if (!replay.ok) return replay;
          }
          if (
            archived.value.outcome === "decided" && archived.value.kind === "material-drift" &&
            archived.value.envelope.payload.decision === "amend-upstream" &&
            !completedMaterialDriftRestartMatches(current.value, request.value, archived.value)
          ) return issue("STATE_INVALID", current.value, "material-drift-restart-replay-mismatch");
          return ok({ state: current, record: archived, effect, replayed: true });
        }
        const closure = await closedStateForRecord(
          dependencies, authority, current, request.value, archived.value, archived.digest, live.value.repository_set,
        );
        if (!closure.ok) return closure;
        const prepared = canonicalDocument(withLastSeenConfig(
          closure.value.value,
          live.value.config,
          live.value.repository_set,
        ));
        // A closure-before-receipt crash resumes through the same ordering. The archived request
        // carries no fingerprint field, so only non-success closures can be resumed here; success
        // receipt recovery is driven by the direct semantic settlement, which supplies the
        // authenticated fingerprint.
        if (earnsReceipt(archived.value)) return issue("STATE_INVALID", current.value, "gate-success-receipt-resume-required");
        const transitioned = withGateTransition(
          authority, request.value, archived.value, current, prepared,
          inputFingerprint ?? current.value.input_fingerprint,
        );
        if (!transitioned.ok) return transitioned;
        const final = transitioned.value;
        await dependencies.atomic.replace(authority.state, final.bytes);
        const gateJson = await resolvePath(dependencies, authority, "gate.json", "workspace-gate-interface");
        if (gateJson.ok) await dependencies.atomic.removeGateInterface(gateJson.value);
        const decisionInterface = await resolvePath(dependencies, authority, "gate.decision", "workspace-gate-interface");
        if (decisionInterface.ok) {
          const projected = await readCanonical(decisionInterface.value, "gate decision interface", (value) => value as PlainJsonValue);
          if (projected !== "missing" && projected !== "invalid") {
            try {
              const bound = parseInterface(projected.value, request.value);
              if (canonicalJsonDigest(bound) === archived.digest) await dependencies.atomic.removeGateInterface(decisionInterface.value);
            } catch { /* leave an unbound interface untouched */ }
          }
        }
        await cleanupCommittedGateWorkspace(dependencies, authority, final.value);
        if (archived.value.outcome === "cancelled") return fail(createProjectError("GATE_CANCELLED", { gate_id: gateId, gate_kind: archived.value.kind }));
        return ok({ state: final, record: archived, effect, replayed: true });
      }
      if (current.value.open_gate?.gate_id !== gateId) return fail(createProjectError("GATE_ACTIVE", { gate_id: current.value.open_gate?.gate_id ?? gateId, gate_kind: current.value.open_gate?.gate_kind ?? request.value.kind }));
      const interfacePath = await resolvePath(dependencies, authority, "gate.decision", "workspace-gate-interface");
      if (!interfacePath.ok) return interfacePath;
      const raw = await readCanonical(interfacePath.value, "gate decision interface", (value) => value as PlainJsonValue);
      if (raw === "missing" || raw === "invalid") return fail(createProjectError("GATE_DECISION_INVALID", { gate_id: gateId, gate_kind: request.value.kind, issue_code: raw === "missing" ? "decision-missing" : "decision-noncanonical" }));
      let record: GateDecisionRecordV1;
      try { record = parseInterface(raw.value, request.value); }
      catch { return fail(createProjectError("GATE_DECISION_INVALID", { gate_id: gateId, gate_kind: request.value.kind, issue_code: "decision-binding-invalid" })); }
      const document = canonicalDocument(record);
      if (!validateDurableSemantics({ gate_request: request, gate_decision: document }).ok) return issue("STATE_INVALID", current.value, "gate-archive-binding-invalid");
      const closure = await closedStateForRecord(
        dependencies, authority, current, request.value, record, document.digest, live.value.repository_set,
      );
      if (!closure.ok) return closure;
      const created = await dependencies.atomic.createExclusive(archivePath.value, document.bytes);
      if (created !== "created") return issue("STATE_INVALID", current.value, "gate-resolution-race");
      const effect = record.outcome === "decided" ? gateDecisionEffect(record.envelope.payload) : "non-advancing";
      const prepared = canonicalDocument(withLastSeenConfig(
        closure.value.value,
        live.value.config,
        live.value.repository_set,
      ));
      const transitioned = withGateTransition(
        authority, request.value, document.value, current, prepared,
        inputFingerprint ?? current.value.input_fingerprint,
      );
      if (!transitioned.ok) return transitioned;
      const final = transitioned.value;
      if (earnsReceipt(record)) return issue("STATE_INVALID", current.value, "gate-success-requires-run-service");
      await dependencies.atomic.replace(authority.state, final.bytes);
      const gateJson = await resolvePath(dependencies, authority, "gate.json", "workspace-gate-interface");
      if (gateJson.ok) await dependencies.atomic.removeGateInterface(gateJson.value);
      await dependencies.atomic.removeGateInterface(interfacePath.value);
      await cleanupCommittedGateWorkspace(dependencies, authority, final.value);
      if (record.outcome === "cancelled") return fail(createProjectError("GATE_CANCELLED", { gate_id: gateId, gate_kind: record.kind }));
      return ok({ state: final, record: document, effect, replayed: false });
    });
  } catch (error) {
    return error instanceof TaskLockError ? io(authority, `gate-lock-${error.stage}`) : io(authority, "gate-resolve");
  }
}

export type BaselineDriftedProjection = Extract<GateRequestV1, { kind: "baseline-adoption" }>["context"]["drifted_projections"][number];
export type BaselineDeletedProjection = NonNullable<Extract<GateRequestV1, { kind: "baseline-adoption" }>["context"]["deleted_projections"]>[number];
type BaselineContext = Extract<GateRequestV1, { kind: "baseline-adoption" }>["context"];
type BaselineRepositoryName = "primary" | RepositoryName;
type BaselineRepositoryTarget = Readonly<{
  repository: BaselineRepositoryName;
  drifted_projections: readonly BaselineDriftedProjection[];
  deleted_projections: readonly BaselineDeletedProjection[];
}>;

function baselineRepositoryTargets(context: BaselineContext): readonly BaselineRepositoryTarget[] {
  return Object.freeze([
    Object.freeze({
      repository: "primary" as const,
      drifted_projections: context.drifted_projections,
      deleted_projections: context.deleted_projections ?? [],
    }),
    ...(context.secondary_targets ?? []).map((target) => Object.freeze({
      repository: target.repository,
      drifted_projections: target.drifted_projections,
      deleted_projections: target.deleted_projections ?? [],
    })),
  ]);
}

function projectionLookup(repository: BaselineRepositoryName, path: BaselineDriftedProjection["path"]): string {
  return repositoryPathKey(repository, path);
}

/** Re-reads the target so a retained/cached before-image can never stand in for human-observed live bytes. */
export async function assessBaselineRestoreSourceFreshness(
  source: ProjectionSource,
  humanObservedDigest: Sha256Digest,
): Promise<Readonly<{ classification: "observed" | "restored" | "stale"; source: ProjectionSource }>> {
  const measuredLive = await captureProjectionTarget(source.target);
  const liveDigest = measuredLive.observation.state === "present"
    ? measuredLive.observation.content_digest
    : undefined;
  const desiredDigest = source.desired.state === "present" ? sha256Bytes(source.desired.bytes) : undefined;
  const refreshed = Object.freeze({
    ...source,
    authenticated_before: measuredLive.observation,
    rollback: measuredLive.rollback,
  });
  return Object.freeze({
    classification: liveDigest === humanObservedDigest ? "observed" : liveDigest === desiredDigest ? "restored" : "stale",
    source: refreshed,
  });
}

/**
 * Builds one durable adoption record from the gate's drifted set. The projection sort is plain
 * code-unit ordering — the comparator the durable-state schema's sorted-unique refinement uses —
 * and deliberately NOT `localeCompare`, which orders mixed-case path sets differently and once
 * produced a record the receipt parser rejected after the decision was already archived.
 */
export function baselineAdoptionRecord(
  gateId: GateDecisionRecordV1["gate_id"],
  adoptedAtRevision: TaskStateV1["revision"],
  driftedProjections: readonly BaselineDriftedProjection[],
  deletedProjections: readonly BaselineDeletedProjection[] = [],
  secondaryTargets: readonly NonNullable<BaselineContext["secondary_targets"]>[number][] = [],
): BaselineAdoptionRecord {
  const ordinal = (left: string, right: string): number => left < right ? -1 : left > right ? 1 : 0;
  const adoptedProjections: BaselineAdoptionRecord["adopted_projections"][number][] = [
    ...driftedProjections.map((drifted) => Object.freeze({ path: drifted.path, content_digest: drifted.observed_digest })),
    ...secondaryTargets.flatMap((target) => target.drifted_projections.map((drifted) => Object.freeze({
      repository: target.repository, path: drifted.path, content_digest: drifted.observed_digest,
    }))),
  ];
  return Object.freeze({
    gate_id: gateId,
    adopted_at_revision: adoptedAtRevision,
    adopted_projections: Object.freeze(adoptedProjections.sort((left, right) =>
      ordinal(left.repository ?? "", right.repository ?? "") || ordinal(left.path, right.path))),
    // Absence is recorded only when the decision adopted deletions; a bytes-only archive from
    // before that decision exists must keep its exact historical shape.
    ...(deletedProjections.length === 0 && secondaryTargets.every((target) => (target.deleted_projections ?? []).length === 0) ? {} : {
      adopted_absences: Object.freeze([
        ...deletedProjections.map((deleted) => deleted.path),
        ...secondaryTargets.flatMap((target) => (target.deleted_projections ?? []).map((deleted) => Object.freeze({
          repository: target.repository, path: deleted.path,
        }))),
      ].sort((left, right) => {
        const leftRepository = typeof left === "string" ? "" : left.repository ?? "";
        const rightRepository = typeof right === "string" ? "" : right.repository ?? "";
        const leftPath = typeof left === "string" ? left : left.path;
        const rightPath = typeof right === "string" ? right : right.path;
        return ordinal(leftRepository, rightRepository) || ordinal(leftPath, rightPath);
      })),
    }),
  });
}

/**
 * Groups the drifted projections by the retained result that owns each recorded generation, so a
 * restore reads each owning manifest exactly once. Fails closed when any drifted path no longer
 * matches its recorded digest, or when the newest generation is adoption-sourced: adopted bytes
 * exist only in the worktree and git, never in a manifest, so there is nothing durable whose
 * re-projection the restore machinery could trust.
 */
async function baselineRestoreOwners(
  dependencies: GateLifecycleDependencies,
  authority: TransactionAuthority,
  current: CanonicalDocument<TaskStateV1>,
  context: BaselineContext,
  repositorySet: RepositorySet,
): Promise<ProjectResult<readonly Readonly<{
  reference: AuthoritativeResultRef;
  repository: BaselineRepositoryName;
  drifted: readonly BaselineDriftedProjection[];
}>[]>> {
  const targets = await discoverNewestProjections(dependencies, authority, current, repositorySet);
  if (!targets.ok) return targets;
  const owners = new Map<string, Map<BaselineRepositoryName, { reference: AuthoritativeResultRef; repository: BaselineRepositoryName; drifted: BaselineDriftedProjection[] }>>();
  for (const target of baselineRepositoryTargets(context)) {
    for (const drifted of target.drifted_projections) {
      const entry = targets.value.get(projectionLookup(target.repository, drifted.path));
      if (entry === undefined || entry.retired || entry.projection.content_digest !== drifted.recorded_digest) {
        return issue("STATE_INVALID", current.value, "baseline-adoption-current-stale");
      }
      if (entry.reference === undefined) {
        return issue("STATE_INVALID", current.value, "baseline-adoption-restore-source-unavailable");
      }
      let repositories = owners.get(entry.reference.result_digest);
      if (repositories === undefined) {
        repositories = new Map();
        owners.set(entry.reference.result_digest, repositories);
      }
      const group = repositories.get(target.repository);
      if (group === undefined) repositories.set(target.repository, {
        reference: entry.reference, repository: target.repository, drifted: [drifted],
      });
      else group.drifted.push(drifted);
    }
  }
  return ok(Object.freeze([...owners.values()].flatMap((repositories) => [...repositories.values()]).map((owner) =>
    Object.freeze({ reference: owner.reference, repository: owner.repository, drifted: Object.freeze(owner.drifted) }))));
}

/**
 * Whether a restore decision can honestly be offered for this drift set: every drifted path's
 * recorded generation must be held by a retained manifest. Adoption-sourced generations exist
 * only in the worktree and git, never in a manifest, so restoring them can never succeed — and
 * a decided interface cannot be corrected, so the choice must be refused before the gate opens
 * rather than recorded as a decision that can never apply behind it.
 */
export async function baselineRestoreOffered(
  dependencies: GateLifecycleDependencies,
  authority: TransactionAuthority,
  state: CanonicalDocument<TaskStateV1>,
  context: BaselineContext,
  repositorySet: RepositorySet,
): Promise<boolean> {
  const newest = await discoverNewestProjections(dependencies, authority, state, repositorySet);
  if (!newest.ok) return false;
  return baselineRepositoryTargets(context).every((target) => target.drifted_projections.every((drifted) =>
    newest.value.get(projectionLookup(target.repository, drifted.path))?.reference !== undefined));
}

async function resolveAdvancingGate(
  dependencies: GateLifecycleDependencies,
  authority: TransactionAuthority,
  gateId: PathSafeId,
  inputFingerprint: Sha256Digest,
): Promise<ProjectResult<GateResolution>> {
  try {
    await ensureIntentDirectory(authority);
    return await dependencies.lock.runExclusive(authority.workspace_root, async () => {
      const stateResult = await stateOrFailure(dependencies, authority); if (!stateResult.ok) return stateResult;
      const current = stateResult.value;
      const live = await validateLiveGateState(dependencies, authority, current, inputFingerprint);
      if (!live.ok) return live;
      const requestPath = await resolvePath(dependencies, authority, gateRequestClaim(gateId), "authority-decision");
      const archivePath = await resolvePath(dependencies, authority, gateDecisionClaim(gateId), "authority-decision");
      const interfacePath = await resolvePath(dependencies, authority, "gate.decision", "workspace-gate-interface");
      if (!requestPath.ok) return requestPath; if (!archivePath.ok) return archivePath; if (!interfacePath.ok) return interfacePath;
      const request = await readCanonical(requestPath.value, "gate request", parsePersistedGateRequest);
      if (request === "missing" || request === "invalid") return issue("STATE_INVALID", current.value, "gate-request-invalid");
      let archived = await readCanonical(archivePath.value, "gate decision record", parseGateDecisionRecord);
      let preparedClosure: CanonicalDocument<TaskStateV1> | undefined;
      if (archived === "invalid") return issue("STATE_INVALID", current.value, "gate-decision-record-invalid");
      if (archived !== "missing" && !validateDurableSemantics({ gate_request: request, gate_decision: archived }).ok) return issue("STATE_INVALID", current.value, "gate-archive-binding-invalid");
      if (archived === "missing") {
        const raw = await readCanonical(interfacePath.value, "gate decision interface", (value) => value as PlainJsonValue);
        if (raw === "missing" || raw === "invalid") return fail(createProjectError("GATE_DECISION_INVALID", { gate_id: gateId, gate_kind: request.value.kind, issue_code: "decision-invalid" }));
        let record: GateDecisionRecordV1;
        try { record = parseInterface(raw.value, request.value); } catch { return fail(createProjectError("GATE_DECISION_INVALID", { gate_id: gateId, gate_kind: request.value.kind, issue_code: "decision-binding-invalid" })); }
        const document = canonicalDocument(record);
        if (!earnsReceipt(record)) return issue("STATE_INVALID", current.value, "gate-resolution-routing-invalid");
        // Validate the landing state before making the human's decision durable. In particular,
        // malformed approved design phase plans must leave no server-owned archive behind so the
        // still-open human interface can be corrected to revise, reject, or cancel.
        const closure = await closedStateForRecord(
          dependencies, authority, current, request.value, record, document.digest, live.value.repository_set,
        );
        if (!closure.ok) return closure;
        if (await dependencies.atomic.createExclusive(archivePath.value, document.bytes) !== "created") return issue("STATE_INVALID", current.value, "gate-resolution-race");
        archived = document;
        preparedClosure = closure.value;
      }
      if (current.value.open_gate?.gate_id !== gateId) {
        const effect = archived.value.outcome === "decided" ? gateDecisionEffect(archived.value.envelope.payload) : "advance";
        return ok({ state: current, record: archived, effect, replayed: true });
      }
      if (archived.value.outcome === "decided" && archived.value.kind === "restore-collision" && archived.value.envelope.payload.decision === "discard-and-restore") {
        const reference = [...current.value.authoritative_results].reverse().find((item) => item.phase_instance === request.value.phase_instance && item.step === "produce");
        if (reference === undefined || dependencies.load_retained_result === undefined || dependencies.projection_writer === undefined || dependencies.gate_secret_scanner === undefined) return issue("STATE_INVALID", current.value, "restore-result-missing");
        const retained = await dependencies.load_retained_result(reference); if (!retained.ok) return retained;
        const context = request.value.context as Extract<GateRequestV1, { kind: "restore-collision" }>["context"];
        const repositoryPath = `.archflow/tasks/${authority.task_id}/${context.path}`;
        const original = retained.value.projection_plan.entries.find((entry) => entry.path === repositoryPath);
        if (original === undefined || original.git_tracked === undefined) return issue("STATE_INVALID", current.value, "restore-gated-path-missing");
        const selected = [original];
        if (original.rename_pair !== undefined) {
          const peer = retained.value.projection_plan.entries.find((entry) => entry.path === original.rename_pair!.peer_path && entry.rename_pair?.peer_path === original.path);
          if (peer === undefined || peer.git_tracked === undefined) return issue("STATE_INVALID", current.value, "restore-rename-peer-missing");
          selected.push(peer);
        }
        const captures = new Map<string, Awaited<ReturnType<typeof captureProjectionTarget>>>();
        for (const entry of selected) {
          const captured = await captureProjectionTarget(entry.target);
          captures.set(entry.path, captured);
        }
        const alreadyApplied = selected.every((entry) => projectionGenerationDigest(captures.get(entry.path)!.observation) === desiredGenerationDigest(entry.desired));
        const originalGeneration = projectionGenerationDigest(captures.get(original.path)!.observation);
        if (originalGeneration !== context.current_generation_digest && originalGeneration !== desiredGenerationDigest(original.desired)) return issue("STATE_INVALID", current.value, "restore-current-generation-stale");
        if (selected.slice(1).some((entry) => {
          const observation = captures.get(entry.path)!.observation;
          return !isDeepStrictEqual(observation, entry.observed_before) && projectionGenerationDigest(observation) !== desiredGenerationDigest(entry.desired);
        })) return issue("STATE_INVALID", current.value, "restore-rename-peer-changed");
        if (!alreadyApplied) {
          const pending = selected.filter((entry) => projectionGenerationDigest(captures.get(entry.path)!.observation) !== desiredGenerationDigest(entry.desired));
          const ordered = [...pending].sort((left, right) =>
            left.rename_pair?.role === "source" ? -1 : right.rename_pair?.role === "source" ? 1 : 0
          );
          const sources: ProjectionSource[] = ordered.map((entry) => {
            const captured = captures.get(entry.path)!;
            return Object.freeze({
              path: entry.path, target: entry.target, desired: entry.desired,
              authenticated_before: captured.observation, rollback: captured.rollback,
              git_tracked: entry.git_tracked!,
            });
          });
          const plan = await prepareProjectionPlan(sources, dependencies.gate_secret_scanner, retained.value.worktree_root); if (!plan.ok) return plan;
          if (plan.value.collisions.length !== 0) return issue("STATE_INVALID", current.value, "restore-replan-collision");
          const applied = await applyProjectionPlan(dependencies.projection_writer, plan.value);
          if (applied.outcome !== "applied") return issue("STATE_INVALID", current.value, `restore-${applied.outcome}`);
        }
      }
      if (archived.value.outcome === "decided" && archived.value.kind === "baseline-adoption" &&
          archived.value.envelope.payload.decision === "restore-recorded-bytes") {
        if (dependencies.load_retained_result === undefined || dependencies.projection_writer === undefined || dependencies.gate_secret_scanner === undefined) {
          return issue("STATE_INVALID", current.value, "baseline-adoption-restore-unavailable");
        }
        const context = request.value.context as Extract<GateRequestV1, { kind: "baseline-adoption" }>["context"];
        const owners = await baselineRestoreOwners(dependencies, authority, current, context, live.value.repository_set);
        if (!owners.ok) return owners;
        const sources = new Map<BaselineRepositoryName, ProjectionSource[]>();
        for (const owner of owners.value) {
          for (const drifted of owner.drifted) {
            let source: ProjectionSource;
            if (owner.repository === "primary") {
              const retained = await dependencies.load_retained_result(owner.reference);
              if (!retained.ok) return retained;
              const entry = retained.value.projection_plan.entries.find((item) => item.path === drifted.path);
              if (entry === undefined || entry.git_tracked === undefined) return issue("STATE_INVALID", current.value, "baseline-adoption-restore-path-missing");
              const captured = await captureProjectionTarget(entry.target);
              source = Object.freeze({
                path: entry.path, target: entry.target, desired: entry.desired,
                authenticated_before: captured.observation, rollback: captured.rollback,
                git_tracked: entry.git_tracked,
                ...(entry.rename_pair === undefined ? {} : { rename_pair: entry.rename_pair }),
              });
            } else {
              const selected = await readRetainedRepositoryOutput({
                primary_runner: dependencies.runner, authority, reference: owner.reference,
                repository_set: live.value.repository_set, repository: owner.repository,
                output_path: drifted.path,
              });
              if (!selected.ok) return selected;
              source = selected.value;
            }
            const freshness = await assessBaselineRestoreSourceFreshness(source, drifted.observed_digest);
            if (freshness.classification === "stale") {
              return issue("STATE_INVALID", current.value, "baseline-adoption-current-stale");
            }
            if (freshness.classification === "restored") continue;
            source = freshness.source;
            const group = sources.get(owner.repository);
            if (group === undefined) sources.set(owner.repository, [source]);
            else group.push(source);
          }
        }
        if (sources.size !== 0) {
          const repositoryPlans = [];
          const orderedRepositories = [...sources.keys()].sort((left, right) =>
            left === "primary" ? -1 : right === "primary" ? 1 : left < right ? -1 : left > right ? 1 : 0);
          for (const repository of orderedRepositories) {
            const member = live.value.repository_set.members.find((candidate) => candidate.name === repository);
            if (member === undefined || member.mode !== "writable") {
              return issue("STATE_INVALID", current.value, "baseline-adoption-restore-repository-unavailable");
            }
            const plan = await prepareProjectionPlan(
              sources.get(repository)!, dependencies.gate_secret_scanner,
              member.binding.runner.location.worktreeRoot as ResolvedTaskPath,
            );
            if (!plan.ok) return plan;
            if (plan.value.collisions.length !== 0) return issue("STATE_INVALID", current.value, "baseline-adoption-restore-collision");
            repositoryPlans.push(Object.freeze({ repository, plan: plan.value }));
          }
          const applied = await applyRepositoryProjectionPlans(dependencies.projection_writer, repositoryPlans);
          if (applied.outcome !== "applied") return issue("STATE_INVALID", current.value, `baseline-adoption-restore-${applied.outcome}`);
        }
      }
      const closure = preparedClosure === undefined
        ? await closedStateForRecord(
          dependencies, authority, current, request.value, archived.value, archived.digest, live.value.repository_set,
        )
        : ok(preparedClosure);
      if (!closure.ok) return closure;
      const prepared = canonicalDocument(withLastSeenConfig(
        closure.value.value,
        live.value.config,
        live.value.repository_set,
      ));
      const installed = await installReceipt(dependencies, authority, request.value, archived.value, current, prepared, inputFingerprint);
      if (!installed.ok) return installed;
      await dependencies.atomic.replace(authority.state, installed.value.final.bytes);
      const gateJson = await resolvePath(dependencies, authority, "gate.json", "workspace-gate-interface");
      if (gateJson.ok) await dependencies.atomic.removeGateInterface(gateJson.value);
      await dependencies.atomic.removeGateInterface(interfacePath.value);
      await cleanupCommittedGateWorkspace(dependencies, authority, installed.value.final.value);
      return ok({ state: installed.value.final, record: archived, effect: "advance", replayed: false });
    });
  } catch (error) { return error instanceof TaskLockError ? io(authority, `gate-lock-${error.stage}`) : io(authority, "gate-resolve-advance"); }
}

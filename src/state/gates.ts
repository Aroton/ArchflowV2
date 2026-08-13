import { isDeepStrictEqual } from "node:util";

import { canonicalDocument, canonicalJsonDigest, type CanonicalDocument } from "../contracts/canonical.js";
import {
  parseActiveGate,
  parseArchivedGateDecisionRecord,
  parseArchivedGateRequest,
  parseGateDecisionRecord,
  parseGateRequest,
  type GateDecisionRecordV1,
  type GateRequestV1,
  type WaiverGateContext,
} from "../contracts/durable-gate.js";
import type { ApprovalRef, LastTransition, TaskStateV1, WaiverRef } from "../contracts/durable-state.js";
import { intentOutcomeDigest, parseIntentReceipt, type IntentReceiptV1 } from "../contracts/durable-intent.js";
import { createCommittedIntentSubject, createPreparedIntentSubject, openGateFrozenStateDigest, validateDurableSemantics } from "../contracts/durable.js";
import { createProjectError, type ProjectResult } from "../contracts/errors.js";
import { parseSafeCode, parseSafeId, parseSafeInteger, type PathSafeId, type Sha256Digest } from "../contracts/evidence.js";
import { decodePhaseInstance } from "../contracts/phase-instance.js";
import { computeGateContextDigest, computeGateId } from "../contracts/fingerprints.js";
import { gateDecisionEffect } from "../contracts/gates.js";
import type { PlainJsonValue } from "../contracts/plain-json.js";
import {
  gateDecisionClaim,
  gateRequestClaim,
  intentReceiptClaim,
  resolveTaskWorkspacePath,
  type ResolvedTaskWorkspacePath,
} from "../repository/paths.js";
import { verifyRepositoryIdentity } from "../repository/identity.js";
import { resolveCommit } from "../repository/git.js";
import { assertInternalTransactionAuthority, type TransactionAuthority } from "./authority.js";
import {
  DECISIONS,
  activeProjection,
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
import { waitForGateInterface } from "./gate-wait.js";
import { ensureDecisionDirectory, ensureIntentDirectory, ensureWorkspaceProjectionParent } from "./layout.js";
import { loadLegacyImportResumePhase } from "./legacy-import-resume.js";
import { TaskLockError } from "./lock.js";
import { loadApprovedDesignFinalPhase } from "./planned-final-phase.js";
import { planStateTransition } from "./transitions.js";
import { applyProjectionPlan, captureProjectionTarget, prepareProjectionPlan, projectionGenerationDigest, type ProjectionSource } from "./snapshots.js";
import { cleanTaskWorkspace } from "./workspace-cleanup.js";

export { loadAuthenticatedGateApproval } from "./gate-approvals.js";
export {
  buildGateDecisionTemplates,
  buildHumanGatePresentation,
  gateDecisionTemplateName,
  selectGateDecisionTemplate,
  writeGateDecisionChoice,
  writeGateDecisionInterface,
} from "./gate-decision-interface.js";
export type { HumanGateDecisionOption, HumanGatePresentation } from "./gate-decision-interface.js";
export type { GateLifecycleDependencies, GateOpenInput } from "./gate-core.js";
export { findLegacyImportResumePhase } from "./legacy-import-resume.js";

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
): Promise<ProjectResult<void>> {
  const identity = verifyRepositoryIdentity(current.value.repository_identity_digest, authority.repository_identity);
  if (!identity.ok) return identity;
  if (!validateDurableSemantics({ state: current }).ok) return issue("STATE_INVALID", current.value, "gate-state-semantics-invalid");
  const config = await dependencies.read_config(authority.config);
  if (config.kind !== "valid") return config.kind === "invalid" ? issue("CONTRACT_INVALID", undefined, "task-config-invalid") : io(authority, "gate-config-read");
  if (config.snapshot.digest !== current.value.config_digest) return fail(createProjectError("PINNED_CONFIG_MISMATCH", { expected_digest: current.value.config_digest, observed_digest: config.snapshot.digest }));
  if (inputFingerprint !== current.value.input_fingerprint) return fail(createProjectError("INPUT_FINGERPRINT_MISMATCH", { expected_digest: current.value.input_fingerprint, observed_digest: inputFingerprint }));
  return ok(undefined);
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
  if (!validateDurableSemantics({ gate_request: request, gate_decision: decision }).ok || decision.digest !== context.origin.origin_decision_digest || decision.value.outcome !== "decided" || decision.value.envelope.payload.decision !== "waiver-requested" || (request.value.kind !== "constitution-review" && request.value.kind !== "design-approval")) return issue("CONTRACT_INVALID", undefined, "waiver-origin-decision-invalid");
  const payload = decision.value.envelope.payload as Extract<typeof decision.value.envelope.payload, { decision: "waiver-requested" }>;
  const requestContext = request.value.context;
  if (!("eligible_waivers" in requestContext) || request.value.gate_id !== context.origin.origin_gate_id || request.value.context_digest !== context.origin.origin_context_digest || request.value.task_id !== context.origin.task_id || request.value.phase_instance !== context.origin.phase_instance || request.value.subject_digest !== context.origin.subject_digest || request.value.current_evidence.set_digest !== context.origin.current_evidence_set_digest || !isDeepStrictEqual(payload.rule, context.origin.rule) || payload.operation !== context.origin.scope.operation || !requestContext.eligible_waivers.some((eligible) => isDeepStrictEqual(eligible.rule, context.origin.rule) && isDeepStrictEqual(eligible.scope, context.origin.scope))) return issue("CONTRACT_INVALID", undefined, "waiver-origin-binding-invalid");
  return ok(undefined);
}

async function cleanupResolvedInterfaces(
  dependencies: GateLifecycleDependencies,
  authority: TransactionAuthority,
  request: GateRequestV1,
  record: GateDecisionRecordV1,
): Promise<ProjectResult<void>> {
  try {
    await ensureIntentDirectory(authority);
    return await dependencies.lock.runExclusive(authority.workspace_root, async () => {
      const gateJson = await resolvePath(dependencies, authority, "gate.json", "workspace-gate-interface");
      if (!gateJson.ok) return gateJson;
      const active = await readCanonical(gateJson.value, "active gate", parseActiveGate);
      if (active !== "missing" && active !== "invalid" && active.value.gate_id === request.gate_id && active.value.task_id === request.task_id && active.value.phase_instance === request.phase_instance && active.value.subject_digest === request.subject_digest && active.value.context_digest === request.context_digest) {
        await dependencies.atomic.removeGateInterface(gateJson.value);
      }
      const decision = await resolvePath(dependencies, authority, "gate.decision", "workspace-gate-interface");
      if (!decision.ok) return decision;
      const projected = await readCanonical(decision.value, "gate decision interface", (value) => value as PlainJsonValue);
      if (projected !== "missing" && projected !== "invalid") {
        try {
          const bound = parseInterface(projected.value, request);
          if (canonicalJsonDigest(bound) === canonicalJsonDigest(record)) await dependencies.atomic.removeGateInterface(decision.value);
        } catch { /* never remove an interface whose gate identity cannot be authenticated */ }
      }
      return ok(undefined);
    });
  } catch (error) { return error instanceof TaskLockError ? io(authority, `gate-cleanup-lock-${error.stage}`) : io(authority, "gate-cleanup"); }
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
      const requestRead = await readCanonical(requestPath.value, "gate request", parseGateRequest);
      if (archived !== "missing") {
        if (archived === "invalid" || requestRead === "missing" || requestRead === "invalid") return issue("STATE_INVALID", current.value, "gate-archive-invalid");
        if (!validateDurableSemantics({ gate_request: requestRead, gate_decision: archived }).ok) return issue("STATE_INVALID", current.value, "gate-archive-binding-invalid");
        if (
          !enactsReentry(archived.value) &&
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
          enactsReentry(archived.value) &&
          requestRead.value.intent_id === input.intent_id &&
          requestRead.value.request_digest === input.request_digest
        ) {
          const replay = await validateCompletedReentry(
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
        const activeRequest = await readCanonical(activeRequestPath.value, "active gate request", parseGateRequest);
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
        if (
          input.subject_digest !== subject ||
          !current.value.approvals.some((approval) =>
            (approval.gate_kind === "artifact-approval" || approval.gate_kind === "design-approval") &&
            approval.subject_digest === subject)
        ) return issue("STATE_INVALID", current.value, "migration-audit-design-not-approved");
        const resume = await loadLegacyImportResumePhase(dependencies, input.authority, current.value);
        if (!resume.ok) return resume;
        const decoded = decodePhaseInstance(resume.value);
        if (
          decoded.kind !== "phase-design" ||
          current.value.planned_final_phase === undefined ||
          Number(decoded.phase) > Number(current.value.planned_final_phase)
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
      const openState = stateWithOpen(current.value, { gate_id: gateId, kind: input.kind, subject_digest: input.subject_digest, context_digest: contextDigest, context: input.context } as Pick<GateRequestV1, "gate_id" | "kind" | "subject_digest" | "context_digest" | "context">);
      let request = parseGateRequest({
        schema_version: "1", gate_id: gateId, intent_id: input.intent_id, request_digest: input.request_digest,
        task_id: input.authority.task_id, phase_instance: input.phase_instance, summary: input.summary,
        subject_digest: input.subject_digest, context_digest: contextDigest, current_evidence: input.current_evidence,
        kind: input.kind, context: input.context, allowed_decisions: waiver === undefined ? DECISIONS[input.kind] : ["grant", "deny", "cancel"], opened_at_revision: current.value.revision + 1,
      });
      let requestDocument = canonicalDocument(request);
      const created = await dependencies.atomic.createExclusive(requestPath.value, requestDocument.bytes);
      if (created === "exists") {
        const existing = await readCanonical(requestPath.value, "gate request", parseGateRequest);
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
): Promise<ProjectResult<CanonicalDocument<TaskStateV1>>> {
  if (enactsReentry(record)) {
    return planGateAuthorizedReentry(dependencies, authority, current, request, record);
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
  const plannedFinalPhase = await loadApprovedDesignFinalPhase(dependencies, current.value, record);
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
  });
  if (!fingerprint.ok) return fingerprint;
  return current.value.input_fingerprint === fingerprint.value
    ? ok(undefined)
    : issue("STATE_INVALID", current.value, "gate-reentry-replay-fingerprint-mismatch");
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
      const request = await readCanonical(requestPath.value, "gate request", parseGateRequest);
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
          return ok({ state: current, record: archived, effect, replayed: true });
        }
        const closure = await closedStateForRecord(
          dependencies, authority, current, request.value, archived.value, archived.digest,
        );
        if (!closure.ok) return closure;
        const prepared = closure.value;
        // A closure-before-receipt crash resumes through the same ordering. The archived request
        // carries no fingerprint field, so only non-success closures can be resumed here; success
        // receipt recovery is driven by runDurableGate, which supplies the authenticated fingerprint.
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
        dependencies, authority, current, request.value, record, document.digest,
      );
      if (!closure.ok) return closure;
      const created = await dependencies.atomic.createExclusive(archivePath.value, document.bytes);
      if (created !== "created") return issue("STATE_INVALID", current.value, "gate-resolution-race");
      const effect = record.outcome === "decided" ? gateDecisionEffect(record.envelope.payload) : "non-advancing";
      const transitioned = withGateTransition(
        authority, request.value, document.value, current, closure.value,
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

export async function runDurableGate(
  dependencies: GateLifecycleDependencies,
  input: GateOpenInput & Readonly<{ signal: AbortSignal }>,
): Promise<ProjectResult<GateResolution | GateOpenResult>> {
  const opened = await openDurableGate(dependencies, input);
  if (!opened.ok) return opened;
  if (opened.value.replay !== undefined) {
    if (opened.value.state.value.open_gate?.gate_id !== opened.value.gate_id) {
      const effect = opened.value.replay.value.outcome === "decided" ? gateDecisionEffect(opened.value.replay.value.envelope.payload) : "non-advancing";
      const cleaned = await cleanupResolvedInterfaces(dependencies, input.authority, opened.value.request.value, opened.value.replay.value);
      if (!cleaned.ok) return cleaned;
      if (opened.value.replay.value.outcome === "cancelled") return fail(createProjectError("GATE_CANCELLED", { gate_id: opened.value.gate_id, gate_kind: opened.value.replay.value.kind }));
      return ok({ state: opened.value.state, record: opened.value.replay, effect, replayed: true });
    }
    return earnsReceipt(opened.value.replay.value)
      ? resolveAdvancingGate(dependencies, input.authority, opened.value.gate_id, input.input_fingerprint)
      : resolveDurableGate(dependencies, input.authority, opened.value.gate_id, input.input_fingerprint);
  }
  const decision = await resolvePath(dependencies, input.authority, "gate.decision", "workspace-gate-interface");
  if (!decision.ok) return decision;
  const wait = await waitForGateInterface({
    decision_path: decision.value,
    signal: input.signal,
  });
  if (wait.kind === "aborted") return fail(createProjectError("CANCELLED", { source: "client", attempt: input.authority.context.attempt }));
  // Resolve inline so advancing decisions can write archive -> receipt -> state while the
  // authenticated request fingerprint is still available. The lower-level resolver deliberately
  // refuses to manufacture success receipts without it.
  const resolved = await resolveDurableGate(dependencies, input.authority, opened.value.gate_id, input.input_fingerprint);
  if (resolved.ok || resolved.error.code !== "STATE_INVALID") return resolved;
  return resolveAdvancingGate(dependencies, input.authority, opened.value.gate_id, input.input_fingerprint);
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
      const request = await readCanonical(requestPath.value, "gate request", parseGateRequest);
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
          dependencies, authority, current, request.value, record, document.digest,
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
      const closure = preparedClosure === undefined
        ? await closedStateForRecord(
          dependencies, authority, current, request.value, archived.value, archived.digest,
        )
        : ok(preparedClosure);
      if (!closure.ok) return closure;
      const prepared = closure.value;
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

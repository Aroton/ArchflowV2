import type { InvocationContext } from "../../contracts/contexts.js";
import { createProjectError, type ProjectResult } from "../../contracts/errors.js";
import { canonicalJsonDigest, sha256Bytes, type GitOid } from "../../contracts/canonical.js";
import { parsePathSafeId, parseSafeId, parseSafeInteger } from "../../contracts/evidence.js";
import type { Sha256Digest } from "../../contracts/evidence.js";
import {
  createInternalResultExpectation,
  validateProjectResultStructure,
  type ParsedToolCall,
  type ToolSuccess,
} from "../../contracts/mcp-tools.js";
import { parseTaskPathClaim } from "../../contracts/path-claims.js";
import { resolveTaskPath } from "../../repository/paths.js";
import { resolveCommit } from "../../repository/git.js";
import {
  loadAuthenticatedGateApproval,
  type AuthenticatedGateApproval,
} from "../../state/gate-approvals.js";
import {
  authenticateRuleAcceptancePolicy,
  resolvePinnedConstitution,
} from "../../state/constitution.js";
import { findLegacyImportResumePhase, loadLegacyImportInitialization } from "../../state/legacy-import-resume.js";
import {
  loadCurrentReviewSet,
  loadRetainedEvidence,
  prepareEvidenceResult,
  validateEditorialPredecessorDeclaration,
  type EvidenceResultValue,
  type PreparedEvidenceResult,
  type RetainedEvidenceSet,
} from "../../state/evidence-results.js";
import { runStateInitialization } from "../../state/initialization.js";
import { identifyTransactionRequest } from "../../state/request.js";
import { changedCoProducedDocumentPaths, loadCurrentProduceSubject, type CurrentProduceSubject } from "../../state/produce-subject.js";
import {
  approvedDesignWorktreeMatchesRetainedArtifact,
  designArtifactCommittedAtCurrentTarget,
  resolveAutonomousDesignMilestoneProof,
  resolveAutonomousImplementationMilestoneProof,
  resolveImplementationMilestoneProof,
  secondaryImplementationMilestonesProven,
} from "../../state/implementation-manifest.js";
import { decodePhaseInstance } from "../../contracts/phase-instance.js";
import { exactCommitAuthorizationContext } from "../../contracts/durable-gate.js";
import type {
  PlanningRestartConnectedProvenance,
  RuleSettlementV1,
  TaskStateV1,
} from "../../contracts/durable-state.js";
import {
  prepareResultInstallation,
  runStateTransaction,
  type PreparedTransaction,
} from "../../state/transaction.js";
import type { ProductionServices } from "../../state/production.js";
import type { RepositorySet } from "../../repository/repository-set.js";
import type { LiveConfigSnapshot } from "../../state/read.js";
import { assessCurrentEvidence } from "../../review/fixed-point.js";
import {
  approvalRuleContext,
  buildRuleSettlement,
  evaluateApprovalRules,
} from "../../state/approval-rules.js";
import {
  currentApprovedUpstreams,
  currentReviewPredecessor,
  currentBaselineTargetFacts,
  currentTargetRef,
  computeTaskStatus,
  baselineAdoptionInputFromFindings,
  baselinePresentedTargetsOnCurrentFirstParent,
  buildSecondaryCommitAuthorizationFacts,
  pendingAdjudicationGates,
} from "../../state/status.js";
import {
  planApprovalTriggerAuthorityRecovery,
  planMilestoneRecovery,
  planStateTransition,
} from "../../state/transitions.js";
import { planPlanningRestart } from "../../state/transitions.js";
import { installPlanningRestartAskAppend, validatePlanningRestartAskAppend } from "../../state/phase-documents.js";
import {
  acceptedNoWaitSettlement,
  authenticatedApprovalIsEligibleAfterLatestRestart,
  matchingOrdinaryApproval,
} from "../../state/restart-authority.js";
import { completedPlanningRestartMatches, planningRestartId } from "../../state/planning-restart.js";
import {
  derivedFinalPhaseBelowCurrentPhase,
  loadAutonomousDesignFinalPhase,
  plannedFinalPhaseFromRecordedPayloads,
} from "../../state/planned-final-phase.js";
import { discoverReconciliationInput } from "../../state/reconciliation-discovery.js";
import { reconcileCurrentAuthority } from "../../state/reconciliation.js";
import { refreshStaleBaselineGate } from "../../state/gates.js";
import { compareRuleSettlements } from "../../contracts/durable-state.js";
import { mapHandlerErrors } from "./errors.js";
import { openHandlerSession } from "./session.js";
import {
  prepareDocumentResult,
  prepareImplementationResult,
  type PreparedStateResult,
} from "./state-results.js";

const fail = <T>(error: ReturnType<typeof createProjectError>): ProjectResult<T> =>
  Object.freeze({ schema_version: "1", ok: false, error });

function stateResultId(intentId: string): ReturnType<typeof parseSafeId> {
  return parseSafeId(`state-result-${sha256Bytes(new TextEncoder().encode(intentId)).slice(0, 32)}`);
}

function restartProvenance(
  context: InvocationContext,
  requestDigest: ReturnType<typeof canonicalJsonDigest>,
): PlanningRestartConnectedProvenance {
  return Object.freeze({
    schema_version: "1",
    actor_class: "human",
    assurance: "connected-request-trace",
    channel: "connected-host",
    connection_id: parseSafeId(context.connection.connection_id),
    invocation_id: parseSafeId(context.invocation_id),
    request_id_digest: canonicalJsonDigest({
      schema_version: "1",
      digest_kind: "transport-request-id",
      request_id: context.transport_metadata.request_id,
    }),
    request_digest: requestDigest,
  });
}

/**
 * The settle-path rule determination (P3-5). This is a specified evidence observation, never an
 * assumption: the preparation assembles the same evidence the composeGate disagreement-guard mirror
 * assembles — the retained evidence set with the triage result this very transaction installs
 * overlaid into it, the pinned constitution, authenticated approvals, approved upstream digests —
 * and runs the same assessment against the post-settle state. A settlement is returned only when that
 * assessment reaches the clean-advance path, which no pending adjudication gate can coexist with
 * (unsatisfied constitution findings, a failing or uncertain rule, or eligible waivers all route
 * elsewhere), and only when the preparation's own single config read both parsed and concluded no
 * rule conclusion is frozen. Every failure along the way means no settlement — fail closed; the
 * settle itself is legitimate work either way, and the post-settle status advertises the next
 * action the status seam derives.
 */
async function settleApprovalRules(
  services: ProductionServices,
  repositorySet: RepositorySet,
  current: TaskStateV1,
  prospective: TaskStateV1,
  produce: CurrentProduceSubject,
  retained: RetainedEvidenceSet,
  config: LiveConfigSnapshot | undefined,
): Promise<RuleSettlementV1 | undefined> {
  if (config === undefined) return undefined;
  try {
    const constitution = await resolvePinnedConstitution(
      services.runner, current.policy_base_commit, services.authority.context,
    );
    if (!constitution.ok) return undefined;
    const authenticated: AuthenticatedGateApproval[] = [];
    for (const approval of current.approvals) {
      const loaded = await loadAuthenticatedGateApproval(services.dependencies, services.authority, approval);
      if (!loaded.ok) return undefined;
      if (!authenticatedApprovalIsEligibleAfterLatestRestart(current, loaded.value)) continue;
      authenticated.push(loaded.value);
    }
    const approvedUpstreams = await currentApprovedUpstreams(
      services.dependencies, services.authority, current, authenticated, produce,
    );
    // A pending migration audit is a human gate this settlement must not stand in for: the settlement
    // is alternative authority to an approval, and an imported design's advance still requires the
    // audit decision — its phase bound comes from the import, never the legacy document's grammar.
    // This is the same `migration_audit_required` fact the composeGate mirror's adjudication
    // branch opens its gate from.
    const legacyInitialization = await loadLegacyImportInitialization(
      services.dependencies, services.authority, current,
    );
    if (!legacyInitialization.ok) return undefined;
    if (
      legacyInitialization.value !== undefined &&
      current.phase_instance === "design" &&
      !authenticated.some((approval) =>
        approval.request.kind === "migration-audit" &&
        approval.decision.envelope.payload.decision === "accept-import-audit")
    ) return undefined;
    const predecessor = currentReviewPredecessor(current, produce);
    const assessment = assessCurrentEvidence(
      prospective,
      retained,
      {
        subject_digest: produce.artifact_digest,
        input_fingerprint: current.input_fingerprint,
        constitution: constitution.value,
        approved_upstream_digests: approvedUpstreams,
        authenticated_gate_approvals: authenticated,
        ...(predecessor === undefined ? {} : { review_predecessor: predecessor }),
        ...(config.parsed.max_attempts === undefined ? {} : { max_attempts: config.parsed.max_attempts }),
      },
    );
    if (assessment.next !== "advance") {
      if (assessment.next !== "adjudication-gate") return undefined;
      const pending = pendingAdjudicationGates(
        prospective, constitution.value, retained, authenticated,
      );
      if (pending[0]?.kind !== "constitution-review") return undefined;
    }
    const changedDocuments = await changedCoProducedDocumentPaths(services.dependencies, current, produce);
    if (!changedDocuments.ok) return undefined;
    const ruleContext = approvalRuleContext(current, produce, config.parsed, changedDocuments.value);
    const conclusion = evaluateApprovalRules(
      ruleContext.config, ruleContext.subject, ruleContext.changedPaths, ruleContext.secondaryChangedPaths,
    );
    const kind = decodePhaseInstance(current.phase_instance).kind;
    const milestoneTarget = !conclusion.wait && (kind === "design" || kind === "phase-design" || kind === "phase-impl")
      ? await currentTargetRef(services.dependencies)
      : undefined;
    const observedTargetHead = milestoneTarget === undefined
      ? undefined
      : await resolveCommit(services.runner, milestoneTarget.value);
    const milestoneBaseline = milestoneTarget === undefined
      ? undefined
      : produce.artifact.artifact_kind === "implementation-output"
        ? produce.artifact.base_commit
        : observedTargetHead;
    const secondaryMilestones = !conclusion.wait && produce.artifact.artifact_kind === "implementation-output"
      ? await buildSecondaryCommitAuthorizationFacts(produce.artifact, repositorySet)
      : Object.freeze([]);
    return buildRuleSettlement(
      current, produce.artifact_digest, config.digest, conclusion, milestoneBaseline,
      milestoneTarget === undefined ? undefined : { ref: milestoneTarget.value, head: observedTargetHead! },
      secondaryMilestones,
    );
  } catch {
    // The guard mirror turns these throws into gate-fixed-point-disagreement; a settle that
    // cannot observe a clean fixed point simply mints no settlement.
    return undefined;
  }
}

export async function handleState(
  call: Extract<ParsedToolCall, { name: "archflow_state" }>,
  context: InvocationContext,
): Promise<ProjectResult<ToolSuccess<"archflow_state">>> {
  return mapHandlerErrors<"archflow_state">(context.invocation_id, async () => {
    const session = await openHandlerSession(call, context);
    if (!session.ok) return session;
    const { services } = session.value;
    const restartInput = call.input.operation === "planning_restart" ? call.input : undefined;
    const refreshInput = call.input.operation === "refresh_milestone_baseline" ? call.input : undefined;
    const recoveryInput = call.input.operation === "recover_milestone_authority" ? call.input : undefined;
    const triggerRecoveryInput = call.input.operation === "recover_approval_trigger_authority" ? call.input : undefined;
    const staleBaselineInput = call.input.operation === "refresh_stale_baseline" ? call.input : undefined;
    const commitAuthorityInput = call.input.operation === "set_commit_authority" ? call.input : undefined;
    const artifact = restartInput === undefined && refreshInput === undefined &&
      recoveryInput === undefined && triggerRecoveryInput === undefined && staleBaselineInput === undefined && commitAuthorityInput === undefined ? call.input.artifact : undefined;
    if (services.state === undefined) {
      if (restartInput !== undefined || refreshInput !== undefined || recoveryInput !== undefined || triggerRecoveryInput !== undefined || staleBaselineInput !== undefined || commitAuthorityInput !== undefined) {
        return fail(createProjectError("STATE_MISSING", { phase_instance: call.input.phase_instance }));
      }
      const initialized = await runStateInitialization(services.dependencies, {
        authority: services.authority,
        call,
      });
      return initialized.ok
        ? Object.freeze({ schema_version: "1", ok: true, value: initialized.value.outcome })
        : initialized;
    }

    if (staleBaselineInput !== undefined) {
      const identified = identifyTransactionRequest(call, services.authority, staleBaselineInput.input_fingerprint);
      const refreshed = await refreshStaleBaselineGate(
        services.dependencies,
        services.authority,
        staleBaselineInput.expected_revision,
        async (current, request) => {
          const discovered = await discoverReconciliationInput(services.dependencies, services.authority, current, session.value.repository_set);
          if (!discovered.ok) return discovered;
          const reconciliation = reconcileCurrentAuthority(discovered.value);
          const target = await currentBaselineTargetFacts(services.dependencies, reconciliation.findings, session.value.repository_set);
          const live = baselineAdoptionInputFromFindings(
            services.authority.task_id, current.value, reconciliation.findings, target,
          );
          if (live === undefined) {
            return fail(createProjectError("STATE_INVALID", {
              phase_instance: current.value.phase_instance,
              issue_code: "stale-baseline-live-subject-unrepresentable",
            }));
          }
          const continuous = await baselinePresentedTargetsOnCurrentFirstParent(
            services.dependencies, request.context, target, session.value.repository_set,
          );
          return Object.freeze({
            schema_version: "1" as const,
            ok: true as const,
            value: Object.freeze({
              context: live.context,
              presented_head_on_current_first_parent: continuous,
            }),
          });
        },
      );
      if (!refreshed.ok) return refreshed;
      return Object.freeze({
        schema_version: "1",
        ok: true,
        value: Object.freeze({
          path: parseTaskPathClaim("state.json"),
          revision: refreshed.value.state.value.revision,
          status: refreshed.value.state.value.status,
          request_digest: identified.request_digest,
        }),
      });
    }

    if (restartInput !== undefined) {
      const identified = identifyTransactionRequest(
        call,
        services.authority,
        restartInput.input_fingerprint,
      );
      const restartId = planningRestartId(identified.request_digest, restartInput.intent_id);
      const existing = services.state.value.restart_history?.find((record) => record.restart_id === restartId);
      if (existing !== undefined) {
        if (!completedPlanningRestartMatches(services.state.value, {
          restart_id: restartId,
          source_phase_instance: restartInput.phase_instance,
          target_phase_instance: restartInput.target_phase_instance,
          reason: restartInput.reason,
          input_fingerprint: restartInput.input_fingerprint,
        })) {
          return fail(createProjectError("STATE_INVALID", {
            phase_instance: services.state.value.phase_instance,
            issue_code: "planning-restart-replay-mismatch",
          }));
        }
        if (existing.target_phase_instance === "prd") {
          const ask = await resolveTaskPath({
            runner: services.runner,
            taskId: services.authority.task_id,
            claim: parseTaskPathClaim("ask.md"),
            expectedClass: "task-ask",
            context: services.authority.context,
          });
          if (!ask.ok) return ask;
          if (restartInput.ask_base_digest === undefined || !await validatePlanningRestartAskAppend({
            target: ask.value,
            expected_base_digest: restartInput.ask_base_digest,
            restart_id: restartId,
            request: restartInput.reason,
          })) {
            return fail(createProjectError("STATE_INVALID", {
              phase_instance: services.state.value.phase_instance,
              issue_code: "planning-restart-ask-replay-mismatch",
            }));
          }
        }
        return Object.freeze({
          schema_version: "1",
          ok: true,
          value: Object.freeze({
            path: parseTaskPathClaim("state.json"),
            revision: existing.restarted_at_revision,
            status: "running" as const,
            request_digest: identified.request_digest,
          }),
        });
      }
    }

    const identified = identifyTransactionRequest(
      call,
      services.authority,
      call.input.input_fingerprint,
    );
    const retainedBytes = services.dependencies.read_retained_task_bytes;
    const scanner = services.dependencies.gate_secret_scanner;
    const transaction = await runStateTransaction(
      services.dependencies,
      { authority: services.authority, call },
      async (current, identifiedCall, liveConfig): Promise<ProjectResult<PreparedTransaction<"archflow_state">>> => {
        if (recoveryInput !== undefined) {
          const computed = await computeTaskStatus(services.dependencies, services.authority);
          const recovery = computed.ok ? computed.value.milestone_recovery : undefined;
          if (!computed.ok || computed.value.next_action.code !== "recover-milestone-authority" ||
              computed.value.revision !== current.value.revision || recovery === undefined ||
              recoveryInput.phase_instance !== current.value.phase_instance ||
              recoveryInput.step !== current.value.step || recoveryInput.status !== current.value.status) {
            return fail(createProjectError("TRANSITION_INVALID", {
              phase_instance: current.value.phase_instance,
              from: `${current.value.step}-${current.value.status}`,
              to: "milestone-recovery",
            }));
          }
          const recoveryId = parsePathSafeId(`milestone-recovery-${identified.request_digest}`);
          const planned = planMilestoneRecovery({
            current: current.value,
            recovery_id: recoveryId,
            cause: recovery.cause,
            target_ref: recovery.target_ref,
            target_head: recovery.target_head,
            subject_digest: recovery.subject_digest,
            recomputed_input_fingerprint: identified.input_fingerprint,
          });
          if (!planned.ok) return planned;
          const revision = parseSafeInteger(current.value.revision + 1);
          const success = Object.freeze({
            path: parseTaskPathClaim("state.json"), revision, status: "running" as const,
            request_digest: identified.request_digest,
          });
          const expectation = createInternalResultExpectation({
            schema_version: "1", tool: "archflow_state", task_id: services.authority.task_id,
            intent_id: recoveryInput.intent_id, input_fingerprint: identified.input_fingerprint,
            request_digest: identified.request_digest, result_id: parseSafeId(recoveryId),
            resulting_revision: revision, success,
          });
          const result = validateProjectResultStructure(identifiedCall, {
            schema_version: "1", ok: true, value: success,
          });
          return Object.freeze({
            schema_version: "1", ok: true,
            value: Object.freeze({ expectation, result, next_state: planned.value }),
          });
        }
        if (triggerRecoveryInput !== undefined) {
          const computed = await computeTaskStatus(services.dependencies, services.authority);
          if (
            !computed.ok ||
            computed.value.next_action.code !== "recover-approval-trigger-authority" ||
            computed.value.revision !== current.value.revision ||
            triggerRecoveryInput.phase_instance !== current.value.phase_instance ||
            triggerRecoveryInput.step !== current.value.step ||
            triggerRecoveryInput.status !== current.value.status
          ) {
            return fail(createProjectError("TRANSITION_INVALID", {
              phase_instance: current.value.phase_instance,
              from: `${current.value.step}-${current.value.status}`,
              to: "approval-trigger-authority-recovery",
            }));
          }
          const planned = planApprovalTriggerAuthorityRecovery({
            current: current.value,
            recomputed_input_fingerprint: identified.input_fingerprint,
          });
          if (!planned.ok) return planned;
          const revision = parseSafeInteger(current.value.revision + 1);
          const success = Object.freeze({
            path: parseTaskPathClaim("state.json"), revision, status: "running" as const,
            request_digest: identified.request_digest,
          });
          const expectation = createInternalResultExpectation({
            schema_version: "1", tool: "archflow_state", task_id: services.authority.task_id,
            intent_id: triggerRecoveryInput.intent_id, input_fingerprint: identified.input_fingerprint,
            request_digest: identified.request_digest,
            result_id: stateResultId(triggerRecoveryInput.intent_id),
            resulting_revision: revision, success,
          });
          const result = validateProjectResultStructure(identifiedCall, {
            schema_version: "1", ok: true, value: success,
          });
          return Object.freeze({
            schema_version: "1", ok: true,
            value: Object.freeze({ expectation, result, next_state: planned.value }),
          });
        }
        if (commitAuthorityInput !== undefined) {
          const state = current.value;
          if (state.terminal !== undefined || state.open_gate !== undefined) {
            return fail(createProjectError("TRANSITION_INVALID", {
              phase_instance: commitAuthorityInput.phase_instance,
              from: `${state.step}-${state.status}`,
              to: "set-commit-authority",
            }));
          }
          let resolvedCommit: GitOid;
          try {
            resolvedCommit = await resolveCommit(services.runner, commitAuthorityInput.target_commit);
          } catch {
            return fail(createProjectError("STATE_INVALID", {
              phase_instance: state.phase_instance,
              issue_code: "target-commit-unresolvable",
            }));
          }
          const scope = commitAuthorityInput.scope ?? ["milestone"];
          const updateMilestone = scope.includes("milestone");
          const updatePolicy = scope.includes("policy");

          const revision = parseSafeInteger(state.revision + 1);
          let updatedRuleSettlements = state.rule_settlements;

          if (updateMilestone && updatedRuleSettlements !== undefined && updatedRuleSettlements.length > 0) {
            const matchingSettlement = [...updatedRuleSettlements]
              .filter((s) => s.phase_instance === state.phase_instance)
              .sort((a, b) => b.settled_at_revision - a.settled_at_revision)[0];
            if (matchingSettlement !== undefined && matchingSettlement.milestone_baseline_commit !== undefined) {
              const replacement: RuleSettlementV1 = Object.freeze({
                ...matchingSettlement,
                settled_at_revision: revision,
                milestone_baseline_commit: resolvedCommit,
                ...(matchingSettlement.milestone_target_ref === undefined ? {} : {
                  milestone_target_ref: matchingSettlement.milestone_target_ref,
                  milestone_target_head: resolvedCommit,
                }),
              });
              updatedRuleSettlements = Object.freeze([...(state.rule_settlements ?? []), replacement].sort(compareRuleSettlements));
            }
          }

          let newPolicyBaseCommit = state.policy_base_commit;
          let newConstitutionDigest = state.constitution_digest;
          if (updatePolicy) {
            const resolvedConstitution = await resolvePinnedConstitution(
              services.runner, resolvedCommit, services.authority.context,
            );
            if (!resolvedConstitution.ok) return resolvedConstitution;
            newPolicyBaseCommit = resolvedCommit;
            newConstitutionDigest = resolvedConstitution.value.digest;
          }

          const { revision: _revision, last_transition: _transition, ...preserved } = state;
          const nextState = Object.freeze({
            ...preserved,
            phase_instance: commitAuthorityInput.phase_instance,
            step: commitAuthorityInput.step,
            status: commitAuthorityInput.status,
            input_fingerprint: identified.input_fingerprint,
            ...(updatePolicy ? { policy_base_commit: newPolicyBaseCommit, constitution_digest: newConstitutionDigest } : {}),
            ...(updatedRuleSettlements === undefined ? {} : { rule_settlements: updatedRuleSettlements }),
          });

          const success = Object.freeze({
            path: parseTaskPathClaim("state.json"),
            revision,
            status: commitAuthorityInput.status,
            request_digest: identified.request_digest,
          });
          const expectation = createInternalResultExpectation({
            schema_version: "1",
            tool: "archflow_state",
            task_id: services.authority.task_id,
            intent_id: commitAuthorityInput.intent_id,
            input_fingerprint: identified.input_fingerprint,
            request_digest: identified.request_digest,
            result_id: stateResultId(commitAuthorityInput.intent_id),
            resulting_revision: revision,
            success,
          });
          const result = validateProjectResultStructure(identifiedCall, {
            schema_version: "1",
            ok: true,
            value: success,
          });
          return Object.freeze({
            schema_version: "1",
            ok: true,
            value: Object.freeze({ expectation, result, next_state: nextState }),
          });
        }
        if (refreshInput !== undefined) {
          const state = current.value;
          const decoded = decodePhaseInstance(state.phase_instance);
          if ((decoded.kind !== "design" && decoded.kind !== "phase-design") ||
              refreshInput.phase_instance !== state.phase_instance || state.step !== "triage" ||
              state.status !== "succeeded" || state.open_gate !== undefined ||
              state.pending_human_revision !== undefined || state.terminal !== undefined) {
            return fail(createProjectError("TRANSITION_INVALID", {
              phase_instance: refreshInput.phase_instance, from: `${state.step}-${state.status}`, to: "refresh-milestone-baseline",
            }));
          }
          const constitution = await resolvePinnedConstitution(
            services.runner, state.policy_base_commit, services.authority.context,
          );
          if (!constitution.ok) return constitution;
          const policy = authenticateRuleAcceptancePolicy(state, constitution.value);
          const produce = await loadCurrentProduceSubject(services.dependencies, state);
          if (!produce.ok) return produce;
          const refreshApprovals: AuthenticatedGateApproval[] = [];
          for (const approval of state.approvals) {
            if (approval.subject_digest !== produce.value.artifact_digest) continue;
            const loaded = await loadAuthenticatedGateApproval(
              services.dependencies, services.authority, approval,
            );
            if (!loaded.ok) return loaded;
            if (authenticatedApprovalIsEligibleAfterLatestRestart(state, loaded.value)) {
              refreshApprovals.push(loaded.value);
            }
          }
          const humanApproved = matchingOrdinaryApproval(
            state, refreshApprovals, produce.value.artifact_digest, state.phase_instance,
          ) !== undefined;
          const prior = policy === undefined || humanApproved ? undefined : acceptedNoWaitSettlement(
            policy, state, produce.value.artifact_digest, state.phase_instance,
          );
          if (prior?.milestone_baseline_commit === undefined || prior.config_digest !== liveConfig.digest) {
            return fail(createProjectError("STATE_INVALID", {
              phase_instance: state.phase_instance, issue_code: "milestone-baseline-refresh-authority-missing",
            }));
          }
          if (produce.value.artifact.artifact_kind !== "document" ||
              !await approvedDesignWorktreeMatchesRetainedArtifact(
                services.runner, state.task_id, produce.value.artifact,
                produce.value.retained.manifest.value.outputs, services.authority.context,
              )) {
            return fail(createProjectError("STATE_INVALID", {
              phase_instance: state.phase_instance, issue_code: "milestone-baseline-refresh-reviewed-bytes-changed",
            }));
          }
          const discovered = await discoverReconciliationInput(services.dependencies, services.authority, current, session.value.repository_set);
          if (!discovered.ok) return discovered;
          const reconciliation = reconcileCurrentAuthority(discovered.value);
          if (reconciliation.findings.length !== 0 || (discovered.value.blocking_reasons ?? []).length !== 0) {
            return fail(createProjectError("STATE_INVALID", {
              phase_instance: state.phase_instance, issue_code: "milestone-baseline-refresh-reconciliation-required",
            }));
          }
          const currentTarget = await currentTargetRef(services.dependencies);
          if (prior.milestone_target_ref !== undefined && currentTarget.value !== prior.milestone_target_ref) {
            return fail(createProjectError("STATE_INVALID", {
              phase_instance: state.phase_instance, issue_code: "milestone-baseline-refresh-target-changed",
            }));
          }
          const head = await resolveCommit(
            services.runner, prior.milestone_target_ref ?? currentTarget.value,
          );
          if (head === prior.milestone_baseline_commit) {
            return fail(createProjectError("STATE_INVALID", {
              phase_instance: state.phase_instance, issue_code: "milestone-baseline-refresh-not-needed",
            }));
          }
          const revision = parseSafeInteger(state.revision + 1);
          const replacement: RuleSettlementV1 = Object.freeze({
            ...prior,
            settled_at_revision: revision,
            milestone_baseline_commit: head,
            ...(prior.milestone_target_ref === undefined ? {} : {
              milestone_target_ref: prior.milestone_target_ref,
              milestone_target_head: head,
            }),
          });
          const { revision: _revision, last_transition: _transition, ...preserved } = state;
          const settlements = Object.freeze([...(state.rule_settlements ?? []), replacement].sort(compareRuleSettlements));
          const nextState = Object.freeze({ ...preserved, rule_settlements: settlements });
          const success = Object.freeze({
            path: parseTaskPathClaim("state.json"), revision, status: "succeeded" as const,
            request_digest: identified.request_digest,
          });
          const expectation = createInternalResultExpectation({
            schema_version: "1", tool: "archflow_state", task_id: services.authority.task_id,
            intent_id: refreshInput.intent_id, input_fingerprint: identified.input_fingerprint,
            request_digest: identified.request_digest, result_id: stateResultId(refreshInput.intent_id),
            resulting_revision: revision, success,
          });
          const result = validateProjectResultStructure(identifiedCall, { schema_version: "1", ok: true, value: success });
          return Object.freeze({ schema_version: "1", ok: true, value: Object.freeze({ expectation, result, next_state: nextState }) });
        }
        if (restartInput !== undefined) {
          const revision = parseSafeInteger(current.value.revision + 1);
          const restartId = planningRestartId(identified.request_digest, restartInput.intent_id);
          let landingFingerprint = identified.input_fingerprint;
          const planInput = {
            current: current.value,
            restart_id: restartId,
            target_phase_instance: restartInput.target_phase_instance,
            reason: restartInput.reason,
            recomputed_input_fingerprint: landingFingerprint,
            human_provenance: restartProvenance(context, identified.request_digest),
          } as const;
          // Validate every state precondition before the sole permitted worktree side effect.
          let planned = planPlanningRestart(planInput);
          if (!planned.ok) return planned;
          if (restartInput.target_phase_instance === "prd") {
            const writer = services.dependencies.atomic;
            const ask = await resolveTaskPath({
              runner: services.runner,
              taskId: services.authority.task_id,
              claim: parseTaskPathClaim("ask.md"),
              expectedClass: "task-ask",
              context: services.authority.context,
            });
            if (!ask.ok) return ask;
            await installPlanningRestartAskAppend(writer, {
              target: ask.value,
              expected_base_digest: restartInput.ask_base_digest!,
              restart_id: restartId,
              request: restartInput.reason,
            });
            const liveConfig = await services.dependencies.read_config(services.authority.config);
            if (liveConfig.kind !== "valid") {
              return fail(createProjectError("CONFIG_INVALID", { issue_code: `config-${liveConfig.kind}` }));
            }
            const landingSubject = await services.dependencies.resolve_input_fingerprint({
              runner: services.runner,
              authority: services.authority,
              state: current,
              call,
              live_config: liveConfig.snapshot,
              // The landing is committed through the kernel, whose equality pin binds the next
              // state's fingerprint to the request's claim — so this recompute is a comparing
              // site: supply the claim as the expected digest and record the accepted
              // (possibly legacy-composition) value rather than writing the new composition.
              expected_input_fingerprint: restartInput.input_fingerprint,
              context: services.authority.context,
            });
            if (!landingSubject.ok) return landingSubject;
            landingFingerprint = landingSubject.value.fingerprint;
            // The append is now installed; bind the landing state to the post-append observation.
            planned = planPlanningRestart({ ...planInput, recomputed_input_fingerprint: landingFingerprint });
            if (!planned.ok) return planned;
          }
          const success = Object.freeze({
            path: parseTaskPathClaim("state.json"),
            revision,
            status: "running" as const,
            request_digest: identified.request_digest,
          });
          const resultId = parseSafeId(restartId);
          const expectation = createInternalResultExpectation({
            schema_version: "1",
            tool: "archflow_state",
            task_id: services.authority.task_id,
            intent_id: restartInput.intent_id,
            input_fingerprint: restartInput.input_fingerprint,
            request_digest: identified.request_digest,
            result_id: resultId,
            resulting_revision: revision,
            success,
          });
          const result = validateProjectResultStructure(identifiedCall, {
            schema_version: "1",
            ok: true,
            value: success,
          });
          return Object.freeze({
            schema_version: "1",
            ok: true,
            value: Object.freeze({ expectation, result, next_state: planned.value }),
          });
        }
        let preparedResult: PreparedStateResult | PreparedEvidenceResult | undefined;
        let derivedPlannedFinalPhase: number | null | undefined;
        let settlementEvidence: RetainedEvidenceSet | undefined;
        let settlementProduce: CurrentProduceSubject | undefined;
        if (artifact?.artifact_kind === "document" || artifact?.artifact_kind === "implementation-output") {
          if (retainedBytes === undefined || scanner === undefined) {
            throw new TypeError("snapshot preparation dependencies are unavailable");
          }
          if (artifact.artifact_kind === "document" && artifact.editorial_predecessor !== undefined) {
            // An editorial revision is accepted only against the retained produce result it
            // names, only when the retained triage authorizes exactly it, and only when the
            // bytes actually changed. `current.value` still holds the predecessor's reference:
            // this very transaction is what replaces it.
            const authorized = await validateEditorialPredecessorDeclaration(
              services.dependencies,
              current.value,
              artifact,
            );
            if (!authorized.ok) return authorized;
          }
          if (
            current.value.pending_human_revision !== undefined &&
            call.input.human_revision?.classification === "simple"
          ) {
            const loadManifest = services.dependencies.load_retained_manifest;
            if (loadManifest === undefined) {
              throw new TypeError("evidence preparation dependencies are unavailable");
            }
            const retained = await loadRetainedEvidence(
              { load_retained_manifest: loadManifest }, current.value, current.value.phase_instance,
            );
            if (!retained.ok) return retained;
            const triage = retained.value.get("triage")?.manifest.source_artifact;
            if (triage?.artifact_kind === "triage" && triage.evidence.accepted_count > 0) {
              return fail(createProjectError("CONTRACT_INVALID", {
                tool: "archflow_state",
                issue_code: "simple-human-revision-cannot-resolve-accepted-finding",
              }));
            }
          }
          const common = {
            services,
            result_id: stateResultId(call.input.intent_id),
            retained_task_bytes: await retainedBytes(),
            measured_at_revision: current.value.revision,
            scanner,
          };
          const prepared = artifact.artifact_kind === "document"
            ? await prepareDocumentResult({ ...common, artifact })
            : await prepareImplementationResult({ ...common, artifact });
          if (!prepared.ok) return prepared;
          preparedResult = prepared.value;
          // Once human design approval has established the planned final phase, a later produce
          // that records design.md re-derives that existing bound from the exact new bytes. Fresh
          // or restarted design bytes leave the bound absent until approval; malformed later
          // governing-document revisions fail closed instead of silently retaining stale authority.
          try {
            derivedPlannedFinalPhase = plannedFinalPhaseFromRecordedPayloads(
              services.authority.task_id,
              prepared.value.prepared.payloads,
              current.value.planned_final_phase,
            );
          } catch {
            return fail(createProjectError("CONTRACT_INVALID", {
              tool: "archflow_state",
              issue_code: "produce-design-phase-plan-invalid",
            }));
          }
          // A derived bound below the producing phase can never satisfy completion's equality
          // test and would wedge the task offering a nonexistent successor — the same class of
          // wedge the re-derivation exists to remove. The honest route for a genuinely shrunken
          // plan is a backward planning restart.
          if (derivedPlannedFinalPhase !== undefined && derivedPlannedFinalPhase !== null &&
              derivedFinalPhaseBelowCurrentPhase(derivedPlannedFinalPhase, call.input.phase_instance)) {
            return fail(createProjectError("CONTRACT_INVALID", {
              tool: "archflow_state",
              issue_code: "produce-derived-final-phase-below-current",
            }));
          }
          const settlesProduceReentry = call.input.phase_instance === current.value.phase_instance &&
            call.input.step === "produce" && call.input.status === "succeeded" &&
            artifact.artifact_kind === "document" && artifact.editorial_predecessor !== undefined &&
            current.value.pending_human_revision === undefined && call.input.human_revision === undefined;
          if (settlesProduceReentry) {
            const loadManifest = services.dependencies.load_retained_manifest;
            if (loadManifest === undefined) throw new TypeError("evidence preparation dependencies are unavailable");
            const retained = await loadRetainedEvidence(
              { load_retained_manifest: loadManifest }, current.value, current.value.phase_instance,
            );
            if (!retained.ok) return retained;
            settlementEvidence = retained.value;
            const manifest = prepared.value.prepared.manifest.value;
            const source = manifest.source_artifact;
            if (source.artifact_kind !== "document" && source.artifact_kind !== "implementation-output") {
              return fail(createProjectError("STATE_INVALID", {
                phase_instance: current.value.phase_instance,
                issue_code: "produce-reentry-subject-invalid",
              }));
            }
            settlementProduce = Object.freeze({
              artifact_digest: manifest.artifact_digest,
              artifact: source,
              reference: prepared.value.reference,
              retained: Object.freeze({
                manifest: prepared.value.prepared.manifest,
                manifest_target: prepared.value.manifest_target,
              }),
            });
          }
        }
        if (artifact?.artifact_kind === "triage") {
          const loadManifest = services.dependencies.load_retained_manifest;
          if (retainedBytes === undefined || scanner === undefined || loadManifest === undefined) {
            throw new TypeError("evidence preparation dependencies are unavailable");
          }
          const produce = await loadCurrentProduceSubject(services.dependencies, current.value);
          if (!produce.ok) return produce;
          if (artifact.evidence.subject_digest !== produce.value.artifact_digest) {
            return fail(createProjectError("STATE_INVALID", {
              phase_instance: current.value.phase_instance,
              issue_code: "review-subject-not-current-produce-artifact",
            }));
          }
          const reviews = await loadCurrentReviewSet(
            {
              read_state: services.dependencies.read_state,
              load_retained_manifest: loadManifest,
            },
            services.authority,
            call.input.phase_instance,
          );
          if (!reviews.ok) return reviews;
          const value: EvidenceResultValue = { kind: "triage", current_reviews: reviews.value, evidence: artifact.evidence };
          // Reviewer memory rides only on the succeeded install: the retained triage and review
          // references still name the PREVIOUS round at this moment, which is exactly what the
          // ledger must carry forward. Any other prepare path installs no ledger field at all.
          const installsTriage = call.input.phase_instance === current.value.phase_instance &&
            call.input.step === "triage" && call.input.status === "succeeded";
          const loadRetainedResult = services.dependencies.load_retained_result;
          if (installsTriage && loadRetainedResult === undefined) {
            throw new TypeError("evidence preparation dependencies are unavailable");
          }
          const previousTriageRef = installsTriage
            ? current.value.authoritative_results.find((candidate) =>
                candidate.phase_instance === call.input.phase_instance && candidate.step === "triage")
            : undefined;
          const previousReviewRef = installsTriage
            ? current.value.authoritative_results.find((candidate) =>
                candidate.phase_instance === call.input.phase_instance && candidate.step === "counter_review")
            : undefined;
          const prepared = await prepareEvidenceResult({
            authority: services.authority,
            runner: services.runner,
            result_id: stateResultId(call.input.intent_id),
            retained_task_bytes: await retainedBytes(),
            measured_at_revision: current.value.revision,
            scanner,
            value,
            ...(installsTriage ? {
              disposition_ledger: {
                attempt: current.value.attempt,
                ...(previousTriageRef === undefined ? {} : { previous_triage_ref: previousTriageRef }),
                ...(previousReviewRef === undefined ? {} : { review_ref: previousReviewRef }),
              },
              // The throw above proved the loader exists whenever installsTriage holds.
              load_retained_result: loadRetainedResult!,
            } : {}),
          });
          if (!prepared.ok) return prepared;
          preparedResult = prepared.value;
          if (
            call.input.phase_instance === current.value.phase_instance &&
            call.input.step === "triage" &&
            call.input.status === "succeeded"
          ) {
            const retained = await loadRetainedEvidence(
              { load_retained_manifest: loadManifest }, current.value, current.value.phase_instance,
            );
            if (!retained.ok) return retained;
            settlementEvidence = new Map(retained.value).set("triage", Object.freeze({
              reference: prepared.value.reference,
              manifest: prepared.value.prepared.manifest.value,
            }));
            settlementProduce = produce.value;
          }
        }
        const installation = preparedResult === undefined ? undefined : prepareResultInstallation({
          reference: preparedResult.reference,
          prepared: preparedResult.prepared,
          manifest_target: preparedResult.manifest_target,
          projection_plan: preparedResult.projection_plan,
          worktree_root: services.runner.location.worktreeRoot as typeof services.authority.task_root,
          ...("secondary_projection_plans" in preparedResult && preparedResult.secondary_projection_plans !== undefined
            ? { secondary_projection_plans: preparedResult.secondary_projection_plans }
            : {}),
        });
        const revision = parseSafeInteger(current.value.revision + 1);
        const success = Object.freeze({
          path: parseTaskPathClaim("state.json"),
          revision,
          status: call.input.status,
          request_digest: identified.request_digest,
        });
        const expectation = createInternalResultExpectation({
          schema_version: "1",
          tool: "archflow_state",
          task_id: services.authority.task_id,
          intent_id: call.input.intent_id,
          input_fingerprint: call.input.input_fingerprint,
          request_digest: identified.request_digest,
          result_id: preparedResult?.reference.result_id ?? stateResultId(call.input.intent_id),
          resulting_revision: revision,
          success,
        });
        const result = validateProjectResultStructure(identifiedCall, {
          schema_version: "1",
          ok: true,
          value: success,
        });
        let completionSubjectDigest: Sha256Digest | undefined;
        let commitObserved = false;
        let legacyResumePhase;
        const authenticatedGateApprovals: AuthenticatedGateApproval[] = [];
        const decodedCurrent = decodePhaseInstance(current.value.phase_instance);
        const crossesPhase = call.input.phase_instance !== current.value.phase_instance;
        const planningRestartSignal = restartInput !== undefined;
        const completionSignal =
          !planningRestartSignal &&
          artifact === undefined &&
          decodedCurrent.kind === "phase-impl" &&
          current.value.step === "triage" &&
          current.value.status === "succeeded";
        const artifactPhaseExitSignal =
          !planningRestartSignal && artifact === undefined && crossesPhase && decodedCurrent.kind !== "phase-impl";
        let currentProduce: CurrentProduceSubject | undefined;
        let authenticatedRuleAcceptance;
        if (completionSignal || artifactPhaseExitSignal) {
          const loadedProduce = await loadCurrentProduceSubject(services.dependencies, current.value);
          if (!loadedProduce.ok) return loadedProduce;
          currentProduce = loadedProduce.value;
          completionSubjectDigest = currentProduce.artifact_digest;
          const resolved = await resolvePinnedConstitution(
            services.runner, current.value.policy_base_commit, services.authority.context,
          );
          if (!resolved.ok) return resolved;
          const policy = authenticateRuleAcceptancePolicy(current.value, resolved.value);
          const settlement = policy === undefined ? undefined : acceptedNoWaitSettlement(
            policy, current.value, completionSubjectDigest, current.value.phase_instance,
          );
          if (policy !== undefined && settlement !== undefined) {
            authenticatedRuleAcceptance = Object.freeze({ policy, settlement });
          }
        }
        if (artifactPhaseExitSignal) {
          const designExit = decodedCurrent.kind === "design" || decodedCurrent.kind === "phase-design";
          for (const approval of current.value.approvals) {
            if (
              !(designExit
                ? approval.gate_kind === "design-approval" || approval.gate_kind === "artifact-approval"
                : approval.gate_kind === "artifact-approval") ||
              approval.subject_digest !== completionSubjectDigest
            ) continue;
            const loaded = await loadAuthenticatedGateApproval(
              services.dependencies, services.authority, approval,
            );
            if (!loaded.ok) return loaded;
            if (!authenticatedApprovalIsEligibleAfterLatestRestart(current.value, loaded.value)) continue;
            authenticatedGateApprovals.push(loaded.value);
          }
          if (
            completionSubjectDigest !== undefined &&
            matchingOrdinaryApproval(
              current.value,
              authenticatedGateApprovals,
              completionSubjectDigest,
              current.value.phase_instance,
            ) !== undefined
          ) {
            authenticatedRuleAcceptance = undefined;
          }
          if (
            designExit &&
            currentProduce?.artifact.artifact_kind === "document"
          ) {
            for (const authenticated of authenticatedGateApprovals) {
              if (authenticated.request.kind !== "design-approval") continue;
              if ((await designArtifactCommittedAtCurrentTarget(
                services.runner,
                current.value.task_id,
                currentProduce.artifact,
                currentProduce.retained.manifest.value.outputs,
                authenticated.request.context,
              )).observed) {
                commitObserved = true;
                break;
              }
            }
            if (!commitObserved && authenticatedRuleAcceptance !== undefined) {
              const settlement = authenticatedRuleAcceptance.settlement;
              const baseline = settlement.milestone_baseline_commit;
              if (baseline !== undefined) {
                const currentTarget = await currentTargetRef(services.dependencies);
                const legacyTarget = settlement.milestone_target_ref === undefined;
                const pinnedTargetValid = legacyTarget || (
                  settlement.milestone_target_head === baseline &&
                  currentTarget.value === settlement.milestone_target_ref
                );
                const targetRef = legacyTarget ? currentTarget.value : settlement.milestone_target_ref!;
                const phase = decodePhaseInstance(current.value.phase_instance);
                if (phase.kind !== "design" && phase.kind !== "phase-design") {
                  throw new TypeError("autonomous design commit has a non-design phase");
                }
                const phaseLabel = phase.kind === "design" ? "design" : `phase ${String(phase.phase)} design`;
                const proof = pinnedTargetValid
                  ? await resolveAutonomousDesignMilestoneProof(
                      services.runner, current.value, currentProduce.artifact,
                      currentProduce.retained.manifest.value.outputs, targetRef, baseline,
                      `ArchFlow: Approve ${current.value.task_id} ${phaseLabel}`,
                      services.authority.context,
                    )
                  : undefined;
                commitObserved = proof?.kind === "proven" &&
                  (!legacyTarget || proof.commit === proof.target_head);
              }
              if (commitObserved && current.value.phase_instance === "design") {
                const bound = await loadAutonomousDesignFinalPhase(
                  services.dependencies, current.value, completionSubjectDigest!,
                );
                if (!bound.ok) return bound;
                derivedPlannedFinalPhase = bound.value;
              }
            }
          }
        }
        if (completionSignal && currentProduce !== undefined) {
          for (const approval of current.value.approvals) {
            if (
              approval.gate_kind !== "commit-authorization" ||
              approval.subject_digest !== completionSubjectDigest
            ) continue;
            const loaded = await loadAuthenticatedGateApproval(
              services.dependencies, services.authority, approval,
            );
            if (!loaded.ok) return loaded;
            if (!authenticatedApprovalIsEligibleAfterLatestRestart(current.value, loaded.value)) continue;
            authenticatedGateApprovals.push(loaded.value);
          }
          if (
            completionSubjectDigest !== undefined &&
            matchingOrdinaryApproval(
              current.value,
              authenticatedGateApprovals,
              completionSubjectDigest,
              current.value.phase_instance,
            ) !== undefined
          ) {
            authenticatedRuleAcceptance = undefined;
          }
          const source = currentProduce.artifact;
          if (source.artifact_kind === "implementation-output") {
            for (const authenticated of authenticatedGateApprovals) {
              if (authenticated.request.kind !== "commit-authorization") continue;
              // Pre-exact-commit archives bound no baseline, message or path set to compare.
              const exact = exactCommitAuthorizationContext(authenticated.request.context);
              if (exact === undefined) continue;
              const primaryProof = await resolveImplementationMilestoneProof(
                services.runner,
                source,
                exact,
              );
              if (primaryProof.kind === "proven" && await secondaryImplementationMilestonesProven(
                source,
                exact.secondary_commits ?? [],
                session.value.repository_set,
              )) {
                commitObserved = true;
                break;
              }
            }
            if (!commitObserved && authenticatedRuleAcceptance !== undefined) {
              const settlement = authenticatedRuleAcceptance.settlement;
              const currentTarget = await currentTargetRef(services.dependencies);
              const legacyTarget = settlement.milestone_target_ref === undefined;
              const pinnedTargetValid = legacyTarget || (
                settlement.milestone_target_head === source.base_commit &&
                settlement.milestone_baseline_commit === source.base_commit &&
                currentTarget.value === settlement.milestone_target_ref
              );
              const targetRef = legacyTarget ? currentTarget.value : settlement.milestone_target_ref!;
              const phase = decodePhaseInstance(source.phase_instance);
              const proof = pinnedTargetValid
                ? await resolveAutonomousImplementationMilestoneProof(
                    services.runner, source, targetRef,
                    `ArchFlow: Implement ${source.task_id} phase ${phase.kind === "phase-impl" ? String(phase.phase) : source.phase_instance}`,
                  )
                : undefined;
              commitObserved = proof?.kind === "proven" &&
                (!legacyTarget || proof.commit === proof.target_head) &&
                await secondaryImplementationMilestonesProven(
                  source,
                  settlement.secondary_milestones ?? [],
                  session.value.repository_set,
                );
            }
          }
        }
        const decodedTarget = decodePhaseInstance(call.input.phase_instance);
        const legacyJumpSignal =
          !planningRestartSignal &&
          artifact === undefined &&
          current.value.phase_instance === "design" &&
          current.value.step === "triage" &&
          current.value.status === "succeeded" &&
          (decodedTarget.kind === "phase-design" || decodedTarget.kind === "phase-impl") &&
          Number(decodedTarget.phase) >= 1;
        if (legacyJumpSignal) {
          const resolved = await findLegacyImportResumePhase(
            services.dependencies,
            services.authority,
            current.value,
          );
          if (!resolved.ok) return resolved;
          legacyResumePhase = resolved.value;
          if (legacyResumePhase !== undefined) {
            for (const approval of current.value.approvals) {
              if (
                approval.gate_kind !== "migration-audit" ||
                approval.subject_digest !== completionSubjectDigest
              ) continue;
              const loaded = await loadAuthenticatedGateApproval(
                services.dependencies,
                services.authority,
                approval,
              );
              if (!loaded.ok) return loaded;
              if (!authenticatedApprovalIsEligibleAfterLatestRestart(current.value, loaded.value)) continue;
              authenticatedGateApprovals.push(loaded.value);
              if (
                loaded.value.request.kind === "migration-audit" &&
                loaded.value.request.context.target_ref !== undefined &&
                loaded.value.request.context.baseline_commit !== undefined &&
                loaded.value.request.context.commit_message !== undefined &&
                currentProduce?.artifact.artifact_kind === "document"
              ) {
                commitObserved = (await designArtifactCommittedAtCurrentTarget(
                  services.runner,
                  current.value.task_id,
                  currentProduce.artifact,
                  currentProduce.retained.manifest.value.outputs,
                  {
                    target_ref: loaded.value.request.context.target_ref,
                    baseline_commit: loaded.value.request.context.baseline_commit,
                    commit_message: loaded.value.request.context.commit_message,
                    ...(loaded.value.request.context.imported_documents === undefined ? {} : {
                      authorized_document_paths: loaded.value.request.context.imported_documents.map((document) => document.path),
                    }),
                  },
                )).observed;
              }
            }
          }
        }
        // A consuming mutation independently closes the reconciliation race. The milestone
        // observations above are compatibility wrappers over the shared structured proof
        // resolver, so this preserves one proof interpretation without requiring a raw state-tool
        // caller to reproduce status's higher-level action projection.
        if (completionSignal || artifactPhaseExitSignal || legacyJumpSignal) {
          const discovered = await discoverReconciliationInput(
            services.dependencies, services.authority, current, session.value.repository_set,
          );
          if (!discovered.ok) return discovered;
          const reconciled = reconcileCurrentAuthority(discovered.value);
          if (reconciled.findings.length !== 0 || (discovered.value.blocking_reasons ?? []).length !== 0) {
            return fail(createProjectError("STATE_INVALID", {
              phase_instance: current.value.phase_instance,
              issue_code: "milestone-consumption-reconciliation-required",
            }));
          }
          if (commitObserved && artifactPhaseExitSignal && current.value.phase_instance === "design" &&
              authenticatedRuleAcceptance !== undefined && derivedPlannedFinalPhase === undefined) {
            const bound = await loadAutonomousDesignFinalPhase(
              services.dependencies, current.value, completionSubjectDigest!,
            );
            if (!bound.ok) return bound;
            derivedPlannedFinalPhase = bound.value;
          }
        }
        const transitionInput = {
          current: current.value,
          target: {
            phase_instance: call.input.phase_instance,
            step: call.input.step,
            status: call.input.status,
            // Mirrors `legalMovement`: a retry of a failed step and any re-opening of the
            // produce window from elsewhere in the phase both spend an attempt. The produce
            // door counts whatever the position it leaves — succeeded, failed, or a step
            // still running whose terminal result cannot be recorded.
            attempt: call.input.phase_instance !== current.value.phase_instance
              ? parseSafeInteger(1)
              : (current.value.status === "failed" && call.input.step === current.value.step) ||
                  (call.input.step === "produce" && (
                    current.value.step !== "produce" || current.value.status === "succeeded"
                  ))
                ? parseSafeInteger(current.value.attempt + 1)
                : current.value.attempt,
            input_fingerprint: call.input.input_fingerprint,
          },
          recomputed_input_fingerprint: call.input.input_fingerprint,
          ...(artifact === undefined ? {} : { artifact }),
          ...(preparedResult === undefined ? {} : { result_reference: preparedResult.reference }),
          ...(preparedResult === undefined ? {} : {
            resulting_subject_digest: preparedResult.prepared.manifest.value.artifact_digest,
          }),
          ...(completionSubjectDigest === undefined ? {} : { completion_subject_digest: completionSubjectDigest }),
          commit_observed: commitObserved,
          ...(legacyResumePhase === undefined ? {} : { legacy_resume_phase: legacyResumePhase }),
          ...(call.input.human_revision === undefined ? {} : { human_revision: call.input.human_revision }),
          ...(derivedPlannedFinalPhase === undefined ? {} : {
            derived_planned_final_phase: derivedPlannedFinalPhase,
          }),
          ...(authenticatedGateApprovals.length === 0 ? {} : {
            authenticated_gate_approvals: authenticatedGateApprovals,
          }),
          ...(authenticatedRuleAcceptance === undefined ? {} : {
            authenticated_rule_acceptance: authenticatedRuleAcceptance,
          }),
        } as const;
        let next = planStateTransition(transitionInput);
        if (!next.ok) return next;
        let ruleSettlement: RuleSettlementV1 | undefined;
        if (settlementEvidence !== undefined && settlementProduce !== undefined) {
          const configRead = await services.dependencies.read_config(services.authority.config);
          if (configRead.kind !== "valid") {
            return fail(createProjectError("CONFIG_INVALID", { issue_code: `config-${configRead.kind}` }));
          }
          const prospective = {
            ...next.value,
            revision,
          } as TaskStateV1;
          ruleSettlement = await settleApprovalRules(
            services, session.value.repository_set, current.value, prospective, settlementProduce, settlementEvidence, configRead.snapshot,
          );
          if (ruleSettlement !== undefined) {
            next = planStateTransition({
              ...transitionInput,
              rule_settlement: ruleSettlement,
            });
            if (!next.ok) return next;
          }
        }
        return Object.freeze({
          schema_version: "1",
          ok: true,
          value: Object.freeze({
            expectation,
            result,
            next_state: next.value,
            ...(installation === undefined ? {} : { result_installation: installation }),
          }),
        });
      },
    );
    return transaction.ok
      ? Object.freeze({ schema_version: "1", ok: true, value: transaction.value.outcome })
      : transaction;
  });
}

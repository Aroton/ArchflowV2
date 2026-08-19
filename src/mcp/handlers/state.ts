import type { InvocationContext } from "../../contracts/contexts.js";
import { createProjectError, type ProjectResult } from "../../contracts/errors.js";
import { canonicalJsonDigest, sha256Bytes } from "../../contracts/canonical.js";
import { parseSafeId, parseSafeInteger } from "../../contracts/evidence.js";
import {
  createInternalResultExpectation,
  validateProjectResultStructure,
  type ParsedToolCall,
  type ToolSuccess,
} from "../../contracts/mcp-tools.js";
import { parseTaskPathClaim } from "../../contracts/path-claims.js";
import { resolveTaskPath } from "../../repository/paths.js";
import { loadAuthenticatedGateApproval, type AuthenticatedGateApproval } from "../../state/gate-approvals.js";
import { findLegacyImportResumePhase } from "../../state/legacy-import-resume.js";
import {
  loadCurrentReviewSet,
  prepareEvidenceResult,
  validateEditorialPredecessorDeclaration,
  type EvidenceResultValue,
  type PreparedEvidenceResult,
} from "../../state/evidence-results.js";
import { runStateInitialization } from "../../state/initialization.js";
import { identifyTransactionRequest } from "../../state/request.js";
import { loadCurrentProduceSubject, type CurrentProduceSubject } from "../../state/produce-subject.js";
import { designArtifactCommittedAtCurrentTarget, implementationOutputCommittedAtCurrentTarget } from "../../state/implementation-manifest.js";
import { decodePhaseInstance } from "../../contracts/phase-instance.js";
import { exactCommitAuthorizationContext } from "../../contracts/durable-gate.js";
import type { PlanningRestartConnectedProvenance } from "../../contracts/durable-state.js";
import {
  prepareResultInstallation,
  runStateTransaction,
  type PreparedTransaction,
} from "../../state/transaction.js";
import { planStateTransition } from "../../state/transitions.js";
import { planPlanningRestart } from "../../state/transitions.js";
import { installPlanningRestartAskAppend, validatePlanningRestartAskAppend } from "../../state/phase-documents.js";
import { authenticatedApprovalIsEligibleAfterLatestRestart } from "../../state/restart-authority.js";
import { completedPlanningRestartMatches, planningRestartId } from "../../state/planning-restart.js";
import { derivedFinalPhaseBelowCurrentPhase, plannedFinalPhaseFromRecordedPayloads } from "../../state/planned-final-phase.js";
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

export async function handleState(
  call: Extract<ParsedToolCall, { name: "archflow_state" }>,
  context: InvocationContext,
): Promise<ProjectResult<ToolSuccess<"archflow_state">>> {
  return mapHandlerErrors<"archflow_state">(context.invocation_id, async () => {
    const session = await openHandlerSession(call, context);
    if (!session.ok) return session;
    const { services } = session.value;
    const restartInput = call.input.operation === "planning_restart" ? call.input : undefined;
    const artifact = restartInput === undefined ? call.input.artifact : undefined;
    if (services.state === undefined) {
      if (restartInput !== undefined) {
        return fail(createProjectError("STATE_MISSING", { phase_instance: restartInput.phase_instance }));
      }
      const initialized = await runStateInitialization(services.dependencies, {
        authority: services.authority,
        call,
      });
      return initialized.ok
        ? Object.freeze({ schema_version: "1", ok: true, value: initialized.value.outcome })
        : initialized;
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
      async (current, identifiedCall): Promise<ProjectResult<PreparedTransaction<"archflow_state">>> => {
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
          // A produce that records the task design document re-derives the planned final phase
          // from those exact bytes in this same transaction: the bound otherwise survives from
          // the design position's own approval and goes stale when later phase boundaries
          // revise the phase plan. A recorded design whose phase plan cannot be parsed fails
          // the produce closed instead of silently keeping the stale bound — but only while a
          // stored bound exists; a boundless task (fresh, legacy-imported, or restarted to the
          // design position) preserves the absent bound and the design-approval gate keeps
          // enforcing conformance at approval.
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
          const prepared = await prepareEvidenceResult({
            authority: services.authority,
            runner: services.runner,
            result_id: stateResultId(call.input.intent_id),
            retained_task_bytes: await retainedBytes(),
            measured_at_revision: current.value.revision,
            scanner,
            value,
          });
          if (!prepared.ok) return prepared;
          preparedResult = prepared.value;
        }
        const installation = preparedResult === undefined ? undefined : prepareResultInstallation({
          reference: preparedResult.reference,
          prepared: preparedResult.prepared,
          manifest_target: preparedResult.manifest_target,
          projection_plan: preparedResult.projection_plan,
          worktree_root: services.runner.location.worktreeRoot as typeof services.authority.task_root,
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
        let completionSubjectDigest;
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
        if (completionSignal || artifactPhaseExitSignal) {
          const loadedProduce = await loadCurrentProduceSubject(services.dependencies, current.value);
          if (!loadedProduce.ok) return loadedProduce;
          currentProduce = loadedProduce.value;
          completionSubjectDigest = currentProduce.artifact_digest;
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
          const source = currentProduce.artifact;
          if (source.artifact_kind === "implementation-output") {
            for (const authenticated of authenticatedGateApprovals) {
              if (authenticated.request.kind !== "commit-authorization") continue;
              // Pre-exact-commit archives bound no baseline, message or path set to compare.
              const exact = exactCommitAuthorizationContext(authenticated.request.context);
              if (exact === undefined) continue;
              if (await implementationOutputCommittedAtCurrentTarget(
                services.runner,
                source,
                exact,
              )) {
                commitObserved = true;
                break;
              }
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
        const next = planStateTransition({
          current: current.value,
          target: {
            phase_instance: call.input.phase_instance,
            step: call.input.step,
            status: call.input.status,
            attempt: call.input.phase_instance !== current.value.phase_instance
              ? parseSafeInteger(1)
              : (current.value.status === "failed" && call.input.step === current.value.step) ||
                  (current.value.status === "succeeded" && call.input.step === "produce")
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
        });
        if (!next.ok) return next;
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

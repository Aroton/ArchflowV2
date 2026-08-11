import type { InvocationContext } from "../../contracts/contexts.js";
import { createProjectError, type ProjectResult } from "../../contracts/errors.js";
import { sha256Bytes } from "../../contracts/canonical.js";
import { parseSafeId, parseSafeInteger } from "../../contracts/evidence.js";
import {
  createInternalResultExpectation,
  validateProjectResultStructure,
  type ParsedToolCall,
  type ToolSuccess,
} from "../../contracts/mcp-tools.js";
import { parseTaskPathClaim } from "../../contracts/path-claims.js";
import { planCheckpointAdoption } from "../../state/checkpoints.js";
import {
  findLegacyImportResumePhase,
  loadAuthenticatedGateApproval,
  type AuthenticatedGateApproval,
} from "../../state/gates.js";
import {
  loadCurrentReviewSet,
  prepareEvidenceResult,
  validateEditorialPredecessorDeclaration,
  type EvidenceResultValue,
  type PreparedEvidenceResult,
} from "../../state/evidence-results.js";
import { runStateInitialization } from "../../state/initialization.js";
import {
  loadManualImportEvidence,
  type AuthenticatedManualImportEvidence,
} from "../../state/manual-import.js";
import { identifyTransactionRequest } from "../../state/request.js";
import { loadCurrentProduceSubject } from "../../state/produce-subject.js";
import { implementationOutputCommittedAtCurrentTarget } from "../../state/implementation-manifest.js";
import { decodePhaseInstance } from "../../contracts/phase-instance.js";
import {
  prepareResultInstallation,
  runStateTransaction,
  type PreparedTransaction,
} from "../../state/transaction.js";
import { planStateTransition } from "../../state/transitions.js";
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

export async function handleState(
  call: Extract<ParsedToolCall, { name: "archflow_state" }>,
  context: InvocationContext,
): Promise<ProjectResult<ToolSuccess<"archflow_state">>> {
  return mapHandlerErrors<"archflow_state">(context.invocation_id, async () => {
    const session = await openHandlerSession(call, context);
    if (!session.ok) return session;
    const { services } = session.value;
    const artifact = call.input.artifact;
    let manualEvidence: AuthenticatedManualImportEvidence | undefined;
    if (artifact?.artifact_kind === "manual-checkpoint-import") {
      const loaded = await loadManualImportEvidence({
        dependencies: services.dependencies,
        authority: services.authority,
        artifact,
      });
      if (!loaded.ok) return loaded;
      manualEvidence = loaded.value;
    }
    if (services.state === undefined) {
      const initialized = await runStateInitialization(services.dependencies, {
        authority: services.authority,
        call,
      }, manualEvidence);
      return initialized.ok
        ? Object.freeze({ schema_version: "1", ok: true, value: initialized.value.outcome })
        : initialized;
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
        let preparedResult: PreparedStateResult | PreparedEvidenceResult | undefined;
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
        }
        if (artifact?.artifact_kind === "triage") {
          const loadRetained = services.dependencies.load_retained_result;
          if (retainedBytes === undefined || scanner === undefined || loadRetained === undefined) {
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
            { read_state: services.dependencies.read_state, load_retained_result: loadRetained },
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
        if (artifact?.artifact_kind === "manual-checkpoint-import") {
          if (manualEvidence === undefined) throw new TypeError("manual import evidence was not loaded");
          return planCheckpointAdoption({ current, call: identifiedCall, expectation, result, evidence: manualEvidence });
        }
        let completionSubjectDigest;
        let commitObserved = false;
        let legacyResumePhase;
        const authenticatedGateApprovals: AuthenticatedGateApproval[] = [];
        const completionSignal =
          artifact === undefined &&
          decodePhaseInstance(current.value.phase_instance).kind === "phase-impl" &&
          current.value.step === "triage" &&
          current.value.status === "succeeded";
        if (completionSignal) {
          const reference = current.value.authoritative_results.find((entry) =>
            entry.phase_instance === current.value.phase_instance && entry.step === "produce");
          const loader = services.dependencies.load_retained_result;
          if (reference !== undefined && loader !== undefined) {
            const retained = await loader(reference);
            if (!retained.ok) return retained;
            completionSubjectDigest = retained.value.prepared.manifest.value.artifact_digest;
            for (const approval of current.value.approvals) {
              if (approval.gate_kind !== "commit-authorization" || approval.subject_digest !== completionSubjectDigest) continue;
              const loaded = await loadAuthenticatedGateApproval(
                services.dependencies, services.authority, approval,
              );
              if (!loaded.ok) return loaded;
              authenticatedGateApprovals.push(loaded.value);
            }
            const source = retained.value.prepared.manifest.value.source_artifact;
            if (source.artifact_kind === "implementation-output") {
              for (const authenticated of authenticatedGateApprovals) {
                if (authenticated.request.kind !== "commit-authorization") continue;
                if (await implementationOutputCommittedAtCurrentTarget(
                  services.runner,
                  source,
                  authenticated.request.context.target_ref,
                )) {
                  commitObserved = true;
                  break;
                }
              }
            }
          }
        }
        const decodedTarget = decodePhaseInstance(call.input.phase_instance);
        const legacyJumpSignal =
          artifact === undefined &&
          current.value.phase_instance === "design" &&
          current.value.step === "triage" &&
          current.value.status === "succeeded" &&
          decodedTarget.kind === "phase-design" &&
          Number(decodedTarget.phase) > 1;
        if (legacyJumpSignal) {
          const resolved = await findLegacyImportResumePhase(
            services.dependencies,
            services.authority,
            current.value,
          );
          if (!resolved.ok) return resolved;
          legacyResumePhase = resolved.value;
          if (legacyResumePhase !== undefined) {
            const produce = await loadCurrentProduceSubject(services.dependencies, current.value);
            if (!produce.ok) return produce;
            for (const approval of current.value.approvals) {
              if (
                approval.gate_kind !== "migration-audit" ||
                approval.subject_digest !== produce.value.artifact_digest
              ) continue;
              const loaded = await loadAuthenticatedGateApproval(
                services.dependencies,
                services.authority,
                approval,
              );
              if (!loaded.ok) return loaded;
              authenticatedGateApprovals.push(loaded.value);
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
          ...(completionSubjectDigest === undefined ? {} : { completion_subject_digest: completionSubjectDigest }),
          commit_observed: commitObserved,
          ...(legacyResumePhase === undefined ? {} : { legacy_resume_phase: legacyResumePhase }),
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

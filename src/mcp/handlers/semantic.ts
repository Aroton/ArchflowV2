import { parseCanonicalDocument } from "../../contracts/canonical.js";
import type { InvocationContext } from "../../contracts/contexts.js";
import { createProjectError, type ProjectError, type ProjectResult } from "../../contracts/errors.js";
import { parseSafeCode } from "../../contracts/evidence.js";
import { parseArchivedGateRequest, type WaiverGateContext } from "../../contracts/durable-gate.js";
import { parseToolCall, type ParsedToolCall } from "../../contracts/mcp-tools.js";
import {
  parseSemanticResultV1,
  type ArchFlowApplyInputV1,
  type ArchFlowStatusInputV1,
  type SemanticResultV1,
  type SemanticStatusSnapshotV1,
  type WorkflowInvocationV1,
  type WorkflowViewV1,
} from "../../contracts/semantic-workflow.js";
import { gateRequestClaim, openResolved, resolveTaskPath } from "../../repository/paths.js";
import { resolveRepositorySet } from "../../repository/repository-set.js";
import { validateRepositorySetContinuity } from "../../state/config-change.js";
import {
  archiveDirectSemanticGateDecision,
  enterDirectSemanticRevisionCheckpoint,
  openDurableGate,
  settleDirectSemanticGateDecision,
} from "../../state/gates.js";
import { createProductionServices, type ProductionServices } from "../../state/production.js";
import { identifyTransactionRequest } from "../../state/request.js";
import { composeRequest } from "../../state/request-composition.js";
import {
  executeSemanticAction,
  SemanticActionExecutionError,
  SemanticActionPlanError,
  type SemanticActionExecutorCapabilities,
  type SemanticActionPlanV1,
} from "../../state/semantic-actions.js";
import { computeAuthoritativeSemanticStatus } from "../../state/semantic-status.js";
import { projectSemanticStatus } from "../../state/semantic-view.js";
import { handleCounterReview } from "./counter-review.js";
import { handleState } from "./state.js";

type LiveSemanticSession = Readonly<{
  services: ProductionServices;
  snapshot: SemanticStatusSnapshotV1;
}>;

const success = (view: WorkflowViewV1): SemanticResultV1 => parseSemanticResultV1({
  schema_version: "1", ok: true, value: view,
});

function retryable(error: ProjectError): boolean {
  return error.code === "IO_ERROR" || error.code === "CANCELLED";
}

function failure(code: string, message: string, view?: WorkflowViewV1, canRetry = false): SemanticResultV1 {
  return parseSemanticResultV1({
    schema_version: "1", ok: false,
    error: { code, message, retryable: canRetry },
    ...(view === undefined ? {} : { view }),
  });
}

async function openSemanticSession(
  taskId: string,
  context: InvocationContext,
  operation: string,
): Promise<ProjectResult<LiveSemanticSession>> {
  const created = await createProductionServices({
    working_directory: context.connection.startup_repository_candidate.working_directory,
    task_id: taskId as never,
    operation: parseSafeCode(operation),
  });
  if (!created.ok) return created;
  let services = created.value;
  const config = await services.dependencies.read_config(services.authority.config);
  if (config.kind === "valid") {
    const repositorySet = await resolveRepositorySet(
      { runner: services.runner, environment: services.environment },
      config.snapshot.parsed,
      services.authority.context,
    );
    if (!repositorySet.ok) return repositorySet;
    if (services.state !== undefined) {
      const continuity = validateRepositorySetContinuity(services.state.value, repositorySet.value);
      if (!continuity.ok) return continuity;
    }
    services = Object.freeze({ ...services, repository_set: repositorySet.value });
  }
  const snapshot = await computeAuthoritativeSemanticStatus(services.dependencies, services.authority);
  return snapshot.ok
    ? Object.freeze({ schema_version: "1", ok: true, value: Object.freeze({ services, snapshot: snapshot.value }) })
    : snapshot;
}

function safeView(session: LiveSemanticSession, invocation?: WorkflowInvocationV1): WorkflowViewV1 {
  return projectSemanticStatus(session.snapshot, invocation).view;
}

async function freshSafeView(
  taskId: string,
  context: InvocationContext,
  invocation?: WorkflowInvocationV1,
): Promise<WorkflowViewV1 | undefined> {
  const refreshed = await openSemanticSession(taskId, context, "semantic-failure-refresh");
  return refreshed.ok ? safeView(refreshed.value, invocation) : undefined;
}

function requireProducingHost(invocation: WorkflowInvocationV1 | undefined, context: InvocationContext): SemanticResultV1 | undefined {
  if (invocation !== undefined && context.connection.initialization_candidates.host === "unknown") {
    return failure("UNSUPPORTED_HOST", "A producing semantic invocation requires an authenticated Claude or Codex host.");
  }
  return undefined;
}

/** Mechanically read-only semantic status. */
export async function handleSemanticStatus(
  input: ArchFlowStatusInputV1,
  context: InvocationContext,
): Promise<SemanticResultV1> {
  const unsupported = requireProducingHost(input.invocation, context);
  if (unsupported !== undefined) return unsupported;
  const session = await openSemanticSession(input.task_id, context, "archflow-status");
  if (!session.ok) return failure(session.error.code, session.error.code, undefined, retryable(session.error));
  return success(safeView(session.value, input.invocation));
}

async function openComposedGate(
  call: Extract<ParsedToolCall, { name: "archflow_gate" }>,
  services: ProductionServices,
) {
  const identified = identifyTransactionRequest(call, services.authority, call.input.input_fingerprint);
  return openDurableGate(services.dependencies, {
    authority: services.authority,
    expected_revision: call.input.expected_revision,
    intent_id: call.input.intent_id,
    request_digest: identified.request_digest,
    input_fingerprint: call.input.input_fingerprint,
    phase_instance: call.input.phase_instance,
    summary: call.input.summary,
    subject_digest: call.input.subject_digest,
    current_evidence: call.input.current_evidence,
    kind: call.input.kind,
    context: call.input.context,
  });
}

async function openComposedWaiver(
  call: Extract<ParsedToolCall, { name: "archflow_waiver" }>,
  services: ProductionServices,
) {
  const target = await resolveTaskPath({
    runner: services.runner,
    taskId: services.authority.task_id,
    claim: gateRequestClaim(call.input.origin.origin_gate_id),
    expectedClass: "authority-decision",
    context: services.authority.context,
  });
  if (!target.ok) return target;
  let request;
  try {
    const handle = await openResolved(target.value.absolute, 0);
    const parsed = parseCanonicalDocument(
      new Uint8Array(await handle.readFile().finally(() => handle.close())),
      "waiver origin gate request",
    );
    request = Object.freeze({ ...parsed, value: parseArchivedGateRequest(parsed.value) });
  } catch {
    return Object.freeze({ schema_version: "1", ok: false, error: createProjectError("CONTRACT_INVALID", {
      issue_code: "waiver-origin-request-invalid",
    }) } as const);
  }
  const identified = identifyTransactionRequest(call, services.authority, call.input.input_fingerprint);
  const waiverContext: WaiverGateContext = Object.freeze({ origin: call.input.origin, rationale: call.input.rationale });
  return openDurableGate(services.dependencies, {
    authority: services.authority,
    expected_revision: call.input.expected_revision,
    intent_id: call.input.intent_id,
    request_digest: identified.request_digest,
    input_fingerprint: call.input.input_fingerprint,
    phase_instance: call.input.origin.phase_instance,
    summary: `Waiver request for ${call.input.origin.rule.rule_id}`,
    subject_digest: call.input.origin.subject_digest,
    current_evidence: request.value.current_evidence,
    kind: "constitution-review",
    context: waiverContext,
    waiver_origin_gate_id: call.input.origin.origin_gate_id,
  });
}

function capabilities(
  initial: LiveSemanticSession,
  input: ArchFlowApplyInputV1,
  context: InvocationContext,
): SemanticActionExecutorCapabilities {
  let live = initial;
  const refresh = async () => {
    const reopened = await openSemanticSession(input.task_id, context, "semantic-action-refresh");
    if (!reopened.ok) throw new SemanticActionExecutionError(reopened as never);
    live = reopened.value;
    return live;
  };
  return Object.freeze({
    refresh_services: refresh,
    execute_composed_request: async (composed) => {
      const call = parseToolCall(composed.envelope.tool, composed.envelope.request.input);
      switch (call.name) {
        case "archflow_state": return handleState(call, context);
        case "archflow_gate": return openComposedGate(call, live.services);
        case "archflow_waiver": return openComposedWaiver(call, live.services);
        case "archflow_counter_review":
          throw new SemanticActionPlanError("SEMANTIC_ACTION_UNSUPPORTED", "counter review must use the direct inner review seam");
      }
    },
    run_counter_review: async (plan: SemanticActionPlanV1) => {
      if (plan.request_facts === undefined) throw new TypeError("review plan has no request facts");
      const composed = await composeRequest(live.services, plan.request_facts);
      if (!composed.ok) return composed;
      const call = parseToolCall("archflow_counter_review", composed.value.envelope.request.input);
      return handleCounterReview(call, context, true);
    },
    archive_decision: (plan: SemanticActionPlanV1) => {
      if (plan.decision_submission === undefined) throw new TypeError("decision archive plan lost its human submission");
      return archiveDirectSemanticGateDecision(live.services.dependencies, {
        authority: live.services.authority,
        operation_digest: plan.operation_digest,
        intent_id: plan.intent_id,
        choice: plan.decision_submission.choice,
        reason: plan.decision_submission.reason,
        ...(plan.decision_submission.option_rationale === undefined ? {} : { option_rationale: plan.decision_submission.option_rationale }),
        invocation_context: context,
      });
    },
    settle_decision: (plan: SemanticActionPlanV1) => settleDirectSemanticGateDecision(live.services.dependencies, {
      authority: live.services.authority, operation_digest: plan.operation_digest, intent_id: plan.intent_id,
    }),
    enter_revision_checkpoint: (plan: SemanticActionPlanV1) => enterDirectSemanticRevisionCheckpoint(live.services.dependencies, {
      authority: live.services.authority, operation_digest: plan.operation_digest, intent_id: plan.intent_id,
    }),
  });
}

/** Applies one authenticated workflow offer and returns at the next actor boundary. */
export async function handleSemanticApply(
  input: ArchFlowApplyInputV1,
  context: InvocationContext,
): Promise<SemanticResultV1> {
  const unsupported = requireProducingHost(input.invocation, context);
  if (unsupported !== undefined) return unsupported;
  const session = await openSemanticSession(input.task_id, context, "archflow-apply");
  if (!session.ok) return failure(session.error.code, session.error.code, undefined, retryable(session.error));
  try {
    return success(await executeSemanticAction(
      session.value.services, session.value.snapshot, input, capabilities(session.value, input, context),
    ));
  } catch (error) {
    const view = await freshSafeView(input.task_id, context, input.invocation);
    if (error instanceof SemanticActionExecutionError) {
      return failure(error.result.error.code, error.message, view, retryable(error.result.error));
    }
    if (error instanceof SemanticActionPlanError) return failure(error.code, error.message, view);
    throw error;
  }
}

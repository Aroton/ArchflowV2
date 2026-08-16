import { canonicalJsonDigest } from "../contracts/canonical.js";
import type { TaskStateV1 } from "../contracts/durable-state.js";
import { parsePathSafeId, type PathSafeId, type Sha256Digest } from "../contracts/evidence.js";
import type { PlainJsonValue } from "../contracts/plain-json.js";
import {
  parseArchFlowApplyInputV1,
  SEMANTIC_SUBSTEPS,
  type ApplySubmissionKindV1,
  type ApplySubmissionV1,
  type ArchFlowApplyInputV1,
  type SemanticActionKindV1,
  type SemanticOperationKeyV1,
  type SemanticStatusSnapshotV1,
  type SemanticSubstepV1,
  type WorkflowInvocationV1,
  type WorkflowViewV1,
} from "../contracts/semantic-workflow.js";
import type { ToolName } from "../contracts/tool-names.js";
import type { ProjectResult } from "../contracts/errors.js";
import type { ProductionServices } from "./production.js";
import { composeRequest, type ComposedRequest } from "./request-composition.js";
import { projectSemanticStatus, semanticOfferToken } from "./semantic-view.js";
import { stageTaskAsk, type StageTaskAskInput } from "../init/task-initialization.js";
import { serializeDispatch } from "../dispatch/cli.js";

const OFFER = /^af1_([0-9a-f]{64})$/u;
const INTENT = /^afop-([0-9a-f]{64})-([a-z][a-z0-9]*(?:-[a-z0-9]+)*)$/u;

export class SemanticActionPlanError extends TypeError {
  public constructor(
    public readonly code:
      | "SEMANTIC_OFFER_STALE"
      | "SEMANTIC_SUBMISSION_MISMATCH"
      | "SEMANTIC_ACTION_UNSUPPORTED"
      | "SEMANTIC_DECISION_DEFERRED"
      | "SEMANTIC_REPLAY_MISMATCH",
    message: string,
  ) {
    super(message);
    this.name = "SemanticActionPlanError";
  }
}

export type SemanticExecutionKind = "compose-request" | "counter-review-handler" | "deferred";
export type SemanticActionPlanV1 = Readonly<{
  action_kind: SemanticActionKindV1;
  /** Present on the starting offer; a fresh continuation recovers the authenticated digest instead. */
  operation_key?: SemanticOperationKeyV1;
  operation_digest: Sha256Digest;
  invocation: WorkflowInvocationV1;
  substeps: readonly SemanticSubstepV1[];
  next_substep: SemanticSubstepV1;
  intent_id: PathSafeId;
  execution: SemanticExecutionKind;
  request_facts?: PlainJsonValue;
  task_ask?: string;
  reopening_request?: string;
  deferred_reason?: string;
  revision_checkpoint?: true;
}>;

type SemanticTransitionExpectation = Readonly<{
  tool: ToolName;
  operation: string;
  input_fingerprint: Sha256Digest;
  request_digest?: Sha256Digest;
}>;

const submissionKind = (submission: ApplySubmissionV1 | undefined): ApplySubmissionKindV1 =>
  submission?.kind ?? "none";

function expectedSubmissionMessage(expected: ApplySubmissionKindV1, actual: ApplySubmissionKindV1): string {
  return `semantic action expects ${expected} submission, received ${actual}`;
}

function assertSubmissionMatches(expected: ApplySubmissionKindV1, submission: ApplySubmissionV1 | undefined): void {
  const actual = submissionKind(submission);
  if (expected === "none" ? submission !== undefined : actual !== expected) {
    throw new SemanticActionPlanError("SEMANTIC_SUBMISSION_MISMATCH", expectedSubmissionMessage(expected, actual));
  }
}

function operationKey(
  offerToken: string,
  offer: NonNullable<ReturnType<typeof projectSemanticStatus>["internal_offer"]>,
  submission: ApplySubmissionV1 | undefined,
): SemanticOperationKeyV1 {
  const match = OFFER.exec(offerToken);
  if (match === null) throw new SemanticActionPlanError("SEMANTIC_OFFER_STALE", "semantic offer token is malformed");
  const submissionDigest = canonicalJsonDigest({
    schema_version: "1",
    digest_kind: "semantic-submission",
    submission: submission ?? { kind: "none" },
  } as PlainJsonValue);
  return Object.freeze({
    schema_version: "1",
    offer_digest: match[1] as Sha256Digest,
    repository_identity_digest: offer.repository_identity_digest,
    task_id: offer.task_id,
    invocation: offer.invocation,
    action_kind: offer.action_kind,
    ...(offer.phase_instance === undefined ? {} : { phase_instance: offer.phase_instance }),
    ...(offer.attempt === undefined ? {} : { attempt: offer.attempt }),
    ...(offer.subject_digest === undefined ? {} : { subject_digest: offer.subject_digest }),
    submission_digest: submissionDigest,
  });
}

export function semanticOperationDigest(key: SemanticOperationKeyV1): Sha256Digest {
  return canonicalJsonDigest({
    schema_version: "1",
    digest_kind: "semantic-operation",
    key,
  } as PlainJsonValue);
}

export function semanticSubstepIntentId(digest: Sha256Digest, substep: SemanticSubstepV1): PathSafeId {
  if (!(SEMANTIC_SUBSTEPS as readonly string[]).includes(substep)) throw new TypeError("unknown semantic substep");
  return parsePathSafeId(`afop-${digest}-${substep}`);
}

export function parseSemanticSubstepIntentId(value: unknown): Readonly<{ operation_digest: Sha256Digest; substep: SemanticSubstepV1 }> {
  const parsed = parsePathSafeId(value);
  const match = INTENT.exec(parsed);
  if (match === null || !(SEMANTIC_SUBSTEPS as readonly string[]).includes(match[2]!)) {
    throw new TypeError("semantic intent id must bind a closed named substep");
  }
  return Object.freeze({ operation_digest: match[1] as Sha256Digest, substep: match[2] as SemanticSubstepV1 });
}

/**
 * A semantic-looking prefix is never replay authority by itself. This predicate also requires the
 * exact durable tool operation, fingerprint, and (when known) request digest.
 */
export function authenticateSemanticLastTransition(
  state: TaskStateV1,
  operationDigest: Sha256Digest,
  substep: SemanticSubstepV1,
  expected: SemanticTransitionExpectation,
): boolean {
  const transition = state.last_transition;
  if (transition === undefined) return false;
  let parsed: ReturnType<typeof parseSemanticSubstepIntentId>;
  try {
    parsed = parseSemanticSubstepIntentId(transition.intent_id);
  } catch {
    return false;
  }
  return parsed.operation_digest === operationDigest && parsed.substep === substep &&
    transition.tool === expected.tool && transition.operation === expected.operation &&
    transition.input_fingerprint === expected.input_fingerprint &&
    (expected.request_digest === undefined || transition.request_digest === expected.request_digest);
}

function authenticatedSemanticReviewContinuation(state: TaskStateV1, expectedSubstep: "review-enter" | "review-run"): Sha256Digest | undefined {
  const transition = state.last_transition;
  if (transition === undefined || !transition.intent_id.startsWith("afop-")) return undefined; // pre-facade authority
  let identity: ReturnType<typeof parseSemanticSubstepIntentId>;
  try {
    identity = parseSemanticSubstepIntentId(transition.intent_id);
  } catch {
    throw new SemanticActionPlanError("SEMANTIC_REPLAY_MISMATCH", "semantic-looking review transition has an invalid intent identity");
  }
  const expected = expectedSubstep === "review-enter"
    ? { tool: "archflow_state" as const, operation: "record-state-boundary" }
    : { tool: "archflow_counter_review" as const, operation: "counter-review" };
  if (!authenticateSemanticLastTransition(state, identity.operation_digest, expectedSubstep, {
    ...expected,
    input_fingerprint: state.input_fingerprint,
  })) {
    throw new SemanticActionPlanError("SEMANTIC_REPLAY_MISMATCH", `review continuation does not authenticate ${expectedSubstep}`);
  }
  return identity.operation_digest;
}

function reviewSubsteps(snapshot: SemanticStatusSnapshotV1): readonly SemanticSubstepV1[] {
  const state = snapshot.state;
  if (state === undefined) throw new SemanticActionPlanError("SEMANTIC_ACTION_UNSUPPORTED", "review requires active durable state");
  if (state.step === "counter_review" && state.status === "running") {
    authenticatedSemanticReviewContinuation(state, "review-enter");
    return Object.freeze(["review-run"]);
  }
  if (state.step === "counter_review" && state.status === "succeeded" && snapshot.full_findings.length === 0) {
    authenticatedSemanticReviewContinuation(state, "review-run");
    return Object.freeze(["review-empty-triage"]);
  }
  return Object.freeze(["review-enter", "review-run", "review-empty-triage"]);
}

function fixedSubsteps(
  action: SemanticActionKindV1,
  snapshot: SemanticStatusSnapshotV1,
  expectedSubmission: ApplySubmissionKindV1,
): readonly SemanticSubstepV1[] {
  switch (action) {
    case "initialize-task": return Object.freeze(["initialize-task"]);
    case "begin-work": return Object.freeze(["begin-work"]);
    case "submit-work": return Object.freeze(["submit-work"]);
    case "review": return reviewSubsteps(snapshot);
    case "triage": return Object.freeze(["triage"]);
    case "revise": return Object.freeze(["revise-enter"]);
    case "reopen": return Object.freeze(["reopen"]);
    case "open-waiver": return Object.freeze(["open-waiver"]);
    case "decide": return expectedSubmission === "gate-summary"
      ? Object.freeze(["open-gate"])
      : expectedSubmission === "decision"
        ? Object.freeze(["decision-archive", "decision-settle"])
        : Object.freeze(["decision-settle"]);
    case "start-next-skill": return Object.freeze(["start-next-skill"]);
    case "finish-task": return Object.freeze(["finish-task"]);
    case "commit":
    case "inspect":
    case "none":
      throw new SemanticActionPlanError("SEMANTIC_ACTION_UNSUPPORTED", `${action} has no semantic mutation plan`);
  }
}

function requestFacts(
  action: SemanticActionKindV1,
  substep: SemanticSubstepV1,
  intentId: PathSafeId,
  submission: ApplySubmissionV1 | undefined,
): Readonly<{ execution: SemanticExecutionKind; facts?: PlainJsonValue; reason?: string }> {
  switch (action) {
    case "initialize-task":
      if (submission?.kind !== "task-ask") throw new TypeError("validated task ask is unavailable");
      return { execution: "compose-request", facts: { kind: "initialize", intent_id: intentId } };
    case "begin-work":
    case "revise":
      return { execution: "compose-request", facts: { kind: "running", step: "produce", intent_id: intentId } };
    case "submit-work": {
      if (submission?.kind !== "work-result") throw new TypeError("validated work result is unavailable");
      if (submission.outcome === "failed") return {
        execution: "compose-request",
        facts: { kind: "failed", intent_id: intentId },
      };
      return { execution: "compose-request", facts: {
        kind: "produce",
        intent_id: intentId,
        ...(submission.implementation === undefined ? {} : { implementation: submission.implementation }),
        ...(submission.human_revision === undefined ? {} : { human_revision: submission.human_revision }),
      } };
    }
    case "review":
      if (substep === "review-enter") return { execution: "compose-request", facts: { kind: "running", step: "counter_review", intent_id: intentId } };
      if (substep === "review-run") return { execution: "counter-review-handler", facts: { kind: "counter-review", intent_id: intentId } };
      return { execution: "compose-request", facts: { kind: "triage", intent_id: intentId, dispositions: [] } };
    case "triage":
      if (submission?.kind !== "triage") throw new TypeError("validated triage is unavailable");
      return { execution: "compose-request", facts: { kind: "triage", intent_id: intentId, dispositions: submission.dispositions } };
    case "reopen":
      return { execution: "compose-request" };
    case "decide":
      if (submission?.kind === "decision") return { execution: "deferred", reason: "decision archive and settlement execution is deferred until the nonblocking decision service is extracted in Phase 2" };
      if (submission === undefined) return { execution: "deferred", reason: "decision settlement is deferred until the nonblocking decision service is extracted in Phase 2" };
      if (submission.kind !== "gate-summary") throw new TypeError("validated gate summary is unavailable");
      return { execution: "compose-request", facts: { kind: "gate", intent_id: intentId, summary: submission.summary } };
    case "open-waiver":
      return { execution: "compose-request", facts: { kind: "waiver", intent_id: intentId } };
    case "start-next-skill":
    case "finish-task":
      return { execution: "compose-request", facts: { kind: "advance", intent_id: intentId } };
    case "commit":
    case "inspect":
    case "none":
      throw new SemanticActionPlanError("SEMANTIC_ACTION_UNSUPPORTED", `${action} has no semantic request facts`);
  }
}

/** Recomputes the current offer and plans exactly its first unfinished named substep. */
export function planSemanticAction(
  snapshot: SemanticStatusSnapshotV1,
  value: unknown,
): SemanticActionPlanV1 {
  const input = parseArchFlowApplyInputV1(value) as ArchFlowApplyInputV1;
  const projection = projectSemanticStatus(snapshot, input.invocation);
  const offer = projection.internal_offer;
  if (offer === undefined) {
    throw new SemanticActionPlanError("SEMANTIC_OFFER_STALE", "authenticated current action has no mutation offer for this invocation");
  }
  const expectedToken = semanticOfferToken(offer);
  assertSubmissionMatches(offer.expected_submission, input.action.submission);
  const key = operationKey(input.action.offer, offer, input.action.submission);
  const candidateOperationDigest = semanticOperationDigest(key);
  let operationDigest = candidateOperationDigest;
  const substeps = fixedSubsteps(offer.action_kind, snapshot, offer.expected_submission);
  const nextSubstep = substeps[0]!;
  let recoveredOperationDigest: Sha256Digest | undefined;
  if (offer.action_kind === "review" && snapshot.state !== undefined) {
    const predecessor = nextSubstep === "review-run"
      ? "review-enter"
      : nextSubstep === "review-empty-triage" ? "review-run" : undefined;
    if (predecessor !== undefined) {
      const recovered = authenticatedSemanticReviewContinuation(snapshot.state, predecessor);
      if (recovered !== undefined) {
        operationDigest = recovered;
        recoveredOperationDigest = recovered;
      }
    }
  }
  const currentOfferMatches = input.action.offer === expectedToken && projection.view.next_action.offer === expectedToken;
  const authenticatedOldReviewRetry = offer.action_kind === "review" &&
    recoveredOperationDigest !== undefined && candidateOperationDigest === recoveredOperationDigest;
  if (!currentOfferMatches && !authenticatedOldReviewRetry) {
    throw new SemanticActionPlanError("SEMANTIC_OFFER_STALE", "semantic offer is stale or does not match the authenticated current action and invocation");
  }
  const intentId = semanticSubstepIntentId(operationDigest, nextSubstep);
  const request = requestFacts(offer.action_kind, nextSubstep, intentId, input.action.submission);
  const requestFactsValue = offer.action_kind === "reopen"
    ? {
        kind: "planning-restart",
        intent_id: intentId,
        invocation: key.invocation,
        reason: input.action.submission?.kind === "reopening-request"
          ? input.action.submission.request
          : "",
      } as const
    : request.facts;
  const execution = offer.action_kind === "reopen" ? "compose-request" as const : request.execution;
  return Object.freeze({
    action_kind: offer.action_kind,
    ...(candidateOperationDigest === operationDigest ? { operation_key: key } : {}),
    operation_digest: operationDigest,
    invocation: input.invocation,
    substeps,
    next_substep: nextSubstep,
    intent_id: intentId,
    execution,
    ...(requestFactsValue === undefined ? {} : { request_facts: requestFactsValue }),
    ...(input.action.submission?.kind !== "task-ask" ? {} : { task_ask: input.action.submission.text }),
    ...(input.action.submission?.kind !== "reopening-request" ? {} : { reopening_request: input.action.submission.request }),
    ...(request.reason === undefined ? {} : { deferred_reason: request.reason }),
  });
}

export type SemanticActionExecutorCapabilities = Readonly<{
  compose_request?: typeof composeRequest;
  execute_composed_request?: (
    composed: ComposedRequest,
    plan: SemanticActionPlanV1,
  ) => Promise<unknown>;
  stage_task_ask?: (input: StageTaskAskInput) => ReturnType<typeof stageTaskAsk>;
  /** Direct non-queued review handler service; the semantic action owns the outer FIFO. */
  run_counter_review?: (plan: SemanticActionPlanV1) => Promise<unknown>;
  /** Recomputes one authenticated semantic snapshot after a completed durable substep. */
  refresh_snapshot?: () => Promise<SemanticStatusSnapshotV1>;
  /** Authenticates and consumes the Phase 2 close-only revision checkpoint. */
  enter_revision_checkpoint?: (plan: SemanticActionPlanV1) => Promise<unknown>;
}>;

export type SemanticSubstepExecutionResult = Readonly<{
  substep: SemanticSubstepV1;
  intent_id: PathSafeId;
  outcome: unknown;
}>;

/**
 * Executes exactly `plan.next_substep` once and returns. Capabilities are explicit so this seam
 * cannot dispatch a producer, run verification/Git, recurse into apply, or consume a later offer.
 */
export async function executeSemanticActionSubstep(
  services: ProductionServices,
  plan: SemanticActionPlanV1,
  capabilities: SemanticActionExecutorCapabilities = {},
): Promise<SemanticSubstepExecutionResult> {
  let outcome: unknown;
  const checkpointStatus = plan.action_kind === "revise" && plan.next_substep === "revise-enter"
    ? plan.revision_checkpoint
    : false;
  if (checkpointStatus === true) {
    if (capabilities.enter_revision_checkpoint === undefined) {
      throw new SemanticActionPlanError("SEMANTIC_ACTION_UNSUPPORTED", "closed revision-checkpoint consumption requires the authenticated revision-entry capability");
    }
    outcome = await capabilities.enter_revision_checkpoint(plan);
    return Object.freeze({ substep: plan.next_substep, intent_id: plan.intent_id, outcome });
  }
  switch (plan.execution) {
    case "compose-request": {
      if (plan.action_kind === "initialize-task") {
        if (plan.task_ask === undefined) throw new TypeError("initialize-task plan is missing the exact task ask");
        const stage = capabilities.stage_task_ask ?? stageTaskAsk;
        const staged = await stage({
          working_directory: services.runner.location.worktreeRoot,
          task_id: services.authority.task_id,
          text: plan.task_ask,
        });
        if (!staged.ok) {
          outcome = staged;
          break;
        }
      }
      if (plan.request_facts === undefined) throw new TypeError("semantic request plan has no request facts");
      const composed = await (capabilities.compose_request ?? composeRequest)(services, plan.request_facts);
      if (!composed.ok) {
        outcome = composed;
        break;
      }
      if (capabilities.execute_composed_request === undefined) {
        throw new SemanticActionPlanError(
          "SEMANTIC_ACTION_UNSUPPORTED",
          "semantic request execution requires the bounded composed-request capability",
        );
      }
      outcome = await capabilities.execute_composed_request(composed.value, plan);
      break;
    }
    case "counter-review-handler": {
      if (capabilities.run_counter_review === undefined) {
        throw new SemanticActionPlanError("SEMANTIC_ACTION_UNSUPPORTED", "counter-review execution requires the bounded handler capability");
      }
      outcome = await capabilities.run_counter_review(plan);
      break;
    }
    case "deferred":
      throw new SemanticActionPlanError("SEMANTIC_ACTION_UNSUPPORTED", plan.deferred_reason ?? "semantic action execution is deferred");
  }
  return Object.freeze({ substep: plan.next_substep, intent_id: plan.intent_id, outcome });
}

function markerStatus(value: PlainJsonValue | undefined): string | undefined {
  if (value === undefined || value === null || Array.isArray(value) || typeof value !== "object") return undefined;
  const descriptor = Object.getOwnPropertyDescriptor(value, "status");
  return descriptor?.enumerable === true && "value" in descriptor && typeof descriptor.value === "string"
    ? descriptor.value
    : undefined;
}

function substepPlan(original: SemanticActionPlanV1, substep: SemanticSubstepV1): SemanticActionPlanV1 {
  const intentId = semanticSubstepIntentId(original.operation_digest, substep);
  const request = requestFacts(original.action_kind, substep, intentId, undefined);
  return Object.freeze({
    action_kind: original.action_kind,
    operation_digest: original.operation_digest,
    invocation: original.invocation,
    substeps: original.substeps,
    next_substep: substep,
    intent_id: intentId,
    execution: request.execution,
    ...(request.facts === undefined ? {} : { request_facts: request.facts }),
    ...(request.reason === undefined ? {} : { deferred_reason: request.reason }),
  });
}

function requireRefresh(capabilities: SemanticActionExecutorCapabilities): NonNullable<SemanticActionExecutorCapabilities["refresh_snapshot"]> {
  if (capabilities.refresh_snapshot === undefined) {
    throw new SemanticActionPlanError("SEMANTIC_ACTION_UNSUPPORTED", "semantic action execution requires authenticated post-substep status refresh");
  }
  return capabilities.refresh_snapshot;
}

function assertCompletedReviewSubstep(snapshot: SemanticStatusSnapshotV1, digestValue: Sha256Digest, substep: "review-enter" | "review-run" | "review-empty-triage"): void {
  const state = snapshot.state;
  if (state === undefined) throw new SemanticActionPlanError("SEMANTIC_REPLAY_MISMATCH", "review substep completed without active durable state");
  const expected = substep === "review-enter"
    ? { tool: "archflow_state" as const, operation: "record-state-boundary" }
    : substep === "review-run"
      ? { tool: "archflow_counter_review" as const, operation: "counter-review" }
      : { tool: "archflow_state" as const, operation: "record-triage" };
  if (!authenticateSemanticLastTransition(state, digestValue, substep, { ...expected, input_fingerprint: state.input_fingerprint })) {
    throw new SemanticActionPlanError("SEMANTIC_REPLAY_MISMATCH", `completed ${substep} did not install its authenticated transition`);
  }
}

async function executeReviewAction(
  services: ProductionServices,
  initial: SemanticActionPlanV1,
  capabilities: SemanticActionExecutorCapabilities,
): Promise<WorkflowViewV1> {
  const refresh = requireRefresh(capabilities);
  let current = initial;
  let snapshot: SemanticStatusSnapshotV1 | undefined;
  if (current.next_substep === "review-enter") {
    await executeSemanticActionSubstep(services, current, capabilities);
    snapshot = await refresh();
    assertCompletedReviewSubstep(snapshot, initial.operation_digest, "review-enter");
    if (projectSemanticStatus(snapshot, initial.invocation).view.next_action.kind !== "review") {
      throw new SemanticActionPlanError("SEMANTIC_REPLAY_MISMATCH", "review-enter did not land at the review-run continuation");
    }
    current = substepPlan(initial, "review-run");
  }
  if (current.next_substep === "review-run") {
    await executeSemanticActionSubstep(services, current, capabilities);
    snapshot = await refresh();
    assertCompletedReviewSubstep(snapshot, initial.operation_digest, "review-run");
    const postReview = projectSemanticStatus(snapshot, initial.invocation).view;
    if (snapshot.full_findings.length > 0) {
      if (postReview.next_action.kind !== "triage") throw new SemanticActionPlanError("SEMANTIC_REPLAY_MISMATCH", "review findings did not land at the triage actor boundary");
      return postReview;
    }
    if (postReview.next_action.kind !== "review") throw new SemanticActionPlanError("SEMANTIC_REPLAY_MISMATCH", "finding-free review did not land at empty-triage settlement");
    current = substepPlan(initial, "review-empty-triage");
  }
  if (current.next_substep === "review-empty-triage") {
    await executeSemanticActionSubstep(services, current, capabilities);
    snapshot = await refresh();
    assertCompletedReviewSubstep(snapshot, initial.operation_digest, "review-empty-triage");
  }
  if (snapshot === undefined) snapshot = await refresh();
  return projectSemanticStatus(snapshot, initial.invocation).view;
}

/**
 * Executes one offered semantic action. Review's fixed no-actor-boundary substeps share the
 * original operation digest and run inside the process-wide review FIFO; every other action runs
 * one substep. The function refreshes and returns the public view but never applies its next offer.
 */
export async function executeSemanticAction(
  services: ProductionServices,
  snapshot: SemanticStatusSnapshotV1,
  value: unknown,
  capabilities: SemanticActionExecutorCapabilities,
): Promise<WorkflowViewV1> {
  let plan = planSemanticAction(snapshot, value);
  if (plan.action_kind === "revise" && markerStatus(snapshot.revision_checkpoint) === "valid") {
    plan = Object.freeze({ ...plan, revision_checkpoint: true });
  }
  if (plan.action_kind === "review") {
    // `run_counter_review` must be the direct, non-queued handler service: this outer FIFO owns
    // replay check, dispatch, and commit as one critical section and must never nest the queue.
    return serializeDispatch(() => executeReviewAction(services, plan, capabilities));
  }
  await executeSemanticActionSubstep(services, plan, capabilities);
  const refreshed = await requireRefresh(capabilities)();
  return projectSemanticStatus(refreshed, plan.invocation).view;
}

/** Composes one low-level request; it never invokes a handler or applies a returned offer. */
export async function composeSemanticActionRequest(
  services: ProductionServices,
  plan: SemanticActionPlanV1,
): Promise<ProjectResult<ComposedRequest>> {
  if (plan.execution !== "compose-request" && plan.execution !== "counter-review-handler") {
    throw new SemanticActionPlanError("SEMANTIC_ACTION_UNSUPPORTED", plan.deferred_reason ?? `${plan.execution} requires its dedicated service`);
  }
  if (plan.request_facts === undefined) throw new TypeError("semantic request plan has no request facts");
  return composeRequest(services, plan.request_facts);
}

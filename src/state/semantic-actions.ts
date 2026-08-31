import { canonicalJsonDigest } from "../contracts/canonical.js";
import type { TaskStateV1 } from "../contracts/durable-state.js";
import { parsePathSafeId, type PathSafeId, type Sha256Digest } from "../contracts/evidence.js";
import type { RouteOverrideDeclaration } from "../contracts/mcp-tools.js";
import { decodePhaseInstance } from "../contracts/phase-instance.js";
import type { PlainJsonValue } from "../contracts/plain-json.js";
import {
  parseArchFlowApplyInputV1,
  SEMANTIC_SUBSTEPS,
  type ApplySubmissionKindV1,
  type ApplySubmissionV1,
  type ArchFlowApplyInputV1,
  type SemanticActionKindV1,
  type SemanticActionOfferV1,
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

export type SemanticExecutionKind =
  | "compose-request"
  | "counter-review-handler"
  | "decision-archive"
  | "decision-settle";
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
  decision_submission?: Extract<ApplySubmissionV1, { readonly kind: "decision" }>;
  /** Set at plan time from a validated `review-dispatch` submission; the continuation substep plan reads it because continuations forward no submission. */
  route_override?: RouteOverrideDeclaration;
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
  // "none" forbids any submission; "review-dispatch" is the one optional kind — the dispatching
  // review offer names it, an override-less apply carries no submission, and a present one must
  // match exactly; every other kind stays exact-required.
  const matches = expected === "none"
    ? submission === undefined
    : submission === undefined
      ? expected === "review-dispatch"
      : actual === expected;
  if (!matches) {
    throw new SemanticActionPlanError("SEMANTIC_SUBMISSION_MISMATCH", expectedSubmissionMessage(expected, actual));
  }
}

/**
 * A succeeded work-result must match its position's produce kind before composition: a phase-impl
 * position requires the client-owned implementation facts, and a document position refuses them.
 * This turns both mismatch directions into semantic failures instead of composer crashes.
 */
function assertWorkResultFactsMatchPosition(
  offer: SemanticActionOfferV1,
  submission: ApplySubmissionV1 | undefined,
): void {
  if (offer.action_kind !== "submit-work" || submission?.kind !== "work-result" || submission.outcome !== "succeeded") return;
  const position = offer.phase_instance === undefined ? undefined : decodePhaseInstance(offer.phase_instance).kind;
  if (position === "phase-impl") {
    if (submission.implementation === undefined) {
      throw new SemanticActionPlanError(
        "SEMANTIC_SUBMISSION_MISMATCH",
        "semantic action expects implementation facts on a succeeded work-result at a phase-impl position",
      );
    }
    return;
  }
  if (position !== undefined && submission.implementation !== undefined) {
    throw new SemanticActionPlanError(
      "SEMANTIC_SUBMISSION_MISMATCH",
      `semantic action refuses implementation facts on a succeeded work-result at a ${position} position`,
    );
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

function markerField(value: PlainJsonValue | undefined, field: string): unknown {
  if (value === undefined || value === null || Array.isArray(value) || typeof value !== "object") return undefined;
  const descriptor = Object.getOwnPropertyDescriptor(value, field);
  return descriptor?.enumerable === true && "value" in descriptor ? descriptor.value : undefined;
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
  // A human gate can legally land at any position and overwrite the single last_transition slot.
  // A transition naming a different substep is no evidence about this one, so the review falls
  // through and runs its remaining substeps under a fresh operation.
  if (identity.substep !== expectedSubstep) return undefined;
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

function authenticatedSemanticTriageContinuation(state: TaskStateV1): Sha256Digest | undefined {
  if (state.step !== "triage" || state.status !== "running") return undefined;
  const transition = state.last_transition;
  if (transition === undefined || !transition.intent_id.startsWith("afop-")) return undefined;
  let identity: ReturnType<typeof parseSemanticSubstepIntentId>;
  try { identity = parseSemanticSubstepIntentId(transition.intent_id); }
  catch { throw new SemanticActionPlanError("SEMANTIC_REPLAY_MISMATCH", "semantic triage entry has an invalid intent identity"); }
  if (identity.substep !== "triage-enter") return undefined; // an interloping gate transition is not this boundary's evidence
  if (!authenticateSemanticLastTransition(
    state, identity.operation_digest, identity.substep,
    { tool: "archflow_state", operation: "record-state-boundary", input_fingerprint: state.input_fingerprint },
  )) throw new SemanticActionPlanError("SEMANTIC_REPLAY_MISMATCH", "triage continuation does not authenticate its entry boundary");
  return identity.operation_digest;
}

function authenticatedSemanticRevisionContinuation(
  state: TaskStateV1,
): Readonly<{ operation_digest: Sha256Digest; entry_kind: "state" | "gate"; predecessor_attempts: readonly number[] }> | undefined {
  if (state.step !== "produce" || state.status !== "running") return undefined;
  const transition = state.last_transition;
  if (transition === undefined || !transition.intent_id.startsWith("afop-")) return undefined;
  let identity: ReturnType<typeof parseSemanticSubstepIntentId>;
  try { identity = parseSemanticSubstepIntentId(transition.intent_id); }
  catch { throw new SemanticActionPlanError("SEMANTIC_REPLAY_MISMATCH", "semantic revision entry has an invalid intent identity"); }
  if (identity.substep !== "revise-enter") return undefined;
  if (transition.resulting_revision !== state.revision) {
    throw new SemanticActionPlanError("SEMANTIC_REPLAY_MISMATCH", "revision continuation does not authenticate its entry boundary");
  }
  const gateEntry = authenticateSemanticLastTransition(state, identity.operation_digest, identity.substep, {
    tool: "archflow_gate", operation: "semantic-revision-enter", input_fingerprint: state.input_fingerprint,
  });
  const stateEntry = authenticateSemanticLastTransition(state, identity.operation_digest, identity.substep, {
    tool: "archflow_state", operation: "record-state-boundary", input_fingerprint: state.input_fingerprint,
  });
  if (!gateEntry && !stateEntry) {
    throw new SemanticActionPlanError("SEMANTIC_REPLAY_MISMATCH", "revision continuation does not authenticate its entry boundary");
  }
  if (gateEntry) {
    const predecessor = markerField(transition.outcome, "predecessor_attempt");
    if (!Number.isSafeInteger(predecessor) || Number(predecessor) < 1 ||
        (predecessor !== state.attempt && predecessor !== state.attempt - 1)) {
      throw new SemanticActionPlanError("SEMANTIC_REPLAY_MISMATCH", "revision entry does not authenticate its predecessor attempt");
    }
    return Object.freeze({
      operation_digest: identity.operation_digest, entry_kind: "gate",
      predecessor_attempts: Object.freeze([Number(predecessor)]),
    });
  }
  // A legal state-boundary revise either preserves the attempt or increments it once. The
  // operation digest authenticates which predecessor offer was actually used; trying this closed
  // pair does not grant either candidate unless its complete operation key hashes to that digest.
  return Object.freeze({
    operation_digest: identity.operation_digest, entry_kind: "state",
    predecessor_attempts: Object.freeze([
      state.attempt,
      ...(state.attempt > 1 ? [state.attempt - 1] : []),
    ]),
  });
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
  if (state.step === "triage" && state.status === "running" && snapshot.full_findings.length === 0) {
    authenticatedSemanticTriageContinuation(state);
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
    case "refresh-milestone-baseline": return Object.freeze(["refresh-milestone-baseline"]);
    case "recover-milestone-authority": return Object.freeze(["recover-milestone-authority"]);
    case "refresh-stale-baseline": return Object.freeze(["refresh-stale-baseline"]);
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
  nextActionCode?: string,
  invocation?: WorkflowInvocationV1,
): Readonly<{ execution: SemanticExecutionKind; facts?: PlainJsonValue }> {
  switch (action) {
    case "initialize-task":
      if (submission?.kind !== "task-ask") throw new TypeError("validated task ask is unavailable");
      return { execution: "compose-request", facts: { kind: "initialize", intent_id: intentId } };
    case "begin-work":
      if (nextActionCode === "recover-approval-trigger-authority") {
        return { execution: "compose-request", facts: { kind: "recover-approval-trigger-authority", intent_id: intentId } };
      }
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
      if (substep === "review-run") return {
        execution: "counter-review-handler",
        facts: {
          kind: "counter-review",
          intent_id: intentId,
          ...(invocation?.review_routes === undefined ? {} : { invocation_routes: invocation.review_routes as unknown as PlainJsonValue }),
          // The declaration is plain-json-asserted at parse time; the cast only sheds zod's
          // inferred optional `undefined` (not a PlainJsonValue) — the composer applies the same
          // idiom to this value in composeCounterReview.
          ...(submission?.kind === "review-dispatch" ? { route_override: submission.route_override as unknown as PlainJsonValue } : {}),
        },
      };
      return { execution: "compose-request", facts: { kind: "triage", intent_id: intentId, dispositions: [] } };
    case "triage":
      if (submission?.kind !== "triage") throw new TypeError("validated triage is unavailable");
      return { execution: "compose-request", facts: { kind: "triage", intent_id: intentId, dispositions: submission.dispositions } };
    case "reopen":
      return { execution: "compose-request" };
    case "decide":
      if (substep === "decision-archive") {
        if (submission?.kind !== "decision") throw new TypeError("validated decision submission is unavailable");
        return { execution: "decision-archive" };
      }
      if (substep === "decision-settle") return { execution: "decision-settle" };
      if (submission?.kind !== "gate-summary") throw new TypeError("validated gate summary is unavailable");
      return { execution: "compose-request", facts: { kind: "gate", intent_id: intentId, summary: submission.summary } };
    case "open-waiver":
      return { execution: "compose-request", facts: { kind: "waiver", intent_id: intentId } };
    case "refresh-milestone-baseline":
      return { execution: "compose-request", facts: { kind: "refresh-milestone-baseline", intent_id: intentId } };
    case "recover-milestone-authority":
      return { execution: "compose-request", facts: { kind: "recover-milestone-authority", intent_id: intentId } };
    case "refresh-stale-baseline":
      return { execution: "compose-request", facts: { kind: "refresh-stale-baseline", intent_id: intentId } };
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
  if (
    input.action.submission?.kind === "review-dispatch" &&
    input.action.submission.route_override["effort-reviewer"] !== undefined &&
    projection.view.dispatch_failure?.role !== "effort-reviewer"
  ) {
    throw new SemanticActionPlanError(
      "SEMANTIC_SUBMISSION_MISMATCH",
      "an effort-reviewer substitution is permitted only for the exact current effort-review dispatch failure",
    );
  }
  assertWorkResultFactsMatchPosition(offer, input.action.submission);
  const expectedToken = semanticOfferToken(offer);
  const archivedOperation = offer.action_kind === "decide" && markerField(snapshot.archived_decision, "status") === "exact"
    ? markerField(snapshot.archived_decision, "operation_digest") as Sha256Digest | undefined
    : undefined;
  const revisionContinuation = snapshot.state === undefined ? undefined : authenticatedSemanticRevisionContinuation(snapshot.state);
  if (revisionContinuation !== undefined && input.action.submission === undefined) {
    const replay = revisionContinuation.predecessor_attempts.map((attempt) => {
      const replayOffer = Object.freeze({
        ...offer, action_kind: "revise" as const, expected_submission: "none" as const, attempt,
      });
      const key = operationKey(input.action.offer, replayOffer, undefined);
      return Object.freeze({ key, digest: semanticOperationDigest(key) });
    }).find((candidate) => candidate.digest === revisionContinuation.operation_digest);
    if (replay !== undefined) {
      const intentId = semanticSubstepIntentId(revisionContinuation.operation_digest, "revise-enter");
      return Object.freeze({
        action_kind: "revise", operation_key: replay.key, operation_digest: revisionContinuation.operation_digest,
        invocation: input.invocation, substeps: Object.freeze(["revise-enter"] as const), next_substep: "revise-enter",
        intent_id: intentId, execution: "compose-request",
        request_facts: Object.freeze({ kind: "running", step: "produce", intent_id: intentId }),
        ...(revisionContinuation.entry_kind === "gate" ? { revision_checkpoint: true as const } : {}),
      });
    }
  }
  const isArchivedDecisionRetry = archivedOperation !== undefined && input.action.submission?.kind === "decision";
  if (!isArchivedDecisionRetry) assertSubmissionMatches(offer.expected_submission, input.action.submission);
  let operationOffer = offer;
  if (isArchivedDecisionRetry) {
    const { archived_decision: _archive, ...beforeArchive } = snapshot;
    const originalProjection = projectSemanticStatus(beforeArchive, input.invocation);
    const originalOffer = originalProjection.internal_offer;
    if (originalOffer === undefined || input.action.offer !== semanticOfferToken(originalOffer)) {
      throw new SemanticActionPlanError("SEMANTIC_OFFER_STALE", "decision retry does not carry the original authenticated offer");
    }
    operationOffer = originalOffer;
  }
  const key = operationKey(input.action.offer, operationOffer, input.action.submission);
  const candidateOperationDigest = semanticOperationDigest(key);
  if (isArchivedDecisionRetry && candidateOperationDigest !== archivedOperation) {
    throw new SemanticActionPlanError("SEMANTIC_REPLAY_MISMATCH", "decision retry does not reproduce the archived operation identity");
  }
  let operationDigest = candidateOperationDigest;
  const substeps = fixedSubsteps(offer.action_kind, snapshot, offer.expected_submission);
  const nextSubstep = substeps[0]!;
  let recoveredOperationDigest: Sha256Digest | undefined;
  if (offer.action_kind === "review" && snapshot.state !== undefined) {
    const predecessor = nextSubstep === "review-run"
      ? "review-enter"
      : nextSubstep === "review-empty-triage" ? "review-run" : undefined;
    if (predecessor !== undefined) {
      const recovered = nextSubstep === "review-empty-triage" && snapshot.state.step === "triage"
        ? authenticatedSemanticTriageContinuation(snapshot.state)
        : authenticatedSemanticReviewContinuation(snapshot.state, predecessor);
      if (recovered !== undefined) {
        operationDigest = recovered;
        recoveredOperationDigest = recovered;
      }
    }
  }
  if (offer.action_kind === "decide" && nextSubstep === "decision-settle" && archivedOperation !== undefined) {
    operationDigest = archivedOperation;
    recoveredOperationDigest = archivedOperation;
  }
  if (offer.action_kind === "triage" && snapshot.state !== undefined) {
    const recovered = authenticatedSemanticTriageContinuation(snapshot.state);
    if (recovered !== undefined) {
      operationDigest = recovered;
      recoveredOperationDigest = recovered;
    }
  }
  const currentOfferMatches = input.action.offer === expectedToken && projection.view.next_action.offer === expectedToken;
  const authenticatedOldReviewRetry = offer.action_kind === "review" &&
    recoveredOperationDigest !== undefined && candidateOperationDigest === recoveredOperationDigest;
  const authenticatedOldTriageRetry = offer.action_kind === "triage" &&
    recoveredOperationDigest !== undefined && candidateOperationDigest === recoveredOperationDigest;
  if (!currentOfferMatches && !authenticatedOldReviewRetry && !authenticatedOldTriageRetry && !isArchivedDecisionRetry) {
    throw new SemanticActionPlanError("SEMANTIC_OFFER_STALE", "semantic offer is stale or does not match the authenticated current action and invocation");
  }
  const intentId = semanticSubstepIntentId(operationDigest, nextSubstep);
  const effectiveSubstep = isArchivedDecisionRetry ? "decision-archive" as const : nextSubstep;
  const effectiveIntentId = semanticSubstepIntentId(operationDigest, effectiveSubstep);
  const request = requestFacts(
    offer.action_kind,
    effectiveSubstep,
    effectiveIntentId,
    input.action.submission,
    operationOffer.next_action_code,
    input.invocation,
  );
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
    next_substep: effectiveSubstep,
    intent_id: effectiveIntentId,
    execution,
    ...(requestFactsValue === undefined ? {} : { request_facts: requestFactsValue }),
    ...(input.action.submission?.kind !== "task-ask" ? {} : { task_ask: input.action.submission.text }),
    ...(input.action.submission?.kind !== "reopening-request" ? {} : { reopening_request: input.action.submission.request }),
    ...(input.action.submission?.kind !== "decision" ? {} : { decision_submission: input.action.submission }),
    ...(input.action.submission?.kind !== "review-dispatch" ? {} : { route_override: input.action.submission.route_override }),
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
  archive_decision?: (plan: SemanticActionPlanV1) => Promise<unknown>;
  settle_decision?: (plan: SemanticActionPlanV1) => Promise<unknown>;
  /** Reopens production services and status from one newly authenticated repository read. */
  refresh_services?: () => Promise<Readonly<{ services: ProductionServices; snapshot: SemanticStatusSnapshotV1 }>>;
  /** Compatibility seam for callers whose services are immutable test doubles. */
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
    case "decision-archive":
      if (capabilities.archive_decision === undefined) throw new SemanticActionPlanError("SEMANTIC_ACTION_UNSUPPORTED", "decision archive execution requires the direct decision capability");
      outcome = await capabilities.archive_decision(plan);
      break;
    case "decision-settle":
      if (capabilities.settle_decision === undefined) throw new SemanticActionPlanError("SEMANTIC_ACTION_UNSUPPORTED", "decision settlement execution requires the direct decision capability");
      outcome = await capabilities.settle_decision(plan);
      break;
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
  // The continuation forwards no request submission; the plan's override field is the carrier that
  // keeps a review-dispatch substitution alive in the review-run facts.
  const submission = original.route_override === undefined
    ? undefined
    : ({ kind: "review-dispatch", route_override: original.route_override } as const);
  const request = requestFacts(original.action_kind, substep, intentId, submission, undefined, original.invocation);
  return Object.freeze({
    action_kind: original.action_kind,
    operation_digest: original.operation_digest,
    invocation: original.invocation,
    substeps: original.substeps,
    next_substep: substep,
    intent_id: intentId,
    execution: request.execution,
    ...(request.facts === undefined ? {} : { request_facts: request.facts }),
  });
}

function triageEntryPlan(
  original: SemanticActionPlanV1,
): SemanticActionPlanV1 {
  const substep = "triage-enter" as const;
  const intentId = semanticSubstepIntentId(original.operation_digest, substep);
  return Object.freeze({
    action_kind: original.action_kind,
    operation_digest: original.operation_digest,
    invocation: original.invocation,
    substeps: original.substeps,
    next_substep: substep,
    intent_id: intentId,
    execution: "compose-request",
    request_facts: Object.freeze({ kind: "running", step: "triage", intent_id: intentId }),
  });
}

function requireRefresh(capabilities: SemanticActionExecutorCapabilities): NonNullable<SemanticActionExecutorCapabilities["refresh_snapshot"]> {
  if (capabilities.refresh_snapshot === undefined) {
    throw new SemanticActionPlanError("SEMANTIC_ACTION_UNSUPPORTED", "semantic action execution requires authenticated post-substep status refresh");
  }
  return capabilities.refresh_snapshot;
}

async function refreshExecution(
  currentServices: ProductionServices,
  capabilities: SemanticActionExecutorCapabilities,
): Promise<Readonly<{ services: ProductionServices; snapshot: SemanticStatusSnapshotV1 }>> {
  if (capabilities.refresh_services !== undefined) return capabilities.refresh_services();
  return Object.freeze({ services: currentServices, snapshot: await requireRefresh(capabilities)() });
}

function failedProjectResult(value: unknown): value is ProjectResult<never> & { readonly ok: false } {
  return value !== null && typeof value === "object" &&
    Object.getOwnPropertyDescriptor(value, "ok")?.value === false &&
    Object.getOwnPropertyDescriptor(value, "schema_version")?.value === "1";
}

export class SemanticActionExecutionError extends Error {
  public constructor(public readonly result: ProjectResult<never> & { readonly ok: false }) {
    super(`${result.error.code}: ${JSON.stringify(result.error.diagnostic.parameters)}`);
    this.name = "SemanticActionExecutionError";
  }
}

function assertSubstepSucceeded(result: SemanticSubstepExecutionResult): void {
  if (failedProjectResult(result.outcome)) throw new SemanticActionExecutionError(result.outcome);
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

function assertEmptyTriageEntered(snapshot: SemanticStatusSnapshotV1, digestValue: Sha256Digest): void {
  const state = snapshot.state;
  if (state === undefined || state.step !== "triage" || state.status !== "running" ||
      !authenticateSemanticLastTransition(state, digestValue, "triage-enter", {
        tool: "archflow_state", operation: "record-state-boundary", input_fingerprint: state.input_fingerprint,
      })) {
    throw new SemanticActionPlanError("SEMANTIC_REPLAY_MISMATCH", "empty triage did not enter its authenticated running boundary");
  }
}

async function executeReviewAction(
  services: ProductionServices,
  initial: SemanticActionPlanV1,
  capabilities: SemanticActionExecutorCapabilities,
): Promise<WorkflowViewV1> {
  let currentServices = services;
  let current = initial;
  let snapshot: SemanticStatusSnapshotV1 | undefined;
  if (current.next_substep === "review-enter") {
    const executed = await executeSemanticActionSubstep(currentServices, current, capabilities);
    assertSubstepSucceeded(executed);
    ({ services: currentServices, snapshot } = await refreshExecution(currentServices, capabilities));
    assertCompletedReviewSubstep(snapshot, initial.operation_digest, "review-enter");
    if (projectSemanticStatus(snapshot, initial.invocation).view.next_action.kind !== "review") {
      throw new SemanticActionPlanError("SEMANTIC_REPLAY_MISMATCH", "review-enter did not land at the review-run continuation");
    }
    current = substepPlan(initial, "review-run");
  }
  if (current.next_substep === "review-run") {
    const executed = await executeSemanticActionSubstep(currentServices, current, capabilities);
    assertSubstepSucceeded(executed);
    ({ services: currentServices, snapshot } = await refreshExecution(currentServices, capabilities));
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
    if (snapshot === undefined) ({ services: currentServices, snapshot } = await refreshExecution(currentServices, capabilities));
    if (snapshot.state?.step === "counter_review" && snapshot.state.status === "succeeded") {
      const entered = await executeSemanticActionSubstep(currentServices, triageEntryPlan(initial), capabilities);
      assertSubstepSucceeded(entered);
      ({ services: currentServices, snapshot } = await refreshExecution(currentServices, capabilities));
      assertEmptyTriageEntered(snapshot, initial.operation_digest);
    }
    const executed = await executeSemanticActionSubstep(currentServices, current, capabilities);
    assertSubstepSucceeded(executed);
    ({ services: currentServices, snapshot } = await refreshExecution(currentServices, capabilities));
    assertCompletedReviewSubstep(snapshot, initial.operation_digest, "review-empty-triage");
  }
  if (snapshot === undefined) ({ snapshot } = await refreshExecution(currentServices, capabilities));
  return projectSemanticStatus(snapshot, initial.invocation).view;
}

async function executeTriageAction(
  services: ProductionServices,
  snapshot: SemanticStatusSnapshotV1,
  plan: SemanticActionPlanV1,
  capabilities: SemanticActionExecutorCapabilities,
): Promise<WorkflowViewV1> {
  let currentServices = services;
  let currentSnapshot = snapshot;
  if (currentSnapshot.state?.step === "counter_review" && currentSnapshot.state.status === "succeeded") {
    const entered = await executeSemanticActionSubstep(
      currentServices, triageEntryPlan(plan), capabilities,
    );
    assertSubstepSucceeded(entered);
    ({ services: currentServices, snapshot: currentSnapshot } = await refreshExecution(currentServices, capabilities));
    const state = currentSnapshot.state;
    if (state === undefined || state.step !== "triage" || state.status !== "running" ||
        !authenticateSemanticLastTransition(state, plan.operation_digest, "triage-enter", {
          tool: "archflow_state", operation: "record-state-boundary", input_fingerprint: state.input_fingerprint,
        })) throw new SemanticActionPlanError("SEMANTIC_REPLAY_MISMATCH", "triage did not enter its authenticated running boundary");
  }
  const completed = await executeSemanticActionSubstep(currentServices, plan, capabilities);
  assertSubstepSucceeded(completed);
  ({ snapshot: currentSnapshot } = await refreshExecution(currentServices, capabilities));
  return projectSemanticStatus(currentSnapshot, plan.invocation).view;
}

async function executeDecisionAction(
  services: ProductionServices,
  initial: SemanticActionPlanV1,
  capabilities: SemanticActionExecutorCapabilities,
): Promise<WorkflowViewV1> {
  let currentServices = services;
  let snapshot: SemanticStatusSnapshotV1;
  let current = initial;
  if (current.next_substep === "decision-archive") {
    const archived = await executeSemanticActionSubstep(currentServices, current, capabilities);
    assertSubstepSucceeded(archived);
    ({ services: currentServices, snapshot } = await refreshExecution(currentServices, capabilities));
    const continuation = projectSemanticStatus(snapshot, initial.invocation);
    if (continuation.view.next_action.kind !== "decide" || continuation.internal_offer?.expected_submission !== "none") {
      throw new SemanticActionPlanError("SEMANTIC_REPLAY_MISMATCH", "decision archive did not land at authenticated settlement");
    }
    current = substepPlan(initial, "decision-settle");
  }
  const settled = await executeSemanticActionSubstep(currentServices, current, capabilities);
  assertSubstepSucceeded(settled);
  ({ snapshot } = await refreshExecution(currentServices, capabilities));
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
  if (plan.action_kind === "triage") return executeTriageAction(services, snapshot, plan, capabilities);
  if (plan.action_kind === "decide" && (plan.next_substep === "decision-archive" || plan.next_substep === "decision-settle")) {
    return executeDecisionAction(services, plan, capabilities);
  }
  const executed = await executeSemanticActionSubstep(services, plan, capabilities);
  assertSubstepSucceeded(executed);
  const refreshed = await refreshExecution(services, capabilities);
  return projectSemanticStatus(refreshed.snapshot, plan.invocation).view;
}

/** Composes one low-level request; it never invokes a handler or applies a returned offer. */
export async function composeSemanticActionRequest(
  services: ProductionServices,
  plan: SemanticActionPlanV1,
): Promise<ProjectResult<ComposedRequest>> {
  if (plan.execution !== "compose-request" && plan.execution !== "counter-review-handler") {
    throw new SemanticActionPlanError("SEMANTIC_ACTION_UNSUPPORTED", `${plan.execution} requires its dedicated service`);
  }
  if (plan.request_facts === undefined) throw new TypeError("semantic request plan has no request facts");
  return composeRequest(services, plan.request_facts);
}

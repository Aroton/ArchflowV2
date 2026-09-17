import { DEFAULT_MAX_ATTEMPTS } from "../review/fixed-point.js";
import type { WorkflowProgressV1 } from "../contracts/workflow-progress.js";
import { canonicalJsonDigest } from "../contracts/canonical.js";
import type { Sha256Digest } from "../contracts/evidence.js";
import { decodePhaseInstance, encodePhaseInstance, parsePositiveSafePhaseNumber, type PhaseInstanceId } from "../contracts/phase-instance.js";
import type { PlainJsonValue } from "../contracts/plain-json.js";
import type {
  ApplySubmissionKindV1,
  HumanPresentationV1,
  SemanticActionKindV1,
  SemanticActionOfferV1,
  SemanticNextActionV1,
  SemanticStatusSnapshotV1,
  WorkflowConditionV1,
  WorkflowStateV1,
  WorkflowInvocationV1,
  WorkflowPositionV1,
  WorkflowReopenImpactV1,
} from "../contracts/semantic-workflow.js";
import type { NextAction } from "./next-action.js";
import type { TaskStatusV1 } from "./status.js";

type ProjectionShape = Readonly<{
  condition: WorkflowConditionV1;
  headline: string;
  detail: string;
  action_kind: SemanticActionKindV1;
  instruction: string;
  expected_submission?: ApplySubmissionKindV1;
  presentation?: HumanPresentationV1;
  commit?: SemanticNextActionV1["commit"];
  skill?: string;
  skill_args?: readonly string[];
  findings?: true;
}>;

type ArchivedDecisionMarker = Readonly<{ status: "exact" | "invalid" }>;
type RevisionCheckpointMarker = Readonly<{ status: "valid" | "invalid" }>;

function statusFromSnapshot(snapshot: SemanticStatusSnapshotV1): TaskStatusV1 {
  return snapshot.status as unknown as TaskStatusV1;
}

function positionFromPhase(phase: PhaseInstanceId | undefined): WorkflowPositionV1 | undefined {
  if (phase === undefined) return undefined;
  const decoded = decodePhaseInstance(phase);
  return decoded.kind === "prd" || decoded.kind === "design"
    ? Object.freeze({ kind: decoded.kind })
    : Object.freeze({ kind: decoded.kind, phase: Number(decoded.phase) });
}

function invocationTarget(invocation: WorkflowInvocationV1): PhaseInstanceId {
  switch (invocation.skill) {
    case "archflow-prd": return encodePhaseInstance({ kind: "prd" });
    case "archflow-design": return encodePhaseInstance({ kind: "design" });
    case "archflow-phase-design": return encodePhaseInstance({ kind: "phase-design", phase: parsePositiveSafePhaseNumber(invocation.phase) });
    case "archflow-phase-impl": return encodePhaseInstance({ kind: "phase-impl", phase: parsePositiveSafePhaseNumber(invocation.phase) });
  }
}

/** Semantic mutations are exposed for every producing workflow, phase implementation included. */
export function semanticInvocationEnabled(invocation: WorkflowInvocationV1): boolean {
  return invocation.skill === "archflow-prd" || invocation.skill === "archflow-design" ||
    invocation.skill === "archflow-phase-design" || invocation.skill === "archflow-phase-impl";
}

function invocationOwnsCurrentPosition(
  invocation: WorkflowInvocationV1,
  status: TaskStatusV1,
  actionKind: SemanticActionKindV1,
): boolean {
  if (!semanticInvocationEnabled(invocation)) return false;
  if (status.state === "missing") return invocation.skill === "archflow-prd" && invocation.intent === "resume";
  if (invocation.intent !== "resume") return false;
  const target = invocationTarget(invocation);
  if (actionKind === "start-next-skill") {
    return status.next_action.code === "advance-phase" && target === status.next_action.target_phase_instance;
  }
  return status.phase_instance !== undefined && target === status.phase_instance;
}

function samePosition(left: WorkflowPositionV1, right: WorkflowPositionV1): boolean {
  if (left.kind !== right.kind) return false;
  if (left.kind === "prd" || left.kind === "design") return true;
  return "phase" in left && "phase" in right && left.phase === right.phase;
}

function reopenImpactFor(
  snapshot: SemanticStatusSnapshotV1,
  invocation: WorkflowInvocationV1,
): WorkflowReopenImpactV1 | undefined {
  if (invocation.intent !== "reopen") return undefined;
  const target = positionFromPhase(invocationTarget(invocation));
  return target === undefined ? undefined : snapshot.reopen_impacts.find((impact) => samePosition(impact.target, target));
}

function markerStatus(value: PlainJsonValue | undefined): string | undefined {
  if (value === undefined || value === null || Array.isArray(value) || typeof value !== "object") return undefined;
  const descriptor = Object.getOwnPropertyDescriptor(value, "status");
  return descriptor?.enumerable === true && "value" in descriptor && typeof descriptor.value === "string"
    ? descriptor.value
    : undefined;
}

function publicPresentation(status: TaskStatusV1): HumanPresentationV1 | undefined {
  const presentation = status.open_gate?.presentation;
  if (presentation === undefined) return undefined;
  return Object.freeze({
    class: presentation.class,
    title: presentation.title,
    summary: presentation.summary,
    ...(presentation.details === undefined ? {} : { details: Object.freeze([...presentation.details]) }),
    question: presentation.question,
    reasons: Object.freeze(presentation.reasons.map((reason) => Object.freeze({ ...reason }))),
    options: Object.freeze(presentation.options.map((option) => Object.freeze({ ...option }))),
  });
}

function inspect(detail: string, instruction = "Request archflow_status with detail: diagnostic for this task and report the failed authority check for operator repair. Do not edit state or approval archives."): ProjectionShape {
  return Object.freeze({
    condition: "blocked", headline: "Workflow needs inspection", detail,
    action_kind: "inspect", instruction,
  });
}

function mapRunStep(status: TaskStatusV1, action: NextAction, snapshot: SemanticStatusSnapshotV1): ProjectionShape {
  switch (action.step) {
    case "produce": {
      const checkpoint = markerStatus(snapshot.revision_checkpoint);
      if (checkpoint === "invalid") return inspect("The recorded human-revision checkpoint could not be authenticated.");
      if (checkpoint === "valid" || action.editorial_revision === true || status.step === "triage") {
        return Object.freeze({
          condition: "ready", headline: "Revision is ready to begin",
          // A policy re-entry carries what the revision has to resolve; nothing else in the
          // semantic view exposes the constitution findings.
          detail: action.policy_reentry === true || action.effort_reentry === true
            ? action.detail
            : "Enter the bounded production write window before changing the artifact.",
          action_kind: "revise", instruction: "Begin the authorized revision, then return to the client-owned work.",
          expected_submission: "none",
        });
      }
      if (status.step === "produce" && status.status === "running") {
        return Object.freeze({
          condition: "awaiting-client", headline: "Client work is in progress", detail: action.detail,
          action_kind: "submit-work", instruction: snapshot.state?.pending_human_revision === undefined
            ? status.minor_revision_pending === true
              ? "Complete the localized correction and applicable automated checks. Include review_revision.classification (minor or significant) and review_revision.rationale describing the actual diff. Minor may clarify established intent, but new requirements, behavior changes, or coordinated rewrites require significant classification and fresh review."
              : "Complete and verify the client-owned work, then submit its result."
            : "Complete and verify the human-requested revision, then submit its result. A succeeded work-result requires human_revision.classification (simple or significant) and human_revision.rationale describing the actual changes. Simple means wording or formatting only with no change in meaning; otherwise classify as significant, including when uncertain. Record any explicit human override in human_revision.user_override.",
          expected_submission: "work-result",
        });
      }
      return Object.freeze({
        condition: "ready", headline: "Work is ready to begin", detail: action.detail,
        action_kind: "begin-work", instruction: "Open the bounded client work window for this phase.",
        expected_submission: "none",
      });
    }
    case "counter_review":
      return Object.freeze({
        condition: "awaiting-client", headline: "Independent review is ready", detail: action.detail,
        action_kind: "review",
        instruction: "Run or resume the server-owned independent review action, carrying a review-dispatch submission with route_override only when requesting a human-authorized reviewer substitution with a reason. For implementation review, you may compact or replace the optional verification-transcript resource before retrying; this action pins its current bytes without replacing the implementation result. Keep verification claims unchanged; changed claims or code require normal revision.",
        expected_submission: "review-dispatch",
      });
    case "triage":
      return snapshot.review_reports !== undefined
        ? Object.freeze({ condition: "awaiting-client", headline: "Review feedback is ready", detail: "Read the reviewer reports and decide whether to revise, make a minor correction, finish, or ask the human.", action_kind: "triage", instruction: "Submit decision and rationale. Use revise with selected reviewer IDs and verification requests for substantive changes; revise-minor without reviewer selection for localized corrections or clarification of established intent. Coordinated rewrites and new requirements need review. Use finish when no worthwhile change remains, or escalate for human judgment.", expected_submission: "triage" })
        : snapshot.full_findings.length === 0
        ? Object.freeze({
            condition: "awaiting-client", headline: "Review settlement is ready",
            detail: "The authenticated review has no findings; record its deterministic empty triage.",
            action_kind: "review", instruction: "Finish the finding-free review without redispatching it.",
            expected_submission: "none",
          })
        : Object.freeze({
            condition: "awaiting-client", headline: "Review findings need triage", detail: action.detail,
            action_kind: "triage", instruction: "Disposition every current review finding.",
            expected_submission: "triage", findings: true,
          });
    case "adjudicate":
    case undefined:
      return inspect("The current pipeline step has no safe semantic action.");
    default:
      return inspect("The current pipeline step has no safe semantic action.");
  }
}

function mapNextAction(status: TaskStatusV1, snapshot: SemanticStatusSnapshotV1): ProjectionShape {
  if (status.dispatch_failure?.code === "RECOVERY_STATE_INVALID") return inspect(status.dispatch_failure.message);
  if (markerStatus(snapshot.pending_waiver_origin) === "invalid") {
    return inspect("The pending waiver origin is stale or unauthenticated.");
  }
  if (snapshot.pending_waiver_origin !== undefined && status.open_gate === undefined) {
    return Object.freeze({
      condition: "awaiting-client", headline: "Waiver request is ready",
      detail: "Open the waiver decision derived from the authenticated prior human choice.",
      action_kind: "open-waiver", instruction: "Open the bounded waiver decision without supplying new gate facts.",
      expected_submission: "none",
    });
  }
  const revisionMarker = markerStatus(snapshot.revision_checkpoint) as RevisionCheckpointMarker["status"] | undefined;
  if (revisionMarker === "invalid") return inspect("The recorded revision checkpoint is stale or unauthenticated.");
  if (revisionMarker === "valid") {
    return Object.freeze({
      condition: "ready", headline: "Requested changes are ready",
      detail: "Enter production before making the approved human-requested revision.",
      action_kind: "revise", instruction: "Enter the revision window and return before editing.",
      expected_submission: "none",
    });
  }

  const action = status.next_action;
  switch (action.code) {
    case "initialize-repository":
      return inspect("ArchFlow repository initialization is unavailable.", "Run the archflow-init skill in this repository, then request fresh status.");
    case "create-task":
      return Object.freeze({
        condition: "ready", headline: "Task initialization is ready", detail: action.detail,
        action_kind: "initialize-task", instruction: "Create the task from the exact user ask.",
        expected_submission: "task-ask",
      });
    case "resume-exact-intent":
    case "inspect-retained-receipt":
    case "create-fresh-intent":
    case "resolve-current-authority":
      return inspect(action.detail, action.detail);
    case "open-gate":
      return Object.freeze({
        condition: "awaiting-client", headline: "A human decision must be prepared", detail: action.detail,
        action_kind: "decide", instruction: "Supply the conversational summary that will frame the human decision.",
        expected_submission: "gate-summary", findings: true,
      });
    case "resolve-open-gate": {
      const archive = markerStatus(snapshot.archived_decision) as ArchivedDecisionMarker["status"] | undefined;
      if (archive === "invalid") return inspect("The archived human decision does not authenticate against the open gate.");
      if (archive === "exact") {
        return Object.freeze({
          condition: "ready", headline: "The recorded decision is ready to settle",
          detail: "Continue the exact archived human choice without presenting or replacing it.",
          action_kind: "decide", instruction: "Settle the already archived decision.", expected_submission: "none",
        });
      }
      const presentation = publicPresentation(status);
      if (presentation === undefined) return inspect("The open human gate has no authenticated presentation.");
      return Object.freeze({
        condition: "awaiting-human", headline: presentation.title, detail: "The returned presentation requires an explicit human decision.",
        action_kind: "decide", instruction: "Present the returned question and choices, then submit the explicit human decision.", expected_submission: "decision", presentation,
      });
    }
    case "run-step": {
      const step = mapRunStep(status, action, snapshot);
      const recovery = status.dispatch_failure?.recovery;
      return step.action_kind === "review" && recovery !== undefined && recovery.status !== "retrying"
        ? Object.freeze({ ...step, condition: "awaiting-human", headline: "Reviewer recovery needs human attention",
            detail: status.dispatch_failure!.message,
            instruction: "Repair the reviewer route or explicitly authorize a one-dispatch retry or substitute, then resume this review." })
        : step;
    }
    case "recover-approval-trigger-authority":
      return Object.freeze({
        condition: "ready",
        headline: "Fresh approval-trigger authority is ready",
        detail: action.detail,
        action_kind: "begin-work",
        instruction: "Record the compatibility recovery, then request fresh status before editing or resubmitting bytes.",
        expected_submission: "none",
      });
    case "commit-artifacts":
      if (action.commit_path === undefined || action.commit_message === undefined || action.commit_target_ref === undefined || action.commit_baseline === undefined) {
        return inspect("The authorized design commit is missing authenticated commit facts.");
      }
      return Object.freeze({
        condition: "awaiting-client", headline: "The authorized design commit is ready", detail: action.detail,
        action_kind: "commit", instruction: "Perform the exact client-side Git commit, then request fresh status.",
        commit: Object.freeze({
          paths: Object.freeze([action.commit_path]), message: action.commit_message, target_ref: action.commit_target_ref,
          baseline: action.commit_baseline,
        }),
      });
    case "refresh-milestone-baseline":
      return Object.freeze({
        condition: "ready", headline: "The milestone baseline is ready to refresh", detail: action.detail,
        action_kind: "refresh-milestone-baseline",
        instruction: "Record the current unchanged target as the reviewed milestone baseline, then request fresh status.",
        expected_submission: "none",
      });
    case "recover-milestone-authority":
      return Object.freeze({
        condition: "ready", headline: "Fresh milestone authority is ready", detail: action.detail,
        action_kind: "recover-milestone-authority",
        instruction: "Record the same-position authority recovery, then request fresh status before editing.",
        expected_submission: "none",
      });
    case "refresh-stale-baseline":
      return Object.freeze({
        condition: "ready", headline: "The stale baseline decision is ready to refresh", detail: action.detail,
        action_kind: "refresh-stale-baseline",
        instruction: "Supersede only the stale baseline interface, then request fresh status for the live repository subject.",
        expected_submission: "none",
      });
    case "commit-phase": {
      if (action.commit_paths === undefined || action.commit_message === undefined || action.commit_target_ref === undefined || action.commit_baseline === undefined) {
        return inspect("Inspect why the approved implementation commit authority is unavailable.");
      }
      return Object.freeze({
        condition: "awaiting-client", headline: "The authorized implementation commit is ready", detail: action.detail,
        action_kind: "commit",
        instruction: "Confirm HEAD matches the authorized baseline and target ref, stage and inspect exactly the authorized paths, create the commit directly with the exact returned message while preserving unrelated changes, then request fresh read-only status so the server observes proof.",
        commit: Object.freeze({
          paths: Object.freeze([...action.commit_paths].sort()), message: action.commit_message,
          target_ref: action.commit_target_ref, baseline: action.commit_baseline,
          ...(action.commit_repository === undefined
            ? {}
            : { repository: Object.freeze({ ...action.commit_repository }) }),
        }),
      });
    }
    case "advance-phase":
      return Object.freeze({
        condition: "ready", headline: "The next skill is ready", detail: action.detail,
        action_kind: "start-next-skill", instruction: "Record the bounded handoff to the next skill.",
        expected_submission: "none",
        ...(action.skill === undefined ? {} : { skill: action.skill }),
        ...(action.skill_args === undefined ? {} : { skill_args: action.skill_args }),
      });
    case "complete-task":
      return Object.freeze({
        condition: "ready", headline: "Task completion is ready", detail: action.detail,
        action_kind: "finish-task", instruction: "Record completion of the final planned implementation phase.",
        expected_submission: "none",
      });
    case "task-complete":
      return Object.freeze({
        condition: "complete", headline: "Task is complete", detail: action.detail,
        action_kind: "none", instruction: "No further task-lifecycle action is required.",
      });
    case "inspect-state":
      return inspect(action.detail, action.detail);
    default:
      return assertNeverNextAction(action.code);
  }
}

function assertNeverNextAction(code: never): never {
  throw new TypeError(`unmapped next action code: ${String(code)}`);
}

function digestJson(value: unknown): Sha256Digest {
  return canonicalJsonDigest(value as PlainJsonValue);
}

function offerFor(
  snapshot: SemanticStatusSnapshotV1,
  status: TaskStatusV1,
  invocation: WorkflowInvocationV1,
  shape: ProjectionShape,
  reopen?: WorkflowReopenImpactV1,
): SemanticActionOfferV1 {
  const state = snapshot.state;
  const commit = shape.commit;
  return Object.freeze({
    schema_version: "1",
    repository_identity_digest: snapshot.repository_identity_digest,
    task_id: status.task_id,
    revision: state?.revision ?? 0,
    input_fingerprint: state?.input_fingerprint ?? snapshot.repository_identity_digest,
    invocation,
    action_kind: shape.action_kind,
    next_action_code: status.next_action.code,
    expected_submission: shape.expected_submission ?? "none",
    ...(status.phase_instance === undefined ? {} : { phase_instance: status.phase_instance }),
    ...(status.attempt === undefined ? {} : { attempt: status.attempt }),
    ...(status.subject_digest === undefined ? {} : { subject_digest: status.subject_digest }),
    ...(status.evidence?.available !== true ? {} : { evidence_digest: status.evidence.current_evidence.set_digest }),
    ...(status.open_gate === undefined ? {} : { gate_digest: digestJson(status.open_gate.presentation) }),
    ...(commit === undefined ? {} : { commit_digest: digestJson(commit) }),
    ...(snapshot.archived_decision === undefined ? {} : { archived_decision_digest: digestJson(snapshot.archived_decision) }),
    ...(reopen === undefined ? {} : { reopen }),
  });
}

/** `af1_` plus the canonical, repository-bound internal offer digest. */
export function semanticOfferToken(offer: SemanticActionOfferV1): string {
  return `af1_${canonicalJsonDigest(offer as unknown as PlainJsonValue)}`;
}

function canOffer(shape: ProjectionShape): boolean {
  return shape.action_kind !== "inspect" && shape.action_kind !== "none" && shape.action_kind !== "commit";
}

function decisionState(shape: ProjectionShape, status: TaskStatusV1): WorkflowStateV1 {
  if (status.state === "abandoned") return "abandoned";
  if (shape.condition === "awaiting-human") return "awaiting-human";
  switch (shape.action_kind) {
    case "initialize-task": return "initialization";
    case "begin-work": return "work-ready";
    case "submit-work": return "working";
    case "review": return status.step === "counter_review" && status.status === "running" ? "review-running" : "review-ready";
    case "triage": return "triage";
    case "revise": return "revision-ready";
    case "reopen": return "reopening";
    case "open-waiver": return "gate-preparation";
    case "decide": return shape.expected_submission === "gate-summary" ? "gate-preparation" : "decision-settlement";
    case "refresh-milestone-baseline":
    case "recover-milestone-authority":
    case "refresh-stale-baseline": return "recovery";
    case "commit": return "commit";
    case "start-next-skill": return "handoff";
    case "finish-task": return "completion-ready";
    case "inspect": return "blocked";
    case "none": return "complete";
  }
}

type DecisionFacts = Readonly<{
  shape: ProjectionShape;
  state: WorkflowStateV1;
  owns: boolean;
  reopen?: WorkflowReopenImpactV1;
  internal_offer?: SemanticActionOfferV1;
}>;
/** A selected actor boundary, shared by rendering and execution; never persisted authority. */
export type WorkflowDecision = DecisionFacts & (
  | { readonly kind: "operation"; readonly actor: "caller" }
  | { readonly kind: "human"; readonly actor: "human" }
  | { readonly kind: "blocked"; readonly actor: "operator" }
  | { readonly kind: "terminal"; readonly actor: "none" }
);

export function resolveWorkflowDecision(snapshot: SemanticStatusSnapshotV1, invocation?: WorkflowInvocationV1): WorkflowDecision {
  const status = statusFromSnapshot(snapshot);
  let shape: ProjectionShape;
  let reopen: WorkflowReopenImpactV1 | undefined;

  if (invocation?.intent === "reopen") {
    reopen = reopenImpactFor(snapshot, invocation);
    const safe = status.state === "active" && status.open_gate === undefined &&
      snapshot.state?.pending_validation_override === undefined &&
      status.blocking_reasons.length === 0 && (status.reconciliation?.findings.length ?? 0) === 0;
    shape = reopen !== undefined && safe
      ? Object.freeze({
          condition: "awaiting-client", headline: "Earlier planning work can be reopened",
          detail: "The server has authenticated the earlier target and its downstream authority impact.",
          action_kind: "reopen", instruction: "Supply the exact human reopening or correction request.",
          expected_submission: "reopening-request", findings: true,
        })
      : mapNextAction(status, snapshot);
  } else {
    shape = mapNextAction(status, snapshot);
  }

  const owns = invocation !== undefined && (
    shape.action_kind === "reopen"
      ? reopen !== undefined && semanticInvocationEnabled(invocation)
      : invocationOwnsCurrentPosition(invocation, status, shape.action_kind)
  );
  if (!owns && shape.skill === undefined && shape.action_kind !== "none" && status.next_action.skill !== undefined) {
    const position = positionFromPhase(status.phase_instance);
    shape = Object.freeze({ ...shape, skill: status.next_action.skill,
      skill_args: Object.freeze(position !== undefined && "phase" in position ? [String(position.phase)] : []),
    });
  }
  const offer = owns && canOffer(shape) ? offerFor(snapshot, status, invocation, shape, reopen) : undefined;

  const facts = { shape, state: decisionState(shape, status), owns,
    ...(reopen === undefined ? {} : { reopen }),
    ...(offer === undefined ? {} : { internal_offer: offer }),
  };
  if (shape.condition === "complete") return Object.freeze({ ...facts, kind: "terminal", actor: "none" });
  if (shape.condition === "blocked") return Object.freeze({ ...facts, kind: "blocked", actor: "operator" });
  if (shape.condition === "awaiting-human" || (shape.action_kind === "start-next-skill" && !owns)) return Object.freeze({ ...facts, kind: "human", actor: "human" });
  return Object.freeze({ ...facts, kind: "operation", actor: "caller" });
}

/** Controller progress is independent of how much context the MCP response renders. */
export function workflowProgress(snapshot: SemanticStatusSnapshotV1, decision = resolveWorkflowDecision(snapshot)): WorkflowProgressV1 | undefined {
  const status = statusFromSnapshot(snapshot);
  const { shape } = decision;
  const recovery = status.dispatch_failure?.recovery;
  const boundary: WorkflowProgressV1["boundary"] = status.state === "abandoned" ? "abandoned"
    : status.state === "complete" ? "complete"
    : shape.presentation !== undefined ? shape.presentation.class
    : status.dispatch_failure !== undefined && recovery?.status !== "retrying" ? "exception"
    : shape.action_kind === "start-next-skill" ? "step-transition"
    : shape.action_kind === "inspect" ? "exception" : "none";
  const progress: WorkflowProgressV1 | undefined = status.step === undefined || status.status === undefined ? undefined : {
    step: status.step, step_status: status.status,
    review_rounds_completed: status.evidence?.assessment?.completed_review_rounds ?? 0,
    review_round_limit: status.evidence?.assessment?.maximum_review_rounds ?? status.review_round_limit ?? DEFAULT_MAX_ATTEMPTS,
    boundary,
    reason: shape.presentation !== undefined ? shape.instruction : recovery?.status === "retrying" ? "A transient reviewer failure is being retried automatically on the same route."
      : status.dispatch_failure !== undefined ? status.dispatch_failure.message
      : shape.action_kind === "start-next-skill" ? "This skill is complete. Waiting for the user to launch the named successor."
      : shape.instruction,
    ...(recovery === undefined ? {} : { dispatch_recovery: recovery }),
  };
  return progress;
}

import { canonicalJsonDigest } from "../contracts/canonical.js";
import type { Sha256Digest } from "../contracts/evidence.js";
import { decodePhaseInstance, encodePhaseInstance, parsePositiveSafePhaseNumber, type PhaseInstanceId } from "../contracts/phase-instance.js";
import type { PlainJsonValue } from "../contracts/plain-json.js";
import type {
  ApplySubmissionKindV1,
  HumanPresentationV1,
  PublicReviewContextV1,
  SemanticActionKindV1,
  SemanticActionOfferV1,
  SemanticNextActionV1,
  SemanticStatusSnapshotV1,
  WorkflowConditionV1,
  WorkflowInvocationV1,
  WorkflowPositionV1,
  WorkflowReopenImpactV1,
  WorkflowResourceV1,
  WorkflowViewV1,
} from "../contracts/semantic-workflow.js";
import type { NextAction, NextActionCode } from "./next-action.js";
import type { TaskStatusV1 } from "./status.js";

export type SemanticProjectionV1 = Readonly<{
  view: WorkflowViewV1;
  internal_offer?: SemanticActionOfferV1;
}>;

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

/** Phase 2 exposes mutations only for the three document-producing workflows. */
export function semanticInvocationEnabled(invocation: WorkflowInvocationV1): boolean {
  return invocation.skill === "archflow-prd" || invocation.skill === "archflow-design" ||
    invocation.skill === "archflow-phase-design";
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

function publicResources(status: TaskStatusV1): readonly WorkflowResourceV1[] {
  return Object.freeze((status.resources ?? []).map(({ role, path, access }) => Object.freeze({ role, path, access })));
}

function reviewContext(status: TaskStatusV1): PublicReviewContextV1 | undefined {
  if (status.review_policy === undefined) return undefined;
  return Object.freeze({
    rubric: Object.freeze({
      schema_version: "1" as const,
      kind: status.review_policy.rubric.kind,
      mode: status.review_policy.rubric.mode,
      criteria: Object.freeze(status.review_policy.rubric.criteria.map((criterion) => Object.freeze({
        id: criterion.id,
        text: criterion.text,
        blocking: criterion.blocking,
      }))),
    }),
    active_rules: Object.freeze((status.constitution?.active_rules ?? []).map((rule) => Object.freeze({
      id: rule.id,
      version: rule.version,
      text: rule.text,
      ...(rule.review_trigger === undefined ? {} : { review_trigger: rule.review_trigger }),
      ...(rule.enforced_by === undefined ? {} : { enforced_by: Object.freeze([...rule.enforced_by]) }),
    }))),
  });
}

function publicPresentation(status: TaskStatusV1): HumanPresentationV1 | undefined {
  const presentation = status.open_gate?.presentation;
  if (presentation === undefined) return undefined;
  return Object.freeze({
    title: presentation.title,
    summary: presentation.summary,
    ...(presentation.details === undefined ? {} : { details: Object.freeze([...presentation.details]) }),
    question: presentation.question,
    options: Object.freeze(presentation.options.map((option) => Object.freeze({ ...option }))),
  });
}

function inspect(detail: string): ProjectionShape {
  return Object.freeze({
    condition: "blocked", headline: "Workflow needs inspection", detail,
    action_kind: "inspect", instruction: detail,
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
          detail: "Enter the bounded production write window before changing the artifact.",
          action_kind: "revise", instruction: "Begin the authorized revision, then return to the client-owned work.",
          expected_submission: "none",
        });
      }
      if (status.step === "produce" && status.status === "running") {
        return Object.freeze({
          condition: "awaiting-client", headline: "Client work is in progress", detail: action.detail,
          action_kind: "submit-work", instruction: "Complete and verify the client-owned work, then submit its result.",
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
        action_kind: "review", instruction: "Run or resume the server-owned independent review action.",
        expected_submission: "none",
      });
    case "triage":
      return snapshot.full_findings.length === 0
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
      return inspect("Initialize or repair the ArchFlow repository before starting this task.");
    case "create-task":
      return Object.freeze({
        condition: "ready", headline: "Task initialization is ready", detail: action.detail,
        action_kind: "initialize-task", instruction: "Create the task from the exact user ask.",
        expected_submission: "task-ask",
      });
    case "resume-exact-intent":
    case "restore-or-record-new-transition":
    case "inspect-retained-receipt":
    case "create-fresh-intent":
    case "resolve-current-authority":
    case "restore-pinned-config":
      return inspect(action.detail);
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
        condition: "awaiting-human", headline: presentation.title, detail: presentation.summary,
        action_kind: "decide", instruction: presentation.question, expected_submission: "decision", presentation,
      });
    }
    case "run-step":
      return mapRunStep(status, action, snapshot);
    case "commit-artifacts":
      if (action.commit_path === undefined || action.commit_message === undefined || action.commit_target_ref === undefined || action.commit_baseline === undefined) {
        return inspect("The authorized design commit is missing authenticated commit facts.");
      }
      return Object.freeze({
        condition: "awaiting-client", headline: "The authorized design commit is ready", detail: action.detail,
        action_kind: "commit", instruction: "Perform the exact client-side Git commit, then request fresh status.",
        commit: Object.freeze({
          path: action.commit_path, message: action.commit_message, target_ref: action.commit_target_ref,
          baseline: action.commit_baseline, requires_human_confirmation: false,
        }),
      });
    case "commit-phase":
      return Object.freeze({
        condition: "awaiting-client", headline: "The authorized implementation commit is ready", detail: action.detail,
        action_kind: "commit",
        instruction: "Use the existing authorized commit procedure, then request fresh status; exact implementation commit facts are not available in this read model.",
      });
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
      return inspect(action.detail);
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

/** Exhaustive, mechanical-data-free projection of one authenticated detailed status snapshot. */
export function projectSemanticStatus(
  snapshot: SemanticStatusSnapshotV1,
  invocation?: WorkflowInvocationV1,
): SemanticProjectionV1 {
  const status = statusFromSnapshot(snapshot);
  let shape: ProjectionShape;
  let reopen: WorkflowReopenImpactV1 | undefined;

  if (invocation?.intent === "reopen") {
    reopen = reopenImpactFor(snapshot, invocation);
    const safe = status.state === "active" && status.open_gate === undefined &&
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
  const offer = owns && canOffer(shape) ? offerFor(snapshot, status, invocation, shape, reopen) : undefined;
  const mismatch = invocation !== undefined && !owns
    ? invocation.skill === "archflow-phase-impl"
      ? " Phase implementation remains on the supported legacy skill workflow in this release; no semantic mutation is offered."
      : ` The invoked skill does not own this current action; continue with the action shown or invoke its owning skill.`
    : "";
  const nextAction: SemanticNextActionV1 = Object.freeze({
    kind: shape.action_kind,
    instruction: shape.instruction,
    ...(offer === undefined ? {} : { offer: semanticOfferToken(offer) }),
    ...(offer === undefined || shape.expected_submission === undefined ? {} : { expected_submission: shape.expected_submission }),
    ...(shape.skill === undefined ? {} : { skill: shape.skill }),
    ...(shape.skill_args === undefined ? {} : { skill_args: Object.freeze([...shape.skill_args]) }),
    ...(shape.commit === undefined ? {} : { commit: shape.commit }),
    ...(reopen === undefined || shape.action_kind !== "reopen" ? {} : { reopen }),
  });
  const position = positionFromPhase(status.phase_instance);
  const context = reviewContext(status);
  const view: WorkflowViewV1 = Object.freeze({
    schema_version: "1",
    task_id: status.task_id,
    condition: shape.condition,
    headline: shape.headline,
    detail: `${shape.detail}${mismatch}`,
    ...(position === undefined ? {} : { position }),
    // A settled re-entry decision is close-only authority. Document write slots become visible
    // only after the separately offered revision-entry transition commits.
    resources: snapshot.revision_checkpoint === undefined ? publicResources(status) : Object.freeze([]),
    next_action: nextAction,
    ...(shape.findings !== true ? {} : { findings: snapshot.full_findings }),
    ...(context === undefined ? {} : { review_context: context }),
    ...(shape.presentation === undefined ? {} : { presentation: shape.presentation }),
  });
  return Object.freeze({ view, ...(offer === undefined ? {} : { internal_offer: offer }) });
}

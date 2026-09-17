import type { PublicReviewContextV1, PublicReviewStrengthV1, SemanticActionOfferV1, SemanticNextActionV1,
  SemanticStatusSnapshotV1, WorkflowInvocationV1, WorkflowResourceV1, WorkflowViewV1 } from "../contracts/semantic-workflow.js";
import { decodePhaseInstance } from "../contracts/phase-instance.js";
import type { PhaseInstanceId } from "../contracts/phase-instance.js";
import type { WorkflowPositionV1 } from "../contracts/semantic-workflow.js";
import type { TaskStatusV1 } from "./status.js";
import { resolveWorkflowDecision, semanticOfferToken, workflowProgress } from "./workflow-decision.js";

export type SemanticProjectionV1 = Readonly<{ view: WorkflowViewV1; internal_offer?: SemanticActionOfferV1 }>;
function positionFromPhase(phase: PhaseInstanceId | undefined): WorkflowPositionV1 | undefined {
  if (phase === undefined) return undefined;
  const decoded = decodePhaseInstance(phase);
  return decoded.kind === "prd" || decoded.kind === "design"
    ? Object.freeze({ kind: decoded.kind })
    : Object.freeze({ kind: decoded.kind, phase: Number(decoded.phase) });
}

function publicResources(status: TaskStatusV1): readonly WorkflowResourceV1[] {
  return Object.freeze((status.resources ?? []).map(({ role, path, access }) => Object.freeze({ role, path, access })));
}

function reviewContext(status: TaskStatusV1): PublicReviewContextV1 | undefined {
  if (status.review_policy === undefined) return undefined;
  const recordedAssignments = status.evidence?.available === true
    ? status.evidence.counter_review_provenance.reviewer_runs?.map((run) => Object.freeze({
      reviewer_id: run.reviewer_id,
      focus: run.focus,
      criterion_ids: Object.freeze([...run.criterion_ids]),
      ...(!("expected_upstream_digests" in run) || run.expected_upstream_digests === undefined
        ? {}
        : { expected_upstream_digests: Object.freeze([...run.expected_upstream_digests]) }),
      ...(!("legacy_confirmations" in run) || run.legacy_confirmations === undefined
        ? {}
        : { legacy_confirmation_finding_ids: Object.freeze(run.legacy_confirmations.map((item) => item.finding_id)) }),
    }))
    : undefined;
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
    ...(recordedAssignments === undefined ? {} : { assignments: Object.freeze(recordedAssignments) }),
    active_rules: Object.freeze((status.constitution?.active_rules ?? []).map((rule) => Object.freeze({
      id: rule.id,
      version: rule.version,
      text: rule.text,
      ...(rule.review_trigger === undefined ? {} : { review_trigger: rule.review_trigger }),
      ...(rule.enforced_by === undefined ? {} : { enforced_by: Object.freeze([...rule.enforced_by]) }),
    }))),
  });
}

/**
 * Projects the strength of the current review evidence from retained provenance and the
 * snapshot's per-attempt rounds. Nothing here is judgment: same-family is a string comparison of
 * recorded families, and a remediation round is any attempt after the first, because the server
 * pins prior triage into every later dispatch of the same phase instance.
 */
function reviewStrength(status: TaskStatusV1, snapshot: SemanticStatusSnapshotV1): PublicReviewStrengthV1 | undefined {
  const evidence = status.evidence;
  if (evidence?.available !== true || status.attempt === undefined) return undefined;
  const provenance = evidence.counter_review_provenance;
  const recordedReviewers = provenance.reviewer_runs?.map((reviewer) => Object.freeze({
    reviewer_id: reviewer.reviewer_id,
    focus: reviewer.focus,
    model: reviewer.model,
    effort: reviewer.effort,
    reviewer_family: reviewer.model_family,
    same_family: reviewer.model_family === provenance.producer_family,
    finding_count: reviewer.finding_ids.length,
  }));
  const reviewers = recordedReviewers ?? [Object.freeze({
    reviewer_id: "general",
    focus: "general" as const,
    model: provenance.model,
    effort: provenance.effort,
    reviewer_family: provenance.model_family,
    same_family: provenance.model_family === provenance.producer_family,
    finding_count: evidence.findings.length,
  })];
  return Object.freeze({
    reviewer_model: provenance.model,
    reviewer_effort: provenance.effort,
    reviewer_family: provenance.model_family,
    producer_family: provenance.producer_family,
    same_family: provenance.model_family === provenance.producer_family,
    attempt: status.attempt,
    remediation_round: status.attempt > 1,
    rounds: Object.freeze((snapshot.review_rounds ?? []).map((round) => Object.freeze({ ...round }))),
    reviewers: Object.freeze(reviewers),
  });
}

/** Exhaustive, mechanical-data-free projection of one authenticated detailed status snapshot. */
export function projectSemanticStatus(
  snapshot: SemanticStatusSnapshotV1,
  invocation?: WorkflowInvocationV1,
  detail: "standard" | "diagnostic" = "standard",
): SemanticProjectionV1 {
  const status = snapshot.status as unknown as TaskStatusV1;
  const decision = resolveWorkflowDecision(snapshot, invocation);
  const { shape, owns, reopen, internal_offer: offer } = decision;
  const mismatch = invocation !== undefined && !owns
    ? ` The invoked skill does not own this current action; continue with the action shown or invoke its owning skill.`
    : "";
  // Informational only: a config change notice never changes the condition or the action kind, so
  // it appends one prose line and the verbatim entries rather than routing through the shape.
  const configChange = status.config_change;
  const configChangeNotice = configChange === undefined ? "" : configChange.length === 1
    ? " Task config changed since the last state transaction (1 field); see config_change."
    : ` Task config changed since the last state transaction (${configChange.length} fields); see config_change.`;
  const nextAction: SemanticNextActionV1 = Object.freeze({
    kind: shape.action_kind,
    instruction: status.restore_targets?.length && shape.action_kind === "inspect"
      ? "For each restore target, run command with args and pass input as JSON on stdin. The helper returns base64 bytes and file type/mode; it does not write files. Verify the decoded content digest, confirm the destination is still missing, then restore exactly that file (100644 means 0644; 100755 means 0755) or create the symlink whose target is the decoded bytes. Stop if any destination now exists. Call archflow_status afterwards."
      : shape.instruction,
    actor: decision.actor,
    ...(shape.action_kind !== "inspect" || !status.restore_targets?.length ? {} : { restore_targets: status.restore_targets }),
    ...(offer === undefined ? {} : { offer: semanticOfferToken(offer) }),
    ...(offer === undefined || shape.expected_submission === undefined ? {} : { expected_submission: shape.expected_submission }),
    ...(shape.skill === undefined ? {} : { skill: shape.skill }),
    ...(shape.skill_args === undefined ? {} : { skill_args: Object.freeze([...shape.skill_args]) }),
    ...(shape.commit === undefined ? {} : { commit: shape.commit }),
    ...(reopen === undefined || shape.action_kind !== "reopen" ? {} : { reopen }),
  });
  const diagnostic = detail === "diagnostic";
  const authoring = shape.action_kind === "begin-work" || shape.action_kind === "submit-work" || shape.action_kind === "revise";
  const baseline = status.next_action.gate_kind === "baseline-adoption" || status.open_gate?.kind === "baseline-adoption";
  const feedback = diagnostic || authoring || shape.action_kind === "triage" ||
    (!baseline && (shape.expected_submission === "gate-summary" || shape.presentation !== undefined));
  const recommendation = diagnostic || (positionFromPhase(status.phase_instance)?.kind === "phase-impl" && authoring) ||
    (positionFromPhase(status.phase_instance)?.kind === "phase-design" && (shape.action_kind === "triage" || shape.action_kind === "start-next-skill"));
  // Revision needs the latest feedback for each reviewer, not every superseded round.
  const previousReports = diagnostic ? snapshot.previous_review_reports
    : authoring && !snapshot.review_reports?.length
      ? [...new Map((snapshot.previous_review_reports ?? []).map(report => [report.reviewer_id, report])).values()]
      : undefined;
  const advice = snapshot.implementation_recommendation;
  const conciseAdvice = !diagnostic && positionFromPhase(status.phase_instance)?.kind === "phase-impl" && advice.status === "ready"
    ? { status: advice.status, model: advice.model, ...(advice.effort === undefined ? {} : { effort: advice.effort }) }
    : advice;
  const position = positionFromPhase(status.phase_instance);
  const context = reviewContext(status);
  const strength = reviewStrength(status, snapshot);
  const progress = detail === "diagnostic" ? workflowProgress(snapshot, decision) : undefined;
  const validationOverrides = snapshot.validation_overrides?.filter(item => diagnostic || item.status !== "granted" || item.current);
  const pushThroughs = snapshot.review_push_throughs?.filter(item => diagnostic || item.status !== "historical");
  const view: WorkflowViewV1 = Object.freeze({
    ...(!diagnostic || progress === undefined ? {} : { progress }),
    schema_version: "1",
    state: decision.state,
    task_id: status.task_id,
    condition: shape.condition,
    headline: shape.headline,
    detail: `${shape.detail}${mismatch}${diagnostic ? configChangeNotice : ""}${status.editorial_revision !== undefined ? " The minor revision reuses the prior review; the final correction has not received another AI review." : ""}`,
    ...(position === undefined ? {} : { position }),
    // A settled re-entry decision is close-only authority. Document write slots become visible
    // only after the separately offered revision-entry transition commits.
    resources: snapshot.revision_checkpoint !== undefined ? Object.freeze([])
      : diagnostic || authoring ? publicResources(status)
      : shape.action_kind === "review" ? publicResources(status).filter(resource => resource.role === "verification-transcript")
      : Object.freeze([]),
    next_action: nextAction,
    ...(!feedback || snapshot.full_findings.length === 0 ? {} : { findings: snapshot.full_findings }),
    ...(!diagnostic || (snapshot.finding_history?.length ?? 0) === 0
      ? {}
      : { finding_history: snapshot.finding_history }),
    ...(!(diagnostic || authoring) || context === undefined ? {} : { review_context: context }),
    ...(!feedback || strength === undefined || snapshot.review_reports !== undefined ? {} : { review_strength: strength }),
    ...(diagnostic && snapshot.review_reports === undefined ? { taxonomy_denial_rates: snapshot.taxonomy_denial_rates } : {}),
    ...(!feedback || !snapshot.review_reports?.length ? {} : { review_reports: snapshot.review_reports }),
    ...(!previousReports?.length ? {} : { previous_review_reports: previousReports }),
    ...(!(diagnostic || status.dispatch_failure !== undefined) || !snapshot.partial_review_reports?.length ? {} : { partial_review_reports: snapshot.partial_review_reports }),
    ...(!feedback || snapshot.review_response === undefined ? {} : { review_response: snapshot.review_response }),
    ...(snapshot.review_revision === undefined ? {} : { review_revision: snapshot.review_revision }),
    ...(!recommendation ? {} : { implementation_recommendation: conciseAdvice }),
    ...(!validationOverrides?.length ? {} : {
      validation_overrides: validationOverrides,
    }),
    ...(!pushThroughs?.length ? {} : {
      review_push_throughs: pushThroughs,
    }),
    ...(shape.presentation === undefined ? {} : { presentation: shape.presentation }),
    ...(status.dispatch_failure === undefined ? {} : { dispatch_failure: status.dispatch_failure }),
    ...(!(diagnostic || authoring || shape.action_kind === "commit") || status.repositories === undefined ? {} : { repositories: status.repositories }),
    ...(!diagnostic || configChange === undefined ? {} : { config_change: configChange }),
  });
  return Object.freeze({ view, ...(offer === undefined ? {} : { internal_offer: offer }) });
}

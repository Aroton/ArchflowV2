import adjudicationOutputSchema from "../contracts/schemas/v1/adjudication.schema.json" with { type: "json" };
import effortReviewOutputSchema from "../contracts/schemas/v1/effort-review.schema.json" with { type: "json" };
import reviewOutputSchema from "../contracts/schemas/v1/review.schema.json" with { type: "json" };

import { canonicalJsonDigest, sha256Bytes, type CanonicalDocument } from "../contracts/canonical.js";
import type { AdjudicationEvidence } from "../contracts/adjudication.js";
import type { TaskStateV1 } from "../contracts/durable-state.js";
import type { ConfigV1 } from "../contracts/config.js";
import type { DispatchFailureRoleV1 } from "../contracts/dispatch-failure.js";
import {
  createDefaultEffortSelectionV2,
  createEffortSelectionV2,
  parseEffortEnvelopeV2,
  type EffortEnvelopeV2,
  type EffortSelectionV2,
} from "../contracts/effort-review.js";
import type { ConstitutionRegistry } from "../contracts/constitution.js";
import { createProjectError, type ProjectError, type ProjectResult } from "../contracts/errors.js";
import { parseSafeInteger, type SafeId, type SafeInteger, type Sha256Digest } from "../contracts/evidence.js";
import {
  createInternalResultExpectation,
  validateProjectResultStructure,
  type CounterReviewConstitutionOutcome,
  type ParsedToolCall,
  type RequestIdentifiedToolCall,
} from "../contracts/mcp-tools.js";
import { parseRepositoryPathClaim } from "../contracts/path-claims.js";
import type { PlainJsonValue } from "../contracts/plain-json.js";
import type { HostIdentity } from "../contracts/hosts.js";
import type {
  ModelFamily,
  ReviewedRepositoryV1,
  ReviewEvidence,
  ReviewFindingV2,
  LegacyReviewFinding,
  ReviewerRunV1,
  RouteOverrideRecord,
  RuleVersionRef,
} from "../contracts/review.js";
import { expectedReviewSummaryV2 } from "../contracts/review.js";
import {
  mintAdjudicationObservation,
  mintReviewObservation,
  serializeDispatch,
  serializeDispatchAll,
} from "../dispatch/cli.js";
import type { RetainedChildOutputStore } from "../dispatch/retained-child-output.js";
import {
  configuredRoute,
  configuredRoutes,
  selectDispatchRouteCandidates,
  selectDispatchRoutes,
  validateSelectedDispatchRoute,
  type DispatchRoute,
  type RoutingRole,
  type SelectedDispatchRoute,
  type SelectedRouteCandidate,
} from "../dispatch/routing.js";
import type { TransactionAuthority } from "../state/authority.js";
import { adjudicationReviewClaim, counterReviewClaim, type ResolvedTaskPath } from "../repository/paths.js";
import type { PreparedEvidenceResult } from "../state/evidence-results.js";
import type {
  InternalResultInstallation,
  PreparedResultTransaction,
  TransactionDependencies,
  TransactionOutcome,
} from "../state/transaction.js";
import {
  prepareResultInstallation,
  runStateTransaction,
} from "../state/transaction.js";
import { identifyTransactionRequest } from "../state/request.js";
import { planStateTransition } from "../state/transitions.js";
import {
  AdjudicationServiceError,
  canonicalRuleRefs,
  crossCheckRuleFindings,
  type AdjudicationDispatchResult,
} from "./adjudication.js";
import {
  buildAdjudicationEnvelope,
  buildEffortEnvelope,
  type AdjudicationEnvelopeInput,
  type AdjudicationUpstreamInput,
  type DispatchEnvelope,
  type DispatchSubject,
  type ReviewWorkspaceBinding,
  type ReviewEnvelopeSeed,
} from "./envelopes.js";
import { buildReviewEnvelopeWithCap, priorTriageContextEntry, type PriorTriageRecord } from "./pinned-context.js";
import { reviewerOwnsFinding, taggedFindingId } from "./reviewer-tags.js";
import { reviewAssignment, type CounterReviewPhaseKind } from "./rubrics.js";

export type CounterReviewDispatchResult = Readonly<{
  cli_version: string;
  extracted_output_bytes: Uint8Array;
}>;

export type ActiveReviewerFindingSet = Readonly<{
  tag: string;
  schema_version: "1" | "2";
  findings: readonly (ReviewFindingV2 | LegacyReviewFinding)[];
}>;

/**
 * Merges one active round in configured reviewer order. Fresh dispatch is V2-only; the explicit
 * guard prevents an accidentally retained or replayed V1 child from being normalized into active
 * evidence. Finding IDs keep the historical tag/disambiguation behavior.
 */
export function aggregateActiveReviewerFindings(
  reviewers: readonly ActiveReviewerFindingSet[],
  totalReviewers = reviewers.length,
): Readonly<{
  findings: readonly ReviewFindingV2[];
  finding_ids_by_reviewer: readonly (readonly string[])[];
  summary: ReturnType<typeof expectedReviewSummaryV2>;
}> {
  const findings: ReviewFindingV2[] = [];
  const findingIdsByReviewer: string[][] = reviewers.map(() => []);
  const seenIds = new Set<string>();
  reviewers.forEach((reviewer, reviewerIndex) => {
    if (reviewer.schema_version !== "2" || reviewer.findings.some((finding) => !("claim_type" in finding))) {
      throw new TypeError("fresh counter-review observations must all use active review schema version 2");
    }
    for (const finding of reviewer.findings as readonly ReviewFindingV2[]) {
      const rawId = taggedFindingId(reviewer.tag, totalReviewers, finding.finding_id);
      let uniqueId = rawId;
      let disambiguator = 2;
      while (seenIds.has(uniqueId)) {
        uniqueId = `${rawId}-${String(disambiguator)}`;
        disambiguator += 1;
      }
      seenIds.add(uniqueId);
      findingIdsByReviewer[reviewerIndex]!.push(uniqueId);
      findings.push({ ...finding, finding_id: uniqueId });
    }
  });
  const frozenFindings = Object.freeze(findings.map((finding) => Object.freeze(finding)));
  return Object.freeze({
    findings: frozenFindings,
    finding_ids_by_reviewer: Object.freeze(findingIdsByReviewer.map((ids) => Object.freeze(ids))),
    summary: expectedReviewSummaryV2(frozenFindings),
  });
}

/** Reduces parser detail to a stable, non-content-bearing diagnostic safe for project errors. */
export function adjudicationOutputIssueCode(error: unknown): string {
  if (error instanceof SyntaxError) return "adjudication-json-invalid";
  const issueMessages = error !== null && typeof error === "object" && "issues" in error && Array.isArray(error.issues)
    ? error.issues.flatMap((issue) =>
      issue !== null && typeof issue === "object" && "message" in issue && typeof issue.message === "string"
        ? [issue.message]
        : [])
    : [];
  const message = [...issueMessages, error instanceof Error ? error.message : ""].join(" | ");
  if (/exactly cover approved_upstream_digests/u.test(message)) return "adjudication-upstream-coverage";
  if (/must be sorted and unique/u.test(message)) return "adjudication-finding-duplicate";
  if (/Unrecognized key/u.test(message)) return "adjudication-unexpected-fields";
  if (/does not match observation capability/u.test(message)) return "adjudication-binding-mismatch";
  return "adjudication-schema-invalid";
}

/** The reviewer-side counterpart of {@link adjudicationOutputIssueCode}: stable, content-free. */
export function reviewOutputIssueCode(error: unknown): string {
  if (error instanceof SyntaxError) return "review-json-invalid";
  const message = error instanceof Error ? error.message : "";
  if (/does not match observation capability/u.test(message)) return "review-binding-mismatch";
  return "review-schema-invalid";
}

export type RunCounterReviewDependencies = Readonly<{
  transaction: TransactionDependencies;
  dispatch: (
    route: DispatchRoute,
    envelope: DispatchEnvelope,
    outputSchema: PlainJsonValue,
  ) => Promise<CounterReviewDispatchResult>;
  prepare_evidence: (
    evidence: ReviewEvidence,
    measuredAtRevision: SafeInteger,
  ) => Promise<ProjectResult<PreparedEvidenceResult>>;
  reobserve_projection_digest: () => Promise<ProjectResult<ReviewEvidence["subject_digest"]>>;
  /** The default process-wide FIFO, or a direct runner when the caller already owns that FIFO. */
  serialize_dispatch?: <T>(operation: () => Promise<T>) => Promise<T>;
  /** Group form of {@link serialize_dispatch}: one FIFO link carrying all parallel children of one review. */
  serialize_dispatch_all?: <T>(operations: readonly (() => Promise<T>)[]) => Promise<T[]>;
  /**
   * Validated outputs this round's earlier children already produced. A child whose retained
   * output still binds to the exact envelope and route is not dispatched again; absent, every
   * child dispatches fresh.
   */
  retained_outputs?: RetainedChildOutputStore;
  /** Best-effort runtime observation seam. It must never replace the original routing/dispatch error. */
  observe_failure?: (
    role: DispatchFailureRoleV1,
    selected: SelectedRouteCandidate | undefined,
    error: unknown,
  ) => void | Promise<void>;
}>;

/** Phase-design-only selector plan; configuration/invocation chooses the selector, never the implementation agent. */
export type EffortReviewPlan = Readonly<{
  envelope: EffortEnvelopeV2;
  /** Selector setup failed before dispatch; emit the fixed default without retrying. */
  force_default?: true;
}>;

/**
 * Everything the constitution review needs beyond what the rubric review already carries. The
 * handler derives all of it from durable authority — pinned constitution, approved upstream
 * documents, a distinct result identity, and the same sealed repository view used by the rubric
 * reviewer. Implementation source bytes stay out of both control envelopes.
 */
export type ConstitutionReviewPlan = Readonly<{
  registry: ConstitutionRegistry;
  pinned_constitution_digest: Sha256Digest;
  rules: AdjudicationEnvelopeInput["rules"];
  approved_upstreams: readonly AdjudicationUpstreamInput[];
  approved_upstream_digests: readonly Sha256Digest[];
  invocation_id: SafeId;
  result_id: SafeId;
  workspace: ReviewWorkspaceBinding;
  dispatch: (
    route: DispatchRoute,
    envelope: ReturnType<typeof buildAdjudicationEnvelope>,
    outputSchema: PlainJsonValue,
  ) => Promise<AdjudicationDispatchResult>;
  /**
   * Prepares the constitution evidence result measured against the same pre-commit retained-byte
   * base as the review result: the durable-state accounting reader cannot see either sibling
   * until the shared transaction commits, so both manifests measure at the same revision and the
   * install-time staleness check re-derives exactly this value.
   */
  prepare_evidence: (
    evidence: AdjudicationEvidence,
    measuredAtRevision: SafeInteger,
  ) => Promise<ProjectResult<PreparedEvidenceResult>>;
}>;

export type RunCounterReviewInput = Readonly<{
  authority: TransactionAuthority;
  call: Extract<ParsedToolCall, { name: "archflow_counter_review" }>;
  config: ConfigV1;
  phase_kind: keyof NonNullable<ConfigV1["overrides"]>;
  producer_family: ModelFamily;
  host?: HostIdentity;
  measured_at_revision: SafeInteger;
  /** Ordered trusted pins projected from the same repository-view plan as the child workspace. */
  repositories: readonly ReviewedRepositoryV1[];
  envelope: ReviewEnvelopeSeed;
  projection_digest: ReviewEvidence["subject_digest"];
  /**
   * The structured prior-triage record when this round is a remediation of an earlier one. It
   * decides which reviewers run (only those with accepted findings to confirm) and scopes each
   * reviewer's pinned record to the findings it raised.
   */
  prior_triage?: PriorTriageRecord;
  /** Present exactly for fresh phase-design review rounds. */
  effort?: EffortReviewPlan;
  /**
   * Present exactly when the pinned constitution has active rules. The server, not the caller,
   * decides this: with a plan the call runs the constitution review as a second server-dispatched
   * review and commits both results in one transaction; without one the result reports the
   * constitution review as not-run.
   */
  constitution?: ConstitutionReviewPlan;
}>;

/**
 * Everything the atomic commit needs from the dispatch stage: the identified request, the fresh
 * review evidence, the optional constitution evidence bound to it, and the prepared installation
 * handles. Passed explicitly so the transaction planner is an ordinary function of the re-read
 * current state rather than a closure over the dispatch flow's locals.
 */
type CounterReviewCommitInputs = Readonly<{
  task_id: TransactionAuthority["task_id"];
  intent_id: RunCounterReviewInput["call"]["input"]["intent_id"];
  request_digest: Sha256Digest;
  review_evidence: ReviewEvidence;
  constitution_evidence: AdjudicationEvidence | undefined;
  result_reference: PreparedEvidenceResult["reference"];
  result_installation: InternalResultInstallation;
  constitution_reference: PreparedEvidenceResult["reference"] | undefined;
  constitution_installation: InternalResultInstallation | undefined;
}>;

/**
 * Plans the single transaction that retains the fresh review — and, when present, the
 * constitution result bound to it — against the re-read current state: the success summary, the
 * internal result expectation, and the counter_review state transition, all committed together
 * or not at all.
 */
async function planCounterReviewCommit(
  inputs: CounterReviewCommitInputs,
  current: CanonicalDocument<TaskStateV1>,
  call: Extract<RequestIdentifiedToolCall, { readonly name: "archflow_counter_review" }>,
): Promise<ProjectResult<PreparedResultTransaction<"archflow_counter_review">>> {
  const constitutionEvidence = inputs.constitution_evidence;
  const revision = parseSafeInteger(current.value.revision + 1);
  const constitutionOutcome: CounterReviewConstitutionOutcome = constitutionEvidence === undefined
    ? Object.freeze({
      status: "not-run" as const,
      reason: "no-active-constitution-rules" as const,
    })
    : Object.freeze({
      status: "evaluated" as const,
      path: parseRepositoryPathClaim(`.archflow/runtime/tasks/${current.value.task_id}/${adjudicationReviewClaim(current.value.phase_instance)}`),
      constitution: constitutionEvidence.constitution,
      drift: constitutionEvidence.drift,
      triggers: canonicalRuleRefs([
        ...constitutionEvidence.matched_rule_versions,
        ...constitutionEvidence.uncertain_rule_versions,
      ]),
    });
  const commonSuccess = {
    path: parseRepositoryPathClaim(`.archflow/runtime/tasks/${current.value.task_id}/${counterReviewClaim(current.value.phase_instance)}`),
    constitution: constitutionOutcome,
    revision,
    request_digest: inputs.request_digest,
  } as const;
  const success = inputs.review_evidence.schema_version === "2"
    ? Object.freeze({
      ...commonSuccess,
      verdict: inputs.review_evidence.verdict,
      total_findings: inputs.review_evidence.total_findings,
      partition_counts: inputs.review_evidence.partition_counts,
    })
    : Object.freeze({
      ...commonSuccess,
      verdict: inputs.review_evidence.verdict,
      blocking_count: inputs.review_evidence.blocking_count,
    });
  const expectation = createInternalResultExpectation({
    schema_version: "1",
    tool: "archflow_counter_review",
    task_id: inputs.task_id,
    intent_id: inputs.intent_id,
    input_fingerprint: inputs.result_reference.input_fingerprint,
    request_digest: inputs.request_digest,
    result_id: inputs.result_reference.result_id,
    resulting_revision: revision,
    success,
  });
  const result = validateProjectResultStructure(call, {
    schema_version: "1",
    ok: true,
    value: success,
  });
  const next = planStateTransition({
    current: current.value,
    target: {
      phase_instance: current.value.phase_instance,
      step: "counter_review",
      status: "succeeded",
      attempt: current.value.attempt,
      input_fingerprint: inputs.result_reference.input_fingerprint,
    },
    recomputed_input_fingerprint: inputs.result_reference.input_fingerprint,
    result_reference: inputs.result_reference,
    ...(inputs.constitution_reference === undefined
      ? {}
      : { constitution_result_reference: inputs.constitution_reference }),
  });
  if (!next.ok) return next;
  return {
    schema_version: "1",
    ok: true,
    value: {
      expectation,
      result,
      next_state: next.value,
      result_installation: inputs.result_installation,
      ...(inputs.constitution_installation === undefined
        ? {}
        : { constitution_installation: inputs.constitution_installation }),
    },
  };
}

/**
 * Runs a fresh server-dispatched review (opposite-family by default, same-family only by explicit
 * config) — and, when the pinned constitution has active rules, the constitution review bound to
 * that fresh evidence — then retains the validated evidence atomically. A fail verdict remains a
 * successful result: it records blocking findings and never manufactures advancement.
 *
 * A call may carry a `route_override`, which substitutes the dispatched route for this call only
 * so a reviewer CLI outage does not strand the task. The pinned config is never amended; the
 * override is validated exactly like a pinned route and recorded on the evidence it produces.
 */
export async function runCounterReview(
  dependencies: RunCounterReviewDependencies,
  input: RunCounterReviewInput,
): Promise<ProjectResult<Readonly<{
  transaction: TransactionOutcome<"archflow_counter_review">;
  evidence: ReviewEvidence;
  constitution_evidence?: AdjudicationEvidence;
}>>> {
  const envelopeRubricDigest = canonicalJsonDigest(input.envelope.rubric as never);
  if (
    input.producer_family !== input.envelope.subject.producer_family ||
    input.envelope.subject.rubric_digest !== envelopeRubricDigest
  ) {
    throw new TypeError("counter-review subject is not derived from the server-owned request");
  }
  const observeFailure = async (
    role: DispatchFailureRoleV1,
    selected: SelectedRouteCandidate | undefined,
    error: unknown,
  ): Promise<void> => {
    // Runtime diagnostics are observation-only. A failure to record one cannot disguise or
    // replace the routing/dispatch failure the semantic caller must receive.
    try {
      await dependencies.observe_failure?.(role, selected, error);
    } catch {
      // Best effort by contract.
    }
  };
  type OverrideableRoutingRole = Exclude<RoutingRole, "effort-reviewer">;
  const selectRoutes = async (
    role: OverrideableRoutingRole,
  ): Promise<readonly Readonly<{ candidate: SelectedRouteCandidate; selection: SelectedDispatchRoute }>[]> => {
    let currentCandidate: SelectedRouteCandidate | undefined;
    try {
      const candidates = selectDispatchRouteCandidates(
        input.config,
        input.phase_kind,
        role,
        input.call.input.invocation_routes?.[role],
        input.call.input.route_override?.[role],
        input.host,
      );
      return Object.freeze(candidates.map((candidate) => {
        currentCandidate = candidate;
        return Object.freeze({ candidate, selection: validateSelectedDispatchRoute(candidate) });
      }));
    } catch (error) {
      await observeFailure(role, currentCandidate, error);
      throw error;
    }
  };
  const dispatchObserved = async <T>(
    role: DispatchFailureRoleV1,
    selected: Readonly<{ candidate: SelectedRouteCandidate; selection: SelectedDispatchRoute }>,
    dispatch: (route: DispatchRoute) => Promise<T>,
  ): Promise<T> => {
    try {
      return await dispatch(selected.selection.route);
    } catch (error) {
      await observeFailure(role, selected.candidate, error);
      throw error;
    }
  };
  // Recorded on the evidence only when the dispatched route actually displaced the pinned one,
  // so the deviation and the human's reason for it are legible at the gate that reads it.
  const overrideRecordFor = (role: OverrideableRoutingRole): RouteOverrideRecord | undefined => {
    const declared = input.call.input.route_override;
    if (declared?.[role] === undefined) return undefined;
    // Read rather than resolve: the displaced route is reported as configured, and a role with no
    // pinned route at all records the reason alone rather than failing the dispatch.
    const pinned = configuredRoute(input.config, input.phase_kind, role, input.host);
    return Object.freeze({
      reason: declared.reason,
      ...(pinned === undefined
        ? {}
        : {
          pinned_model: pinned.model,
          pinned_effort: pinned.effort,
          ...(pinned.provider === undefined ? {} : { pinned_provider: pinned.provider }),
        }),
    });
  };
  const reviewOverride = overrideRecordFor("counter-reviewer");
  const testReviewOverride = overrideRecordFor("test-reviewer");
  // The server stamps the durable attempt counter into the child-visible subject from the same
  // transaction authority the dispatch runs under, so the round number is never a caller claim.
  const subject: DispatchSubject = Object.freeze({
    ...input.envelope.subject,
    attempt: input.authority.context.attempt,
  });
  const serializeAll = dependencies.serialize_dispatch_all ??
    (dependencies.serialize_dispatch ?
      async <T>(ops: readonly (() => Promise<T>)[]) => Promise.all(ops.map((op) => op())) :
      serializeDispatchAll);
  const plan = input.constitution;
  // All routes are selected before children spend tokens, so a bad route fails before launch.
  const configuredReviewRoutes = await selectRoutes("counter-reviewer");
  const specialistApplicable = input.phase_kind === "phase-design" || input.phase_kind === "phase-impl";
  const testReviewDeclared = configuredRoutes(input.config, input.phase_kind, "test-reviewer", input.host).length > 0 ||
    input.call.input.invocation_routes?.["test-reviewer"] !== undefined ||
    input.call.input.route_override?.["test-reviewer"] !== undefined;
  const configuredTestRoutes = specialistApplicable && testReviewDeclared
    ? await selectRoutes("test-reviewer")
    : Object.freeze([]);
  const constitutionRoutes = plan === undefined ? undefined : await selectRoutes("adjudicator");
  const constitutionRoute = constitutionRoutes?.[0];
  const effortPlan = input.effort;
  if ((input.phase_kind === "phase-design") !== (effortPlan !== undefined)) {
    throw new TypeError("fresh phase-design review requires exactly one effort plan");
  }
  const parsedEffortEnvelope = effortPlan === undefined ? undefined : parseEffortEnvelopeV2(effortPlan.envelope);
  if (parsedEffortEnvelope !== undefined && (
    parsedEffortEnvelope.task_id !== subject.task_id ||
    parsedEffortEnvelope.phase_instance !== subject.phase_instance ||
    parsedEffortEnvelope.attempt !== subject.attempt ||
    parsedEffortEnvelope.subject_digest !== subject.subject_digest ||
    parsedEffortEnvelope.input_fingerprint !== subject.input_fingerprint ||
    canonicalJsonDigest(parsedEffortEnvelope.repositories as never) !== canonicalJsonDigest(input.repositories as never)
  )) throw new TypeError("effort plan is not bound to the counter-review subject and repository pins");
  // Effort selection is advisory and best-effort. Its route is isolated from ordinary route
  // prevalidation so any selector-only problem collapses to the fixed default profile.
  let effortRoute: Readonly<{ candidate: SelectedRouteCandidate; selection: SelectedDispatchRoute }> | undefined;
  if (parsedEffortEnvelope !== undefined && effortPlan?.force_default !== true) {
    try {
      const candidate = selectDispatchRouteCandidates(
        input.config,
        input.phase_kind,
        "effort-reviewer",
        input.call.input.invocation_routes?.["effort-reviewer"],
        undefined,
        input.host,
      )[0];
      if (candidate !== undefined) effortRoute = Object.freeze({ candidate, selection: validateSelectedDispatchRoute(candidate) });
    } catch {
      effortRoute = undefined;
    }
  }

  // Reviewer identity is the tag stamped on its findings, fixed by position in the configured
  // route list so it survives rounds that dispatch only a subset of reviewers.
  const specialistActive = configuredTestRoutes.length > 0;
  const phaseKind = input.phase_kind as CounterReviewPhaseKind;
  const generalRoutes = configuredReviewRoutes.map((routeEntry, index) => {
    // Number every general reviewer whenever the configured list has siblings. A bare `general`
    // would also prefix-match `general-2-*` finding IDs during remediation ownership checks.
    const reviewerId = configuredReviewRoutes.length === 1 ? "general" : `general-${String(index + 1)}`;
    return Object.freeze({
      ...routeEntry,
      role: "counter-reviewer" as const,
      tag: reviewerId,
      assignment: reviewAssignment(reviewerId, "general", phaseKind, input.envelope.rubric, specialistActive),
    });
  });
  const testRoutes = configuredTestRoutes.map((routeEntry) => Object.freeze({
    ...routeEntry,
    role: "test-reviewer" as const,
    tag: "test",
    assignment: reviewAssignment("test", "tests", phaseKind, input.envelope.rubric, specialistActive),
  }));
  const taggedRoutes = Object.freeze([...generalRoutes, ...testRoutes]);
  const totalReviewers = taggedRoutes.length;
  const sharedPriorTriage = input.envelope.context.find((entry) => entry.kind === "prior-triage");
  const priorTriage = sharedPriorTriage === undefined ? undefined : input.prior_triage;
  // A remediation round dispatches only owners of the latest accepted findings. Rejected and
  // editorial findings are closed. If attribution fails, the first configured reviewer confirms
  // every accepted intent; dispatching every reviewer would turn remediation into another sweep.
  const dispositioned = priorTriage?.current ?? [];
  const owners = (findingId: string) =>
    taggedRoutes.filter((routeEntry) => reviewerOwnsFinding(routeEntry.tag, totalReviewers, findingId));
  const unattributed = priorTriage !== undefined &&
    dispositioned.some((disposition) => owners(disposition.finding_id).length === 0);
  const reviewRoutes = priorTriage === undefined
    ? taggedRoutes
    : unattributed
      ? taggedRoutes.slice(0, 1)
    : taggedRoutes.filter((routeEntry) => dispositioned.some((disposition) =>
      reviewerOwnsFinding(routeEntry.tag, totalReviewers, disposition.finding_id)));
  const assignmentFor = (routeEntry: (typeof taggedRoutes)[number]) =>
    unattributed && routeEntry.role === "counter-reviewer"
      ? reviewAssignment(routeEntry.tag, "general", phaseKind, input.envelope.rubric, false)
      : routeEntry.assignment;
  const envelopeFor = (routeEntry: (typeof taggedRoutes)[number]): DispatchEnvelope => {
    const assignment = assignmentFor(routeEntry);
    if (priorTriage === undefined || unattributed) {
      return buildReviewEnvelopeWithCap({ ...input.envelope, assignment, subject });
    }
    const scoped = priorTriageContextEntry(priorTriage, (findingId) =>
      reviewerOwnsFinding(routeEntry.tag, totalReviewers, findingId));
    return buildReviewEnvelopeWithCap({
      ...input.envelope,
      assignment,
      subject,
      context: input.envelope.context.map((entry) => entry.kind === "prior-triage" ? scoped : entry),
    });
  };
  const activeAssignments = reviewRoutes.map(assignmentFor);
  const reviewEnvelopes = reviewRoutes.map(envelopeFor);
  // The first dispatched reviewer's envelope is the round: the merged evidence carries its digest
  // and the constitution child binds to it, so every retained record of the round agrees.
  const envelope = reviewEnvelopes[0]!;
  // The constitution dispatch binds to the ROUND, not to the review's output payload: the review
  // envelope digest is stamped before either child dispatches, so the children fly concurrently.
  const constitutionSubject = plan === undefined || constitutionRoute === undefined
    ? undefined
    : Object.freeze({
      task_id: input.envelope.subject.task_id,
      phase_instance: input.envelope.subject.phase_instance,
      role: "adjudication" as const,
      step: "adjudicate" as const,
      subject_digest: input.envelope.subject.subject_digest,
      input_fingerprint: input.envelope.subject.input_fingerprint,
      pinned_constitution_digest: plan.pinned_constitution_digest,
      approved_upstream_digests: plan.approved_upstream_digests,
      source_review_envelope_digest: envelope.digest,
      invocation_id: plan.invocation_id,
      result_id: plan.result_id,
    });
  const constitutionEnvelope = constitutionSubject === undefined || plan === undefined
    ? undefined
    : buildAdjudicationEnvelope({
      artifact: input.envelope.artifact,
      rules: plan.rules,
      source_review_envelope_digest: envelope.digest,
      approved_upstreams: plan.approved_upstreams,
      workspace: plan.workspace,
      subject: constitutionSubject,
    });
  const effortEnvelope = parsedEffortEnvelope === undefined ? undefined : buildEffortEnvelope(parsedEffortEnvelope);

  // Each child dispatches, validates, and retains its own output, and never rejects: the round
  // settles only after every child has finished, so one failure cannot discard its siblings'
  // valid work or dispose the shared workspace under them. A retry of the same round then
  // re-dispatches only the children without a retained output for the identical envelope.
  type ReviewObservation = ReturnType<typeof mintReviewObservation>;
  type ChildValue =
    | Readonly<{ kind: "review"; observation: ReviewObservation }>
    | Readonly<{ kind: "effort"; assessment: EffortSelectionV2 }>
    | Readonly<{ kind: "adjudication"; evidence: AdjudicationEvidence }>;
  type ChildOutcome =
    | Readonly<{ ok: true; value: ChildValue }>
    | Readonly<{ ok: false; error: unknown; project_error?: ProjectError }>;
  const retained = dependencies.retained_outputs;
  // Failures in the order they FINISHED, so the surfaced error names the same child the
  // failure-observation slot recorded first.
  const failures: Extract<ChildOutcome, { ok: false }>[] = [];
  const noteFailure = (outcome: ChildOutcome): ChildOutcome => {
    if (!outcome.ok) failures.push(outcome);
    return outcome;
  };

  const reviewOp = (
    routeEntry: (typeof reviewRoutes)[number],
    reviewEnvelope: DispatchEnvelope,
  ) => async (): Promise<ChildOutcome> => {
    const route = routeEntry.selection.route;
    const routeOverride = routeEntry.role === "test-reviewer" ? testReviewOverride : reviewOverride;
    const mint = (dispatched: CounterReviewDispatchResult): ReviewObservation => mintReviewObservation({
      subject,
      adapter: route.adapter,
      cli_version: dispatched.cli_version,
      route,
      route_source: routeEntry.selection.source,
      envelope_input_digest: reviewEnvelope.digest,
      extracted_output_bytes: dispatched.extracted_output_bytes,
      repositories: input.repositories,
      ...(routeOverride === undefined ? {} : { route_override: routeOverride }),
    });
    const binding = { envelope_digest: reviewEnvelope.digest, role: routeEntry.role, selection: routeEntry.selection };
    const kept = await retained?.read(binding);
    if (kept !== undefined) {
      try {
        return { ok: true, value: { kind: "review", observation: mint(kept) } };
      } catch {
        // Retained bytes that no longer validate are a miss, not a failure: dispatch fresh.
      }
    }
    let dispatched: CounterReviewDispatchResult;
    try {
      dispatched = await dispatchObserved(routeEntry.role, routeEntry, (selectedRoute) =>
        dependencies.dispatch(selectedRoute, reviewEnvelope, reviewOutputSchema as PlainJsonValue));
    } catch (error) {
      return { ok: false, error };
    }
    let observation: ReviewObservation;
    try {
      observation = mint(dispatched);
    } catch (error) {
      // Invalid output is not a classified dispatch failure, so no observation slot is written.
      return {
        ok: false,
        error,
        project_error: createProjectError("MODEL_OUTPUT_INVALID", {
          adapter: route.adapter,
          attempt: 1,
          issue_code: reviewOutputIssueCode(error),
        }),
      };
    }
    await retained?.write(binding, dispatched);
    return { ok: true, value: { kind: "review", observation } };
  };

  const ops: (() => Promise<ChildOutcome>)[] = reviewRoutes.map((routeEntry, index) => reviewOp(routeEntry, reviewEnvelopes[index]!));
  if (effortPlan !== undefined && parsedEffortEnvelope !== undefined && effortEnvelope !== undefined && effortRoute !== undefined) {
    const route = effortRoute.selection.route;
    const mint = (dispatched: CounterReviewDispatchResult): EffortSelectionV2 => createEffortSelectionV2(
      JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(dispatched.extracted_output_bytes)),
      parsedEffortEnvelope,
      {
        adapter: route.adapter,
        cli_version: dispatched.cli_version,
        model_family: route.family,
        model: route.model,
        effort: route.effort,
        invocation_id: parsedEffortEnvelope.invocation_id,
        result_id: parsedEffortEnvelope.result_id,
        envelope_input_digest: effortEnvelope.digest,
        observed_output_digest: sha256Bytes(dispatched.extracted_output_bytes),
        ...(route.provider === undefined ? {} : { provider: route.provider }),
        route_source: effortRoute.selection.source,
        repositories: input.repositories,
      },
    );
    const binding = { envelope_digest: effortEnvelope.digest, role: "effort-reviewer" as const, selection: effortRoute.selection };
    ops.push(async (): Promise<ChildOutcome> => {
      const kept = await retained?.read(binding);
      if (kept !== undefined) {
        try {
          return { ok: true, value: { kind: "effort", assessment: mint(kept) } };
        } catch {
          // A stale or invalid retained result is an exact-cache miss.
        }
      }
      let dispatched: CounterReviewDispatchResult;
      try {
        dispatched = await dependencies.dispatch(route, effortEnvelope, effortReviewOutputSchema as PlainJsonValue);
      } catch {
        return { ok: true, value: { kind: "effort", assessment: createDefaultEffortSelectionV2(parsedEffortEnvelope) } };
      }
      let assessment: EffortSelectionV2;
      try {
        assessment = mint(dispatched);
      } catch {
        return { ok: true, value: { kind: "effort", assessment: createDefaultEffortSelectionV2(parsedEffortEnvelope) } };
      }
      await retained?.write(binding, dispatched);
      return { ok: true, value: { kind: "effort", assessment } };
    });
  }
  if (
    plan !== undefined && constitutionRoute !== undefined &&
    constitutionSubject !== undefined && constitutionEnvelope !== undefined
  ) {
    const constitutionOverride = overrideRecordFor("adjudicator");
    const route = constitutionRoute.selection.route;
    const mint = (dispatched: CounterReviewDispatchResult): AdjudicationEvidence => crossCheckRuleFindings(
      plan.registry,
      mintAdjudicationObservation({
        subject: constitutionSubject,
        adapter: route.adapter,
        cli_version: dispatched.cli_version,
        route,
        route_source: constitutionRoute.selection.source,
        envelope_input_digest: constitutionEnvelope.digest,
        extracted_output_bytes: dispatched.extracted_output_bytes,
        repositories: input.repositories,
        ...(constitutionOverride === undefined ? {} : { route_override: constitutionOverride }),
      }).evidence,
      route.adapter,
    );
    const binding = { envelope_digest: constitutionEnvelope.digest, role: "adjudicator" as const, selection: constitutionRoute.selection };
    ops.push(async (): Promise<ChildOutcome> => {
      const kept = await retained?.read(binding);
      if (kept !== undefined) {
        try {
          return { ok: true, value: { kind: "adjudication", evidence: mint(kept) } };
        } catch {
          // Same as the reviewer arm: a retained output that no longer validates dispatches fresh.
        }
      }
      let dispatched: CounterReviewDispatchResult;
      try {
        dispatched = await dispatchObserved("adjudicator", constitutionRoute, (selectedRoute) =>
          plan.dispatch(selectedRoute, constitutionEnvelope, adjudicationOutputSchema as PlainJsonValue));
      } catch (error) {
        return { ok: false, error };
      }
      let evidence: AdjudicationEvidence;
      try {
        evidence = mint(dispatched);
      } catch (error) {
        return {
          ok: false,
          error,
          project_error: error instanceof AdjudicationServiceError
            ? error.project_error
            : createProjectError("MODEL_OUTPUT_INVALID", {
              adapter: route.adapter,
              attempt: 1,
              issue_code: adjudicationOutputIssueCode(error),
            }),
        };
      }
      await retained?.write(binding, dispatched);
      return { ok: true, value: { kind: "adjudication", evidence } };
    });
  }

  const settled = await serializeAll(ops.map((op) => async () => noteFailure(await op())));
  // Surface the first failure that finished. Dispatch and routing errors are rethrown so the
  // handler maps them exactly as before; invalid model output is a project error naming the
  // adapter and a content-free issue code.
  const failed = failures[0];
  if (failed !== undefined) {
    if (failed.project_error !== undefined) {
      return { schema_version: "1", ok: false, error: failed.project_error };
    }
    throw failed.error;
  }
  const singleObservations: ReviewObservation[] = [];
  let constitutionEvidence: AdjudicationEvidence | undefined;
  let effortAssessment: EffortSelectionV2 | undefined = parsedEffortEnvelope === undefined
    ? undefined
    : createDefaultEffortSelectionV2(parsedEffortEnvelope);
  for (const outcome of settled) {
    if (!outcome.ok) continue;
    if (outcome.value.kind === "review") singleObservations.push(outcome.value.observation);
    else if (outcome.value.kind === "effort") effortAssessment = outcome.value.assessment;
    else constitutionEvidence = outcome.value.evidence;
  }
  if (singleObservations.length !== reviewRoutes.length) {
    throw new TypeError("counter-review settled without an observation for every selected reviewer");
  }
  if (singleObservations.some((observation) => observation.evidence.schema_version !== "2")) {
    throw new TypeError("fresh counter-review observations must all use active review schema version 2");
  }
  if (effortPlan !== undefined && effortAssessment === undefined) {
    throw new TypeError("phase-design counter-review settled without an effort assessment");
  }

  const aggregated = aggregateActiveReviewerFindings(singleObservations.map((observation, index) => ({
    tag: reviewRoutes[index]!.tag,
    schema_version: observation.evidence.schema_version,
    findings: observation.evidence.findings,
  })), totalReviewers);
  const allFindings = aggregated.findings;
  const ownedFindingIds = aggregated.finding_ids_by_reviewer;

  const matchedMap = new Map<string, RuleVersionRef>();
  for (const obs of singleObservations) {
    for (const ruleRef of obs.evidence.matched_rule_versions) {
      matchedMap.set(`${ruleRef.rule_id}:${ruleRef.rule_version}`, ruleRef);
    }
  }
  const mergedMatchedRules = [...matchedMap.values()].sort((a, b) => a.rule_id.localeCompare(b.rule_id));

  const mergedSummary = aggregated.summary;

  const primaryObs = singleObservations[0]!;
  const reviewerRuns: ReviewerRunV1[] = singleObservations.map((obs, index) => {
    const evidence = obs.evidence;
    const routeEntry = reviewRoutes[index]!;
    const assignment = activeAssignments[index]!;
    if (evidence.route_source === undefined) {
      throw new TypeError("fresh reviewer evidence must carry route provenance");
    }
    return Object.freeze({
      reviewer_id: assignment.reviewer_id,
      focus: assignment.focus,
      routing_role: routeEntry.role,
      criterion_ids: Object.freeze([...assignment.criterion_ids]),
      rubric_digest: evidence.rubric_digest,
      model_family: evidence.model_family,
      model: evidence.model,
      effort: evidence.effort,
      adapter: evidence.adapter,
      cli_version: evidence.cli_version,
      invocation_id: evidence.invocation_id,
      envelope_input_digest: evidence.envelope_input_digest,
      observed_output_digest: evidence.observed_output_digest,
      finding_ids: Object.freeze([...ownedFindingIds[index]!]),
      ...(evidence.provider === undefined ? {} : { provider: evidence.provider }),
      route_source: evidence.route_source,
      ...(evidence.route_override === undefined ? {} : { route_override: evidence.route_override }),
    });
  });
  const mergedReviewEvidence: ReviewEvidence = Object.freeze({
    ...primaryObs.evidence,
    schema_version: "2",
    findings: Object.freeze(allFindings),
    ...mergedSummary,
    matched_rule_versions: Object.freeze(mergedMatchedRules),
    reviewer_runs: Object.freeze(reviewerRuns),
    ...(effortAssessment === undefined ? {} : { effort_review: effortAssessment }),
  });

  const summarizedConstitution = constitutionEvidence;

  // Re-authenticate the complete subject only after every required child has returned. In
  // particular, a repository or artifact that moves during the sequential constitution review
  // must prevent both sibling evidence results from becoming current.
  const currentProjection = await dependencies.reobserve_projection_digest();
  if (!currentProjection.ok) return currentProjection;
  if (currentProjection.value !== input.projection_digest) {
    return {
      schema_version: "1",
      ok: false,
      error: createProjectError("STATE_INVALID", {
        phase_instance: input.envelope.subject.phase_instance,
        issue_code: "counter-review-subject-not-current",
      }),
    };
  }

  const prepared = await dependencies.prepare_evidence(
    mergedReviewEvidence,
    input.measured_at_revision,
  );
  if (!prepared.ok) return prepared;
  let constitutionPrepared: PreparedEvidenceResult | undefined;
  if (plan !== undefined && constitutionEvidence !== undefined) {
    const preparedConstitution = await plan.prepare_evidence(
      constitutionEvidence,
      input.measured_at_revision,
    );
    if (!preparedConstitution.ok) return preparedConstitution;
    constitutionPrepared = preparedConstitution.value;
  }

  const identified = identifyTransactionRequest(
    input.call,
    input.authority,
    prepared.value.reference.input_fingerprint,
  );
  const installation = prepareResultInstallation({
    reference: prepared.value.reference,
    prepared: prepared.value.prepared,
    manifest_target: prepared.value.manifest_target,
    projection_plan: prepared.value.projection_plan,
    worktree_root: dependencies.transaction.runner.location.worktreeRoot as ResolvedTaskPath,
  });
  const constitutionInstallation = constitutionPrepared === undefined
    ? undefined
    : prepareResultInstallation({
      reference: constitutionPrepared.reference,
      prepared: constitutionPrepared.prepared,
      manifest_target: constitutionPrepared.manifest_target,
      projection_plan: constitutionPrepared.projection_plan,
      worktree_root: dependencies.transaction.runner.location.worktreeRoot as ResolvedTaskPath,
    });
  const committed = await runStateTransaction(
    dependencies.transaction,
    { authority: input.authority, call: input.call },
    (current, call) => planCounterReviewCommit({
      task_id: input.authority.task_id,
      intent_id: input.call.input.intent_id,
      request_digest: identified.request_digest,
      review_evidence: mergedReviewEvidence,
      constitution_evidence: summarizedConstitution,
      result_reference: prepared.value.reference,
      result_installation: installation,
      constitution_reference: constitutionPrepared?.reference,
      constitution_installation: constitutionInstallation,
    }, current, call),
  );
  if (!committed.ok) return committed;
  // The round is durable now; its retained child outputs have served their purpose.
  for (const digest of new Set(reviewEnvelopes.map((reviewEnvelope) => reviewEnvelope.digest))) {
    await retained?.discard(digest);
  }
  if (constitutionEnvelope !== undefined) await retained?.discard(constitutionEnvelope.digest);
  if (effortEnvelope !== undefined) await retained?.discard(effortEnvelope.digest);
  return {
    schema_version: "1",
    ok: true,
    value: Object.freeze({
      transaction: committed.value,
      evidence: mergedReviewEvidence,
      ...(constitutionEvidence === undefined ? {} : { constitution_evidence: constitutionEvidence }),
    }),
  };
}

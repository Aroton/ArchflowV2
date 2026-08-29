import adjudicationOutputSchema from "../contracts/schemas/v1/adjudication.schema.json" with { type: "json" };
import reviewOutputSchema from "../contracts/schemas/v1/review.schema.json" with { type: "json" };

import { canonicalJsonDigest, type CanonicalDocument } from "../contracts/canonical.js";
import type { AdjudicationEvidence } from "../contracts/adjudication.js";
import type { TaskStateV1 } from "../contracts/durable-state.js";
import type { ConfigV1 } from "../contracts/config.js";
import type { ConstitutionRegistry } from "../contracts/constitution.js";
import { createProjectError, type ProjectResult } from "../contracts/errors.js";
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
  ReviewFinding,
  ReviewVerdict,
  RouteOverrideRecord,
  RuleVersionRef,
} from "../contracts/review.js";
import {
  mintAdjudicationObservation,
  mintReviewObservation,
  serializeDispatch,
  serializeDispatchAll,
  serializeDispatchPair,
} from "../dispatch/cli.js";
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
  type AdjudicationEnvelopeInput,
  type AdjudicationUpstreamInput,
  type DispatchEnvelope,
  type DispatchSubject,
  type ReviewWorkspaceBinding,
  type ReviewEnvelopeSeed,
} from "./envelopes.js";
import { buildReviewEnvelopeWithCap } from "./pinned-context.js";

export type CounterReviewDispatchResult = Readonly<{
  cli_version: string;
  extracted_output_bytes: Uint8Array;
}>;

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
  /** Pair form of {@link serialize_dispatch}: one FIFO link carrying both children of one review. */
  serialize_dispatch_pair?: <A, B>(first: () => Promise<A>, second: () => Promise<B>) => Promise<[A, B]>;
  /** Group form of {@link serialize_dispatch}: one FIFO link carrying all parallel children of one review. */
  serialize_dispatch_all?: <T>(operations: readonly (() => Promise<T>)[]) => Promise<T[]>;
  /** Best-effort runtime observation seam. It must never replace the original routing/dispatch error. */
  observe_failure?: (
    role: RoutingRole,
    selected: SelectedRouteCandidate | undefined,
    error: unknown,
  ) => void | Promise<void>;
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
  const success = Object.freeze({
    path: parseRepositoryPathClaim(`.archflow/runtime/tasks/${current.value.task_id}/${counterReviewClaim(current.value.phase_instance)}`),
    verdict: inputs.review_evidence.verdict,
    blocking_count: inputs.review_evidence.blocking_count,
    constitution: constitutionOutcome,
    revision,
    request_digest: inputs.request_digest,
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
    role: RoutingRole,
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
  const selectRoutes = async (
    role: RoutingRole,
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
    role: RoutingRole,
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
  const overrideRecordFor = (role: RoutingRole): RouteOverrideRecord | undefined => {
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
  // The server stamps the durable attempt counter into the child-visible subject from the same
  // transaction authority the dispatch runs under, so the round number is never a caller claim.
  const subject: DispatchSubject = Object.freeze({
    ...input.envelope.subject,
    attempt: input.authority.context.attempt,
  });
  const envelope = buildReviewEnvelopeWithCap({ ...input.envelope, subject });
  const serializeAll = dependencies.serialize_dispatch_all ??
    (dependencies.serialize_dispatch ?
      async <T>(ops: readonly (() => Promise<T>)[]) => Promise.all(ops.map((op) => op())) :
      serializeDispatchAll);
  const plan = input.constitution;
  // All routes are selected before children spend tokens, so a bad route fails before launch.
  const reviewRoutes = await selectRoutes("counter-reviewer");
  const constitutionRoutes = plan === undefined ? undefined : await selectRoutes("adjudicator");
  const constitutionRoute = constitutionRoutes?.[0];
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

  const dispatchReviewOps = reviewRoutes.map((routeEntry) => () =>
    dispatchObserved("counter-reviewer", routeEntry, (route) =>
      dependencies.dispatch(route, envelope, reviewOutputSchema as PlainJsonValue)),
  );
  let dispatchConstitution: (() => Promise<CounterReviewDispatchResult>) | undefined;
  if (
    plan !== undefined && constitutionRoute !== undefined &&
    constitutionSubject !== undefined && constitutionEnvelope !== undefined
  ) {
    dispatchConstitution = () =>
      dispatchObserved("adjudicator", constitutionRoute, (route) =>
        plan.dispatch(route, constitutionEnvelope, adjudicationOutputSchema as PlainJsonValue));
  }

  const allOps: (() => Promise<CounterReviewDispatchResult>)[] = [...dispatchReviewOps];
  if (dispatchConstitution !== undefined) {
    allOps.push(dispatchConstitution);
  }

  const allDispatched = await serializeAll(allOps);
  const reviewDispatchedList = allDispatched.slice(0, reviewRoutes.length);
  const constitutionDispatched = dispatchConstitution !== undefined ? allDispatched[reviewRoutes.length] : undefined;

  const singleObservations = reviewDispatchedList.map((reviewDispatched, index) => {
    const routeEntry = reviewRoutes[index]!;
    const route = routeEntry.selection.route;
    return mintReviewObservation({
      subject,
      adapter: route.adapter,
      cli_version: reviewDispatched.cli_version,
      route,
      route_source: routeEntry.selection.source,
      envelope_input_digest: envelope.digest,
      extracted_output_bytes: reviewDispatched.extracted_output_bytes,
      repositories: input.repositories,
      ...(reviewOverride === undefined ? {} : { route_override: reviewOverride }),
    });
  });

  const makeFindingId = (model: string, findingId: string, index: number, total: number): string => {
    if (total <= 1) return findingId;
    const modelSlug = model.toLowerCase().replace(/[^a-z0-9]+/gu, "-").replace(/^-+|-+$/gu, "");
    const shortTag = modelSlug.includes("sol") ? "sol"
      : modelSlug.includes("fable") ? "fable"
      : modelSlug.includes("opus") ? "opus"
      : modelSlug.includes("sonnet") ? "sonnet"
      : modelSlug.includes("haiku") ? "haiku"
      : modelSlug.includes("flash") ? "flash"
      : modelSlug.includes("pro") ? "pro"
      : `r${index + 1}`;
    if (findingId.startsWith(`${shortTag}-`)) return findingId;
    return `${shortTag}-${findingId}`;
  };

  const allFindings: ReviewFinding[] = [];
  const seenIds = new Set<string>();
  for (let i = 0; i < singleObservations.length; i += 1) {
    const obs = singleObservations[i]!;
    const model = obs.evidence.model;
    for (const f of obs.evidence.findings) {
      const rawId = makeFindingId(model, f.finding_id, i, singleObservations.length);
      let uniqueId = rawId;
      let disambig = 2;
      while (seenIds.has(uniqueId)) {
        uniqueId = `${rawId}-${disambig}`;
        disambig += 1;
      }
      seenIds.add(uniqueId);
      allFindings.push({
        ...f,
        finding_id: uniqueId,
      });
    }
  }

  const matchedMap = new Map<string, RuleVersionRef>();
  for (const obs of singleObservations) {
    for (const ruleRef of obs.evidence.matched_rule_versions) {
      matchedMap.set(`${ruleRef.rule_id}:${ruleRef.rule_version}`, ruleRef);
    }
  }
  const mergedMatchedRules = [...matchedMap.values()].sort((a, b) => a.rule_id.localeCompare(b.rule_id));

  const anyFail = singleObservations.some((obs) => obs.evidence.verdict === "fail");
  const anyAdvisory = singleObservations.some((obs) => obs.evidence.verdict === "advisory");
  const mergedVerdict: ReviewVerdict = anyFail ? "fail" : anyAdvisory ? "advisory" : "pass";
  const mergedBlockingCount = allFindings.filter((f) => f.blocking).length;

  const primaryObs = singleObservations[0]!;
  const mergedReviewEvidence: ReviewEvidence = Object.freeze({
    ...primaryObs.evidence,
    findings: Object.freeze(allFindings),
    verdict: mergedVerdict,
    blocking_count: mergedBlockingCount,
    matched_rule_versions: Object.freeze(mergedMatchedRules),
  });

  let constitutionEvidence: AdjudicationEvidence | undefined;
  if (
    plan !== undefined && constitutionSubject !== undefined && constitutionEnvelope !== undefined &&
    constitutionRoute !== undefined && constitutionDispatched !== undefined
  ) {
    const constitutionOverride = overrideRecordFor("adjudicator");
    try {
      const observedConstitution = mintAdjudicationObservation({
        subject: constitutionSubject,
        adapter: constitutionRoute.selection.route.adapter,
        cli_version: constitutionDispatched.cli_version,
        route: constitutionRoute.selection.route,
        route_source: constitutionRoute.selection.source,
        envelope_input_digest: constitutionEnvelope.digest,
        extracted_output_bytes: constitutionDispatched.extracted_output_bytes,
        repositories: input.repositories,
        ...(constitutionOverride === undefined ? {} : { route_override: constitutionOverride }),
      });
      constitutionEvidence = crossCheckRuleFindings(
        plan.registry,
        observedConstitution.evidence,
        constitutionRoute.selection.route.adapter,
      );
    } catch (error) {
      return {
        schema_version: "1",
        ok: false,
        error: error instanceof AdjudicationServiceError
          ? error.project_error
          : createProjectError("MODEL_OUTPUT_INVALID", {
            adapter: constitutionRoute.selection.route.adapter,
            attempt: 1,
            issue_code: adjudicationOutputIssueCode(error),
          }),
      };
    }
  }
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

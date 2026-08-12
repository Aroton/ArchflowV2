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
import type { ModelFamily, ReviewEvidence } from "../contracts/review.js";
import {
  mintAdjudicationObservation,
  mintReviewObservation,
  serializeDispatch,
} from "../dispatch/cli.js";
import { resolveDispatchRoute, type DispatchRoute } from "../dispatch/routing.js";
import type { TransactionAuthority } from "../state/authority.js";
import { adjudicationReviewClaim, counterReviewClaim, type ResolvedTaskPath } from "../repository/paths.js";
import {
  deriveEvidenceSetFromCounter,
  type PreparedEvidenceResult,
} from "../state/evidence-results.js";
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
  type ReviewEnvelopeSeed,
} from "./envelopes.js";
import { buildReviewEnvelopeWithCap } from "./pinned-context.js";

export type CounterReviewDispatchResult = Readonly<{
  cli_version: string;
  extracted_output_bytes: Uint8Array;
}>;

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
}>;

/**
 * Everything the constitution review needs beyond what the rubric review already carries. The
 * handler derives all of it from durable authority — pinned constitution, approved upstream
 * documents, a distinct result identity, and a dispatch coordinator that materializes NO
 * repository checkout: the adjudicating child judges exactly the sealed envelope.
 */
export type ConstitutionReviewPlan = Readonly<{
  registry: ConstitutionRegistry;
  pinned_constitution_digest: Sha256Digest;
  rules: AdjudicationEnvelopeInput["rules"];
  approved_upstreams: readonly AdjudicationUpstreamInput[];
  approved_upstream_digests: readonly Sha256Digest[];
  invocation_id: SafeId;
  result_id: SafeId;
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
  measured_at_revision: SafeInteger;
  envelope: ReviewEnvelopeSeed;
  projection_digest: ReviewEvidence["subject_digest"];
  /**
   * Present exactly when the pinned constitution has active rules. The server, not the caller,
   * decides this: with a plan the call runs the constitution review as a second opposite-family
   * dispatch and commits both results in one transaction; without one the result reports the
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
 * Runs a fresh opposite-family review — and, when the pinned constitution has active rules, the
 * opposite-family constitution review bound to that fresh evidence — then retains the validated
 * evidence atomically. A fail verdict remains a successful result: it records blocking findings
 * and never manufactures advancement.
 */
export async function runCounterReview(
  dependencies: RunCounterReviewDependencies,
  input: RunCounterReviewInput,
): Promise<ProjectResult<Readonly<{
  transaction: TransactionOutcome<"archflow_counter_review">;
  evidence: ReviewEvidence;
  constitution_evidence?: AdjudicationEvidence;
}>>> {
  const callRubricDigest = canonicalJsonDigest(input.call.input.rubric as never);
  if (
    input.producer_family !== input.envelope.subject.producer_family ||
    input.envelope.subject.rubric_digest !== callRubricDigest ||
    canonicalJsonDigest(input.envelope.rubric as never) !== callRubricDigest
  ) {
    throw new TypeError("counter-review subject is not derived from the server-owned request");
  }
  const route = resolveDispatchRoute(
    input.config,
    input.phase_kind,
    "counter-reviewer",
    input.producer_family,
  );
  // The server stamps the durable attempt counter into the child-visible subject from the same
  // transaction authority the dispatch runs under, so the round number is never a caller claim.
  const subject: DispatchSubject = Object.freeze({
    ...input.envelope.subject,
    attempt: input.authority.context.attempt,
  });
  const envelope = buildReviewEnvelopeWithCap({ ...input.envelope, subject });
  const dispatched = await serializeDispatch(() =>
    dependencies.dispatch(route, envelope, reviewOutputSchema as PlainJsonValue));
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
  const observed = mintReviewObservation({
    subject,
    adapter: route.adapter,
    cli_version: dispatched.cli_version,
    route,
    envelope_input_digest: envelope.digest,
    extracted_output_bytes: dispatched.extracted_output_bytes,
  });
  const prepared = await dependencies.prepare_evidence(
    observed.evidence,
    input.measured_at_revision,
  );
  if (!prepared.ok) return prepared;

  let constitutionEvidence: AdjudicationEvidence | undefined;
  let constitutionPrepared: PreparedEvidenceResult | undefined;
  const plan = input.constitution;
  if (plan !== undefined) {
    // The constitution dispatch binds the review evidence it was dispatched with: the set digest
    // is a pure function of the fresh review payload, recomputable from the retained result after
    // both are installed by the one transaction below.
    const derivedSet = deriveEvidenceSetFromCounter(observed.evidence);
    const setDigest = derivedSet.current_evidence_set.set_digest;
    const constitutionRoute = resolveDispatchRoute(
      input.config,
      input.phase_kind,
      "adjudicator",
      input.producer_family,
    );
    const constitutionSubject = Object.freeze({
      task_id: input.envelope.subject.task_id,
      phase_instance: input.envelope.subject.phase_instance,
      role: "adjudication" as const,
      step: "adjudicate" as const,
      subject_digest: input.envelope.subject.subject_digest,
      input_fingerprint: input.envelope.subject.input_fingerprint,
      pinned_constitution_digest: plan.pinned_constitution_digest,
      approved_upstream_digests: plan.approved_upstream_digests,
      source_evidence_set_digest: setDigest,
      invocation_id: plan.invocation_id,
      result_id: plan.result_id,
    });
    const constitutionEnvelope = buildAdjudicationEnvelope({
      artifact: input.envelope.artifact,
      rules: plan.rules,
      source_evidence_set_digest: setDigest,
      approved_upstreams: plan.approved_upstreams,
      subject: constitutionSubject,
    });
    const constitutionDispatched = await serializeDispatch(() =>
      plan.dispatch(constitutionRoute, constitutionEnvelope, adjudicationOutputSchema as PlainJsonValue));
    try {
      const observedConstitution = mintAdjudicationObservation({
        subject: constitutionSubject,
        adapter: constitutionRoute.adapter,
        cli_version: constitutionDispatched.cli_version,
        route: constitutionRoute,
        envelope_input_digest: constitutionEnvelope.digest,
        extracted_output_bytes: constitutionDispatched.extracted_output_bytes,
      });
      constitutionEvidence = crossCheckRuleFindings(
        plan.registry,
        observedConstitution.evidence,
        constitutionRoute.adapter,
      );
    } catch (error) {
      return {
        schema_version: "1",
        ok: false,
        error: error instanceof AdjudicationServiceError
          ? error.project_error
          : createProjectError("MODEL_OUTPUT_INVALID", {
            adapter: constitutionRoute.adapter,
            attempt: 1,
            issue_code: "adjudication-output-invalid",
          }),
      };
    }
    const preparedConstitution = await plan.prepare_evidence(
      constitutionEvidence,
      input.measured_at_revision,
    );
    if (!preparedConstitution.ok) return preparedConstitution;
    constitutionPrepared = preparedConstitution.value;
  }
  const summarizedConstitution = constitutionEvidence;

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
      review_evidence: observed.evidence,
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
      evidence: observed.evidence,
      ...(constitutionEvidence === undefined ? {} : { constitution_evidence: constitutionEvidence }),
    }),
  };
}

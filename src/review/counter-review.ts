import reviewOutputSchema from "../contracts/schemas/v1/review.schema.json" with { type: "json" };

import { canonicalJsonDigest } from "../contracts/canonical.js";
import type { ConfigV1 } from "../contracts/config.js";
import { createProjectError, type ProjectResult } from "../contracts/errors.js";
import { parseSafeInteger, type SafeInteger } from "../contracts/evidence.js";
import {
  createInternalResultExpectation,
  validateProjectResultStructure,
  type ParsedToolCall,
} from "../contracts/mcp-tools.js";
import { counterReviewClaim } from "../contracts/path-claims.js";
import type { PlainJsonValue } from "../contracts/plain-json.js";
import type { ModelFamily, ReviewEvidence } from "../contracts/review.js";
import {
  mintReviewObservation,
  serializeDispatch,
} from "../dispatch/cli.js";
import { resolveDispatchRoute, type DispatchRoute } from "../dispatch/routing.js";
import type { TransactionAuthority } from "../state/authority.js";
import type { ResolvedTaskPath } from "../repository/paths.js";
import type { PreparedEvidenceResult } from "../state/evidence-results.js";
import type {
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

export type RunCounterReviewInput = Readonly<{
  authority: TransactionAuthority;
  call: Extract<ParsedToolCall, { name: "archflow_counter_review" }>;
  config: ConfigV1;
  phase_kind: keyof NonNullable<ConfigV1["overrides"]>;
  producer_family: ModelFamily;
  measured_at_revision: SafeInteger;
  envelope: ReviewEnvelopeSeed;
  projection_digest: ReviewEvidence["subject_digest"];
}>;

/**
 * Runs a fresh opposite-family review and retains the validated evidence. A fail verdict remains
 * a successful result: it records blocking findings and never manufactures advancement.
 */
export async function runCounterReview(
  dependencies: RunCounterReviewDependencies,
  input: RunCounterReviewInput,
): Promise<ProjectResult<Readonly<{
  transaction: TransactionOutcome<"archflow_counter_review">;
  evidence: ReviewEvidence;
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
  const committed = await runStateTransaction(
    dependencies.transaction,
    { authority: input.authority, call: input.call },
    async (current, call) => {
      const revision = parseSafeInteger(current.value.revision + 1);
      const success = Object.freeze({
        path: counterReviewClaim(current.value.phase_instance),
        verdict: observed.evidence.verdict,
        blocking_count: observed.evidence.blocking_count,
        revision,
        request_digest: identified.request_digest,
      });
      const expectation = createInternalResultExpectation({
        schema_version: "1",
        tool: "archflow_counter_review",
        task_id: input.authority.task_id,
        intent_id: input.call.input.intent_id,
        input_fingerprint: prepared.value.reference.input_fingerprint,
        request_digest: identified.request_digest,
        result_id: prepared.value.reference.result_id,
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
          input_fingerprint: prepared.value.reference.input_fingerprint,
        },
        recomputed_input_fingerprint: prepared.value.reference.input_fingerprint,
        result_reference: prepared.value.reference,
      });
      if (!next.ok) return next;
      return {
        schema_version: "1",
        ok: true,
        value: {
          expectation,
          result,
          next_state: next.value,
          result_installation: installation,
        },
      };
    },
  );
  if (!committed.ok) return committed;
  return {
    schema_version: "1",
    ok: true,
    value: Object.freeze({ transaction: committed.value, evidence: observed.evidence }),
  };
}

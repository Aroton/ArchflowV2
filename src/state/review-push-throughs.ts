import { isDeepStrictEqual } from "node:util";

import type { ReviewPushThroughRecordV1 } from "../contracts/durable-state.js";
import type { ProjectResult } from "../contracts/errors.js";
import { assertPlainJson } from "../contracts/plain-json.js";
import { verifyRepositoryIdentity } from "../repository/identity.js";
import type {
  AuthenticatedReviewPushThroughFacts,
  ReviewPushThroughAuthoritySource,
} from "../review/fixed-point.js";
import { assertInternalTransactionAuthority, type TransactionAuthority } from "./authority.js";
import {
  assertAuthenticatedGateApproval,
  loadAuthenticatedGateApproval,
  type AuthenticatedGateApproval,
} from "./gate-approvals.js";
import {
  deepFreezeGateJson,
  issue,
  ok,
  stateOrFailure,
  type GateApprovalLoaderDependencies,
} from "./gate-core.js";

const authenticatedReviewPushThroughs = new WeakSet<object>();
const authenticatedReviewPushThroughBrand: unique symbol = Symbol("AuthenticatedReviewPushThrough");

export type AuthenticatedReviewPushThrough = Readonly<{
  record: ReviewPushThroughRecordV1;
  approval: AuthenticatedGateApproval;
}> & { readonly [authenticatedReviewPushThroughBrand]: true };

export function assertAuthenticatedReviewPushThrough(
  value: AuthenticatedReviewPushThrough,
): void {
  if (!authenticatedReviewPushThroughs.has(value)) {
    throw new TypeError("an authenticated review push-through is required");
  }
  assertAuthenticatedGateApproval(value.approval);
}

/** Adapts loader-branded values to the fixed point without exposing plain durable records. */
export function reviewPushThroughAuthoritySource(
  values: readonly AuthenticatedReviewPushThrough[],
): ReviewPushThroughAuthoritySource {
  return Object.freeze({
    values: Object.freeze([...values]),
    authenticate(value: unknown): AuthenticatedReviewPushThroughFacts {
      const authenticated = value as AuthenticatedReviewPushThrough;
      assertAuthenticatedReviewPushThrough(authenticated);
      const record = authenticated.record;
      return Object.freeze({
        task_id: authenticated.approval.request.task_id,
        phase_instance: record.phase_instance,
        attempt: record.attempt,
        subject_digest: record.subject_digest,
        current_evidence_set_digest: record.current_evidence_set_digest,
        triage_result_digest: record.triage_result_digest,
        accepted_occurrences: record.accepted_occurrences,
      });
    },
  });
}

const ordinalOccurrences = (
  occurrences: readonly Readonly<{ review_evidence_digest: string; finding_id: string }>[],
) => [...occurrences].sort((left, right) =>
  left.review_evidence_digest < right.review_evidence_digest ? -1 :
    left.review_evidence_digest > right.review_evidence_digest ? 1 :
      left.finding_id < right.finding_id ? -1 : left.finding_id > right.finding_id ? 1 : 0);

/** Reloads and authenticates the state record, generic approval, and immutable human archive. */
export async function loadAuthenticatedReviewPushThrough(
  dependencies: GateApprovalLoaderDependencies,
  authority: TransactionAuthority,
  value: ReviewPushThroughRecordV1,
): Promise<ProjectResult<AuthenticatedReviewPushThrough>> {
  assertInternalTransactionAuthority(authority, {
    runner: dependencies.runner,
    environment: dependencies.environment,
  });
  assertPlainJson(value, "review push-through record");
  const claimed = structuredClone(value);
  const current = await stateOrFailure(dependencies, authority);
  if (!current.ok) return current;
  if (current.value.value.task_id !== authority.task_id ||
      !verifyRepositoryIdentity(current.value.value.repository_identity_digest, authority.repository_identity).ok) {
    return issue("STATE_INVALID", current.value.value, "review-push-through-state-authority-mismatch");
  }
  const durable = current.value.value.review_push_throughs?.find((record) => record.gate_id === claimed.gate_id);
  if (durable === undefined || !isDeepStrictEqual(durable, claimed)) {
    return issue("STATE_INVALID", current.value.value, "review-push-through-not-current");
  }
  const approvalRef = current.value.value.approvals.find((approval) => approval.gate_id === claimed.gate_id);
  if (approvalRef === undefined) {
    return issue("STATE_INVALID", current.value.value, "review-push-through-approval-missing");
  }
  const loaded = await loadAuthenticatedGateApproval(dependencies, authority, approvalRef);
  if (!loaded.ok) return loaded;
  const approval = loaded.value;
  const request = approval.request;
  const decision = approval.decision;
  const context = request.kind === "attempts-exhausted"
    ? request.context.review_push_through
    : undefined;
  const provenance = decision.envelope.human_provenance;
  if (
    request.kind !== "attempts-exhausted" || context === undefined ||
    decision.kind !== "attempts-exhausted" || decision.envelope.payload.decision !== "push-through-review" ||
    provenance.actor_class !== "human" || provenance.channel !== "connected-host" ||
    approval.approval.decision_digest !== claimed.decision_digest ||
    approval.approval.subject_digest !== claimed.subject_digest ||
    approval.approval.resolved_at_revision !== claimed.resolved_at_revision ||
    request.phase_instance !== claimed.phase_instance || request.subject_digest !== claimed.subject_digest ||
    request.context.attempts !== claimed.attempt ||
    context.current_evidence_set_digest !== claimed.current_evidence_set_digest ||
    context.triage_result_digest !== claimed.triage_result_digest ||
    request.current_evidence.set_digest !== claimed.current_evidence_set_digest ||
    decision.envelope.payload.reason !== claimed.human_reason ||
    provenance.recorded_at !== claimed.decided_at ||
    !isDeepStrictEqual(ordinalOccurrences(context.accepted_occurrences), claimed.accepted_occurrences)
  ) return issue("STATE_INVALID", current.value.value, "review-push-through-binding-invalid");

  const authenticated = {
    record: deepFreezeGateJson(structuredClone(durable)),
    approval,
  } as unknown as AuthenticatedReviewPushThrough;
  Object.defineProperty(authenticated, authenticatedReviewPushThroughBrand, {
    value: true,
    enumerable: false,
    writable: false,
    configurable: false,
  });
  Object.freeze(authenticated);
  authenticatedReviewPushThroughs.add(authenticated);
  return ok(authenticated);
}

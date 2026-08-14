import { isDeepStrictEqual } from "node:util";

import {
  parseArchivedGateDecisionRecord,
  parseArchivedGateRequest,
  type ArchivedGateDecisionRecordV1,
  type ArchivedGateRequestV1,
} from "../contracts/durable-gate.js";
import type { ApprovalRef } from "../contracts/durable-state.js";
import { validateDurableSemantics } from "../contracts/durable.js";
import type { ProjectResult } from "../contracts/errors.js";
import { gateDecisionEffect } from "../contracts/gates.js";
import { assertPlainJson } from "../contracts/plain-json.js";
import { gateDecisionClaim, gateRequestClaim } from "../repository/paths.js";
import { verifyRepositoryIdentity } from "../repository/identity.js";
import { assertInternalTransactionAuthority, type TransactionAuthority } from "./authority.js";
import {
  deepFreezeGateJson,
  issue,
  ok,
  readCanonical,
  resolvePath,
  stateOrFailure,
  type GateApprovalLoaderDependencies,
} from "./gate-core.js";

const authenticatedGateApprovals = new WeakSet<object>();
const authenticatedGateApprovalBrand: unique symbol = Symbol("AuthenticatedGateApproval");

/**
 * A durable approval reloaded from the state and decision archive by this module.
 * The public fields let state-owned decision functions check the immutable binding;
 * membership in the private WeakSet prevents callers from fabricating the authority.
 */
export type AuthenticatedGateApproval = Readonly<{
  approval: ApprovalRef;
  request: ArchivedGateRequestV1;
  decision: Extract<ArchivedGateDecisionRecordV1, { readonly outcome: "decided" }>;
}> & { readonly [authenticatedGateApprovalBrand]: true };

export function assertAuthenticatedGateApproval(
  value: AuthenticatedGateApproval,
): void {
  if (!authenticatedGateApprovals.has(value)) {
    throw new TypeError("an authenticated gate approval is required");
  }
}

/**
 * Reloads an ApprovalRef's current durable authority. Nothing supplied by the caller other
 * than the exact ref is trusted: state, request, and decision are all read from canonical
 * task-owned paths before an in-memory capability is minted.
 */
export async function loadAuthenticatedGateApproval(
  dependencies: GateApprovalLoaderDependencies,
  authority: TransactionAuthority,
  approval: ApprovalRef,
): Promise<ProjectResult<AuthenticatedGateApproval>> {
  assertInternalTransactionAuthority(authority, {
    runner: dependencies.runner,
    environment: dependencies.environment,
  });
  assertPlainJson(approval, "approval reference");
  const claimed = structuredClone(approval);
  const current = await stateOrFailure(dependencies, authority);
  if (!current.ok) return current;
  if (
    current.value.value.task_id !== authority.task_id ||
    !verifyRepositoryIdentity(
      current.value.value.repository_identity_digest,
      authority.repository_identity,
    ).ok
  ) return issue("STATE_INVALID", current.value.value, "gate-approval-state-authority-mismatch");
  const durable = current.value.value.approvals.find((entry) =>
    entry.gate_id === claimed.gate_id);
  if (durable === undefined || !isDeepStrictEqual(durable, claimed)) {
    return issue("STATE_INVALID", current.value.value, "gate-approval-not-current");
  }
  const requestPath = await resolvePath(
    dependencies,
    authority,
    gateRequestClaim(claimed.gate_id),
    "authority-decision",
  );
  const decisionPath = await resolvePath(
    dependencies,
    authority,
    gateDecisionClaim(claimed.gate_id),
    "authority-decision",
  );
  if (!requestPath.ok) return requestPath;
  if (!decisionPath.ok) return decisionPath;
  const request = await readCanonical(requestPath.value, "gate request", parseArchivedGateRequest);
  const decision = await readCanonical(
    decisionPath.value,
    "gate decision record",
    parseArchivedGateDecisionRecord,
  );
  if (request === "missing" || request === "invalid") {
    return issue("STATE_INVALID", current.value.value, "gate-approval-request-invalid");
  }
  if (decision === "missing" || decision === "invalid") {
    return issue("STATE_INVALID", current.value.value, "gate-approval-decision-invalid");
  }
  if (
    decision.digest !== claimed.decision_digest ||
    !validateDurableSemantics({
      gate_request: request,
      gate_decision: decision,
    }).ok ||
    decision.value.outcome !== "decided" ||
    gateDecisionEffect(decision.value.envelope.payload) !== "advance" ||
    request.value.task_id !== authority.task_id ||
    request.value.gate_id !== claimed.gate_id ||
    request.value.kind !== claimed.gate_kind ||
    request.value.subject_digest !== claimed.subject_digest ||
    decision.value.gate_id !== claimed.gate_id ||
    decision.value.task_id !== authority.task_id ||
    decision.value.kind !== claimed.gate_kind ||
    decision.value.subject_digest !== claimed.subject_digest
  ) return issue("STATE_INVALID", current.value.value, "gate-approval-binding-invalid");

  const authenticated = {
    approval: deepFreezeGateJson(structuredClone(durable)),
    request: deepFreezeGateJson(structuredClone(request.value)),
    decision: deepFreezeGateJson(structuredClone(decision.value)),
  } as unknown as AuthenticatedGateApproval;
  Object.defineProperty(authenticated, authenticatedGateApprovalBrand, {
    value: true,
    enumerable: false,
    writable: false,
    configurable: false,
  });
  Object.freeze(authenticated);
  authenticatedGateApprovals.add(authenticated);
  return ok(authenticated);
}

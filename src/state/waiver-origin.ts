import { isDeepStrictEqual } from "node:util";

import type { CanonicalDocument } from "../contracts/canonical.js";
import type {
  ArchivedGateDecisionRecordV1,
  ArchivedGateRequestV1,
} from "../contracts/durable-gate.js";
import { validateDurableSemantics } from "../contracts/durable.js";
import type { GateContext, WaiverOriginRef } from "../contracts/gates.js";
import type { CurrentEvidenceSetRef } from "../contracts/trust.js";

type WaiverOriginRequest = ArchivedGateRequestV1 & Readonly<{
  current_evidence: CurrentEvidenceSetRef;
  context:
    | GateContext<"artifact-approval">
    | GateContext<"design-approval">
    | GateContext<"commit-authorization">
    | GateContext<"constitution-review">;
}>;

/**
 * The closed set of request shapes that may be consumed as a waiver origin. New policy findings
 * use an ordinary gate; the fourth arm exists only for an archived policy-context constitution
 * review whose old human interface already offered `waiver-requested`.
 */
export function isWaiverOriginRequest(request: ArchivedGateRequestV1): request is WaiverOriginRequest {
  return "eligible_waivers" in request.context && (
    request.kind === "artifact-approval" || request.kind === "design-approval" ||
    request.kind === "commit-authorization" || request.kind === "constitution-review"
  );
}

/** Re-verifies every caller-supplied waiver origin field against the archived human decision. */
export function authenticWaiverOriginArchive(
  request: CanonicalDocument<ArchivedGateRequestV1>,
  decision: CanonicalDocument<ArchivedGateDecisionRecordV1>,
  origin: WaiverOriginRef,
): boolean {
  const payload = decision.value.outcome === "decided" ? decision.value.envelope.payload : undefined;
  // Fresh policy findings redirect through one of the three ordinary gates. A historical
  // policy-context constitution review remains a valid origin only because its archived human
  // interface offered the same waiver-requested choice. The new waiver context has `origin`
  // rather than `eligible_waivers`, so it can never authenticate itself as another waiver origin.
  if (!isWaiverOriginRequest(request.value)) return false;
  return request.value.gate_id === origin.origin_gate_id &&
    request.value.task_id === origin.task_id &&
    request.value.phase_instance === origin.phase_instance &&
    request.value.subject_digest === origin.subject_digest &&
    request.value.context_digest === origin.origin_context_digest &&
    request.value.current_evidence.set_digest === origin.current_evidence_set_digest &&
    decision.digest === origin.origin_decision_digest &&
    payload?.decision === "waiver-requested" &&
    isDeepStrictEqual(payload.rule, origin.rule) &&
    payload.operation === origin.scope.operation &&
    "eligible_waivers" in request.value.context &&
    request.value.context.eligible_waivers.some((eligible) =>
      isDeepStrictEqual(eligible.rule, origin.rule) &&
      isDeepStrictEqual(eligible.scope, origin.scope)) &&
    validateDurableSemantics({ gate_request: request, gate_decision: decision }).ok;
}

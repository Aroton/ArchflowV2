import { isDeepStrictEqual } from "node:util";

import type { CanonicalDocument } from "../contracts/canonical.js";
import type {
  ArchivedGateDecisionRecordV1,
  ArchivedGateRequestV1,
} from "../contracts/durable-gate.js";
import { validateDurableSemantics } from "../contracts/durable.js";
import type { WaiverOriginRef } from "../contracts/gates.js";

/** Re-verifies every caller-supplied waiver origin field against the archived human decision. */
export function authenticWaiverOriginArchive(
  request: CanonicalDocument<ArchivedGateRequestV1>,
  decision: CanonicalDocument<ArchivedGateDecisionRecordV1>,
  origin: WaiverOriginRef,
): boolean {
  const payload = decision.value.outcome === "decided" ? decision.value.envelope.payload : undefined;
  // Checked first so the kind narrowing also fixes the evidence shape below: only reviewed gate
  // kinds carry an evidence set a waiver origin can cite.
  if (request.value.kind !== "constitution-review" && request.value.kind !== "design-approval") return false;
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

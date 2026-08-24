import { isDeepStrictEqual } from "node:util";
import { readFile } from "node:fs/promises";

import { parseCanonicalDocument } from "../contracts/canonical.js";
import { parseArchivedGateDecisionRecord, parseArchivedGateRequest } from "../contracts/durable-gate.js";
import { validateDurableSemantics } from "../contracts/durable.js";
import { createProjectError, type ProjectResult } from "../contracts/errors.js";
import { parsePathSafeId } from "../contracts/evidence.js";
import type { WaiverOriginRef } from "../contracts/gates.js";
import { gateDecisionClaim, gateRequestClaim, resolveTaskPath } from "../repository/paths.js";
import type { ProductionServices } from "./production.js";
import { isWaiverOriginRequest } from "./waiver-origin.js";

const fail = <T>(issue_code: string): ProjectResult<T> => Object.freeze({
  schema_version: "1", ok: false, error: createProjectError("CONTRACT_INVALID", { issue_code }),
});

export type PendingWaiverRequest = Readonly<{ origin: WaiverOriginRef; rationale: string }>;

/** Derives the no-submission waiver action solely from the authenticated prior gate archives. */
export async function derivePendingWaiverRequest(
  services: ProductionServices,
): Promise<ProjectResult<PendingWaiverRequest>> {
  const state = services.state?.value;
  if (state === undefined || state.open_gate !== undefined || state.last_transition?.tool !== "archflow_gate" || state.last_transition.operation !== "gate") {
    return fail("pending-waiver-transition-missing");
  }
  const gateId = parsePathSafeId(state.last_transition.result_id);
  const requestPath = await resolveTaskPath({ runner: services.runner, taskId: services.authority.task_id,
    claim: gateRequestClaim(gateId), expectedClass: "authority-decision", context: services.authority.context });
  if (!requestPath.ok) return requestPath;
  const decisionPath = await resolveTaskPath({ runner: services.runner, taskId: services.authority.task_id,
    claim: gateDecisionClaim(gateId), expectedClass: "authority-decision", context: services.authority.context });
  if (!decisionPath.ok) return decisionPath;
  try {
    const request = parseCanonicalDocument(new Uint8Array(await readFile(requestPath.value.absolute)), "pending waiver request");
    const decision = parseCanonicalDocument(new Uint8Array(await readFile(decisionPath.value.absolute)), "pending waiver decision");
    const requestValue = parseArchivedGateRequest(request.value);
    const decisionValue = parseArchivedGateDecisionRecord(decision.value);
    const payload = decisionValue.outcome === "decided" ? decisionValue.envelope.payload : undefined;
    if (
      !validateDurableSemantics({ gate_request: { ...request, value: requestValue }, gate_decision: { ...decision, value: decisionValue } }).ok ||
      requestValue.gate_id !== gateId || decisionValue.gate_id !== gateId ||
      !isWaiverOriginRequest(requestValue) ||
      payload?.decision !== "waiver-requested" || !("eligible_waivers" in requestValue.context)
    ) return fail("pending-waiver-archive-invalid");
    const eligible = requestValue.context.eligible_waivers.find((item) =>
      isDeepStrictEqual(item.rule, payload.rule) && item.scope.operation === payload.operation);
    if (eligible === undefined) return fail("pending-waiver-eligibility-invalid");
    return Object.freeze({ schema_version: "1", ok: true, value: Object.freeze({
      origin: Object.freeze({ origin_gate_id: requestValue.gate_id, origin_decision_digest: decision.digest,
        origin_context_digest: requestValue.context_digest, task_id: requestValue.task_id,
        phase_instance: requestValue.phase_instance, subject_digest: requestValue.subject_digest,
        current_evidence_set_digest: requestValue.current_evidence.set_digest, rule: payload.rule, scope: eligible.scope }),
      rationale: payload.rationale,
    }) });
  } catch { return fail("pending-waiver-archive-invalid"); }
}

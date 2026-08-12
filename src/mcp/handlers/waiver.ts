import { parseCanonicalDocument } from "../../contracts/canonical.js";
import type { InvocationContext } from "../../contracts/contexts.js";
import { createProjectError, type ProjectResult } from "../../contracts/errors.js";
import { parseGateDecisionRecord, parseGateRequest, type WaiverGateContext } from "../../contracts/durable-gate.js";
import { validateDurableSemantics } from "../../contracts/durable.js";
import type { CanonicalDocument } from "../../contracts/canonical.js";
import type { GateDecisionRecordV1, GateRequestV1 } from "../../contracts/durable-gate.js";
import type { WaiverOriginRef } from "../../contracts/gates.js";
import { isDeepStrictEqual } from "node:util";
import type { ParsedToolCall, ToolSuccess } from "../../contracts/mcp-tools.js";
import { gateDecisionClaim, gateRequestClaim, openResolved, resolveTaskPath } from "../../repository/paths.js";
import { runDurableGate } from "../../state/gates.js";
import { identifyTransactionRequest } from "../../state/request.js";
import { mapHandlerErrors } from "./errors.js";
import { openHandlerSession } from "./session.js";

const fail = <T>(error: ReturnType<typeof createProjectError>): ProjectResult<T> =>
  Object.freeze({ schema_version: "1", ok: false, error });

export function authenticWaiverOriginArchive(
  request: CanonicalDocument<GateRequestV1>,
  decision: CanonicalDocument<GateDecisionRecordV1>,
  origin: WaiverOriginRef,
): boolean {
  const payload = decision.value.outcome === "decided" ? decision.value.envelope.payload : undefined;
  return request.value.gate_id === origin.origin_gate_id &&
    request.value.task_id === origin.task_id &&
    request.value.phase_instance === origin.phase_instance &&
    request.value.subject_digest === origin.subject_digest &&
    request.value.context_digest === origin.origin_context_digest &&
    request.value.current_evidence.set_digest === origin.current_evidence_set_digest &&
    request.value.kind === "constitution-review" &&
    decision.digest === origin.origin_decision_digest &&
    payload?.decision === "waiver-requested" &&
    isDeepStrictEqual(payload.rule, origin.rule) &&
    payload.operation === origin.scope.operation &&
    // The origin gate must actually have offered this rule on this axis.
    "eligible_waivers" in request.value.context &&
    request.value.context.eligible_waivers.some((eligible) =>
      isDeepStrictEqual(eligible.rule, origin.rule) &&
      isDeepStrictEqual(eligible.scope, origin.scope)) &&
    validateDurableSemantics({ gate_request: request, gate_decision: decision }).ok;
}

export async function handleWaiver(
  call: Extract<ParsedToolCall, { name: "archflow_waiver" }>,
  context: InvocationContext,
): Promise<ProjectResult<ToolSuccess<"archflow_waiver">>> {
  return mapHandlerErrors<"archflow_waiver">(context.invocation_id, async () => {
    const session = await openHandlerSession(call, context);
    if (!session.ok) return session;
    const { services } = session.value;
    const state = services.state;
    if (state === undefined) return fail(createProjectError("STATE_MISSING", { phase_instance: call.input.origin.phase_instance }));

    const originTarget = await resolveTaskPath({
      runner: services.runner, taskId: services.authority.task_id,
      claim: gateRequestClaim(call.input.origin.origin_gate_id), expectedClass: "decision",
      context: services.authority.context,
    });
    if (!originTarget.ok) return originTarget;
    const decisionTarget = await resolveTaskPath({
      runner: services.runner, taskId: services.authority.task_id,
      claim: gateDecisionClaim(call.input.origin.origin_gate_id), expectedClass: "decision",
      context: services.authority.context,
    });
    if (!decisionTarget.ok) return decisionTarget;
    let originRequest;
    let originDecision;
    try {
      const handle = await openResolved(originTarget.value.absolute, 0);
      originRequest = parseCanonicalDocument(
        new Uint8Array(await handle.readFile().finally(() => handle.close())),
        "waiver origin gate request",
      );
      originRequest = Object.freeze({ ...originRequest, value: parseGateRequest(originRequest.value) });
      const decisionHandle = await openResolved(decisionTarget.value.absolute, 0);
      originDecision = parseCanonicalDocument(
        new Uint8Array(await decisionHandle.readFile().finally(() => decisionHandle.close())),
        "waiver origin gate decision",
      );
      originDecision = Object.freeze({ ...originDecision, value: parseGateDecisionRecord(originDecision.value) });
    } catch {
      return fail(createProjectError("CONTRACT_INVALID", { issue_code: "waiver-origin-request-invalid" }));
    }
    if (!authenticWaiverOriginArchive(originRequest, originDecision, call.input.origin)) {
      return fail(createProjectError("CONTRACT_INVALID", { issue_code: "waiver-origin-decision-invalid" }));
    }

    const identified = identifyTransactionRequest(call, services.authority, call.input.input_fingerprint);
    const waiverContext: WaiverGateContext = Object.freeze({ origin: call.input.origin, rationale: call.input.rationale });
    const resolved = await runDurableGate(services.dependencies, {
      authority: services.authority,
      expected_revision: call.input.expected_revision,
      intent_id: call.input.intent_id,
      request_digest: identified.request_digest,
      input_fingerprint: call.input.input_fingerprint,
      phase_instance: call.input.origin.phase_instance,
      summary: `Waiver request for ${call.input.origin.rule.rule_id}`,
      subject_digest: call.input.origin.subject_digest,
      current_evidence: originRequest.value.current_evidence,
      kind: "constitution-review",
      context: waiverContext,
      waiver_origin_gate_id: call.input.origin.origin_gate_id,
      ...(call.input.supplemental_outcome === undefined ? {} : {
        supplemental_outcome: call.input.supplemental_outcome,
      }),
      signal: context.signal,
    });
    if (!resolved.ok) return resolved;
    if (!("record" in resolved.value) || resolved.value.record.value.outcome !== "waiver-decided") {
      return fail(createProjectError("STATE_INVALID", {
        phase_instance: call.input.origin.phase_instance,
        issue_code: "waiver-resolution-missing-decision",
      }));
    }
    const decision = resolved.value.record.value;
    return Object.freeze({ schema_version: "1", ok: true, value: Object.freeze({
      origin_gate_id: call.input.origin.origin_gate_id,
      waiver_gate_id: decision.gate_id,
      task_id: decision.task_id,
      rule_id: decision.origin.rule.rule_id,
      rule_version: decision.origin.rule.rule_version,
      subject_digest: decision.subject_digest,
      current_evidence_set_digest: decision.origin.current_evidence_set_digest,
      scope: decision.scope,
      human_provenance: decision.human_provenance,
      granted: decision.granted,
      ...(decision.granted ? { expires: "task-complete" as const } : {}),
      notes: decision.notes,
      revision: resolved.value.state.value.revision,
      request_digest: identified.request_digest,
    }) as ToolSuccess<"archflow_waiver"> });
  });
}

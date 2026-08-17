import { parseCanonicalDocument } from "../../contracts/canonical.js";
import type { InvocationContext } from "../../contracts/contexts.js";
import { createProjectError, type ProjectResult } from "../../contracts/errors.js";
import {
  parseArchivedGateDecisionRecord,
  parseArchivedGateRequest,
  type WaiverGateContext,
} from "../../contracts/durable-gate.js";
import type { ParsedToolCall, ToolSuccess } from "../../contracts/mcp-tools.js";
import { gateDecisionClaim, gateRequestClaim, openResolved, resolveTaskPath } from "../../repository/paths.js";
import { runConnectedGateDecision } from "../../state/gate-direct.js";
import { runDurableGate } from "../../state/gates.js";
import { buildGatePreview, previewHasChoice } from "../../state/gate-preview.js";
import { identifyTransactionRequest } from "../../state/request.js";
import { mapHandlerErrors } from "./errors.js";
import { openHandlerSession } from "./session.js";
import { authenticWaiverOriginArchive } from "../../state/waiver-origin.js";

export { authenticWaiverOriginArchive } from "../../state/waiver-origin.js";

const fail = <T>(error: ReturnType<typeof createProjectError>): ProjectResult<T> =>
  Object.freeze({ schema_version: "1", ok: false, error });

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
      claim: gateRequestClaim(call.input.origin.origin_gate_id), expectedClass: "authority-decision",
      context: services.authority.context,
    });
    if (!originTarget.ok) return originTarget;
    const decisionTarget = await resolveTaskPath({
      runner: services.runner, taskId: services.authority.task_id,
      claim: gateDecisionClaim(call.input.origin.origin_gate_id), expectedClass: "authority-decision",
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
      originRequest = Object.freeze({ ...originRequest, value: parseArchivedGateRequest(originRequest.value) });
      const decisionHandle = await openResolved(decisionTarget.value.absolute, 0);
      originDecision = parseCanonicalDocument(
        new Uint8Array(await decisionHandle.readFile().finally(() => decisionHandle.close())),
        "waiver origin gate decision",
      );
      originDecision = Object.freeze({ ...originDecision, value: parseArchivedGateDecisionRecord(originDecision.value) });
    } catch {
      return fail(createProjectError("CONTRACT_INVALID", { issue_code: "waiver-origin-request-invalid" }));
    }
    if (!authenticWaiverOriginArchive(originRequest, originDecision, call.input.origin)) {
      return fail(createProjectError("CONTRACT_INVALID", { issue_code: "waiver-origin-decision-invalid" }));
    }

    // The bounded-decision pair is all-or-nothing: both present settles the waiver in this one
    // call through the validated preview; both absent opens the waiver gate and waits for the
    // human decision written through the disposable interface. Anything in between fails closed.
    const bounded = call.input.preview_digest !== undefined && call.input.decision !== undefined;
    if (!bounded && (call.input.preview_digest !== undefined || call.input.decision !== undefined)) {
      return fail(createProjectError("STATE_INVALID", {
        phase_instance: call.input.origin.phase_instance,
        issue_code: "waiver-decision-required",
      }));
    }

    const identified = identifyTransactionRequest(call, services.authority, call.input.input_fingerprint);
    const waiverContext: WaiverGateContext = Object.freeze({ origin: call.input.origin, rationale: call.input.rationale });
    if (bounded) {
      const preview = buildGatePreview({
        task_id: call.input.task_id,
        revision: call.input.expected_revision,
        phase_instance: call.input.origin.phase_instance,
        summary: `Waiver request for ${call.input.origin.rule.rule_id}`,
        subject_digest: call.input.origin.subject_digest,
        current_evidence: originRequest.value.current_evidence,
        kind: "constitution-review",
        context: waiverContext,
      });
      if (preview.preview_digest !== call.input.preview_digest || !previewHasChoice(preview, call.input.decision)) {
        return fail(createProjectError("STATE_INVALID", {
          phase_instance: call.input.origin.phase_instance,
          issue_code: preview.preview_digest !== call.input.preview_digest
            ? "waiver-preview-stale"
            : "waiver-decision-choice-invalid",
        }));
      }
    }
    const resolved = await (bounded ? runConnectedGateDecision(services.dependencies, {
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
    }, call.input.decision!, context) : runDurableGate(services.dependencies, {
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
      signal: context.signal,
    }));
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

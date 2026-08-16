import type { InvocationContext } from "../../contracts/contexts.js";
import { createProjectError, type ProjectResult } from "../../contracts/errors.js";
import type { ParsedToolCall, ToolSuccess } from "../../contracts/mcp-tools.js";
import { buildGatePreview, previewHasChoice } from "../../state/gate-preview.js";
import { runConnectedGateDecision } from "../../state/gate-direct.js";
import { identifyTransactionRequest } from "../../state/request.js";
import { mapHandlerErrors } from "./errors.js";
import { openHandlerSession } from "./session.js";

const fail = <T>(error: ReturnType<typeof createProjectError>): ProjectResult<T> =>
  Object.freeze({ schema_version: "1", ok: false, error });

export async function handleGate(
  call: Extract<ParsedToolCall, { name: "archflow_gate" }>,
  context: InvocationContext,
): Promise<ProjectResult<ToolSuccess<"archflow_gate">>> {
  return mapHandlerErrors<"archflow_gate">(context.invocation_id, async () => {
    const session = await openHandlerSession(call, context);
    if (!session.ok) return session;
    const preview = buildGatePreview({
      task_id: call.input.task_id,
      revision: call.input.expected_revision,
      phase_instance: call.input.phase_instance,
      summary: call.input.summary,
      subject_digest: call.input.subject_digest,
      current_evidence: call.input.current_evidence,
      kind: call.input.kind,
      context: call.input.context,
    });
    if (preview.preview_digest !== call.input.preview_digest || !previewHasChoice(preview, call.input.decision)) {
      return fail(createProjectError("STATE_INVALID", {
        phase_instance: call.input.phase_instance,
        issue_code: preview.preview_digest !== call.input.preview_digest
          ? "gate-preview-stale"
          : "gate-decision-choice-invalid",
      }));
    }
    const identified = identifyTransactionRequest(
      call,
      session.value.services.authority,
      call.input.input_fingerprint,
    );
    const outcome = await runConnectedGateDecision(session.value.services.dependencies, {
      authority: session.value.services.authority,
      expected_revision: call.input.expected_revision,
      intent_id: call.input.intent_id,
      request_digest: identified.request_digest,
      input_fingerprint: call.input.input_fingerprint,
      phase_instance: call.input.phase_instance,
      summary: call.input.summary,
      subject_digest: call.input.subject_digest,
      current_evidence: call.input.current_evidence,
      kind: call.input.kind,
      context: call.input.context,
    }, call.input.decision, context);
    if (!outcome.ok) return outcome;
    if (!("record" in outcome.value) || outcome.value.record.value.outcome !== "decided") {
      return fail(createProjectError("STATE_INVALID", {
        phase_instance: call.input.phase_instance,
        issue_code: "gate-resolution-missing-decision",
      }));
    }
    const decision = outcome.value.record.value.envelope;
    return Object.freeze({
      schema_version: "1",
      ok: true,
      value: Object.freeze({
        kind: decision.kind,
        decision,
        notes: decision.payload.reason,
        revision: outcome.value.state.value.revision,
        request_digest: identified.request_digest,
      }) as ToolSuccess<"archflow_gate">,
    });
  });
}

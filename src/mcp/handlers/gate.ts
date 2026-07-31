import type { InvocationContext } from "../../contracts/contexts.js";
import { createProjectError, type ProjectResult } from "../../contracts/errors.js";
import type { ParsedToolCall, ToolSuccess } from "../../contracts/mcp-tools.js";
import { identifyTransactionRequest } from "../../state/request.js";
import { runDurableGate } from "../../state/gates.js";
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
    const identified = identifyTransactionRequest(
      call,
      session.value.services.authority,
      call.input.input_fingerprint,
    );
    const outcome = await runDurableGate(session.value.services.dependencies, {
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
      ...(call.input.supersedes === undefined ? {} : { supersedes: call.input.supersedes }),
      ...(call.input.supplemental_outcome === undefined ? {} : {
        supplemental_outcome: call.input.supplemental_outcome,
      }),
      signal: context.signal,
    });
    if (!outcome.ok) return outcome;
    if ("record" in outcome.value && outcome.value.record.value.outcome === "superseded") {
      const supplemental = call.input.supplemental_outcome;
      if (
        supplemental?.action !== "supersede" ||
        outcome.value.record.value.gate_id !== supplemental.review.prior_gate_id ||
        outcome.value.record.value.supersession.old_subject_digest !== supplemental.old_subject_digest
      ) {
        return fail(createProjectError("STATE_INVALID", {
          phase_instance: call.input.phase_instance,
          issue_code: "gate-supersession-caller-binding-invalid",
        }));
      }
      return fail(createProjectError("GATE_SUPERSEDED", {
        gate_id: outcome.value.record.value.gate_id,
        old_subject_digest: outcome.value.record.value.supersession.old_subject_digest,
        new_subject_digest: supplemental.new_subject_digest,
      }));
    }
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
      }) as ToolSuccess<"archflow_gate">,
    });
  });
}

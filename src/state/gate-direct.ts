import type { InvocationContext } from "../contracts/contexts.js";
import type { ProjectResult } from "../contracts/errors.js";
import type { PlainJsonValue } from "../contracts/plain-json.js";
import { writeConnectedGateDecisionChoice } from "./gate-decision-interface.js";
import type { GateLifecycleDependencies, GateOpenInput, GateResolution } from "./gate-core.js";
import { openDurableGate, runDurableGate } from "./gates.js";

/**
 * Opens and resolves one gate within a bounded MCP call. The decision is already present, so the
 * disposable interface is installed immediately and `runDurableGate` never waits for another
 * process. A crash between open and resolution is retryable with the same intent and choice.
 */
export async function runConnectedGateDecision(
  dependencies: GateLifecycleDependencies,
  input: GateOpenInput,
  decision: PlainJsonValue,
  context: InvocationContext,
): Promise<ProjectResult<GateResolution>> {
  const opened = await openDurableGate(dependencies, input);
  if (!opened.ok) return opened;
  if (opened.value.replay === undefined || opened.value.state.value.open_gate?.gate_id === opened.value.gate_id) {
    const written = await writeConnectedGateDecisionChoice(
      dependencies,
      input.authority,
      decision,
      context,
    );
    if (!written.ok) return written;
  }
  const resolved = await runDurableGate(dependencies, { ...input, signal: context.signal });
  if (!resolved.ok) return resolved;
  if (!("record" in resolved.value)) {
    throw new TypeError("bounded gate decision did not resolve a record");
  }
  return Object.freeze({ schema_version: "1", ok: true, value: resolved.value });
}

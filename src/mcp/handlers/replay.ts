import { createProjectError, type ProjectResult } from "../../contracts/errors.js";
import type { ParsedToolCall, ToolSuccess } from "../../contracts/mcp-tools.js";
import type { ToolName } from "../../contracts/tool-names.js";
import type { TransactionAuthority } from "../../state/authority.js";
import { runStateTransaction, type TransactionDependencies } from "../../state/transaction.js";

const NEW_INTENT = "handler-replay-probe-new-intent";

/**
 * Uses the transaction kernel's authenticated replay/recovery path while supplying a preparation
 * callback that deliberately stops a genuinely new intent before any receipt or state write.
 */
export async function resolvePreDispatchReplay<K extends Extract<ToolName, "archflow_counter_review" | "archflow_adjudicate">>(
  dependencies: TransactionDependencies,
  authority: TransactionAuthority,
  call: Extract<ParsedToolCall, { name: K }>,
): Promise<ProjectResult<ToolSuccess<K> | undefined>> {
  const probed = await runStateTransaction(dependencies, { authority, call }, async (current) => ({
    schema_version: "1",
    ok: false,
    error: createProjectError("STATE_INVALID", {
      phase_instance: current.value.phase_instance,
      issue_code: NEW_INTENT,
    }),
  }));
  if (probed.ok) {
    return Object.freeze({ schema_version: "1", ok: true, value: probed.value.outcome });
  }
  if (
    probed.error.code === "STATE_INVALID" &&
    probed.error.diagnostic.parameters.issue_code === NEW_INTENT
  ) {
    return Object.freeze({ schema_version: "1", ok: true, value: undefined });
  }
  return probed;
}

import type { ToolHandlerRegistry } from "../server.js";
import { handleCounterReview } from "./counter-review.js";
import { handleGate } from "./gate.js";
import { handleState } from "./state.js";
import { handleWaiver } from "./waiver.js";
import { handleSemanticApply, handleSemanticStatus } from "./semantic.js";

/** The complete and only live MCP workflow registry. */
export function createToolHandlers(): ToolHandlerRegistry {
  return Object.freeze({
    archflow_state: handleState,
    archflow_counter_review: handleCounterReview,
    archflow_gate: handleGate,
    archflow_waiver: handleWaiver,
    archflow_status: handleSemanticStatus,
    archflow_apply: handleSemanticApply,
  });
}

import type { ToolHandlerRegistry } from "../server.js";
import { handleAdjudicate } from "./adjudicate.js";
import { handleCounterReview } from "./counter-review.js";
import { handleGate } from "./gate.js";
import { handleState } from "./state.js";
import { handleWaiver } from "./waiver.js";

/** The complete and only live MCP workflow registry. */
export function createToolHandlers(): ToolHandlerRegistry {
  return Object.freeze({
    archflow_state: handleState,
    archflow_counter_review: handleCounterReview,
    archflow_adjudicate: handleAdjudicate,
    archflow_gate: handleGate,
    archflow_waiver: handleWaiver,
  });
}

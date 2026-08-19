import type { ToolHandlerRegistry } from "../server.js";
import { handleCounterReview } from "./counter-review.js";
import { handleState } from "./state.js";
import { handleSemanticApply, handleSemanticStatus } from "./semantic.js";

/**
 * The complete and only live MCP workflow registry. The semantic pair is advertised and
 * dispatched; `handleState`/`handleCounterReview` remain registered internal services invoked by
 * the semantic handler, never dispatched by name.
 */
export function createToolHandlers(): ToolHandlerRegistry {
  return Object.freeze({
    archflow_status: handleSemanticStatus,
    archflow_apply: handleSemanticApply,
  });
}

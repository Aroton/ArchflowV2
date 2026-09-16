import { runSimpleReview } from "../../review/simple-review.js";
import type { ToolHandlerRegistry } from "../server.js";
import { handleCounterReview } from "./counter-review.js";
import { handleState } from "./state.js";
import { handleSemanticApply, handleSemanticStatus } from "./semantic.js";

/**
 * The live MCP registry includes standalone review and the semantic workflow pair. Both are
 * dispatched; `handleState`/`handleCounterReview` remain internal services invoked by
 * the semantic handler, never dispatched by name.
 */
export function createToolHandlers(): ToolHandlerRegistry {
  return Object.freeze({
    archflow_review: runSimpleReview,
    archflow_status: handleSemanticStatus,
    archflow_apply: handleSemanticApply,
  });
}

export const TOOL_NAMES = Object.freeze([
  "archflow_state",
  "archflow_counter_review",
  "archflow_gate",
  "archflow_waiver"
] as const);

export type ToolName = (typeof TOOL_NAMES)[number];

/** Public semantic tools are intentionally outside the durable low-level tool vocabulary. */
export const SEMANTIC_TOOL_NAMES = Object.freeze([
  "archflow_status",
  "archflow_apply"
] as const);

export type SemanticToolName = (typeof SEMANTIC_TOOL_NAMES)[number];
export const ADVERTISED_TOOL_NAMES = Object.freeze([...TOOL_NAMES, ...SEMANTIC_TOOL_NAMES] as const);
export type AdvertisedToolName = (typeof ADVERTISED_TOOL_NAMES)[number];

export function isToolName(value: unknown): value is ToolName {
  return typeof value === "string" && (TOOL_NAMES as readonly string[]).includes(value);
}

export function isSemanticToolName(value: unknown): value is SemanticToolName {
  return typeof value === "string" && (SEMANTIC_TOOL_NAMES as readonly string[]).includes(value);
}

export function isAdvertisedToolName(value: unknown): value is AdvertisedToolName {
  return typeof value === "string" && (ADVERTISED_TOOL_NAMES as readonly string[]).includes(value);
}

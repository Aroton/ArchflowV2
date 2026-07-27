export const TOOL_NAMES = Object.freeze([
  "archflow_state",
  "archflow_counter_review",
  "archflow_adjudicate",
  "archflow_gate",
  "archflow_waiver"
] as const);

export type ToolName = (typeof TOOL_NAMES)[number];

export function isToolName(value: unknown): value is ToolName {
  return typeof value === "string" && (TOOL_NAMES as readonly string[]).includes(value);
}

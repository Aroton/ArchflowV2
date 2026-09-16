import { dispatchUsageSchema, type DispatchUsage } from "../contracts/dispatch-usage.js";

/** Read only known numeric accounting fields from a terminal Claude wrapper, even on failure. */
export function claudeDispatchUsage(stdout: Uint8Array): DispatchUsage | undefined {
  try {
    const wrapper: unknown = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(stdout));
    if (wrapper === null || typeof wrapper !== "object" || Array.isArray(wrapper)) return undefined;
    const record = wrapper as Record<string, unknown>;
    const usage = record.usage !== null && typeof record.usage === "object" && !Array.isArray(record.usage)
      ? record.usage as Record<string, unknown> : {};
    const details = usage.output_tokens_details !== null && typeof usage.output_tokens_details === "object"
      ? usage.output_tokens_details as Record<string, unknown> : {};
    const candidate: Record<string, number> = {};
    for (const [name, value] of Object.entries({
      input_tokens: usage.input_tokens,
      output_tokens: usage.output_tokens,
      cache_read_input_tokens: usage.cache_read_input_tokens,
      cache_creation_input_tokens: usage.cache_creation_input_tokens,
      thinking_tokens: details.thinking_tokens,
      num_turns: record.num_turns,
      duration_ms: record.duration_ms,
      duration_api_ms: record.duration_api_ms,
      total_cost_usd: record.total_cost_usd,
    })) {
      if (typeof value === "number" && Number.isFinite(value) && value >= 0 &&
          (name === "total_cost_usd" || Number.isSafeInteger(value))) candidate[name] = value;
    }
    return Object.keys(candidate).length === 0 ? undefined : dispatchUsageSchema.parse(candidate) as DispatchUsage;
  } catch { return undefined; }
}

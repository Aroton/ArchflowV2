import { dispatchUsageSchema, type DispatchUsage } from "../contracts/dispatch-usage.js";
import type { AdapterId } from "../contracts/review.js";

function isNonNegativeSafeInt(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

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

/**
 * Sum known numeric token accounting fields across terminal `turn.completed` JSONL events emitted
 * by `codex exec --json`. Missing or malformed lines are ignored; never invents zeros.
 */
export function codexDispatchUsage(stdout: Uint8Array): DispatchUsage | undefined {
  let text: string;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(stdout);
  } catch {
    return undefined;
  }
  const totals: Record<string, number> = {};
  let turnsWithUsage = 0;

  for (const line of text.split(/\r?\n/u)) {
    if (line.trim() === "") continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      continue;
    }
    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) continue;
    const event = parsed as Record<string, unknown>;
    if (event.type !== "turn.completed") continue;
    const usage = event.usage;
    if (usage === null || typeof usage !== "object" || Array.isArray(usage)) continue;
    const u = usage as Record<string, unknown>;
    const mapped: ReadonlyArray<readonly [string, unknown]> = [
      ["input_tokens", u.input_tokens],
      ["output_tokens", u.output_tokens],
      ["cache_read_input_tokens", u.cached_input_tokens],
      ["cache_creation_input_tokens", u.cache_write_input_tokens],
      ["thinking_tokens", u.reasoning_output_tokens],
    ];
    let turnHadField = false;
    for (const [name, value] of mapped) {
      if (!isNonNegativeSafeInt(value)) continue;
      const next = (totals[name] ?? 0) + value;
      if (!Number.isSafeInteger(next)) continue;
      totals[name] = next;
      turnHadField = true;
    }
    if (turnHadField) turnsWithUsage += 1;
  }

  if (turnsWithUsage === 0) return undefined;
  totals.num_turns = turnsWithUsage;
  try {
    return dispatchUsageSchema.parse(totals) as DispatchUsage;
  } catch {
    return undefined;
  }
}

/** Extract CLI-reported accounting fields for adapters that emit structured usage on stdout. */
export function dispatchUsageForAdapter(adapter: AdapterId, stdout: Uint8Array): DispatchUsage | undefined {
  if (adapter === "claude-cli") return claudeDispatchUsage(stdout);
  if (adapter === "codex-cli") return codexDispatchUsage(stdout);
  return undefined;
}

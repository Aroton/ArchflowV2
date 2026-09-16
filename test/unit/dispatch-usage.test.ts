import { describe, expect, it } from "vitest";
import { claudeDispatchUsage } from "../../src/dispatch/usage.js";

const bytes = (value: unknown) => new TextEncoder().encode(JSON.stringify(value));
describe("Claude dispatch accounting", () => {
  it("retains totals and the thinking subset without adding thinking to output twice", () => {
    expect(claudeDispatchUsage(bytes({
      usage: { input_tokens: 12, output_tokens: 100, cache_read_input_tokens: 2000,
        cache_creation_input_tokens: 300, output_tokens_details: { thinking_tokens: 80 } },
      num_turns: 4, duration_ms: 1000, duration_api_ms: 800, total_cost_usd: 0.025,
      result: "private output", session_id: "private session", structured_output: { outcome: "no_issues_found" },
    }))).toEqual({ input_tokens: 12, output_tokens: 100, cache_read_input_tokens: 2000,
      cache_creation_input_tokens: 300, thinking_tokens: 80, num_turns: 4,
      duration_ms: 1000, duration_api_ms: 800, total_cost_usd: 0.025 });
  });
  it("keeps reported zero on failure but does not invent missing measurements", () => {
    expect(claudeDispatchUsage(bytes({ is_error: true, usage: { output_tokens: 0 }, total_cost_usd: 0 })))
      .toEqual({ output_tokens: 0, total_cost_usd: 0 });
    expect(claudeDispatchUsage(bytes({ structured_output: {} }))).toBeUndefined();
    expect(claudeDispatchUsage(new TextEncoder().encode('{truncated'))).toBeUndefined();
  });
  it("ignores invalid fields without losing independent valid measurements", () => {
    expect(claudeDispatchUsage(bytes({ usage: { input_tokens: -1, output_tokens: "huge",
      cache_read_input_tokens: 1.5, cache_creation_input_tokens: 3 }, total_cost_usd: -1, num_turns: 2 })))
      .toEqual({ cache_creation_input_tokens: 3, num_turns: 2 });
  });
});

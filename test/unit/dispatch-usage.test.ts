import { describe, expect, it } from "vitest";
import { claudeDispatchUsage, codexDispatchUsage, dispatchUsageForAdapter } from "../../src/dispatch/usage.js";

const bytes = (value: unknown) => new TextEncoder().encode(JSON.stringify(value));
const jsonl = (...lines: unknown[]) => new TextEncoder().encode(`${lines.map((line) => (typeof line === "string" ? line : JSON.stringify(line))).join("\n")}\n`);

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

describe("Codex dispatch accounting", () => {
  it("extracts and sums token usage across turn.completed JSONL events", () => {
    const out = jsonl(
      { type: "thread.started", thread_id: "01a20fa0-f603-75b2-9c76-b4267abefbb2" },
      { type: "turn.started" },
      { type: "turn.completed", usage: { input_tokens: 19305, cached_input_tokens: 11392, cache_write_input_tokens: 0, output_tokens: 45, reasoning_output_tokens: 12 } },
      "{truncated line",
      { type: "turn.completed", usage: { input_tokens: 5000, cached_input_tokens: 4000, output_tokens: 100, reasoning_output_tokens: 30 } },
    );
    expect(codexDispatchUsage(out)).toEqual({
      input_tokens: 24305,
      output_tokens: 145,
      cache_read_input_tokens: 15392,
      cache_creation_input_tokens: 0,
      thinking_tokens: 42,
      num_turns: 2,
    });
  });

  it("returns undefined when turn.completed carries no valid usage fields", () => {
    expect(codexDispatchUsage(jsonl({ type: "turn.completed" }))).toBeUndefined();
    expect(codexDispatchUsage(jsonl({ type: "turn.completed", usage: { input_tokens: -5, output_tokens: "bad" } }))).toBeUndefined();
    expect(codexDispatchUsage(new TextEncoder().encode("not json"))).toBeUndefined();
  });

  it("routes adapter extraction cleanly for claude-cli, codex-cli, and antigravity-cli", () => {
    const codexOut = jsonl({ type: "turn.completed", usage: { input_tokens: 100, output_tokens: 10 } });
    expect(dispatchUsageForAdapter("codex-cli", codexOut)).toEqual({ input_tokens: 100, output_tokens: 10, num_turns: 1 });
    expect(dispatchUsageForAdapter("antigravity-cli", codexOut)).toBeUndefined();
  });
});

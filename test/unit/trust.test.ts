import { describe, expect, it } from "vitest";

import { assertAdapterFamily } from "../../src/contracts/trust.js";

describe("adapter-family relation", () => {
  it("accepts each adapter only with its own model family", () => {
    expect(() => assertAdapterFamily("claude-cli", "claude")).not.toThrow();
    expect(() => assertAdapterFamily("codex-cli", "codex")).not.toThrow();
    expect(() => assertAdapterFamily("antigravity-cli", "gemini")).not.toThrow();
    for (const [adapter, family] of [["claude-cli", "codex"], ["codex-cli", "claude"], ["antigravity-cli", "codex"]] as const) {
      expect(() => assertAdapterFamily(adapter, family)).toThrow(/adapter and model family/);
    }
  });
});

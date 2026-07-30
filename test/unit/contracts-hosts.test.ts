import { readFile } from "node:fs/promises";

import { describe, expect, it } from "vitest";

import { deriveHostIdentity } from "../../src/contracts/hosts.js";

type InitializeFixture = Readonly<{
  params: Readonly<{
    clientInfo: Readonly<{ name: string; version: string }>;
  }>;
}>;

async function fixture(name: string): Promise<InitializeFixture> {
  return JSON.parse(await readFile(
    new URL(`../fixtures/dispatch/handshakes/${name}.json`, import.meta.url),
    "utf8"
  )) as InitializeFixture;
}

describe("host identity", () => {
  it("derives every recorded supported handshake", async () => {
    const claude = await fixture("claude-code-2.1.220");
    const codex = await fixture("codex-mcp-client-0.146.0");

    expect(deriveHostIdentity(claude.params.clientInfo)).toBe("claude");
    expect(deriveHostIdentity(codex.params.clientInfo)).toBe("codex");
  });

  it("derives supported hosts across client version updates", () => {
    expect(deriveHostIdentity({ name: "claude-code", version: "2.1.221" })).toBe("claude");
    expect(deriveHostIdentity({ name: "codex-mcp-client", version: "0.147.0" })).toBe("codex");
  });

  it.each([
    ["missing", undefined],
    ["null", null],
    ["missing name", { version: "2.1.220" }],
    ["missing version", { name: "claude-code" }],
    ["malformed name", { name: 1, version: "2.1.220" }],
    ["malformed version", { name: "claude-code", version: 1 }],
    ["ambiguous", { name: "claude-code codex-mcp-client", version: "2.1.220" }],
    ["unknown client", { name: "third-party-client", version: "1.0.0" }]
  ])("returns unknown for %s clientInfo", (_label, clientInfo) => {
    expect(deriveHostIdentity(clientInfo as never)).toBe("unknown");
  });

  it("does not infer identity from substrings or casing", () => {
    expect(deriveHostIdentity({ name: "Claude Code", version: "2.1.220" })).toBe("unknown");
    expect(deriveHostIdentity({ name: "Codex", version: "0.146.0" })).toBe("unknown");
    expect(deriveHostIdentity({ name: "third-party-claude-code", version: "2.1.220" })).toBe("unknown");
    expect(deriveHostIdentity({ name: "codex-mcp-client-preview", version: "0.146.0" })).toBe("unknown");
  });
});

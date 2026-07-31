import { readFile } from "node:fs/promises";

import { describe, expect, it } from "vitest";

import { parseConfigYaml, ROUTING_ROLES, type ConfigV1 } from "../../src/contracts/config.js";
import { resolveDispatchRoute } from "../../src/dispatch/routing.js";

const template = () => readFile(new URL("../../assets/config.template.yaml", import.meta.url), "utf8");

function commentedCodexOrientation(source: string): string {
  const marker = "# Codex-producer orientation";
  const block = source.slice(source.indexOf(marker)).split("\n").slice(1);
  return block.map((line) => line.startsWith("# ") ? line.slice(2) : line === "#" ? "" : line).join("\n");
}

function expectOrientation(config: ConfigV1, producerFamily: "claude" | "codex"): void {
  const producerModel = producerFamily === "claude" ? "claude-opus-5" : "gpt-5.6-sol";
  const producerEffort = producerFamily === "claude" ? "high" : "xhigh";
  const reviewerModel = producerFamily === "claude" ? "gpt-5.6-sol" : "claude-opus-5";
  const reviewerEffort = producerFamily === "claude" ? "xhigh" : "high";

  for (const role of ROUTING_ROLES) {
    const route = resolveDispatchRoute(config, "phase-impl", role, producerFamily);
    const isOppositeFamily = role === "counter-reviewer" || role === "adjudicator";
    expect(route).toMatchObject({
      model: isOppositeFamily ? reviewerModel : producerModel,
      effort: isOppositeFamily ? reviewerEffort : producerEffort,
    });
    if (route.family === "claude") expect(route.effort).not.toBe("ultra");
  }
}

describe("Phase 16 config template", () => {
  it("parses and resolves every active Claude-producer route", async () => {
    expectOrientation(parseConfigYaml(await template(), "config.template.yaml"), "claude");
  });

  it("documents a parseable Codex-producer orientation with the families swapped", async () => {
    const source = await template();
    expectOrientation(parseConfigYaml(commentedCodexOrientation(source), "commented Codex orientation"), "codex");
  });
});

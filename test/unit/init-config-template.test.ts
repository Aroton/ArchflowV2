import { readFile } from "node:fs/promises";

import { describe, expect, it } from "vitest";

import { parseConfigYaml, ROUTING_ROLES, type ConfigV1 } from "../../src/contracts/config.js";
import { resolveDispatchRoute } from "../../src/dispatch/routing.js";

const template = () => readFile(new URL("../../assets/config.template.yaml", import.meta.url), "utf8");

function commentedCodexOrientation(source: string): string {
  const marker = "# Codex-host orientation";
  const block = source.slice(source.indexOf(marker)).split("\n").slice(1);
  return block.map((line) => line.startsWith("# ") ? line.slice(2) : line === "#" ? "" : line).join("\n");
}

function expectOrientation(config: ConfigV1, hostFamily: "claude" | "codex"): void {
  const reviewerModel = hostFamily === "claude" ? "gpt-5.6-sol" : "claude-opus-5";
  const reviewerEffort = hostFamily === "claude" ? "xhigh" : "high";

  for (const role of ROUTING_ROLES) {
    const route = resolveDispatchRoute(config, "phase-impl", role);
    expect(route).toMatchObject({
      model: reviewerModel,
      effort: reviewerEffort,
    });
    // The template's default reviewer is the host's opposite family; a claude
    // reviewer never ships with the claude-unsupported ultra effort.
    expect(route.family).not.toBe(hostFamily);
    if (route.family === "claude") expect(route.effort).not.toBe("ultra");
  }
}

describe("config template", () => {
  it("parses and resolves every active claude-host route", async () => {
    const config = parseConfigYaml(await template(), "config.template.yaml");
    expectOrientation(config, "claude");
    expect(config.approval_rules).toEqual({
      subjects: ["prd", "design"],
      content: [
        { paths: ["**/*.sql"] },
        { paths: [".archflow/tasks/*/design.md", ".archflow/tasks/*/prd.md"] },
      ],
    });
    expect(config.approval_rules?.subjects).not.toContain("phase-design");
  });

  it("documents a parseable codex-host orientation with the families swapped", async () => {
    const source = await template();
    expectOrientation(parseConfigYaml(commentedCodexOrientation(source), "commented codex-host orientation"), "codex");
  });

  it("documents secondary repository declarations without enabling them by default", async () => {
    const source = await template();
    const parsed = parseConfigYaml(source, "config.template.yaml");

    expect(parsed.repositories).toBeUndefined();
    expect(source).toContain("repositories:");
  });
});

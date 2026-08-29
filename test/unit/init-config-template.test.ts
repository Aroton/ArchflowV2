import { readFile } from "node:fs/promises";

import { describe, expect, it } from "vitest";

import { parseConfigYaml, ROUTING_ROLES, type ConfigV1 } from "../../src/contracts/config.js";
import { resolveDispatchRoute, resolveDispatchRoutes } from "../../src/dispatch/routing.js";

const template = () => readFile(new URL("../../assets/config.template.yaml", import.meta.url), "utf8");

describe("config template", () => {
  it("parses and resolves routes for claude, antigravity, and codex producers", async () => {
    const config = parseConfigYaml(await template(), "config.template.yaml");

    // Claude host
    expect(resolveDispatchRoute(config, "phase-impl", "counter-reviewer", "claude")).toMatchObject({
      model: "gpt-5.6-sol",
      effort: "high",
      family: "codex",
      adapter: "codex-cli",
    });
    expect(resolveDispatchRoute(config, "phase-impl", "adjudicator", "claude")).toMatchObject({
      model: "gemini-3.7-flash-high",
      effort: "high",
      family: "gemini",
      adapter: "antigravity-cli",
    });

    // Antigravity host (multi-reviewer)
    expect(resolveDispatchRoutes(config, "phase-impl", "counter-reviewer", "antigravity")).toEqual([
      { model: "gpt-5.6-sol", effort: "high", family: "codex", adapter: "codex-cli" },
      { model: "claude-fable-5", effort: "medium", family: "claude", adapter: "claude-cli" },
    ]);
    expect(resolveDispatchRoute(config, "phase-impl", "adjudicator", "antigravity")).toMatchObject({
      model: "gemini-3.7-flash-high",
      effort: "high",
      family: "gemini",
      adapter: "antigravity-cli",
    });

    // Codex host
    expect(resolveDispatchRoute(config, "phase-impl", "counter-reviewer", "codex")).toMatchObject({
      model: "claude-fable-5",
      effort: "medium",
      family: "claude",
      adapter: "claude-cli",
    });
    expect(resolveDispatchRoute(config, "phase-impl", "adjudicator", "codex")).toMatchObject({
      model: "gemini-3.7-flash-high",
      effort: "high",
      family: "gemini",
      adapter: "antigravity-cli",
    });

    // Fallback roles
    expect(resolveDispatchRoute(config, "phase-impl", "counter-reviewer")).toMatchObject({
      model: "gpt-5.6-sol",
      effort: "high",
    });

    expect(config.approval_rules).toEqual({
      subjects: ["prd", "design"],
      content: [
        { paths: ["**/*.sql"] },
        { paths: [".archflow/tasks/*/design.md", ".archflow/tasks/*/prd.md"] },
      ],
    });
    expect(config.approval_rules?.subjects).not.toContain("phase-design");
  });

  it("documents secondary repository declarations without enabling them by default", async () => {
    const source = await template();
    const parsed = parseConfigYaml(source, "config.template.yaml");

    expect(parsed.repositories).toBeUndefined();
    expect(source).toContain("repositories:");
  });
});

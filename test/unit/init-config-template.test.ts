import { readFile } from "node:fs/promises";

import { describe, expect, it } from "vitest";

import { parseConfigYaml, ROUTING_ROLES, type ConfigV1 } from "../../src/contracts/config.js";
import { configuredRoute, configuredRoutes } from "../helpers/dispatch-routes.js";

const template = () => readFile(new URL("../../assets/config.template.yaml", import.meta.url), "utf8");

describe("config template", () => {
  it("parses and resolves routes for claude, antigravity, and codex producers", async () => {
    const config = parseConfigYaml(await template(), "config.template.yaml");

    // Claude host
    expect(configuredRoute(config, "phase-impl", "counter-reviewer", "claude")).toMatchObject({
      model: "gpt-6.1-sol",
      effort: "high",
      family: "codex",
      adapter: "codex-cli",
    });
    expect(configuredRoute(config, "phase-impl", "adjudicator", "claude")).toMatchObject({
      model: "claude-opus-5-5",
      effort: "high",
      family: "claude",
      adapter: "claude-cli",
    });

    // Antigravity host (multi-reviewer)
    expect(configuredRoutes(config, "phase-impl", "counter-reviewer", "antigravity")).toEqual([
      { model: "gpt-6.1-sol", effort: "high", family: "codex", adapter: "codex-cli" },
      { model: "claude-opus-5-5", effort: "medium", family: "claude", adapter: "claude-cli" },
    ]);
    expect(configuredRoute(config, "phase-impl", "adjudicator", "antigravity")).toMatchObject({
      model: "claude-opus-5-5",
      effort: "high",
      family: "claude",
      adapter: "claude-cli",
    });

    // Codex host
    expect(configuredRoute(config, "phase-impl", "counter-reviewer", "codex")).toMatchObject({
      model: "claude-opus-5-5",
      effort: "medium",
      family: "claude",
      adapter: "claude-cli",
    });
    expect(configuredRoute(config, "phase-impl", "adjudicator", "codex")).toMatchObject({
      model: "claude-opus-5-5",
      effort: "high",
      family: "claude",
      adapter: "claude-cli",
    });

    // Fallback roles
    expect(configuredRoute(config, "phase-impl", "counter-reviewer")).toMatchObject({
      model: "gpt-6.1-sol",
      effort: "high",
    });
    expect(configuredRoute(config, "phase-impl", "test-reviewer")).toMatchObject({
      model: "gpt-6.1-sol",
      effort: "low",
      family: "codex",
      adapter: "codex-cli",
    });

    expect(config.approval_rules).toEqual({
      subjects: [],
      content: [
        { paths: ["**/*.sql"] },
      ],
    });
  });

  it("writes only the keys review reads", async () => {
    const config = parseConfigYaml(await template(), "config.template.yaml");

    expect(Object.keys(config).sort()).toEqual(["approval_rules", "producers", "roles", "schema_version"]);
    expect(Object.keys(config.roles).sort()).toEqual([...ROUTING_ROLES].sort());
    for (const host of ["claude", "codex", "antigravity"] as const) {
      expect(Object.keys(config.producers?.[host] ?? {}).every((role) => role === "counter-reviewers" || (ROUTING_ROLES as readonly string[]).includes(role))).toBe(true);
    }
  });

  it("reads a config written by the earlier template and resolves the same routes", async () => {
    const legacySource = await readFile(new URL("../fixtures/foundation/config/legacy-template.yaml", import.meta.url), "utf8");
    // The fixture is the template as shipped before review dropped the task workflow's keys.
    for (const key of ["implementation:", "effort-reviewer:", "max_attempts:", "repositories:", "subjects: [prd, design]"]) {
      expect(legacySource).toContain(key);
    }
    const legacy = parseConfigYaml(legacySource, "legacy-template.yaml");
    expect(legacy.implementation).toBeDefined();
    expect(legacy.roles["effort-reviewer"]).toBeDefined();
    const current = parseConfigYaml(await template(), "config.template.yaml");
    const routes = (config: ConfigV1) => (["phase-design", "phase-impl"] as const).flatMap((stage) =>
      ([undefined, "claude", "codex", "antigravity"] as const).flatMap((host) =>
        ROUTING_ROLES.map((role) => ({ stage, host, role, routes: configuredRoutes(config, stage, role, host) }))));
    expect(routes(legacy)).toEqual(routes(current));
  });
});

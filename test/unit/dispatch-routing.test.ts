import { describe, expect, it } from "vitest";

import { parseConfigV1, type ConfigV1 } from "../../src/contracts/config.js";
import { EFFORT_VALUES } from "../../src/contracts/review.js";
import { classifiedDispatchFailure } from "../../src/dispatch/failure-classification.js";
import { DispatchRoutingError, routeFromConfiguredRoute, type RoutingRole } from "../../src/dispatch/routing.js";
import { configuredRoute, configuredRoutes, selectedRoutes } from "../helpers/dispatch-routes.js";

const config = (roles: ConfigV1["roles"], overrides?: ConfigV1["overrides"]): ConfigV1 => ({
  schema_version: "1",
  roles,
  ...(overrides === undefined ? {} : { overrides }),
});

/** The single route a role selects (the first candidate), with its provenance. */
const selectRoute = (...args: Parameters<typeof selectedRoutes>) => selectedRoutes(...args)[0]!;

function expectRoutingError(run: () => unknown, code: DispatchRoutingError["project_error"]["code"], parameters: unknown): void {
  try {
    run();
  } catch (error) {
    expect(error).toBeInstanceOf(DispatchRoutingError);
    const routing = error as DispatchRoutingError;
    expect(routing.project_error.code).toBe(code);
    expect(routing.project_error.diagnostic.parameters).toEqual(parameters);
    return;
  }
  throw new Error(`expected ${code}`);
}

describe("dispatch routing", () => {
  it("rejects Astra max in configured and invocation routes", () => {
    const forbidden = { model: "gpt-6-astra", effort: "max" } as const;
    const allowed = config({ "counter-reviewer": { model: "gpt-5.6-sol", effort: "medium" } });
    for (const run of [
      () => selectRoute(config({ "counter-reviewer": forbidden }), "phase-design", "counter-reviewer"),
      () => selectRoute(allowed, "phase-design", "counter-reviewer", forbidden),
    ]) {
      expectRoutingError(run, "CONFIG_INVALID", { issue_code: "astra-max-disallowed" });
      try { run(); } catch (error) {
        expect(classifiedDispatchFailure(error)?.message).toBe("GPT-6 Astra max effort is disabled. Choose low or high effort.");
      }
    }
    for (const effort of ["low", "high"] as const) {
      expect(routeFromConfiguredRoute({ model: "gpt-6-astra", effort })).toMatchObject({ model: "gpt-6-astra", effort, adapter: "codex-cli" });
    }
  });
  it("derives family and adapter from configured full model slugs", () => {
    expect(configuredRoute(config({ "counter-reviewer": { model: "gpt-5.3-codex", effort: "high" } }), "phase-design", "counter-reviewer"))
      .toEqual({ adapter: "codex-cli", family: "codex", model: "gpt-5.3-codex", effort: "high" });
    expect(configuredRoute(config({ adjudicator: { model: "claude-opus-4-6", effort: "max" } }), "phase-impl", "adjudicator"))
      .toEqual({ adapter: "claude-cli", family: "claude", model: "claude-opus-4-6", effort: "max" });
  });

  it("prefers a phase-kind override and falls back to the base role", () => {
    const value = config(
      { "counter-reviewer": { model: "gpt-5.3-codex", effort: "high" } },
      { "phase-design": { "counter-reviewer": { model: "gpt-5.4", effort: "xhigh" } } },
    );
    expect(configuredRoute(value, "phase-design", "counter-reviewer").model).toBe("gpt-5.4");
    expect(configuredRoute(value, "phase-impl", "counter-reviewer").model).toBe("gpt-5.3-codex");
  });

  it("parses the legacy explore, prd, and design overrides and never routes through them", () => {
    const legacy = { "counter-reviewer": { model: "gpt-legacy", effort: "high" }, "test-reviewer": { model: "gpt-legacy", effort: "high" } };
    const value = parseConfigV1({
      schema_version: "1",
      roles: { "counter-reviewer": { model: "gpt-5.3-codex", effort: "high" } },
      overrides: { explore: legacy, prd: legacy, design: legacy },
    });
    for (const phaseKind of ["phase-design", "phase-impl"] as const) {
      expect(configuredRoute(value, phaseKind, "counter-reviewer").model).toBe("gpt-5.3-codex");
      expect(configuredRoute(value, phaseKind, "test-reviewer").model).toBe("gpt-6.1-sol");
    }
  });

  it("routes the optional test reviewer with producer and phase precedence", () => {
    const value: ConfigV1 = {
      schema_version: "1",
      roles: { "test-reviewer": { model: "gpt-5.6-luna", effort: "max" } },
      producers: {
        codex: { "test-reviewer": { model: "gpt-5.6-luna-fast", effort: "xhigh" } },
      },
      overrides: {
        "phase-impl": { "test-reviewer": { model: "gpt-5.6-luna-impl", effort: "max" } },
      },
    };
    expect(configuredRoute(value, "phase-design", "test-reviewer", "codex").model)
      .toBe("gpt-5.6-luna-fast");
    expect(configuredRoute(value, "phase-impl", "test-reviewer", "codex").model)
      .toBe("gpt-5.6-luna-fast");
    expect(configuredRoute(value, "phase-impl", "test-reviewer", "claude").model)
      .toBe("gpt-5.6-luna-impl");
    expect(configuredRoute(value, "phase-design", "test-reviewer", "claude").model)
      .toBe("gpt-5.6-luna");
  });

  it("falls back to the built-in test reviewer when no test-reviewer route is configured", () => {
    const builtIn = { adapter: "codex-cli", family: "codex", model: "gpt-6.1-sol", effort: "low" };
    const otherRolesOnly: ConfigV1 = {
      schema_version: "1",
      roles: { "counter-reviewer": { model: "gpt-5.3-codex", effort: "high" } },
      producers: { claude: { adjudicator: { model: "claude-opus-4-6", effort: "high" } } },
      overrides: { "phase-impl": { "counter-reviewer": { model: "gpt-5.4", effort: "high" } } },
    };
    for (const value of [config({}), otherRolesOnly]) {
      for (const phaseKind of ["phase-design", "phase-impl"] as const) {
        for (const host of [undefined, "claude", "codex", "antigravity"] as const) {
          expect(selectRoute(value, phaseKind, "test-reviewer", undefined, host)).toMatchObject({
            route: builtIn,
            source: { provenance: "configured" },
          });
        }
      }
    }
  });

  it("classifies an absent dispatched role without returning a route", () => {
    expectRoutingError(
      () => configuredRoute(config({}), "phase-impl", "counter-reviewer"),
      "CONFIG_INVALID",
      { issue_code: "route-missing" },
    );
  });

  it("rejects Claude ultra effort before dispatch", () => {
    expectRoutingError(
      () => configuredRoute(config({ adjudicator: { model: "claude-opus-4-6", effort: "ultra" } }), "phase-design", "adjudicator"),
      "CONFIG_INVALID",
      { issue_code: "effort-unsupported" },
    );
  });

  it.each(EFFORT_VALUES)("accepts Codex %s effort", (effort) => {
    expect(configuredRoute(
      config({ adjudicator: { model: "gpt-5.4", effort } }),
      "phase-design",
      "adjudicator",
    ).effort).toBe(effort);
  });

  it("rejects an unsupported Codex effort before dispatch", () => {
    const invalid = config({ adjudicator: { model: "gpt-5.4", effort: "bogus" as never } });
    expectRoutingError(
      () => configuredRoute(invalid, "phase-design", "adjudicator"),
      "CONFIG_INVALID",
      { issue_code: "effort-unsupported" },
    );
  });

  it("does not conflate routing counter-reviewer with evidence counter-review", () => {
    expectRoutingError(
      () => configuredRoute(
        config({ "counter-reviewer": { model: "gpt-5.4", effort: "high" } }),
        "phase-design",
        "counter-review" as RoutingRole,
      ),
      "CONFIG_INVALID",
      { issue_code: "route-missing" },
    );
  });

  it("accepts an explicitly configured same-family counter-reviewer", () => {
    expect(configuredRoute(config({ "counter-reviewer": { model: "claude-opus-4-6", effort: "high" } }), "phase-design", "counter-reviewer"))
      .toEqual({ adapter: "claude-cli", family: "claude", model: "claude-opus-4-6", effort: "high" });
  });

  it("accepts an explicitly configured same-family adjudicator", () => {
    expect(configuredRoute(config({ adjudicator: { model: "gpt-5.4", effort: "high" } }), "phase-design", "adjudicator"))
      .toEqual({ adapter: "codex-cli", family: "codex", model: "gpt-5.4", effort: "high" });
  });

  it("routes a cc-switch provider through the claude CLI regardless of model name", () => {
    expect(configuredRoute(config({ "counter-reviewer": { model: "glm-5.3", effort: "high", provider: "zai" } }), "phase-design", "counter-reviewer"))
      .toEqual({ adapter: "claude-cli", family: "claude", model: "glm-5.3", effort: "high", provider: "zai" });
    expect(configuredRoute(config({ "counter-reviewer": { model: "claude-opus-4-6", effort: "high", provider: "zai" } }), "phase-design", "counter-reviewer"))
      .toEqual({ adapter: "claude-cli", family: "claude", model: "claude-opus-4-6", effort: "high", provider: "zai" });
  });

  it("refuses a cc-switch provider paired with a codex model", () => {
    expectRoutingError(
      () => configuredRoute(config({ adjudicator: { model: "gpt-5.4", effort: "high", provider: "zai" } }), "phase-design", "adjudicator"),
      "CONFIG_INVALID",
      { issue_code: "provider-unsupported" },
    );
  });

  it("guards error construction for unsafe and unsupported configured models", () => {
    expectRoutingError(
      () => configuredRoute(config({ adjudicator: { model: "openai/gpt-5", effort: "high" } }), "phase-design", "adjudicator"),
      "CONFIG_INVALID",
      { issue_code: "model-not-safe-id" },
    );
    expectRoutingError(
      () => configuredRoute(config({ adjudicator: { model: "mistral-large", effort: "high" } }), "phase-design", "adjudicator"),
      "CONFIG_MODEL_UNSUPPORTED",
      { model: "mistral-large" },
    );
  });

  it("resolves gemini models to antigravity-cli adapter and gemini family", () => {
    expect(configuredRoute(config({ adjudicator: { model: "gemini-3.7-flash-high", effort: "high" } }), "phase-design", "adjudicator"))
      .toEqual({ adapter: "antigravity-cli", family: "gemini", model: "gemini-3.7-flash-high", effort: "high" });
  });

  it("resolves per-producer client specific routes and multiple counter-reviewers", () => {
    const fullConfig: ConfigV1 = {
      schema_version: "1",
      roles: {
        "counter-reviewer": { model: "gpt-5.6-sol", effort: "high" },
        adjudicator: { model: "gemini-3.7-flash-high", effort: "high" },
      },
      producers: {
        claude: {
          "counter-reviewer": { model: "gpt-5.6-sol", effort: "high" },
          adjudicator: { model: "gemini-3.7-flash-high", effort: "high" },
        },
        antigravity: {
          "counter-reviewers": [
            { model: "gpt-5.6-sol", effort: "high" },
            { model: "claude-fable-5", effort: "medium" },
          ],
          adjudicator: { model: "gemini-3.7-flash-high", effort: "high" },
        },
        codex: {
          "counter-reviewer": { model: "claude-fable-5", effort: "medium" },
          adjudicator: { model: "gemini-3.7-flash-high", effort: "high" },
        },
      },
    };

    // Claude host producer
    expect(configuredRoutes(fullConfig, "phase-design", "counter-reviewer", "claude"))
      .toEqual([{ adapter: "codex-cli", family: "codex", model: "gpt-5.6-sol", effort: "high" }]);

    // Antigravity host producer (multiple parallel reviewers)
    expect(configuredRoutes(fullConfig, "phase-design", "counter-reviewer", "antigravity"))
      .toEqual([
        { adapter: "codex-cli", family: "codex", model: "gpt-5.6-sol", effort: "high" },
        { adapter: "claude-cli", family: "claude", model: "claude-fable-5", effort: "medium" },
      ]);

    // Codex host producer
    expect(configuredRoutes(fullConfig, "phase-design", "counter-reviewer", "codex"))
      .toEqual([{ adapter: "claude-cli", family: "claude", model: "claude-fable-5", effort: "medium" }]);

    // Adjudicator for all hosts
    expect(configuredRoute(fullConfig, "phase-design", "adjudicator", "antigravity"))
      .toEqual({ adapter: "antigravity-cli", family: "gemini", model: "gemini-3.7-flash-high", effort: "high" });
  });
});

describe("route override validation", () => {
  it("holds a substitute route to the same rules as a pinned one", () => {
    expect(routeFromConfiguredRoute({ model: "claude-opus-4-6", effort: "high" }))
      .toEqual({ adapter: "claude-cli", family: "claude", model: "claude-opus-4-6", effort: "high" });
    expect(routeFromConfiguredRoute({ model: "glm-5.3", effort: "high", provider: "zhipu" }))
      .toEqual({ adapter: "claude-cli", family: "claude", model: "glm-5.3", effort: "high", provider: "zhipu" });
    expect(routeFromConfiguredRoute({ model: "gemini-3.7-flash-high", effort: "high" }))
      .toEqual({ adapter: "antigravity-cli", family: "gemini", model: "gemini-3.7-flash-high", effort: "high" });
  });

  it("rejects the same substitute shapes a pinned route rejects", () => {
    expectRoutingError(() => routeFromConfiguredRoute({ model: "not a safe id", effort: "high" }), "CONFIG_INVALID", { issue_code: "model-not-safe-id" });
    expectRoutingError(() => routeFromConfiguredRoute({ model: "gpt-5.3-codex", effort: "high", provider: "zhipu" }), "CONFIG_INVALID", { issue_code: "provider-unsupported" });
    expectRoutingError(() => routeFromConfiguredRoute({ model: "claude-opus-4-6", effort: "ultra" }), "CONFIG_INVALID", { issue_code: "effort-unsupported" });
    expectRoutingError(() => routeFromConfiguredRoute({ model: "llama-4", effort: "high" }), "CONFIG_MODEL_UNSUPPORTED", { model: "llama-4" });
  });
});

describe("role-level route selection provenance", () => {
  const configured = config({
    "counter-reviewer": { model: "gpt-configured", effort: "high" },
    adjudicator: { model: "claude-configured", effort: "max", provider: "configured-provider" },
  });

  it("uses configuration when no higher-precedence route is declared", () => {
    expect(selectRoute(configured, "phase-design", "counter-reviewer")).toMatchObject({
      route: { model: "gpt-configured", effort: "high" },
      source: { provenance: "configured" },
    });
  });

  it("selects invocation routing independently per role and records raw configured displacement", () => {
    expect(selectRoute(
      configured,
      "phase-design",
      "adjudicator",
      { model: "glm-5-3", effort: "high", provider: "invocation-provider" },
    )).toMatchObject({
      route: { adapter: "claude-cli", family: "claude", model: "glm-5-3", effort: "high", provider: "invocation-provider" },
      source: {
        provenance: "invocation-declared",
        displaced: {
          source: "configured",
          model: "claude-configured",
          effort: "max",
          provider: "configured-provider",
        },
      },
    });
    expect(selectRoute(configured, "phase-design", "counter-reviewer").source.provenance).toBe("configured");
  });

  it("permits invocation routing when the configured role is missing", () => {
    const missing = config({});
    expect(selectRoute(missing, "phase-impl", "counter-reviewer", { model: "gpt-invocation", effort: "high" }).source)
      .toEqual({ provenance: "invocation-declared" });
  });

  it("validates only the selected route and never falls back after an invalid invocation", () => {
    expectRoutingError(
      () => selectRoute(configured, "phase-design", "counter-reviewer", { model: "unsupported-model", effort: "high" }),
      "CONFIG_MODEL_UNSUPPORTED",
      { model: "unsupported-model" },
    );
    expect(selectRoute(
      config({ "counter-reviewer": { model: "unsupported-config", effort: "high" } }),
      "phase-design",
      "counter-reviewer",
      { model: "gpt-invocation", effort: "high" },
    ).route.model).toBe("gpt-invocation");
  });
});

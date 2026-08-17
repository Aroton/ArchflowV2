import { describe, expect, it } from "vitest";

import type { ConfigV1 } from "../../src/contracts/config.js";
import { EFFORT_VALUES } from "../../src/contracts/review.js";
import { DispatchRoutingError, resolveDispatchRoute, type RoutingRole } from "../../src/dispatch/routing.js";

const config = (roles: ConfigV1["roles"], overrides?: ConfigV1["overrides"]): ConfigV1 => ({
  schema_version: "1",
  roles,
  ...(overrides === undefined ? {} : { overrides }),
});

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
  it("derives family and adapter from configured full model slugs", () => {
    expect(resolveDispatchRoute(config({ "counter-reviewer": { model: "gpt-5.3-codex", effort: "high" } }), "design", "counter-reviewer"))
      .toEqual({ adapter: "codex-cli", family: "codex", model: "gpt-5.3-codex", effort: "high" });
    expect(resolveDispatchRoute(config({ adjudicator: { model: "claude-opus-4-6", effort: "max" } }), "prd", "adjudicator"))
      .toEqual({ adapter: "claude-cli", family: "claude", model: "claude-opus-4-6", effort: "max" });
  });

  it("prefers a phase-kind override and falls back to the base role", () => {
    const value = config(
      { "counter-reviewer": { model: "gpt-5.3-codex", effort: "high" } },
      { design: { "counter-reviewer": { model: "gpt-5.4", effort: "xhigh" } } },
    );
    expect(resolveDispatchRoute(value, "design", "counter-reviewer").model).toBe("gpt-5.4");
    expect(resolveDispatchRoute(value, "prd", "counter-reviewer").model).toBe("gpt-5.3-codex");
  });

  it("classifies an absent dispatched role without returning a route", () => {
    expectRoutingError(
      () => resolveDispatchRoute(config({}), "phase-impl", "counter-reviewer"),
      "CONFIG_INVALID",
      { issue_code: "route-missing" },
    );
  });

  it("rejects Claude ultra effort before dispatch", () => {
    expectRoutingError(
      () => resolveDispatchRoute(config({ adjudicator: { model: "claude-opus-4-6", effort: "ultra" } }), "design", "adjudicator"),
      "CONFIG_INVALID",
      { issue_code: "effort-unsupported" },
    );
  });

  it.each(EFFORT_VALUES)("accepts Codex %s effort", (effort) => {
    expect(resolveDispatchRoute(
      config({ adjudicator: { model: "gpt-5.4", effort } }),
      "design",
      "adjudicator",
    ).effort).toBe(effort);
  });

  it("rejects an unsupported Codex effort before dispatch", () => {
    const invalid = config({ adjudicator: { model: "gpt-5.4", effort: "bogus" as never } });
    expectRoutingError(
      () => resolveDispatchRoute(invalid, "design", "adjudicator"),
      "CONFIG_INVALID",
      { issue_code: "effort-unsupported" },
    );
  });

  it("does not conflate routing counter-reviewer with evidence counter-review", () => {
    expectRoutingError(
      () => resolveDispatchRoute(
        config({ "counter-reviewer": { model: "gpt-5.4", effort: "high" } }),
        "design",
        "counter-review" as RoutingRole,
      ),
      "CONFIG_INVALID",
      { issue_code: "route-missing" },
    );
  });

  it("accepts an explicitly configured same-family counter-reviewer", () => {
    expect(resolveDispatchRoute(config({ "counter-reviewer": { model: "claude-opus-4-6", effort: "high" } }), "design", "counter-reviewer"))
      .toEqual({ adapter: "claude-cli", family: "claude", model: "claude-opus-4-6", effort: "high" });
  });

  it("accepts an explicitly configured same-family adjudicator", () => {
    expect(resolveDispatchRoute(config({ adjudicator: { model: "gpt-5.4", effort: "high" } }), "design", "adjudicator"))
      .toEqual({ adapter: "codex-cli", family: "codex", model: "gpt-5.4", effort: "high" });
  });

  it("routes a cc-switch provider through the claude CLI regardless of model name", () => {
    expect(resolveDispatchRoute(config({ "counter-reviewer": { model: "glm-5.3", effort: "high", provider: "zai" } }), "design", "counter-reviewer"))
      .toEqual({ adapter: "claude-cli", family: "claude", model: "glm-5.3", effort: "high", provider: "zai" });
    expect(resolveDispatchRoute(config({ "counter-reviewer": { model: "claude-opus-4-6", effort: "high", provider: "zai" } }), "design", "counter-reviewer"))
      .toEqual({ adapter: "claude-cli", family: "claude", model: "claude-opus-4-6", effort: "high", provider: "zai" });
  });

  it("refuses a cc-switch provider paired with a codex model", () => {
    expectRoutingError(
      () => resolveDispatchRoute(config({ adjudicator: { model: "gpt-5.4", effort: "high", provider: "zai" } }), "design", "adjudicator"),
      "CONFIG_INVALID",
      { issue_code: "provider-unsupported" },
    );
  });

  it("guards error construction for unsafe and unsupported configured models", () => {
    expectRoutingError(
      () => resolveDispatchRoute(config({ adjudicator: { model: "openai/gpt-5", effort: "high" } }), "design", "adjudicator"),
      "CONFIG_INVALID",
      { issue_code: "model-not-safe-id" },
    );
    expectRoutingError(
      () => resolveDispatchRoute(config({ adjudicator: { model: "gemini-3", effort: "high" } }), "design", "adjudicator"),
      "CONFIG_MODEL_UNSUPPORTED",
      { model: "gemini-3" },
    );
  });
});

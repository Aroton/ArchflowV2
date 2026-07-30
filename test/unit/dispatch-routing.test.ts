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
    expect(resolveDispatchRoute(config({ "counter-reviewer": { model: "gpt-5.3-codex", effort: "high" } }), "design", "counter-reviewer", "claude"))
      .toEqual({ adapter: "codex-cli", family: "codex", model: "gpt-5.3-codex", effort: "high" });
    expect(resolveDispatchRoute(config({ adjudicator: { model: "claude-opus-4-6", effort: "max" } }), "prd", "adjudicator", "codex"))
      .toEqual({ adapter: "claude-cli", family: "claude", model: "claude-opus-4-6", effort: "max" });
  });

  it("prefers a phase-kind override and falls back to the base role", () => {
    const value = config(
      { "counter-reviewer": { model: "gpt-5.3-codex", effort: "high" } },
      { design: { "counter-reviewer": { model: "gpt-5.4", effort: "xhigh" } } },
    );
    expect(resolveDispatchRoute(value, "design", "counter-reviewer", "claude").model).toBe("gpt-5.4");
    expect(resolveDispatchRoute(value, "prd", "counter-reviewer", "claude").model).toBe("gpt-5.3-codex");
  });

  it("classifies an absent dispatched role without returning a route", () => {
    expectRoutingError(
      () => resolveDispatchRoute(config({}), "phase-impl", "counter-reviewer", "claude"),
      "CONFIG_INVALID",
      { issue_code: "route-missing" },
    );
  });

  it("rejects Claude ultra effort before dispatch", () => {
    expectRoutingError(
      () => resolveDispatchRoute(config({ adjudicator: { model: "claude-opus-4-6", effort: "ultra" } }), "design", "adjudicator", "codex"),
      "CONFIG_INVALID",
      { issue_code: "effort-unsupported" },
    );
  });

  it.each(EFFORT_VALUES)("accepts Codex %s effort", (effort) => {
    expect(resolveDispatchRoute(
      config({ adjudicator: { model: "gpt-5.4", effort } }),
      "design",
      "adjudicator",
      "claude",
    ).effort).toBe(effort);
  });

  it("rejects an unsupported Codex effort before dispatch", () => {
    const invalid = config({ adjudicator: { model: "gpt-5.4", effort: "bogus" as never } });
    expectRoutingError(
      () => resolveDispatchRoute(invalid, "design", "adjudicator", "claude"),
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
        "claude",
      ),
      "CONFIG_INVALID",
      { issue_code: "route-missing" },
    );
  });

  it("refuses same-family counter-review with the expected opposite family", () => {
    expectRoutingError(
      () => resolveDispatchRoute(config({ "counter-reviewer": { model: "claude-opus-4-6", effort: "high" } }), "design", "counter-reviewer", "claude"),
      "FAMILY_MISMATCH",
      { expected_family: "codex", observed_family: "claude" },
    );
  });

  it("guards error construction for unsafe and unsupported configured models", () => {
    expectRoutingError(
      () => resolveDispatchRoute(config({ adjudicator: { model: "openai/gpt-5", effort: "high" } }), "design", "adjudicator", "claude"),
      "CONFIG_INVALID",
      { issue_code: "model-not-safe-id" },
    );
    expectRoutingError(
      () => resolveDispatchRoute(config({ adjudicator: { model: "gemini-3", effort: "high" } }), "design", "adjudicator", "claude"),
      "CONFIG_MODEL_UNSUPPORTED",
      { model: "gemini-3" },
    );
  });
});

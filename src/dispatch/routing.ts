import type { ConfigV1, ModelRouteV1 } from "../contracts/config.js";
import { ROUTING_ROLES } from "../contracts/config.js";
import { createProjectError, type ProjectError } from "../contracts/errors.js";
import { safeIdV1Schema } from "../contracts/evidence.js";
import type { AdapterId, ModelFamily } from "../contracts/review.js";
import { EFFORT_VALUES } from "../contracts/review.js";
import { assertAdapterFamily } from "../contracts/trust.js";

export type RoutingPhaseKind = keyof NonNullable<ConfigV1["overrides"]>;
export type RoutingRole = (typeof ROUTING_ROLES)[number];

export type DispatchRoute = Readonly<{
  adapter: AdapterId;
  family: ModelFamily;
  model: string;
  effort: (typeof EFFORT_VALUES)[number];
  provider?: string;
}>;

export class DispatchRoutingError extends Error {
  public constructor(public readonly project_error: ProjectError) {
    super(project_error.code);
    this.name = "DispatchRoutingError";
  }
}

const fail = (error: ProjectError): never => {
  throw new DispatchRoutingError(error);
};

function deriveModelFamily(model: string): ModelFamily {
  if (model.startsWith("claude-")) return "claude";
  if (model.startsWith("gpt-")) return "codex";
  return fail(createProjectError("CONFIG_MODEL_UNSUPPORTED", { model }));
}

function adapterForFamily(family: ModelFamily): AdapterId {
  return family === "claude" ? "claude-cli" : "codex-cli";
}

const SUPPORTED_EFFORTS: Readonly<Record<AdapterId, ReadonlySet<string>>> = Object.freeze({
  "claude-cli": new Set(["low", "medium", "high", "xhigh", "max"]),
  // Codex 0.146.0 recognizes every effort in the durable configuration vocabulary.
  "codex-cli": new Set(EFFORT_VALUES),
});

function assertSupportedEffort(adapter: AdapterId, effort: string): void {
  if (!SUPPORTED_EFFORTS[adapter].has(effort)) {
    fail(createProjectError("CONFIG_INVALID", { issue_code: "effort-unsupported" }));
  }
}

/**
 * Validates one configured route into a dispatchable route. Shared by the pinned-config path and
 * the per-dispatch override, so an override is held to exactly the same rules as a pinned route.
 */
export function routeFromConfiguredRoute(configured: ModelRouteV1): DispatchRoute {
  if (!safeIdV1Schema.safeParse(configured.model).success) {
    return fail(createProjectError("CONFIG_INVALID", { issue_code: "model-not-safe-id" }));
  }

  // A cc-switch provider implies the claude CLI regardless of model name, so
  // non-claude-prefixed models (e.g. glm-5.3) can be routed through it — but a
  // codex model paired with one is a misconfiguration, not a silent reroute.
  if (configured.provider !== undefined && configured.model.startsWith("gpt-")) {
    return fail(createProjectError("CONFIG_INVALID", { issue_code: "provider-unsupported" }));
  }
  const family = configured.provider !== undefined ? "claude" : deriveModelFamily(configured.model);
  const adapter = adapterForFamily(family);
  assertAdapterFamily(adapter, family);
  assertSupportedEffort(adapter, configured.effort);

  return Object.freeze({
    adapter,
    family,
    model: configured.model,
    effort: configured.effort,
    ...(configured.provider === undefined ? {} : { provider: configured.provider }),
  });
}

/**
 * The route the config pins for a role, unvalidated. Reading it is not the same as resolving it: a
 * pinned route can be schema-legal but unroutable (an absent role, or an effort its adapter does
 * not support), and reporting what an override displaced must not fail on the very cases the
 * override exists to get past.
 */
export function configuredRoute(
  config: ConfigV1,
  phaseKind: RoutingPhaseKind,
  role: RoutingRole,
): ModelRouteV1 | undefined {
  return config.overrides?.[phaseKind]?.[role] ?? config.roles[role];
}

export function resolveDispatchRoute(
  config: ConfigV1,
  phaseKind: RoutingPhaseKind,
  role: RoutingRole,
): DispatchRoute {
  const configured = configuredRoute(config, phaseKind, role);
  if (configured === undefined) {
    return fail(createProjectError("CONFIG_INVALID", { issue_code: "route-missing" }));
  }
  return routeFromConfiguredRoute(configured);
}

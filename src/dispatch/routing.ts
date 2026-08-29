import type { ConfigV1, ModelRouteV1 } from "../contracts/config.js";
import { ROUTING_ROLES } from "../contracts/config.js";
import { createProjectError, type ProjectError } from "../contracts/errors.js";
import { safeIdV1Schema } from "../contracts/evidence.js";
import type { HostIdentity } from "../contracts/hosts.js";
import type { AdapterId, ModelFamily, RouteSourceRecord } from "../contracts/review.js";
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

export type SelectedDispatchRoute = Readonly<{
  selected: SelectedRouteCandidate;
  route: DispatchRoute;
  source: RouteSourceRecord;
}>;

export type SelectedRouteCandidate = Readonly<{
  raw_route: ModelRouteV1;
  source: RouteSourceRecord;
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
  if (model.startsWith("gemini-")) return "gemini";
  return fail(createProjectError("CONFIG_MODEL_UNSUPPORTED", { model }));
}

function adapterForFamily(family: ModelFamily): AdapterId {
  if (family === "claude") return "claude-cli";
  if (family === "codex") return "codex-cli";
  if (family === "gemini") return "antigravity-cli";
  return fail(createProjectError("CONFIG_FAMILY_UNSUPPORTED", { family }));
}

const SUPPORTED_EFFORTS: Readonly<Record<AdapterId, ReadonlySet<string>>> = Object.freeze({
  "claude-cli": new Set(["low", "medium", "high", "xhigh", "max"]),
  // Codex 0.146.0 recognizes every effort in the durable configuration vocabulary.
  "codex-cli": new Set(EFFORT_VALUES),
  "antigravity-cli": new Set(["low", "medium", "high"]),
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
  if (configured.provider !== undefined && (configured.model.startsWith("gpt-") || configured.model.startsWith("gemini-"))) {
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

function normalizeRawRoutes(value: ModelRouteV1 | readonly ModelRouteV1[] | undefined): readonly ModelRouteV1[] {
  if (value === undefined) return [];
  if (Array.isArray(value)) return value;
  return [value as ModelRouteV1];
}

/**
 * Resolves the raw configured routes for a role, taking into account producer client specialization
 * (e.g., config.producers.antigravity), phase-kind overrides, and base roles.
 */
export function configuredRoutes(
  config: ConfigV1,
  phaseKind: RoutingPhaseKind,
  role: RoutingRole,
  host?: HostIdentity,
): readonly ModelRouteV1[] {
  if (host !== undefined && host !== "unknown" && config.producers?.[host] !== undefined) {
    const producerRoles = config.producers[host];
    if (role === "counter-reviewer") {
      const candidates = normalizeRawRoutes(producerRoles?.["counter-reviewers"] ?? producerRoles?.["counter-reviewer"]);
      if (candidates.length > 0) return candidates;
    } else if (producerRoles?.adjudicator !== undefined) {
      return [producerRoles.adjudicator];
    }
  }

  const phaseOverrides = config.overrides?.[phaseKind];
  if (phaseOverrides !== undefined) {
    if (role === "counter-reviewer") {
      const candidates = normalizeRawRoutes(phaseOverrides["counter-reviewers"] ?? phaseOverrides["counter-reviewer"]);
      if (candidates.length > 0) return candidates;
    } else if (phaseOverrides.adjudicator !== undefined) {
      return [phaseOverrides.adjudicator];
    }
  }

  const baseRoles = config.roles;
  if (role === "counter-reviewer") {
    const candidates = normalizeRawRoutes(baseRoles["counter-reviewers"] ?? baseRoles["counter-reviewer"]);
    if (candidates.length > 0) return candidates;
  } else if (baseRoles.adjudicator !== undefined) {
    return [baseRoles.adjudicator];
  }

  return [];
}

/**
 * The primary route the config pins for a role, unvalidated.
 */
export function configuredRoute(
  config: ConfigV1,
  phaseKind: RoutingPhaseKind,
  role: RoutingRole,
  host?: HostIdentity,
): ModelRouteV1 | undefined {
  return configuredRoutes(config, phaseKind, role, host)[0];
}

const displacedRoute = (
  source: "configured" | "invocation-declared",
  route: ModelRouteV1,
): NonNullable<RouteSourceRecord["displaced"]> => Object.freeze({
  source,
  model: route.model,
  effort: route.effort,
  ...(route.provider === undefined ? {} : { provider: route.provider }),
});

/**
 * Selects candidates for one role by trust precedence. Supports multiple candidates for parallel reviewers.
 */
export function selectDispatchRouteCandidates(
  config: ConfigV1,
  phaseKind: RoutingPhaseKind,
  role: RoutingRole,
  invocationRoute?: ModelRouteV1,
  humanOverride?: ModelRouteV1,
  host?: HostIdentity,
): readonly SelectedRouteCandidate[] {
  const configured = configuredRoutes(config, phaseKind, role, host);
  const primaryConfigured = configured[0];
  const normallySelected = invocationRoute ?? primaryConfigured;

  if (humanOverride !== undefined) {
    return Object.freeze([{
      raw_route: humanOverride,
      source: Object.freeze({
        provenance: "route-override" as const,
        ...(normallySelected === undefined
          ? {}
          : { displaced: displacedRoute(invocationRoute === undefined ? "configured" : "invocation-declared", normallySelected) }),
      }),
    }]);
  }

  if (invocationRoute !== undefined) {
    return Object.freeze([{
      raw_route: invocationRoute,
      source: Object.freeze({
        provenance: "invocation-declared" as const,
        ...(primaryConfigured === undefined ? {} : { displaced: displacedRoute("configured", primaryConfigured) }),
      }),
    }]);
  }

  if (configured.length === 0) {
    return fail(createProjectError("CONFIG_INVALID", { issue_code: "route-missing" }));
  }

  return Object.freeze(configured.map((raw_route) => Object.freeze({
    raw_route,
    source: Object.freeze({ provenance: "configured" as const }),
  })));
}

/**
 * Selects one role's primary route candidate by trust precedence.
 */
export function selectDispatchRouteCandidate(
  config: ConfigV1,
  phaseKind: RoutingPhaseKind,
  role: RoutingRole,
  invocationRoute?: ModelRouteV1,
  humanOverride?: ModelRouteV1,
  host?: HostIdentity,
): SelectedRouteCandidate {
  const candidates = selectDispatchRouteCandidates(config, phaseKind, role, invocationRoute, humanOverride, host);
  return candidates[0]!;
}

export function validateSelectedDispatchRoute(selected: SelectedRouteCandidate): SelectedDispatchRoute {
  return Object.freeze({
    selected,
    route: routeFromConfiguredRoute(selected.raw_route),
    source: selected.source,
  });
}

export function selectDispatchRoute(
  config: ConfigV1,
  phaseKind: RoutingPhaseKind,
  role: RoutingRole,
  invocationRoute?: ModelRouteV1,
  humanOverride?: ModelRouteV1,
  host?: HostIdentity,
): SelectedDispatchRoute {
  return validateSelectedDispatchRoute(selectDispatchRouteCandidate(
    config,
    phaseKind,
    role,
    invocationRoute,
    humanOverride,
    host,
  ));
}

export function selectDispatchRoutes(
  config: ConfigV1,
  phaseKind: RoutingPhaseKind,
  role: RoutingRole,
  invocationRoute?: ModelRouteV1,
  humanOverride?: ModelRouteV1,
  host?: HostIdentity,
): readonly SelectedDispatchRoute[] {
  const candidates = selectDispatchRouteCandidates(config, phaseKind, role, invocationRoute, humanOverride, host);
  return Object.freeze(candidates.map(validateSelectedDispatchRoute));
}

export function resolveDispatchRoute(
  config: ConfigV1,
  phaseKind: RoutingPhaseKind,
  role: RoutingRole,
  host?: HostIdentity,
): DispatchRoute {
  return selectDispatchRoute(config, phaseKind, role, undefined, undefined, host).route;
}

export function resolveDispatchRoutes(
  config: ConfigV1,
  phaseKind: RoutingPhaseKind,
  role: RoutingRole,
  host?: HostIdentity,
): readonly DispatchRoute[] {
  return selectDispatchRoutes(config, phaseKind, role, undefined, undefined, host).map((s) => s.route);
}


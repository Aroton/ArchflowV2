import type { ConfigV1, ModelRouteV1 } from "../../src/contracts/config.js";
import type { HostIdentity } from "../../src/contracts/hosts.js";
import {
  selectDispatchRouteCandidates,
  validateSelectedDispatchRoute,
  type DispatchRoute,
  type RoutingPhaseKind,
  type RoutingRole,
} from "../../src/dispatch/routing.js";

/** Selects and validates every route for one role, composed exactly as the standalone review does. */
export function selectedRoutes(
  config: ConfigV1,
  phaseKind: RoutingPhaseKind,
  role: RoutingRole,
  invocationRoute?: ModelRouteV1,
  host?: HostIdentity,
): ReturnType<typeof validateSelectedDispatchRoute>[] {
  return selectDispatchRouteCandidates(config, phaseKind, role, invocationRoute, host).map(validateSelectedDispatchRoute);
}

/** The dispatchable routes configured for one role. */
export function configuredRoutes(
  config: ConfigV1,
  phaseKind: RoutingPhaseKind,
  role: RoutingRole,
  host?: HostIdentity,
): DispatchRoute[] {
  return selectedRoutes(config, phaseKind, role, undefined, host).map((selected) => selected.route);
}

/** The first dispatchable route configured for one role (the one a single-reviewer role uses). */
export function configuredRoute(
  config: ConfigV1,
  phaseKind: RoutingPhaseKind,
  role: RoutingRole,
  host?: HostIdentity,
): DispatchRoute {
  return configuredRoutes(config, phaseKind, role, host)[0]!;
}

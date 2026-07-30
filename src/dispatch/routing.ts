import type { ConfigV1 } from "../contracts/config.js";
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

export function resolveDispatchRoute(
  config: ConfigV1,
  phaseKind: RoutingPhaseKind,
  role: RoutingRole,
  producer_family: ModelFamily,
): DispatchRoute {
  const configured = config.overrides?.[phaseKind]?.[role] ?? config.roles[role];
  if (configured === undefined) {
    return fail(createProjectError("CONFIG_INVALID", { issue_code: "route-missing" }));
  }

  if (!safeIdV1Schema.safeParse(configured.model).success) {
    return fail(createProjectError("CONFIG_INVALID", { issue_code: "model-not-safe-id" }));
  }

  const family = deriveModelFamily(configured.model);
  const adapter = adapterForFamily(family);
  assertAdapterFamily(adapter, family);
  assertSupportedEffort(adapter, configured.effort);

  if (role === "counter-reviewer" && family === producer_family) {
    const expected_family: ModelFamily = producer_family === "claude" ? "codex" : "claude";
    return fail(createProjectError("FAMILY_MISMATCH", { expected_family, observed_family: family }));
  }

  return Object.freeze({ adapter, family, model: configured.model, effort: configured.effort });
}

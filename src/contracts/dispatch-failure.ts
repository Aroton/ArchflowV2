import { z } from "zod";

import { REASONING_EFFORTS, REPOSITORY_NAME_PATTERN, type ModelRouteV1 } from "./config.js";
import {
  safeIntegerV1Schema,
  taskSlugV1Schema,
  type SafeInteger,
  type TaskSlug,
} from "./evidence.js";
import {
  phaseInstanceIdV1Schema,
  type PhaseInstanceId,
} from "./phase-instance.js";

export const DISPATCH_FAILURE_CODES = [
  "CONFIG_INVALID",
  "CONFIG_MODEL_UNSUPPORTED",
  "CLI_MISSING",
  "AUTH_UNAVAILABLE",
  "RATE_LIMITED",
  "UNSUPPORTED_MODEL",
  "CLI_VERSION_UNSUPPORTED",
  "PROCESS_FAILED",
  "REPOSITORY_VIEW_UNAVAILABLE",
] as const;

export type DispatchFailureCodeV1 = (typeof DISPATCH_FAILURE_CODES)[number];
export type DispatchFailureRoleV1 = "counter-reviewer" | "test-reviewer" | "adjudicator";
export type DispatchRouteSourceV1 = "configured" | "invocation-declared" | "route-override";

export type DispatchFailureRouteV1 = Readonly<{
  model: ModelRouteV1["model"];
  effort: ModelRouteV1["effort"];
  provider?: Exclude<ModelRouteV1["provider"], undefined>;
  source: DispatchRouteSourceV1;
}>;

/**
 * Compact ignored runtime observation. It is authenticated for status only by an exact join to
 * canonical state; the file is neither durable evidence nor workflow authority.
 */
export type DispatchFailureObservationV1 = Readonly<{
  schema_version: "1";
  task_id: TaskSlug;
  phase_instance: PhaseInstanceId;
  step: "counter_review";
  attempt: SafeInteger;
  role: DispatchFailureRoleV1;
  code: DispatchFailureCodeV1;
  message: string;
  repository_name?: string;
  route?: DispatchFailureRouteV1;
  observed_at_revision: SafeInteger;
}>;

/** Public semantic projection: no runtime path or canonical-state join identifiers. */
export type PublicDispatchFailureV1 = Readonly<{
  role: DispatchFailureRoleV1;
  code: DispatchFailureCodeV1;
  message: string;
  repository_name?: string;
  route?: DispatchFailureRouteV1;
}>;

const boundedMessage = z.string().min(1).max(256);

/**
 * The published JSON form of the `repository_name`-iff-`REPOSITORY_VIEW_UNAVAILABLE` invariant
 * the `superRefine` below enforces at runtime. It sits under `allOf` so both documents keep a
 * plain object root; Zod remains the authority and this only lets a schema reader see the rule.
 */
export const REPOSITORY_NAME_PRESENCE_RULE = Object.freeze({
  allOf: [{
    if: { properties: { code: { const: "REPOSITORY_VIEW_UNAVAILABLE" } }, required: ["code"] },
    then: { properties: { repository_name: {} }, required: ["repository_name"] },
    else: { not: { properties: { repository_name: {} }, required: ["repository_name"] } },
  }],
} as const);
function requireRepositoryNameOnlyForViewFailures(
  failure: Readonly<{ code: DispatchFailureCodeV1; repository_name?: string | undefined }>,
  context: z.RefinementCtx,
): void {
  if ((failure.code === "REPOSITORY_VIEW_UNAVAILABLE") !== (failure.repository_name !== undefined)) {
    context.addIssue({ code: "custom", path: ["repository_name"], message: "repository_name is required only for repository view failures" });
  }
}
// A fresh instance per document: the observation and public projection live in different schema
// documents, and the generator keys `$ref` emission on object identity.
const repositoryName = () => z.union([z.literal("primary"), z.string().regex(REPOSITORY_NAME_PATTERN)]);
const route = z.object({
  model: z.string().min(1).regex(/\S/u),
  effort: z.enum(REASONING_EFFORTS),
  provider: z.string().trim().min(1).regex(/\S/u).optional(),
  source: z.enum(["configured", "invocation-declared", "route-override"]),
}).strict() as unknown as z.ZodType<DispatchFailureRouteV1>;

export const dispatchFailureObservationV1Schema = z.object({
  schema_version: z.literal("1"),
  task_id: taskSlugV1Schema,
  phase_instance: phaseInstanceIdV1Schema,
  step: z.literal("counter_review"),
  attempt: safeIntegerV1Schema,
  role: z.enum(["counter-reviewer", "test-reviewer", "adjudicator"]),
  code: z.enum(DISPATCH_FAILURE_CODES),
  message: boundedMessage,
  repository_name: repositoryName().optional(),
  route: route.optional(),
  observed_at_revision: safeIntegerV1Schema,
}).strict().superRefine(requireRepositoryNameOnlyForViewFailures).meta({ ...REPOSITORY_NAME_PRESENCE_RULE }) as unknown as z.ZodType<DispatchFailureObservationV1>;

export const publicDispatchFailureV1Schema = z.object({
  role: z.enum(["counter-reviewer", "test-reviewer", "adjudicator"]),
  code: z.enum(DISPATCH_FAILURE_CODES),
  message: boundedMessage,
  repository_name: repositoryName().optional(),
  route: route.optional(),
}).strict().superRefine(requireRepositoryNameOnlyForViewFailures).meta({ ...REPOSITORY_NAME_PRESENCE_RULE }) as unknown as z.ZodType<PublicDispatchFailureV1>;

export function parseDispatchFailureObservationV1(value: unknown): DispatchFailureObservationV1 {
  return dispatchFailureObservationV1Schema.parse(value);
}

export function projectDispatchFailureObservation(
  observation: DispatchFailureObservationV1,
): PublicDispatchFailureV1 {
  return Object.freeze({
    role: observation.role,
    code: observation.code,
    message: observation.message,
    ...(observation.repository_name === undefined ? {} : { repository_name: observation.repository_name }),
    ...(observation.route === undefined ? {} : { route: Object.freeze({ ...observation.route }) }),
  });
}

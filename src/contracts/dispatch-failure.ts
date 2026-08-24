import { z } from "zod";

import { REASONING_EFFORTS, type ModelRouteV1 } from "./config.js";
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
] as const;

export type DispatchFailureCodeV1 = (typeof DISPATCH_FAILURE_CODES)[number];
export type DispatchFailureRoleV1 = "counter-reviewer" | "adjudicator";
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
  route?: DispatchFailureRouteV1;
  observed_at_revision: SafeInteger;
}>;

/** Public semantic projection: no runtime path or canonical-state join identifiers. */
export type PublicDispatchFailureV1 = Readonly<{
  role: DispatchFailureRoleV1;
  code: DispatchFailureCodeV1;
  message: string;
  route?: DispatchFailureRouteV1;
}>;

const boundedMessage = z.string().min(1).max(256);
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
  role: z.enum(["counter-reviewer", "adjudicator"]),
  code: z.enum(DISPATCH_FAILURE_CODES),
  message: boundedMessage,
  route: route.optional(),
  observed_at_revision: safeIntegerV1Schema,
}).strict() as unknown as z.ZodType<DispatchFailureObservationV1>;

export const publicDispatchFailureV1Schema = z.object({
  role: z.enum(["counter-reviewer", "adjudicator"]),
  code: z.enum(DISPATCH_FAILURE_CODES),
  message: boundedMessage,
  route: route.optional(),
}).strict() as unknown as z.ZodType<PublicDispatchFailureV1>;

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
    ...(observation.route === undefined ? {} : { route: Object.freeze({ ...observation.route }) }),
  });
}

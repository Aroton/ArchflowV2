import { z } from "zod";

import { assertPlainJson } from "./plain-json.js";
import { parseSingleYamlDocument } from "./yaml.js";

export const ROUTING_ROLES = ["producer", "counter-reviewer", "adjudicator"] as const;
export const REASONING_EFFORTS = ["low", "medium", "high", "xhigh", "max", "ultra"] as const;
export const DEFAULT_MAX_ATTEMPTS = 3;

const routeSchema = z.object({
  model: z.string().min(1).refine((value) => value.trim().length > 0, "model must contain a non-whitespace character"),
  effort: z.enum(REASONING_EFFORTS),
}).strict();

const rolesSchema = z.object({
  producer: routeSchema.optional(),
  "counter-reviewer": routeSchema.optional(),
  adjudicator: routeSchema.optional(),
}).strict();

const overridesSchema = z.object({
  explore: rolesSchema.optional(),
  prd: rolesSchema.optional(),
  design: rolesSchema.optional(),
  "phase-design": rolesSchema.optional(),
  "phase-impl": rolesSchema.optional(),
}).strict();

export const configV1Schema = z.object({
  schema_version: z.literal("1"),
  roles: rolesSchema,
  overrides: overridesSchema.optional(),
  max_attempts: z.number().int().positive().safe().optional(),
}).strict();

export type ModelRouteV1 = z.infer<typeof routeSchema>;
export type ConfigV1 = z.infer<typeof configV1Schema>;

export function parseConfigV1(value: unknown): ConfigV1 {
  assertPlainJson(value, "config");
  return configV1Schema.parse(value);
}

export function parseConfigYaml(source: string, label = "config.yaml"): ConfigV1 {
  return parseConfigV1(parseSingleYamlDocument(source, label));
}

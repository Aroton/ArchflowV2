import { z } from "zod";

import { assertPlainJson } from "./plain-json.js";
import { parseSingleYamlDocument } from "./yaml.js";

// The producer is the connected MCP host, never a config role; routing config
// describes only the roles the server dispatches.
export const ROUTING_ROLES = ["counter-reviewer", "adjudicator"] as const;
export const REASONING_EFFORTS = ["low", "medium", "high", "xhigh", "max", "ultra"] as const;

export const configRouteSchema = z.object({
  model: z.string().min(1).regex(/\S/, "model must contain a non-whitespace character"),
  effort: z.enum(REASONING_EFFORTS),
  // Optional cc-switch provider id; claude routes only. Unset means a direct
  // CLI launch with no wrapper.
  provider: z.string().trim().min(1).regex(/\S/, "provider must contain a non-whitespace character").optional(),
}).strict();

export const configRolesSchema = z.object({
  // Retired; accepted on read only so configs pinned before the producer role was removed
  // round-trip unchanged. The producer is the connected host; nothing consumes this.
  producer: configRouteSchema.optional(),
  "counter-reviewer": configRouteSchema.optional(),
  adjudicator: configRouteSchema.optional(),
}).strict();

export const configOverridesSchema = z.object({
  explore: configRolesSchema.optional(),
  prd: configRolesSchema.optional(),
  design: configRolesSchema.optional(),
  "phase-design": configRolesSchema.optional(),
  "phase-impl": configRolesSchema.optional(),
}).strict();

export const configV1Schema = z.object({
  schema_version: z.literal("1"),
  roles: configRolesSchema,
  overrides: configOverridesSchema.optional(),
  max_attempts: z.number().int().positive().safe().optional(),
}).strict();

export type ModelRouteV1 = z.infer<typeof configRouteSchema>;
export type ConfigV1 = z.infer<typeof configV1Schema>;

export function parseConfigV1(value: unknown): ConfigV1 {
  assertPlainJson(value, "config");
  return configV1Schema.parse(value);
}

export function parseConfigYaml(source: string, label = "config.yaml"): ConfigV1 {
  return parseConfigV1(parseSingleYamlDocument(source, label));
}

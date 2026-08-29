import { z } from "zod";

import { assertPlainJson } from "./plain-json.js";
import { parseSingleYamlDocument } from "./yaml.js";

// The producer is the connected MCP host, never a config role; routing config
// describes only the roles the server dispatches.
export const ROUTING_ROLES = ["counter-reviewer", "test-reviewer", "adjudicator"] as const;
export const REASONING_EFFORTS = ["low", "medium", "high", "xhigh", "max", "ultra"] as const;
export const WORKFLOW_SUBJECTS = ["prd", "design", "phase-design", "phase-impl"] as const;
export type WorkflowSubject = (typeof WORKFLOW_SUBJECTS)[number];

export const workflowSubjectV1Schema = z.enum(WORKFLOW_SUBJECTS);

export const configRouteSchema = z.object({
  model: z.string().min(1).regex(/\S/, "model must contain a non-whitespace character"),
  effort: z.enum(REASONING_EFFORTS),
  // Optional cc-switch provider id; claude routes only. Unset means a direct
  // CLI launch with no wrapper.
  provider: z.string().trim().min(1).regex(/\S/, "provider must contain a non-whitespace character").optional(),
}).strict();

export const singleOrArrayRoutesSchema = z.union([
  configRouteSchema,
  z.array(configRouteSchema).min(1),
]);

export const configRolesSchema = z.object({
  // Retired; accepted on read only so configs pinned before the producer role was removed
  // round-trip unchanged. The producer is the connected host; nothing consumes this.
  producer: configRouteSchema.optional(),
  "counter-reviewer": singleOrArrayRoutesSchema.optional(),
  "counter-reviewers": z.array(configRouteSchema).min(1).optional(),
  "test-reviewer": configRouteSchema.optional(),
  adjudicator: configRouteSchema.optional(),
}).strict();

export const producersSchema = z.object({
  claude: configRolesSchema.optional(),
  codex: configRolesSchema.optional(),
  antigravity: configRolesSchema.optional(),
}).strict();

export const configOverridesSchema = z.object({
  explore: configRolesSchema.optional(),
  prd: configRolesSchema.optional(),
  design: configRolesSchema.optional(),
  "phase-design": configRolesSchema.optional(),
  "phase-impl": configRolesSchema.optional(),
}).strict();

/**
 * Declarative approval triggers: `subjects` gates a workflow subject's steps wholesale; `content`
 * gates a step on the repository paths its result changed — every path an implementation touched,
 * or the governing task documents (`.archflow/tasks/<task>/design.md`, `prd.md`) a later phase
 * rewrote. Evaluation lives in `src/state/approval-rules.ts`. Both lists are human-authored
 * config, so their order is free; `subjects` rejects repeats, and nothing here demands a sorted hand.
 */
export const approvalRulesSchema = z.object({
  subjects: z.array(workflowSubjectV1Schema)
    .refine((subjects) => new Set(subjects).size === subjects.length, "approval rule subjects must not repeat"),
  content: z.array(z.object({
    paths: z.array(z.string().min(1).regex(/\S/u, "path pattern must contain a non-whitespace character")),
  }).strict()),
}).strict();

export const REPOSITORY_MODES = ["context-only", "writable"] as const;
export const repositoryModeV1Schema = z.enum(REPOSITORY_MODES);
/**
 * The task-slug lexical vocabulary with `primary` additionally reserved for the implicit member.
 * This is the single source for every repository-name check: each contract document builds its
 * own schema instance from this pattern (so no document emits cross-document refs), and runtime
 * segment checks test it directly. Never restate the regex elsewhere.
 */
export const REPOSITORY_NAME_PATTERN = /^(?!primary$)(?!(?:[Cc][Oo][Nn]|[Pp][Rr][Nn]|[Aa][Uu][Xx]|[Nn][Uu][Ll]|[Cc][Oo][Mm][1-9]|[Ll][Pp][Tt][1-9])(?:\.[^/]*)?$)(?!.*[. ]$)[a-z0-9][a-z0-9._-]{0,63}$/u;
export const REPOSITORY_NAME_MESSAGE = "must use the task-slug vocabulary and must not be the reserved name primary";
export const repositoryNameV1Schema = z.string().regex(REPOSITORY_NAME_PATTERN, REPOSITORY_NAME_MESSAGE);
export const repositoryDeclarationV1Schema = z.object({
  path: z.string().min(1).regex(/\S/u, "path must contain a non-whitespace character"),
  mode: repositoryModeV1Schema.optional(),
}).strict();
export const repositoriesV1Schema = z.record(repositoryNameV1Schema, repositoryDeclarationV1Schema);

export const configV1Schema = z.object({
  schema_version: z.literal("1"),
  roles: configRolesSchema,
  producers: producersSchema.optional(),
  overrides: configOverridesSchema.optional(),
  max_attempts: z.number().int().positive().safe().optional(),
  approval_rules: approvalRulesSchema.optional(),
  repositories: repositoriesV1Schema.optional(),
}).strict();

export type ModelRouteV1 = z.infer<typeof configRouteSchema>;
export type RepositoryModeV1 = z.infer<typeof repositoryModeV1Schema>;
export type RepositoryName = z.infer<typeof repositoryNameV1Schema>;
export type RepositoryDeclarationV1 = z.infer<typeof repositoryDeclarationV1Schema>;
export type ConfigV1 = z.infer<typeof configV1Schema>;

/**
 * Strips the `| undefined` zod's `.optional()` infers from every optional field, recursively:
 * under `exactOptionalPropertyTypes` that explicit `undefined` would break the `PlainJsonValue`
 * constraint every persisted-reachable shape must satisfy — an absent field is simply absent,
 * never `undefined`. The mapping is homomorphic, so optionality and `readonly` survive.
 */
type AbsentIsAbsence<T> = T extends readonly (infer Item)[] ? readonly AbsentIsAbsence<Item>[]
  : T extends object ? { [Key in keyof T]: AbsentIsAbsence<Exclude<T[Key], undefined>> }
  : T;

/**
 * The parsed config value as durably recorded (`TaskStateV1.last_seen_config`) and diffed by the
 * status change notice: `ConfigV1` with zod's inferred `undefined`s stripped, so the shape is a
 * plain-JSON value. Defined from the one `z.infer` of `configV1Schema`, beside it, so the
 * persisted snapshot type cannot drift from the parser's own output type.
 */
export type TaskConfigSnapshot = AbsentIsAbsence<ConfigV1>;

export function parseConfigV1(value: unknown): ConfigV1 {
  assertPlainJson(value, "config");
  return configV1Schema.parse(value);
}

export function parseConfigYaml(source: string, label = "config.yaml"): ConfigV1 {
  return parseConfigV1(parseSingleYamlDocument(source, label));
}

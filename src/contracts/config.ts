import { z } from "zod";

import { assertPlainJson } from "./plain-json.js";
import { parseSingleYamlDocument } from "./yaml.js";

/**
 * Config is read tolerantly and written minimally. Repositories initialized by older templates
 * carry keys the standalone review never reads; they parse and are ignored, so those configs keep
 * reviewing unchanged (the parsed value passes through, so their config digest does not move).
 * The shipped template no longer writes them. The legacy allowance:
 * - top level: `implementation`, `repositories`, `max_attempts` accept any value;
 * - roles: the retired `producer` and `effort-reviewer` routes keep their route shape;
 * - overrides: `explore`, `prd`, `design` keep the roles shape (review routes only
 *   `phase-design` and `phase-impl`);
 * - `approval_rules.subjects`: `prd` and `design` are accepted and never match, because a plan
 *   review is evaluated as `phase-design` and an implementation review as `phase-impl`.
 */

// The producer is the connected host, never a config role; routing config describes only the
// roles review dispatches.
export const ROUTING_ROLES = ["counter-reviewer", "test-reviewer", "adjudicator"] as const;
const REASONING_EFFORTS = ["low", "medium", "high", "xhigh", "max", "ultra"] as const;
export const WORKFLOW_SUBJECTS = ["prd", "design", "phase-design", "phase-impl"] as const;
export type WorkflowSubject = (typeof WORKFLOW_SUBJECTS)[number];

export const configRouteSchema = z.object({
  model: z.string().min(1).regex(/\S/, "model must contain a non-whitespace character"),
  effort: z.enum(REASONING_EFFORTS),
  // Optional cc-switch provider id; claude routes only. Unset means a direct
  // CLI launch with no wrapper.
  provider: z.string().trim().min(1).regex(/\S/, "provider must contain a non-whitespace character").optional(),
}).strict();

const singleOrArrayRoutesSchema = z.union([
  configRouteSchema,
  z.array(configRouteSchema).min(1),
]);

export const configRolesSchema = z.object({
  // Legacy, accepted and ignored (see above).
  producer: configRouteSchema.optional(),
  "counter-reviewer": singleOrArrayRoutesSchema.optional(),
  "counter-reviewers": z.array(configRouteSchema).min(1).optional(),
  "test-reviewer": configRouteSchema.optional(),
  // Legacy, accepted and ignored (see above).
  "effort-reviewer": configRouteSchema.optional(),
  adjudicator: configRouteSchema.optional(),
}).strict();

const producersSchema = z.object({
  claude: configRolesSchema.optional(),
  codex: configRolesSchema.optional(),
  antigravity: configRolesSchema.optional(),
}).strict();

export const configOverridesSchema = z.object({
  // Legacy, accepted and ignored (see above).
  explore: configRolesSchema.optional(),
  prd: configRolesSchema.optional(),
  design: configRolesSchema.optional(),
  "phase-design": configRolesSchema.optional(),
  "phase-impl": configRolesSchema.optional(),
}).strict();

/**
 * Declarative approval triggers: `subjects` names review subjects that always need a human
 * (`phase-design` for a plan review, `phase-impl` for an implementation review); `content` names
 * path globs whose change needs one. Evaluation lives in `src/review/approval-rules.ts`. Both
 * lists are human-authored config, so their order is free; `subjects` rejects repeats, and
 * nothing here demands a sorted hand.
 */
const approvalRulesSchema = z.object({
  subjects: z.array(z.enum(WORKFLOW_SUBJECTS))
    .refine((subjects) => new Set(subjects).size === subjects.length, "approval rule subjects must not repeat"),
  content: z.array(z.object({
    paths: z.array(z.string().min(1).regex(/\S/u, "path pattern must contain a non-whitespace character")),
  }).strict()),
}).strict();

/**
 * The name vocabulary for repository views (a lowercase slug, safe as one filesystem segment),
 * with `primary` reserved for the primary view. This is the single source for every
 * repository-name check: schemas build their own instance from this pattern, and runtime segment
 * checks test it directly. Never restate the regex elsewhere.
 */
export const REPOSITORY_NAME_PATTERN = /^(?!primary$)(?!(?:[Cc][Oo][Nn]|[Pp][Rr][Nn]|[Aa][Uu][Xx]|[Nn][Uu][Ll]|[Cc][Oo][Mm][1-9]|[Ll][Pp][Tt][1-9])(?:\.[^/]*)?$)(?!.*[. ]$)[a-z0-9][a-z0-9._-]{0,63}$/u;
export const REPOSITORY_NAME_MESSAGE = "must use the task-slug vocabulary and must not be the reserved name primary";
export const repositoryNameV1Schema = z.string().regex(REPOSITORY_NAME_PATTERN, REPOSITORY_NAME_MESSAGE);

export const configV1Schema = z.object({
  schema_version: z.literal("1"),
  roles: configRolesSchema,
  producers: producersSchema.optional(),
  overrides: configOverridesSchema.optional(),
  approval_rules: approvalRulesSchema.optional(),
  // Legacy, accepted with any value and ignored (see above).
  max_attempts: z.unknown().optional(),
  repositories: z.unknown().optional(),
  implementation: z.unknown().optional(),
}).strict();

export type ModelRouteV1 = z.infer<typeof configRouteSchema>;
export type RepositoryName = z.infer<typeof repositoryNameV1Schema>;
export type ConfigV1 = z.infer<typeof configV1Schema>;

export function parseConfigV1(value: unknown): ConfigV1 {
  assertPlainJson(value, "config");
  return configV1Schema.parse(value);
}

export function parseConfigYaml(source: string, label = "config.yaml"): ConfigV1 {
  return parseConfigV1(parseSingleYamlDocument(source, label));
}

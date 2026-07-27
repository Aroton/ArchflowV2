import { z } from "zod";

import { assertPlainJson } from "./plain-json.js";
import { parseSingleYamlDocument } from "./yaml.js";

export interface ConstitutionRuleV1 {
  readonly id: string;
  readonly version: number;
  readonly status: "active" | "deprecated";
  readonly text: string;
  readonly review_trigger?: string;
  readonly enforced_by?: readonly string[];
}

export type ConstitutionRegistry = ReadonlyMap<string, ConstitutionRuleV1>;

const frontmatterSchema = z.object({
  id: z.string().regex(/^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/),
  version: z.number().int().positive().safe(),
  status: z.enum(["active", "deprecated"]),
  review_trigger: z.string().min(1).refine((value) => value.trim().length > 0, "review_trigger must contain a non-whitespace character").optional(),
  enforced_by: z.array(z.string().min(1).refine((value) => value.trim().length > 0, "enforced_by entries must contain a non-whitespace character")).min(1).optional(),
}).strict();

export const constitutionRuleV1Schema = frontmatterSchema.extend({ text: z.string().min(1).refine((value) => value.trim().length > 0, "text must contain a non-whitespace character") }).strict();

export function parseConstitutionRuleV1(value: unknown): ConstitutionRuleV1 {
  assertPlainJson(value, "constitution rule");
  const parsed = constitutionRuleV1Schema.parse(value);
  return {
    id: parsed.id,
    version: parsed.version,
    status: parsed.status,
    text: parsed.text,
    ...(parsed.review_trigger === undefined ? {} : { review_trigger: parsed.review_trigger }),
    ...(parsed.enforced_by === undefined ? {} : { enforced_by: parsed.enforced_by }),
  };
}

export function parseConstitutionRuleMarkdown(source: string, label: string): ConstitutionRuleV1 {
  const normalized = source.replaceAll("\r\n", "\n");
  if (!normalized.startsWith("---\n")) throw new Error(`${label}: expected opening YAML frontmatter delimiter`);
  const close = normalized.indexOf("\n---\n", 4);
  if (close < 0) throw new Error(`${label}: expected closing YAML frontmatter delimiter`);
  const frontmatter = parseSingleYamlDocument(normalized.slice(4, close), `${label} frontmatter`);
  const text = normalized.slice(close + 5).trim();
  return parseConstitutionRuleV1({ ...frontmatter as object, text });
}

function registryFromRules(rules: readonly ConstitutionRuleV1[]): Map<string, ConstitutionRuleV1> {
  const registry = new Map<string, ConstitutionRuleV1>();
  for (const candidate of rules) {
    const rule = parseConstitutionRuleV1(candidate);
    if (registry.has(rule.id)) throw new Error(`Duplicate constitution rule id: ${rule.id}`);
    registry.set(rule.id, Object.freeze(rule));
  }
  return registry;
}

export function parseConstitutionRuleFiles(files: Readonly<Record<string, string>>): ConstitutionRegistry {
  return registryFromRules(Object.keys(files).sort().map((path) => parseConstitutionRuleMarkdown(files[path]!, path)));
}

export function validateConstitutionEvolution(previous: ConstitutionRegistry, candidate: readonly ConstitutionRuleV1[]): ConstitutionRegistry {
  const next = registryFromRules(candidate);
  for (const [id, prior] of previous) {
    const current = next.get(id);
    if (!current) throw new Error(`Constitution rule ${id} cannot be deleted or reused`);
    if (prior.status === "deprecated" && current.status === "active") throw new Error(`Deprecated constitution rule ${id} cannot be reactivated`);
    const contentChanged = prior.status !== current.status || prior.text !== current.text || prior.review_trigger !== current.review_trigger || JSON.stringify(prior.enforced_by) !== JSON.stringify(current.enforced_by);
    if (contentChanged && current.version <= prior.version) throw new Error(`Changed constitution rule ${id} must increment its version`);
    if (!contentChanged && current.version !== prior.version) throw new Error(`Unchanged constitution rule ${id} must retain its version`);
  }
  return next;
}

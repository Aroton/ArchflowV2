import { z } from "zod";

import { assertPlainJson } from "./plain-json.js";

export interface RubricCriterionV1 {
  readonly id: string;
  readonly text: string;
  readonly blocking: boolean;
}

export interface RubricV1 {
  readonly schema_version: "1";
  readonly kind: "artifact" | "implementation";
  readonly mode: "self_review" | "adversarial";
  readonly criteria: readonly RubricCriterionV1[];
}

export const rubricV1Schema = z.object({
  schema_version: z.literal("1"),
  kind: z.enum(["artifact", "implementation"]),
  mode: z.enum(["self_review", "adversarial"]),
  criteria: z.array(z.object({
    id: z.string().regex(/^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/),
    text: z.string().min(1).refine((value) => value.trim().length > 0, "criterion text must contain a non-whitespace character"),
    blocking: z.boolean(),
  }).strict()).min(1),
}).strict().superRefine((rubric, context) => {
  const seen = new Set<string>();
  rubric.criteria.forEach((criterion, index) => {
    if (seen.has(criterion.id)) {
      context.addIssue({ code: "custom", path: ["criteria", index, "id"], message: `Duplicate criterion id: ${criterion.id}` });
    }
    seen.add(criterion.id);
  });
});

export function parseRubricV1(value: unknown): RubricV1 {
  assertPlainJson(value, "rubric");
  return rubricV1Schema.parse(value);
}

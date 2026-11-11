import { z, type ZodType } from "zod";

import {
  internalErrorSchemaTables,
  PROJECT_ERROR_DEFINITIONS,
  type ProjectErrorCode,
} from "../errors.js";
import { SCHEMA_IDS } from "../versions.js";
import type { SchemaGenerationGroup } from "./schema-generation.js";

/**
 * One serialized-error variant per registry row: the exact envelope `parseProjectError` accepts
 * for that code, with every registry-derived field pinned as a `const`. The strict flat object is
 * the same constraint the hand-written documents expressed as an `errorBase` `allOf` overlay —
 * base and overlay folded into one schema per code.
 */
function serializedErrorVariant(code: string, definition: { readonly owner: string; readonly retryable: boolean; readonly action: string }, parameters: ZodType): ZodType {
  return z.object({
    schema_version: z.literal("1"),
    code: z.literal(code),
    owner: z.literal(definition.owner),
    retryable: z.literal(definition.retryable),
    diagnostic: z.object({ template_id: z.literal(code), parameters }).strict(),
    next_action: z.literal(definition.action),
  }).strict();
}

const projectVariants = Object.fromEntries(
  (Object.keys(PROJECT_ERROR_DEFINITIONS) as readonly ProjectErrorCode[]).map((code) => [
    code,
    serializedErrorVariant(code, PROJECT_ERROR_DEFINITIONS[code], internalErrorSchemaTables.project.parameters[code]),
  ]),
) as Readonly<Record<ProjectErrorCode, ZodType>>;

const projectErrorVariantDefs = Object.fromEntries(
  (Object.keys(projectVariants) as readonly ProjectErrorCode[]).map((code) => [`E_${code}`, projectVariants[code]]),
) as Readonly<Record<string, ZodType>>;

/** Error shapes: project-error, derived from the frozen error registry. */
export const errorSchemaGroup: SchemaGenerationGroup = {
  group: "errors",
  documents: [
    {
      file: "project-error",
      id: SCHEMA_IDS.projectError,
      root: z.union(Object.values(projectVariants)),
      defs: {
        ...internalErrorSchemaTables.project.primitives,
        ...internalErrorSchemaTables.project.shared,
        ...projectErrorVariantDefs,
      },
      migrated: true,
    },
  ],
};

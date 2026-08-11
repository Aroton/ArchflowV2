import { z, type ZodType } from "zod";

import {
  internalErrorSchemaTables,
  PROJECT_ERROR_DEFINITIONS,
  PROTOCOL_ERROR_DEFINITIONS,
  type ProjectErrorCode,
  type ProtocolErrorCode,
} from "../errors.js";
import { SCHEMA_IDS } from "../versions.js";
import type { GeneratedDefOverride, SchemaGenerationGroup } from "./schema-generation.js";

/**
 * One serialized-error variant per registry row: the exact envelope `parseProjectError` and
 * `parseProtocolError` accept for that code, with every registry-derived field pinned as a
 * `const`. The strict flat object is the same constraint the hand-written documents expressed as
 * an `errorBase` `allOf` overlay — base and overlay folded into one schema per code.
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

const protocolVariants = Object.fromEntries(
  (Object.keys(PROTOCOL_ERROR_DEFINITIONS) as readonly ProtocolErrorCode[]).map((code) => [
    code,
    serializedErrorVariant(code, PROTOCOL_ERROR_DEFINITIONS[code], internalErrorSchemaTables.protocol.parameters[code]),
  ]),
) as Readonly<Record<ProtocolErrorCode, ZodType>>;

/**
 * The path-claim Zod authority is a chain of named refines, which a schema emission cannot
 * represent, so this def keeps the hand-authored body: the single-pattern form of the same
 * lexical rules plus the two Ajv keywords (`x-archflow-max-utf8-bytes`, `x-archflow-nfc`) whose
 * logic JSON Schema cannot express as a pattern. Byte-for-byte the def `path-claim.schema.json`
 * and the pre-generation document carried.
 */
const repositoryPathClaimEmission: GeneratedDefOverride = {
  type: "string",
  minLength: 1,
  "x-archflow-max-utf8-bytes": 1024,
  "x-archflow-nfc": true,
  pattern: "^(?!/)(?![A-Za-z]:)(?!//)(?!.*\\\\)(?!.*[\\u0000-\\u001F\\u007F-\\u009F])(?!\\.\\.?(?:/|$))(?!.*\\/\\.\\.?(?:/|$))(?!.*//)(?!.*[:*?\\[\\]<>|])(?!.*[. ](?:/|$))(?!(?:.*/)?(?:[Cc][Oo][Nn]|[Pp][Rr][Nn]|[Aa][Uu][Xx]|[Nn][Uu][Ll]|[Cc][Oo][Mm][1-9]|[Ll][Pp][Tt][1-9])(?:\\.[^/]*)?(?:/|$)).+$",
};

const projectErrorVariantDefs = Object.fromEntries(
  (Object.keys(projectVariants) as readonly ProjectErrorCode[]).map((code) => [`E_${code}`, projectVariants[code]]),
) as Readonly<Record<string, ZodType>>;

/** Error shapes: project-error and protocol-error, derived from the frozen error registry. */
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
      overrides: { repositoryPathClaim: repositoryPathClaimEmission },
      migrated: true,
    },
    {
      file: "protocol-error",
      id: SCHEMA_IDS.protocolError,
      root: z.union(Object.values(protocolVariants)),
      defs: {
        ...internalErrorSchemaTables.protocol.primitives,
        notFound: protocolVariants.TOOL_NOT_FOUND,
        disabled: protocolVariants.TOOL_DISABLED,
        unsupported: protocolVariants.UNSUPPORTED_PROTOCOL,
        repeated: protocolVariants.INITIALIZATION_REPEATED,
      },
      migrated: true,
    },
  ],
};

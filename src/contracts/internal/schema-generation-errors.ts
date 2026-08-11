import type { SchemaGenerationGroup } from "./schema-generation.js";

/**
 * Error shapes: project-error and protocol-error. Documents join this list as their runtime
 * authority flips from Ajv to their Zod source.
 */
export const errorSchemaGroup: SchemaGenerationGroup = {
  group: "errors",
  documents: [],
};

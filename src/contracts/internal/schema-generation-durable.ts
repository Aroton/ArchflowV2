import type { SchemaGenerationGroup } from "./schema-generation.js";

/**
 * Durable-state shapes: durable-primitives, task-state, intent-receipt, maintenance-record,
 * task-initialization, legacy-import-initialization, document-artifact, implementation-output,
 * and result-manifest. Documents join this list as their runtime authority flips from Ajv to
 * their Zod source; the recursive plain-json def will need a hand-authored override emission.
 */
export const durableSchemaGroup: SchemaGenerationGroup = {
  group: "durable",
  documents: [],
};

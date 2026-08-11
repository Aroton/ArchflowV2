import type { SchemaGenerationGroup } from "./schema-generation.js";

/**
 * Gate shapes: gate-request, gate-decision-record, active-gate, gate-contract, and gate-decision.
 * Documents join this list as their runtime authority flips from Ajv to their Zod source.
 */
export const gateSchemaGroup: SchemaGenerationGroup = {
  group: "gate",
  documents: [],
};

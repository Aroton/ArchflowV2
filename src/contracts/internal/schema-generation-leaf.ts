import { configOverridesSchema, configRolesSchema, configRouteSchema, configV1Schema } from "../config.js";
import { SCHEMA_IDS } from "../versions.js";
import type { SchemaGenerationGroup } from "./schema-generation.js";

/**
 * Leaf shapes — the schemas with no durable-state, gate, error, or MCP-envelope role: primitives,
 * path-claim, evidence-slots, rubric, triage, config, workflow, constitution-rule, phase-instance,
 * review, review-evidence, adjudication, adjudication-evidence, secret-scan-result,
 * supplemental-review, supplemental-review-record, and result-expectation. Documents join this
 * list as their runtime authority flips from Ajv to their Zod source.
 */
export const leafSchemaGroup: SchemaGenerationGroup = {
  group: "leaf",
  documents: [
    {
      file: "config",
      id: SCHEMA_IDS.config,
      root: configV1Schema,
      defs: {
        route: configRouteSchema,
        roles: configRolesSchema,
        overrides: configOverridesSchema,
      },
      migrated: true,
    },
  ],
};

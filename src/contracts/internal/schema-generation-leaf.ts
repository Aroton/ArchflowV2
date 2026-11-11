import { configOverridesSchema, configRolesSchema, configRouteSchema, configV1Schema } from "../config.js";
import { constitutionRuleV1Schema } from "../constitution.js";
import { pathClaimLexicalV1Schema } from "../path-claims.js";
import { rubricV1Schema } from "../rubric.js";
import { SCHEMA_IDS } from "../versions.js";
import type { SchemaGenerationGroup } from "./schema-generation.js";

/**
 * Leaf shapes — the schemas with no error role: path-claim (which `simple-review-input`
 * references), config, rubric, and constitution-rule.
 */
export const leafSchemaGroup: SchemaGenerationGroup = {
  group: "leaf",
  documents: [
    {
      file: "path-claim",
      id: SCHEMA_IDS.pathClaim,
      root: pathClaimLexicalV1Schema,
      migrated: true,
    },
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
    {
      file: "rubric",
      id: SCHEMA_IDS.rubric,
      root: rubricV1Schema,
      migrated: true,
    },
    {
      file: "constitution-rule",
      id: SCHEMA_IDS.constitutionRule,
      root: constitutionRuleV1Schema,
      migrated: true,
    },
  ],
};

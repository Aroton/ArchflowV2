import type { SchemaGenerationGroup } from "./schema-generation.js";

/**
 * The MCP tool-envelope shape: mcp-tools. It joins this list when its runtime authority flips
 * from Ajv to its Zod source; its advertised-tool projection in `src/mcp/tools.ts` keeps reading
 * the generated document unchanged because cross-document refs keep the exact
 * `<schema-id>#/$defs/<def>` form.
 */
export const mcpToolsSchemaGroup: SchemaGenerationGroup = {
  group: "mcp-tools",
  documents: [],
};

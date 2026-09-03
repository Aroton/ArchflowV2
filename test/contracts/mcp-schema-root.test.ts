import { describe, expect, it } from "vitest";

import { ADVERTISED_TOOL_CATALOGUE } from "../../src/mcp/tools.js";

describe("MCP tool schema root convention", () => {
  it("advertises every tool with a plain object root schema (no root-level oneOf/allOf/anyOf/$ref)", () => {
    expect(ADVERTISED_TOOL_CATALOGUE.length).toBeGreaterThan(0);

    for (const tool of ADVERTISED_TOOL_CATALOGUE) {
      const schema = tool.inputSchema as Record<string, unknown>;

      // Root must be a plain object
      expect(schema, `${tool.name} schema must be an object`).toBeTypeOf("object");
      expect(schema.type, `${tool.name} root schema type must be 'object'`).toBe("object");

      // No root combinators or refs that flatten/drop in hosts
      expect(schema.oneOf, `${tool.name} must not have root-level oneOf`).toBeUndefined();
      expect(schema.allOf, `${tool.name} must not have root-level allOf`).toBeUndefined();
      expect(schema.anyOf, `${tool.name} must not have root-level anyOf`).toBeUndefined();
      expect(schema.$ref, `${tool.name} must not have root-level $ref`).toBeUndefined();

      // Must have properties map
      expect(schema.properties, `${tool.name} must declare a properties object`).toBeTypeOf("object");
      const properties = schema.properties as Record<string, unknown>;
      expect(Object.keys(properties).length, `${tool.name} properties must not be empty`).toBeGreaterThan(0);
    }
  });
});

import { specTypeSchemas } from "@modelcontextprotocol/server";
import { describe, expect, it } from "vitest";

import { ADVERTISED_TOOL_NAMES } from "../../src/contracts/tool-names.js";
import { ADVERTISED_TOOL_CATALOGUE } from "../../src/mcp/tools.js";

describe("advertised MCP tool catalogue", () => {
  it("passes the SDK ListToolsResult schema with the fixed non-paginated surface", () => {
    const listed = { tools: ADVERTISED_TOOL_CATALOGUE };
    const validation = specTypeSchemas.ListToolsResult["~standard"].validate(listed);
    expect(validation).not.toHaveProperty("issues");
    expect(validation).toHaveProperty("value");
    expect(listed).not.toHaveProperty("nextCursor");
    expect(ADVERTISED_TOOL_CATALOGUE.map(({ name }) => name)).toEqual(ADVERTISED_TOOL_NAMES);
  });

  it("keeps both tool inputs on plain object roots within the advertisement byte budget", () => {
    expect(ADVERTISED_TOOL_NAMES).toEqual(["archflow_status", "archflow_apply"]);
    expect(ADVERTISED_TOOL_CATALOGUE.map(({ description }) => description)).toEqual([
      "Read durable ArchFlow status for one task and optional producing-skill invocation without mutation; returns one reconciled workflow view and at most one bounded offer for the current document owner.",
      "Apply exactly one supplied server offer using only its expected semantic submission; never chooses or loops to another action and returns the newly authenticated workflow view.",
    ]);
    for (const descriptor of ADVERTISED_TOOL_CATALOGUE) {
      expect(descriptor.inputSchema.type, `${descriptor.name} input root`).toBe("object");
      for (const combinator of ["oneOf", "allOf", "anyOf", "$ref", "if"] as const) {
        expect(descriptor.inputSchema, `${descriptor.name} input root ${combinator}`).not.toHaveProperty(combinator);
      }
    }
    expect(JSON.stringify({ tools: ADVERTISED_TOOL_CATALOGUE }).length).toBeLessThan(28_200);
  });
});

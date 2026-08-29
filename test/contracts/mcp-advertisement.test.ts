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
    // Measured at 33,591 bytes with the repository-set and review-strength projections in both
    // semantic tools; the ceiling sits about 3% above that so any further growth of the
    // advertisement is a deliberate decision rather than drift. Input roots and their
    // host-compatibility constraints remain unchanged.
    // The additive test-reviewer route and public contributor/assignment provenance intentionally
    // expand both semantic tool schemas. Keep a close ceiling so accidental recursive growth still
    // fails, while accounting for those user-visible fields.
    expect(JSON.stringify({ tools: ADVERTISED_TOOL_CATALOGUE }).length).toBeLessThan(36_500);
  });
});

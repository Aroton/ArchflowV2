import { specTypeSchemas } from "@modelcontextprotocol/server";
import { describe, expect, it } from "vitest";

import { ADVERTISED_TOOL_NAMES } from "../../src/contracts/tool-names.js";
import { ADVERTISED_TOOL_CATALOGUE } from "../../src/mcp/tools.js";
import { SELECTOR_PROFILES } from "../../src/review/effort-policy.js";
import { createJsonSchemaValidator } from "../helpers/json-schema.js";

describe("advertised MCP tool catalogue", () => {
  it("advertises every current recommendation profile with optional explanation", () => {
    for (const descriptor of ADVERTISED_TOOL_CATALOGUE.filter(({ name }) => name !== "archflow_review")) {
      const output = descriptor.outputSchema as { $defs: Record<string, object> };
      const { validate } = createJsonSchemaValidator(output.$defs.implementationRecommendation!);
      for (const { model, effort } of Object.values(SELECTOR_PROFILES)) {
        for (const explanation of [{}, { rationale: "The tested predecessor settles ownership; this phase wires its consumers." }]) {
          expect(validate({ status: "ready", model, effort, ...explanation }), JSON.stringify(validate.errors)).toBe(true);
        }
      }
    }
  });
  it("passes the SDK ListToolsResult schema with the fixed non-paginated surface", () => {
    const listed = { tools: ADVERTISED_TOOL_CATALOGUE };
    const validation = specTypeSchemas.ListToolsResult["~standard"].validate(listed);
    expect(validation).not.toHaveProperty("issues");
    expect(validation).toHaveProperty("value");
    expect(listed).not.toHaveProperty("nextCursor");
    expect(ADVERTISED_TOOL_CATALOGUE.map(({ name }) => name)).toEqual(ADVERTISED_TOOL_NAMES);
  });

  it("keeps all tool inputs on plain object roots within the advertisement byte budget", () => {
    expect(ADVERTISED_TOOL_NAMES).toEqual(["archflow_status", "archflow_apply", "archflow_review"]);
    expect(ADVERTISED_TOOL_CATALOGUE.filter(({ name }) => name !== "archflow_review").map(({ description }) => description)).toEqual([
      "Read durable ArchFlow status for one task and optional producing-skill invocation without mutation; returns one reconciled workflow view and at most one bounded offer for the current document owner.",
      "Apply exactly one supplied server offer using only its expected semantic submission; never chooses or loops to another action and returns the newly authenticated workflow view.",
    ]);
    for (const descriptor of ADVERTISED_TOOL_CATALOGUE) {
      expect(descriptor.inputSchema.type, `${descriptor.name} input root`).toBe("object");
      for (const combinator of ["oneOf", "allOf", "anyOf", "$ref", "if"] as const) {
        expect(descriptor.inputSchema, `${descriptor.name} input root ${combinator}`).not.toHaveProperty(combinator);
      }
    }
    // Measured at 79,378 bytes with per-reviewer failure details and retry progress, in addition
    // to current, prior, and partial reports plus producer responses. The ceiling retains about
    // 3% headroom so accidental recursive growth still fails.
    // Input roots and their host-compatibility constraints remain unchanged.
    expect(JSON.stringify({ tools: ADVERTISED_TOOL_CATALOGUE }).length).toBeLessThan(94_000);
  });
});

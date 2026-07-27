import { describe, expect, expectTypeOf, it } from "vitest";

import { isToolName, TOOL_NAMES, type ToolName } from "../../src/contracts/index.js";

describe("five-tool vocabulary", () => {
  it("contains exactly the five architecture names in canonical order", () => {
    expect(TOOL_NAMES).toEqual([
      "archflow_state",
      "archflow_counter_review",
      "archflow_adjudicate",
      "archflow_gate",
      "archflow_waiver"
    ]);
    expect(Object.isFrozen(TOOL_NAMES)).toBe(true);
    expect(new Set(TOOL_NAMES)).toHaveLength(5);
  });

  it("narrows only exact names", () => {
    for (const name of TOOL_NAMES) expect(isToolName(name)).toBe(true);
    for (const value of ["archflow_init", "ARCHFLOW_STATE", " archflow_state", 1, null]) {
      expect(isToolName(value)).toBe(false);
    }
    expectTypeOf<ToolName>().toEqualTypeOf<(typeof TOOL_NAMES)[number]>();
  });
});

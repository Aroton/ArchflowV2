import { describe, expect, it } from "vitest";
import { DEFAULT_IMPLEMENTATION_SETTINGS, implementationProfilesSchema, projectImplementationProfiles } from "../../src/contracts/implementation-selection.js";

describe("public implementation catalog", () => {
  it("preserves effort omission and disabled profiles without exposing selection scoring", () => {
    const input = { status: "ready" as const, settings: { ...DEFAULT_IMPLEMENTATION_SETTINGS, enabled_profiles: ["glm-max"] },
      catalog: { schema_version: "1" as const, benchmark: "fixture", source: "fixture", captured_on: "2026-09-15", profiles: [
        { profile_id: "glm-max", model: "glm-5.3", effort: "max", score: 42, cost_group: "zai" },
        { profile_id: "glm-flash", model: "glm-5.3-flash", score: 33, cost_group: "zai" },
      ] } };
    const before = JSON.stringify(input);
    expect(projectImplementationProfiles("task", input)).toEqual({ schema_version: "1", task_id: "task", profiles: [
      { profile_id: "glm-max", model: "glm-5.3", effort: "max", enabled: true },
      { profile_id: "glm-flash", model: "glm-5.3-flash", enabled: false },
    ] });
    expect(JSON.stringify(input)).toBe(before);
    expect(implementationProfilesSchema.safeParse({ schema_version: "2", task_id: "task", profiles: [] }).success).toBe(false);
  });
});

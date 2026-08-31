import { describe, expect, it } from "vitest";

import { parseRawEffortReviewV1, type RawEffortReviewV1 } from "../../src/contracts/effort-review.js";
import { deriveImplementationEffortV1 } from "../../src/review/effort-policy.js";

const digest = (character: string): string => character.repeat(64);

function scoresForTotal(total: number): Record<"A" | "B" | "C" | "D" | "E", number> {
  let remaining = total;
  const scores = { A: 0, B: 0, C: 0, D: 0, E: 0 };
  for (const key of ["A", "B", "C", "E"] as const) {
    scores[key] = Math.min(3, remaining);
    remaining -= scores[key];
  }
  scores.D = remaining;
  return scores;
}

function raw(total: number, overrides: Record<string, unknown> = {}): RawEffortReviewV1 {
  const scores = scoresForTotal(total);
  const axis = (key: keyof typeof scores) => ({ score: scores[key], rationale: `${key} rationale` });
  const component = {
    component_id: "component-one",
    axes: { A: axis("A"), B: axis("B"), C: axis("C"), D: axis("D"), E: axis("E") },
    long_tool_loop: { value: "no", rationale: "bounded" },
    short_component: { value: "no", rationale: "not short" },
    ...(scores.D >= 2 ? { blocker: { answer_kind: "number", question: "Which numeric threshold applies?" } } : {}),
    ...overrides,
  };
  return parseRawEffortReviewV1({
    schema_version: "1",
    task_id: "effort-review",
    phase_instance: "phase-design-1",
    step: "effort_review",
    role: "effort-reviewer",
    subject_digest: digest("a"),
    input_fingerprint: digest("b"),
    component_manifest_digest: digest("c"),
    hazard_registry_digest: digest("d"),
    policy_id: "implementation-effort-v1",
    decomposition: { status: "adequate", rationale: "independent boundaries" },
    components: [component],
  });
}

describe("implementation effort policy", () => {
  it("exhausts every total and applies D blockers before routing", () => {
    const expected = [
      "gemini-3-7-flash-max", "gemini-3-7-flash-max", "gemini-3-7-flash-max",
      "gemini-3-7-flash-max", "gemini-3-7-flash-max", "gemini-3-7-flash-max",
      "glm-5-3-flash-max", "glm-5-3-flash-max",
      "gpt-5-6-sol-medium", "gpt-5-6-sol-medium", "gpt-5-6-sol-medium", "gpt-5-6-sol-medium",
      "gpt-5-6-sol-xhigh", "gpt-5-6-sol-xhigh", "blocked", "blocked",
    ];
    for (let total = 0; total <= 15; total += 1) {
      const result = deriveImplementationEffortV1(raw(total));
      expect(result.status === "blocked" ? "blocked" : result.phase_profile.profile_id, `total ${total}`).toBe(expected[total]);
      if (result.status === "ready" && result.phase_profile.model === "gpt-5.6-sol") {
        expect(result.phase_profile.effort).not.toBe("max" as never);
      }
    }
  });

  it("applies both conditional Gemini branches and conservative unknown fallbacks", () => {
    const axis = (score: number) => ({ score, rationale: "because" });
    const axes = (values: readonly number[]) => ({
      A: axis(values[0]!), B: axis(values[1]!), C: axis(values[2]!), D: axis(values[3]!), E: axis(values[4]!),
    });
    const classify = (value: "yes" | "no" | "unknown") => ({ value, rationale: "classified" });

    const lowLong = deriveImplementationEffortV1(raw(3, { axes: axes([1, 1, 1, 0, 0]), long_tool_loop: classify("yes") }));
    expect(lowLong.status === "ready" && lowLong.phase_profile.profile_id).toBe("glm-5-3-flash-max");
    const lowUnknown = deriveImplementationEffortV1(raw(3, { axes: axes([1, 1, 1, 0, 0]), long_tool_loop: classify("unknown") }));
    expect(lowUnknown.status === "ready" && lowUnknown.component_profiles[0]!.caveats[0]!.code).toBe("long-loop-unknown-conservative-glm");
    const lowHazard = deriveImplementationEffortV1(raw(3, { axes: axes([1, 0, 0, 0, 2]) }));
    expect(lowHazard.status === "ready" && lowHazard.phase_profile.profile_id).toBe("glm-5-3-flash-max");

    const midShort = deriveImplementationEffortV1(raw(6, { axes: axes([3, 1, 2, 0, 0]), short_component: classify("yes") }));
    expect(midShort.status === "ready" && midShort.phase_profile.profile_id).toBe("gemini-3-7-flash-max");
    const midUnknown = deriveImplementationEffortV1(raw(6, { axes: axes([3, 1, 2, 0, 0]), short_component: classify("unknown") }));
    expect(midUnknown.status === "ready" && midUnknown.component_profiles[0]!.caveats[0]!.code).toBe("short-component-unknown-conservative-glm");
  });

  it("aggregates by ladder maximum and retains every determining component id", () => {
    const first = raw(8).components[0]!;
    const second = { ...first, component_id: "component-two" };
    const third = { ...raw(3).components[0]!, component_id: "component-three" };
    const source = { ...raw(8), components: [first, second, third] };
    const result = deriveImplementationEffortV1(source);
    expect(result.status).toBe("ready");
    if (result.status === "ready") {
      expect(result.phase_profile.profile_id).toBe("gpt-5-6-sol-medium");
      expect(result.determining_component_ids).toEqual(["component-one", "component-two"]);
    }
  });

  it("withholds the phase profile for decomposition blockers", () => {
    const result = deriveImplementationEffortV1({
      ...raw(1),
      decomposition: { status: "undifferentiated", rationale: "multiple independent boundaries were merged", missing_boundaries: ["separate contract and dispatch components"] },
    });
    expect(result).toMatchObject({ status: "blocked", blockers: [{ kind: "undifferentiated-decomposition" }] });
    expect(result).not.toHaveProperty("phase_profile");
  });
});

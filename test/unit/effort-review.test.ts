import { describe, expect, it } from "vitest";

import {
  deriveBoundImplementationEffortV1,
  parseRawEffortReviewV1,
  type EffortReviewExpectedBindingsV1,
} from "../../src/contracts/effort-review.js";

const digest = (character: string): string => character.repeat(64);
const component = (id: string) => ({
  id,
  name: id,
  scope: "scope",
  mechanism: "mechanism",
  repositories: [{ name: "primary", paths: [`src/${id}.ts`] }],
  verification: "focused test",
});
const judgment = (id: string, e = 0, d = 0) => ({
  component_id: id,
  axes: Object.fromEntries(["A", "B", "C", "D", "E"].map((axis) => [axis, {
    score: axis === "D" ? d : axis === "E" ? e : 0,
    rationale: `${axis} rationale`,
  }])),
  long_tool_loop: { value: "no", rationale: "bounded" },
  short_component: { value: "yes", rationale: "small" },
  ...(d >= 2 ? { blocker: { answer_kind: "priority-order", question: "Which priority wins?" } } : {}),
});
const raw = (components: readonly unknown[]) => ({
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
  decomposition: { status: "adequate", rationale: "separable" },
  components,
});
const expected = {
  task_id: "effort-review",
  phase_instance: "phase-design-1",
  subject_digest: digest("a"),
  input_fingerprint: digest("b"),
  component_manifest_digest: digest("c"),
  policy_id: "implementation-effort-v1",
  component_manifest: { schema_version: "1", components: [component("one"), component("two")] },
  hazard_registry: {
    schema_version: "1",
    state: "present",
    registry_digest: digest("d"),
    hazards: [],
    components: [
      { component_id: "one", matches: [], e_floor: "unmatched" },
      { component_id: "two", matches: [], e_floor: 2 },
    ],
  },
} as unknown as EffortReviewExpectedBindingsV1;

describe("effort review contracts", () => {
  it("accepts exact ordered coverage and enforces captured hazard floors", () => {
    const result = deriveBoundImplementationEffortV1(raw([judgment("one"), judgment("two", 2)]), expected);
    expect(result.recommendation.status).toBe("ready");
    expect(() => deriveBoundImplementationEffortV1(raw([judgment("one"), judgment("two", 1)]), expected)).toThrow(/hazard floor/);
  });

  it("rejects reordered, missing, duplicate, and orphan component results", () => {
    for (const components of [
      [judgment("two", 2), judgment("one")],
      [judgment("one")],
      [judgment("one"), judgment("one")],
      [judgment("one"), judgment("orphan")],
    ]) expect(() => deriveBoundImplementationEffortV1(raw(components), expected)).toThrow();
  });

  it("keeps totals, profiles, phase aggregation, routes, and actions out of raw output", () => {
    const valid = raw([judgment("one"), judgment("two", 2)]);
    for (const forbidden of ["total", "profile", "phase_profile", "route", "action"]) {
      expect(() => parseRawEffortReviewV1({ ...valid, [forbidden]: "not reviewer-owned" })).toThrow();
    }
  });

  it("requires a number-or-priority question exactly when D blocks", () => {
    const blocked = judgment("one", 0, 2);
    expect(() => parseRawEffortReviewV1(raw([{ ...blocked, blocker: undefined }]))).toThrow();
    expect(() => parseRawEffortReviewV1(raw([{ ...judgment("one"), blocker: { answer_kind: "number", question: "unearned" } }]))).toThrow();
  });

  it("rejects accessor and non-enumerable caller-owned data before parsing", () => {
    const accessor = raw([judgment("one")]) as Record<string, unknown>;
    Object.defineProperty(accessor, "task_id", { enumerable: true, get: () => "effort-review" });
    expect(() => parseRawEffortReviewV1(accessor)).toThrow();
    const hidden = raw([judgment("one")]) as Record<string, unknown>;
    Object.defineProperty(hidden, "hidden", { enumerable: false, value: true });
    expect(() => parseRawEffortReviewV1(hidden)).toThrow();
  });
});

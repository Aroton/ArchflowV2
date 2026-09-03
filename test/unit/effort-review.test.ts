import { describe, expect, it } from "vitest";

import {
  EFFORT_SELECTOR_INSTRUCTIONS,
  IMPLEMENTATION_AGENT_SELECTOR_POLICY_ID,
  createDefaultEffortSelectionV2,
  createEffortSelectionV2,
  deriveBoundImplementationEffortV1,
  rawEffortSelectionV2Schema,
  parseRawEffortReviewV1,
  type EffortEnvelopeV2,
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
  const selectorEnvelope = {
    schema_version: "2",
    instructions: EFFORT_SELECTOR_INSTRUCTIONS,
    artifact: "# Phase design\n",
    task_id: "effort-review",
    phase_instance: "phase-design-1",
    attempt: 1,
    subject_digest: digest("a"),
    input_fingerprint: digest("b"),
    invocation_id: "selector-invocation",
    result_id: "selector-result",
    policy_id: IMPLEMENTATION_AGENT_SELECTOR_POLICY_ID,
    hazard_registry: { schema_version: "1", state: "absent", registry_digest: digest("d"), hazards: [] },
    repositories: [{ name: "primary", repository_identity_digest: digest("e"), commit: "f".repeat(40) }],
  } as unknown as EffortEnvelopeV2;

  it("accepts only a bound profile from the fresh selector", () => {
    const rawSelection = {
      schema_version: "2", task_id: "effort-review", phase_instance: "phase-design-1",
      step: "effort_review", role: "effort-reviewer", subject_digest: digest("a"),
      input_fingerprint: digest("b"), policy_id: IMPLEMENTATION_AGENT_SELECTOR_POLICY_ID,
      profile_id: "gpt-5-6-sol-xhigh",
    };
    expect(rawEffortSelectionV2Schema.parse(rawSelection)).toEqual(rawSelection);
    for (const forbidden of ["components", "scores", "rationale", "findings", "questions", "blockers", "total"]) {
      expect(() => rawEffortSelectionV2Schema.parse({ ...rawSelection, [forbidden]: [] })).toThrow();
    }
    const selected = createEffortSelectionV2(rawSelection, selectorEnvelope, {
      adapter: "codex-cli", cli_version: "1.0.0", model_family: "codex", model: "gpt-5.6-luna",
      effort: "xhigh", invocation_id: "selector-invocation", result_id: "selector-result",
      envelope_input_digest: digest("1") as never, observed_output_digest: digest("2") as never, route_source: { provenance: "configured" },
      repositories: selectorEnvelope.repositories,
    });
    expect(selected.profile).toMatchObject({ model: "gpt-5.6-sol", effort: "xhigh" });
  });

  it("mints the fixed Sol-medium default without selector work", () => {
    expect(createDefaultEffortSelectionV2(selectorEnvelope)).toMatchObject({
      schema_version: "2",
      profile: { model: "gpt-5.6-sol", effort: "medium" },
      source: { kind: "default" },
    });
  });

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

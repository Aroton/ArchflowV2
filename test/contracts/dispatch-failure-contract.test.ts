import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

import {
  REPOSITORY_NAME_PRESENCE_RULE,
  dispatchFailureObservationV1Schema,
  projectDispatchFailureObservation,
} from "../../src/contracts/dispatch-failure.js";

const observation = {
  schema_version: "1",
  task_id: "approval-automation",
  phase_instance: "phase-impl-2",
  step: "counter_review",
  attempt: 1,
  role: "counter-reviewer",
  code: "AUTH_UNAVAILABLE",
  message: "The required reviewer authentication is unavailable.",
  route: {
    model: "claude-fable-5",
    effort: "high",
    provider: "zai",
    source: "invocation-declared",
  },
  observed_at_revision: 17,
} as const;

describe("dispatch-failure contract", () => {
  it("parses the strict bounded observation and rejects forensic or unbounded additions", () => {
    expect(dispatchFailureObservationV1Schema.parse(observation)).toEqual(observation);
    expect(dispatchFailureObservationV1Schema.safeParse({ ...observation, stderr_tail: "secret" }).success).toBe(false);
    expect(dispatchFailureObservationV1Schema.safeParse({ ...observation, message: "x".repeat(257) }).success).toBe(false);
    expect(dispatchFailureObservationV1Schema.safeParse({ ...observation, code: "MODEL_OUTPUT_INVALID" }).success).toBe(false);
    expect(dispatchFailureObservationV1Schema.safeParse({
      ...observation, route: { ...observation.route, effort: "extreme" },
    }).success).toBe(false);
  });

  it("projects only safe public facts and strips exact-current join identifiers", () => {
    const projected = projectDispatchFailureObservation(
      dispatchFailureObservationV1Schema.parse(observation),
    );
    expect(projected).toEqual({
      role: "counter-reviewer",
      code: "AUTH_UNAVAILABLE",
      message: "The required reviewer authentication is unavailable.",
      route: observation.route,
    });
    expect(projected).not.toHaveProperty("task_id");
    expect(projected).not.toHaveProperty("phase_instance");
    expect(projected).not.toHaveProperty("attempt");
    expect(projected).not.toHaveProperty("observed_at_revision");
  });

  it("names only the safe configured member for a repository view failure", () => {
    const unavailable = dispatchFailureObservationV1Schema.parse({
      ...observation,
      code: "REPOSITORY_VIEW_UNAVAILABLE",
      message: "A required read-only repository snapshot is unavailable.",
      repository_name: "apis",
    });
    expect(projectDispatchFailureObservation(unavailable)).toMatchObject({
      code: "REPOSITORY_VIEW_UNAVAILABLE",
      repository_name: "apis",
    });
    expect(dispatchFailureObservationV1Schema.safeParse({ ...unavailable, repository_name: "/private/apis" }).success).toBe(false);
    expect(dispatchFailureObservationV1Schema.safeParse({ ...unavailable, repository_name: undefined }).success).toBe(false);
    expect(dispatchFailureObservationV1Schema.safeParse({ ...observation, repository_name: "apis" }).success).toBe(false);
  });

  it("publishes the repository_name presence rule below the leaf document's plain object root", () => {
    const leaf = JSON.parse(readFileSync(new URL("../../src/contracts/schemas/v1/dispatch-failure.schema.json", import.meta.url), "utf8")) as Record<string, unknown>;
    expect(leaf.type).toBe("object");
    expect(leaf.allOf).toEqual(REPOSITORY_NAME_PRESENCE_RULE.allOf);
  });
});

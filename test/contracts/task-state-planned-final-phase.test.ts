import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

import pathClaimSchema from "../../src/contracts/schemas/v1/path-claim.schema.json" with { type: "json" };
import primitivesSchema from "../../src/contracts/schemas/v1/primitives.schema.json" with { type: "json" };
import taskStateSchema from "../../src/contracts/schemas/v1/task-state.schema.json" with { type: "json" };
import { createJsonSchemaValidator } from "../helpers/json-schema.js";

const validator = createJsonSchemaValidator<Record<string, unknown>>(
  structuredClone(taskStateSchema),
  [structuredClone(primitivesSchema), structuredClone(pathClaimSchema)],
);
const fixture = (): Record<string, unknown> => JSON.parse(readFileSync(
  new URL("../fixtures/contracts/durable/task-state.valid.json", import.meta.url),
  "utf8",
)) as Record<string, unknown>;

describe("TaskStateV1 planned_final_phase", () => {
  it("accepts absence and a positive safe integer", () => {
    expect(validator.validate(fixture())).toBe(true);
    expect(validator.validate({ ...fixture(), planned_final_phase: 2 })).toBe(true);
  });

  it.each([0, -1, 1.5, Number.MAX_SAFE_INTEGER + 1])(
    "rejects invalid final phase %s",
    (plannedFinalPhase) => {
      expect(validator.validate({ ...fixture(), planned_final_phase: plannedFinalPhase })).toBe(false);
    },
  );
});

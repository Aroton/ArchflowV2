import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

import pathClaimSchema from "../../src/contracts/schemas/v1/path-claim.schema.json" with { type: "json" };
import primitivesSchema from "../../src/contracts/schemas/v1/primitives.schema.json" with { type: "json" };
import taskStateSchema from "../../src/contracts/schemas/v1/task-state.schema.json" with { type: "json" };
import { taskStateV1Schema } from "../../src/contracts/durable-state.js";
import { assertZodAgreement, createJsonSchemaValidator } from "../../src/contracts/validators.js";

/**
 * The `task-state` agreement suite. `taskStateV1Schema` is now the runtime authority — `readTaskState`
 * parses through it — and `task-state.schema.json` is generated from it. The compiled schema is
 * still exercised so the generated document and its Zod source cannot drift structurally; the three
 * set-ordering rules are Zod-only since generation retired the `x-archflow-sorted-unique-by`
 * keyword, and each is proven from a committed negative fixture so the rejection survives a rewrite.
 */

const validator = createJsonSchemaValidator<Record<string, unknown>>(
  structuredClone(taskStateSchema),
  [structuredClone(primitivesSchema), structuredClone(pathClaimSchema)],
);

type JsonObject = Record<string, unknown>;

const fixture = (name: string): JsonObject => JSON.parse(readFileSync(
  new URL(`../fixtures/contracts/durable/${name}.json`, import.meta.url),
  "utf8",
)) as JsonObject;

const rejectedByBoth = (value: unknown, label: string): void => {
  expect(validator.validate(value), `${label}: JSON Schema accepted`).toBe(false);
  expect(taskStateV1Schema.safeParse(value).success, `${label}: Zod accepted`).toBe(false);
  expect(() => assertZodAgreement(value, validator, taskStateV1Schema, label)).toThrowError(
    /schema validation failed/,
  );
};

describe("task-state mirror agreement", () => {
  it("agrees on the canonical fixture", () => {
    const sample = fixture("task-state.valid");
    expect(assertZodAgreement(sample, validator, taskStateV1Schema, "task-state")).toEqual(sample);
  });

  it("agrees when every optional field is exercised", () => {
    const sample = fixture("task-state.valid");
    delete sample.open_gate;
    delete sample.committed_intent;
    delete sample.adopted_checkpoint;
    const minimal = { ...sample };
    const maximal = { ...fixture("task-state.valid"), planned_final_phase: 3, terminal: "complete" };
    for (const [label, value] of [["minimal", minimal], ["maximal", maximal]] as const) {
      expect(assertZodAgreement(value, validator, taskStateV1Schema, label)).toEqual(value);
    }
  });

  it("agrees on the legacy adopted_checkpoint field, preserved verbatim", () => {
    const sample = fixture("task-state.valid");
    expect(sample.adopted_checkpoint).toEqual({
      revision: 7,
      checkpoint_digest: "2b3c4d5e6f1a2b3c4d5e6f1a2b3c4d5e6f1a2b3c4d5e6f1a2b3c4d5e6f1a2b3c",
    });
    const validated = assertZodAgreement(sample, validator, taskStateV1Schema, "adopted_checkpoint") as JsonObject;
    expect(validated.adopted_checkpoint).toEqual(sample.adopted_checkpoint);
  });

  it("rejects an unknown property in both authorities", () => {
    rejectedByBoth(
      { ...fixture("task-state.valid"), archflow_unknown_property: "x" },
      "unknown property",
    );
  });

  /**
   * Generation retired the `x-archflow-sorted-unique-by` keyword, so the compiled document accepts
   * these fixtures; the Zod authority behind `readTaskState` must keep rejecting them.
   */
  describe("set ordering — the Zod authority rejects each committed violation", () => {
    it.each([
      ["task-state.invalid-unsorted-authoritative-results", "authoritative_results out of (phase_instance, step) order"],
      ["task-state.invalid-duplicate-approval-gate-id", "approvals with a duplicate gate_id"],
      ["task-state.invalid-duplicate-waiver-gate-id", "waivers with a duplicate gate_id"],
    ])("%s", (name, label) => {
      const value = fixture(name);
      expect(validator.validate(value), `${label}: generated schema kept a retired keyword`).toBe(true);
      expect(taskStateV1Schema.safeParse(value).success, `${label}: Zod accepted`).toBe(false);
    });
  });
});

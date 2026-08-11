import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

import pathClaimSchema from "../../src/contracts/schemas/v1/path-claim.schema.json" with { type: "json" };
import primitivesSchema from "../../src/contracts/schemas/v1/primitives.schema.json" with { type: "json" };
import taskStateSchema from "../../src/contracts/schemas/v1/task-state.schema.json" with { type: "json" };
import { taskStateV1Schema } from "../../src/contracts/durable-state.js";
import { createJsonSchemaValidator } from "../helpers/json-schema.js";

/**
 * `task-state` validation under the Zod authority. `taskStateV1Schema` is the runtime authority —
 * `readTaskState` parses through it — and `task-state.schema.json` is generated from it, with
 * `check:schemas` fencing the committed bytes. The compiled schema appears only as a third-party
 * consumer: it must accept the canonical fixture, and it deliberately accepts the three
 * set-ordering violations below because generation retired the ordering keywords — each rejection
 * belongs to the Zod authority alone and is proven from a committed negative fixture so it
 * survives a rewrite.
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

const accepts = (value: unknown, label: string): void => {
  const result = taskStateV1Schema.safeParse(value);
  expect(result.success, `${label}: Zod rejected`).toBe(true);
  if (result.success) expect(result.data, `${label}: Zod transformed the value`).toEqual(value);
};

describe("task-state validation under the Zod authority", () => {
  it("accepts the canonical fixture, and the published schema accepts it too", () => {
    const sample = fixture("task-state.valid");
    accepts(sample, "canonical");
    expect(validator.validate(sample)).toBe(true);
  });

  it("accepts every optional-field combination", () => {
    const sample = fixture("task-state.valid");
    delete sample.open_gate;
    delete sample.committed_intent;
    delete sample.adopted_checkpoint;
    const minimal = { ...sample };
    const maximal = { ...fixture("task-state.valid"), planned_final_phase: 3, terminal: "complete" };
    for (const [label, value] of [["minimal", minimal], ["maximal", maximal]] as const) {
      accepts(value, label);
    }
  });

  it("preserves the legacy adopted_checkpoint field verbatim", () => {
    const sample = fixture("task-state.valid");
    expect(sample.adopted_checkpoint).toEqual({
      revision: 7,
      checkpoint_digest: "2b3c4d5e6f1a2b3c4d5e6f1a2b3c4d5e6f1a2b3c4d5e6f1a2b3c4d5e6f1a2b3c",
    });
    accepts(sample, "adopted_checkpoint");
  });

  it("rejects an unknown property", () => {
    const mutated = { ...fixture("task-state.valid"), archflow_unknown_property: "x" };
    expect(taskStateV1Schema.safeParse(mutated).success, "unknown property: Zod accepted").toBe(false);
  });

  /**
   * Generation retired the set-ordering keywords, so the compiled document accepts these fixtures;
   * the Zod authority behind `readTaskState` must keep rejecting them.
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

import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

import pathClaimSchema from "../../src/contracts/schemas/v1/path-claim.schema.json" with { type: "json" };
import primitivesSchema from "../../src/contracts/schemas/v1/primitives.schema.json" with { type: "json" };
import taskStateSchema from "../../src/contracts/schemas/v1/task-state.schema.json" with { type: "json" };
import { ruleSettlementV1Schema, taskStateV1Schema } from "../../src/contracts/durable-state.js";
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
    delete sample.last_transition;
    const minimal = { ...sample };
    const maximal = { ...fixture("task-state.valid"), planned_final_phase: 3, terminal: "complete" };
    for (const [label, value] of [["minimal", minimal], ["maximal", maximal]] as const) {
      accepts(value, label);
    }
  });

  /**
   * A rule settlement freezes both autonomous and wait outcomes. Its set rule is the TRIPLE
   * `(phase_instance, subject_digest,
   * settled_at_revision)`: an exact planning restart legally re-settles the same pair at a new
   * revision, so a pair key would reject the settling transaction's own history. The revision
   * bound is Zod-only (generation retired such keywords), like the set ordering above.
   */
  const ruleSettlement = (
    settledAtRevision: number,
    conclusion: JsonObject = { wait: false, match: null },
  ): JsonObject => ({
    task_id: "mcp-integration",
    phase_instance: "phase-design-1",
    step: "triage",
    subject_digest: "d".repeat(64),
    conclusion,
    config_digest: "e".repeat(64),
    settled_at_revision: settledAtRevision,
  });

  it("accepts both rule-settlement conclusions, including a same-pair resettlement", () => {
    const sample = fixture("task-state.valid");
    accepts({
      ...sample,
      rule_settlements: [
        ruleSettlement(5),
        ruleSettlement(6, { wait: true, match: { kind: "subject", subject: "phase-design" } }),
        ruleSettlement(7, { wait: true, match: { kind: "content", paths: ["db/a.sql", "db/b.sql"] } }),
      ],
    }, "rule settlements");
    accepts({ ...sample, rule_settlements: [] }, "empty rule settlements");
  });

  it("rejects a rule settlement beyond the current revision, in the Zod authority", () => {
    const sample = fixture("task-state.valid");
    const future = { ...sample, rule_settlements: [ruleSettlement(8)] };
    expect(validator.validate(future), "generated schema kept a retired keyword").toBe(true);
    expect(taskStateV1Schema.safeParse(future).success, "Zod accepted").toBe(false);
  });

  it("rejects a rule settlement at revision 0", () => {
    const sample = fixture("task-state.valid");
    expect(taskStateV1Schema.safeParse({ ...sample, rule_settlements: [ruleSettlement(0)] }).success).toBe(false);
  });

  it("orders settlement revisions numerically across 9→10 and 99→100", () => {
    const sample = { ...fixture("task-state.valid"), revision: 100 };
    const canonical = [9, 10, 99, 100].map((revision) => ruleSettlement(revision));
    accepts({ ...sample, rule_settlements: canonical }, "numeric canonical order");
    for (const [label, entries] of [
      ["reverse numeric order", [...canonical].reverse()],
      ["duplicate triple", [canonical[0], { ...canonical[0] }]],
    ] as const) {
      const value = { ...sample, rule_settlements: entries };
      expect(validator.validate(value), `${label}: generated schema kept a retired keyword`).toBe(true);
      expect(taskStateV1Schema.safeParse(value).success, `${label}: Zod accepted`).toBe(false);
    }
  });

  it("rejects a content match whose paths are empty or not a sorted set", () => {
    const sample = fixture("task-state.valid");
    for (const paths of [[], ["db/b.sql", "db/a.sql"]]) {
      expect(taskStateV1Schema.safeParse({
        ...sample,
        rule_settlements: [ruleSettlement(6, { wait: true, match: { kind: "content", paths } })],
      }).success).toBe(false);
    }
  });

  it("rejects contradictory conclusions and unknown properties", () => {
    const sample = fixture("task-state.valid");
    expect(taskStateV1Schema.safeParse({
      ...sample,
      rule_settlements: [{ ...ruleSettlement(6), archflow_unknown_property: "x" }],
    }).success).toBe(false);
    for (const conclusion of [
      { wait: false, match: { kind: "subject", subject: "design" } },
      { wait: true, match: null },
      { wait: false, match: null, extra: true },
    ]) {
      expect(taskStateV1Schema.safeParse({
        ...sample,
        rule_settlements: [ruleSettlement(6, conclusion)],
      }).success).toBe(false);
    }
  });

  it("rejects secondary milestones on wait:true even when the primary milestone baseline is absent", () => {
    const waiting = {
      ...ruleSettlement(6, {
        wait: true,
        match: { kind: "content", paths: [], secondary_paths: [{ repository: "api", paths: ["src/api.ts"] }] },
      }),
      phase_instance: "phase-impl-1",
      secondary_milestones: [{
        repository: "api",
        repository_identity_digest: "a".repeat(64),
        baseline_commit: "1".repeat(40),
        target_ref: "refs/heads/main",
        target_head: "1".repeat(40),
        paths: ["src/api.ts"],
        commit_message: "ArchFlow: Implement mcp-integration phase 1",
        diff_digest: "b".repeat(64),
        snapshot_digest: "c".repeat(64),
      }],
    };
    expect(waiting).not.toHaveProperty("milestone_baseline_commit");
    const settlement = ruleSettlementV1Schema.safeParse(waiting);
    expect(settlement.success).toBe(false);
    if (!settlement.success) {
      expect(settlement.error.issues).toContainEqual(expect.objectContaining({ path: ["secondary_milestones"] }));
    }
    const sample = fixture("task-state.valid");
    expect(taskStateV1Schema.safeParse({ ...sample, rule_settlements: [waiting] }).success).toBe(false);
  });

  it("rejects retired state compatibility fields", () => {
    const sample = fixture("task-state.valid");
    expect(taskStateV1Schema.safeParse({ ...sample, committed_intent: {} }).success).toBe(false);
    expect(taskStateV1Schema.safeParse({ ...sample, adopted_checkpoint: {} }).success).toBe(false);
  });

  it("rejects an unknown property", () => {
    const mutated = { ...fixture("task-state.valid"), archflow_unknown_property: "x" };
    expect(taskStateV1Schema.safeParse(mutated).success, "unknown property: Zod accepted").toBe(false);
  });

  /**
   * Generation retired the set-ordering keywords, so the compiled document accepts these fixtures;
   * the Zod authority behind `readTaskState` must keep rejecting them.
   */
  describe("set ordering — the Zod authority rejects each violation", () => {
    it.each([
      ["authoritative_results", (sample: JsonObject) => [...sample.authoritative_results as unknown[],].reverse(), "authoritative_results out of (phase_instance, step) order"],
      ["approvals", (sample: JsonObject) => [...(sample.approvals as unknown[]), (sample.approvals as unknown[])[0]], "approvals with a duplicate gate_id"],
      ["waivers", (sample: JsonObject) => [...(sample.waivers as unknown[]), (sample.waivers as unknown[])[0]], "waivers with a duplicate gate_id"],
    ] as const)("%s", (field, mutate, label) => {
      const sample = fixture("task-state.valid");
      const value = { ...sample, [field]: mutate(sample) };
      expect(validator.validate(value), `${label}: generated schema kept a retired keyword`).toBe(true);
      expect(taskStateV1Schema.safeParse(value).success, `${label}: Zod accepted`).toBe(false);
    });
  });
});

import { readFile } from "node:fs/promises";

import { describe, expect, it } from "vitest";

import { STEP_STATUSES, TERMINAL_STATES, taskStateV1Schema, type TaskStateV1 } from "../../src/contracts/durable-state.js";
import { GATE_KINDS } from "../../src/contracts/gates.js";
import { createJsonSchemaValidator } from "../helpers/json-schema.js";
import { PIPELINE_STEPS } from "../../src/contracts/vocabulary.js";

/**
 * `task-state` has exactly one shape authority (D2): `durable-state.ts` declares no Zod schema, so
 * there is no `assertZodAgreement` here and there must not be. Chunk 13 registers the schema; until
 * then the validator is built directly, as `durable-primitives.test.ts` already does.
 */
const readJson = async (url: URL): Promise<Record<string, unknown>> =>
  JSON.parse(await readFile(url, "utf8")) as Record<string, unknown>;

const schema = async (name: string): Promise<Record<string, unknown>> =>
  readJson(new URL(`../../src/contracts/schemas/v1/${name}.schema.json`, import.meta.url));

const taskStateValidator = async () =>
  createJsonSchemaValidator<TaskStateV1>(await schema("task-state"), [
    await schema("primitives"),
    await schema("path-claim"),
  ]);

const validState = async (): Promise<Record<string, unknown>> =>
  readJson(new URL("../fixtures/contracts/durable/task-state.valid.json", import.meta.url));

/** Every rejection below is structural — the schema's, never a validator rule. */
const rejects = async (mutate: (state: Record<string, unknown>) => Record<string, unknown>): Promise<void> => {
  const validator = await taskStateValidator();
  expect(validator.validate(mutate(await validState()))).toBe(false);
};

/**
 * Rejected by the Zod authority alone: generation retired the ordering keywords from the committed
 * schema, so the compiled document accepts these; the Zod refinement behind `readTaskState` is the
 * surviving authority.
 */
const rejectedByZodAuthority = async (mutate: (state: Record<string, unknown>) => Record<string, unknown>): Promise<void> => {
  const validator = await taskStateValidator();
  const mutated = mutate(await validState());
  expect(validator.validate(mutated)).toBe(true);
  expect(taskStateV1Schema.safeParse(mutated).success).toBe(false);
};

const enums = (value: unknown): readonly string[] | undefined => (value as { enum?: readonly string[] }).enum;

describe("task state contract", () => {
  it("round-trips the canonical valid fixture through its JSON Schema", async () => {
    const validator = await taskStateValidator();
    const state = await validState();
    expect(validator.validate(state), JSON.stringify(validator.validate.errors)).toBe(true);
  });

  it("keeps every vocabulary tuple identical to its schema enum", async () => {
    const taskState = await schema("task-state");
    const defs = taskState.$defs as Record<string, unknown>;
    const properties = taskState.properties as Record<string, unknown>;
    expect(enums(defs.stepStatus)).toEqual([...STEP_STATUSES]);
    expect(enums(defs.gateKind)).toEqual([...GATE_KINDS]);
    expect(enums(properties.terminal)).toEqual([...TERMINAL_STATES]);
    expect(enums(properties.step)).toEqual([...PIPELINE_STEPS]);
  });

  it("rejects 0 in every `>= 1` field (D8 — SafeInteger admits 0)", async () => {
    await rejects((state) => ({ ...state, revision: 0 }));
    await rejects((state) => ({ ...state, attempt: 0 }));
    await rejects((state) => ({
      ...state,
      approvals: [{ ...(state.approvals as Record<string, unknown>[])[0], resolved_at_revision: 0 }],
    }));
    await rejects((state) => ({
      ...state,
      open_gate: { ...(state.open_gate as Record<string, unknown>), opened_at_revision: 0 },
    }));
    await rejects((state) => ({
      ...state,
      waivers: [{ ...(state.waivers as Record<string, unknown>[])[0], rule_version: 0 }],
    }));
    await rejects((state) => ({
      ...state,
      waivers: [{ ...(state.waivers as Record<string, unknown>[])[0], granted_at_revision: 0 }],
    }));
    await rejects((state) => ({
      ...state,
      last_transition: { ...(state.last_transition as Record<string, unknown>), resulting_revision: 0 },
    }));
  });

  // Generation retired `x-archflow-sorted-unique-by`, so the compiled document accepts these
  // permutations; the Zod authority behind `readTaskState` is the surviving rejection.
  it("rejects a shuffled or duplicated authoritative_results in the Zod authority — a SET on the (phase_instance, step) tuple", async () => {
    await rejectedByZodAuthority((state) => ({ ...state, authoritative_results: [...(state.authoritative_results as unknown[])].reverse() }));
    await rejectedByZodAuthority((state) => {
      const [first] = state.authoritative_results as unknown[];
      return { ...state, authoritative_results: [first, first] };
    });
  });

  it("rejects a shuffled or duplicated approvals set in the Zod authority", async () => {
    await rejectedByZodAuthority((state) => ({ ...state, approvals: [...(state.approvals as unknown[])].reverse() }));
    await rejectedByZodAuthority((state) => {
      const [first] = state.approvals as unknown[];
      return { ...state, approvals: [first, first] };
    });
  });

  it("rejects an open_gate supplied as an array — a nested gate is unrepresentable, not merely rejected", async () => {
    await rejects((state) => ({ ...state, open_gate: [state.open_gate] }));
  });

  it("rejects retired compatibility fields", async () => {
    const validator = await taskStateValidator();
    const state = await validState();
    expect(validator.validate({ ...state, adopted_checkpoint: {} })).toBe(false);
    expect(validator.validate({ ...state, committed_intent: {} })).toBe(false);
  });

  it("requires waiver scope and accepts the optional waiver-origin gate marker", async () => {
    const validator = await taskStateValidator();
    const state = await validState();
    const [waiver] = state.waivers as Record<string, unknown>[];
    const { scope: _scope, ...withoutScope } = waiver!;
    expect(validator.validate({ ...state, waivers: [withoutScope] })).toBe(false);
    expect(validator.validate({
      ...state,
      open_gate: { ...(state.open_gate as Record<string, unknown>), waiver_origin_gate_id: "gate-origin" },
    }), JSON.stringify(validator.validate.errors)).toBe(true);
  });
});

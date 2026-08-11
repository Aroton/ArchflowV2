import { readFile } from "node:fs/promises";

import { describe, expect, it } from "vitest";

import {
  implementationOutputV1Schema,
  parseImplementationOutput,
  type ImplementationOutputV1,
} from "../../src/contracts/durable-implementation-output.js";
import { assertZodAgreement, createJsonSchemaValidator } from "../../src/contracts/validators.js";

const schema = async (name: string): Promise<object> =>
  JSON.parse(await readFile(new URL(`../../src/contracts/schemas/v1/${name}.schema.json`, import.meta.url), "utf8")) as object;

/**
 * Built directly here rather than through the registry: chunk 13 is the sole writer of
 * `versions.ts` and `schema-registry.test.ts`. The referenced set is exactly the transitive closure
 * of this schema's `$ref`s — `durable-primitives` (`outputEntry`, `declaredInputRef`,
 * `snapshotAccounting`), `secret-scan-result` (whole root), `primitives`, and the `path-claim` root
 * both claim `$defs` delegate to.
 */
const validator = async () =>
  createJsonSchemaValidator<ImplementationOutputV1>(await schema("implementation-output"), [
    await schema("primitives"),
    await schema("path-claim"),
    await schema("durable-primitives"),
    await schema("secret-scan-result"),
  ]);

const fixture = async (): Promise<Record<string, unknown>> =>
  JSON.parse(
    await readFile(new URL("../fixtures/contracts/durable/implementation-output.valid.json", import.meta.url), "utf8")
  ) as Record<string, unknown>;

/** Structural rejection means *both* authorities reject; a one-sided rejection is drift. */
const rejectedBoth = async (value: unknown): Promise<void> => {
  const jsonValidator = await validator();
  expect(jsonValidator.validate(value)).toBe(false);
  expect(implementationOutputV1Schema.safeParse(value).success).toBe(false);
};

const without = (value: Record<string, unknown>, key: string): Record<string, unknown> => {
  const { [key]: _removed, ...rest } = value;
  return rest;
};

describe("implementation output contract", () => {
  it("round-trips the canonical valid fixture through the JSON Schema", async () => {
    const jsonValidator = await validator();
    const sample = await fixture();
    expect(jsonValidator.validate(sample), JSON.stringify(jsonValidator.validate.errors)).toBe(true);
  });

  it("agrees between the two authorities on the fixture and parses it", async () => {
    const jsonValidator = await validator();
    const sample = await fixture();
    expect(assertZodAgreement(sample, jsonValidator, implementationOutputV1Schema)).toBe(sample);
    // Zod returns a fresh object rather than the input, so this is deep equality by construction.
    expect(parseImplementationOutput(sample)).toStrictEqual(sample);
  });

  it("requires `step` in both authorities and admits exactly the pipeline steps (D19)", async () => {
    const sample = await fixture();
    await rejectedBoth(without(sample, "step"));
    await rejectedBoth({ ...sample, step: "implement" });
    const jsonValidator = await validator();
    for (const step of ["produce", "counter_review", "triage", "adjudicate"]) {
      expect(assertZodAgreement({ ...sample, step }, jsonValidator, implementationOutputV1Schema)).toBeTruthy();
    }
  });

  it("rejects an empty `outputs`", async () => {
    await rejectedBoth({ ...(await fixture()), outputs: [] });
  });

  it("rejects a shuffled or duplicated member of every declared set", async () => {
    const sample = await fixture();
    for (const key of ["outputs", "parent_documents", "declared_inputs", "restore_targets"]) {
      const items = sample[key] as unknown[];
      await rejectedBoth({ ...sample, [key]: [...items].reverse() });
      await rejectedBoth({ ...sample, [key]: [items[0], items[0]] });
    }
    const changes = sample.undeclared_changes as Record<string, unknown>;
    const paths = changes.undeclared_paths as unknown[];
    await rejectedBoth({ ...sample, undeclared_changes: { ...changes, undeclared_paths: [...paths].reverse() } });
    await rejectedBoth({ ...sample, undeclared_changes: { ...changes, undeclared_paths: [paths[0], paths[0]] } });
  });

  it("accepts a raw, unrepresentable undeclared path that no claim schema would admit", async () => {
    const sample = await fixture();
    const changes = sample.undeclared_changes as Record<string, unknown>;
    const jsonValidator = await validator();
    const value = {
      ...sample,
      undeclared_changes: { ...changes, undeclared_paths: ["a\nb.txt", "notes/trailing."] },
    };
    expect(assertZodAgreement(value, jsonValidator, implementationOutputV1Schema)).toBe(value);
  });

  it("rejects a parent document role outside the four", async () => {
    const sample = await fixture();
    const parents = sample.parent_documents as Record<string, unknown>[];
    await rejectedBoth({
      ...sample,
      parent_documents: [{ ...parents[0], role: "phase-impl" }, parents[1]],
    });
  });

  it("rejects an unknown field in both authorities", async () => {
    await rejectedBoth({ ...(await fixture()), restore_hint: "src/index.ts" });
  });

  it("accepts `constitution_edit_gate_id` present and absent, with no rule tying it to a path class (D14)", async () => {
    const jsonValidator = await validator();
    const sample = await fixture();
    expect(sample.constitution_edit_gate_id).toBe("constitution-edit-1");
    expect(assertZodAgreement(sample, jsonValidator, implementationOutputV1Schema)).toBe(sample);
    const absent = without(sample, "constitution_edit_gate_id");
    expect(assertZodAgreement(absent, jsonValidator, implementationOutputV1Schema)).toBe(absent);
    // A `task-branch-constitution` output with the hook absent stays valid: gate policy is REQ-16's
    // and Phase 11's, not this schema's.
    const outputs = sample.outputs as Record<string, unknown>[];
    const constitutional = {
      ...absent,
      outputs: [{ ...outputs[0], path_class: "task-branch-constitution" }, outputs[1]],
    };
    expect(assertZodAgreement(constitutional, jsonValidator, implementationOutputV1Schema)).toBe(constitutional);
  });
});

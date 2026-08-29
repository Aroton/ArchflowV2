import { readFile } from "node:fs/promises";

import { describe, expect, it } from "vitest";

import {
  implementationOutputV1Schema,
  parseImplementationOutput,
  type ImplementationOutputV1,
} from "../../src/contracts/durable-implementation-output.js";
import { assertZodAgreement, createJsonSchemaValidator } from "../helpers/json-schema.js";

const schema = async (name: string): Promise<object> =>
  JSON.parse(await readFile(new URL(`../../src/contracts/schemas/v1/${name}.schema.json`, import.meta.url), "utf8")) as object;

/**
 * Built directly here rather than through the registry: chunk 13 is the sole writer of
 * `versions.ts` and `schema-registry.test.ts`. The referenced set is exactly the transitive closure
 * of this schema's `$ref`s — `durable-primitives` (`outputEntry`, `declaredInputRef`,
 * `snapshotAccounting`), `secret-scan-result` (whole root), `primitives`, and the `path-claim` root
 * both claim `$defs` delegate to.
 */
let validatorPromise: Promise<ReturnType<typeof createJsonSchemaValidator<ImplementationOutputV1>>> | undefined;
const validator = () => {
  if (validatorPromise === undefined) {
    validatorPromise = Promise.all([
      schema("implementation-output"),
      schema("primitives"),
      schema("path-claim"),
      schema("durable-primitives"),
      schema("secret-scan-result"),
    ]).then(([implSchema, ...refs]) => createJsonSchemaValidator<ImplementationOutputV1>(implSchema, refs));
  }
  return validatorPromise;
};

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

/**
 * Rejected by the Zod authority alone: generation retired the ordering keywords from the committed
 * schema, so the compiled document accepts these; the Zod refinement behind the parse function is
 * the surviving authority.
 */
const rejectedByZodAuthority = async (value: unknown): Promise<void> => {
  const jsonValidator = await validator();
  expect(jsonValidator.validate(value)).toBe(true);
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

  it("keeps secondary sections optional and validates their strict repository-bound shape", async () => {
    const sample = await fixture();
    expect(parseImplementationOutput(sample).secondary_repositories).toBeUndefined();
    const outputs = sample.outputs as Record<string, unknown>[];
    const accounting = sample.accounting as Record<string, unknown>;
    const declared = sample.declared_inputs as Record<string, unknown>[];
    const value = {
      ...sample,
      secondary_repositories: [{
        repository: "api",
        repository_identity_digest: "a".repeat(64),
        base_commit: sample.base_commit,
        index_identity_digest: "b".repeat(64),
        worktree_identity_digest: "c".repeat(64),
        outputs,
        diff_digest: "d".repeat(64),
        snapshot_digest: "e".repeat(64),
        restore_targets: sample.restore_targets,
        accounting,
        undeclared_changes: sample.undeclared_changes,
        declared_inputs: declared.map((input) => ({ ...input, path: "inputs/source.txt" })),
      }],
    };
    const jsonValidator = await validator();
    expect(assertZodAgreement(value, jsonValidator, implementationOutputV1Schema)).toBe(value);
    await rejectedBoth({ ...value, secondary_repositories: [{ ...(value.secondary_repositories[0] as object), unknown: true }] });
  });

  it("rejects a shuffled or duplicated member of every declared set in the Zod authority", async () => {
    const sample = await fixture();
    for (const key of ["outputs", "parent_documents", "declared_inputs", "restore_targets"]) {
      const items = sample[key] as unknown[];
      await rejectedByZodAuthority({ ...sample, [key]: [...items].reverse() });
      await rejectedByZodAuthority({ ...sample, [key]: [items[0], items[0]] });
    }
    const changes = sample.undeclared_changes as Record<string, unknown>;
    const paths = changes.undeclared_paths as unknown[];
    await rejectedByZodAuthority({ ...sample, undeclared_changes: { ...changes, undeclared_paths: [...paths].reverse() } });
    await rejectedByZodAuthority({ ...sample, undeclared_changes: { ...changes, undeclared_paths: [paths[0], paths[0]] } });
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

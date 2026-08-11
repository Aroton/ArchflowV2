import { readFile } from "node:fs/promises";

import { describe, expect, it } from "vitest";

import {
  parseTaskInitialization,
  taskInitializationV1Schema,
  type TaskInitializationV1,
} from "../../src/contracts/durable-task-initialization.js";
import { assertZodAgreement, createJsonSchemaValidator } from "../helpers/json-schema.js";

const schema = async (name: string): Promise<object> =>
  JSON.parse(await readFile(new URL(`../../src/contracts/schemas/v1/${name}.schema.json`, import.meta.url), "utf8")) as object;

/**
 * The schema is not registered in `versions.ts` yet — chunk 13 is that file's sole writer — so the
 * validator is built directly from the reference set. Compiling it also proves the pinned
 * `urn:archflow:schema:v1:durable-primitives#/$defs/canonicalTaskPaths` pointer resolves: Ajv raises
 * `can't resolve reference` at compile time if it does not.
 */
const validator = async () =>
  createJsonSchemaValidator<TaskInitializationV1>(
    await schema("task-initialization"),
    [await schema("primitives"), await schema("path-claim"), await schema("durable-primitives")]
  );

const fixture = JSON.parse(
  await readFile(new URL("../fixtures/contracts/durable/task-initialization.valid.json", import.meta.url), "utf8")
) as Record<string, unknown>;

/** Rejected structurally by BOTH authorities, never by one alone. */
const rejectedBoth = async (value: unknown): Promise<void> => {
  const jsonValidator = await validator();
  expect(jsonValidator.validate(value)).toBe(false);
  expect(taskInitializationV1Schema.safeParse(value).success).toBe(false);
};

describe("task initialization contract", () => {
  it("round-trips the canonical valid fixture through the JSON Schema", async () => {
    const jsonValidator = await validator();
    expect(jsonValidator.validate(fixture), JSON.stringify(jsonValidator.validate.errors)).toBe(true);
  });

  it("agrees between the two authorities on the fixture", async () => {
    const jsonValidator = await validator();
    expect(assertZodAgreement(fixture, jsonValidator, taskInitializationV1Schema)).toBe(fixture);
  });

  it("parses the fixture", () => {
    expect(parseTaskInitialization(fixture)).toEqual(fixture);
  });

  it("rejects an unknown field in both authorities", async () => {
    await rejectedBoth({ ...fixture, repin_of: "something" });
  });

  it("rejects a wrong artifact_kind in both authorities", async () => {
    await rejectedBoth({ ...fixture, artifact_kind: "legacy-import-initialization" });
  });

  it("rejects a malformed code_baseline_commit in both authorities", async () => {
    await rejectedBoth({ ...fixture, code_baseline_commit: "NOTAHEXOID" });
    await rejectedBoth({ ...fixture, code_baseline_commit: "0F1E2D3C4B5A69788796A5B4C3D2E1F001234567" });
    await rejectedBoth({ ...fixture, code_baseline_commit: "0f1e2d3c4b5a69788796a5b4c3d2e1f0012345" });
  });

  it("rejects a canonical_paths missing a member in both authorities", async () => {
    const { constitution_root: _dropped, ...incomplete } = fixture.canonical_paths as Record<string, unknown>;
    await rejectedBoth({ ...fixture, canonical_paths: incomplete });
  });
});

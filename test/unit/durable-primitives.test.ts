import { readFile } from "node:fs/promises";

import { describe, expect, it } from "vitest";

import {
  canonicalTaskPathsV1Schema,
  declaredInputRefV1Schema,
  outputEntryV1Schema,
  parseSnapshotAccounting,
  snapshotAccountingV1Schema,
  type CanonicalTaskPaths,
  type OutputEntry,
  type SnapshotAccountingV1,
} from "../../src/contracts/durable-primitives.js";
import type { DeclaredInputRef } from "../../src/contracts/fingerprints.js";
import { assertZodAgreement, createJsonSchemaValidator } from "../../src/contracts/validators.js";

const schema = async (name: string): Promise<object> =>
  JSON.parse(await readFile(new URL(`../../src/contracts/schemas/v1/${name}.schema.json`, import.meta.url), "utf8")) as object;

/**
 * `durable-primitives.schema.json` declares no root document — it is a bag of `$defs` other
 * schemas reach by `$ref`. The wrapper below is the same reference chunk 9 will use for
 * `implementation-output.outputs[*]`, so compiling it here also proves the pointer resolves.
 */
const outputEntryValidator = async () =>
  createJsonSchemaValidator<OutputEntry>(
    {
      $schema: "https://json-schema.org/draft/2020-12/schema",
      $id: "urn:archflow:schema:v1:test:output-entry",
      $ref: "urn:archflow:schema:v1:durable-primitives#/$defs/outputEntry",
    },
    [await schema("durable-primitives"), await schema("primitives"), await schema("path-claim")]
  );

const oid = (fill: string): string => fill.repeat(40).slice(0, 40);
const digest = (fill: string): string => fill.repeat(64).slice(0, 64);

/** One valid sample per operation, between them covering both storages and both file types. */
const addGitRegular = {
  path: "src/index.ts",
  path_class: "repository-source",
  operation: "add",
  storage: "git-object",
  file_type: "regular",
  after: { oid: oid("a1b2"), mode: "100644", size_bytes: 1024 },
};

const modifyRawSymlink = {
  path: ".archflow/tasks/demo/reviews/link.md",
  path_class: "review",
  operation: "modify",
  storage: "raw-payload",
  payload_bytes: 0,
  payload_digest: digest("c3d4"),
  file_type: "symlink",
  // `before` on modify/rename is deliberately unconstrained: `file_type` describes the post-state,
  // so a regular file may legally be replaced by a symlink.
  before: { oid: oid("b2c3"), mode: "100755", size_bytes: 12 },
  after: { oid: oid("d4e5"), mode: "120000", size_bytes: 9 },
};

const renameGitSymlink = {
  path: "docs/current.md",
  path_class: "document",
  operation: "rename",
  storage: "git-object",
  file_type: "symlink",
  before: { oid: oid("e5f6"), mode: "120000", size_bytes: 11 },
  after: { oid: oid("f6a7"), mode: "120000", size_bytes: 11 },
  previous_path: "docs/old.md",
};

const deleteGitRegular = {
  path: "docs/removed.md",
  path_class: "document",
  operation: "delete",
  storage: "git-object",
  file_type: "regular",
  // On delete, `before` IS the surviving blob and is mode-locked to `file_type`; `after` is absent.
  before: { oid: oid("0a1b"), mode: "100644", size_bytes: 64 },
};

const samples = [addGitRegular, modifyRawSymlink, renameGitSymlink, deleteGitRegular];

describe("durable output entry contract", () => {
  it("accepts one valid sample per operation in the JSON Schema", async () => {
    const jsonValidator = await outputEntryValidator();
    for (const sample of samples) {
      expect(jsonValidator.validate(sample), JSON.stringify(jsonValidator.validate.errors)).toBe(true);
    }
  });

  it("accepts the same samples in the Zod mirror", () => {
    for (const sample of samples) {
      expect(outputEntryV1Schema.safeParse(sample).success).toBe(true);
    }
  });

  it("agrees between the two authorities on every sample", async () => {
    const jsonValidator = await outputEntryValidator();
    for (const sample of samples) {
      expect(assertZodAgreement(sample, jsonValidator, outputEntryV1Schema)).toBe(sample);
    }
  });
});

/** The same `$def`-wrapper reference chunks 6-9 will use for the shared shapes. */
const defValidator = async <T>(defName: string) =>
  createJsonSchemaValidator<T>(
    {
      $schema: "https://json-schema.org/draft/2020-12/schema",
      $id: `urn:archflow:schema:v1:test:${defName}`,
      $ref: `urn:archflow:schema:v1:durable-primitives#/$defs/${defName}`,
    },
    [await schema("durable-primitives"), await schema("primitives"), await schema("path-claim")]
  );

const canonicalPaths = {
  task_root: ".archflow/tasks/demo",
  config: ".archflow/tasks/demo/config.yaml",
  state: ".archflow/tasks/demo/state.json",
  workflow: ".archflow/workflow.yaml",
  constitution_root: ".archflow/constitution",
};

const declaredInput = { input_id: "prd:v1", digest: digest("1234") };

/** `counted_entries` is a SET sorted by `path`; both entries below are in ascending path order. */
const accounting = {
  schema_version: "1",
  result_bytes: 4096,
  task_bytes: 8192,
  result_byte_cap: 26214400,
  task_byte_cap: 262144000,
  counted_entries: [
    { path: ".archflow/tasks/demo/reviews/a.md", storage: "raw-payload", stored_bytes: 4096 },
    { path: "src/index.ts", storage: "git-object", stored_bytes: 0 },
  ],
  measured_at_revision: 1,
};

/** Rejected by both authorities structurally, not by a validator rule. */
const rejectedBoth = async <T>(
  defName: string,
  zodSchema: { safeParse(value: unknown): { success: boolean } },
  value: unknown
): Promise<void> => {
  const jsonValidator = await defValidator<T>(defName);
  expect(jsonValidator.validate(value)).toBe(false);
  expect(zodSchema.safeParse(value).success).toBe(false);
};

describe("durable shared primitives contract", () => {
  it("agrees on a valid canonicalTaskPaths sample", async () => {
    const jsonValidator = await defValidator<CanonicalTaskPaths>("canonicalTaskPaths");
    expect(assertZodAgreement(canonicalPaths, jsonValidator, canonicalTaskPathsV1Schema)).toBe(canonicalPaths);
  });

  it("agrees on a valid declaredInputRef sample", async () => {
    const jsonValidator = await defValidator<DeclaredInputRef>("declaredInputRef");
    expect(assertZodAgreement(declaredInput, jsonValidator, declaredInputRefV1Schema)).toBe(declaredInput);
  });

  it("agrees on a valid snapshotAccounting sample and parses it", async () => {
    const jsonValidator = await defValidator<SnapshotAccountingV1>("snapshotAccounting");
    expect(assertZodAgreement(accounting, jsonValidator, snapshotAccountingV1Schema)).toBe(accounting);
    expect(parseSnapshotAccounting(accounting).measured_at_revision).toBe(1);
  });

  it("rejects a git-object entry with non-zero stored_bytes in both authorities (D16, structural)", async () => {
    await rejectedBoth("snapshotAccounting", snapshotAccountingV1Schema, {
      ...accounting,
      counted_entries: [
        { path: ".archflow/tasks/demo/reviews/a.md", storage: "raw-payload", stored_bytes: 4096 },
        { path: "src/index.ts", storage: "git-object", stored_bytes: 12 },
      ],
    });
  });

  it("rejects shuffled and duplicated counted_entries in both authorities", async () => {
    await rejectedBoth("snapshotAccounting", snapshotAccountingV1Schema, {
      ...accounting,
      counted_entries: [...accounting.counted_entries].reverse(),
    });
    await rejectedBoth("snapshotAccounting", snapshotAccountingV1Schema, {
      ...accounting,
      counted_entries: [accounting.counted_entries[0], accounting.counted_entries[0]],
    });
  });

  it("rejects measured_at_revision of 0 in both authorities (D8 — SafeInteger admits 0)", async () => {
    await rejectedBoth("snapshotAccounting", snapshotAccountingV1Schema, { ...accounting, measured_at_revision: 0 });
  });

  it("rejects byte counts above their caps structurally", async () => {
    const jsonValidator = await defValidator<SnapshotAccountingV1>("snapshotAccounting");
    expect(jsonValidator.validate({ ...accounting, result_bytes: 26214401 })).toBe(false);
    expect(jsonValidator.validate({ ...accounting, task_bytes: 262144001 })).toBe(false);
    expect(jsonValidator.validate({ ...accounting, result_bytes: 26214400, task_bytes: 262144000 })).toBe(true);
  });
});

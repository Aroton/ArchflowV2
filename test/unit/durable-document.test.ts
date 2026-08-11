import { readFile } from "node:fs/promises";

import { describe, expect, it } from "vitest";

import {
  documentArtifactV1Schema,
  parseDocumentArtifact,
  type DocumentArtifactV1,
} from "../../src/contracts/durable-document.js";
import { assertZodAgreement, createJsonSchemaValidator } from "../helpers/json-schema.js";

const schema = async (name: string): Promise<object> =>
  JSON.parse(await readFile(new URL(`../../src/contracts/schemas/v1/${name}.schema.json`, import.meta.url), "utf8")) as object;

/**
 * Chunk 13 is the sole writer of `versions.ts` and the registry test, so this suite builds the Ajv
 * validator directly, exactly as `durable-primitives.test.ts` does. Compiling it also proves the
 * pinned `urn:archflow:schema:v1:durable-primitives#/$defs/declaredInputRef` pointer resolves.
 */
const validator = async () =>
  createJsonSchemaValidator<DocumentArtifactV1>(
    await schema("document-artifact"),
    [await schema("durable-primitives"), await schema("primitives"), await schema("path-claim")]
  );

const fixture = async (): Promise<Record<string, unknown>> =>
  JSON.parse(await readFile(new URL("../fixtures/contracts/durable/document-artifact.valid.json", import.meta.url), "utf8")) as Record<string, unknown>;

/** Rejected by BOTH authorities — the schema and its mirror, never one alone. */
const rejectedBoth = async (value: unknown): Promise<void> => {
  const jsonValidator = await validator();
  expect(jsonValidator.validate(value)).toBe(false);
  expect(documentArtifactV1Schema.safeParse(value).success).toBe(false);
};

/**
 * Rejected by the Zod authority alone: generation retired the ordering keywords from the committed
 * schema, so the compiled document accepts these; the Zod refinement behind the parse function is
 * the surviving authority.
 */
const rejectedByZodAuthority = async (value: unknown): Promise<void> => {
  const jsonValidator = await validator();
  expect(jsonValidator.validate(value)).toBe(true);
  expect(documentArtifactV1Schema.safeParse(value).success).toBe(false);
};

describe("document artifact contract", () => {
  it("round-trips the valid fixture through the JSON Schema", async () => {
    const jsonValidator = await validator();
    const valid = await fixture();
    expect(jsonValidator.validate(valid), JSON.stringify(jsonValidator.validate.errors)).toBe(true);
  });

  it("agrees between the two authorities on the valid fixture", async () => {
    const jsonValidator = await validator();
    const valid = await fixture();
    expect(assertZodAgreement(valid, jsonValidator, documentArtifactV1Schema)).toBe(valid);
  });

  it("parses the valid fixture", async () => {
    const valid = await fixture();
    const parsed = parseDocumentArtifact(valid);
    expect(parsed.artifact_kind).toBe("document");
    expect(parsed.step).toBe("produce");
    expect(parsed.declared_inputs).toHaveLength(2);
  });

  it("rejects an absent step in both authorities (D19)", async () => {
    const { step: _step, ...withoutStep } = await fixture();
    await rejectedBoth(withoutStep);
  });

  it("rejects a sixth step value in both authorities (D19)", async () => {
    await rejectedBoth({ ...(await fixture()), step: "review" });
  });

  it("rejects a path_class other than `document` in both authorities", async () => {
    await rejectedBoth({ ...(await fixture()), path_class: "review" });
  });

  it("rejects shuffled and duplicated declared_inputs in the Zod authority (D11)", async () => {
    const valid = await fixture();
    const inputs = valid["declared_inputs"] as readonly unknown[];
    await rejectedByZodAuthority({ ...valid, declared_inputs: [...inputs].reverse() });
    await rejectedByZodAuthority({ ...valid, declared_inputs: [inputs[0], inputs[0]] });
  });

  it("rejects an unknown field in both authorities", async () => {
    await rejectedBoth({ ...(await fixture()), reviewer: "someone" });
  });
});

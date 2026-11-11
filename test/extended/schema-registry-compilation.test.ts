import { readFile, readdir } from "node:fs/promises";

import { describe, expect, it } from "vitest";

import { SCHEMA_IDS } from "../../src/contracts/versions.js";
import { createJsonSchemaValidator } from "../helpers/json-schema.js";

const SCHEMA_DIR = new URL("../../src/contracts/schemas/v1/", import.meta.url);

describe("extended schema registry validation", () => {
  it("strict-compiles every committed document against every other document", async () => {
    const files = (await readdir(SCHEMA_DIR)).filter((name) => name.endsWith(".schema.json")).sort();
    const entries = await Promise.all(files.map(async (name) => [name, JSON.parse(
      await readFile(new URL(name, SCHEMA_DIR), "utf8"),
    ) as Record<string, unknown>] as const));

    expect(new Set(entries.map(([, schema]) => schema.$id))).toEqual(new Set(Object.values(SCHEMA_IDS)));
    for (const [name, target] of entries) {
      const references = entries.filter(([otherName]) => otherName !== name).map(([, schema]) => schema);
      expect(() => createJsonSchemaValidator(target, references), name).not.toThrow();
    }
  });
});

import { readFile, readdir } from "node:fs/promises";

import { describe, expect, it } from "vitest";

import { triageCandidateSchema } from "../../src/contracts/triage.js";
import { SCHEMA_IDS } from "../../src/contracts/versions.js";
import { createJsonSchemaValidator } from "../helpers/json-schema.js";

const SCHEMA_DIR = new URL("../../src/contracts/schemas/v1/", import.meta.url);

const loadSchema = async (name: string): Promise<Record<string, unknown>> =>
  JSON.parse(await readFile(new URL(`${name}.schema.json`, SCHEMA_DIR), "utf8")) as Record<string, unknown>;

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

  it("checks composite disposition identities across JSON Schema and Zod", async () => {
    const validator = createJsonSchemaValidator(await loadSchema("triage"), [
      await loadSchema("primitives"),
      await loadSchema("path-claim"),
    ]);
    const disposition = {
      review_evidence_digest: "a".repeat(64),
      finding_id: "same-id",
      disposition: "rejected",
      rationale: "Not applicable.",
      evidence: "The finding is stale.",
    };
    const value = {
      schema_version: "1",
      task_id: "task-1",
      phase_instance: "phase-impl-2",
      step: "triage",
      subject_digest: "b".repeat(64),
      input_fingerprint: "c".repeat(64),
      current_evidence_set_digest: "d".repeat(64),
      source_evidence_digests: ["a".repeat(64)],
      dispositions: [disposition, { ...disposition }],
      accepted_count: 0,
      rejected_count: 2,
    };
    expect(validator.validate(value), JSON.stringify(validator.validate.errors)).toBe(true);
    expect(triageCandidateSchema.safeParse(value).success).toBe(false);

    const unique = {
      ...value,
      source_evidence_digests: ["a".repeat(64), "e".repeat(64)],
      dispositions: [disposition, { ...disposition, review_evidence_digest: "e".repeat(64) }],
    };
    expect(validator.assert(unique)).toEqual(expect.any(Object));
    expect(triageCandidateSchema.safeParse(unique).success).toBe(true);
  });
});

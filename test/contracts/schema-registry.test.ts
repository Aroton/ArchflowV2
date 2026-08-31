import { readFile, readdir } from "node:fs/promises";

import { describe, expect, it } from "vitest";

import {
  HAND_WRITTEN_SCHEMA_FILES,
  SCHEMA_GENERATION_GROUPS,
} from "../../src/contracts/internal/schema-generation.js";
import { SCHEMA_IDS } from "../../src/contracts/versions.js";
import * as publicContracts from "../../src/contracts/index.js";

const SCHEMA_DIR = new URL("../../src/contracts/schemas/v1/", import.meta.url);

describe("SCHEMA_IDS registry", () => {
  it("is a bijection with the 42 committed schema documents", async () => {
    const files = (await readdir(SCHEMA_DIR)).filter((name) => name.endsWith(".schema.json")).sort();
    const documents = await Promise.all(files.map(async (name) => JSON.parse(
      await readFile(new URL(name, SCHEMA_DIR), "utf8"),
    ) as { readonly $id?: unknown }));

    expect(files).toHaveLength(42);
    expect(Object.keys(SCHEMA_IDS)).toHaveLength(42);
    expect(new Set(Object.values(SCHEMA_IDS)).size).toBe(42);
    expect(new Set(documents.map((document) => document.$id))).toEqual(new Set(Object.values(SCHEMA_IDS)));
  });

  it("generates every document except the hand-written release manifest", () => {
    const generated = SCHEMA_GENERATION_GROUPS
      .flatMap((group) => group.documents)
      .filter((document) => document.migrated)
      .map((document) => document.file)
      .sort();

    expect(HAND_WRITTEN_SCHEMA_FILES).toEqual(["release-manifest"]);
    expect(generated).toHaveLength(41);
    expect(generated).not.toContain("release-manifest");
  });

  it("does not expose internal authority mint factories from the public barrel", () => {
    expect(Object.keys(publicContracts)).not.toEqual(expect.arrayContaining([
      "createTestObservationCapability",
      "createTestAuthorityLink",
      "createTestVerifiedReferencedEvidence",
      "createTestCurrentReviewSetAuthority",
      "createTestResultExpectation",
      "createReviewObservationCapability",
      "createAdjudicationObservationCapability",
      "createVerifiedEvidenceReference",
      "createRetainedEvidenceReference",
      "createTransactionAuthorityLink",
      "assertAuthenticParsedToolCall",
    ]));
  });
});

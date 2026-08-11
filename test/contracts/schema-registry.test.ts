import { readFile, readdir } from "node:fs/promises";

import { describe, expect, it } from "vitest";

import { triageCandidateSchema } from "../../src/contracts/triage.js";
import {
  HAND_WRITTEN_SCHEMA_FILES,
  SCHEMA_GENERATION_GROUPS,
} from "../../src/contracts/internal/schema-generation.js";
import { SCHEMA_IDS } from "../../src/contracts/versions.js";
import * as publicContracts from "../../src/contracts/index.js";
import { createJsonSchemaValidator } from "../helpers/json-schema.js";

/**
 * The registry fence. Staleness of the committed bytes is `check:schemas`' job; this suite pins
 * the surrounding invariants: the registry↔directory bijection, that every committed document
 * still compiles under a strict third-party validator with only the surviving `x-archflow-*`
 * keywords registered, and that the generation manifest covers exactly the directory minus the two
 * deliberately hand-written release schemas.
 */

const SCHEMA_FILES = {
  primitives: "primitives",
  phaseInstance: "phase-instance",
  workflow: "workflow",
  config: "config",
  rubric: "rubric",
  constitutionRule: "constitution-rule",
  review: "review",
  reviewEvidence: "review-evidence",
  adjudication: "adjudication",
  adjudicationEvidence: "adjudication-evidence",
  evidenceSlots: "evidence-slots",
  triage: "triage",
  supplementalReview: "supplemental-review",
  supplementalReviewRecord: "supplemental-review-record",
  gateContract: "gate-contract",
  gateDecision: "gate-decision",
  gateRequest: "gate-request",
  gateDecisionRecord: "gate-decision-record",
  activeGate: "active-gate",
  projectError: "project-error",
  protocolError: "protocol-error",
  mcpTools: "mcp-tools",
  resultExpectation: "result-expectation",
  pathClaim: "path-claim",
  releaseManifest: "release-manifest",
  releaseLegalReview: "release-legal-review",
  secretScanResult: "secret-scan-result",
  durablePrimitives: "durable-primitives",
  taskState: "task-state",
  intentReceipt: "intent-receipt",
  maintenanceRecord: "maintenance-record",
  taskInitialization: "task-initialization",
  legacyImportInitialization: "legacy-import-initialization",
  documentArtifact: "document-artifact",
  implementationOutput: "implementation-output",
  resultManifest: "result-manifest",
} as const satisfies Record<keyof typeof SCHEMA_IDS, string>;

const SCHEMA_DIR = new URL("../../src/contracts/schemas/v1/", import.meta.url);

const loadSchema = async (name: string): Promise<Record<string, unknown>> =>
  JSON.parse(await readFile(new URL(`${name}.schema.json`, SCHEMA_DIR), "utf8")) as Record<string, unknown>;

describe("SCHEMA_IDS registry", () => {
  it("is a bijection with the schema directory at 36 ids", async () => {
    const files = (await readdir(SCHEMA_DIR)).filter((name) => name.endsWith(".schema.json")).sort();
    expect(Object.keys(SCHEMA_IDS)).toHaveLength(36);
    expect(new Set(Object.values(SCHEMA_IDS)).size).toBe(36);
    expect(files).toHaveLength(36);
    expect(files).toEqual(Object.values(SCHEMA_FILES).map((stem) => `${stem}.schema.json`).sort());
    expect(Object.keys(SCHEMA_IDS).sort()).toEqual(Object.keys(SCHEMA_FILES).sort());
  });

  it("matches every committed $id and strict-compiles every committed document", async () => {
    const entries = await Promise.all(
      Object.entries(SCHEMA_FILES).map(async ([key, filename]) => [key, await loadSchema(filename)] as const),
    );

    for (const [key, target] of entries) {
      expect(target.$id).toBe(SCHEMA_IDS[key as keyof typeof SCHEMA_IDS]);
      const references = entries.filter(([otherKey]) => otherKey !== key).map(([, schema]) => schema);
      expect(() => createJsonSchemaValidator(target, references)).not.toThrow();
    }
  });

  it("generates everything except the two hand-written release schemas", async () => {
    const generated = SCHEMA_GENERATION_GROUPS
      .flatMap((group) => group.documents)
      .filter((document) => document.migrated)
      .map((document) => document.file)
      .sort();

    expect(HAND_WRITTEN_SCHEMA_FILES).toEqual(["release-manifest", "release-legal-review"]);
    for (const stem of HAND_WRITTEN_SCHEMA_FILES) {
      expect(generated).not.toContain(stem);
      const document = await loadSchema(stem);
      expect(document.$id).toBe(`urn:archflow:schema:v1:${stem}`);
    }

    const allStems = Object.values(SCHEMA_FILES).sort();
    expect([...generated, ...HAND_WRITTEN_SCHEMA_FILES].sort()).toEqual(allStems);
    expect(generated).toHaveLength(34);
  });

  it("enforces composite disposition identities through the Zod triage authority", async () => {
    // x-archflow-unique-by retired from the generated triage document; uniqueness now lives in
    // the triage schema's superRefine, so the compiled JSON Schema accepts what Zod rejects.
    const validator = createJsonSchemaValidator(await loadSchema("triage"), [await loadSchema("primitives"), await loadSchema("path-claim")]);
    const disposition = { review_evidence_digest: "a".repeat(64), finding_id: "same-id", disposition: "rejected", rationale: "Not applicable.", evidence: "The finding is stale." };
    const value = { schema_version: "1", task_id: "task-1", phase_instance: "phase-impl-2", step: "triage", subject_digest: "b".repeat(64), input_fingerprint: "c".repeat(64), current_evidence_set_digest: "d".repeat(64), source_evidence_digests: ["a".repeat(64)], dispositions: [disposition, { ...disposition }], accepted_count: 0, rejected_count: 2 };
    expect(validator.validate(value), JSON.stringify(validator.validate.errors)).toBe(true);
    expect(triageCandidateSchema.safeParse(value).success).toBe(false);
    const unique = { ...value, source_evidence_digests: ["a".repeat(64), "e".repeat(64)], dispositions: [disposition, { ...disposition, review_evidence_digest: "e".repeat(64) }] };
    expect(validator.assert(unique)).toEqual(expect.any(Object));
    expect(triageCandidateSchema.safeParse(unique).success).toBe(true);
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

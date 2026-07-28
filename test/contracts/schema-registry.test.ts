import { readFile } from "node:fs/promises";

import { describe, expect, it } from "vitest";

import { createJsonSchemaValidator } from "../../src/contracts/validators.js";
import { SCHEMA_IDS } from "../../src/contracts/versions.js";
import * as publicContracts from "../../src/contracts/index.js";

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
  evidenceReference: "evidence-reference",
  authorityLink: "authority-link",
  evidenceSlots: "evidence-slots",
  triage: "triage",
  supplementalReview: "supplemental-review",
  gateContract: "gate-contract",
  gateDecision: "gate-decision",
  projectError: "project-error",
  protocolError: "protocol-error",
  mcpTools: "mcp-tools",
  resultExpectation: "result-expectation",
  pathClaim: "path-claim",
  releaseManifest: "release-manifest",
  releaseLegalReview: "release-legal-review",
} as const satisfies Record<keyof typeof SCHEMA_IDS, string>;

const loadSchema = async (name: string): Promise<Record<string, unknown>> =>
  JSON.parse(
    await readFile(
      new URL(`../../src/contracts/schemas/v1/${name}.schema.json`, import.meta.url),
      "utf8",
    ),
  ) as Record<string, unknown>;

describe("SCHEMA_IDS registry", () => {
  it("matches every normative schema and loads each entry independently", async () => {
    const entries = await Promise.all(
      Object.entries(SCHEMA_FILES).map(async ([key, filename]) => [key, await loadSchema(filename)] as const),
    );

    expect(Object.keys(SCHEMA_IDS).sort()).toEqual(Object.keys(SCHEMA_FILES).sort());

    for (const [key, target] of entries) {
      expect(target.$id).toBe(SCHEMA_IDS[key as keyof typeof SCHEMA_IDS]);
      const references = entries.filter(([otherKey]) => otherKey !== key).map(([, schema]) => schema);
      expect(() => createJsonSchemaValidator(target, references)).not.toThrow();
    }
  });

  it("enforces composite x-archflow-unique-by identities", async () => {
    const validator = createJsonSchemaValidator(await loadSchema("triage"));
    const disposition = { review_evidence_digest: "a".repeat(64), finding_id: "same-id", disposition: "rejected", rationale: "Not applicable.", evidence: "The finding is stale." };
    const value = { schema_version: "1", task_id: "task-1", phase_instance: "phase-impl-2", step: "triage", subject_digest: "b".repeat(64), input_fingerprint: "c".repeat(64), current_evidence_set_digest: "d".repeat(64), source_evidence_digests: ["a".repeat(64)], dispositions: [disposition, { ...disposition }], accepted_count: 0, rejected_count: 2 };
    expect(() => validator.assert(value)).toThrow(/x-archflow-unique-by/iu);
    expect(validator.assert({ ...value, source_evidence_digests: ["a".repeat(64), "e".repeat(64)], dispositions: [disposition, { ...disposition, review_evidence_digest: "e".repeat(64) }] })).toEqual(expect.any(Object));
  });

  it("does not expose internal authority mint factories from the public barrel", () => {
    expect(Object.keys(publicContracts)).not.toEqual(expect.arrayContaining([
      "createTestObservationCapability",
      "createTestAuthorityLink",
      "createTestVerifiedReferencedEvidence",
      "createTestCurrentReviewSetAuthority",
      "createTestResultExpectation",
    ]));
  });
});

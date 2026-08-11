import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

import { rawAdjudicationSchema } from "../../src/contracts/adjudication.js";
import { gateInputSchema, resultExpectationDataSchema, waiverInputSchema } from "../../src/contracts/mcp-tools.js";
import { rawReviewSchema } from "../../src/contracts/review.js";
import { supplementalReviewOutcomeSchema } from "../../src/contracts/supplemental.js";
import {
  assertZodAgreement,
  createJsonSchemaValidator,
  type JsonSchemaValidator,
  type ZodLikeSchema,
} from "../../src/contracts/validators.js";

/**
 * Each custom Ajv semantic keyword must have its logic wired into the Zod side before Zod can
 * become the single shape authority. Every case pairs the compiled normative schema that carries
 * the keyword with the Zod schema chain that must reject the same violations on parse: a fixture
 * violating only the semantic rule is rejected by both authorities, and its valid counterpart is
 * accepted by both without mutation.
 */

const SCHEMA_DIR = new URL("../../src/contracts/schemas/v1/", import.meta.url);
const FIXTURE_DIR = new URL("../fixtures/contracts/", import.meta.url);

const schema = (stem: string): object => JSON.parse(readFileSync(new URL(`${stem}.schema.json`, SCHEMA_DIR), "utf8")) as object;
const fixture = (name: string): unknown => JSON.parse(readFileSync(new URL(`${name}.json`, FIXTURE_DIR), "utf8"));

const MCP_REFERENCE_STEMS = [
  "supplemental-review", "primitives", "project-error", "rubric", "path-claim", "evidence-slots",
  "gate-contract", "gate-decision", "durable-primitives", "task-state", "task-initialization",
  "legacy-import-initialization", "document-artifact", "implementation-output", "secret-scan-result",
  "review-evidence", "triage",
] as const;

const reviewValidator = createJsonSchemaValidator<unknown>(schema("review"));
const adjudicationValidator = createJsonSchemaValidator<unknown>(schema("adjudication"));
const supplementalValidator = createJsonSchemaValidator<unknown>(schema("supplemental-review"), [schema("primitives")]);
const mcpValidator = createJsonSchemaValidator<unknown>(schema("mcp-tools"), MCP_REFERENCE_STEMS.map(schema));
const expectationValidator = createJsonSchemaValidator<unknown>(schema("result-expectation"), [schema("mcp-tools"), ...MCP_REFERENCE_STEMS.map(schema)]);

type KeywordCase = {
  readonly keyword: string;
  readonly json: JsonSchemaValidator<unknown>;
  readonly zod: ZodLikeSchema<unknown>;
  readonly valid: unknown;
  readonly invalid: ReadonlyArray<readonly [violation: string, value: unknown]>;
};

const CASES: readonly KeywordCase[] = [
  {
    keyword: "x-archflow-review-summary",
    json: reviewValidator,
    zod: rawReviewSchema,
    valid: fixture("review/valid"),
    invalid: [["a summary contradicting its findings", fixture("review/invalid-summary-mismatch")]],
  },
  {
    keyword: "x-archflow-adjudication-semantics",
    json: adjudicationValidator,
    zod: rawAdjudicationSchema,
    valid: fixture("adjudication/valid"),
    invalid: [["a constitution rollup contradicting rule findings", fixture("adjudication/invalid-constitution-rollup-mismatch")]],
  },
  {
    keyword: "x-archflow-supplemental-semantics",
    json: supplementalValidator,
    zod: supplementalReviewOutcomeSchema,
    valid: fixture("supplemental/supersede-valid"),
    invalid: [["a supersession whose old subject is not the reviewed subject", fixture("supplemental/invalid-supersede-subject-mismatch")]],
  },
  {
    keyword: "x-archflow-mcp-semantics on the gate input",
    json: mcpValidator,
    zod: gateInputSchema,
    valid: fixture("mcp-tools/gate-valid"),
    invalid: [
      ["duplicate evidence digests across review slots", fixture("mcp-tools/gate-invalid-duplicate-evidence-digest")],
      ["an attempts-exhausted context below its maximum", fixture("mcp-tools/gate-invalid-attempts-below-maximum")],
    ],
  },
  {
    keyword: "x-archflow-mcp-semantics on the waiver input",
    json: mcpValidator,
    zod: waiverInputSchema,
    valid: fixture("mcp-tools/waiver-valid"),
    invalid: [["an origin bound to a different task", fixture("mcp-tools/waiver-invalid-origin-task-mismatch")]],
  },
  {
    keyword: "x-archflow-result-expectation-semantics",
    json: expectationValidator,
    zod: resultExpectationDataSchema,
    valid: fixture("mcp-tools/result-expectation-valid"),
    invalid: [["a resulting revision disagreeing with its success revision", fixture("mcp-tools/result-expectation-invalid-revision-mismatch")]],
  },
];

describe("semantic keyword parity between Ajv keywords and Zod mirrors", () => {
  for (const entry of CASES) {
    describe(entry.keyword, () => {
      it("accepts the valid fixture in both authorities without mutation", () => {
        const before = structuredClone(entry.valid);
        expect(assertZodAgreement(entry.valid, entry.json, entry.zod, entry.keyword)).toEqual(before);
        expect(entry.valid).toEqual(before);
      });

      for (const [violation, value] of entry.invalid) {
        it(`rejects ${violation} in both authorities`, () => {
          expect(entry.json.validate(value), "JSON Schema accepted the semantic violation").toBe(false);
          expect(entry.zod.safeParse(value).success, "Zod accepted the semantic violation").toBe(false);
        });
      }
    });
  }
});

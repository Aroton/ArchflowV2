import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

import { rawAdjudicationSchema } from "../../src/contracts/adjudication.js";
import { parseSha256Digest } from "../../src/contracts/evidence.js";
import { gateInputSchema, resultExpectationDataSchema, waiverInputSchema } from "../../src/contracts/mcp-tools.js";
import {
  assertZodAgreement,
  createJsonSchemaValidator,
  type JsonSchemaValidator,
  type ZodLikeSchema,
} from "../helpers/json-schema.js";
import { ordinaryApprovalFacts } from "../helpers/ordinary-approval.js";

/**
 * Each custom Ajv semantic keyword's logic is wired into the Zod side, which is now the single
 * shape authority for the generated documents. Where a document has been regenerated its custom
 * keyword is retired from the committed schema (`jsonKeywordRetired: true`): the compiled schema
 * accepts the semantic violation and only Zod rejects it. The generated `mcp-tools` document
 * deliberately re-emits `x-archflow-mcp-semantics` on its root via `.meta`, so it keeps keyword
 * parity: both authorities reject. Valid fixtures are accepted by both authorities without
 * mutation in every case.
 */

const SCHEMA_DIR = new URL("../../src/contracts/schemas/v1/", import.meta.url);
const FIXTURE_DIR = new URL("../fixtures/contracts/", import.meta.url);

const schema = (stem: string): object => JSON.parse(readFileSync(new URL(`${stem}.schema.json`, SCHEMA_DIR), "utf8")) as object;
const fixture = (name: string): unknown => JSON.parse(readFileSync(new URL(`${name}.json`, FIXTURE_DIR), "utf8"));
const ordinaryGateFixture = (name: string): unknown => {
  const value = fixture(name) as Record<string, unknown>;
  return {
    ...value,
    context: {
      ...(value.context as Record<string, unknown>),
      ...ordinaryApprovalFacts("phase-impl", parseSha256Digest(value.subject_digest)),
    },
  };
};
const adjudicationOutput = (value: unknown): Record<string, unknown> => {
  const { constitution: _constitution, drift: _drift, matched_rule_versions: _matched, uncertain_rule_versions: _uncertain, ...output } = value as Record<string, unknown>;
  return output;
};

const MCP_REFERENCE_STEMS = [
  "primitives", "project-error", "rubric", "path-claim", "evidence-slots",
  "gate-contract", "gate-decision", "durable-primitives", "task-state", "task-initialization",
  "legacy-import-initialization", "document-artifact", "implementation-output", "secret-scan-result",
  "review", "review-evidence", "adjudication", "triage",
] as const;

const sharedReferences = [schema("primitives"), schema("path-claim")];
const adjudicationValidator = createJsonSchemaValidator<unknown>(schema("adjudication"), sharedReferences);
const mcpValidator = createJsonSchemaValidator<unknown>(schema("mcp-tools"), MCP_REFERENCE_STEMS.map(schema));
const expectationValidator = createJsonSchemaValidator<unknown>(schema("result-expectation"), [schema("mcp-tools"), ...MCP_REFERENCE_STEMS.map(schema)]);

type KeywordCase = {
  readonly keyword: string;
  readonly json: JsonSchemaValidator<unknown>;
  readonly zod: ZodLikeSchema<unknown>;
  /** True once the keyword's document is generated: the committed schema no longer carries it. */
  readonly jsonKeywordRetired: boolean;
  readonly valid: unknown;
  readonly invalid: ReadonlyArray<readonly [violation: string, value: unknown]>;
};

const CASES: readonly KeywordCase[] = [
  {
    keyword: "x-archflow-adjudication-semantics",
    json: adjudicationValidator,
    zod: rawAdjudicationSchema,
    jsonKeywordRetired: true,
    valid: adjudicationOutput(fixture("adjudication/valid")),
    invalid: [["duplicate rule findings", (() => {
      const value = adjudicationOutput(fixture("adjudication/valid"));
      return { ...value, rule_findings: [...value.rule_findings as unknown[], ...value.rule_findings as unknown[]] };
    })()]],
  },
  {
    keyword: "x-archflow-mcp-semantics on the gate input",
    json: mcpValidator,
    zod: gateInputSchema,
    jsonKeywordRetired: false,
    valid: ordinaryGateFixture("mcp-tools/gate-valid"),
    invalid: [
      ["duplicate evidence digests across review slots", ordinaryGateFixture("mcp-tools/gate-invalid-duplicate-evidence-digest")],
      ["an attempts-exhausted context below its maximum", fixture("mcp-tools/gate-invalid-attempts-below-maximum")],
    ],
  },
  {
    keyword: "x-archflow-mcp-semantics on the waiver input",
    json: mcpValidator,
    zod: waiverInputSchema,
    jsonKeywordRetired: false,
    valid: fixture("mcp-tools/waiver-valid"),
    invalid: [["an origin bound to a different task", fixture("mcp-tools/waiver-invalid-origin-task-mismatch")]],
  },
  {
    keyword: "x-archflow-result-expectation-semantics",
    json: expectationValidator,
    zod: resultExpectationDataSchema,
    jsonKeywordRetired: true,
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
        if (entry.jsonKeywordRetired) {
          it(`rejects ${violation} through the Zod authority alone`, () => {
            expect(entry.json.validate(value), "the generated schema no longer carries the retired keyword").toBe(true);
            expect(entry.zod.safeParse(value).success, "Zod accepted the semantic violation").toBe(false);
          });
        } else {
          it(`rejects ${violation} in both authorities`, () => {
            expect(entry.json.validate(value), "JSON Schema accepted the semantic violation").toBe(false);
            expect(entry.zod.safeParse(value).success, "Zod accepted the semantic violation").toBe(false);
          });
        }
      }
    });
  }
});

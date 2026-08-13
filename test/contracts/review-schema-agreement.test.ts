import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import { adjudicationEvidenceSchema, rawAdjudicationSchema } from "../../src/contracts/adjudication.js";
import { rawReviewSchema, reviewEvidenceSchema } from "../../src/contracts/review.js";
import { assertZodAgreement, createJsonSchemaValidator } from "../helpers/json-schema.js";

const json = async (url: URL) => JSON.parse(await readFile(url, "utf8")) as unknown;
const adjudicationOutput = (value: unknown): unknown => {
  const { constitution: _constitution, drift: _drift, matched_rule_versions: _matched, uncertain_rule_versions: _uncertain, ...output } = value as Record<string, unknown>;
  return output;
};
const schema = async (name: string) => await json(new URL(`../../src/contracts/schemas/v1/${name}.schema.json`, import.meta.url)) as object;
/** The generated evidence documents reference the raw review and adjudication documents by URI. */
const referenceStems = ["primitives", "path-claim", "review", "adjudication"] as const;
const validator = async (name: string) =>
  createJsonSchemaValidator(await schema(name), await Promise.all(referenceStems.filter((stem) => stem !== name).map(schema)));
describe("review and adjudication schema agreement", () => {
  it("accepts the same review corpus without mutation", async () => { const value = await json(new URL("../fixtures/contracts/review/valid.json", import.meta.url)); const before = structuredClone(value); expect(assertZodAgreement(value, await validator("review"), rawReviewSchema)).toBe(value); expect(value).toEqual(before); });
  it("accepts the reduced adjudication output without mutation", async () => { const value = adjudicationOutput(await json(new URL("../fixtures/contracts/adjudication/valid.json", import.meta.url))); const before = structuredClone(value); expect(assertZodAgreement(value, await validator("adjudication"), rawAdjudicationSchema)).toEqual(value); expect(value).toEqual(before); });
  it("rejects closed-shape substitutions", async () => { const value = await json(new URL("../fixtures/contracts/review/valid.json", import.meta.url)) as Record<string, unknown>; const reviewValidator = await validator("review"); expect(() => assertZodAgreement({ ...value, authority: true }, reviewValidator, rawReviewSchema)).toThrow(); });

  it("agrees across every evidence variant without mutation", async () => {
    const review = await json(new URL("../fixtures/contracts/review/valid.json", import.meta.url)) as Record<string, unknown>;
    const adjudication = await json(new URL("../fixtures/contracts/adjudication/valid.json", import.meta.url)) as Record<string, unknown>;
    const reviewValidator = await validator("review-evidence");
    const adjudicationValidator = await validator("adjudication-evidence");
    const variants = [
      [reviewValidator, reviewEvidenceSchema, { ...review, assurance: "degraded", model_family: "unknown", model: "unknown", effort: "unknown", reason: "Manual fallback." }],
      [reviewValidator, reviewEvidenceSchema, { ...review, assurance: "server-attested", adapter: "codex-cli", cli_version: "1.0.0", model_family: "codex", model: "gpt-5", effort: "high", invocation_id: "invocation-1", envelope_input_digest: "d".repeat(64), observed_output_digest: "e".repeat(64), result_id: "result-1" }],
      [adjudicationValidator, adjudicationEvidenceSchema, { ...adjudication, assurance: "agent-declared", model_family: "unknown", model: "unknown", effort: "unknown" }],
      [adjudicationValidator, adjudicationEvidenceSchema, { ...adjudication, assurance: "degraded", model_family: "unknown", model: "unknown", effort: "unknown", reason: "Manual fallback." }],
      [adjudicationValidator, adjudicationEvidenceSchema, { ...adjudication, assurance: "server-attested", adapter: "codex-cli", cli_version: "1.0.0", model_family: "codex", model: "gpt-5", effort: "high", invocation_id: "invocation-1", envelope_input_digest: "d".repeat(64), observed_output_digest: "e".repeat(64), result_id: "result-1" }],
    ] as const;

    for (const [jsonValidator, mirror, value] of variants) {
      const before = structuredClone(value);
      expect(jsonValidator.validate(value), JSON.stringify(jsonValidator.validate.errors)).toBe(true);
      expect(assertZodAgreement(value, jsonValidator, mirror, String(value.assurance))).toBe(value);
      expect(value).toEqual(before);
    }
  });

  it("rejects cross-family, cross-assurance, and nested closed-shape substitutions", async () => {
    const review = await json(new URL("../fixtures/contracts/review/valid.json", import.meta.url)) as Record<string, unknown>;
    const adjudication = await json(new URL("../fixtures/contracts/adjudication/valid.json", import.meta.url)) as Record<string, unknown>;
    const reviewValidator = await validator("review-evidence");
    const adjudicationValidator = await validator("adjudication-evidence");
    const declaredReview = { ...review, assurance: "degraded", reason: "Manual fallback.", model_family: "unknown", model: "unknown", effort: "unknown" };
    const declaredAdjudication = { ...adjudication, assurance: "agent-declared", model_family: "unknown", model: "unknown", effort: "unknown" };
    const finding = (review.findings as Array<Record<string, unknown>>)[0]!;

    expect(() => reviewValidator.assert(declaredAdjudication)).toThrow();
    expect(() => adjudicationValidator.assert(declaredReview)).toThrow();
    expect(() => assertZodAgreement({ ...declaredReview, adapter: "codex-cli" }, reviewValidator, reviewEvidenceSchema)).toThrow();
    expect(() => assertZodAgreement({ ...declaredAdjudication, reason: "degraded-only" }, adjudicationValidator, adjudicationEvidenceSchema)).toThrow();
    expect(() => assertZodAgreement({ ...review, assurance: "agent-declared", model_family: "unknown", model: "unknown", effort: "unknown" }, reviewValidator, reviewEvidenceSchema)).toThrow();
    expect(() => assertZodAgreement({ ...declaredReview, findings: [{ ...finding, internal_authority: true }] }, reviewValidator, reviewEvidenceSchema)).toThrow();
  });

  it("rejects wrong role and step in both authorities", async () => {
    const review = await json(new URL("../fixtures/contracts/review/valid.json", import.meta.url)) as Record<string, unknown>;
    const evidenceValidator = await validator("review-evidence");
    const base = { ...review, assurance: "degraded", reason: "Manual fallback.", model_family: "unknown", model: "unknown", effort: "unknown" };
    for (const value of [{ ...base, role: "self-review" }, { ...base, step: "self_review" }]) {
      expect(evidenceValidator.validate(value)).toBe(false);
      expect(reviewEvidenceSchema.safeParse(value).success).toBe(false);
    }
  });

  it("rejects duplicate IDs, same-family attestation, and review contradictions in the Zod authority", async () => {
    // The x-archflow-review-summary keyword, the unique-by finding rule, and the opposite-family
    // conditional retired from the generated document; the Zod source is the surviving authority
    // for these, so the compiled JSON Schema now accepts what Zod still rejects.
    const review = await json(new URL("../fixtures/contracts/review/valid.json", import.meta.url)) as Record<string, unknown>;
    const evidenceValidator = await validator("review-evidence");
    const base = { ...review, assurance: "degraded", reason: "Manual fallback.", model_family: "unknown", model: "unknown", effort: "unknown" };
    const server = { ...review, assurance: "server-attested", adapter: "codex-cli", cli_version: "1", model_family: "codex", model: "gpt", effort: "high", invocation_id: "invocation-1", envelope_input_digest: "d".repeat(64), observed_output_digest: "e".repeat(64), result_id: "result-1" };
    const cases = [
      { ...base, findings: [...(review.findings as unknown[]), ...(review.findings as unknown[])] },
      { ...server, model_family: "claude" },
      { ...base, verdict: "pass" },
      { ...base, blocking_count: 2 },
    ];
    for (const value of cases) {
      expect(evidenceValidator.validate(value), JSON.stringify(evidenceValidator.validate.errors)).toBe(true);
      expect(reviewEvidenceSchema.safeParse(value).success).toBe(false);
    }
  });

  it("admits no per-mechanism attestation on a rule finding in either authority", async () => {
    // A rule's enforced_by labels are reviewer context and never come back as a finding field.
    // Reporting per-mechanism state is what once made a rule declaring them permanently uncertain,
    // so both the portable document and the Zod authority must refuse to carry it at all.
    const adjudication = await json(new URL("../fixtures/contracts/adjudication/valid.json", import.meta.url)) as Record<string, unknown>;
    const evidenceValidator = await validator("adjudication-evidence");
    const finding = structuredClone((adjudication.rule_findings as Array<Record<string, unknown>>)[0]!);
    expect(finding).not.toHaveProperty("enforced_by");
    const base = { ...adjudication, assurance: "agent-declared", model_family: "unknown", model: "unknown", effort: "unknown" };
    expect(evidenceValidator.validate(base), JSON.stringify(evidenceValidator.validate.errors)).toBe(true);
    expect(adjudicationEvidenceSchema.safeParse(base).success).toBe(true);
    const attested = { ...base, rule_findings: [{ ...finding, enforced_by: [{ mechanism: "path-contract", state: "unknown", details: "Unavailable." }] }] };
    expect(evidenceValidator.validate(attested)).toBe(false);
    expect(adjudicationEvidenceSchema.safeParse(attested).success).toBe(false);
  });
});

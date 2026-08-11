import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import { adjudicationEvidenceSchema, rawAdjudicationSchema } from "../../src/contracts/adjudication.js";
import { rawReviewSchema, reviewEvidenceSchema } from "../../src/contracts/review.js";
import { assertZodAgreement, createJsonSchemaValidator } from "../../src/contracts/validators.js";

const json = async (url: URL) => JSON.parse(await readFile(url, "utf8")) as unknown;
const schema = async (name: string) => await json(new URL(`../../src/contracts/schemas/v1/${name}.schema.json`, import.meta.url)) as object;
describe("review and adjudication schema agreement", () => {
  it("accepts the same review corpus without mutation", async () => { const value = await json(new URL("../fixtures/contracts/review/valid.json", import.meta.url)); const before = structuredClone(value); expect(assertZodAgreement(value, createJsonSchemaValidator(await schema("review")), rawReviewSchema)).toBe(value); expect(value).toEqual(before); });
  it("accepts the same adjudication corpus without mutation", async () => { const value = await json(new URL("../fixtures/contracts/adjudication/valid.json", import.meta.url)); const before = structuredClone(value); expect(assertZodAgreement(value, createJsonSchemaValidator(await schema("adjudication")), rawAdjudicationSchema)).toBe(value); expect(value).toEqual(before); });
  it("rejects closed-shape substitutions", async () => { const value = await json(new URL("../fixtures/contracts/review/valid.json", import.meta.url)) as Record<string, unknown>; const validator = createJsonSchemaValidator(await schema("review")); expect(() => assertZodAgreement({ ...value, authority: true }, validator, rawReviewSchema)).toThrow(); });

  it("agrees across every evidence variant without mutation", async () => {
    const review = await json(new URL("../fixtures/contracts/review/valid.json", import.meta.url)) as Record<string, unknown>;
    const adjudication = await json(new URL("../fixtures/contracts/adjudication/valid.json", import.meta.url)) as Record<string, unknown>;
    const reviewValidator = createJsonSchemaValidator(await schema("review-evidence"));
    const adjudicationValidator = createJsonSchemaValidator(await schema("adjudication-evidence"));
    const variants = [
      [reviewValidator, reviewEvidenceSchema, { ...review, assurance: "degraded", model_family: "unknown", model: "unknown", effort: "unknown", reason: "Manual fallback." }],
      [reviewValidator, reviewEvidenceSchema, { ...review, assurance: "server-attested", adapter: "codex-cli", cli_version: "1.0.0", model_family: "codex", model: "gpt-5", effort: "high", invocation_id: "invocation-1", envelope_input_digest: "d".repeat(64), observed_output_digest: "e".repeat(64), result_id: "result-1" }],
      [adjudicationValidator, adjudicationEvidenceSchema, { ...adjudication, assurance: "agent-declared", model_family: "unknown", model: "unknown", effort: "unknown" }],
      [adjudicationValidator, adjudicationEvidenceSchema, { ...adjudication, assurance: "degraded", model_family: "unknown", model: "unknown", effort: "unknown", reason: "Manual fallback." }],
      [adjudicationValidator, adjudicationEvidenceSchema, { ...adjudication, assurance: "server-attested", adapter: "codex-cli", cli_version: "1.0.0", model_family: "codex", model: "gpt-5", effort: "high", invocation_id: "invocation-1", envelope_input_digest: "d".repeat(64), observed_output_digest: "e".repeat(64), result_id: "result-1" }],
    ] as const;

    for (const [validator, mirror, value] of variants) {
      const before = structuredClone(value);
      expect(validator.validate(value), JSON.stringify(validator.validate.errors)).toBe(true);
      expect(assertZodAgreement(value, validator, mirror, String(value.assurance))).toBe(value);
      expect(value).toEqual(before);
    }
  });

  it("rejects cross-family, cross-assurance, and nested closed-shape substitutions", async () => {
    const review = await json(new URL("../fixtures/contracts/review/valid.json", import.meta.url)) as Record<string, unknown>;
    const adjudication = await json(new URL("../fixtures/contracts/adjudication/valid.json", import.meta.url)) as Record<string, unknown>;
    const reviewValidator = createJsonSchemaValidator(await schema("review-evidence"));
    const adjudicationValidator = createJsonSchemaValidator(await schema("adjudication-evidence"));
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

  it("agrees on duplicate IDs, role/step, opposite family, and review contradictions", async () => {
    const review = await json(new URL("../fixtures/contracts/review/valid.json", import.meta.url)) as Record<string, unknown>;
    const validator = createJsonSchemaValidator(await schema("review-evidence"));
    const base = { ...review, assurance: "degraded", reason: "Manual fallback.", model_family: "unknown", model: "unknown", effort: "unknown" };
    const server = { ...review, assurance: "server-attested", adapter: "codex-cli", cli_version: "1", model_family: "codex", model: "gpt", effort: "high", invocation_id: "invocation-1", envelope_input_digest: "d".repeat(64), observed_output_digest: "e".repeat(64), result_id: "result-1" };
    const cases = [
      { ...base, findings: [...(review.findings as unknown[]), ...(review.findings as unknown[])] },
      { ...base, role: "self-review" },
      { ...base, step: "self_review" },
      { ...server, model_family: "claude" },
      { ...base, verdict: "pass" },
      { ...base, blocking_count: 2 },
    ];
    for (const value of cases) { expect(validator.validate(value)).toBe(false); expect(reviewEvidenceSchema.safeParse(value).success).toBe(false); }
  });

  it("agrees that empty mechanical pass evidence is structural while mixed and wrong-subject evidence fail", async () => {
    const adjudication = await json(new URL("../fixtures/contracts/adjudication/valid.json", import.meta.url)) as Record<string, unknown>;
    const validator = createJsonSchemaValidator(await schema("adjudication-evidence"));
    const finding = structuredClone((adjudication.rule_findings as Array<Record<string, unknown>>)[0]!);
    const current = structuredClone((finding.enforced_by as Array<Record<string, unknown>>)[0]!);
    const base = { ...adjudication, assurance: "agent-declared", model_family: "unknown", model: "unknown", effort: "unknown" };
    const empty = { ...base, rule_findings: [{ ...finding, enforced_by: [] }] };
    expect(validator.validate(empty), JSON.stringify(validator.validate.errors)).toBe(true);
    expect(adjudicationEvidenceSchema.safeParse(empty).success).toBe(true);
    const cases = [
      { ...base, rule_findings: [{ ...finding, enforced_by: [current, { mechanism: "manual", state: "unknown", details: "Unavailable." }] }] },
      { ...base, rule_findings: [{ ...finding, enforced_by: [{ ...current, subject_digest: "0".repeat(64) }] }] },
    ];
    for (const value of cases) { expect(validator.validate(value), JSON.stringify(validator.validate.errors)).toBe(false); expect(adjudicationEvidenceSchema.safeParse(value).success).toBe(false); }
  });
});

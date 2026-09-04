import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import {
  createGeneralReviewOutputV3Schema,
  createTestReviewOutputV3Schema,
  parseAndDeriveReview,
  parseReferencedReviewEvidence,
  parseReviewEvidence,
} from "../../src/contracts/review.js";

const fixture = async (name: string) => JSON.parse(await readFile(new URL(`../fixtures/contracts/review/${name}`, import.meta.url), "utf8")) as unknown;
describe("review semantics", () => {
  it("checks exact verdict and count without mutating raw claims", async () => { const value = await fixture("valid-v1.json"); const invalid = await fixture("invalid-contradiction.json"); const before = structuredClone(value); expect(parseAndDeriveReview(value).verdict).toBe("fail"); expect(value).toEqual(before); expect(() => parseAndDeriveReview(invalid)).toThrow(/blocking_count/); });
  it("keeps provenance variants closed and rejects the retired agent-declared arm", async () => { const review = await fixture("valid-v1.json") as Record<string, unknown>; const degraded = { ...review, assurance: "degraded", reason: "manual fallback", model_family: "unknown", model: "unknown", effort: "unknown" }; expect(parseReviewEvidence(degraded).assurance).toBe("degraded"); expect(() => parseReviewEvidence({ ...degraded, adapter: "codex-cli" })).toThrow(); expect(() => parseReviewEvidence({ ...review, assurance: "agent-declared", model_family: "unknown", model: "unknown", effort: "unknown" })).toThrow(); const sameFamily = parseReviewEvidence({ ...review, assurance: "server-attested", adapter: "claude-cli", cli_version: "1", model_family: "claude", model: "claude", effort: "high", invocation_id: "invocation-1", envelope_input_digest: "d".repeat(64), observed_output_digest: "e".repeat(64), result_id: "result-1" }); expect(sameFamily.model_family).toBe(sameFamily.producer_family); });
  it("composes evidence and referenced-evidence parsing through all raw semantics", async () => { const review = await fixture("valid-v1.json") as Record<string, unknown>; const degraded = { ...review, assurance: "degraded", reason: "manual fallback", model_family: "unknown", model: "unknown", effort: "unknown" }; const duplicate = { ...degraded, findings: [...(review.findings as unknown[]), ...(review.findings as unknown[])] }; expect(() => parseReviewEvidence(duplicate)).toThrow(/duplicate finding_id/); expect(() => parseReferencedReviewEvidence({ evidence_digest: "d".repeat(64), evidence: duplicate })).toThrow(/duplicate finding_id/); expect(() => parseReviewEvidence({ ...degraded, verdict: "pass" })).toThrow(/verdict/); expect(() => parseReviewEvidence({ ...degraded, role: "self-review" })).toThrow(); expect(() => parseReviewEvidence({ ...degraded, step: "self_review" })).toThrow(); });
  it("retains contributor provenance and requires reviewer runs to partition findings", async () => {
    const review = await fixture("valid-v1.json") as Record<string, unknown>;
    const run = {
      reviewer_id: "test", focus: "tests", routing_role: "test-reviewer",
      criterion_ids: ["test-quality"], rubric_digest: "c".repeat(64),
      model_family: "codex", model: "gpt-5.6-luna", effort: "max", adapter: "codex-cli",
      cli_version: "1.2.3", invocation_id: "invocation-test", envelope_input_digest: "d".repeat(64),
      observed_output_digest: "e".repeat(64), finding_ids: ["unsafe-path"],
      route_source: { provenance: "configured" },
    };
    const attested = {
      ...review, assurance: "server-attested", adapter: "codex-cli", cli_version: "1.2.3",
      model_family: "codex", model: "gpt-5.6-sol", effort: "xhigh", invocation_id: "invocation-general",
      envelope_input_digest: "f".repeat(64), observed_output_digest: "0".repeat(64), result_id: "result-general",
      reviewer_runs: [run],
    };
    expect(parseReviewEvidence(attested)).toMatchObject({ reviewer_runs: [{ reviewer_id: "test" }] });
    expect(() => parseReviewEvidence({ ...attested, reviewer_runs: [{ ...run, finding_ids: [] }] }))
      .toThrow(/partition review findings exactly/);
    expect(() => parseReviewEvidence({ ...attested, reviewer_runs: [run, { ...run }] }))
      .toThrow(/reviewer run ids must be unique/);
  });

  it("keeps fresh general and test child findings in separate exact criterion shapes", () => {
    const common = {
      schema_version: "3", task_id: "mcp-integration", phase_instance: "phase-impl-1",
      step: "counter_review", role: "counter-review", subject_digest: "a".repeat(64),
      input_fingerprint: "b".repeat(64), rubric_digest: "c".repeat(64), producer_family: "claude",
    } as const;
    const generalFinding = {
      finding_id: "unsafe-path", criterion_id: "correctness", claim_type: "defect", confidence: "certain",
      falsifier: "Prove the path remains confined.", summary: "Path escapes.", evidence: "Traversal is accepted.",
      suggested_resolution: "Reject traversal.",
    } as const;
    const general = createGeneralReviewOutputV3Schema({ criterion_ids: ["correctness"], expected_upstream_digests: [] });
    expect(general.parse({ ...common, findings: [generalFinding], upstream_alignment: [] })).toMatchObject({ findings: [generalFinding] });
    expect(() => general.parse({ ...common, findings: [{ ...generalFinding, criterion_id: "test-quality" }], upstream_alignment: [] })).toThrow();
    expect(() => general.parse({ ...common, findings: [{ ...generalFinding, consequence: "Hidden test detail." }], upstream_alignment: [] })).toThrow();
    expect(() => general.parse({ ...common, findings: [{ ...generalFinding, reviewer_id: "general" }], upstream_alignment: [] })).toThrow();

    const testFinding = {
      finding_id: "missing-oracle", criterion_id: "test-quality", claim_type: "gap", confidence: "likely",
      falsifier: "Show an assertion that detects the bad result.", required_behavior_or_risk_boundary: "Reject traversal.",
      coverage_or_oracle_problem: "The test has no rejection assertion.", consequence: "Traversal can regress silently.",
      proposed_verification_change: "Assert the rejection and unchanged filesystem.",
    } as const;
    const tests = createTestReviewOutputV3Schema({ criterion_ids: ["test-quality"] });
    expect(tests.parse({ ...common, findings: [testFinding] })).toMatchObject({ findings: [testFinding] });
    expect(() => tests.parse({ ...common, findings: [{ ...testFinding, suggested_resolution: "Change production code." }] })).toThrow();
  });

  it("treats a present empty upstream plan as an exact alignment responsibility", () => {
    const schema = createGeneralReviewOutputV3Schema({ criterion_ids: [], expected_upstream_digests: [] });
    const common = {
      schema_version: "3", task_id: "mcp-integration", phase_instance: "design", step: "counter_review",
      role: "counter-review", subject_digest: "a".repeat(64), input_fingerprint: "b".repeat(64),
      rubric_digest: "c".repeat(64), producer_family: "claude", findings: [],
    } as const;
    expect(schema.parse({ ...common, upstream_alignment: [] })).toEqual({ ...common, upstream_alignment: [] });
    expect(() => schema.parse(common)).toThrow();
    expect(() => createGeneralReviewOutputV3Schema({ criterion_ids: [] })).toThrow(/requires criteria/u);
  });
});

import { readFile } from "node:fs/promises";

import { describe, expect, it } from "vitest";

import {
  expectedReviewSummaryV2,
  parseAndDeriveReview,
  parseReviewEvidence,
  type ReviewFindingV2,
} from "../../src/contracts/review.js";

const digest = (character: string) => character.repeat(64);
const v2Finding: ReviewFindingV2 = {
  finding_id: "unsafe-path", claim_type: "defect", confidence: "certain",
  falsifier: "Inspect path normalization and demonstrate that traversal stays within the task root.",
  summary: "Path is unsafe.", evidence: "The path escapes its task.", suggested_resolution: "Reject traversal.",
};
const v2Raw = () => ({
  schema_version: "2" as const, task_id: "mcp-integration", phase_instance: "phase-impl-2",
  step: "counter_review" as const, role: "counter-review" as const,
  subject_digest: digest("a"), input_fingerprint: digest("b"), rubric_digest: digest("c"),
  producer_family: "claude" as const, findings: [v2Finding], matched_rule_versions: [],
  ...expectedReviewSummaryV2([v2Finding]),
});
const provenance = { model_family: "codex" as const, model: "gpt-5", effort: "high" as const };
const attestation = {
  assurance: "server-attested" as const, adapter: "codex-cli" as const, cli_version: "1.0.0",
  invocation_id: "invocation-1", envelope_input_digest: digest("d"), observed_output_digest: digest("e"), result_id: "result-1",
};

describe("archived review compatibility", () => {
  it("preserves the archived V1 record without normalization", async () => {
    const bytes = await readFile(new URL("../fixtures/contracts/review/valid-v1.json", import.meta.url), "utf8");
    const archived = JSON.parse(bytes) as unknown;
    const before = structuredClone(archived);
    const parsed = parseAndDeriveReview(archived);
    expect(parsed).toEqual(archived);
    expect(archived).toEqual(before);
    expect(parsed.schema_version).toBe("1");
  });

  it("reads all four version and assurance arms without crossing shapes", async () => {
    const v1 = JSON.parse(await readFile(new URL("../fixtures/contracts/review/valid-v1.json", import.meta.url), "utf8")) as Record<string, unknown>;
    const variants = [
      { ...v1, ...provenance, ...attestation },
      { ...v1, ...provenance, assurance: "degraded", reason: "Manual fallback." },
      { ...v2Raw(), ...provenance, ...attestation },
      { ...v2Raw(), ...provenance, assurance: "degraded", reason: "Manual fallback." },
    ];
    for (const value of variants) expect(parseReviewEvidence(value)).toEqual(value);
    expect(() => parseReviewEvidence({ ...variants[0], schema_version: "2" })).toThrow();
    expect(() => parseReviewEvidence({ ...variants[2], schema_version: "1" })).toThrow();
  });

  it("trusts archived attested V2 summaries but rejects degraded contradictions", () => {
    const contradiction = { ...v2Raw(), verdict: "pass", total_findings: 0 };
    expect(parseReviewEvidence({ ...contradiction, ...provenance, ...attestation })).toMatchObject({ verdict: "pass", total_findings: 0 });
    expect(() => parseReviewEvidence({ ...contradiction, ...provenance, assurance: "degraded", reason: "Manual fallback." })).toThrow();
  });
});

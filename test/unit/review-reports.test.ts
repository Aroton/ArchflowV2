import { describe, expect, it } from "vitest";
import { canonicalJsonDigest } from "../../src/contracts/canonical.js";
import { parseSha256Digest, parseTaskSlug } from "../../src/contracts/evidence.js";
import { createTestObservationCapability } from "../../src/contracts/internal/test-capabilities.js";
import { parseReviewEvidence, readableReviewReport } from "../../src/contracts/review.js";
import { observationSource, type ObservationBindingByKind } from "../../src/contracts/trust.js";
import { projectCliOutputSchema } from "../../src/dispatch/cli.js";

const digest = (value: string) => parseSha256Digest(value.repeat(64));
const binding: ObservationBindingByKind["review"] = {
  kind: "review", task_id: parseTaskSlug("reports"), phase_instance: "phase-impl-1" as never,
  role: "counter-review", subject_digest: digest("a"), input_fingerprint: digest("b"),
  rubric_digest: digest("c"), producer_family: "codex", invocation_id: "review-1",
  result_id: "result-1", envelope_input_digest: digest("d"), adapter: "claude-cli",
  cli_version: "2.1.220", family: "claude", model: "claude-fable-5-1", effort: "medium",
  route_source: { provenance: "configured" }, repositories: [{ name: "primary", repository_identity_digest: digest("e"), commit: "a".repeat(40) as never }],
  assignment: { report_format: true, reviewer_id: "general", focus: "general", routing_role: "counter-reviewer", criterion_ids: ["correctness"] },
};
function observe(value: unknown) {
  return observationSource.observeReview(createTestObservationCapability(binding), new TextEncoder().encode(JSON.stringify(value)));
}

describe("explicit reviewer feedback", () => {
  it.each(["issues_found", "no_issues_found"] as const)("preserves the explicit %s outcome with server-owned provenance", outcome => {
    const feedback = outcome === "issues_found" ? "src/retry.ts:12 can charge twice on retry." : "Reviewed the changes; no actionable issues remain.";
    const result = observe({ outcome, feedback });
    expect(result.evidence.schema_version).toBe("5");
    if (result.evidence.schema_version !== "5") throw new Error("expected feedback");
    expect(result.evidence.reports[0]).toMatchObject({ outcome, feedback, reviewer_id: "general", model: "claude-fable-5-1", subject_digest: digest("a") });
    expect(parseReviewEvidence(result.evidence)).toEqual(result.evidence);
    expect(Object.isFrozen(result.evidence.reports[0])).toBe(true);
    expect(result.evidence).not.toHaveProperty("verdict");
    expect(result.evidence).not.toHaveProperty("findings");
    const forged = { ...result.evidence, reports: [{ ...result.evidence.reports[0], reviewer_id: "forged" }] };
    expect(() => parseReviewEvidence(forged)).toThrow(/dispatched reviewers/);
    expect(canonicalJsonDigest(result.evidence)).toMatch(/^[a-f0-9]{64}$/);
  });

  it.each([
    { outcome: "no_issues_found", feedback: " " },
    { outcome: "issues_found", feedback: "" },
    { feedback: "No issues found" },
    { report: "No issues found" },
    { outcome: "approved", feedback: "Good" },
    { outcome: "no_issues_found", feedback: "Good", task_id: "forged" },
    { outcome: "no_issues_found", feedback: "Good", usage: { output_tokens: 0 } },
    { findings: [] }, [], "No issues found", null,
  ])("never treats absent, ambiguous or model-authored authority as signoff: %j", value => {
    expect(() => observe(value)).toThrow();
  });

  it("retains CLI measurements supplied by the server without asking the model to repeat them", () => {
    const usage = { output_tokens: 30, thinking_tokens: 20, num_turns: 2, total_cost_usd: 0.001 };
    const result = observationSource.observeReview(createTestObservationCapability({ ...binding, usage }),
      new TextEncoder().encode(JSON.stringify({ outcome: "no_issues_found", feedback: "Reviewed; no issues." })));
    expect(result.evidence).toMatchObject({ schema_version: "5", reports: [{ usage }] });
  });

  it("keeps V4 archives readable without inventing an outcome", () => {
    const current = observe({ outcome: "no_issues_found", feedback: "No concerns." }).evidence;
    if (current.schema_version !== "5") throw new Error("expected feedback");
    const { outcome: _outcome, feedback, ...provenance } = current.reports[0]!;
    const archived = parseReviewEvidence({ ...current, schema_version: "4", reports: [{ ...provenance, report: feedback }] });
    expect(archived.schema_version).toBe("4");
    if (archived.schema_version !== "4") throw new Error("expected archive");
    expect(archived.reports[0]).not.toHaveProperty("outcome");
    const followUp = parseReviewEvidence({ ...current, previous_reports: archived.reports });
    expect(followUp).toMatchObject({ schema_version: "5", previous_reports: [{ report: "No concerns." }] });
    expect(readableReviewReport({ report: archived.reports[0]!.report })).toBe("No concerns.");
  });

  it("rejects broken JSON", () => {
    expect(() => observationSource.observeReview(createTestObservationCapability(binding), new TextEncoder().encode("{broken"))).toThrow();
  });

  it.each(["claude-cli", "codex-cli", "antigravity-cli"] as const)("advertises explicit feedback with a plain root for %s", adapter => {
    const projected = projectCliOutputSchema({}, "review", adapter, {}, { reviewer_id: "test", focus: "tests", criterion_ids: ["test-quality"] });
    expect(projected).toMatchObject({ type: "object", properties: { outcome: { enum: ["issues_found", "no_issues_found"] }, feedback: { type: "string" } }, required: ["outcome", "feedback"] });
    expect(projected).not.toHaveProperty("oneOf");
    expect(projected).not.toHaveProperty("$schema");
  });
});

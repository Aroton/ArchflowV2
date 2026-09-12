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

describe("readable reviewer reports", () => {
  it.each([
    { report: "No consequential concerns." },
    { findings: [{ severity: "major", text: "Check the retry path." }], extra: true },
    { upstream_alignment: [{ upstream_digest: "not-an-authority", drift: "maybe" }], findings: [] },
    ["Missing regression coverage", "The implementation otherwise looks sound"],
    "The revisions resolve my concerns.",
  ])("retains extracted feedback without interpreting its shape: %j", value => {
    const result = observe(value);
    expect(result.evidence.schema_version).toBe("4");
    if (result.evidence.schema_version !== "4") throw new Error("expected report evidence");
    expect(result.evidence.reports[0]?.report).toBe(readableReviewReport(value));
    expect(parseReviewEvidence(result.evidence)).toEqual(result.evidence);
    expect(Object.isFrozen(result.evidence.reports[0])).toBe(true);
    expect(result.evidence).not.toHaveProperty("findings");
    expect(result.evidence).not.toHaveProperty("verdict");
    expect(result.evidence).not.toHaveProperty("partition_counts");
  });

  it("binds provenance from the dispatch, never from feedback text", () => {
    const result = observe({ task_id: "different-task", subject_digest: "different-subject", reviewer_id: "test", report: "Useful feedback" });
    expect(result.evidence).toMatchObject({ task_id: "reports", subject_digest: digest("a"), model: "claude-fable-5-1" });
    if (result.evidence.schema_version !== "4") throw new Error("expected report evidence");
    expect(result.evidence.reports[0]).toMatchObject({ reviewer_id: "general", subject_digest: digest("a") });
    expect(result.evidence.reports[0]?.report).toContain("different-task");
    const evidence = result.evidence;
    expect(() => parseReviewEvidence({ ...evidence, reports: [{ ...evidence.reports[0], reviewer_id: "forged" }] })).toThrow(/dispatched reviewers/);
    expect(canonicalJsonDigest(result.evidence)).toMatch(/^[a-f0-9]{64}$/);
  });

  it("distinguishes absent readable feedback from unconventional feedback", () => {
    expect(() => observe({ report: "  " })).toThrow(/empty/);
    expect(() => observationSource.observeReview(createTestObservationCapability(binding), new TextEncoder().encode("{broken"))).toThrow();
    expect(observe({ findings: [] }).evidence.schema_version).toBe("4");
  });

  it.each(["claude-cli", "codex-cli", "antigravity-cli"] as const)("uses one report field for %s", adapter => {
    const projected = projectCliOutputSchema({}, "review", adapter, {}, { reviewer_id: "test", focus: "tests", criterion_ids: ["test-quality"] });
    expect(projected).toMatchObject({ type: "object", properties: { report: { type: "string" } }, required: ["report"] });
    expect(projected).not.toHaveProperty("oneOf");
  });
});

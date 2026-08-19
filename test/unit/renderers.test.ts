import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";

import { parseSha256Digest, parseTaskSlug } from "../../src/contracts/evidence.js";
import { createTestAuthorityLink, createTestCurrentReviewSetAuthority, createTestVerifiedReferencedEvidence } from "../../src/contracts/internal/test-capabilities.js";
import { createVerifiedEvidenceReference } from "../../src/contracts/internal/trust-mints.js";
import { encodePhaseInstance } from "../../src/contracts/phase-instance.js";
import { renderAdjudicationEvidence, renderReviewEvidence, renderTriage } from "../../src/contracts/renderers.js";
import { parseReviewEvidence, type DegradedReview } from "../../src/contracts/review.js";
import { authorityQualifier, type QualifiedAdjudicationEvidence, type QualifiedReviewEvidence } from "../../src/contracts/trust.js";
import { validateTriage } from "../../src/contracts/triage.js";

const digest = (character: string) => parseSha256Digest(character.repeat(64));
const phase = encodePhaseInstance({ kind: "phase-impl", phase: 2 as never });
const TASK = parseTaskSlug("task");

const reviewEvidence = (evidenceDigest: ReturnType<typeof digest>): DegradedReview => ({
  schema_version: "1", task_id: TASK, phase_instance: phase, step: "counter_review", role: "counter-review",
  subject_digest: digest("a"), input_fingerprint: digest("b"), rubric_digest: digest("c"), producer_family: "claude",
  findings: [{ finding_id: "spoof", severity: "minor", blocking: false, summary: "# injected\n| table |\n```<x>&\u202e", evidence: "ok", suggested_resolution: "none" }],
  matched_rule_versions: [], verdict: "advisory", blocking_count: 0,
  assurance: "degraded", model_family: "codex", model: "unknown", effort: "unknown", reason: "manual",
}) as DegradedReview;

function qualifyReview(evidenceDigest: ReturnType<typeof digest>): QualifiedReviewEvidence {
  const evidence = reviewEvidence(evidenceDigest);
  const verified = createTestVerifiedReferencedEvidence<"review", "degraded">("review", { evidence_digest: evidenceDigest, evidence } as never);
  const authority = { kind: "degraded", checkpoint_digest: digest("8"), checkpoint_revision: 1 } as const;
  const link = createTestAuthorityLink({ schema_version: "1", evidence_kind: "review", assurance: evidence.assurance, role: "counter-review", task_id: TASK, phase_instance: phase, subject_digest: digest("a"), input_fingerprint: digest("b"), evidence_digest: evidenceDigest, authority } as never);
  return authorityQualifier.qualifyReview(link as never, verified as never);
}

describe("anti-spoofing renderers", () => {
  it("renders genuinely qualified review evidence and visibly escapes prose", () => {
    const value = qualifyReview(digest("2"));
    const bytes = renderReviewEvidence(value);
    const rendered = new TextDecoder().decode(bytes);
    expect(rendered.startsWith("# ArchFlow Review Evidence\nschema_version:")).toBe(true);
    expect(rendered).toContain("\\u000a"); expect(rendered).toContain("\\u0060"); expect(rendered).toContain("\\u003c"); expect(rendered).toContain("\\u202e");
    expect(rendered.endsWith("\n")).toBe(true); expect(rendered.endsWith("\n\n")).toBe(false); expect(rendered).not.toContain("\r");
    const verified = createVerifiedEvidenceReference(value.evidence);
    expect(new TextDecoder().decode(renderReviewEvidence(verified))).toContain(`evidence_digest: ${JSON.stringify(verified.evidence_digest)}`);
    expect(() => renderReviewEvidence({ ...value } as never)).toThrow(/authenticated review/);
    expect(() => renderReviewEvidence({ evidence_digest: digest("2"), evidence: value.evidence, authority: value.authority } as never)).toThrow(/authenticated review/);
  });

  it("renders and round-trips a route override on server-attested review evidence", () => {
    const evidenceDigest = digest("3");
    const { reason: _degradedReason, ...base } = reviewEvidence(evidenceDigest);
    const evidence = {
      ...base,
      assurance: "server-attested", adapter: "claude-cli", cli_version: "2.0.0", model_family: "claude",
      model: "claude-opus-4-6", effort: "max", invocation_id: "inv-1", envelope_input_digest: digest("d"),
      observed_output_digest: digest("e"), result_id: "res-1",
      route_override: { reason: "codex auth outage\nsecond line", pinned_model: "gpt-fixture", pinned_effort: "high" },
    };
    // The parse is the durable round-trip: an override survives the strict server-attested arm.
    expect(parseReviewEvidence(structuredClone(evidence))).toMatchObject({
      route_override: { reason: "codex auth outage\nsecond line", pinned_model: "gpt-fixture", pinned_effort: "high" },
    });

    const rendered = new TextDecoder().decode(renderReviewEvidence(createVerifiedEvidenceReference(parseReviewEvidence(structuredClone(evidence)))));
    expect(rendered).toContain("## Route Override");
    expect(rendered).toContain('pinned_model: "gpt-fixture"');
    expect(rendered).toContain('pinned_effort: "high"');
    // Prose escaping applies to the human's reason exactly as it does to every other rendered field.
    expect(rendered).toContain("\\u000a");
  });

  it("omits the route override section when the dispatch ran on its pinned route", () => {
    expect(new TextDecoder().decode(renderReviewEvidence(qualifyReview(digest("2"))))).not.toContain("## Route Override");
  });

  it("rejects forged and spread-cloned adjudication evidence", async () => {
    const raw = JSON.parse(await readFile(new URL("../fixtures/contracts/adjudication/valid.json", import.meta.url), "utf8")) as Record<string, unknown>;
    const evidence = { ...raw, assurance: "degraded", model_family: "unknown", model: "unknown", effort: "unknown", reason: "manual" };
    const verified = createTestVerifiedReferencedEvidence<"adjudication", "degraded">("adjudication", { evidence_digest: digest("4"), evidence } as never);
    const link = createTestAuthorityLink({ schema_version: "1", evidence_kind: "adjudication", assurance: "degraded", role: "adjudication", task_id: parseTaskSlug("mcp-integration"), phase_instance: phase, subject_digest: digest("a"), input_fingerprint: digest("b"), evidence_digest: digest("4"), authority: { kind: "degraded", checkpoint_digest: digest("8"), checkpoint_revision: 1 } });
    const qualified = authorityQualifier.qualifyAdjudication(link, verified) as QualifiedAdjudicationEvidence;
    expect(new TextDecoder().decode(renderAdjudicationEvidence(qualified))).toMatch(/^# ArchFlow Adjudication Evidence/mu);
    const derived = createVerifiedEvidenceReference(qualified.evidence);
    expect(new TextDecoder().decode(renderAdjudicationEvidence(derived))).toContain(`evidence_digest: ${JSON.stringify(derived.evidence_digest)}`);
    expect(() => renderAdjudicationEvidence({ ...qualified } as never)).toThrow(/authenticated adjudication/);
    expect(() => renderAdjudicationEvidence({ evidence_digest: digest("4"), evidence, authority: link } as never)).toThrow(/authenticated adjudication/);
  });

  it("renders only identity-authenticated validated triage", () => {
    const counter = qualifyReview(digest("2"));
    const slots = [
      { role: "counter-review", evidence_digest: digest("2"), assurance: "degraded", producer_family: "claude", reviewer_family: "codex" },
    ] as const;
    const set = authorityQualifier.currentReviews(createTestCurrentReviewSetAuthority({ task_id: TASK, phase_instance: phase, subject_digest: digest("a"), input_fingerprint: digest("b"), slots }), [counter]);
    const candidate = { schema_version: "1", task_id: TASK, phase_instance: phase, step: "triage", subject_digest: digest("a"), input_fingerprint: digest("b"), current_evidence_set_digest: set.current_evidence_set.set_digest, source_evidence_digests: [digest("2")], dispositions: [{ review_evidence_digest: digest("2"), finding_id: "spoof", disposition: "rejected", rationale: "not applicable", evidence: "source confirms" }], accepted_count: 0, rejected_count: 1, accepted_editorial_count: 0 };
    const validated = validateTriage(set, candidate);
    expect(new TextDecoder().decode(renderTriage(validated))).toMatch(/^# ArchFlow Review Triage/mu);
    expect(() => renderTriage({ ...validated } as never)).toThrow(/validated triage/);
    expect(() => renderTriage(candidate as never)).toThrow(/validated triage/);
  });
});

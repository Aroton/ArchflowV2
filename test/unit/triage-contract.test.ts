import { describe, expect, it } from "vitest";

import { parseSha256Digest, parseTaskSlug } from "../../src/contracts/evidence.js";
import {
  createTestAuthorityLink,
  createTestCurrentReviewSetAuthority,
  createTestVerifiedReferencedEvidence,
} from "../../src/contracts/internal/test-capabilities.js";
import { encodePhaseInstance } from "../../src/contracts/phase-instance.js";
import { authorityQualifier, type QualifiedReviewEvidence } from "../../src/contracts/trust.js";
import { validateTriage } from "../../src/contracts/triage.js";
import type { ReviewFindingV2 } from "../../src/contracts/review.js";

const digest = (character: string) => parseSha256Digest(character.repeat(64));
const TASK = parseTaskSlug("triage-contract-task");
const phase = encodePhaseInstance({ kind: "design" });

function qualifyWithFindings(findings: readonly (ReviewFindingV2 | { finding_id: string; severity: "blocker" | "minor"; blocking: boolean; summary: string; evidence: string; suggested_resolution: string })[]): QualifiedReviewEvidence {
  const evidence = {
    schema_version: "1",
    task_id: TASK,
    phase_instance: phase,
    step: "counter_review",
    role: "counter-review",
    subject_digest: digest("a"),
    input_fingerprint: digest("b"),
    rubric_digest: digest("c"),
    producer_family: "claude",
    findings,
    matched_rule_versions: [],
    verdict: "advisory",
    blocking_count: 0,
    assurance: "degraded",
    model_family: "codex",
    model: "model",
    effort: "unknown",
    reason: "manual",
  } as const;
  const verified = createTestVerifiedReferencedEvidence<"review", "degraded">("review", {
    evidence_digest: digest("1"),
    evidence,
  } as never);
  const authority = { kind: "degraded", checkpoint_digest: digest("f"), checkpoint_revision: 1 } as const;
  const link = createTestAuthorityLink({
    schema_version: "1",
    evidence_kind: "review",
    assurance: evidence.assurance,
    role: evidence.role,
    task_id: TASK,
    phase_instance: phase,
    subject_digest: digest("a"),
    input_fingerprint: digest("b"),
    evidence_digest: digest("1"),
    authority,
  } as never);
  return authorityQualifier.qualifyReview(link as never, verified as never);
}

function makeContext(findings: readonly (ReviewFindingV2 | { finding_id: string; severity: "blocker" | "minor"; blocking: boolean; summary: string; evidence: string; suggested_resolution: string })[]) {
  const reviews = [qualifyWithFindings(findings)] as const;
  const slots = [
    { role: "counter-review", evidence_digest: digest("1"), assurance: "degraded", producer_family: "claude", reviewer_family: "codex" },
  ] as const;
  const current = authorityQualifier.currentReviews(
    createTestCurrentReviewSetAuthority({
      task_id: TASK,
      phase_instance: phase,
      subject_digest: digest("a"),
      input_fingerprint: digest("b"),
      slots,
    }),
    reviews,
  );
  return current;
}

describe("triage contract machine invariants", () => {
  it("refuses deferred disposition for a defect claim", () => {
    const finding: ReviewFindingV2 = {
      finding_id: "defect-1",
      claim_type: "defect",
      confidence: "certain",
      falsifier: "falsifier",
      summary: "defect summary",
      evidence: "defect evidence",
      suggested_resolution: "fix defect",
    };
    const current = makeContext([finding]);
    const candidate = {
      schema_version: "1",
      task_id: TASK,
      phase_instance: phase,
      step: "triage",
      subject_digest: digest("a"),
      input_fingerprint: digest("b"),
      current_evidence_set_digest: current.current_evidence_set.set_digest,
      source_evidence_digests: [digest("1")],
      dispositions: [{
        review_evidence_digest: digest("1"),
        finding_id: "defect-1",
        disposition: "deferred" as const,
        rationale: "cannot defer defect",
      }],
      accepted_count: 0,
      rejected_count: 0,
      accepted_editorial_count: 0,
      escalated_human_count: 0,
      deferred_count: 1,
    };
    expect(() => validateTriage(current, candidate)).toThrow(
      /deferred is refused for defect finding/u,
    );
  });

  it("refuses deferred disposition for a legacy blocking: true finding", () => {
    const finding = {
      finding_id: "legacy-blocker",
      severity: "blocker" as const,
      blocking: true,
      summary: "blocker summary",
      evidence: "blocker evidence",
      suggested_resolution: "fix blocker",
    };
    const current = makeContext([finding]);
    const candidate = {
      schema_version: "1",
      task_id: TASK,
      phase_instance: phase,
      step: "triage",
      subject_digest: digest("a"),
      input_fingerprint: digest("b"),
      current_evidence_set_digest: current.current_evidence_set.set_digest,
      source_evidence_digests: [digest("1")],
      dispositions: [{
        review_evidence_digest: digest("1"),
        finding_id: "legacy-blocker",
        disposition: "deferred" as const,
        rationale: "trying to defer legacy blocker",
      }],
      accepted_count: 0,
      rejected_count: 0,
      accepted_editorial_count: 0,
      escalated_human_count: 0,
      deferred_count: 1,
    };
    expect(() => validateTriage(current, candidate)).toThrow(
      /deferred is refused for defect finding/u,
    );
  });

  it("requires non-blank evidence for substantive deferral (risk)", () => {
    const finding: ReviewFindingV2 = {
      finding_id: "risk-1",
      claim_type: "risk",
      confidence: "likely",
      falsifier: "falsifier",
      summary: "risk summary",
      evidence: "risk evidence",
      suggested_resolution: "mitigate risk",
    };
    const current = makeContext([finding]);
    const candidateWithoutEvidence = {
      schema_version: "1",
      task_id: TASK,
      phase_instance: phase,
      step: "triage",
      subject_digest: digest("a"),
      input_fingerprint: digest("b"),
      current_evidence_set_digest: current.current_evidence_set.set_digest,
      source_evidence_digests: [digest("1")],
      dispositions: [{
        review_evidence_digest: digest("1"),
        finding_id: "risk-1",
        disposition: "deferred" as const,
        rationale: "mitigation scheduled for phase 4",
      }],
      accepted_count: 0,
      rejected_count: 0,
      accepted_editorial_count: 0,
      escalated_human_count: 0,
      deferred_count: 1,
    };
    expect(() => validateTriage(current, candidateWithoutEvidence)).toThrow(
      /deferred requires non-blank evidence demonstrating non-material consequence/u,
    );

    const candidateWithEvidence = {
      ...candidateWithoutEvidence,
      dispositions: [{
        ...candidateWithoutEvidence.dispositions[0],
        evidence: "Benchmark proves system operates within capacity without mitigation",
      }],
    };
    const validated = validateTriage(current, candidateWithEvidence);
    expect(validated.deferred_count).toBe(1);
  });

  it("enforces 5-way partition counts against actual filtered dispositions", () => {
    const findings: ReviewFindingV2[] = [
      { finding_id: "f1", claim_type: "preference", confidence: "likely", falsifier: "f", summary: "s", evidence: "e", suggested_resolution: "r" },
      { finding_id: "f2", claim_type: "preference", confidence: "likely", falsifier: "f", summary: "s", evidence: "e", suggested_resolution: "r" },
      { finding_id: "f3", claim_type: "preference", confidence: "likely", falsifier: "f", summary: "s", evidence: "e", suggested_resolution: "r" },
      { finding_id: "f4", claim_type: "preference", confidence: "likely", falsifier: "f", summary: "s", evidence: "e", suggested_resolution: "r" },
      { finding_id: "f5", claim_type: "preference", confidence: "likely", falsifier: "f", summary: "s", evidence: "e", suggested_resolution: "r" },
    ];
    const current = makeContext(findings);
    const candidate = {
      schema_version: "1",
      task_id: TASK,
      phase_instance: phase,
      step: "triage",
      subject_digest: digest("a"),
      input_fingerprint: digest("b"),
      current_evidence_set_digest: current.current_evidence_set.set_digest,
      source_evidence_digests: [digest("1")],
      dispositions: [
        { review_evidence_digest: digest("1"), finding_id: "f1", disposition: "accepted" as const, rationale: "fix it", revision_intent: "plan rewrite" },
        { review_evidence_digest: digest("1"), finding_id: "f2", disposition: "accepted-editorial" as const, rationale: "style fix", revision_intent: "spelling" },
        { review_evidence_digest: digest("1"), finding_id: "f3", disposition: "rejected" as const, rationale: "disagree", evidence: "docs refute" },
        { review_evidence_digest: digest("1"), finding_id: "f4", disposition: "escalated-human" as const, rationale: "human tradeoff" },
        { review_evidence_digest: digest("1"), finding_id: "f5", disposition: "deferred" as const, rationale: "later phase" },
      ],
      accepted_count: 1,
      accepted_editorial_count: 1,
      rejected_count: 1,
      escalated_human_count: 1,
      deferred_count: 1,
    };
    const validated = validateTriage(current, candidate);
    expect(validated.accepted_count).toBe(1);
    expect(validated.accepted_editorial_count).toBe(1);
    expect(validated.rejected_count).toBe(1);
    expect(validated.escalated_human_count).toBe(1);
    expect(validated.deferred_count).toBe(1);

    // Mismatched partition count throws contradictory error
    expect(() => validateTriage(current, { ...candidate, escalated_human_count: 0 })).toThrow(/contradictory/u);
    expect(() => validateTriage(current, { ...candidate, deferred_count: 2 })).toThrow(/contradictory/u);
  });
});

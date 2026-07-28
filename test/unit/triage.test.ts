import { describe, expect, it } from "vitest";

import { parseSha256Digest, parseTaskSlug } from "../../src/contracts/evidence.js";
import { createTestAuthorityLink, createTestCurrentReviewSetAuthority, createTestVerifiedReferencedEvidence } from "../../src/contracts/internal/test-capabilities.js";
import { encodePhaseInstance } from "../../src/contracts/phase-instance.js";
import { authorityQualifier, type QualifiedReviewEvidence } from "../../src/contracts/trust.js";
import { validateTriage } from "../../src/contracts/triage.js";

const digest = (character: string) => parseSha256Digest(character.repeat(64));
const phase = encodePhaseInstance({ kind: "phase-impl", phase: 2 as never });
const TASK = parseTaskSlug("task");

function qualify(role: "self-review" | "counter-review", evidenceDigest: ReturnType<typeof digest>): QualifiedReviewEvidence {
  const self = role === "self-review";
  const evidence = { schema_version: "1", task_id: TASK, phase_instance: phase, step: self ? "self_review" : "counter_review", role, subject_digest: digest("a"), input_fingerprint: digest("b"), rubric_digest: digest("c"), producer_family: "claude", findings: [{ finding_id: "same-id", severity: "minor", blocking: false, summary: "summary", evidence: "evidence", suggested_resolution: "resolution" }], matched_rule_versions: [], verdict: "advisory", blocking_count: 0, ...(self ? { assurance: "agent-declared", model_family: "claude", model: "model", effort: "high" } : { assurance: "degraded", model_family: "codex", model: "model", effort: "unknown", reason: "manual" }) } as const;
  const verified = createTestVerifiedReferencedEvidence<"review", "agent-declared" | "degraded">("review", { evidence_digest: evidenceDigest, evidence } as never);
  const authority = self ? { kind: "agent-declared", result_id: "result-1", result_digest: digest("f"), state_revision: 1 } as const : { kind: "degraded", checkpoint_digest: digest("f"), checkpoint_revision: 1 } as const;
  const link = createTestAuthorityLink({ schema_version: "1", evidence_kind: "review", assurance: evidence.assurance, role, task_id: TASK, phase_instance: phase, subject_digest: digest("a"), input_fingerprint: digest("b"), evidence_digest: evidenceDigest, authority } as never);
  return authorityQualifier.qualifyReview(link as never, verified as never);
}

const reviews = [qualify("self-review", digest("1")), qualify("counter-review", digest("2"))] as const;
const slots = [
  { role: "self-review", evidence_digest: digest("1"), assurance: "agent-declared", producer_family: "claude", reviewer_family: "claude", independence: "same-family-self" },
  { role: "counter-review", evidence_digest: digest("2"), assurance: "degraded", producer_family: "claude", reviewer_family: "codex", independence: "opposite-family" },
] as const;
const current = authorityQualifier.currentReviews(createTestCurrentReviewSetAuthority({ task_id: TASK, phase_instance: phase, subject_digest: digest("a"), input_fingerprint: digest("b"), slots }), reviews);
const disposition = (reviewDigest: ReturnType<typeof digest>) => ({ review_evidence_digest: reviewDigest, finding_id: "same-id", disposition: "rejected", rationale: "not applicable", evidence: "source confirms" });
const candidate = { schema_version: "1", task_id: TASK, phase_instance: phase, step: "triage", subject_digest: digest("a"), input_fingerprint: digest("b"), current_evidence_set_digest: current.current_evidence_set.set_digest, source_evidence_digests: [digest("1"), digest("2")], dispositions: [disposition(digest("1")), disposition(digest("2"))], accepted_count: 0, rejected_count: 2 };

describe("exact-set triage", () => {
  it("uses composite finding identities", () => { expect(validateTriage(current, candidate).dispositions).toHaveLength(2); });
  it("rejects omissions, duplicates, and foreign review digests", () => {
    expect(() => validateTriage(current, { ...candidate, dispositions: candidate.dispositions.slice(1), rejected_count: 1 })).toThrow(/exactly cover/);
    expect(() => validateTriage(current, { ...candidate, dispositions: [candidate.dispositions[0], candidate.dispositions[0]], rejected_count: 2 })).toThrow(/duplicate/);
    expect(() => validateTriage(current, { ...candidate, dispositions: [disposition(digest("3")), candidate.dispositions[1]] })).toThrow(/foreign or stale/);
  });
  it("rejects cast and spread-cloned current review sets", () => {
    expect(() => validateTriage({ ...current } as never, candidate)).toThrow(/authenticated/);
  });
});

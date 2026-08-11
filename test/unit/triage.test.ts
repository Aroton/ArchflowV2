import { describe, expect, it } from "vitest";

import { parsePathSafeId, parseSha256Digest, parseTaskSlug } from "../../src/contracts/evidence.js";
import { createTestAuthorityLink, createTestCurrentReviewSetAuthority, createTestVerifiedReferencedEvidence } from "../../src/contracts/internal/test-capabilities.js";
import { encodePhaseInstance } from "../../src/contracts/phase-instance.js";
import { authorityQualifier, type QualifiedReviewEvidence } from "../../src/contracts/trust.js";
import { parseTriageCandidate, validateTriage } from "../../src/contracts/triage.js";

const digest = (character: string) => parseSha256Digest(character.repeat(64));
const phase = encodePhaseInstance({ kind: "phase-impl", phase: 2 as never });
const TASK = parseTaskSlug("task");

const GATE_ID = parsePathSafeId("gate-1");

function qualify(role: "counter-review" | "gate-counter-review", evidenceDigest: ReturnType<typeof digest>, blocking = false): QualifiedReviewEvidence {
  const evidence = { schema_version: "1", task_id: TASK, phase_instance: phase, step: "counter_review", role, subject_digest: digest("a"), input_fingerprint: digest("b"), rubric_digest: digest("c"), producer_family: "claude", findings: [{ finding_id: "same-id", severity: blocking ? "blocker" : "minor", blocking, summary: "summary", evidence: "evidence", suggested_resolution: "resolution" }], matched_rule_versions: [], verdict: blocking ? "fail" : "advisory", blocking_count: blocking ? 1 : 0, assurance: "degraded", model_family: "codex", model: "model", effort: "unknown", reason: "manual" } as const;
  const verified = createTestVerifiedReferencedEvidence<"review", "degraded">("review", { evidence_digest: evidenceDigest, evidence } as never);
  const authority = { kind: "degraded", checkpoint_digest: digest("f"), checkpoint_revision: 1 } as const;
  const link = createTestAuthorityLink({ schema_version: "1", evidence_kind: "review", assurance: evidence.assurance, role, task_id: TASK, phase_instance: phase, subject_digest: digest("a"), input_fingerprint: digest("b"), evidence_digest: evidenceDigest, ...(role === "gate-counter-review" ? { gate_id: GATE_ID } : {}), authority } as never);
  return authorityQualifier.qualifyReview(link as never, verified as never);
}

const reviews = [qualify("counter-review", digest("1")), qualify("gate-counter-review", digest("2"))] as const;
const slots = [
  { role: "counter-review", evidence_digest: digest("1"), assurance: "degraded", producer_family: "claude", reviewer_family: "codex", independence: "opposite-family" },
  { role: "gate-counter-review", evidence_digest: digest("2"), assurance: "degraded", producer_family: "claude", reviewer_family: "codex", independence: "opposite-family", gate_id: GATE_ID },
] as const;
const current = authorityQualifier.currentReviews(createTestCurrentReviewSetAuthority({ task_id: TASK, phase_instance: phase, subject_digest: digest("a"), input_fingerprint: digest("b"), slots }), reviews);
const disposition = (reviewDigest: ReturnType<typeof digest>) => ({ review_evidence_digest: reviewDigest, finding_id: "same-id", disposition: "rejected", rationale: "not applicable", evidence: "source confirms" });
const candidate = { schema_version: "1", task_id: TASK, phase_instance: phase, step: "triage", subject_digest: digest("a"), input_fingerprint: digest("b"), current_evidence_set_digest: current.current_evidence_set.set_digest, source_evidence_digests: [digest("1"), digest("2")], dispositions: [disposition(digest("1")), disposition(digest("2"))], accepted_count: 0, rejected_count: 2, accepted_editorial_count: 0 };

describe("exact-set triage", () => {
  it("parses structure without claiming current-set coverage", () => {
    const structurallyValid = { ...candidate, dispositions: candidate.dispositions.slice(1), rejected_count: 1 };
    expect(parseTriageCandidate(structurallyValid).dispositions).toHaveLength(1);
    expect(() => validateTriage(current, structurallyValid)).toThrow(/exactly cover/);
  });
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

const editorialDisposition = (reviewDigest: ReturnType<typeof digest>) => ({ review_evidence_digest: reviewDigest, finding_id: "same-id", disposition: "accepted-editorial", rationale: "wording only", revision_intent: "polish wording" });

describe("accepted-editorial triage", () => {
  const editorialCandidate = { ...candidate, dispositions: [editorialDisposition(digest("1")), editorialDisposition(digest("2"))], accepted_count: 0, rejected_count: 0, accepted_editorial_count: 2 };
  it("validates editorial-only acceptance with its own count", () => {
    const validated = validateTriage(current, editorialCandidate);
    expect(validated.accepted_count).toBe(0);
    expect(validated.accepted_editorial_count).toBe(2);
  });
  it("refuses a missing or contradictory accepted_editorial_count", () => {
    const { accepted_editorial_count: _omitted, ...withoutCount } = editorialCandidate;
    expect(parseTriageCandidate(withoutCount).dispositions).toHaveLength(2);
    expect(() => validateTriage(current, withoutCount)).toThrow(/requires accepted_editorial_count/);
    expect(() => validateTriage(current, { ...editorialCandidate, accepted_editorial_count: 1, rejected_count: 1 })).toThrow(/contradictory/);
    expect(() => validateTriage(current, { ...candidate, accepted_editorial_count: 1, rejected_count: 1 })).toThrow(/contradictory/);
  });
  it("refuses accepted-editorial on any blocking finding", () => {
    const blockingReviews = [qualify("counter-review", digest("1"), true), qualify("gate-counter-review", digest("2"))] as const;
    const blockingCurrent = authorityQualifier.currentReviews(createTestCurrentReviewSetAuthority({ task_id: TASK, phase_instance: phase, subject_digest: digest("a"), input_fingerprint: digest("b"), slots }), blockingReviews);
    const mixed = { ...editorialCandidate, current_evidence_set_digest: blockingCurrent.current_evidence_set.set_digest };
    expect(() => validateTriage(blockingCurrent, mixed)).toThrow(/blocking finding/);
    const editorialOnNonBlocking = { ...mixed, dispositions: [disposition(digest("1")), editorialDisposition(digest("2"))], accepted_count: 0, rejected_count: 1, accepted_editorial_count: 1 };
    expect(validateTriage(blockingCurrent, editorialOnNonBlocking).accepted_editorial_count).toBe(1);
  });
});

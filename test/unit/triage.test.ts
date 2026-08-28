import { describe, expect, it } from "vitest";

import { parseSha256Digest, parseTaskSlug } from "../../src/contracts/evidence.js";
import { createTestAuthorityLink, createTestCurrentReviewSetAuthority, createTestVerifiedReferencedEvidence } from "../../src/contracts/internal/test-capabilities.js";
import { encodePhaseInstance } from "../../src/contracts/phase-instance.js";
import { authorityQualifier, type QualifiedReviewEvidence } from "../../src/contracts/trust.js";
import { parseTriageCandidate, validateTriage } from "../../src/contracts/triage.js";

const digest = (character: string) => parseSha256Digest(character.repeat(64));
const phase = encodePhaseInstance({ kind: "phase-impl", phase: 2 as never });
const TASK = parseTaskSlug("task");

function qualify(evidenceDigest: ReturnType<typeof digest>, blocking = false): QualifiedReviewEvidence {
  const evidence = { schema_version: "1", task_id: TASK, phase_instance: phase, step: "counter_review", role: "counter-review", subject_digest: digest("a"), input_fingerprint: digest("b"), rubric_digest: digest("c"), producer_family: "claude", findings: [{ finding_id: "same-id", severity: blocking ? "blocker" : "minor", blocking, summary: "summary", evidence: "evidence", suggested_resolution: "resolution" }], matched_rule_versions: [], verdict: blocking ? "fail" : "advisory", blocking_count: blocking ? 1 : 0, assurance: "degraded", model_family: "codex", model: "model", effort: "unknown", reason: "manual" } as const;
  const verified = createTestVerifiedReferencedEvidence<"review", "degraded">("review", { evidence_digest: evidenceDigest, evidence } as never);
  const authority = { kind: "degraded", checkpoint_digest: digest("f"), checkpoint_revision: 1 } as const;
  const link = createTestAuthorityLink({ schema_version: "1", evidence_kind: "review", assurance: evidence.assurance, role: evidence.role, task_id: TASK, phase_instance: phase, subject_digest: digest("a"), input_fingerprint: digest("b"), evidence_digest: evidenceDigest, authority } as never);
  return authorityQualifier.qualifyReview(link as never, verified as never);
}

const reviews = [qualify(digest("1"))] as const;
const slots = [
  { role: "counter-review", evidence_digest: digest("1"), assurance: "degraded", producer_family: "claude", reviewer_family: "codex" },
] as const;
const current = authorityQualifier.currentReviews(createTestCurrentReviewSetAuthority({ task_id: TASK, phase_instance: phase, subject_digest: digest("a"), input_fingerprint: digest("b"), slots }), reviews);
const disposition = (reviewDigest: ReturnType<typeof digest>) => ({ review_evidence_digest: reviewDigest, finding_id: "same-id", disposition: "rejected", rationale: "not applicable", evidence: "source confirms" });
const candidate = { schema_version: "1", task_id: TASK, phase_instance: phase, step: "triage", subject_digest: digest("a"), input_fingerprint: digest("b"), current_evidence_set_digest: current.current_evidence_set.set_digest, source_evidence_digests: [digest("1")], dispositions: [disposition(digest("1"))], accepted_count: 0, rejected_count: 1, accepted_editorial_count: 0 };

describe("exact-set triage", () => {
  it("parses structure without claiming current-set coverage", () => {
    const structurallyValid = { ...candidate, dispositions: candidate.dispositions.slice(1), rejected_count: 1 };
    expect(parseTriageCandidate(structurallyValid).dispositions).toHaveLength(0);
    expect(() => validateTriage(current, structurallyValid)).toThrow(/exactly cover/);
  });
  it("binds every finding to its review identity", () => { expect(validateTriage(current, candidate).dispositions).toHaveLength(1); });
  it("rejects omissions, duplicates, and foreign review digests", () => {
    expect(() => validateTriage(current, { ...candidate, dispositions: candidate.dispositions.slice(1), rejected_count: 1 })).toThrow(/exactly cover/);
    expect(() => validateTriage(current, { ...candidate, dispositions: [candidate.dispositions[0], candidate.dispositions[0]], rejected_count: 2 })).toThrow(/duplicate/);
    expect(() => validateTriage(current, { ...candidate, dispositions: [disposition(digest("3"))] })).toThrow(/foreign or stale/);
  });
  it("rejects cast and spread-cloned current review sets", () => {
    expect(() => validateTriage({ ...current } as never, candidate)).toThrow(/authenticated/);
  });
});

const editorialDisposition = (reviewDigest: ReturnType<typeof digest>) => ({ review_evidence_digest: reviewDigest, finding_id: "same-id", disposition: "accepted-editorial", rationale: "wording only", revision_intent: "polish wording" });

describe("accepted-editorial triage", () => {
  const editorialCandidate = { ...candidate, dispositions: [editorialDisposition(digest("1"))], accepted_count: 0, rejected_count: 0, accepted_editorial_count: 1 };
  it("validates editorial-only acceptance with its own count", () => {
    const validated = validateTriage(current, editorialCandidate);
    expect(validated.accepted_count).toBe(0);
    expect(validated.accepted_editorial_count).toBe(1);
  });
  it("refuses a missing or contradictory accepted_editorial_count", () => {
    const { accepted_editorial_count: _omitted, ...withoutCount } = editorialCandidate;
    expect(parseTriageCandidate(withoutCount).dispositions).toHaveLength(1);
    expect(() => validateTriage(current, withoutCount)).toThrow(/requires accepted_editorial_count/);
    expect(() => validateTriage(current, { ...editorialCandidate, accepted_editorial_count: 0, rejected_count: 1 })).toThrow(/contradictory/);
    expect(() => validateTriage(current, { ...candidate, accepted_editorial_count: 1, rejected_count: 1 })).toThrow(/contradictory/);
  });
  it("refuses accepted-editorial on any blocking finding", () => {
    const blockingReviews = [qualify(digest("1"), true)] as const;
    const blockingCurrent = authorityQualifier.currentReviews(createTestCurrentReviewSetAuthority({ task_id: TASK, phase_instance: phase, subject_digest: digest("a"), input_fingerprint: digest("b"), slots }), blockingReviews);
    const mixed = { ...editorialCandidate, current_evidence_set_digest: blockingCurrent.current_evidence_set.set_digest };
    expect(() => validateTriage(blockingCurrent, mixed)).toThrow(/blocking finding/);
  });
});

describe("disposition ledger boundary", () => {
  const ledger = [{ review_evidence_digest: digest("9"), finding_id: "older", disposition: "rejected" as const, attempt: 1, rationale: "older rejection", evidence: "older evidence" }];

  it("refuses a candidate that arrives with a server-computed ledger", () => {
    expect(() => validateTriage(current, { ...candidate, disposition_ledger: ledger as never })).toThrow(/server-computed/u);
    // The structural parse accepts the field so retained artifacts keep loading; only the
    // producer-facing validation refuses it.
    expect(() => parseTriageCandidate({ ...candidate, disposition_ledger: [] })).not.toThrow();
  });

  it("freezes the server-provided ledger into the validated result", () => {
    const validated = validateTriage(current, candidate, ledger as never);
    expect(validated.disposition_ledger).toEqual(ledger);
    expect(Object.isFrozen(validated.disposition_ledger)).toBe(true);
  });

  it("keeps parsing retained candidates that carry a ledger", () => {
    const parsed = parseTriageCandidate({ ...candidate, disposition_ledger: ledger });
    expect(parsed.disposition_ledger).toHaveLength(1);
  });
});

import { describe, expect, it } from "vitest";

import { parseSha256Digest, parseTaskSlug } from "../../src/contracts/evidence.js";
import {
  createTestAuthorityLink,
  createTestCurrentReviewSetAuthority,
  createTestVerifiedReferencedEvidence,
} from "../../src/contracts/internal/test-capabilities.js";
import { encodePhaseInstance, type PhaseInstanceId } from "../../src/contracts/phase-instance.js";
import { authorityQualifier, type QualifiedReviewEvidence } from "../../src/contracts/trust.js";
import { parseTriageCandidate, validateTriage } from "../../src/contracts/triage.js";

const digest = (character: string) => parseSha256Digest(character.repeat(64));
const TASK = parseTaskSlug("test-task");

function qualify(evidenceDigest: ReturnType<typeof digest>, phaseInstance: PhaseInstanceId): QualifiedReviewEvidence {
  const evidence = {
    schema_version: "1",
    task_id: TASK,
    phase_instance: phaseInstance,
    step: "counter_review",
    role: "counter-review",
    subject_digest: digest("a"),
    input_fingerprint: digest("b"),
    rubric_digest: digest("c"),
    producer_family: "claude",
    findings: [{
      finding_id: "editorial-finding",
      claim_type: "preference",
      confidence: "likely",
      falsifier: "falsifier",
      summary: "wording suggestion",
      evidence: "evidence",
      suggested_resolution: "rephrase",
    }],
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
    evidence_digest: evidenceDigest,
    evidence,
  } as never);
  const authority = { kind: "degraded", checkpoint_digest: digest("f"), checkpoint_revision: 1 } as const;
  const link = createTestAuthorityLink({
    schema_version: "1",
    evidence_kind: "review",
    assurance: evidence.assurance,
    role: evidence.role,
    task_id: TASK,
    phase_instance: phaseInstance,
    subject_digest: digest("a"),
    input_fingerprint: digest("b"),
    evidence_digest: evidenceDigest,
    authority,
  } as never);
  return authorityQualifier.qualifyReview(link as never, verified as never);
}

function makeCurrentAndCandidate(phaseInstance: PhaseInstanceId) {
  const reviews = [qualify(digest("1"), phaseInstance)] as const;
  const slots = [
    { role: "counter-review", evidence_digest: digest("1"), assurance: "degraded", producer_family: "claude", reviewer_family: "codex" },
  ] as const;
  const current = authorityQualifier.currentReviews(
    createTestCurrentReviewSetAuthority({
      task_id: TASK,
      phase_instance: phaseInstance,
      subject_digest: digest("a"),
      input_fingerprint: digest("b"),
      slots,
    }),
    reviews,
  );
  const candidate = {
    schema_version: "1",
    task_id: TASK,
    phase_instance: phaseInstance,
    step: "triage",
    subject_digest: digest("a"),
    input_fingerprint: digest("b"),
    current_evidence_set_digest: current.current_evidence_set.set_digest,
    source_evidence_digests: [digest("1")],
    dispositions: [{
      review_evidence_digest: digest("1"),
      finding_id: "editorial-finding",
      disposition: "accepted-editorial" as const,
      rationale: "minor phrasing tweak",
      revision_intent: "improve readability",
    }],
    accepted_count: 0,
    rejected_count: 0,
    accepted_editorial_count: 1,
    escalated_human_count: 0,
    deferred_count: 0,
  };
  return { current, candidate };
}

describe("triage editorial produce guard", () => {
  it("refuses accepted-editorial on phase-impl positions", () => {
    const phaseImpl = encodePhaseInstance({ kind: "phase-impl", phase: 1 as never });
    const { current, candidate } = makeCurrentAndCandidate(phaseImpl);
    expect(() => validateTriage(current, candidate)).toThrow(
      /editorial produce is supported only for PRD and design/u,
    );
  });

  it("refuses accepted-editorial on phase-design positions", () => {
    const phaseDesign = encodePhaseInstance({ kind: "phase-design", phase: 1 as never });
    const { current, candidate } = makeCurrentAndCandidate(phaseDesign);
    expect(() => validateTriage(current, candidate)).toThrow(
      /editorial produce is supported only for PRD and design/u,
    );
  });

  it("accepts accepted-editorial on prd position", () => {
    const prdPhase = encodePhaseInstance({ kind: "prd" });
    const { current, candidate } = makeCurrentAndCandidate(prdPhase);
    const validated = validateTriage(current, candidate);
    expect(validated.accepted_editorial_count).toBe(1);
    expect(validated.accepted_count).toBe(0);
  });

  it("accepts accepted-editorial on design position", () => {
    const designPhase = encodePhaseInstance({ kind: "design" });
    const { current, candidate } = makeCurrentAndCandidate(designPhase);
    const validated = validateTriage(current, candidate);
    expect(validated.accepted_editorial_count).toBe(1);
    expect(validated.accepted_count).toBe(0);
  });
});

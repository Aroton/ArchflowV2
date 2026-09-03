import { createHash } from "node:crypto";

import { describe, expect, it } from "vitest";

import { parseAndDeriveAdjudication, type AdjudicationEvidence } from "../../src/contracts/adjudication.js";
import type { ResultManifestV1 } from "../../src/contracts/durable-result-manifest.js";
import type { TaskStateV1 } from "../../src/contracts/durable-state.js";
import { parseSafeInteger, parseSha256Digest, parseTaskSlug } from "../../src/contracts/evidence.js";
import { encodePhaseInstance } from "../../src/contracts/phase-instance.js";
import { computeFindingPartitionCounts, type ReviewEvidence, type ReviewFindingV2 } from "../../src/contracts/review.js";
import type { TriageCandidate } from "../../src/contracts/triage.js";
import {
  REVIEW_PUSH_THROUGH_MIN_ATTEMPT,
  assessCurrentEvidence,
  deriveReviewPushThroughCandidate,
  type AuthenticatedReviewPushThroughFacts,
  type EvidenceSubject,
  type ReviewPushThroughAuthoritySource,
} from "../../src/review/fixed-point.js";
import { deriveEvidenceSetFromCounter, type RetainedEvidenceSet } from "../../src/state/evidence-results.js";
import { resolvedConstitutionFixture } from "../helpers/resolved-constitution.js";

const digest = (text: string) => parseSha256Digest(createHash("sha256").update(text).digest("hex"));
const task = parseTaskSlug("push-through-core");
const phase = encodePhaseInstance({ kind: "phase-impl", phase: 2 as never });
const subjectDigest = digest("subject");
const inputFingerprint = digest("input");
const reviewEnvelopeDigest = digest("review-envelope");
const triageResultDigest = digest("triage-result");

const constitution = await resolvedConstitutionFixture({
  "10-required.md": `---
id: required
version: 1
status: active
---
The implementation must meet this rule.
`,
});

function state(attempt = 2): TaskStateV1 {
  return {
    schema_version: "1",
    task_id: task,
    repository_identity_digest: digest("repository"),
    revision: parseSafeInteger(8),
    phase_instance: phase,
    step: "triage",
    status: "succeeded",
    attempt: parseSafeInteger(attempt),
    input_fingerprint: inputFingerprint,
    initialization_digest: digest("initialization"),
    config_digest: digest("config"),
    workflow_digest: digest("workflow"),
    constitution_digest: constitution.digest,
    policy_base_commit: constitution.policy_base_commit,
    authoritative_results: [],
    approvals: [],
    waivers: [],
  };
}

function reviewEvidence(findings: readonly ReviewFindingV2[]): ReviewEvidence {
  return {
    schema_version: "2",
    task_id: task,
    phase_instance: phase,
    step: "counter_review",
    role: "counter-review",
    subject_digest: subjectDigest,
    input_fingerprint: inputFingerprint,
    rubric_digest: digest("rubric"),
    producer_family: "claude",
    findings,
    matched_rule_versions: [],
    verdict: "review-raised",
    total_findings: findings.length,
    partition_counts: computeFindingPartitionCounts(findings),
    assurance: "server-attested",
    envelope_input_digest: reviewEnvelopeDigest,
    observed_output_digest: digest("observed-output"),
    adapter: "codex-cli",
    cli_version: "1.0.0",
    invocation_id: "push-through-review" as never,
    result_id: "push-through-result" as never,
    model_family: "codex",
    model: "gpt-test",
    effort: "high",
  };
}

function manifest(step: "counter_review" | "triage" | "adjudicate", evidence: unknown, artifactDigest: ReturnType<typeof digest>): ResultManifestV1 {
  return {
    artifact_digest: artifactDigest,
    source_artifact: {
      schema_version: "1",
      artifact_kind: step === "counter_review" ? "review-evidence" : step === "triage" ? "triage" : "adjudication-evidence",
      evidence,
    },
  } as never;
}

function adjudication(compliance: "pass" | "fail"): AdjudicationEvidence {
  const derived = parseAndDeriveAdjudication({
    schema_version: "1",
    task_id: task,
    phase_instance: phase,
    step: "adjudicate",
    subject_digest: subjectDigest,
    input_fingerprint: inputFingerprint,
    pinned_constitution_digest: constitution.digest,
    source_review_envelope_digest: reviewEnvelopeDigest,
    approved_upstream_digests: [],
    rule_findings: [{
      rule_id: "required",
      rule_version: parseSafeInteger(1),
      compliance,
      rationale: compliance === "fail" ? "The current bytes do not meet the rule." : "The current bytes meet the rule.",
      trigger: "not-matched",
      trigger_evidence: "No separate trigger matched.",
    }],
    drift_findings: [],
  });
  return {
    ...derived,
    assurance: "degraded",
    reason: "Focused fixed-point fixture.",
    model_family: "codex",
    model: "gpt-test",
    effort: "high",
  };
}

function retained(options: Readonly<{
  attempt?: number;
  history?: readonly Readonly<{ attempt: number; review_evidence_digest?: ReturnType<typeof digest> }>[];
  policy_failure?: boolean;
}> = {}): RetainedEvidenceSet {
  const findings: readonly ReviewFindingV2[] = [
    { finding_id: "first-defect", claim_type: "defect", confidence: "certain", falsifier: "A focused test disproves it.", summary: "First accepted defect.", evidence: "The behavior is absent.", suggested_resolution: "Implement it." },
    { finding_id: "second-risk", claim_type: "risk", confidence: "likely", falsifier: "A stress test disproves it.", summary: "Second accepted risk.", evidence: "The edge case is uncovered.", suggested_resolution: "Cover it." },
  ];
  const review = reviewEvidence(findings);
  const current = deriveEvidenceSetFromCounter(review);
  const reviewDigest = current.reviews[0]!.evidence_digest;
  const attempt = options.attempt ?? 2;
  const history = options.history ?? [
    { attempt: 1, review_evidence_digest: reviewDigest },
    { attempt, review_evidence_digest: reviewDigest },
  ];
  const triage: TriageCandidate = {
    schema_version: "1",
    task_id: task,
    phase_instance: phase,
    step: "triage",
    subject_digest: subjectDigest,
    input_fingerprint: inputFingerprint,
    current_evidence_set_digest: current.current_evidence_set.set_digest,
    source_evidence_digests: [reviewDigest],
    dispositions: findings.map((finding) => ({
      review_evidence_digest: reviewDigest,
      finding_id: finding.finding_id,
      disposition: "accepted" as const,
      rationale: "The finding is material.",
      revision_intent: "Address it in production.",
    })),
    accepted_count: findings.length,
    rejected_count: 0,
    accepted_editorial_count: 0,
    escalated_human_count: 0,
    deferred_count: 0,
    review_round_history: history.map((entry) => ({
      attempt: parseSafeInteger(entry.attempt),
      review_evidence_digest: entry.review_evidence_digest ?? reviewDigest,
    })),
  };
  const entries: [string, RetainedEvidenceSet extends ReadonlyMap<unknown, infer Value> ? Value : never][] = [
    ["counter_review", {
      reference: { result_digest: digest("review-result"), step: "counter_review" } as never,
      manifest: manifest("counter_review", review, reviewDigest),
    }],
    ["triage", {
      reference: { result_digest: triageResultDigest, step: "triage" } as never,
      manifest: manifest("triage", triage, digest("triage-artifact")),
    }],
  ];
  entries.push(["adjudicate", {
    reference: { result_digest: digest("adjudication-result"), step: "adjudicate" } as never,
    manifest: manifest("adjudicate", adjudication(options.policy_failure === true ? "fail" : "pass"), digest("adjudication-artifact")),
  }]);
  return new Map(entries) as RetainedEvidenceSet;
}

function baseSubject(): EvidenceSubject {
  return {
    subject_digest: subjectDigest,
    input_fingerprint: inputFingerprint,
    constitution,
    max_attempts: 2,
  };
}

function authoritySource(facts: AuthenticatedReviewPushThroughFacts): ReviewPushThroughAuthoritySource {
  const opaque = Object.freeze({ facts });
  const authenticated = new WeakSet<object>([opaque]);
  return Object.freeze({
    values: Object.freeze([opaque]),
    authenticate: (value: unknown) => {
      if (typeof value !== "object" || value === null || !authenticated.has(value)) {
        throw new TypeError("authenticated review push-through required");
      }
      return (value as typeof opaque).facts;
    },
  });
}

function factsFor(candidate: NonNullable<ReturnType<typeof deriveReviewPushThroughCandidate>>): AuthenticatedReviewPushThroughFacts {
  return Object.freeze({
    task_id: task,
    phase_instance: phase,
    attempt: candidate.attempt,
    subject_digest: candidate.subject_digest,
    current_evidence_set_digest: candidate.context.current_evidence_set_digest,
    triage_result_digest: candidate.context.triage_result_digest,
    accepted_occurrences: candidate.context.accepted_occurrences,
  });
}

describe("exact-evidence review push-through", () => {
  it("requires distinct completed review history rather than an inflated state attempt", () => {
    const oneRound = retained({ attempt: 3, history: [{ attempt: 3 }] });
    expect(deriveReviewPushThroughCandidate(state(3), oneRound, {
      ...baseSubject(), max_attempts: 3,
    })).toBeUndefined();

    const repeatedEvidence = retained();
    const candidate = deriveReviewPushThroughCandidate(state(), repeatedEvidence, baseSubject());
    expect(candidate).toMatchObject({
      attempt: 2,
      review_round_count: REVIEW_PUSH_THROUGH_MIN_ATTEMPT,
      subject_digest: subjectDigest,
      context: {
        minimum_attempt: REVIEW_PUSH_THROUGH_MIN_ATTEMPT,
        triage_result_digest: triageResultDigest,
      },
    });
    expect(candidate?.context.accepted_occurrences.map((item) => item.finding_id)).toEqual([
      "first-defect", "second-risk",
    ]);
  });

  it("suppresses accepted findings only after the opaque authority authenticates and exactly matches", () => {
    const evidence = retained();
    const currentState = state();
    const subject = baseSubject();
    const candidate = deriveReviewPushThroughCandidate(currentState, evidence, subject)!;

    expect(assessCurrentEvidence(currentState, evidence, subject)).toMatchObject({
      blocker_remains: true,
      next: "attempts-exhausted",
    });
    expect(assessCurrentEvidence(currentState, evidence, {
      ...subject,
      review_push_through_authority: authoritySource(factsFor(candidate)),
    })).toMatchObject({
      blocker_remains: false,
      reentry_required: false,
      next: "advance",
    });
  });

  it.each([
    ["foreign task", { task_id: parseTaskSlug("other-task") }],
    ["changed attempt", { attempt: parseSafeInteger(3) }],
    ["changed subject", { subject_digest: digest("other-subject") }],
    ["changed evidence set", { current_evidence_set_digest: digest("other-set") }],
    ["changed triage result", { triage_result_digest: digest("other-triage") }],
    ["partial accepted set", { accepted_occurrences: [] }],
    ["extra accepted occurrence", { accepted_occurrences: [{ review_evidence_digest: digest("extra-review"), finding_id: "extra" }] }],
  ] as const)("keeps remediation active for %s authority", (_label, override) => {
    const evidence = retained();
    const currentState = state();
    const subject = baseSubject();
    const candidate = deriveReviewPushThroughCandidate(currentState, evidence, subject)!;
    const baseFacts = factsFor(candidate);
    const accepted = "accepted_occurrences" in override && override.accepted_occurrences.length > 0
      ? [...baseFacts.accepted_occurrences, ...override.accepted_occurrences]
      : "accepted_occurrences" in override
        ? override.accepted_occurrences
        : baseFacts.accepted_occurrences;
    const mismatched = {
      ...baseFacts,
      ...override,
      accepted_occurrences: accepted,
    } as AuthenticatedReviewPushThroughFacts;
    expect(assessCurrentEvidence(currentState, evidence, {
      ...subject,
      review_push_through_authority: authoritySource(mismatched),
    }).next).toBe("attempts-exhausted");
  });

  it("continues into unchanged constitution adjudication after the accepted set is settled", () => {
    const evidence = retained({ policy_failure: true });
    const currentState = state(2);
    const subject = baseSubject();
    const candidate = deriveReviewPushThroughCandidate(currentState, evidence, subject)!;
    const assessment = assessCurrentEvidence(currentState, evidence, {
      ...subject,
      review_push_through_authority: authoritySource(factsFor(candidate)),
    });
    expect(assessment).toMatchObject({
      blocker_remains: false,
      reentry_required: false,
      next: "adjudication-gate",
      adjudication_gate_pending: false,
    });
  });
});

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
  assessCurrentEvidence,
  deriveReviewPushThroughCandidate,
  waiverInForce,
  type AuthenticatedReviewPushThroughFacts,
  type EvidenceSubject,
  type ReviewPushThroughAuthoritySource,
} from "../../src/review/fixed-point.js";
import { deriveEvidenceSetFromCounter, type RetainedEvidenceSet } from "../../src/state/evidence-results.js";
import { resolvedConstitutionFixture } from "../helpers/resolved-constitution.js";

const digest = (text: string) => parseSha256Digest(createHash("sha256").update(text).digest("hex"));
const task = parseTaskSlug("push-through-policy");
const phase = encodePhaseInstance({ kind: "phase-impl", phase: 7 as never });
const subjectDigest = digest("subject");
const inputFingerprint = digest("input");
const envelopeDigest = digest("envelope");
const upstreamDigest = digest("upstream");

const constitution = await resolvedConstitutionFixture({
  "20-human-boundary.md": `---
id: human-boundary
version: 1
status: active
review_trigger: Human trust boundaries require review.
---
Human trust boundaries remain effective.
`,
});

type PolicyCase = "fail" | "uncertain" | "trigger" | "drift";

function state(): TaskStateV1 {
  return {
    schema_version: "1",
    task_id: task,
    repository_identity_digest: digest("repository"),
    revision: parseSafeInteger(12),
    phase_instance: phase,
    step: "triage",
    status: "succeeded",
    attempt: parseSafeInteger(2),
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

function review(): Readonly<{ evidence: ReviewEvidence; digest: ReturnType<typeof digest>; set: ReturnType<typeof deriveEvidenceSetFromCounter> }> {
  const findings: readonly ReviewFindingV2[] = [{
    finding_id: "ordinary-defect",
    claim_type: "defect",
    confidence: "certain",
    falsifier: "A direct behavior test disproves the defect.",
    summary: "The ordinary rubric finding remains accepted.",
    evidence: "The reviewer identified the same behavior gap.",
    suggested_resolution: "Revise the implementation.",
  }];
  const evidence: ReviewEvidence = {
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
    total_findings: 1,
    partition_counts: computeFindingPartitionCounts(findings),
    assurance: "server-attested",
    envelope_input_digest: envelopeDigest,
    observed_output_digest: digest("output"),
    adapter: "codex-cli",
    cli_version: "1.0.0",
    invocation_id: "policy-review" as never,
    result_id: "policy-review-result" as never,
    model_family: "codex",
    model: "gpt-test",
    effort: "high",
  };
  const set = deriveEvidenceSetFromCounter(evidence);
  return Object.freeze({ evidence, digest: set.reviews[0]!.evidence_digest, set });
}

function adjudication(policyCase: PolicyCase): AdjudicationEvidence {
  const compliance = policyCase === "fail" ? "fail" : policyCase === "uncertain" ? "uncertain" : "pass";
  const trigger = policyCase === "trigger" ? "matched" : "not-matched";
  const approvedUpstreams = policyCase === "drift" ? [upstreamDigest] : [];
  const derived = parseAndDeriveAdjudication({
    schema_version: "1",
    task_id: task,
    phase_instance: phase,
    step: "adjudicate",
    subject_digest: subjectDigest,
    input_fingerprint: inputFingerprint,
    pinned_constitution_digest: constitution.digest,
    source_review_envelope_digest: envelopeDigest,
    approved_upstream_digests: approvedUpstreams,
    rule_findings: [{
      rule_id: "human-boundary",
      rule_version: parseSafeInteger(1),
      compliance,
      rationale: `Policy compliance is ${compliance}.`,
      trigger,
      trigger_evidence: `Review trigger is ${trigger}.`,
    }],
    drift_findings: policyCase === "drift"
      ? [{
          upstream_digest: upstreamDigest,
          drift: "material",
          affected_claim_ids: ["current-behavior"],
          rationale: "The implementation materially departs from its approved upstream.",
        }]
      : [],
  });
  return {
    ...derived,
    assurance: "degraded",
    reason: "Focused policy preservation fixture.",
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

function retained(policyCase: PolicyCase): RetainedEvidenceSet {
  const current = review();
  const triage: TriageCandidate = {
    schema_version: "1",
    task_id: task,
    phase_instance: phase,
    step: "triage",
    subject_digest: subjectDigest,
    input_fingerprint: inputFingerprint,
    current_evidence_set_digest: current.set.current_evidence_set.set_digest,
    source_evidence_digests: [current.digest],
    dispositions: [{
      review_evidence_digest: current.digest,
      finding_id: "ordinary-defect",
      disposition: "accepted",
      rationale: "The ordinary finding is material.",
      revision_intent: "Revise the implementation.",
    }],
    accepted_count: 1,
    rejected_count: 0,
    accepted_editorial_count: 0,
    escalated_human_count: 0,
    deferred_count: 0,
    review_round_history: [
      { attempt: parseSafeInteger(1), review_evidence_digest: current.digest },
      { attempt: parseSafeInteger(2), review_evidence_digest: current.digest },
    ],
  };
  return new Map([
    ["counter_review", {
      reference: { result_digest: digest("review-result"), step: "counter_review" } as never,
      manifest: manifest("counter_review", current.evidence, current.digest),
    }],
    ["triage", {
      reference: { result_digest: digest("triage-result"), step: "triage" } as never,
      manifest: manifest("triage", triage, digest("triage-artifact")),
    }],
    ["adjudicate", {
      reference: { result_digest: digest("adjudication-result"), step: "adjudicate" } as never,
      manifest: manifest("adjudicate", adjudication(policyCase), digest("adjudication-artifact")),
    }],
  ]) as RetainedEvidenceSet;
}

function authoritySource(facts: AuthenticatedReviewPushThroughFacts): ReviewPushThroughAuthoritySource {
  const value = Object.freeze({ facts });
  const brand = new WeakSet<object>([value]);
  return Object.freeze({
    values: Object.freeze([value]),
    authenticate(candidate: unknown) {
      if (typeof candidate !== "object" || candidate === null || !brand.has(candidate)) {
        throw new TypeError("authenticated push-through required");
      }
      return (candidate as typeof value).facts;
    },
  });
}

function subjectFor(policyCase: PolicyCase, evidence: RetainedEvidenceSet): EvidenceSubject {
  const base: EvidenceSubject = {
    subject_digest: subjectDigest,
    input_fingerprint: inputFingerprint,
    constitution,
    approved_upstream_digests: policyCase === "drift" ? [upstreamDigest] : [],
    max_attempts: 2,
  };
  const candidate = deriveReviewPushThroughCandidate(state(), evidence, base)!;
  const facts: AuthenticatedReviewPushThroughFacts = {
    task_id: task,
    phase_instance: phase,
    attempt: candidate.attempt,
    subject_digest: candidate.subject_digest,
    current_evidence_set_digest: candidate.context.current_evidence_set_digest,
    triage_result_digest: candidate.context.triage_result_digest,
    accepted_occurrences: candidate.context.accepted_occurrences,
  };
  return Object.freeze({ ...base, review_push_through_authority: authoritySource(facts) });
}

describe("review push-through policy preservation", () => {
  it.each([
    ["constitution failure", "fail"],
    ["constitution uncertainty", "uncertain"],
    ["matched review trigger", "trigger"],
    ["material upstream drift", "drift"],
  ] as const)("does not bypass %s", (_label, policyCase) => {
    const evidence = retained(policyCase);
    const assessment = assessCurrentEvidence(state(), evidence, subjectFor(policyCase, evidence));
    expect(assessment).toMatchObject({
      blocker_remains: false,
      reentry_required: false,
      next: "adjudication-gate",
    });
  });

  it("never creates or satisfies constitution waiver authority", () => {
    const evidence = retained("fail");
    const currentState = state();
    const before = waiverInForce(
      currentState,
      { rule_id: "human-boundary", rule_version: 1 },
      subjectDigest,
      { operation: "adjudication-failure", boundary: "subject" },
    );
    expect(before).toBeUndefined();
    assessCurrentEvidence(currentState, evidence, subjectFor("fail", evidence));
    expect(currentState.waivers).toEqual([]);
    expect(waiverInForce(
      currentState,
      { rule_id: "human-boundary", rule_version: 1 },
      subjectDigest,
      { operation: "adjudication-failure", boundary: "subject" },
    )).toBeUndefined();
  });
});

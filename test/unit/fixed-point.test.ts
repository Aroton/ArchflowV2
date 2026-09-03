import { describe, expect, it } from "vitest";
import { createHash } from "node:crypto";

import { parseSha256Digest, parseTaskSlug, parseSafeInteger } from "../../src/contracts/evidence.js";
import { encodePhaseInstance } from "../../src/contracts/phase-instance.js";
import type { TaskStateV1 } from "../../src/contracts/durable-state.js";
import type { RetainedEvidenceSet } from "../../src/state/evidence-results.js";
import { deriveEvidenceSetFromCounter } from "../../src/state/evidence-results.js";
import type { EvidenceSubject } from "../../src/review/fixed-point.js";
import { assessCurrentEvidence } from "../../src/review/fixed-point.js";
import type { TriageCandidate } from "../../src/contracts/triage.js";
import type { ResultManifestV1 } from "../../src/contracts/durable-result-manifest.js";
import { resolvedConstitutionFixture } from "../helpers/resolved-constitution.js";
import type { ResolvedConstitution } from "../../src/state/constitution.js";
import { computeFindingPartitionCounts, type ReviewEvidence, type ReviewFindingV2 } from "../../src/contracts/review.js";

const digest = (content: string) => parseSha256Digest(createHash("sha256").update(content).digest("hex"));
const TASK = parseTaskSlug("fixed-point-test-task");
const phase = encodePhaseInstance({ kind: "design" });
const subjectDigest = digest("a");
const inputFingerprint = digest("b");
const envelopeDigest = digest("env-input");

const constitution = await resolvedConstitutionFixture({
  "01-rule-1.md": `---
id: rule-1
version: 1
status: active
review_trigger: A rule trigger matched.
---
Rule 1 text
`,
});

function baseState(resolved: ResolvedConstitution = constitution): TaskStateV1 {
  return {
    schema_version: "1",
    task_id: TASK,
    repository_identity_digest: digest("r"),
    revision: parseSafeInteger(1),
    phase_instance: phase,
    step: "triage",
    status: "succeeded",
    attempt: parseSafeInteger(1),
    input_fingerprint: inputFingerprint,
    initialization_digest: digest("i"),
    config_digest: digest("k"),
    workflow_digest: digest("w"),
    constitution_digest: resolved.digest,
    policy_base_commit: resolved.policy_base_commit,
    authoritative_results: [],
    approvals: [],
    waivers: [],
  };
}

function makeManifest(step: "counter_review" | "triage" | "adjudicate", evidence: unknown, artifactDigest = digest("1")): ResultManifestV1 {
  return {
    schema_version: "1",
    task_id: TASK,
    repository_identity_digest: digest("r"),
    result_id: `res-${step}` as never,
    phase_instance: phase,
    operation: "fixed-point" as never,
    measured_at_revision: parseSafeInteger(1),
    input_fingerprint: inputFingerprint,
    artifact_digest: artifactDigest,
    accounting: { input_bytes: 1, retained_bytes: 1 },
    outputs: [],
    secret_scan: {
      schema_version: "1",
      outcome: "clean",
      detector_set_id: "det" as never,
      scanned_paths: [],
    },
    source_artifact: {
      schema_version: "1",
      artifact_kind: step === "counter_review" ? "review-evidence" : step === "triage" ? "triage" : "adjudication-evidence",
      evidence,
    },
  } as never;
}

import { parseAndDeriveAdjudication, type AdjudicationEvidence } from "../../src/contracts/adjudication.js";

function makeReviewEvidence(findings: readonly ReviewFindingV2[]): { review: ReviewEvidence; reviewDigest: ReturnType<typeof digest>; setDigest: ReturnType<typeof digest> } {
  const hasDefect = findings.some((f) => f.claim_type === "defect");
  const verdict = hasDefect ? "review-raised" : findings.length > 0 ? "advisory" : "pass";
  const review: ReviewEvidence = {
    schema_version: "2",
    task_id: TASK,
    phase_instance: phase,
    step: "counter_review",
    role: "counter-review",
    subject_digest: subjectDigest,
    input_fingerprint: inputFingerprint,
    rubric_digest: digest("rubric"),
    producer_family: "claude",
    verdict,
    total_findings: findings.length,
    partition_counts: computeFindingPartitionCounts(findings),
    assurance: "server-attested",
    envelope_input_digest: envelopeDigest,
    observed_output_digest: digest("output"),
    adapter: "claude-cli",
    cli_version: "1.0.0",
    invocation_id: "inv-1" as never,
    result_id: "res-1" as never,
    model_family: "codex",
    model: "model",
    effort: "high",
    matched_rule_versions: [],
    findings: findings as never,
  };
  const derived = deriveEvidenceSetFromCounter(review);
  return {
    review,
    reviewDigest: derived.reviews[0]!.evidence_digest,
    setDigest: derived.current_evidence_set.set_digest,
  };
}

function makeAdjudicationEvidence(compliance: "pass" | "fail", trigger: "not-matched" | "matched"): AdjudicationEvidence {
  const derived = parseAndDeriveAdjudication({
    schema_version: "1",
    task_id: TASK,
    phase_instance: phase,
    step: "adjudicate",
    subject_digest: subjectDigest,
    input_fingerprint: inputFingerprint,
    pinned_constitution_digest: constitution.digest,
    source_review_envelope_digest: envelopeDigest,
    approved_upstream_digests: [],
    rule_findings: [{
      rule_id: "rule-1",
      rule_version: parseSafeInteger(1),
      compliance,
      rationale: `rule ${compliance}`,
      trigger,
      trigger_evidence: `trigger ${trigger}`,
    }],
    drift_findings: [],
  });
  return {
    ...derived,
    assurance: "degraded",
    reason: "test",
    model_family: "codex",
    model: "model",
    effort: "high",
  };
}

describe("fixed-point taxonomy and escalation handling", () => {
  it("advances cleanly when all findings are rejected or deferred", () => {
    const findings: ReviewFindingV2[] = [
      { finding_id: "f1", claim_type: "defect", confidence: "certain", falsifier: "f", summary: "s", evidence: "e", suggested_resolution: "r" },
      { finding_id: "f2", claim_type: "risk", confidence: "likely", falsifier: "f", summary: "s", evidence: "e", suggested_resolution: "r" },
    ];
    const { review, reviewDigest, setDigest } = makeReviewEvidence(findings);

    const triage: TriageCandidate = {
      schema_version: "1",
      task_id: TASK,
      phase_instance: phase,
      step: "triage",
      subject_digest: subjectDigest,
      input_fingerprint: inputFingerprint,
      current_evidence_set_digest: setDigest,
      source_evidence_digests: [reviewDigest],
      dispositions: [
        { review_evidence_digest: reviewDigest, finding_id: "f1", disposition: "rejected", rationale: "not a bug", evidence: "proven" },
        { review_evidence_digest: reviewDigest, finding_id: "f2", disposition: "deferred", rationale: "postponed", evidence: "tested ok" },
      ],
      accepted_count: 0,
      rejected_count: 1,
      accepted_editorial_count: 0,
      escalated_human_count: 0,
      deferred_count: 1,
    };

    const adjudicationEvidence = makeAdjudicationEvidence("pass", "not-matched");

    const retained: RetainedEvidenceSet = new Map([
      ["counter_review", {
        reference: { result_digest: digest("res-rev"), step: "counter_review" } as never,
        manifest: makeManifest("counter_review", review, reviewDigest),
      }],
      ["triage", {
        reference: { result_digest: digest("res-triage"), step: "triage" } as never,
        manifest: makeManifest("triage", triage, digest("triage-art")),
      }],
      ["adjudicate", {
        reference: { result_digest: digest("res-adj"), step: "adjudicate" } as never,
        manifest: makeManifest("adjudicate", adjudicationEvidence, digest("adj-art")),
      }],
    ]);

    const subject: EvidenceSubject = {
      subject_digest: subjectDigest,
      input_fingerprint: inputFingerprint,
      constitution,
    };

    const assessment = assessCurrentEvidence(baseState(), retained, subject);
    expect(assessment.every_finding_dispositioned).toBe(true);
    expect(assessment.blocker_remains).toBe(false);
    expect(assessment.next).toBe("advance");
  });

  it("returns advance with escalated_human_findings when escalation is unsettled and policy passes", () => {
    const findings: ReviewFindingV2[] = [
      { finding_id: "f1", claim_type: "risk", confidence: "likely", falsifier: "f", summary: "s", evidence: "e", suggested_resolution: "r" },
    ];
    const { review, reviewDigest, setDigest } = makeReviewEvidence(findings);

    const triage: TriageCandidate = {
      schema_version: "1",
      task_id: TASK,
      phase_instance: phase,
      step: "triage",
      subject_digest: subjectDigest,
      input_fingerprint: inputFingerprint,
      current_evidence_set_digest: setDigest,
      source_evidence_digests: [reviewDigest],
      dispositions: [
        { review_evidence_digest: reviewDigest, finding_id: "f1", disposition: "escalated-human", rationale: "needs human call" },
      ],
      accepted_count: 0,
      rejected_count: 0,
      accepted_editorial_count: 0,
      escalated_human_count: 1,
      deferred_count: 0,
    };

    const adjudicationEvidence = makeAdjudicationEvidence("pass", "not-matched");

    const retained: RetainedEvidenceSet = new Map([
      ["counter_review", {
        reference: { result_digest: digest("res-rev"), step: "counter_review" } as never,
        manifest: makeManifest("counter_review", review, reviewDigest),
      }],
      ["triage", {
        reference: { result_digest: digest("res-triage"), step: "triage" } as never,
        manifest: makeManifest("triage", triage, digest("triage-art")),
      }],
      ["adjudicate", {
        reference: { result_digest: digest("res-adj"), step: "adjudicate" } as never,
        manifest: makeManifest("adjudicate", adjudicationEvidence, digest("adj-art")),
      }],
    ]);

    const subject: EvidenceSubject = {
      subject_digest: subjectDigest,
      input_fingerprint: inputFingerprint,
      constitution,
    };

    const assessment = assessCurrentEvidence(baseState(), retained, subject);
    expect(assessment.escalated_human_findings).toBe(true);
    expect(assessment.next).toBe("advance");
  });

  it("returns adjudication-gate with escalated_human_findings when escalation exists and policy fails", () => {
    const findings: ReviewFindingV2[] = [
      { finding_id: "f1", claim_type: "risk", confidence: "likely", falsifier: "f", summary: "s", evidence: "e", suggested_resolution: "r" },
    ];
    const { review, reviewDigest, setDigest } = makeReviewEvidence(findings);

    const triage: TriageCandidate = {
      schema_version: "1",
      task_id: TASK,
      phase_instance: phase,
      step: "triage",
      subject_digest: subjectDigest,
      input_fingerprint: inputFingerprint,
      current_evidence_set_digest: setDigest,
      source_evidence_digests: [reviewDigest],
      dispositions: [
        { review_evidence_digest: reviewDigest, finding_id: "f1", disposition: "escalated-human", rationale: "needs human call" },
      ],
      accepted_count: 0,
      rejected_count: 0,
      accepted_editorial_count: 0,
      escalated_human_count: 1,
      deferred_count: 0,
    };

    const adjudicationEvidence = makeAdjudicationEvidence("fail", "matched");

    const retained: RetainedEvidenceSet = new Map([
      ["counter_review", {
        reference: { result_digest: digest("res-rev"), step: "counter_review" } as never,
        manifest: makeManifest("counter_review", review, reviewDigest),
      }],
      ["triage", {
        reference: { result_digest: digest("res-triage"), step: "triage" } as never,
        manifest: makeManifest("triage", triage, digest("triage-art")),
      }],
      ["adjudicate", {
        reference: { result_digest: digest("res-adj"), step: "adjudicate" } as never,
        manifest: makeManifest("adjudicate", adjudicationEvidence, digest("adj-art")),
      }],
    ]);

    const subject: EvidenceSubject = {
      subject_digest: subjectDigest,
      input_fingerprint: inputFingerprint,
      constitution,
    };

    const assessment = assessCurrentEvidence(baseState(), retained, subject);
    expect(assessment.escalated_human_findings).toBe(true);
    expect(assessment.next).toBe("adjudication-gate");
    expect(assessment.adjudication_gate_pending).toBe(true);
  });
});

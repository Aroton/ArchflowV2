import { describe, expect, it } from "vitest";

import type { AuthoritativeResultRef } from "../../src/contracts/durable-state.js";
import { parseSafeInteger, parseSha256Digest } from "../../src/contracts/evidence.js";
import type { TriageDisposition } from "../../src/contracts/triage.js";
import { computeDispositionLedger } from "../../src/state/evidence-results.js";

const digest = (character: string) => parseSha256Digest(character.repeat(64));
const REVIEW = digest("1");
const attempt = parseSafeInteger(2);
const ref = (step: string) => ({ step }) as never as AuthoritativeResultRef;

const dispositions: readonly TriageDisposition[] = [
  { review_evidence_digest: REVIEW, finding_id: "digest-drift", disposition: "accepted", rationale: "Real defect.", revision_intent: "Recompute." },
  { review_evidence_digest: REVIEW, finding_id: "naming-nit", disposition: "rejected", rationale: "Not applicable.", evidence: "Convention says otherwise." },
];

const finding = (finding_id: string, severity: "blocker" | "minor") => ({
  finding_id, severity, blocking: severity === "blocker",
  summary: `${finding_id} summary`, evidence: `${finding_id} evidence`,
  suggested_resolution: `${finding_id} resolution`,
});

const taxonomyFinding = (finding_id: string) => ({
  finding_id, claim_type: "risk", confidence: "likely",
  summary: `${finding_id} summary`, evidence: `${finding_id} evidence`,
  suggested_resolution: `${finding_id} resolution`, falsifier: `${finding_id} falsifier`,
});

const installation = (source: Record<string, unknown>, artifactDigest = REVIEW) => ({
  prepared: { manifest: { value: { artifact_digest: artifactDigest, source_artifact: source } } },
}) as never;

const loaderWith =
  (results: Record<string, unknown>) =>
    (async (reference: { step: string }) =>
      results[reference.step] === undefined
        ? { schema_version: "1", ok: false, error: { code: "IO_ERROR" } }
        : { schema_version: "1", ok: true, value: results[reference.step] }) as never;

const reviewInstallation = installation({
  artifact_kind: "review-evidence",
  evidence: { findings: [finding("digest-drift", "blocker"), finding("naming-nit", "minor")] },
});

describe("computeDispositionLedger", () => {
  it("embeds the current round's dispositions with their round's finding details", async () => {
    const ledger = await computeDispositionLedger(
      dispositions,
      { attempt, review_ref: ref("counter_review") },
      loaderWith({ counter_review: reviewInstallation }),
    );
    expect(ledger).toEqual([
      {
        review_evidence_digest: REVIEW, finding_id: "digest-drift", disposition: "accepted", attempt,
        rationale: "Real defect.", revision_intent: "Recompute.",
        severity: "blocker", blocking: true, summary: "digest-drift summary",
        evidence: "digest-drift evidence", suggested_resolution: "digest-drift resolution",
      },
      {
        review_evidence_digest: REVIEW, finding_id: "naming-nit", disposition: "rejected", attempt,
        rationale: "Not applicable.", evidence: "Convention says otherwise.",
        severity: "minor", blocking: false, summary: "naming-nit summary",
        suggested_resolution: "naming-nit resolution",
      },
    ]);
  });

  it("embeds the complete V2 taxonomy from the exact reviewed occurrence", async () => {
    const evidence = digest("2");
    const ledger = await computeDispositionLedger(
      [{ review_evidence_digest: evidence, finding_id: "runtime-risk", disposition: "rejected", rationale: "Refuted.", evidence: "Covered by the invariant." }],
      { attempt, review_ref: ref("counter_review") },
      loaderWith({ counter_review: installation({ artifact_kind: "review-evidence", evidence: { findings: [taxonomyFinding("runtime-risk")] } }, evidence) }),
    );
    expect(ledger[0]).toMatchObject({
      claim_type: "risk", confidence: "likely", falsifier: "runtime-risk falsifier",
      summary: "runtime-risk summary", suggested_resolution: "runtime-risk resolution",
    });
    expect(ledger[0]).not.toHaveProperty("severity");
    expect(ledger[0]).not.toHaveProperty("blocking");
  });

  it("preserves V3 test attribution and native detail independently of disposition evidence", async () => {
    const evidence = digest("3");
    const testFinding = {
      finding_id: "test-oracle-gap", criterion_id: "test-quality",
      claim_type: "gap", confidence: "certain", falsifier: "run the recovery test",
      reviewer_id: "test", reviewer_focus: "tests", routing_role: "test-reviewer",
      required_behavior_or_risk_boundary: "recovery remains covered",
      coverage_or_oracle_problem: "the oracle accepts a bad value",
      consequence: "a regression escapes",
      proposed_verification_change: "assert the recovered value",
    };
    const ledger = await computeDispositionLedger(
      [{ review_evidence_digest: evidence, finding_id: "test-oracle-gap", disposition: "rejected", rationale: "Refuted.", evidence: "The branch is already asserted." }],
      { attempt, review_ref: ref("counter_review") },
      loaderWith({ counter_review: installation({ artifact_kind: "review-evidence", evidence: { findings: [testFinding] } }, evidence) }),
    );
    expect(ledger[0]).toMatchObject({
      reviewer_id: "test", reviewer_focus: "tests", routing_role: "test-reviewer", criterion_id: "test-quality",
      required_behavior_or_risk_boundary: "recovery remains covered",
      coverage_or_oracle_problem: "the oracle accepts a bad value",
      consequence: "a regression escapes",
      proposed_verification_change: "assert the recovered value",
      disposition_evidence: "The branch is already asserted.",
    });
    expect(ledger[0]).not.toHaveProperty("evidence");
  });

  it("carries the predecessor ledger and replaces only an exact occurrence replay", async () => {
    const previous = installation({
      artifact_kind: "triage",
      evidence: {
        dispositions: [],
        disposition_ledger: [
          { review_evidence_digest: digest("9"), finding_id: "older-round", disposition: "rejected", attempt: 1, rationale: "older rejection", evidence: "older rejection evidence" },
          { review_evidence_digest: REVIEW, finding_id: "digest-drift", disposition: "accepted", attempt: 1, rationale: "stale embed", revision_intent: "stale intent", severity: "blocker", blocking: true, summary: "stale summary", evidence: "stale finding evidence", suggested_resolution: "stale resolution" },
        ],
      },
    });
    const ledger = await computeDispositionLedger(
      dispositions,
      { attempt, previous_triage_ref: ref("triage"), review_ref: ref("counter_review") },
      loaderWith({ triage: previous, counter_review: reviewInstallation }),
    );
    expect(ledger.map((entry) => `${entry.review_evidence_digest}:${entry.finding_id}`)).toEqual([
      `${digest("9")}:older-round`, `${REVIEW}:digest-drift`, `${REVIEW}:naming-nit`,
    ]);
    expect(ledger.find((entry) => entry.finding_id === "digest-drift")).toMatchObject({
      attempt, rationale: "Real defect.", revision_intent: "Recompute.",
      summary: "digest-drift summary", evidence: "digest-drift evidence",
    });
  });

  it("retains recurring finding ids from distinct authenticated evidence", async () => {
    const previousDigest = digest("8");
    const previous = installation({
      artifact_kind: "triage",
      evidence: { disposition_ledger: [{
        review_evidence_digest: previousDigest, finding_id: "same-id", disposition: "rejected",
        attempt: 1, rationale: "Earlier occurrence.", evidence: "Earlier evidence.",
      }] },
    });
    const ledger = await computeDispositionLedger(
      [{ review_evidence_digest: REVIEW, finding_id: "same-id", disposition: "accepted", rationale: "Current occurrence.", revision_intent: "Fix it." }],
      { attempt, previous_triage_ref: ref("triage") },
      loaderWith({ triage: previous }),
    );
    expect(ledger.map((entry) => entry.review_evidence_digest)).toEqual([previousDigest, REVIEW]);
  });

  it("carries nothing from an unloadable predecessor or review", async () => {
    const ledger = await computeDispositionLedger(
      dispositions,
      { attempt, previous_triage_ref: ref("triage"), review_ref: ref("counter_review") },
      loaderWith({}),
    );
    expect(ledger).toHaveLength(2);
    for (const entry of ledger) {
      expect(entry).not.toHaveProperty("severity");
      expect(entry).not.toHaveProperty("summary");
    }
  });

  it("carries nothing from a predecessor installed before reviewer memory", async () => {
    const previous = installation({
      artifact_kind: "triage",
      evidence: { dispositions: [{ review_evidence_digest: digest("9"), finding_id: "gone", disposition: "rejected", rationale: "old", evidence: "old" }] },
    });
    const ledger = await computeDispositionLedger(
      dispositions,
      { attempt, previous_triage_ref: ref("triage"), review_ref: ref("counter_review") },
      loaderWith({ triage: previous, counter_review: reviewInstallation }),
    );
    expect(ledger.map((entry) => entry.finding_id)).toEqual(["digest-drift", "naming-nit"]);
  });

  it("resolves finding details only for the exact reviewed evidence digest", async () => {
    const stale = [{ ...dispositions[0]!, review_evidence_digest: digest("2") }];
    const ledger = await computeDispositionLedger(
      stale,
      { attempt, review_ref: ref("counter_review") },
      loaderWith({ counter_review: reviewInstallation }),
    );
    expect(ledger[0]).not.toHaveProperty("severity");
    expect(ledger[0]).not.toHaveProperty("summary");
  });

  it("embeds accepted-editorial, escalated-human, and deferred dispositions into ledger", async () => {
    const mixedReview = installation({
      artifact_kind: "review-evidence",
      evidence: { findings: [
        taxonomyFinding("f1"),
        taxonomyFinding("f2"),
        taxonomyFinding("f3"),
      ] },
    });
    const mixedDispositions: readonly TriageDisposition[] = [
      { review_evidence_digest: REVIEW, finding_id: "f1", disposition: "accepted-editorial", rationale: "Style tweak", revision_intent: "Fix spelling" },
      { review_evidence_digest: REVIEW, finding_id: "f2", disposition: "escalated-human", rationale: "Needs human call" },
      { review_evidence_digest: REVIEW, finding_id: "f3", disposition: "deferred", rationale: "Not in scope", evidence: "Verified non-blocking" },
    ];
    const ledger = await computeDispositionLedger(
      mixedDispositions,
      { attempt, review_ref: ref("counter_review") },
      loaderWith({ counter_review: mixedReview }),
    );
    expect(ledger).toEqual([
      {
        review_evidence_digest: REVIEW, finding_id: "f1", disposition: "accepted-editorial", attempt,
        rationale: "Style tweak", revision_intent: "Fix spelling",
        claim_type: "risk", confidence: "likely", falsifier: "f1 falsifier",
        summary: "f1 summary", suggested_resolution: "f1 resolution",
        evidence: "f1 evidence",
      },
      {
        review_evidence_digest: REVIEW, finding_id: "f2", disposition: "escalated-human", attempt,
        rationale: "Needs human call",
        claim_type: "risk", confidence: "likely", falsifier: "f2 falsifier",
        summary: "f2 summary", suggested_resolution: "f2 resolution",
        evidence: "f2 evidence",
      },
      {
        review_evidence_digest: REVIEW, finding_id: "f3", disposition: "deferred", attempt,
        rationale: "Not in scope", evidence: "Verified non-blocking",
        claim_type: "risk", confidence: "likely", falsifier: "f3 falsifier",
        summary: "f3 summary", suggested_resolution: "f3 resolution",
      },
    ]);
  });
});

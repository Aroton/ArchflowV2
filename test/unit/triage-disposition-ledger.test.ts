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

const installation = (source: Record<string, unknown>) => ({
  prepared: { manifest: { value: { artifact_digest: REVIEW, source_artifact: source } } },
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

  it("carries the predecessor's ledger forward and lets the newest disposition win", async () => {
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
    expect(ledger.map((entry) => entry.finding_id)).toEqual(["older-round", "digest-drift", "naming-nit"]);
    const redispositioned = ledger.find((entry) => entry.finding_id === "digest-drift")!;
    expect(redispositioned).toMatchObject({
      attempt, rationale: "Real defect.", revision_intent: "Recompute.",
      summary: "digest-drift summary", evidence: "digest-drift evidence",
    });
    expect(ledger.find((entry) => entry.finding_id === "older-round")).toMatchObject({
      attempt: 1, rationale: "older rejection", evidence: "older rejection evidence",
    });
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
});

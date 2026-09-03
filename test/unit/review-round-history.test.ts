import { describe, expect, it } from "vitest";

import type { AuthoritativeResultRef } from "../../src/contracts/durable-state.js";
import { parseSafeInteger, parseSha256Digest } from "../../src/contracts/evidence.js";
import { computeReviewRoundHistory } from "../../src/state/evidence-results.js";

const digest = (character: string) => parseSha256Digest(character.repeat(64));
const reviewDigest = digest("1");
const ref = (step: "counter_review" | "triage") => ({ step }) as never as AuthoritativeResultRef;

const installation = (source: Record<string, unknown>, artifactDigest = reviewDigest) => ({
  prepared: { manifest: { value: { artifact_digest: artifactDigest, source_artifact: source } } },
}) as never;

const loaderWith = (results: Record<string, unknown>) =>
  (async (reference: { step: string }) => results[reference.step] === undefined
    ? { schema_version: "1", ok: false, error: { code: "IO_ERROR" } }
    : { schema_version: "1", ok: true, value: results[reference.step] }) as never;

describe("completed review round history", () => {
  it("retains a finding-free predecessor and byte-identical repeated review as distinct attempts", async () => {
    const previous = installation({
      artifact_kind: "triage",
      evidence: {
        dispositions: [],
        disposition_ledger: [],
        review_round_history: [{ attempt: parseSafeInteger(1), review_evidence_digest: reviewDigest }],
      },
    });
    const current = installation({ artifact_kind: "review-evidence", evidence: { findings: [] } });
    const history = await computeReviewRoundHistory(
      {
        attempt: parseSafeInteger(2),
        previous_triage_ref: ref("triage"),
        review_ref: ref("counter_review"),
      },
      loaderWith({ triage: previous, counter_review: current }),
    );
    expect(history).toEqual([
      { attempt: 1, review_evidence_digest: reviewDigest },
      { attempt: 2, review_evidence_digest: reviewDigest },
    ]);
  });

  it("backfills unambiguous pre-history attempts from the server-computed disposition ledger", async () => {
    const previousDigest = digest("8");
    const previous = installation({
      artifact_kind: "triage",
      evidence: {
        disposition_ledger: [{
          attempt: parseSafeInteger(1),
          review_evidence_digest: previousDigest,
          finding_id: "older-finding",
          disposition: "accepted",
        }],
      },
    });
    const current = installation({ artifact_kind: "review-evidence", evidence: { findings: [] } });
    await expect(computeReviewRoundHistory(
      {
        attempt: parseSafeInteger(2),
        previous_triage_ref: ref("triage"),
        review_ref: ref("counter_review"),
      },
      loaderWith({ triage: previous, counter_review: current }),
    )).resolves.toEqual([
      { attempt: 1, review_evidence_digest: previousDigest },
      { attempt: 2, review_evidence_digest: reviewDigest },
    ]);
  });

  it("omits a conflicting attempt without blocking ordinary triage history", async () => {
    const previous = installation({
      artifact_kind: "triage",
      evidence: {
        review_round_history: [
          { attempt: parseSafeInteger(1), review_evidence_digest: digest("8") },
          { attempt: parseSafeInteger(2), review_evidence_digest: digest("9") },
        ],
      },
    });
    const current = installation({ artifact_kind: "review-evidence", evidence: { findings: [] } });
    await expect(computeReviewRoundHistory(
      {
        attempt: parseSafeInteger(2),
        previous_triage_ref: ref("triage"),
        review_ref: ref("counter_review"),
      },
      loaderWith({ triage: previous, counter_review: current }),
    )).resolves.toEqual([
      { attempt: 1, review_evidence_digest: digest("8") },
    ]);
  });
});

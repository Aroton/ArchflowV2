import { describe, expect, it } from "vitest";

import {
  canonicalDocument,
} from "../../src/contracts/canonical.js";
import {
  DURABLE_ISSUE_CODES,
  validateDurableSemantics,
} from "../../src/contracts/durable.js";
import {
  implementationOutputV1Schema,
} from "../../src/contracts/durable-implementation-output.js";
import { taskStateV1Schema } from "../../src/contracts/durable-state.js";
import { parsePathSafeId, parseSha256Digest } from "../../src/contracts/evidence.js";
import {
  authorityDecisionRecordClaim,
  authorityDecisionRequestClaim,
  authorityInitializationClaim,
  authorityResultClaim,
  authoritySupplementalReviewClaim,
  parsePathClass,
} from "../../src/contracts/path-claims.js";
import stateFixture from "../fixtures/contracts/durable/task-state.valid.json" with { type: "json" };
import implementationFixture from "../fixtures/contracts/durable/implementation-output.valid.json" with { type: "json" };

describe("durable authority contracts", () => {
  it("derives every tracked authority path from stable identity", () => {
    const digest = parseSha256Digest("a".repeat(64));
    const gate = parsePathSafeId("gate-1");
    expect(authorityInitializationClaim()).toBe("authority/initialization.json");
    expect(authorityResultClaim(digest)).toBe(`authority/results/${digest}.json`);
    expect(authorityDecisionRequestClaim(gate)).toBe("authority/decisions/gate-1/request.json");
    expect(authorityDecisionRecordClaim(gate)).toBe("authority/decisions/gate-1/decision.json");
    expect(authoritySupplementalReviewClaim(gate)).toBe("authority/decisions/gate-1/supplemental-review.json");
  });

  it("does not expose ignored workspace categories as durable path classes", () => {
    for (const retired of [
      "gate-interface", "verification-transcript", "review", "result-payload", "intent",
      "staged-request", "attempt", "maintenance-record", "import",
    ]) {
      expect(() => parsePathClass(retired)).toThrow();
    }
    for (const durable of ["authority-initialization", "authority-result", "authority-decision"]) {
      expect(parsePathClass(durable)).toBe(durable);
    }
  });

  it("requires self-contained last-transition replay authority", () => {
    expect(taskStateV1Schema.safeParse(stateFixture).success).toBe(true);
    const { last_transition: _last, ...withoutTransition } = stateFixture;
    expect(taskStateV1Schema.safeParse(withoutTransition).success).toBe(true);
    expect(taskStateV1Schema.safeParse({ ...stateFixture, committed_intent: stateFixture.last_transition }).success).toBe(false);
    expect(taskStateV1Schema.safeParse({ ...stateFixture, last_transition: { ...stateFixture.last_transition, outcome: undefined } }).success).toBe(false);
  });

  it("validates the embedded outcome digest and revision without a crash receipt", () => {
    const { open_gate: _openGate, ...closedState } = stateFixture;
    const valid = validateDurableSemantics({ state: canonicalDocument(closedState as never) });
    expect(valid.ok).toBe(true);
    const badOutcome = {
      ...closedState,
      last_transition: { ...stateFixture.last_transition, outcome_digest: "f".repeat(64) },
    };
    const outcomeResult = validateDurableSemantics({ state: canonicalDocument(badOutcome as never) });
    expect(outcomeResult.ok ? undefined : outcomeResult.error.diagnostic.parameters).toMatchObject({
      issue_code: DURABLE_ISSUE_CODES.lastTransitionOutcomeDigestMismatch,
    });
    const badRevision = {
      ...closedState,
      last_transition: { ...stateFixture.last_transition, prior_revision: 5 },
    };
    const revisionResult = validateDurableSemantics({ state: canonicalDocument(badRevision as never) });
    expect(revisionResult.ok ? undefined : revisionResult.error.diagnostic.parameters).toMatchObject({
      issue_code: DURABLE_ISSUE_CODES.lastTransitionRevisionMismatch,
    });
  });

  it("requires the transcript digest and byte count on implementation output", () => {
    expect(implementationOutputV1Schema.safeParse(implementationFixture).success).toBe(true);
    const { verification_evidence: _verification, ...withoutVerification } = implementationFixture;
    expect(implementationOutputV1Schema.safeParse(withoutVerification).success).toBe(false);
  });
});

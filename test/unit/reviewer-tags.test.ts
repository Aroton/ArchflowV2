import { describe, expect, it } from "vitest";

import { parseSafeInteger } from "../../src/contracts/evidence.js";
import { parsePhaseInstanceId } from "../../src/contracts/phase-instance.js";
import { priorTriageContextEntry, type PriorTriageRecord } from "../../src/review/pinned-context.js";
import {
  resolveReviewFindingOwner,
  reviewerFindingTag,
  reviewerOwnsFinding,
  taggedFindingId,
  type ReviewerRosterEntry,
} from "../../src/review/reviewer-tags.js";

const roster = Object.freeze([
  Object.freeze({ reviewer_id: "general-1", focus: "general", routing_role: "counter-reviewer", model: "gpt-5.6-sol" }),
  Object.freeze({ reviewer_id: "general-2", focus: "general", routing_role: "counter-reviewer", model: "claude-fable-5" }),
  Object.freeze({ reviewer_id: "test", focus: "tests", routing_role: "test-reviewer", model: "gpt-5.6-luna" }),
] satisfies readonly ReviewerRosterEntry[]);

describe("reviewer finding tags", () => {
  it("derives a stable tag from the model name, falling back to the configured position", () => {
    expect(reviewerFindingTag("gpt-5.6-sol", 0)).toBe("sol");
    expect(reviewerFindingTag("claude-fable-5", 1)).toBe("fable");
    expect(reviewerFindingTag("gemini-3.7-flash-high", 2)).toBe("flash");
    expect(reviewerFindingTag("glm-5.3", 1)).toBe("r2");
  });

  it("prefixes only when more than one reviewer is configured, and never twice", () => {
    expect(taggedFindingId("sol", 1, "missing-index")).toBe("missing-index");
    expect(taggedFindingId("sol", 2, "missing-index")).toBe("sol-missing-index");
    expect(taggedFindingId("sol", 2, "sol-missing-index")).toBe("sol-missing-index");
    expect(reviewerOwnsFinding("sol", 1, "anything")).toBe(true);
    expect(reviewerOwnsFinding("sol", 2, "sol-missing-index")).toBe(true);
    expect(reviewerOwnsFinding("sol", 2, "fable-missing-index")).toBe(false);
  });

  it("scopes the rendered prior-triage record to one reviewer's findings", () => {
    const record: PriorTriageRecord = {
      phase_instance: parsePhaseInstanceId("design"),
      current_attempt: parseSafeInteger(2),
      dispositions: [
        { finding_id: "sol-budget", disposition: "rejected", attempt: 1 },
        { finding_id: "fable-contract", disposition: "accepted", attempt: 1, revision_intent: "fix it" },
        { finding_id: "fable-older", disposition: "rejected", attempt: 0 },
      ],
      current: [
        { finding_id: "sol-budget", disposition: "rejected" },
        { finding_id: "fable-contract", disposition: "accepted" },
      ],
    };
    const decode = (entry: ReturnType<typeof priorTriageContextEntry>) => {
      if (entry.status !== "pinned") throw new Error("expected pinned entry");
      return JSON.parse(entry.content) as { dispositions: { finding_id: string }[]; coverage: string };
    };
    const all = decode(priorTriageContextEntry(record));
    expect(all.dispositions.map((d) => d.finding_id)).toEqual(["fable-contract"]);
    const fable = decode(priorTriageContextEntry(record, (id) => reviewerOwnsFinding("fable", 2, id)));
    expect(fable.dispositions.map((d) => d.finding_id)).toEqual(["fable-contract"]);
    expect(fable.coverage).toMatch(/assigned to this reviewer/u);
  });

  it("pins the prior-triage record whole even past the excerpt budget", () => {
    const record: PriorTriageRecord = {
      phase_instance: parsePhaseInstanceId("design"),
      current_attempt: parseSafeInteger(2),
      dispositions: [{ finding_id: "sol-budget", disposition: "accepted", attempt: 1, evidence: "x".repeat(30_000) }],
      current: [{ finding_id: "sol-budget", disposition: "accepted" }],
    };
    const entry = priorTriageContextEntry(record);
    expect(entry.status).toBe("pinned");
    if (entry.status !== "pinned") return;
    expect((JSON.parse(entry.content) as { dispositions: unknown[] }).dispositions).toHaveLength(1);
  });

  it("uses exact run membership before ID prose and maps a resized roster by its unique tuple", () => {
    const resolved = resolveReviewFindingOwner({
      schema_version: "2",
      finding: { finding_id: "general-2-owned" },
      reviewer_runs: [{
        reviewer_id: "general-2", focus: "general", routing_role: "counter-reviewer",
        model: "claude-fable-5", finding_ids: ["general-2-owned"],
      }],
      roster,
    });
    expect(resolved).toMatchObject({ ok: true, owner: { reviewer_id: "general-2" } });

    const resized = resolveReviewFindingOwner({
      schema_version: "2",
      finding: { finding_id: "owned" },
      reviewer_runs: [{
        reviewer_id: "general", focus: "general", routing_role: "counter-reviewer",
        model: "claude-fable-5", finding_ids: ["owned"],
      }],
      roster,
    });
    expect(resized).toMatchObject({ ok: true, owner: { reviewer_id: "general-2" } });
  });

  it("keeps the versioned run-less cohorts mutually exclusive", () => {
    for (const finding_id of ["test-strategy-oracle-missing", "general-2-owned", "escalate-now", "unverifiable-proof"]) {
      expect(resolveReviewFindingOwner({
        schema_version: "2", finding: { finding_id }, roster,
      })).toMatchObject({ ok: true, owner: { reviewer_id: "general-1" } });
    }
    expect(resolveReviewFindingOwner({
      schema_version: "1", finding: { finding_id: "fable-owned" }, roster,
    })).toMatchObject({ ok: true, owner: { reviewer_id: "general-1" } });
    expect(resolveReviewFindingOwner({
      schema_version: "2", finding: { finding_id: "fable-owned" }, roster,
    })).toEqual({ ok: false, failure: { reason: "legacy-alias-collision-unavailable" } });
  });

  it("never transfers a run-less V2 keyword-looking unprefixed ID to a current alias route", () => {
    const withFlash = [
      roster[0]!,
      { reviewer_id: "general-2", focus: "general", routing_role: "counter-reviewer", model: "gemini-3.7-flash-high" },
    ] satisfies readonly ReviewerRosterEntry[];
    for (const finding_id of ["flash-write-barrier-missing", "pro-rata-accounting-drift", "fable-owned"]) {
      expect(resolveReviewFindingOwner({ schema_version: "2", finding: { finding_id }, roster: withFlash }))
        .toEqual({ ok: false, failure: { reason: "legacy-alias-collision-unavailable" } });
    }
  });

  it("recognizes historical ordinal tags but never maps them to current positions", () => {
    expect(resolveReviewFindingOwner({
      schema_version: "2", finding: { finding_id: "r2-owned" }, roster,
    })).toEqual({ ok: false, failure: { reason: "legacy-ordinal-unavailable", historical_position: 2 } });
  });

  it("does not transfer a run-recorded test finding to general", () => {
    const noTest = roster.filter((entry) => entry.focus === "general");
    expect(resolveReviewFindingOwner({
      schema_version: "2",
      finding: { finding_id: "test-oracle" },
      reviewer_runs: [{
        reviewer_id: "test", focus: "tests", routing_role: "test-reviewer",
        model: "gpt-5.6-luna", finding_ids: ["test-oracle"],
      }],
      roster: noTest,
    })).toMatchObject({ ok: false, failure: { reason: "reviewer-route-unavailable" } });
  });

  it("maps a V3 run across roster resizing only through its unique recorded route tuple", () => {
    const single = [Object.freeze({
      reviewer_id: "general", focus: "general", routing_role: "counter-reviewer", model: "claude-fable-5",
    })] satisfies readonly ReviewerRosterEntry[];
    expect(resolveReviewFindingOwner({
      schema_version: "3",
      finding: {
        finding_id: "general-2-owned", reviewer_id: "general-2",
        reviewer_focus: "general", routing_role: "counter-reviewer",
      },
      reviewer_runs: [{
        reviewer_id: "general-2", focus: "general", routing_role: "counter-reviewer",
        model: "claude-fable-5", finding_ids: ["general-2-owned"],
      }],
      roster: single,
    })).toMatchObject({ ok: true, owner: { reviewer_id: "general" } });

    const ambiguous = [...single, { ...single[0]!, reviewer_id: "general-2" }];
    expect(resolveReviewFindingOwner({
      schema_version: "3",
      finding: {
        finding_id: "retired-owned", reviewer_id: "retired",
        reviewer_focus: "general", routing_role: "counter-reviewer",
      },
      reviewer_runs: [{
        reviewer_id: "retired", focus: "general", routing_role: "counter-reviewer",
        model: "claude-fable-5", finding_ids: ["retired-owned"],
      }],
      roster: ambiguous,
    })).toMatchObject({ ok: false, failure: { reason: "reviewer-route-ambiguous" } });
  });

  it("accepts a criterion-less legacy ID in V3 only when the run records its confirmation responsibility", () => {
    expect(resolveReviewFindingOwner({
      schema_version: "3",
      finding: {
        finding_id: "fable-historical", reviewer_id: "general-1",
        reviewer_focus: "general", routing_role: "counter-reviewer",
      },
      reviewer_runs: [{
        reviewer_id: "general-1", focus: "general", routing_role: "counter-reviewer",
        model: "gpt-5.6-sol", finding_ids: ["fable-historical"],
        legacy_confirmations: [{ finding_id: "fable-historical" }],
      }, {
        reviewer_id: "test", focus: "tests", routing_role: "test-reviewer",
        model: "gpt-5.6-luna", finding_ids: [],
      }],
      roster,
    })).toMatchObject({ ok: true, owner: { reviewer_id: "general-1" } });
  });
});

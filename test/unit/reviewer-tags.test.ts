import { describe, expect, it } from "vitest";

import { parseSafeInteger } from "../../src/contracts/evidence.js";
import { parsePhaseInstanceId } from "../../src/contracts/phase-instance.js";
import { priorTriageContextEntry, type PriorTriageRecord } from "../../src/review/pinned-context.js";
import { reviewerFindingTag, reviewerOwnsFinding, taggedFindingId } from "../../src/review/reviewer-tags.js";

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
        // Carried from an earlier round: in the ledger, not in the current dispositions.
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
    expect(all.dispositions.map((d) => d.finding_id)).toEqual(["sol-budget", "fable-contract", "fable-older"]);
    const fable = decode(priorTriageContextEntry(record, (id) => reviewerOwnsFinding("fable", 2, id)));
    expect(fable.dispositions.map((d) => d.finding_id)).toEqual(["fable-contract", "fable-older"]);
    expect(fable.coverage).toMatch(/this reviewer raised/u);
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
});

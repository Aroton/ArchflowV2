import { describe, expect, it } from "vitest";

import { resumeAdjudicationReplay } from "../../src/mcp/handlers/adjudicate.js";

describe("adjudication replay fixed-point driver", () => {
  it("resolves pending gates before returning the retained outcome and has no dispatch seam", async () => {
    let reads = 0;
    let gateCalls = 0;
    const retained = { path: "reviews/phase-impl-15.adjudication.md", constitution: "pass", drift: "none", triggers: [], revision: 5 } as const;
    const result = await resumeAdjudicationReplay({
      outcome: retained,
      load_frame: async () => {
        reads += 1;
        return reads === 1
          ? { schema_version: "1", ok: true, value: { next: "adjudication-gate", gate: {
              kind: "review-trigger", subject_digest: "a".repeat(64) as never,
              context: { matched_rules: [], uncertain_rules: [], eligible_waiver_rules: [], waiver_scope: { operation: "review-trigger", boundary: "subject" } },
            } } } as const
          : { schema_version: "1", ok: true, value: { next: "complete" } } as const;
      },
      resolve_gate: async () => {
        gateCalls += 1;
        return { schema_version: "1", ok: true, value: undefined } as const;
      },
    });
    expect(result).toEqual({ schema_version: "1", ok: true, value: retained });
    expect(gateCalls).toBe(1);
    expect(reads).toBe(2);
    expect(Object.keys({ load_frame: true, resolve_gate: true })).not.toContain("dispatch");
  });
});

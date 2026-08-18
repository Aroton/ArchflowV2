import { describe, expect, it } from "vitest";

import type { BaselineDriftedProjection } from "../../src/state/gates.js";
import { baselineAdoptionRecord } from "../../src/state/gates.js";

/**
 * The adoption record's projection sort must satisfy the durable-state schema's sorted-unique
 * refinement, which compares plain code units. `localeCompare` orders mixed-case path sets
 * differently (here: locale says a.md < B.md, code units say B.md < a.md), and once produced a
 * record that failed receipt parsing only after the decision had been archived on the live task.
 */
describe("the durable baseline adoption record", () => {
  it("orders adopted projections by code unit, not locale", () => {
    const drifted = [
      { path: "docs/a.md", recorded_digest: "0".repeat(64), observed_digest: "1".repeat(64) },
      { path: "docs/B.md", recorded_digest: "2".repeat(64), observed_digest: "3".repeat(64) },
    ] as unknown as readonly BaselineDriftedProjection[];
    // The witness: the two comparators genuinely disagree on this pair.
    expect("docs/a.md".localeCompare("docs/B.md")).toBeLessThan(0);
    expect("docs/a.md" < "docs/B.md").toBe(false);

    const record = baselineAdoptionRecord("gate-adoption" as never, 5 as never, drifted);
    expect(record.adopted_projections.map((projection) => projection.path)).toEqual(["docs/B.md", "docs/a.md"]);
    expect(record.adopted_projections.map((projection) => projection.content_digest)).toEqual(["3".repeat(64), "1".repeat(64)]);
  });
});

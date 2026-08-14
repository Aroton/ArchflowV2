import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import {
  parseArchivedGateDecisionRecord,
  parseArchivedGateRequest,
  parseGateDecisionRecord,
  parseGateRequest,
} from "../../src/contracts/durable-gate.js";

const fixture = (name: string): unknown => JSON.parse(readFileSync(join(
  import.meta.dirname,
  "../fixtures/contracts",
  `durable-gate-v1-pre-ad057d3-${name}.json`,
), "utf8"));

describe("durable gate V1 archive compatibility", () => {
  it("reads a retired request supersession without admitting it to the current writer shape", () => {
    const bytes = fixture("request-with-supersedes");
    const archived = parseArchivedGateRequest(bytes);

    expect(archived).toMatchObject({
      gate_id: "gate-legacy-2",
      supersedes: { superseded_gate_id: "gate-legacy-1" },
    });
    expect(archived).toEqual(bytes);
    expect(() => parseGateRequest(bytes)).toThrow();
  });

  it.each([
    ["empty", "decision-empty-supplemental", 0],
    ["non-empty", "decision-nonempty-supplemental", 1],
  ])("reads a retired decided record with a %s supplemental ledger", (_label, name, count) => {
    const bytes = fixture(name);
    const archived = parseArchivedGateDecisionRecord(bytes);

    expect(archived).toMatchObject({ outcome: "decided", supplemental: expect.any(Array) });
    expect("supplemental" in archived && archived.supplemental).toHaveLength(count);
    expect(archived).toEqual(bytes);
    expect(() => parseGateDecisionRecord(bytes)).toThrow();
  });

  it("reads a historical superseded outcome but does not reinterpret it as a decision", () => {
    const bytes = fixture("decision-superseded");
    const archived = parseArchivedGateDecisionRecord(bytes);

    expect(archived).toMatchObject({
      outcome: "superseded",
      supersession: { superseded_gate_id: "gate-legacy-1" },
    });
    expect(archived).toEqual(bytes);
    expect("envelope" in archived).toBe(false);
    expect(() => parseGateDecisionRecord(bytes)).toThrow();
  });

  it("rejects retired ledgers containing a supersession action", () => {
    expect(() => parseArchivedGateDecisionRecord(fixture("decision-malformed-supplemental")))
      .toThrow(/supplemental|discriminator/);
  });
});

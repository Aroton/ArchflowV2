import { describe, expect, it } from "vitest";
import { createRawAdjudicationV2Schema } from "../../src/contracts/adjudication.js";

// The constitution review's adjudicator output: exact rule slots, strict shape, no accessor tricks.
describe("adjudication semantics", () => {
  it("accepts exactly the assigned V2 judgment slots in a strict shape", () => {
    const slots = [
      { slot: "slot-b", rule_id: "alpha-rule", rule_version: 1 },
      { slot: "slot-a", rule_id: "zeta-rule", rule_version: 2 },
    ] as const;
    const output = {
      schema_version: "2",
      judgments: {
        "slot-a": { compliance: "uncertain", rationale: "Could not prove it.", trigger: "uncertain", trigger_evidence: "The boundary is ambiguous." },
        "slot-b": { compliance: "pass", rationale: "The guard is present.", trigger: "matched", trigger_evidence: "The changed path is in scope." },
      },
    } as const;
    const schema = createRawAdjudicationV2Schema(slots);
    expect(schema.parse(output)).toEqual(output);
    expect(schema.safeParse({ ...output, judgments: { "slot-a": output.judgments["slot-a"] } }).success).toBe(false);
    expect(schema.safeParse({ ...output, judgments: { ...output.judgments, extra: output.judgments["slot-a"] } }).success).toBe(false);
    expect(schema.safeParse({ ...output, task_id: "server-owned" }).success).toBe(false);
  });
});

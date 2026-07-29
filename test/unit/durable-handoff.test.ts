import { describe, expect, it } from "vitest";

import { parseHandoffRecord } from "../../src/contracts/durable-handoff.js";
import { handoffRecordV1Validator } from "../../src/contracts/validators.js";

const digest = (value: string): string => value.repeat(64);
const oid = (value: string): string => value.repeat(40);
const checkpoint = (revision: number, value: string) => ({ revision, checkpoint_digest: digest(value) });
const sample = {
  schema_version: "1",
  record_kind: "handoff-record",
  task_id: "task-1",
  repository_identity_digest: digest("a"),
  preserved_heads: [
    { head_oid: oid("1"), authoritative_checkpoint: checkpoint(7, "b") },
    { head_oid: oid("2"), authoritative_checkpoint: checkpoint(8, "c") },
  ],
  common_authoritative_checkpoint: checkpoint(6, "d"),
  selected_successor_head: oid("2"),
  clean_handoff: {
    head_oid: oid("2"),
    state_revision: 10,
    state_digest: digest("e"),
    authoritative_checkpoint: checkpoint(8, "c"),
  },
} as const;

describe("durable handoff contract", () => {
  it("round-trips through the sole normative unmirrored JSON Schema authority", () => {
    expect(handoffRecordV1Validator.assert(sample)).toBe(sample);
    expect(parseHandoffRecord(sample)).toEqual(sample);
  });

  it("rejects omitted evidence, extra lock claims, and malformed heads", () => {
    const { clean_handoff: _clean, ...withoutClean } = sample;
    for (const candidate of [
      withoutClean,
      { ...sample, distributed_lock: true },
      { ...sample, preserved_heads: [sample.preserved_heads[0]] },
      { ...sample, selected_successor_head: "not-an-oid" },
    ]) {
      expect(handoffRecordV1Validator.validate(candidate)).toBe(false);
      expect(() => parseHandoffRecord(candidate)).toThrow();
    }
  });
});

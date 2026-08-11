import { describe, expect, it } from "vitest";

import { canonicalJsonDigest } from "../../src/contracts/canonical.js";
import { LOCAL_COMMANDS, assertGateCounterRequestBinding, runLocalCommand } from "../../src/local/commands.js";

describe("archflow-local pure adapters", () => {
  it("publishes exactly the fifteen local commands", () => {
    expect([...LOCAL_COMMANDS].sort()).toEqual([
      "build-request", "decide", "envelope", "gate-counter", "hash", "init", "maintain",
      "manual-status", "reconcile", "render", "restore", "snapshot", "status", "upgrade", "validate",
    ]);
  });

  it("hashes the exact canonical JSON value", async () => {
    const value = { z: [2, 1], a: "value" } as const;
    await expect(runLocalCommand({
      command: "hash",
      working_directory: process.cwd(),
      value,
    })).resolves.toEqual({ digest: canonicalJsonDigest(value) });
  });

  it("validates through the named durable parser instead of accepting arbitrary JSON", async () => {
    await expect(runLocalCommand({
      command: "validate",
      working_directory: process.cwd(),
      value: { kind: "gate-request", value: { schema_version: "1" } },
    })).rejects.toThrow();
    await expect(runLocalCommand({
      command: "validate",
      working_directory: process.cwd(),
      value: { kind: "unknown", value: {} },
    })).rejects.toThrow(/not supported/u);
  });

  it("rejects forged gate bindings and non-degraded helper evidence", () => {
    const request = {
      request_digest: "a".repeat(64), task_id: "task", phase_instance: "phase-impl-1",
      kind: "review-trigger", subject_digest: "b".repeat(64), context_digest: "c".repeat(64),
      current_evidence: { set_digest: "d".repeat(64), slots: [{ producer_family: "claude" }, { producer_family: "claude" }] },
    } as never;
    const record: Record<string, unknown> = {
      request_digest: "a".repeat(64), task_id: "task", phase_instance: "phase-impl-1",
      kind: "review-trigger", subject_digest: "b".repeat(64), context_digest: "c".repeat(64),
      current_evidence_set_digest: "d".repeat(64), input_fingerprint: "e".repeat(64),
      review: { assurance: "degraded", producer_family: "claude" },
    };
    expect(() => assertGateCounterRequestBinding(record as never, request, "e".repeat(64))).not.toThrow();
    expect(() => assertGateCounterRequestBinding({ ...record, context_digest: "f".repeat(64) } as never, request, "e".repeat(64))).toThrow(/archived request/u);
    expect(() => assertGateCounterRequestBinding({ ...record, review: { assurance: "server-attested", producer_family: "claude" } } as never, request, "e".repeat(64))).toThrow(/archived request/u);
  });
});

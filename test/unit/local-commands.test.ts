import { describe, expect, it } from "vitest";

import { canonicalJsonDigest } from "../../src/contracts/canonical.js";
import { INPUT_FREE_COMMANDS, LOCAL_COMMANDS, LOCAL_COMMAND_CONTRACTS, runLocalCommand } from "../../src/local/commands.js";

describe("archflow-local pure adapters", () => {
  it("publishes exactly the twelve supported local commands", () => {
    expect([...LOCAL_COMMANDS].sort()).toEqual([
      "automation-status", "clean", "hash", "init", "manual-status", "reconcile", "render", "restore",
      "snapshot", "upgrade", "upgrade-adopt", "validate",
    ]);
  });

  it("registers automation status as task-required and input-free", () => {
    expect(LOCAL_COMMAND_CONTRACTS["automation-status"]).toEqual({ payload: null, task: "required" });
    expect(INPUT_FREE_COMMANDS.has("automation-status")).toBe(true);
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

});

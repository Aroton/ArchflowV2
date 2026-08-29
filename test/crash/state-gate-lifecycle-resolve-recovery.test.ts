import { existsSync } from "node:fs";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { canonicalDocument } from "../../src/contracts/canonical.js";
import type { TaskStateV1 } from "../../src/contracts/durable-state.js";
import { parseSafeInteger } from "../../src/contracts/evidence.js";
import { readTaskState } from "../../src/state/read.js";
import {
  cleanupFixture,
  D,
  decision,
  event,
  fixture,
  repair,
  start,
} from "./state-gate-lifecycle-helpers.js";

afterEach(cleanupFixture);

describe("gate process resolve cut SIGKILL recovery", { timeout: 20_000 }, () => {
  for (const cut of ["archive-created", "receipt-created", "state-resolved", "interface-remove-before"] as const) {
    it(`resumes exactly once after real SIGKILL at resolve cut ${cut}`, async () => {
      const input = await fixture();
      expect((await event(start(input, "open"), "result")).result.ok).toBe(true);
      const gateId = await decision(input);
      const killed = start(input, "run-kill", cut);
      await event(killed, "cut");
      await new Promise<void>((resolve) => killed.once("exit", () => resolve()));
      await repair(input);
      const result = await event(start(input, "run"), "result");
      expect(result.result).toMatchObject({ ok: true });
      const state = await readTaskState(input.authority.state);
      expect(state.kind === "canonical" ? state.document.value.approvals : []).toHaveLength(1);
      expect(existsSync(join(input.taskRoot, "authority", "decisions", gateId, "decision.json"))).toBe(true);
      const supersededInterfacesRemain = cut === "state-resolved" || cut === "interface-remove-before";
      expect(existsSync(join(input.authority.workspace_root, "cache", "gates", "gate.json"))).toBe(supersededInterfacesRemain);
      expect(existsSync(join(input.authority.workspace_root, "cache", "gates", "gate.decision"))).toBe(supersededInterfacesRemain);
    });
  }

  it.each([
    ["reentry", "revise", 2],
    ["exhaustion", "retry-once", 3],
  ] as const)(
    "resumes an already archived %s decision onto exactly one enacted re-entry",
    async (kind, choice, attempt) => {
      const input = await fixture(`gate-crash-${kind}`);
      const before = await readTaskState(input.authority.state);
      if (before.kind !== "canonical") throw new Error("fixture state unavailable");
      await writeFile(input.authority.state.absolute, canonicalDocument({
        ...before.document.value,
        step: "triage",
        status: "succeeded",
        attempt: parseSafeInteger(attempt),
      } as TaskStateV1).bytes);

      expect((await event(start(input, `${kind}-open`), "result")).result.ok).toBe(true);
      const gateId = await decision(input, choice);
      const killed = start(input, `${kind}-run-kill`, "archive-created");
      await event(killed, "cut");
      await new Promise<void>((resolve) => killed.once("exit", () => resolve()));
      await repair(input);

      expect((await event(start(input, `${kind}-run`), "result")).result).toMatchObject({
        ok: true,
        value: { effect: "retry" },
      });
      const after = await readTaskState(input.authority.state);
      expect(after).toMatchObject({
        kind: "canonical",
        document: {
          value: {
            step: "produce",
            status: "running",
            attempt: choice === "retry-once" ? attempt + 1 : attempt,
            input_fingerprint: D("e"),
          },
        },
      });
      expect(existsSync(join(input.taskRoot, "authority", "decisions", gateId, "decision.json"))).toBe(true);
      expect(existsSync(join(input.authority.workspace_root, "cache", "gates", "gate.json"))).toBe(false);
      expect(existsSync(join(input.authority.workspace_root, "cache", "gates", "gate.decision"))).toBe(false);
    },
  );
});

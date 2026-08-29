import { afterEach, describe, expect, it } from "vitest";

import { readTaskState } from "../../src/state/read.js";
import {
  cleanupFixture,
  event,
  fixture,
  repair,
  start,
} from "./state-gate-lifecycle-helpers.js";

afterEach(cleanupFixture);

describe("gate process open cut SIGKILL recovery", { timeout: 20_000 }, () => {
  for (const cut of ["request-created", "gate-published", "state-opened"] as const) {
    it(`resumes after real SIGKILL at open cut ${cut}`, async () => {
      const input = await fixture();
      const killed = start(input, "open-kill", cut);
      await event(killed, "cut");
      await new Promise<void>((resolve) => killed.once("exit", () => resolve()));
      await repair(input);
      const resumed = start(input, "open");
      expect((await event(resumed, "result")).result).toMatchObject({ ok: true });
      const state = await readTaskState(input.authority.state);
      expect(state).toMatchObject({ kind: "canonical", document: { value: { revision: 8, open_gate: { gate_id: expect.any(String) } } } });
    });
  }
});

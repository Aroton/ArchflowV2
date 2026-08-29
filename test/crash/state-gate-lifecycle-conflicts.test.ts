import { existsSync } from "node:fs";
import { readFile, readdir } from "node:fs/promises";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { readTaskState } from "../../src/state/read.js";
import {
  cleanupFixture,
  decision,
  event,
  fixture,
  repair,
  start,
  waitForAbsent,
  waitForFile,
} from "./state-gate-lifecycle-helpers.js";

afterEach(cleanupFixture);

describe("gate process conflict and concurrent wait boundaries", { timeout: 20_000 }, () => {
  it("serializes conflicting opens and leaves the losing process without a request", async () => {
    const input = await fixture();
    const winner = start(input, "open-hold", "gate-published", "winner-intent", "8");
    await event(winner, "cut");
    const loser = start(input, "open", "none", "loser-intent", "2");
    const lost = await event(loser, "result");
    expect(lost.result).toMatchObject({ ok: false, error: { code: "IO_ERROR" } });
    winner.send?.({ type: "release" });
    expect((await event(winner, "result")).result).toMatchObject({ ok: true });
    const state = await readTaskState(input.authority.state);
    expect(state).toMatchObject({ kind: "canonical", document: { value: { revision: 8, open_gate: { gate_id: expect.any(String) } } } });
    expect((await readFile(join(input.authority.workspace_root, "cache", "gates", "gate.json"), "utf8"))).toContain("winner-intent");
    expect((await readFile(join(input.authority.workspace_root, "cache", "gates", "gate.json"), "utf8"))).not.toContain("loser-intent");
    expect(await readdir(join(input.taskRoot, "authority", "decisions"))).toHaveLength(1);
  });

  it("serializes conflicting resolves and appends one approval", async () => {
    const input = await fixture();
    expect((await event(start(input, "open"), "result")).result.ok).toBe(true);
    await decision(input);
    const winner = start(input, "run-hold", "archive-created");
    await event(winner, "cut");
    const loser = start(input, "run");
    expect((await event(loser, "result")).result).toMatchObject({ ok: false, error: { code: "IO_ERROR" } });
    winner.send?.({ type: "release" });
    expect((await event(winner, "result")).result).toMatchObject({ ok: true });
    const state = await readTaskState(input.authority.state);
    expect(state.kind === "canonical" ? state.document.value.approvals : []).toHaveLength(1);
  });

  it("waits independently on two tasks without holding either task lock", async () => {
    const first = await fixture("gate-wait-one");
    const second = await fixture("gate-wait-two");
    const left = start(first, "run");
    const right = start(second, "run");
    await Promise.all([waitForFile(join(first.authority.workspace_root, "cache", "gates", "gate.json")), waitForFile(join(second.authority.workspace_root, "cache", "gates", "gate.json"))]);
    await Promise.all([waitForAbsent(join(first.authority.workspace_root, "transient", ".transaction-lock")), waitForAbsent(join(second.authority.workspace_root, "transient", ".transaction-lock"))]);
    expect(existsSync(join(first.authority.workspace_root, "transient", ".transaction-lock"))).toBe(false);
    expect(existsSync(join(second.authority.workspace_root, "transient", ".transaction-lock"))).toBe(false);
    await Promise.all([decision(first), decision(second)]);
    const [leftResult, rightResult] = await Promise.all([event(left, "result"), event(right, "result")]);
    expect(leftResult.result.ok).toBe(true);
    expect(rightResult.result.ok).toBe(true);
  });

  it("preserves a decision written after gate publication but before state names it", async () => {
    const input = await fixture();
    const killed = start(input, "open-kill", "gate-published");
    await event(killed, "cut");
    await new Promise<void>((resolve) => killed.once("exit", () => resolve()));
    const gateId = await decision(input);
    await repair(input);
    expect((await event(start(input, "run"), "result")).result).toMatchObject({ ok: true });
    const state = await readTaskState(input.authority.state);
    expect(state.kind === "canonical" ? state.document.value.approvals : []).toHaveLength(1);
    expect(existsSync(join(input.taskRoot, "authority", "decisions", gateId, "decision.json"))).toBe(true);
  });
});

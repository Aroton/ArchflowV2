import { mkdtemp, rename, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { parseRepositoryPathClaim } from "../../src/contracts/path-claims.js";
import type { ResolvedPath, ResolvedTaskPath } from "../../src/repository/paths.js";
import { GATE_POLL_INTERVAL_MS, waitForGateInterface } from "../../src/state/gate-wait.js";

const roots: string[] = [];
async function temporaryRoot(label: string): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), `archflow-${label}-`));
  roots.push(root);
  return root;
}
afterEach(async () => Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))));

function resolved(absolute: string, pathClass: "gate-interface" | "review"): ResolvedPath {
  const suffix = pathClass === "review" ? "reviews/phase-impl-1.gate-counter.gate-1.md" : "gate.decision";
  return {
    absolute: absolute as ResolvedTaskPath,
    path_class: pathClass,
    repositoryRelative: parseRepositoryPathClaim(`.archflow/tasks/demo/${suffix}`),
  };
}

describe("waitForGateInterface", () => {
  it("waits for the complete atomic decision projection and returns no bytes", async () => {
    const root = await temporaryRoot("gate-wait");
    const target = join(root, "gate.decision");
    const temporary = join(root, ".gate.decision.tmp");
    const controller = new AbortController();
    await writeFile(temporary, "{\"torn\":");
    const waiting = waitForGateInterface({ decision_path: resolved(target, "gate-interface"), signal: controller.signal });
    await new Promise((resolve) => setTimeout(resolve, 20));
    await writeFile(temporary, "{}\n");
    await rename(temporary, target);
    await expect(waiting).resolves.toEqual({ kind: "interface" });
  }, GATE_POLL_INTERVAL_MS * 3);

  it("surfaces only unrecorded supplemental evidence", async () => {
    const root = await temporaryRoot("gate-wait-supplemental");
    const review = join(root, "review.md");
    await writeFile(review, "review\n");
    const controller = new AbortController();
    await expect(waitForGateInterface({
      decision_path: resolved(join(root, "gate.decision"), "gate-interface"),
      supplemental: { path: resolved(review, "review"), already_recorded: false },
      signal: controller.signal,
    })).resolves.toEqual({ kind: "supplemental" });
  });

  it("treats the first supplemental projection as a wake-up signal only", async () => {
    const root = await temporaryRoot("gate-wait-first-supplemental");
    const review = join(root, "review.md");
    const bytes = Buffer.from("first review\n");
    await writeFile(review, bytes);
    await expect(waitForGateInterface({
      decision_path: resolved(join(root, "gate.decision"), "gate-interface"),
      supplemental: { path: resolved(review, "review"), already_recorded: false },
      signal: new AbortController().signal,
    })).resolves.toEqual({ kind: "supplemental" });
  });

  it("surfaces an untriaged supplemental projection before a simultaneously complete decision", async () => {
    const root = await temporaryRoot("gate-wait-simultaneous");
    const review = join(root, "review.md");
    const decision = join(root, "gate.decision");
    const bytes = Buffer.from("counter review\n");
    await Promise.all([writeFile(review, bytes), writeFile(decision, "{}\n")]);
    await expect(waitForGateInterface({
      decision_path: resolved(decision, "gate-interface"),
      supplemental: { path: resolved(review, "review"), already_recorded: false },
      signal: new AbortController().signal,
    })).resolves.toEqual({ kind: "supplemental" });
  });

  it("does not re-surface supplemental evidence already in the projection ledger", async () => {
    const root = await temporaryRoot("gate-wait-recorded");
    const review = join(root, "review.md");
    await writeFile(review, "review\n");
    const controller = new AbortController();
    const waiting = waitForGateInterface({
      decision_path: resolved(join(root, "gate.decision"), "gate-interface"),
      supplemental: { path: resolved(review, "review"), already_recorded: true },
      signal: controller.signal,
    });
    controller.abort();
    await expect(waiting).resolves.toEqual({ kind: "aborted" });
  });

  it("uses abort to interrupt a pending poll", async () => {
    const root = await temporaryRoot("gate-wait-abort");
    const controller = new AbortController();
    const waiting = waitForGateInterface({
      decision_path: resolved(join(root, "gate.decision"), "gate-interface"),
      signal: controller.signal,
    });
    controller.abort();
    await expect(waiting).resolves.toEqual({ kind: "aborted" });
  });
});

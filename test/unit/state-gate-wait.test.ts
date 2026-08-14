import { mkdtemp, rename, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { parseRepositoryPathClaim } from "../../src/contracts/path-claims.js";
import { parseWorkspacePathClaim, type ResolvedTaskWorkspacePath, type ResolvedWorkspacePath } from "../../src/repository/paths.js";
import { GATE_POLL_INTERVAL_MS, waitForGateInterface } from "../../src/state/gate-wait.js";

const roots: string[] = [];
async function temporaryRoot(label: string): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), `archflow-${label}-`));
  roots.push(root);
  return root;
}
afterEach(async () => Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))));

function resolved(absolute: string): ResolvedWorkspacePath {
  const suffix = "cache/gates/gate.decision";
  return {
    absolute: absolute as ResolvedTaskWorkspacePath,
    path_class: "workspace-gate-interface",
    workspaceRelative: parseWorkspacePathClaim(suffix),
    repositoryRelative: parseRepositoryPathClaim(`.archflow/runtime/tasks/demo/${suffix}`),
  };
}

describe("waitForGateInterface", () => {
  it("waits for the complete atomic decision projection and returns no bytes", async () => {
    const root = await temporaryRoot("gate-wait");
    const target = join(root, "gate.decision");
    const temporary = join(root, ".gate.decision.tmp");
    const controller = new AbortController();
    await writeFile(temporary, "{\"torn\":");
    const waiting = waitForGateInterface({ decision_path: resolved(target), signal: controller.signal });
    await new Promise((resolve) => setTimeout(resolve, 20));
    await writeFile(temporary, "{}\n");
    await rename(temporary, target);
    await expect(waiting).resolves.toEqual({ kind: "interface" });
  }, GATE_POLL_INTERVAL_MS * 3);

  it("uses abort to interrupt a pending poll", async () => {
    const root = await temporaryRoot("gate-wait-abort");
    const controller = new AbortController();
    const waiting = waitForGateInterface({
      decision_path: resolved(join(root, "gate.decision")),
      signal: controller.signal,
    });
    controller.abort();
    await expect(waiting).resolves.toEqual({ kind: "aborted" });
  });
});

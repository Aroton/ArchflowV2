import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, utimesSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { afterAll, describe, expect, it } from "vitest";

import { cleanupTemporaryRepositories, temporaryRoot } from "../helpers/temp-repository.js";

const script = fileURLToPath(new URL("../../skills/archflow-run/scripts/wait.sh", import.meta.url));
const twoDaysAgo = new Date(Date.now() - 2 * 24 * 60 * 60 * 1000);

afterAll(() => {
  cleanupTemporaryRepositories();
});

/** A directory in the temp root, optionally shaped like a handle, with its last change set two days back. */
function directory(temp: string, name: string, files: Readonly<Record<string, string>>, old: boolean): string {
  const path = join(temp, name);
  mkdirSync(path);
  for (const [file, content] of Object.entries(files)) writeFileSync(join(path, file), content);
  if (old) utimesSync(path, twoDaysAgo, twoDaysAgo);
  return path;
}

describe("archflow-run wait script", () => {
  it("deletes old finished handles when a command starts and keeps everything else", () => {
    const temp = temporaryRoot("wait-handle-sweep");
    const oldFinished = directory(temp, "archflow-wait.oldfin", { command: "true\n", pid: "1\n", exit: "0\n" }, true);
    const oldDead = directory(temp, "archflow-wait.olddead", { command: "true\n", pid: "2147483646\n" }, true);
    // This test's own process stands in for a runner that is still going after a day.
    const oldRunning = directory(temp, "archflow-wait.oldrun", { command: "sleep 1\n", pid: `${process.pid}\n` }, true);
    const recentFinished = directory(temp, "archflow-wait.recent", { command: "true\n", pid: "1\n", exit: "0\n" }, false);
    const notAHandle = directory(temp, "archflow-wait.notes", { "notes.txt": "someone's own\n" }, true);
    const unrelated = directory(temp, "unrelated", { command: "true\n", exit: "0\n" }, true);

    const result = spawnSync("bash", [script, "run", "true"], {
      encoding: "utf8",
      env: { ...process.env, TMPDIR: temp, ARCHFLOW_WAIT_SLICE: "20" },
    });

    expect(result.status, result.stdout + result.stderr).toBe(0);
    expect(result.stdout).toContain("exit=0");
    expect(existsSync(oldFinished)).toBe(false);
    expect(existsSync(oldDead)).toBe(false);
    for (const kept of [oldRunning, recentFinished, notAHandle, unrelated]) expect(existsSync(kept), kept).toBe(true);
    // The handle this run created is still there for the caller to read.
    expect(readdirSync(temp).filter((name) => name.startsWith("archflow-wait.")).length).toBe(4);
  });
});

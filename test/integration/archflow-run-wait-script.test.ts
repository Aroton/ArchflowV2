import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, readdirSync, utimesSync, writeFileSync } from "node:fs";
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

/** Runs the script to its end without blocking the test's own timers. */
function run(path: string, args: readonly string[], env: NodeJS.ProcessEnv) {
  return new Promise<{ status: number | null; stdout: string; stderr: string }>((resolve) => {
    const child = spawn("bash", [path, ...args], { env });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk: Buffer) => (stdout += chunk.toString()));
    child.stderr.on("data", (chunk: Buffer) => (stderr += chunk.toString()));
    child.on("close", (status) => resolve({ status, stdout, stderr }));
  });
}

describe("archflow-run wait script", () => {
  it("returns after one slice with the line to run next, and that line reports the command's status", () => {
    const temp = temporaryRoot("wait-slice");
    const env = { ...process.env, TMPDIR: temp, ARCHFLOW_WAIT_SLICE: "1" };

    const first = spawnSync("bash", [script, "run", "sleep 3; exit 3"], { encoding: "utf8", env });

    expect(first.status, first.stdout + first.stderr).toBe(0);
    expect(first.stdout).toContain("running after 1s; continue with:");
    const handle = /^handle=([^;]+);/.exec(first.stdout)?.[1] ?? "";
    expect(first.stdout).toContain(`bash '${script}' wait '${handle}'`);

    // The caller keeps running the printed line; a slice that sees the command end carries its status.
    let next = spawnSync("bash", [script, "wait", handle], { encoding: "utf8", env });
    for (let slices = 0; next.status === 0 && slices < 10; slices += 1) {
      expect(next.stdout).toContain("running after 1s");
      next = spawnSync("bash", [script, "wait", handle], { encoding: "utf8", env });
    }
    expect(next.stdout, next.stderr).toContain("exit=3");
    expect(next.status).toBe(3);
  });

  it("finishes cleanly when the script file is rewritten while it waits", async () => {
    // An install or an edit overwrites the file in place. Bash reads a script as it goes, so a copy that had not
    // read everything would pick up at its old position in the new bytes.
    const temp = temporaryRoot("wait-rewritten");
    const copy = join(temp, "wait.sh");
    const original = readFileSync(script, "utf8");
    writeFileSync(copy, original);

    const waiting = run(copy, ["run", "sleep 2; exit 3"], { ...process.env, TMPDIR: temp, ARCHFLOW_WAIT_SLICE: "20" });
    await new Promise((resolve) => setTimeout(resolve, 700));
    writeFileSync(copy, original.replace("\n", "\n# a later version of this script, with every later byte moved\n"));
    const result = await waiting;

    expect(result.stderr).toBe("");
    expect(result.stdout).toContain("exit=3");
    expect(result.status).toBe(3);
  });

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

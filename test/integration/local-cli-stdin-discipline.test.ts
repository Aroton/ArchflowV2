import { spawn, spawnSync } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { buildSync } from "esbuild";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const TEST_TIMEOUT_MS = 30_000;
const PROCESS_TIMEOUT_MS = 5_000;
const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
let outputDirectory = "";
let localBundle = "";

beforeAll(async () => {
  outputDirectory = await mkdtemp(resolve(tmpdir(), "archflow-local-integration-"));
  localBundle = resolve(outputDirectory, "archflow-local.mjs");
  buildSync({
    absWorkingDir: repositoryRoot,
    entryPoints: ["src/local/main.ts"],
    outfile: localBundle,
    bundle: true,
    platform: "node",
    format: "esm",
    target: "node24",
    banner: {
      js: 'import { createRequire as __createRequire } from "node:module"; const require = __createRequire(import.meta.url);',
    },
  });
}, TEST_TIMEOUT_MS);

afterAll(async () => {
  if (outputDirectory !== "") await rm(outputDirectory, { recursive: true, force: true });
});

describe("archflow-local process", () => {
  it("does not wait for stdin when manual-status has no input payload", async () => {
    const child = spawn(process.execPath, [localBundle, "manual-status"], {
      cwd: repositoryRoot,
      stdio: ["pipe", "pipe", "pipe"],
    });
    let stderr = "";
    let stdout = "";
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk: string) => { stderr += chunk; });
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => { stdout += chunk; });

    const result = await new Promise<Readonly<{ code: number | null; signal: NodeJS.Signals | null }>>((resolveResult, reject) => {
      const timer = setTimeout(() => {
        child.kill("SIGKILL");
        reject(new Error("archflow-local manual-status waited for stdin"));
      }, PROCESS_TIMEOUT_MS);
      child.once("error", reject);
      child.once("exit", (code, signal) => {
        clearTimeout(timer);
        resolveResult({ code, signal });
      });
    });

    expect(result).toEqual({ code: 1, signal: null });
    expect(JSON.parse(stdout)).toMatchObject({ schema_version: "1", ok: false, error: { code: "CONTRACT_INVALID" } });
    expect(stderr).toContain("manual-status requires --task <task>");
    child.stdin.destroy();
  }, TEST_TIMEOUT_MS);

  it("does not wait for stdin when clean has no input payload", async () => {
    const child = spawn(process.execPath, [localBundle, "clean", "--task", "missing-clean-task"], {
      cwd: repositoryRoot,
      stdio: ["pipe", "pipe", "pipe"],
    });
    let stderr = "";
    let stdout = "";
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk: string) => { stderr += chunk; });
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => { stdout += chunk; });

    const result = await new Promise<Readonly<{ code: number | null; signal: NodeJS.Signals | null }>>((resolveResult, reject) => {
      const timer = setTimeout(() => {
        child.kill("SIGKILL");
        reject(new Error("archflow-local clean waited for stdin"));
      }, PROCESS_TIMEOUT_MS);
      child.once("error", reject);
      child.once("exit", (code, signal) => {
        clearTimeout(timer);
        resolveResult({ code, signal });
      });
    });

    expect(result).toEqual({ code: 1, signal: null });
    expect(JSON.parse(stdout)).toMatchObject({ schema_version: "1", ok: false, error: { code: "CONTRACT_INVALID" } });
    expect(stderr).toContain("clean requires current task state");
    child.stdin.destroy();
  }, TEST_TIMEOUT_MS);
});

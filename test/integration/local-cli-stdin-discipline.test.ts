import { execFileSync, spawn } from "node:child_process";
import { cp, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { delimiter, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { buildSync } from "esbuild";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const TEST_TIMEOUT_MS = 30_000;
const PROCESS_TIMEOUT_MS = 5_000;
const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const fakeHostCli = resolve(repositoryRoot, "test/fixtures/init/fake-host-cli.mjs");
const roots: string[] = [];
let outputDirectory = "";
let localBundle = "";

beforeAll(async () => {
  outputDirectory = await mkdtemp(resolve(tmpdir(), "archflow-local-integration-"));
  // The installed layout: `dist/archflow-local.mjs` beside the `assets/` init scaffolds from.
  await mkdir(resolve(outputDirectory, "dist"));
  await cp(resolve(repositoryRoot, "assets"), resolve(outputDirectory, "assets"), { recursive: true });
  localBundle = resolve(outputDirectory, "dist/archflow-local.mjs");
  buildSync({
    absWorkingDir: repositoryRoot,
    entryPoints: ["src/local/main.ts"],
    outfile: localBundle,
    bundle: true,
    platform: "node", loader: { ".yaml": "text" },
    format: "esm",
    target: "node24",
    banner: {
      js: 'import { createRequire as __createRequire } from "node:module"; const require = __createRequire(import.meta.url);',
    },
  });
}, TEST_TIMEOUT_MS);

afterAll(async () => {
  if (outputDirectory !== "") await rm(outputDirectory, { recursive: true, force: true });
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});

describe("archflow-local process", () => {
  it("does not wait for stdin when init runs, since init has no input payload", async () => {
    const root = await mkdtemp(resolve(tmpdir(), "archflow-local-init-stdin-"));
    roots.push(root);
    const work = resolve(root, "work");
    const home = resolve(root, "home");
    const bin = resolve(root, "bin");
    for (const directory of [work, home, bin]) await mkdir(directory);
    for (const adapter of ["claude", "codex"]) {
      await writeFile(resolve(bin, adapter), `#!/bin/sh\nFAKE_HOST_ADAPTER=${adapter} exec "${process.execPath}" "${fakeHostCli}" "$@"\n`, { mode: 0o755 });
    }
    execFileSync("git", ["-c", "init.defaultBranch=main", "init", "-q"], { cwd: work });
    const child = spawn(process.execPath, [localBundle, "init"], {
      cwd: work,
      env: { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_SYSTEM: "/dev/null", HOME: home, PATH: `${bin}${delimiter}${process.env.PATH ?? ""}` },
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
        reject(new Error("archflow-local init waited for stdin"));
      }, PROCESS_TIMEOUT_MS);
      child.once("error", reject);
      child.once("exit", (code, signal) => {
        clearTimeout(timer);
        resolveResult({ code, signal });
      });
    });

    expect(result, stderr).toEqual({ code: 0, signal: null });
    expect(JSON.parse(stdout)).toMatchObject({ schema_version: "1", ok: true });
    child.stdin.destroy();
  }, TEST_TIMEOUT_MS);

  it("rejects a review without a producer before reading its stdin payload", async () => {
    const child = spawn(process.execPath, [localBundle, "review"], {
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
        reject(new Error("archflow-local review waited for stdin before checking --producer"));
      }, PROCESS_TIMEOUT_MS);
      child.once("error", reject);
      child.once("exit", (code, signal) => {
        clearTimeout(timer);
        resolveResult({ code, signal });
      });
    });

    expect(result).toEqual({ code: 1, signal: null });
    expect(JSON.parse(stdout)).toMatchObject({ schema_version: "1", ok: false, error: { code: "CONTRACT_INVALID" } });
    expect(stderr).toContain("review requires --producer claude|codex|antigravity");
    child.stdin.destroy();
  }, TEST_TIMEOUT_MS);
});

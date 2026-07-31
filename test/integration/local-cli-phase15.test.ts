import { spawn, spawnSync } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

const TEST_TIMEOUT_MS = 30_000;
const PROCESS_TIMEOUT_MS = 5_000;
const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
let outputDirectory = "";
let localBundle = "";

beforeAll(async () => {
  outputDirectory = await mkdtemp(resolve(tmpdir(), "archflow-local-integration-"));
  localBundle = resolve(outputDirectory, "archflow-local.mjs");
  const program = [
    'import { build } from "esbuild";',
    'const [root, outfile] = process.argv.slice(1);',
    'await build({absWorkingDir:root,entryPoints:["src/local/main.ts"],outfile,bundle:true,platform:"node",format:"esm",target:"node24",banner:{js:\'import { createRequire as __createRequire } from "node:module"; const require = __createRequire(import.meta.url);\'}});',
  ].join("");
  const built = spawnSync(process.execPath, ["--input-type=module", "--eval", program, repositoryRoot, localBundle], {
    cwd: repositoryRoot,
    encoding: "utf8",
    timeout: TEST_TIMEOUT_MS,
  });
  expect(built.error).toBeUndefined();
  expect(built.status, built.stderr).toBe(0);
}, TEST_TIMEOUT_MS);

afterAll(async () => {
  if (outputDirectory !== "") await rm(outputDirectory, { recursive: true, force: true });
});

describe("archflow-local process", () => {
  it("does not wait for stdin when status has no input payload", async () => {
    const child = spawn(process.execPath, [localBundle, "status"], {
      cwd: repositoryRoot,
      stdio: ["pipe", "pipe", "pipe"],
    });
    let stderr = "";
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk: string) => { stderr += chunk; });

    const result = await new Promise<Readonly<{ code: number | null; signal: NodeJS.Signals | null }>>((resolveResult, reject) => {
      const timer = setTimeout(() => {
        child.kill("SIGKILL");
        reject(new Error("archflow-local status waited for stdin"));
      }, PROCESS_TIMEOUT_MS);
      child.once("error", reject);
      child.once("exit", (code, signal) => {
        clearTimeout(timer);
        resolveResult({ code, signal });
      });
    });

    expect(result).toEqual({ code: 1, signal: null });
    expect(stderr).toContain("unsupported undefined value at task slug");
    child.stdin.destroy();
  }, TEST_TIMEOUT_MS);
});

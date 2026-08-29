import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { buildSync } from "esbuild";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";

import { parseTaskSlug } from "../../src/contracts/evidence.js";
import { LOCAL_COMMANDS, LOCAL_COMMAND_CONTRACTS } from "../../src/local/commands.js";

const TIMEOUT = 30_000;
const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const roots: string[] = [];
const task = parseTaskSlug("payload-input");
let bundleRoot = "";
let localBundle = "";

const gitEnvironment: NodeJS.ProcessEnv = {
  ...process.env,
  GIT_CONFIG_GLOBAL: "/dev/null",
  GIT_CONFIG_SYSTEM: "/dev/null",
  GIT_AUTHOR_NAME: "ArchFlow Test",
  GIT_AUTHOR_EMAIL: "test@example.invalid",
  GIT_COMMITTER_NAME: "ArchFlow Test",
  GIT_COMMITTER_EMAIL: "test@example.invalid",
};

beforeAll(async () => {
  bundleRoot = await mkdtemp(resolve(tmpdir(), "archflow-local-payload-"));
  localBundle = resolve(bundleRoot, "archflow-local.mjs");
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
}, TIMEOUT);

afterAll(async () => { if (bundleRoot !== "") await rm(bundleRoot, { recursive: true, force: true }); });
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

function cliStdin(root: string, command: string, raw?: string): Readonly<{ status: number | null; stdout: string; stderr: string; value?: any }> {
  const result = spawnSync(process.execPath, [localBundle, command, "--task", task], {
    cwd: root, env: gitEnvironment, input: raw, encoding: "utf8", timeout: TIMEOUT,
  });
  return { status: result.status, stdout: result.stdout, stderr: result.stderr,
    ...(result.stdout === "" ? {} : { value: JSON.parse(result.stdout) }) };
}

function cliFile(root: string, command: string, raw: string): Readonly<{ status: number | null; stdout: string; stderr: string; path: string; value?: any }> {
  const payloadRoot = mkdtempSync(join(tmpdir(), "archflow-payload-"));
  roots.push(payloadRoot);
  const path = join(payloadRoot, "payload.json");
  writeFileSync(path, raw);
  const result = spawnSync(process.execPath, [localBundle, command, "--task", task, "--input", path], {
    cwd: root, env: gitEnvironment, encoding: "utf8", timeout: TIMEOUT,
  });
  return { status: result.status, stdout: result.stdout, stderr: result.stderr, path,
    ...(result.stdout === "" ? {} : { value: JSON.parse(result.stdout) }) };
}

// The interactive-TTY guard (isTTY → fail fast) is not reachable from spawned children, which
// always receive pipes; the empty-stdin cases below assert the same "no payload provided" message.
describe("payload input modes and error taxonomy", () => {
  it("accepts --input <file> for a payload command", () => {
    const value = { z: [2, 1], a: "value" };
    const hashed = cliFile(repositoryRoot, "hash", JSON.stringify(value));
    expect(hashed).toMatchObject({ status: 0 });
    expect(typeof hashed.value.digest).toBe("string");
  }, TIMEOUT);

  it("names the command's input contract when stdin is empty and --input is absent", () => {
    const result = cliStdin(repositoryRoot, "validate", "");
    expect(result.status).toBe(1);
    expect(result.value).toMatchObject({ schema_version: "1", ok: false, error: { code: "CONTRACT_INVALID" } });
    expect(result.stderr).toContain("validate requires an input payload (--input <json-file> or stdin)");
    expect(result.stderr).toContain(`expected: ${LOCAL_COMMAND_CONTRACTS.validate.payload}`);
  });

  it("names render's expected payload shape when called without input", () => {
    const result = cliStdin(repositoryRoot, "render", "");
    expect(result.status).toBe(1);
    expect(result.value).toMatchObject({ schema_version: "1", ok: false, error: { code: "CONTRACT_INVALID" } });
    expect(result.stderr).toContain("render requires an input payload (--input <json-file> or stdin)");
    expect(result.stderr).toContain('expected: {"kind":"review"|"adjudication"');
  });

  it("lists every command's input contract in the usage output", () => {
    const result = spawnSync(process.execPath, [localBundle, "--help"], {
      cwd: repositoryRoot, encoding: "utf8", timeout: TIMEOUT,
    });
    expect(result.status).toBe(0);
    expect(result.stdout).toContain("usage: archflow-local <command>");
    expect(result.stdout).toContain("--repository <secondary>");
    const lines = result.stdout.split("\n");
    for (const command of LOCAL_COMMANDS) {
      const contract = LOCAL_COMMAND_CONTRACTS[command];
      const line = lines.find((candidate) => candidate.startsWith(`  ${command} `));
      expect(line, `usage line for ${command}`).toBeDefined();
      expect(line).toContain(contract.payload === null ? "no payload" : `payload ${contract.payload}`);
      expect(line).toContain(`--task ${contract.task}`);
    }
  });

  it("rejects repository selection for commands other than restore", () => {
    const result = spawnSync(process.execPath, [localBundle, "hash", "--repository", "apis"], {
      cwd: repositoryRoot, env: gitEnvironment, input: "{}", encoding: "utf8", timeout: TIMEOUT,
    });
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("--repository is supported only by restore");
  });

  it("reports invalid JSON with its source for stdin payloads", () => {
    const result = cliStdin(repositoryRoot, "hash", "{");
    expect(result.status).toBe(1);
    expect(result.value).toMatchObject({ schema_version: "1", ok: false, error: { code: "CONTRACT_INVALID" } });
    expect(result.stderr).toContain("invalid JSON payload from stdin");
  });

  it("reports invalid JSON with its source for --input payloads", () => {
    const result = cliFile(repositoryRoot, "hash", "{");
    expect(result.status).toBe(1);
    expect(result.value).toMatchObject({ schema_version: "1", ok: false, error: { code: "CONTRACT_INVALID" } });
    expect(result.stderr).toContain(`invalid JSON payload from ${result.path}`);
  });
});

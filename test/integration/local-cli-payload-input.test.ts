import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { buildSync } from "esbuild";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";

import { LOCAL_COMMAND_CONTRACTS } from "../../src/local/commands.js";

const TIMEOUT = 30_000;
const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const roots: string[] = [];
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

/** Fails schema validation inside the review, which proves the payload was read and parsed. */
const SCHEMA_INVALID_REVIEW = JSON.stringify({ schema_version: "1", stage: "plan" });

beforeAll(async () => {
  bundleRoot = await mkdtemp(resolve(tmpdir(), "archflow-local-payload-"));
  localBundle = resolve(bundleRoot, "archflow-local.mjs");
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
}, TIMEOUT);

afterAll(async () => { if (bundleRoot !== "") await rm(bundleRoot, { recursive: true, force: true }); });
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

function reviewStdin(raw?: string): Readonly<{ status: number | null; stdout: string; stderr: string; value?: any }> {
  const result = spawnSync(process.execPath, [localBundle, "review", "--producer", "claude"], {
    cwd: repositoryRoot, env: gitEnvironment, input: raw, encoding: "utf8", timeout: TIMEOUT,
  });
  return { status: result.status, stdout: result.stdout, stderr: result.stderr,
    ...(result.stdout === "" ? {} : { value: JSON.parse(result.stdout) }) };
}

function reviewFile(raw: string): Readonly<{ status: number | null; stdout: string; stderr: string; path: string; value?: any }> {
  const payloadRoot = mkdtempSync(join(tmpdir(), "archflow-payload-"));
  roots.push(payloadRoot);
  const path = join(payloadRoot, "payload.json");
  writeFileSync(path, raw);
  const result = spawnSync(process.execPath, [localBundle, "review", "--producer", "claude", "--input", path], {
    cwd: repositoryRoot, env: gitEnvironment, encoding: "utf8", timeout: TIMEOUT,
  });
  return { status: result.status, stdout: result.stdout, stderr: result.stderr, path,
    ...(result.stdout === "" ? {} : { value: JSON.parse(result.stdout) }) };
}

// The interactive-TTY guard (isTTY → fail fast) is not reachable from spawned children, which
// always receive pipes; the empty-stdin cases below assert the same "no payload provided" message.
describe("review payload input modes and error taxonomy", () => {
  it("reads the review payload from --input <file>", () => {
    const result = reviewFile(SCHEMA_INVALID_REVIEW);
    expect(result.status).toBe(1);
    expect(result.value).toMatchObject({ schema_version: "1", ok: false, error: { code: "INPUT_INVALID" } });
    expect(result.value.error.message).toContain("base_commit");
    expect(result.stderr).toContain("review failed: INPUT_INVALID");
  });

  it("rejects a schema-invalid stdin review payload with a JSON failure envelope", () => {
    const result = reviewStdin(SCHEMA_INVALID_REVIEW);
    expect(result.status).toBe(1);
    expect(result.value).toMatchObject({ schema_version: "1", ok: false, error: { code: "INPUT_INVALID" } });
    expect(result.value.error.message).toContain("base_commit");
    expect(result.stderr).toContain("review failed: INPUT_INVALID");
  });

  it("names the review input contract when stdin is empty and --input is absent", () => {
    const result = reviewStdin("");
    expect(result.status).toBe(1);
    expect(result.value).toMatchObject({ schema_version: "1", ok: false, error: { code: "CONTRACT_INVALID" } });
    expect(result.stderr).toContain("review requires an input payload (--input <json-file> or stdin)");
    expect(result.stderr).toContain(`expected: ${LOCAL_COMMAND_CONTRACTS.review.payload}`);
  });

  it("names the empty --input file", () => {
    const result = reviewFile("");
    expect(result.status).toBe(1);
    expect(result.value).toMatchObject({ schema_version: "1", ok: false, error: { code: "CONTRACT_INVALID" } });
    expect(result.stderr).toContain(`review requires an input payload; ${result.path} is empty`);
  });

  it("reports invalid JSON with its source for stdin payloads", () => {
    const result = reviewStdin("{");
    expect(result.status).toBe(1);
    expect(result.value).toMatchObject({ schema_version: "1", ok: false, error: { code: "CONTRACT_INVALID" } });
    expect(result.stderr).toContain("invalid JSON payload from stdin");
  });

  it("reports invalid JSON with its source for --input payloads", () => {
    const result = reviewFile("{");
    expect(result.status).toBe(1);
    expect(result.value).toMatchObject({ schema_version: "1", ok: false, error: { code: "CONTRACT_INVALID" } });
    expect(result.stderr).toContain(`invalid JSON payload from ${result.path}`);
  });
});

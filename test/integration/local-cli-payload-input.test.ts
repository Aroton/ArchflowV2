import { spawnSync, execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";

import { parseSafeCode, parseSha256Digest, parseTaskSlug } from "../../src/contracts/evidence.js";
import { parseToolCall } from "../../src/contracts/mcp-tools.js";
import { scaffoldRepositoryAssets } from "../../src/init/assets.js";
import { stageTaskInitialization } from "../../src/init/task-initialization.js";
import { runStateInitialization } from "../../src/state/initialization.js";
import { createProductionServices } from "../../src/state/production.js";

const TIMEOUT = 30_000;
const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const roots: string[] = [];
const task = parseTaskSlug("payload-input");
const digest = (character: string) => parseSha256Digest(character.repeat(64));
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
  const program = [
    'import { build } from "esbuild";',
    'const [root, outfile] = process.argv.slice(1);',
    'await build({absWorkingDir:root,entryPoints:["src/local/main.ts"],outfile,bundle:true,platform:"node",format:"esm",target:"node24",banner:{js:\'import { createRequire as __createRequire } from "node:module"; const require = __createRequire(import.meta.url);\'}});',
  ].join("");
  const built = spawnSync(process.execPath, ["--input-type=module", "--eval", program, repositoryRoot, localBundle], {
    cwd: repositoryRoot, encoding: "utf8", timeout: TIMEOUT,
  });
  expect(built.status, built.stderr).toBe(0);
}, TIMEOUT);

afterAll(async () => { if (bundleRoot !== "") await rm(bundleRoot, { recursive: true, force: true }); });
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

function git(root: string, ...argv: string[]): string {
  return execFileSync("git", argv, { cwd: root, env: gitEnvironment, encoding: "utf8" }).trim();
}

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

async function repository() {
  const root = mkdtempSync(join(tmpdir(), "archflow-payload-repo-"));
  roots.push(root);
  git(root, "-c", "init.defaultBranch=main", "init", "-q");
  writeFileSync(join(root, "README.md"), "repository\n");
  git(root, "add", "--", "README.md");
  git(root, "commit", "-q", "-m", "root");
  const scaffolded = await scaffoldRepositoryAssets({ working_directory: root });
  if (!scaffolded.ok) throw new Error(scaffolded.error.code);
  git(root, "add", "--", ".gitattributes", ".archflow/workflow.yaml", ".archflow/constitution", ".archflow/config.yaml");
  git(root, "commit", "-q", "-m", "policy");
  const staged = await stageTaskInitialization({ working_directory: root, task_id: task });
  if (!staged.ok) throw new Error(staged.error.code);
  return { root, initialization: staged.value };
}

// The interactive-TTY guard (isTTY → fail fast) is not reachable from spawned children, which
// always receive pipes; the empty-stdin cases below assert the same "no payload provided" message.
describe("payload input modes and error taxonomy", () => {
  it("accepts --input <file> for envelope and build-document", async () => {
    const fixture = await repository();
    const placeholder = digest("0");
    const initialInput = {
      schema_version: "1", task_id: task, intent_id: "initialize-file-mode", expected_revision: 0,
      input_fingerprint: placeholder, phase_instance: "prd", step: "produce", status: "running",
      artifact: fixture.initialization,
    };
    const first = cliFile(fixture.root, "envelope", JSON.stringify({ tool: "archflow_state", input: initialInput }));
    expect(first).toMatchObject({ status: 0, value: { ok: true, value: { tool: "archflow_state" } } });

    const bootstrap = await createProductionServices({
      working_directory: fixture.root, task_id: task, operation: parseSafeCode("cli-file-bootstrap"),
    });
    if (!bootstrap.ok || bootstrap.value.state !== undefined) throw new Error("bootstrap services unavailable");
    const initialized = await runStateInitialization(bootstrap.value.dependencies, {
      authority: bootstrap.value.authority,
      call: parseToolCall("archflow_state", { ...initialInput, input_fingerprint: first.value.value.input_fingerprint }),
    });
    expect(initialized.ok).toBe(true);
    if (!initialized.ok) return;

    writeFileSync(join(bootstrap.value.authority.task_root, "prd.md"), "# PRD\n");
    const built = cliFile(fixture.root, "build-document", JSON.stringify({
      phase_instance: "prd", step: "produce", document_path: "prd.md", declared_inputs: [],
      input_fingerprint: initialized.value.state.value.input_fingerprint,
    }));
    expect(built).toMatchObject({ status: 0, value: { ok: true, value: { artifact_kind: "document", document_path: "prd.md" } } });
  }, TIMEOUT);

  it("reports a missing payload when stdin is empty and --input is absent", () => {
    const result = cliStdin(repositoryRoot, "envelope", "");
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("no payload provided: pass --input");
  });

  it("reports invalid JSON with its source for stdin payloads", () => {
    const result = cliStdin(repositoryRoot, "envelope", "{");
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("invalid JSON payload from stdin");
  });

  it("reports invalid JSON with its source for --input payloads", () => {
    const result = cliFile(repositoryRoot, "envelope", "{");
    expect(result.status).toBe(1);
    expect(result.stderr).toContain(`invalid JSON payload from ${result.path}`);
  });

  it("states the expected envelope wrapper for missing and unrecognized tools", async () => {
    const fixture = await repository();
    const missing = cliStdin(fixture.root, "envelope", JSON.stringify({ input: {} }));
    expect(missing.status).toBe(1);
    expect(missing.stderr).toContain('call envelope input is missing "tool"');
    expect(missing.stderr).toContain('{"tool": <one of archflow_state');

    const unrecognized = cliStdin(fixture.root, "envelope", JSON.stringify({ tool: "archflow_bogus", input: {} }));
    expect(unrecognized.status).toBe(1);
    expect(unrecognized.stderr).toContain('call envelope tool "archflow_bogus" is not recognized');
    expect(unrecognized.stderr).toContain("archflow_state");
  }, TIMEOUT);
});

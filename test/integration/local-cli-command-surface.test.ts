import { spawnSync, execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";

import { parseTaskSlug } from "../../src/contracts/evidence.js";
import { scaffoldRepositoryAssets } from "../../src/init/assets.js";
import { stageTaskInitialization } from "../../src/init/task-initialization.js";
import { LOCAL_COMMANDS } from "../../src/local/commands.js";

const TIMEOUT = 30_000;
const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const roots: string[] = [];
const task = parseTaskSlug("local-cli");
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

/** Every command the helper choreography retirement removed from the local surface. */
const RETIRED_COMMANDS = ["build-request", "envelope", "decide", "commit", "status", "gate-preview"] as const;

beforeAll(async () => {
  bundleRoot = await mkdtemp(resolve(tmpdir(), "archflow-local-cli-"));
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

function cli(root: string, command: string, value?: unknown): Readonly<{ status: number | null; stdout: string; stderr: string; value?: any }> {
  const result = spawnSync(process.execPath, [localBundle, command, "--task", task], {
    cwd: root,
    env: gitEnvironment,
    input: value === undefined ? undefined : JSON.stringify(value),
    encoding: "utf8",
    timeout: TIMEOUT,
  });
  return {
    status: result.status,
    stdout: result.stdout,
    stderr: result.stderr,
    ...(result.stdout === "" ? {} : { value: JSON.parse(result.stdout) }),
  };
}

async function repository() {
  const root = mkdtempSync(join(tmpdir(), "archflow-local-cli-repo-"));
  roots.push(root);
  git(root, "-c", "init.defaultBranch=main", "init", "-q");
  writeFileSync(join(root, "README.md"), "repository\n");
  git(root, "add", "--", "README.md");
  git(root, "commit", "-q", "-m", "root");
  const scaffolded = await scaffoldRepositoryAssets({ working_directory: root });
  if (!scaffolded.ok) throw new Error(scaffolded.error.code);
  git(root, "add", "--", ".gitattributes", ".archflow/.gitignore", ".archflow/workflow.yaml", ".archflow/constitution", ".archflow/config.yaml");
  git(root, "commit", "-q", "-m", "policy");
  const staged = await stageTaskInitialization({ working_directory: root, task_id: task });
  if (!staged.ok) throw new Error(staged.error.code);
  return { root, initialization: staged.value };
}

describe("bundled local CLI", () => {
  it("lists exactly the surviving commands in its usage", async () => {
    const help = spawnSync(process.execPath, [localBundle, "--help"], { encoding: "utf8", timeout: TIMEOUT });
    expect(help.status).toBe(0);
    const listed = [...help.stdout.matchAll(/^  (\S+)(?=\s{2,})/gmu)].map((match) => match[1]);
    expect(listed.sort()).toEqual([...LOCAL_COMMANDS].sort());
  }, TIMEOUT);

  it("keeps every retired helper command out of the registry and rejecting at the CLI entry", async () => {
    const fixture = await repository();
    for (const retired of RETIRED_COMMANDS) {
      expect(LOCAL_COMMANDS).not.toContain(retired);
      const rejected = cli(fixture.root, retired, {});
      expect(rejected.status, `${retired} must reject`).not.toBe(0);
      expect(rejected.stderr).toMatch(/unknown archflow-local command/u);
    }
  }, TIMEOUT);

  it("hashes canonical JSON and rejects unsupported validate kinds through the bundle", async () => {
    const fixture = await repository();
    const value = { z: [2, 1], a: "value" } as const;
    const hashed = cli(fixture.root, "hash", value);
    expect(hashed).toMatchObject({ status: 0 });
    expect(typeof hashed.value.digest).toBe("string");

    const rejected = cli(fixture.root, "validate", { kind: "unknown", value: {} });
    expect(rejected.status).not.toBe(0);
    expect(rejected.stderr).toMatch(/not supported/u);
    expect(rejected.stdout).toBe("");
  }, TIMEOUT);

  it("classifies a task without durable state through manual-status", async () => {
    const fixture = await repository();
    const classified = cli(fixture.root, "manual-status");
    expect(classified).toMatchObject({ status: 0, value: { ok: true } });
  }, TIMEOUT);

  it("reports a failed result through the process exit code", async () => {
    const fixture = await repository();
    // A structured project failure keeps its full JSON body on stdout — scripts still parse the
    // error — while the exit code turns nonzero so an unchecked shell pipeline cannot mistake the
    // failure for success. Previewing an import from a directory that is not a legacy repository
    // fails closed.
    const unavailable = cli(fixture.root, "upgrade", {
      operation: "preview",
      source_root: join(fixture.root, "missing-legacy-root"),
      task_id: task,
      policy_base_commit: "0".repeat(40),
      import_baseline_commit: "0".repeat(40),
      code_baseline_commit: "0".repeat(40),
    });
    expect(unavailable).toMatchObject({ status: 1, value: { ok: false } });
    expect(unavailable.value.error.code).toEqual(expect.any(String));
  }, TIMEOUT);
});

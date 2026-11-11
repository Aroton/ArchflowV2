import { spawnSync, execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { cp, mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { delimiter, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { buildSync } from "esbuild";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";

import { LOCAL_COMMANDS } from "../../src/local/commands.js";

const TIMEOUT = 30_000;
const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const fakeHostCli = join(repositoryRoot, "test", "fixtures", "init", "fake-host-cli.mjs");
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

/** Commands earlier releases shipped (task workflow, MCP debugging, helper choreography); none survive. */
const REMOVED_COMMANDS = [
  "validate", "hash", "render", "snapshot", "restore", "clean", "reconcile",
  "manual-status", "automation-status", "upgrade", "upgrade-adopt", "set-commit-authority",
  "implementation-profiles", "review-preview",
  "build-request", "envelope", "decide", "commit", "status", "gate-preview",
] as const;

beforeAll(async () => {
  bundleRoot = await mkdtemp(resolve(tmpdir(), "archflow-local-cli-"));
  await mkdir(resolve(bundleRoot, "dist"));
  await cp(resolve(repositoryRoot, "assets"), resolve(bundleRoot, "assets"), { recursive: true });
  localBundle = resolve(bundleRoot, "dist/archflow-local.mjs");
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

function git(root: string, ...argv: string[]): string {
  return execFileSync("git", argv, { cwd: root, env: gitEnvironment, encoding: "utf8" }).trim();
}

/** A committed scratch repository plus a scratch HOME and fake reviewer CLIs, so init touches nothing real. */
function repository(): Readonly<{ root: string; env: NodeJS.ProcessEnv }> {
  const root = mkdtempSync(join(tmpdir(), "archflow-local-cli-repo-"));
  roots.push(root);
  const work = join(root, "work");
  const home = join(root, "home");
  const bin = join(root, "bin");
  for (const directory of [work, home, bin]) mkdirSync(directory);
  for (const adapter of ["claude", "codex"]) {
    writeFileSync(join(bin, adapter), `#!/bin/sh\nFAKE_HOST_ADAPTER=${adapter} exec "${process.execPath}" "${fakeHostCli}" "$@"\n`, { mode: 0o755 });
  }
  git(work, "-c", "init.defaultBranch=main", "init", "-q");
  writeFileSync(join(work, "README.md"), "repository\n");
  git(work, "add", "--", "README.md");
  git(work, "commit", "-q", "-m", "root");
  return { root: work, env: { ...gitEnvironment, HOME: home, PATH: `${bin}${delimiter}${process.env.PATH ?? ""}` } };
}

function cli(cwd: string, env: NodeJS.ProcessEnv, ...argv: string[]): Readonly<{ status: number | null; stdout: string; stderr: string; value?: any }> {
  const result = spawnSync(process.execPath, [localBundle, ...argv], { cwd, env, input: "", encoding: "utf8", timeout: TIMEOUT });
  return {
    status: result.status,
    stdout: result.stdout,
    stderr: result.stderr,
    ...(result.stdout === "" || argv.includes("--help") ? {} : { value: JSON.parse(result.stdout) }),
  };
}

describe("bundled local CLI", () => {
  it("lists exactly review and init in its usage", () => {
    const help = cli(repositoryRoot, gitEnvironment, "--help");
    expect(help.status).toBe(0);
    const listed = [...help.stdout.matchAll(/^  (\S+)(?=\s{2,})/gmu)].map((match) => match[1]);
    expect(listed.sort()).toEqual(["init", "review"]);
    expect([...LOCAL_COMMANDS].sort()).toEqual(["init", "review"]);
    expect(help.stdout).toContain("usage: archflow-local <command>");
    expect(help.stdout).toContain("review --producer <claude|codex|antigravity>");
    expect(help.stdout).not.toContain("--task");
  }, TIMEOUT);

  it("rejects every other command name with the unknown-command message", () => {
    for (const removed of [...REMOVED_COMMANDS, "upgrade adopt"]) {
      const rejected = cli(repositoryRoot, gitEnvironment, ...removed.split(" "));
      expect(rejected.status, `${removed} must reject`).toBe(1);
      expect(rejected.stderr).toMatch(/unknown archflow-local command/u);
      expect(rejected.value).toMatchObject({
        schema_version: "1",
        ok: false,
        error: { code: "CONTRACT_INVALID", diagnostic: { parameters: { issue_code: "local-command-invalid" } } },
      });
    }
  }, TIMEOUT);

  it("rejects options that belong to the other command", () => {
    const fixture = repository();
    expect(cli(fixture.root, fixture.env, "review", "--producer", "claude", "--force").stderr).toContain("--force is supported only by init");
    expect(cli(fixture.root, fixture.env, "init", "--producer", "claude").stderr).toContain("--producer is supported only by review");
    expect(cli(fixture.root, fixture.env, "init", "--input", "payload.json").stderr).toContain("init accepts no input payload; omit --input");
    expect(cli(fixture.root, fixture.env, "review", "--producer", "claude", "--task", "example").stderr).toMatch(/Unknown option '--task'/u);
    expect(existsSync(join(fixture.root, ".archflow"))).toBe(false);
  }, TIMEOUT);

  it("initializes a repository with only the review inputs", () => {
    const fixture = repository();
    const initialized = cli(fixture.root, fixture.env, "init");
    expect(initialized.status, initialized.stderr).toBe(0);
    expect(initialized.value).toMatchObject({ schema_version: "1", ok: true });
    expect(readdirSync(join(fixture.root, ".archflow")).sort()).toEqual([".gitignore", "config.yaml", "constitution"]);
    const refreshed = cli(fixture.root, fixture.env, "init", "--force");
    expect(refreshed.status, refreshed.stderr).toBe(0);
    expect(refreshed.value).toMatchObject({ schema_version: "1", ok: true });
  }, TIMEOUT);

  it("reports a failed review result through the process exit code", () => {
    const fixture = repository();
    // A structured project failure keeps its full JSON body on stdout — scripts still parse the
    // error — while the exit code turns nonzero so an unchecked shell pipeline cannot mistake the
    // failure for success.
    const result = spawnSync(process.execPath, [localBundle, "review", "--producer", "claude"], {
      cwd: fixture.root, env: fixture.env, input: JSON.stringify({ schema_version: "1", stage: "plan" }), encoding: "utf8", timeout: TIMEOUT,
    });
    expect(result.status).toBe(1);
    expect(JSON.parse(result.stdout)).toMatchObject({ schema_version: "1", ok: false, error: { code: "INPUT_INVALID" } });
    expect(result.stderr).toContain("review failed: INPUT_INVALID");
  }, TIMEOUT);
});

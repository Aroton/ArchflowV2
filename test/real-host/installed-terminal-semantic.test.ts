/**
 * Opt-in installed-bundle journeys for the current public terminal surface.
 *
 * These tests scratch-install the tracked release payload, exercise supported `archflow-local`
 * commands, and drive the two semantic MCP tools directly over stdio. Model dispatch and host
 * selection live in the other real-host files; this file proves the shipped launchers themselves.
 */

import { spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  chmodSync,
  cpSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  readlinkSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { realHostsEnabled } from "../helpers/real-host.js";

const enabled = realHostsEnabled();
const TIMEOUT = 30_000;
const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const roots: string[] = [];
let installationRoot = "";
let checkoutRoot = "";
let scratchHome = "";
let scratchBin = "";
let installedEnvironment: NodeJS.ProcessEnv;
let developerSkillsBefore = "";

const gitIdentity: NodeJS.ProcessEnv = {
  GIT_CONFIG_GLOBAL: "/dev/null",
  GIT_CONFIG_SYSTEM: "/dev/null",
  GIT_AUTHOR_NAME: "ArchFlow Installed Journey",
  GIT_AUTHOR_EMAIL: "journey@example.invalid",
  GIT_COMMITTER_NAME: "ArchFlow Installed Journey",
  GIT_COMMITTER_EMAIL: "journey@example.invalid",
};

function digestTree(paths: readonly string[]): string {
  const hash = createHash("sha256");
  const visit = (path: string, label: string): void => {
    if (!existsSync(path)) {
      hash.update(`missing\0${label}\0`);
      return;
    }
    const stat = lstatSync(path);
    hash.update(`${stat.isDirectory() ? "d" : stat.isSymbolicLink() ? "l" : "f"}\0${label}\0${stat.mode}\0`);
    if (stat.isDirectory()) {
      for (const name of readdirSync(path).sort()) visit(join(path, name), `${label}/${name}`);
    } else if (stat.isSymbolicLink()) hash.update(readlinkSync(path));
    else hash.update(readFileSync(path));
  };
  paths.forEach((path, index) => visit(path, String(index)));
  return hash.digest("hex");
}

function git(root: string, ...argv: string[]): string {
  const result = spawnSync("git", argv, {
    cwd: root,
    env: { ...process.env, ...gitIdentity },
    encoding: "utf8",
    timeout: TIMEOUT,
  });
  expect(result.status, result.stderr).toBe(0);
  return result.stdout.trim();
}

function local(root: string, argv: readonly string[], value?: unknown): Readonly<{
  status: number | null;
  stderr: string;
  value: any;
}> {
  const result = spawnSync("archflow-local", [...argv], {
    cwd: root,
    env: installedEnvironment,
    input: value === undefined ? undefined : JSON.stringify(value),
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
    timeout: TIMEOUT,
  });
  return {
    status: result.status,
    stderr: result.stderr,
    value: result.stdout.trim() === "" ? undefined : JSON.parse(result.stdout),
  };
}

function makeRepository(name: string): string {
  const root = mkdtempSync(join(tmpdir(), `archflow-installed-${name}-`));
  roots.push(root);
  git(root, "-c", "init.defaultBranch=main", "init", "-q");
  writeFileSync(join(root, "README.md"), "installed journey\n");
  git(root, "add", "--", "README.md");
  git(root, "commit", "-q", "-m", "root");
  return root;
}

function initializeRepository(root: string): void {
  const initialized = local(root, ["init"]);
  expect(initialized.value, initialized.stderr).toMatchObject({ ok: true });
  git(root, "add", "--", ".gitattributes", ".archflow/workflow.yaml", ".archflow/constitution", ".archflow/config.yaml");
  git(root, "commit", "-q", "-m", "installed policy base");
}

async function mcpTool(root: string, name: "archflow_status" | "archflow_apply", input: unknown): Promise<any> {
  const child = spawn("archflow-mcp", [], {
    cwd: root,
    env: installedEnvironment,
    stdio: ["pipe", "pipe", "pipe"],
  });
  const stdout: Buffer[] = [];
  const stderr: Buffer[] = [];
  child.stdout.on("data", (chunk: Buffer) => stdout.push(Buffer.from(chunk)));
  child.stderr.on("data", (chunk: Buffer) => stderr.push(Buffer.from(chunk)));
  const waitForLines = async (count: number): Promise<void> => {
    if (Buffer.concat(stdout).toString("utf8").split("\n").length - 1 >= count) return;
    await new Promise<void>((resolveWait, reject) => {
      const timer = setTimeout(() => reject(new Error(`installed MCP timed out waiting for ${count} lines`)), TIMEOUT);
      const onData = (): void => {
        if (Buffer.concat(stdout).toString("utf8").split("\n").length - 1 < count) return;
        clearTimeout(timer);
        child.stdout.off("data", onData);
        resolveWait();
      };
      child.stdout.on("data", onData);
    });
  };

  child.stdin.write(`${JSON.stringify({
    jsonrpc: "2.0",
    id: "init",
    method: "initialize",
    params: {
      protocolVersion: "2025-11-25",
      capabilities: {},
      clientInfo: { name: "installed-terminal-journey", version: "1.0.0" },
    },
  })}\n`);
  await waitForLines(1);
  child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" })}\n`);
  child.stdin.write(`${JSON.stringify({
    jsonrpc: "2.0",
    id: "call",
    method: "tools/call",
    params: { name, arguments: input },
  })}\n`);
  await waitForLines(2);
  child.stdin.end();
  const exit = await new Promise<number | null>((resolveExit, reject) => {
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      reject(new Error("installed MCP timed out while exiting"));
    }, TIMEOUT);
    child.once("error", reject);
    child.once("exit", (code) => {
      clearTimeout(timer);
      resolveExit(code);
    });
  });
  expect(exit, Buffer.concat(stderr).toString("utf8")).toBe(0);
  const responses = Buffer.concat(stdout).toString("utf8").trim().split("\n").map((line) => JSON.parse(line));
  const response = responses.find((candidate) => candidate.id === "call");
  expect(response, `stderr=${Buffer.concat(stderr).toString("utf8")}`).toBeDefined();
  return response.result?.structuredContent;
}

beforeAll(() => {
  if (!enabled) return;
  const developerHome = process.env.HOME;
  if (developerHome === undefined) throw new Error("HOME is required for the non-mutation assertion");
  developerSkillsBefore = digestTree([
    join(developerHome, ".claude", "skills"),
    join(developerHome, ".agents", "skills"),
  ]);
  installationRoot = mkdtempSync(join(tmpdir(), "archflow-installed-launchers-"));
  checkoutRoot = join(installationRoot, "checkout");
  scratchHome = join(installationRoot, "home");
  scratchBin = join(installationRoot, "bin");
  mkdirSync(scratchHome, { recursive: true });
  mkdirSync(scratchBin, { recursive: true });
  mkdirSync(checkoutRoot, { recursive: true });
  for (const path of ["dist", "assets", "skills"]) {
    cpSync(join(repositoryRoot, path), join(checkoutRoot, path), { recursive: true });
  }
  for (const path of ["install.sh", "package.json"]) cpSync(join(repositoryRoot, path), join(checkoutRoot, path));
  chmodSync(join(checkoutRoot, "install.sh"), 0o755);
  installedEnvironment = {
    ...process.env,
    ...gitIdentity,
    HOME: scratchHome,
    ARCHFLOW_HOME: join(installationRoot, "archflow-home"),
    ARCHFLOW_BIN: scratchBin,
    PATH: `${scratchBin}:${process.env.PATH ?? ""}`,
  };
  const installed = spawnSync("./install.sh", [], {
    cwd: checkoutRoot,
    env: installedEnvironment,
    encoding: "utf8",
    timeout: TIMEOUT,
  });
  expect(installed.status, installed.stderr).toBe(0);
  expect(digestTree([join(developerHome, ".claude", "skills"), join(developerHome, ".agents", "skills")]))
    .toBe(developerSkillsBefore);
}, TIMEOUT);

afterAll(() => {
  const developerHome = process.env.HOME;
  if (enabled && developerHome !== undefined) {
    expect(digestTree([join(developerHome, ".claude", "skills"), join(developerHome, ".agents", "skills")]))
      .toBe(developerSkillsBefore);
  }
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
  if (installationRoot !== "") rmSync(installationRoot, { recursive: true, force: true });
});

describe.skipIf(!enabled)("installed terminal journeys", () => {
  it("advertises the current local command surface without retired protocol adapters", () => {
    const result = spawnSync("archflow-local", ["--help"], {
      cwd: checkoutRoot,
      env: installedEnvironment,
      encoding: "utf8",
      timeout: TIMEOUT,
    });
    expect(result.status, result.stderr).toBe(0);
    for (const command of [
      "validate", "hash", "render", "snapshot", "restore", "clean", "reconcile", "init",
      "manual-status", "automation-status", "upgrade", "upgrade-adopt", "set-commit-authority",
    ]) expect(result.stdout).toContain(command);
    for (const retired of ["build-request", "envelope", "decide"]) expect(result.stdout).not.toContain(retired);
  });

  it("runs payload and input-free commands through the scratch-installed launcher", () => {
    const root = makeRepository("local-surface");
    initializeRepository(root);
    const hashed = local(root, ["hash"], { current: "semantic-surface" });
    expect(hashed.status, hashed.stderr).toBe(0);
    expect(hashed.value).toMatchObject({ digest: expect.stringMatching(/^[0-9a-f]{64}$/u) });
    const status = local(root, ["manual-status", "--task", "missing-task"]);
    expect(status.status, status.stderr).toBe(0);
    expect(status.value).toMatchObject({
      ok: true,
      value: { mode: "degraded", next_action: { code: "wait-for-server" } },
    });
  });

  it("reports the task-initialization boundary through archflow_status over stdio", async () => {
    const root = makeRepository("semantic-journey");
    initializeRepository(root);
    const task = "installed-semantic";
    const status = await mcpTool(root, "archflow_status", {
      schema_version: "1",
      task_id: task,
    });
    expect(status, JSON.stringify(status)).toMatchObject({ ok: true, value: { next_action: { kind: "initialize-task" } } });
    expect(existsSync(join(root, ".archflow", "tasks", task, "state.json"))).toBe(false);
  });
});

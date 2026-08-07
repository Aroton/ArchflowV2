import { spawn, spawnSync } from "node:child_process";
import { chmod, cp, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { delimiter, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { afterEach, describe, expect, it } from "vitest";

const TEST_TIMEOUT_MS = 120_000;
const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const fakeHostFixture = join(repositoryRoot, "test", "fixtures", "init", "fake-host-cli.mjs");
const temporaryRoots: string[] = [];

async function checkoutCopy(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "archflow-install-"));
  temporaryRoots.push(root);
  await Promise.all([
    cp(join(repositoryRoot, "dist"), join(root, "dist"), { recursive: true }),
    cp(join(repositoryRoot, "assets"), join(root, "assets"), { recursive: true }),
    cp(join(repositoryRoot, "skills"), join(root, "skills"), { recursive: true }),
    cp(join(repositoryRoot, "install.sh"), join(root, "install.sh")),
    cp(join(repositoryRoot, "package.json"), join(root, "package.json")),
  ]);
  await chmod(join(root, "install.sh"), 0o755);
  return root;
}

function runInstaller(
  root: string,
  home: string,
  bin: string,
  path = `${bin}${delimiter}${process.env.PATH ?? ""}`,
  environment: NodeJS.ProcessEnv = {},
) {
  return spawnSync(join(root, "install.sh"), ["--claude"], {
    cwd: root,
    encoding: "utf8",
    env: { ...process.env, ...environment, HOME: home, ARCHFLOW_HOME: join(home, "archflow-home"), ARCHFLOW_BIN: bin, PATH: path },
    timeout: TEST_TIMEOUT_MS,
  });
}

function git(root: string, ...argv: string[]): void {
  const result = spawnSync("git", argv, {
    cwd: root,
    encoding: "utf8",
    env: {
      ...process.env,
      GIT_CONFIG_GLOBAL: "/dev/null",
      GIT_CONFIG_SYSTEM: "/dev/null",
      GIT_AUTHOR_NAME: "ArchFlow Test",
      GIT_AUTHOR_EMAIL: "test@example.invalid",
      GIT_COMMITTER_NAME: "ArchFlow Test",
      GIT_COMMITTER_EMAIL: "test@example.invalid",
    },
  });
  expect(result.status, result.stderr).toBe(0);
}

async function installFakeHosts(bin: string): Promise<void> {
  for (const adapter of ["claude", "codex"] as const) {
    const launcher = join(bin, adapter);
    await writeFile(launcher, `#!/bin/sh\nFAKE_HOST_ADAPTER=${adapter} exec "${process.execPath}" "${fakeHostFixture}" "$@"\n`);
    await chmod(launcher, 0o755);
  }
}

async function runInputFreeInit(
  command: string,
  cwd: string,
  environment: NodeJS.ProcessEnv,
): Promise<Readonly<{ code: number | null; stdout: string; stderr: string }>> {
  const child = spawn(command, ["init"], { cwd, env: environment, stdio: ["pipe", "pipe", "pipe"] });
  let stdout = "";
  let stderr = "";
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  child.stdout.on("data", (chunk: string) => { stdout += chunk; });
  child.stderr.on("data", (chunk: string) => { stderr += chunk; });
  const result = await new Promise<Readonly<{ code: number | null; stdout: string; stderr: string }>>((resolveResult, reject) => {
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      reject(new Error("archflow-local init waited for stdin"));
    }, 5_000);
    child.once("error", reject);
    child.once("exit", (code) => {
      clearTimeout(timer);
      resolveResult({ code, stdout, stderr });
    });
  });
  child.stdin.destroy();
  return result;
}

afterEach(async () => {
  await Promise.all(temporaryRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("installer", () => {
  it("installs a verified offline bundle and prunes only previously owned skill files", async () => {
    const root = await checkoutCopy();
    const home = join(root, "home");
    const bin = join(home, "bin");
    const skillRoot = join(home, ".claude", "skills");
    await mkdir(join(skillRoot, "unrelated"), { recursive: true });
    await mkdir(join(skillRoot, "archflow-status"), { recursive: true });
    await writeFile(join(skillRoot, "unrelated", "SKILL.md"), "human-owned\n");
    await writeFile(join(skillRoot, "archflow-status", "obsolete.md"), "obsolete\n");
    await writeFile(join(skillRoot, ".archflow-installed"), "archflow-status/obsolete.md\n");

    const installed = runInstaller(root, home, bin);
    expect(installed.error).toBeUndefined();
    expect(installed.status, installed.stderr).toBe(0);
    expect(await readFile(join(skillRoot, "unrelated", "SKILL.md"), "utf8")).toBe("human-owned\n");
    await expect(readFile(join(skillRoot, "archflow-status", "obsolete.md"))).rejects.toMatchObject({ code: "ENOENT" });
    expect(await readFile(join(home, "archflow-home", "bundle", "assets", "config.template.yaml"), "utf8"))
      .toBe(await readFile(join(root, "assets", "config.template.yaml"), "utf8"));

    const handshake = `${JSON.stringify({
      jsonrpc: "2.0", id: 1, method: "initialize",
      params: { protocolVersion: "2025-11-25", capabilities: {}, clientInfo: { name: "claude-code", version: "2.1.220" } },
    })}\n`;
    const server = spawnSync(join(bin, "archflow-mcp"), [], {
      cwd: root, encoding: "utf8", input: handshake,
      env: { ...process.env, HOME: home, PATH: `${bin}${delimiter}${process.env.PATH ?? ""}` },
      timeout: TEST_TIMEOUT_MS,
    });
    expect(server.status, server.stderr).toBe(0);
    expect(JSON.parse(server.stdout.trim())).toMatchObject({ jsonrpc: "2.0", id: 1, result: { protocolVersion: "2025-11-25" } });

    git(root, "-c", "init.defaultBranch=main", "init", "-q");
    await installFakeHosts(bin);
    const hostEnvironment = {
      ...process.env,
      HOME: home,
      PATH: `${bin}${delimiter}${process.env.PATH ?? ""}`,
      FAKE_CODEX_TRUSTED: "1",
    };
    const initialized = await runInputFreeInit(join(bin, "archflow-local"), root, hostEnvironment);
    expect(initialized.code, initialized.stderr).toBe(0);
    expect(JSON.parse(initialized.stdout)).toMatchObject({ ok: true, value: { creates_task_state: false, creates_commit: false } });

    git(root, "add", "--", ".gitattributes", ".archflow/workflow.yaml", ".archflow/constitution", ".archflow/config.yaml");
    git(root, "commit", "-q", "-m", "approve policy");
    const taskInit = spawnSync(join(bin, "archflow-local"), ["task-init", "--task", "demo"], {
      cwd: root, encoding: "utf8", env: hostEnvironment, timeout: TEST_TIMEOUT_MS,
    });
    expect(taskInit.status, taskInit.stderr).toBe(0);
    expect(JSON.parse(taskInit.stdout)).toMatchObject({ ok: true, value: { artifact_kind: "task-initialization" } });

    const portable = [
      await readFile(join(root, ".mcp.json"), "utf8"),
      await readFile(join(root, ".codex", "config.toml"), "utf8"),
      taskInit.stdout,
    ].join("\n");
    expect(portable).not.toContain(home);
    expect(portable).not.toContain(join(home, "archflow-home"));
  }, TEST_TIMEOUT_MS);

  it("rejects a mutated runtime asset before copying it", async () => {
    const root = await checkoutCopy();
    const home = join(root, "home");
    const bin = join(home, "bin");
    await writeFile(join(root, "assets", "workflow.yaml"), "mutated\n");
    const installed = runInstaller(root, home, bin);
    expect(installed.status).toBe(1);
    expect(installed.stderr).toContain("payload verification failed for assets/workflow.yaml");
  }, TEST_TIMEOUT_MS);

  it("prints the exact PATH export and fails when launchers are not resolvable", async () => {
    const root = await checkoutCopy();
    const home = join(root, "home");
    const bin = join(home, "not-on-path");
    const installed = runInstaller(root, home, bin, process.env.PATH ?? "");
    expect(installed.status).toBe(1);
    expect(installed.stderr).toContain(`export PATH="${bin}:$PATH"`);
  }, TEST_TIMEOUT_MS);

  it.each(["23.99.0", "24.14.0"])("rejects unsupported Node %s before installation", async (version) => {
    const root = await checkoutCopy();
    const home = join(root, "home");
    const bin = join(home, "bin");
    await mkdir(bin, { recursive: true });
    const fakeNode = join(bin, "node");
    const fakeNodeProgram = join(bin, "fake-node.cjs");
    await writeFile(fakeNodeProgram, `Object.defineProperty(process.versions, "node", { value: process.env.FAKE_NODE_VERSION });\nif (process.argv[2] !== "-e") process.exit(92);\nconst source = process.argv[3];\nprocess.argv = [process.argv[0], ...process.argv.slice(4)];\neval(source);\n`);
    await writeFile(fakeNode, `#!/bin/sh\nexec "${process.execPath}" "${fakeNodeProgram}" "$@"\n`);
    await chmod(fakeNode, 0o755);
    const installed = runInstaller(
      root,
      home,
      bin,
      `${bin}${delimiter}${process.env.PATH ?? ""}`,
      { FAKE_NODE_VERSION: version },
    );
    expect(installed.status).toBe(1);
    expect(installed.stderr).toContain(`ArchFlow requires Node ^24.15.0; observed ${version}.`);
  }, TEST_TIMEOUT_MS);
});

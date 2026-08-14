import { access, chmod, mkdir, mkdtemp, readFile, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { delimiter, dirname, join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import reviewSchema from "../../src/contracts/schemas/v1/review.schema.json" with { type: "json" };
import { selectCliAdapter, type CliAdapter } from "../../src/dispatch/cli.js";
import {
  DispatchProcessError,
  runDispatchChild,
  scanDispatchOutput,
  type DispatchChildResult,
} from "../../src/dispatch/process.js";
import type { DispatchRoute } from "../../src/dispatch/routing.js";
import { createDispatchWorkspace, type DispatchWorkspace } from "../../src/dispatch/workspace.js";
import type { AdapterId } from "../../src/contracts/review.js";
import type { DispatchEnvelope } from "../../src/review/envelopes.js";

const scratchRoots: string[] = [];
const plantedNames = [
  "ANTHROPIC_API_KEY",
  "CODEX_API_KEY",
  "CODEX_ACCESS_TOKEN",
  "ANTHROPIC_MODEL",
  "OPENAI_BASE_URL",
  "AWS_PROFILE",
  "ARCHFLOW_UNRELATED_SENTINEL",
] as const;

type Observation = Readonly<{
  pid: number;
  parent_pid: number;
  session_id: number | null;
  cwd: string;
  env: Record<string, string>;
  stdin_base64?: string;
  argv: string[];
}>;

afterEach(async () => {
  await Promise.all(scratchRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

function envelope(text = '{"schema_version":"1"}\n'): DispatchEnvelope {
  const bytes = Buffer.from(text);
  return Object.freeze({
    result_kind: "review",
    bytes,
    digest: "d".repeat(64) as never,
    byte_count: bytes.byteLength,
  });
}

function route(adapter: AdapterId): DispatchRoute {
  return adapter === "claude-cli"
    ? { adapter, family: "claude", model: "claude-opus-4-6", effort: "high" }
    : { adapter, family: "codex", model: "gpt-5.3-codex", effort: "high" };
}

async function fixtureWorkspace(
  adapter: AdapterId,
  scenario: string,
): Promise<Readonly<{ workspace: DispatchWorkspace; outside: string }>> {
  const outside = await mkdtemp(join(tmpdir(), "archflow-plumbing-fixture-"));
  scratchRoots.push(outside);
  const sourceHome = join(outside, "source-home");
  const bin = join(outside, "bin");
  const credentialDirectory = adapter === "claude-cli"
    ? join(sourceHome, "claude-profile")
    : join(sourceHome, "codex-profile");
  const credential = join(
    credentialDirectory,
    adapter === "claude-cli" ? ".credentials.json" : "auth.json",
  );
  await Promise.all([mkdir(dirname(credential), { recursive: true }), mkdir(bin)]);
  await writeFile(credential, '{"fixture":"not-a-real-credential"}\n');

  const family = adapter === "claude-cli" ? "claude" : "codex";
  const fixture = new URL(`../fixtures/dispatch/plumbing-${family}.mjs`, import.meta.url);
  await chmod(fixture, 0o755);
  await symlink(fixture, join(bin, family));

  const names = ["HOME", "CODEX_HOME", "CLAUDE_CONFIG_DIR", "PATH", "LANG", "LC_ALL", "HTTP_PROXY", "HTTPS_PROXY", "NO_PROXY", "NODE_EXTRA_CA_CERTS", ...plantedNames] as const;
  const saved = new Map(names.map((name) => [name, process.env[name]]));
  try {
    process.env.HOME = sourceHome;
    if (adapter === "claude-cli") {
      process.env.CLAUDE_CONFIG_DIR = credentialDirectory;
      delete process.env.CODEX_HOME;
    } else {
      process.env.CODEX_HOME = credentialDirectory;
      delete process.env.CLAUDE_CONFIG_DIR;
    }
    process.env.PATH = `${bin}${delimiter}${dirname(process.execPath)}`;
    process.env.LANG = "C.UTF-8";
    process.env.LC_ALL = "C.UTF-8";
    process.env.HTTP_PROXY = "http://allowed-proxy.invalid";
    process.env.HTTPS_PROXY = "http://allowed-proxy.invalid";
    process.env.NO_PROXY = "localhost";
    process.env.NODE_EXTRA_CA_CERTS = join(outside, "allowed-ca.pem");
    for (const name of plantedNames) process.env[name] = `planted-${name.toLowerCase()}`;
    const workspace = await createDispatchWorkspace(adapter, process.cwd());
    await writeFile(join(workspace.root, "plumbing-scenario"), `${scenario}\n`);
    return { workspace, outside };
  } finally {
    for (const [name, value] of saved) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  }
}

async function dispatch(
  adapter: CliAdapter,
  workspace: DispatchWorkspace,
  input: DispatchEnvelope,
  signal = new AbortController().signal,
  byteCap?: number,
): Promise<DispatchChildResult> {
  await adapter.preflight(workspace);
  const invocation = await adapter.buildInvocation(input, route(adapter.id), workspace, reviewSchema);
  return runDispatchChild({ ...invocation, signal, ...(byteCap === undefined ? {} : { byte_cap: byteCap }) });
}

async function observation(workspace: DispatchWorkspace): Promise<Observation> {
  return JSON.parse(await readFile(join(workspace.root, "plumbing-observation.json"), "utf8")) as Observation;
}

async function waitForFile(path: string): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (await stat(path).then(() => true, () => false)) return;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error(`timed out waiting for ${path}`);
}

async function waitForProcessExit(pid: number): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    try {
      process.kill(pid, 0);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ESRCH") return;
      throw error;
    }
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error(`process ${pid} survived process-group termination`);
}

describe("dispatch plumbing proof", () => {
  it.each([
    ["claude", "codex-cli"],
    ["codex", "claude-cli"],
  ] as const)("dispatches host %s to a fresh opposite-family %s child", async (host, expectedAdapter) => {
    const adapter = selectCliAdapter(host, { allow_claude_dispatch: true });
    expect(adapter.id).toBe(expectedAdapter);
    const { workspace } = await fixtureWorkspace(adapter.id, "observe-input");
    const input = envelope('{"schema_version":"1","artifact":"envelope-only"}\n');
    try {
      const result = await dispatch(adapter, workspace, input);
      expect(adapter.classifyFailure(result)).toBeUndefined();
      expect(JSON.parse(Buffer.from(adapter.parseOutput(result)).toString("utf8"))).toEqual({ schema_version: "1" });

      const seen = await observation(workspace);
      expect(seen.pid).not.toBe(process.pid);
      expect(seen.parent_pid).toBe(process.pid);
      if (process.platform === "linux") expect(seen.session_id).toBe(seen.pid);
      expect(seen.cwd).toBe(workspace.root);
      expect(Buffer.from(seen.stdin_base64!, "base64")).toEqual(Buffer.from(input.bytes));
      expect(seen.argv).toEqual(expect.arrayContaining(adapter.id === "claude-cli"
        ? ["--tools", "", "--setting-sources", ""]
        : ["--ignore-user-config", "--ignore-rules", "project_doc_max_bytes=0"]));

      const expectedKeys = [
        ...(adapter.id === "claude-cli" ? ["CLAUDE_CONFIG_DIR"] : ["CODEX_HOME"]),
        "HOME", "HTTPS_PROXY", "HTTP_PROXY", "LANG", "LC_ALL", "NODE_EXTRA_CA_CERTS", "NO_PROXY", "PATH", "TMPDIR",
      ].sort();
      expect(Object.keys(seen.env).sort()).toEqual(expectedKeys);
      expect(seen.env.HOME).toBe(workspace.env.HOME);
      expect(seen.env[adapter.id === "claude-cli" ? "CLAUDE_CONFIG_DIR" : "CODEX_HOME"])
        .toBe(workspace.env[adapter.id === "claude-cli" ? "CLAUDE_CONFIG_DIR" : "CODEX_HOME"]);
      for (const name of plantedNames) expect(seen.env).not.toHaveProperty(name);
    } finally {
      await workspace.dispose();
    }
    await expect(access(workspace.root)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("keeps workspaces caller-disposable after child failure and abort", async () => {
    for (const scenario of ["failure", "hang"] as const) {
      const adapter = selectCliAdapter("claude");
      const { workspace } = await fixtureWorkspace(adapter.id, scenario);
      try {
        if (scenario === "failure") {
          const result = await dispatch(adapter, workspace, envelope());
          expect(adapter.classifyFailure(result)?.code).toBe("PROCESS_FAILED");
        } else {
          const controller = new AbortController();
          const pending = dispatch(adapter, workspace, envelope(), controller.signal);
          setTimeout(() => controller.abort(), 50).unref();
          await expect(pending).rejects.toMatchObject({ project_error: { code: "CANCELLED" } });
        }
      } finally {
        await workspace.dispose();
      }
      await expect(access(workspace.root)).rejects.toMatchObject({ code: "ENOENT" });
    }
  });

  it.runIf(process.platform !== "win32")("reaps an in-group grandchild when dispatch is cancelled", async () => {
    const root = await mkdtemp(join(tmpdir(), "archflow-dispatch-grandchild-"));
    scratchRoots.push(root);
    const fixture = new URL("../fixtures/dispatch/grandchild.mjs", import.meta.url);
    const controller = new AbortController();
    const pending = runDispatchChild({
      adapter: "codex-cli",
      command: process.execPath,
      argv: [fixture.pathname],
      cwd: root,
      env: { PATH: dirname(process.execPath) },
      signal: controller.signal,
    });
    await waitForFile(join(root, "grandchild-pid"));
    const childPid = Number((await readFile(join(root, "child-pid"), "utf8")).trim());
    const grandchildPid = Number((await readFile(join(root, "grandchild-pid"), "utf8")).trim());

    controller.abort();
    await expect(pending).rejects.toMatchObject({ project_error: { code: "CANCELLED" } });
    await Promise.all([waitForProcessExit(childPid), waitForProcessExit(grandchildPid)]);
  });

  it("bounds the Codex final file independently while its JSONL remains small", async () => {
    const adapter = selectCliAdapter("claude");
    const { workspace } = await fixtureWorkspace(adapter.id, "overgrown-final");
    try {
      await expect(dispatch(adapter, workspace, envelope(), undefined, 128)).rejects.toMatchObject({
        project_error: { code: "OUTPUT_OVERFLOW", diagnostic: { parameters: { adapter: "codex-cli", byte_cap: 128 } } },
      });
      expect((await readFile(join(workspace.root, "final-output.json"))).byteLength).toBeGreaterThan(128);
      // The fixture emits only this 26-byte event on stdout before the independently bounded file is read.
      expect(Buffer.byteLength('{"type":"turn.completed"}\n')).toBeLessThan(128);
    } finally {
      await workspace.dispose();
    }
  });

  it.each(["claude", "codex"] as const)("keeps planted canaries out of %s output and diagnostics", async (host) => {
    const adapter = selectCliAdapter(host, { allow_claude_dispatch: true });
    const { workspace } = await fixtureWorkspace(adapter.id, "success");
    const canaries = ["credential-canary-7429", "routing-sentinel-1836"];
    try {
      const result = await dispatch(adapter, workspace, envelope(`{"schema_version":"1","artifact":"${canaries.join(" ")}"}\n`));
      expect(scanDispatchOutput(result, canaries)).toEqual([]);
      const diagnostics = await readFile(join(workspace.root, "plumbing-observation.json"));
      expect(scanDispatchOutput({ stdout: diagnostics, stderr: Buffer.alloc(0) }, canaries)).toEqual([]);
    } finally {
      await workspace.dispose();
    }
  });

  it("proves the canary scan catches a deliberately leaking fake", async () => {
    const root = await mkdtemp(join(tmpdir(), "archflow-plumbing-leak-"));
    scratchRoots.push(root);
    const fixture = new URL("../fixtures/dispatch/plumbing-leak.mjs", import.meta.url);
    await chmod(fixture, 0o755);
    const canary = "credential-canary-negative-control";
    const result = await runDispatchChild({
      adapter: "codex-cli",
      command: fixture.pathname,
      argv: [],
      cwd: root,
      env: { PATH: `${dirname(process.execPath)}` },
      stdin: Buffer.from(canary),
      signal: new AbortController().signal,
    });
    expect(scanDispatchOutput(result, [canary])).toEqual([canary]);
  });

  it("renders prompt input as only the envelope, excluding global, skill, and project documents", async () => {
    const adapter = selectCliAdapter("claude");
    const { workspace, outside } = await fixtureWorkspace(adapter.id, "prompt-input");
    const excluded = ["GLOBAL-AGENTS-CANARY", "SKILL-DESCRIPTION-CANARY", "PROJECT-DOC-CANARY"];
    await Promise.all([
      writeFile(join(outside, "source-home", "AGENTS.md"), excluded[0]!),
      mkdir(join(workspace.root, ".codex", "skills", "planted"), { recursive: true }).then(() =>
        writeFile(join(workspace.root, ".codex", "skills", "planted", "SKILL.md"), excluded[1]!)),
      writeFile(join(workspace.root, "AGENTS.md"), excluded[2]!),
    ]);
    const input = envelope('{"schema_version":"1","artifact":"prompt-envelope"}\n');
    try {
      await dispatch(adapter, workspace, input);
      const rendered = await readFile(join(workspace.root, "prompt-input.json"), "utf8");
      expect(JSON.parse(rendered)).toEqual({ messages: [{ role: "user", content: Buffer.from(input.bytes).toString("utf8") }] });
      for (const value of excluded) expect(rendered).not.toContain(value);
      // This fixture models `codex debug prompt-input`: it inspects input messages, not tools[].
      // Codex exposes no corresponding tool-surface inspection command, so this is not such a proof.
    } finally {
      await workspace.dispose();
    }
  });
});

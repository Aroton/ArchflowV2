import { execFileSync } from "node:child_process";
import { chmod, mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { afterEach, describe, expect, it, vi } from "vitest";

import {
  CLAUDE_MCP_TIMEOUT_MS,
  CLAUDE_PASTE_GUIDANCE,
  CODEX_MANAGED_BLOCK,
  CODEX_PASTE_GUIDANCE,
  registerClaudeProject,
  registerCodexProject,
} from "../../src/init/registration.js";
import { runInit } from "../../src/init/index.js";
import { collectInitDiagnostics } from "../../src/init/diagnostics.js";

const fixture = fileURLToPath(new URL("../fixtures/init/fake-host-cli.mjs", import.meta.url));
const temporary: string[] = [];

async function setup(): Promise<{ repository: string; env: NodeJS.ProcessEnv }> {
  const root = await mkdtemp(join(tmpdir(), "archflow-init-registration-"));
  temporary.push(root);
  const repository = join(root, "repository with ünicode");
  const bin = join(root, "bin");
  await mkdir(repository, { recursive: true });
  await mkdir(bin);
  for (const adapter of ["claude", "codex"] as const) {
    const launcher = join(bin, adapter);
    await writeFile(launcher, `#!/bin/sh\nFAKE_HOST_ADAPTER=${adapter} exec "${process.execPath}" "${fixture}" "$@"\n`);
    await chmod(launcher, 0o755);
  }
  return { repository, env: { ...process.env, PATH: `${bin}:${process.env.PATH ?? ""}` } };
}

afterEach(async () => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  const { rm } = await import("node:fs/promises");
  await Promise.all(temporary.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

describe("host registration", () => {
  it("registers Claude, patches the timeout, and is byte-stable", async () => {
    const { repository, env } = await setup();
    const first = await registerClaudeProject({ working_directory: repository, environment: env });
    expect(first.ok).toBe(true);
    const path = join(repository, ".mcp.json");
    const once = await readFile(path, "utf8");
    expect(JSON.parse(once).mcpServers.archflow.timeout).toBe(CLAUDE_MCP_TIMEOUT_MS);
    expect(once.endsWith("\n")).toBe(true);
    const second = await registerClaudeProject({ working_directory: repository, environment: env });
    expect(second.ok).toBe(true);
    expect(await readFile(path, "utf8")).toBe(once);
  });

  it("preserves unrelated Claude servers and tolerates duplicate exit one", async () => {
    const { repository, env } = await setup();
    const path = join(repository, ".mcp.json");
    await writeFile(path, JSON.stringify({ mcpServers: {
      alpha: { command: "alpha", env: { X: "1" } },
      beta: { command: "beta", args: ["--flag"] },
    } }));
    const result = await registerClaudeProject({
      working_directory: repository,
      environment: { ...env, FAKE_CLAUDE_DUPLICATE: "1" },
    });
    expect(result.ok).toBe(true);
    const parsed = JSON.parse(await readFile(path, "utf8"));
    expect(parsed.mcpServers.alpha).toEqual({ command: "alpha", env: { X: "1" } });
    expect(parsed.mcpServers.beta).toEqual({ command: "beta", args: ["--flag"] });
  });

  it("refuses foreign Claude top-level keys and command collisions", async () => {
    const { repository, env } = await setup();
    const path = join(repository, ".mcp.json");
    await writeFile(path, JSON.stringify({ $schema: "foreign", mcpServers: {} }));
    const write = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    const foreign = await registerClaudeProject({ working_directory: repository, environment: env });
    expect(foreign.ok ? undefined : foreign.error.diagnostic.parameters).toEqual({ issue_code: "mcp-json-foreign-keys" });
    expect(write).toHaveBeenCalledWith(CLAUDE_PASTE_GUIDANCE);
    await writeFile(path, JSON.stringify({ mcpServers: { archflow: { command: "other" } } }));
    const collision = await registerClaudeProject({ working_directory: repository, environment: env });
    expect(collision.ok ? undefined : collision.error.diagnostic.parameters).toEqual({ issue_code: "server-command-collision" });
    expect(write).toHaveBeenLastCalledWith(CLAUDE_PASTE_GUIDANCE);
  });

  it("writes the project entry even when Claude reports a higher-precedence mask", async () => {
    const { repository, env } = await setup();
    const result = await registerClaudeProject({
      working_directory: repository,
      environment: { ...env, FAKE_CLAUDE_GET: "Scope: Local\nCommand: other\n" },
    });
    expect(result.ok && result.value.masked_by_higher_precedence).toBe(true);
    expect(JSON.parse(await readFile(join(repository, ".mcp.json"), "utf8")).mcpServers.archflow.command).toBe("archflow-mcp");
  });

  it("appends and replaces only the owned Codex block", async () => {
    const { repository, env } = await setup();
    const path = join(repository, ".codex", "config.toml");
    await mkdir(dirname(path), { recursive: true });
    const prefix = "# user's comment\nmodel = \"gpt-test\"\n";
    await writeFile(path, prefix);
    const first = await registerCodexProject({
      working_directory: repository,
      environment: { ...env, FAKE_CODEX_TRUSTED: "1" },
    });
    expect(first.ok && first.value.project_trusted).toBe(true);
    const once = await readFile(path, "utf8");
    expect(once).toBe(`${prefix}${CODEX_MANAGED_BLOCK}`);
    const second = await registerCodexProject({
      working_directory: repository,
      environment: { ...env, FAKE_CODEX_TRUSTED: "1" },
    });
    expect(second.ok).toBe(true);
    expect(await readFile(path, "utf8")).toBe(once);
    expect(once).not.toContain("trust_level");
  });

  it("refuses outside Codex conflicts and reports untrusted projects", async () => {
    const { repository, env } = await setup();
    const path = join(repository, ".codex", "config.toml");
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, "[mcp_servers.archflow]\ncommand = \"other\"\n");
    const write = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    const collision = await registerCodexProject({ working_directory: repository, environment: env });
    expect(collision.ok ? undefined : collision.error.diagnostic.parameters).toEqual({ issue_code: "server-command-collision" });
    expect(write).toHaveBeenCalledWith(CODEX_PASTE_GUIDANCE);
    await writeFile(path, "model = \"gpt-test\"\n");
    const untrusted = await registerCodexProject({ working_directory: repository, environment: env });
    expect(untrusted.ok && untrusted.value.project_trusted).toBe(false);
    expect(await readFile(path, "utf8")).not.toContain("trust_level");
  });

  it("refuses an inline archflow entry under the bare Codex MCP table", async () => {
    const { repository, env } = await setup();
    const path = join(repository, ".codex", "config.toml");
    await mkdir(dirname(path), { recursive: true });
    const source = "[mcp_servers]\narchflow = { command = \"other-binary\", args = [] }\n";
    await writeFile(path, source);
    const write = vi.spyOn(process.stderr, "write").mockImplementation(() => true);

    const collision = await registerCodexProject({ working_directory: repository, environment: env });

    expect(collision.ok ? undefined : collision.error.diagnostic.parameters).toEqual({ issue_code: "server-command-collision" });
    expect(write).toHaveBeenCalledWith(CODEX_PASTE_GUIDANCE);
    expect(await readFile(path, "utf8")).toBe(source);
  });

  it("fails closed for an ambiguous inline archflow entry under the bare Codex MCP table", async () => {
    const { repository, env } = await setup();
    const path = join(repository, ".codex", "config.toml");
    await mkdir(dirname(path), { recursive: true });
    const source = "[mcp_servers]\narchflow = { args = [] }\n";
    await writeFile(path, source);
    vi.spyOn(process.stderr, "write").mockImplementation(() => true);

    const foreign = await registerCodexProject({ working_directory: repository, environment: env });

    expect(foreign.ok ? undefined : foreign.error.diagnostic.parameters).toEqual({ issue_code: "codex-config-foreign" });
    expect(await readFile(path, "utf8")).toBe(source);
  });

  it("does not treat a same-command global Codex entry as project trust", async () => {
    const { repository, env } = await setup();

    const result = await registerCodexProject({ working_directory: repository, environment: env });

    expect(result.ok && result.value.project_trusted).toBe(false);
    expect(result.ok && result.value.masked_by_higher_precedence).toBe(false);
  });

  it("maps a missing host binary to the existing CLI_MISSING error", async () => {
    const { repository } = await setup();
    const result = await registerClaudeProject({ working_directory: repository, environment: { PATH: "" } });
    expect(result.ok ? undefined : result.error.code).toBe("CLI_MISSING");
  });

  it("orchestrates scaffold, registration, and scrubbed preflight with fake binaries", async () => {
    const { repository, env } = await setup();
    execFileSync("git", ["-c", "init.defaultBranch=main", "init", "-q"], { cwd: repository });
    vi.stubEnv("PATH", env.PATH!);
    vi.stubEnv("HOME", join(dirname(repository), "home"));
    const result = await runInit({ working_directory: repository });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.assets.created).toContain(".archflow/workflow.yaml");
    expect(result.value.claude_registration?.command).toBe("archflow-mcp");
    expect(result.value.codex_registration?.command).toBe("archflow-mcp");
    expect(result.value.diagnostics.claude.version).toBe("2.1.220");
    expect(result.value.diagnostics.codex.version).toBe("0.146.0");
    expect(result.value.diagnostics.limitations.join(" ")).toContain("best-effort");
  });

  it("reports the existing below-floor and logged-out preflight errors", async () => {
    const { repository, env } = await setup();
    const bin = env.PATH!.split(":")[0]!;
    const claude = join(bin, "claude");
    vi.stubEnv("PATH", env.PATH!);
    vi.stubEnv("HOME", join(dirname(repository), "home"));

    await writeFile(claude, `#!/bin/sh\nFAKE_HOST_ADAPTER=claude FAKE_CLAUDE_VERSION=2.1.100 exec "${process.execPath}" "${fixture}" "$@"\n`);
    await chmod(claude, 0o755);
    const belowFloor = await collectInitDiagnostics({ working_directory: repository });
    expect(belowFloor.claude.version).toBe("2.1.100");
    expect(belowFloor.claude.error?.code).toBe("CLI_VERSION_UNSUPPORTED");

    await writeFile(claude, `#!/bin/sh\nFAKE_HOST_ADAPTER=claude FAKE_LOGGED_OUT=1 exec "${process.execPath}" "${fixture}" "$@"\n`);
    await chmod(claude, 0o755);
    const loggedOut = await collectInitDiagnostics({ working_directory: repository });
    expect(loggedOut.claude.authenticated).toBe(false);
    expect(loggedOut.claude.error?.code).toBe("AUTH_UNAVAILABLE");
  });
});

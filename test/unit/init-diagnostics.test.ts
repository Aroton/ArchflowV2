import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it, vi } from "vitest";

import type { DispatchChildSpec } from "../../src/dispatch/process.js";

const { createDispatchWorkspace, runDispatchChild, stat } = vi.hoisted(() => ({
  createDispatchWorkspace: vi.fn(),
  runDispatchChild: vi.fn(),
  stat: vi.fn(),
}));

vi.mock("node:fs/promises", async (importOriginal) => ({
  ...await importOriginal<typeof import("node:fs/promises")>(),
  stat,
}));

vi.mock("../../src/dispatch/workspace.js", () => ({ createDispatchWorkspace }));

vi.mock("../../src/dispatch/process.js", async (importOriginal) => ({
  ...await importOriginal<typeof import("../../src/dispatch/process.js")>(),
  runDispatchChild,
}));

import {
  claudeTimeoutFinding,
  codexTimeoutFinding,
  collectInitDiagnostics,
  diagnoseIgnoredGeneratedAssets,
  diagnoseRuntimeDirectory,
} from "../../src/init/diagnostics.js";
import {
  CLAUDE_MCP_TIMEOUT_MS,
  CODEX_MANAGED_BLOCK,
  CODEX_TOOL_TIMEOUT_SEC,
} from "../../src/init/registration.js";

function claudeConfig(entry: Record<string, unknown>): string {
  return `${JSON.stringify({ mcpServers: { archflow: entry } }, null, 2)}\n`;
}

const workspace = Object.freeze({
  root: "/tmp/archflow-init-diagnostics",
  env: Object.freeze({
    PATH: "/bin",
    HOME: "/tmp/archflow-init-diagnostics/home",
    TMPDIR: "/tmp/archflow-init-diagnostics",
    CODEX_HOME: "/tmp/archflow-init-diagnostics/home/.codex",
  }),
  dispose: vi.fn(async () => undefined),
});

describe("init diagnostics", () => {
  it("verifies that runtime is ignored and reports any already tracked runtime paths", async () => {
    const repository = await mkdtemp(join(tmpdir(), "archflow-init-work-diagnostic-"));
    try {
      execFileSync("git", ["-c", "init.defaultBranch=main", "init", "-q"], { cwd: repository });
      await mkdir(join(repository, ".archflow", "runtime", "tasks", "demo"), { recursive: true });
      await writeFile(join(repository, ".archflow", ".gitignore"), "/runtime/\n", "utf8");
      await writeFile(join(repository, ".archflow", "runtime", "tasks", "demo", "cached.json"), "{}\n", "utf8");

      const clean = await diagnoseRuntimeDirectory(repository);
      expect(clean).toEqual({ ignored: true, tracked_paths: [], error: null });

      execFileSync("git", ["add", "-f", ".archflow/runtime/tasks/demo/cached.json"], { cwd: repository });
      const contaminated = await diagnoseRuntimeDirectory(repository);
      expect(contaminated.ignored).toBe(true);
      expect(contaminated.tracked_paths).toEqual([".archflow/runtime/tasks/demo/cached.json"]);
      expect(contaminated.error).toBeNull();
    } finally {
      await rm(repository, { recursive: true, force: true });
    }
  });

  it("reports generated assets hidden by ancestor ignore rules", async () => {
    const repository = await mkdtemp(join(tmpdir(), "archflow-init-hidden-assets-"));
    try {
      execFileSync("git", ["-c", "init.defaultBranch=main", "init", "-q"], { cwd: repository });
      await writeFile(join(repository, ".gitignore"), ".archflow/\n.mcp.json\n", "utf8");
      const hidden = await diagnoseIgnoredGeneratedAssets(repository);
      expect(hidden).toContain(".archflow/workflow.yaml");
      expect(hidden).toContain(".archflow/config.yaml");
      expect(hidden).toContain(".archflow/hazards.yaml");
      expect(hidden).toContain(".mcp.json");
      expect(hidden).not.toContain(".codex/config.toml");
    } finally {
      await rm(repository, { recursive: true, force: true });
    }
  });

  it("retains an observed CLI version when authentication fails", async () => {
    stat.mockRejectedValue(Object.assign(new Error("missing"), { code: "ENOENT" }));
    createDispatchWorkspace.mockResolvedValue(workspace);
    runDispatchChild.mockImplementation(async (spec: DispatchChildSpec) => {
      const stdout = spec.argv[0] === "--version"
        ? spec.adapter === "claude-cli" ? "2.1.220 (Claude Code)\n" : "codex-cli 0.146.0\n"
        : "Logged out\n";
      return Object.freeze({
        exit_code: 0,
        signal: null,
        stdout: Buffer.from(stdout),
        stderr: Buffer.alloc(0),
      });
    });

    const result = await collectInitDiagnostics({ working_directory: "/repo" });

    expect(result.claude).toMatchObject({
      version: "2.1.220",
      authenticated: false,
      error: { code: "AUTH_UNAVAILABLE" },
    });
    expect(result.codex).toMatchObject({
      version: "0.146.0",
      authenticated: false,
      error: { code: "AUTH_UNAVAILABLE" },
    });
  });

  it("reports no timeout finding when both host configs carry the registered timeouts", () => {
    const claude = claudeConfig({ type: "stdio", command: "archflow-mcp", args: [], timeout: CLAUDE_MCP_TIMEOUT_MS });
    expect(claudeTimeoutFinding(claude)).toBeUndefined();
    expect(codexTimeoutFinding(CODEX_MANAGED_BLOCK)).toBeUndefined();
  });

  it("reports a finding when a registered entry is missing its timeout field", () => {
    const claude = claudeConfig({ type: "stdio", command: "archflow-mcp", args: [] });
    const claudeFinding = claudeTimeoutFinding(claude);
    expect(claudeFinding).toContain(`is missing "timeout": ${CLAUDE_MCP_TIMEOUT_MS}`);
    expect(claudeFinding).toContain("fifteen minutes");
    expect(claudeFinding).toContain("~2 minutes");
    expect(claudeFinding).toContain("archflow-init");

    const codex = "[mcp_servers.archflow]\ncommand = \"archflow-mcp\"\nargs = []\n";
    const codexFinding = codexTimeoutFinding(codex);
    expect(codexFinding).toContain(`missing tool_timeout_sec = ${CODEX_TOOL_TIMEOUT_SEC}`);
    expect(codexFinding).toContain("fifteen minutes");
    expect(codexFinding).toContain("~2 minutes");
    expect(codexFinding).toContain("archflow-init");
  });

  it("reports a finding when a registered entry carries a different timeout value", () => {
    const claude = claudeConfig({ type: "stdio", command: "archflow-mcp", args: [], timeout: 120_000 });
    expect(claudeTimeoutFinding(claude))
      .toContain(`has "timeout" 120000 instead of ${CLAUDE_MCP_TIMEOUT_MS}`);

    const codex = "[mcp_servers.archflow]\ncommand = \"archflow-mcp\"\ntool_timeout_sec = 120\n";
    expect(codexTimeoutFinding(codex))
      .toContain(`has tool_timeout_sec = 120 instead of ${CODEX_TOOL_TIMEOUT_SEC}`);
  });

  it("ignores absent host configs and absent entries when checking timeouts", () => {
    expect(claudeTimeoutFinding(undefined)).toBeUndefined();
    expect(claudeTimeoutFinding("{\"mcpServers\": {}}")).toBeUndefined();
    expect(codexTimeoutFinding(undefined)).toBeUndefined();
    expect(codexTimeoutFinding("[mcp_servers.other]\ncommand = \"other\"\n")).toBeUndefined();
  });

  it("surfaces timeout findings from the working directory's host configs", async () => {
    stat.mockRejectedValue(Object.assign(new Error("missing"), { code: "ENOENT" }));
    createDispatchWorkspace.mockRejectedValue(new Error("workspace unavailable"));
    const repository = await mkdtemp(join(tmpdir(), "archflow-init-diagnostics-"));
    try {
      await writeFile(
        join(repository, ".mcp.json"),
        claudeConfig({ type: "stdio", command: "archflow-mcp", args: [], timeout: 120_000 }),
        "utf8",
      );
      await mkdir(join(repository, ".codex"), { recursive: true });
      await writeFile(
        join(repository, ".codex", "config.toml"),
        "[mcp_servers.archflow]\ncommand = \"archflow-mcp\"\nargs = []\n",
        "utf8",
      );

      const result = await collectInitDiagnostics({ working_directory: repository });

      expect(result.timeout_findings).toHaveLength(2);
      expect(result.timeout_findings[0]).toContain(".mcp.json");
      expect(result.timeout_findings[1]).toContain(".codex/config.toml");
    } finally {
      await rm(repository, { recursive: true, force: true });
    }
  });

  it("maps unexpected workspace failures to the existing init-preflight IO error", async () => {
    stat.mockRejectedValue(Object.assign(new Error("missing"), { code: "ENOENT" }));
    createDispatchWorkspace.mockRejectedValue(new Error("workspace unavailable"));

    const result = await collectInitDiagnostics({ working_directory: "/repo" });

    for (const diagnostic of [result.claude, result.codex]) {
      expect(diagnostic.error).toMatchObject({
        code: "IO_ERROR",
        diagnostic: { parameters: { operation: "init-preflight", attempt: 1 } },
      });
      expect(diagnostic.version).toBeNull();
    }
  });
});

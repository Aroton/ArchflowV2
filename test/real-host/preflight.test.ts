import { execFileSync } from "node:child_process";
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";

import { describe, expect, it } from "vitest";

import reviewSchema from "../../src/contracts/schemas/v1/review.schema.json" with { type: "json" };
import { deriveHostIdentity } from "../../src/contracts/hosts.js";
import { parsePhaseInstanceId } from "../../src/contracts/phase-instance.js";
import type { PlainJsonValue } from "../../src/contracts/plain-json.js";
import { detectManagedPolicyPaths, preflightAdapter } from "../../src/dispatch/cli.js";
import { createDispatchCoordinator } from "../../src/dispatch/coordinator.js";
import { CliAdapterError } from "../../src/dispatch/cli.js";
import type { DispatchRoute } from "../../src/dispatch/routing.js";
import { createDispatchWorkspace } from "../../src/dispatch/workspace.js";
import { startMcpRuntime } from "../../src/mcp/sdk-adapter.js";
import type { DispatchEnvelope } from "../../src/review/envelopes.js";
import { REAL_HOST_PROBE_TIMEOUT_MS, REAL_HOST_TEST_TIMEOUT_MS, realHostsAvailable, requireRealHostsAvailable } from "../helpers/real-host.js";
import { createTaskWorkspace } from "../helpers/task-workspace.js";

const REAL_HOSTS_AVAILABLE = realHostsAvailable();
requireRealHostsAvailable(REAL_HOSTS_AVAILABLE);
const decoder = new TextDecoder("utf-8", { fatal: true });
const encoder = new TextEncoder();
const PHASE = parsePhaseInstanceId("prd");

function command(commandName: string, argv: readonly string[]): string {
  return execFileSync(commandName, [...argv], {
    encoding: "utf8",
    timeout: REAL_HOST_PROBE_TIMEOUT_MS,
    stdio: ["ignore", "pipe", "pipe"],
  }).trim();
}

async function waitForLines(lines: readonly string[], count: number): Promise<void> {
  for (let attempt = 0; attempt < 400; attempt += 1) {
    if (lines.length >= count) return;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error(`timed out waiting for ${String(count)} MCP responses`);
}

describe.skipIf(!REAL_HOSTS_AVAILABLE)("Phase 21 real-host preflight", () => {
  it("accepts exact real version and authentication shapes through production preflight", async () => {
    const claudeVersion = command("claude", ["--version"]);
    const codexVersion = command("codex", ["--version"]);
    expect(claudeVersion).toMatch(/^\d+\.\d+\.\d+ \(Claude Code\)$/u);
    expect(codexVersion).toMatch(/^codex-cli \d+\.\d+\.\d+$/u);

    const repositoryRoot = process.cwd();
    const claudeWorkspace = await createDispatchWorkspace("claude-cli", repositoryRoot);
    const codexWorkspace = await createDispatchWorkspace("codex-cli", repositoryRoot);
    try {
      const [claude, codex] = await Promise.all([
        preflightAdapter("claude-cli", claudeWorkspace),
        preflightAdapter("codex-cli", codexWorkspace),
      ]);
      expect(claude).toEqual({
        cli_version: claudeVersion.match(/^(\d+\.\d+\.\d+)/u)![1],
        managed_policy_present: claude.managed_policy_paths.length > 0,
        managed_policy_paths: expect.any(Array),
      });
      expect(codex).toEqual({
        cli_version: codexVersion.match(/^(?:codex-cli )?(\d+\.\d+\.\d+)/u)![1],
        managed_policy_present: codex.managed_policy_paths.length > 0,
        managed_policy_paths: expect.any(Array),
      });
      for (const result of [claude, codex]) {
        expect(new Set(result.managed_policy_paths).size).toBe(result.managed_policy_paths.length);
        expect(result.managed_policy_paths.every((path) => path.startsWith("/"))).toBe(true);
      }
    } finally {
      await Promise.all([claudeWorkspace.dispose(), codexWorkspace.dispose()]);
    }
  }, REAL_HOST_PROBE_TIMEOUT_MS * 4);

  it("derives the stable first-party host names at the real installed versions", () => {
    const claudeVersion = command("claude", ["--version"]).match(/^(\d+\.\d+\.\d+)/u)![1]!;
    const codexVersion = command("codex", ["--version"]).match(/^codex-cli (\d+\.\d+\.\d+)$/u)![1]!;
    expect(deriveHostIdentity({ name: "claude-code", version: claudeVersion })).toBe("claude");
    expect(deriveHostIdentity({ name: "codex-mcp-client", version: codexVersion })).toBe("codex");
  }, REAL_HOST_PROBE_TIMEOUT_MS);

  it("reports a synthesized present managed-policy path through production detection", async () => {
    const root = await mkdtemp(join(tmpdir(), "archflow-managed-policy-"));
    const present = join(root, "managed-policy.json");
    const missing = join(root, "missing-policy.json");
    try {
      await writeFile(present, "{}\n");
      await expect(detectManagedPolicyPaths([missing, present])).resolves.toEqual([present]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  }, REAL_HOST_PROBE_TIMEOUT_MS);

  it("rejects an unsolicited pre-initialize request and remains open for initialization", async () => {
    const input = new PassThrough();
    const output = new PassThrough();
    const lines: string[] = [];
    let buffered = "";
    output.on("data", (chunk: Buffer) => {
      buffered += chunk.toString("utf8");
      for (;;) {
        const newline = buffered.indexOf("\n");
        if (newline < 0) break;
        lines.push(buffered.slice(0, newline));
        buffered = buffered.slice(newline + 1);
      }
    });
    const runtime = await startMcpRuntime({ input, output, workingDirectory: process.cwd() });
    try {
      input.write(`${JSON.stringify({ jsonrpc: "2.0", id: "early", method: "tools/list", params: {} })}\n`);
      await waitForLines(lines, 1);
      expect(JSON.parse(lines[0]!)).toMatchObject({ jsonrpc: "2.0", id: "early", error: { code: -32600 } });

      input.write(`${JSON.stringify({
        jsonrpc: "2.0", id: "initialize-after-error", method: "initialize",
        params: {
          protocolVersion: "2025-11-25", capabilities: {},
          clientInfo: { name: "codex-mcp-client", version: command("codex", ["--version"]).replace(/^codex-cli /u, "") },
        },
      })}\n`);
      await waitForLines(lines, 2);
      expect(JSON.parse(lines[1]!)).toMatchObject({
        jsonrpc: "2.0", id: "initialize-after-error",
        result: { protocolVersion: "2025-11-25", serverInfo: { name: "archflow-mcp" } },
      });
    } finally {
      input.end();
      await runtime.close();
    }
  }, REAL_HOST_PROBE_TIMEOUT_MS);

  it("never persists Claude authentication PII values in attempt or diagnostic bytes", async () => {
    const rawAuth = JSON.parse(command("claude", ["auth", "status"])) as Record<string, unknown>;
    expect(rawAuth.loggedIn).toBe(true);
    const pii = ["email", "orgId", "orgName", "subscriptionType"]
      .map((key) => rawAuth[key])
      .filter((value): value is string => typeof value === "string" && value !== "");
    expect(pii.length).toBeGreaterThan(0);

    const workspace = await createTaskWorkspace({ taskId: "real-preflight-pii", label: "real-preflight-pii" });
    const route: DispatchRoute = {
      adapter: "claude-cli", family: "claude", model: "claude-model-does-not-exist-phase21", effort: "high",
    };
    const envelope: DispatchEnvelope = {
      result_kind: "review", bytes: encoder.encode("{}\n"), digest: "d".repeat(64) as never, byte_count: 3,
    };
    try {
      const dispatch = createDispatchCoordinator({
        authority: workspace.services.authority,
        dependencies: workspace.services.dependencies,
        host: "codex",
        repository_root: workspace.root,
        phase_instance: PHASE,
        signal: new AbortController().signal,
        cancellation_source: "client",
        allow_claude_dispatch: true,
      });
      await expect(dispatch(route, envelope, reviewSchema as PlainJsonValue)).rejects.toSatisfy((error: unknown) =>
        error instanceof CliAdapterError && error.project_error.code === "PROCESS_FAILED");
      const attemptDirectory = join(workspace.root, ".archflow", "tasks", workspace.taskId, "attempts", "prd");
      const attempts = await readdir(attemptDirectory);
      expect(attempts).toHaveLength(1);
      const persisted = await readFile(join(attemptDirectory, attempts[0]!));
      const diagnosticBytes = Buffer.from(decoder.decode(persisted));
      for (const value of pii) expect(diagnosticBytes.includes(Buffer.from(value))).toBe(false);
    } finally {
      workspace.dispose();
    }
  }, REAL_HOST_TEST_TIMEOUT_MS);
});

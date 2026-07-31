import { chmod, mkdtemp, mkdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { delimiter, dirname, join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import reviewSchema from "../../src/contracts/schemas/v1/review.schema.json" with { type: "json" };
import { CliAdapterError, selectCliAdapter } from "../../src/dispatch/cli.js";
import { runDispatchChild } from "../../src/dispatch/process.js";
import type { DispatchRoute } from "../../src/dispatch/routing.js";
import type { DispatchWorkspace } from "../../src/dispatch/workspace.js";
import type { DispatchEnvelope } from "../../src/review/envelopes.js";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function fakeWorkspace(kind: "claude" | "codex", scenario = "success"): Promise<DispatchWorkspace> {
  const root = await mkdtemp(join(tmpdir(), `archflow-${kind}-cli-`));
  roots.push(root);
  const bin = join(root, "bin");
  const home = join(root, "home");
  await Promise.all([mkdir(bin), mkdir(home)]);
  const fixture = new URL(`../fixtures/dispatch/fake-${kind}.mjs`, import.meta.url);
  await chmod(fixture, 0o755);
  await symlink(fixture, join(bin, kind));
  await writeFile(join(root, "scenario"), scenario);
  return Object.freeze({
    root,
    home,
    env: Object.freeze({
      PATH: `${bin}${delimiter}${dirname(process.execPath)}`,
      HOME: home,
      TMPDIR: root,
      CODEX_HOME: join(home, ".codex"),
    }),
    dispose: () => rm(root, { recursive: true, force: true }),
  });
}

async function rejectedCode(promise: Promise<unknown>): Promise<string> {
  try { await promise; } catch (error) {
    expect(error).toBeInstanceOf(CliAdapterError);
    return (error as CliAdapterError).project_error.code;
  }
  throw new Error("expected preflight rejection");
}

describe("CLI adapter preflight", () => {
  it("parses exact current Claude and Codex versions and authenticates under the workspace env", async () => {
    const [claude, codex] = await Promise.all([fakeWorkspace("claude"), fakeWorkspace("codex")]);
    const [claudeResult, codexResult] = await Promise.all([
      selectCliAdapter("codex", { allow_claude_dispatch: true }).preflight(claude),
      selectCliAdapter("claude").preflight(codex),
    ]);
    expect(claudeResult).toMatchObject({ cli_version: "2.1.220", managed_policy_present: expect.any(Boolean) });
    expect(codexResult).toMatchObject({ cli_version: "0.146.0", managed_policy_present: expect.any(Boolean) });
  });

  it.each([
    ["claude", { adapter: "claude-cli", family: "claude", model: "claude-opus-4-6", effort: "high" }],
    ["codex", { adapter: "codex-cli", family: "codex", model: "gpt-5.3-codex", effort: "high" }],
  ] as const)("drives the no-network %s fixture with the pinned invocation", async (kind, route) => {
    const target = await fakeWorkspace(kind);
    const adapter = kind === "claude"
      ? selectCliAdapter("codex", { allow_claude_dispatch: true })
      : selectCliAdapter("claude");
    const envelope: DispatchEnvelope = Object.freeze({
      result_kind: "review",
      bytes: Buffer.from('{"schema_version":"1"}\n'),
      digest: "d".repeat(64) as never,
      byte_count: 23,
    });
    const invocation = await adapter.buildInvocation(envelope, route as DispatchRoute, target, reviewSchema);
    const child = await runDispatchChild({ ...invocation, signal: new AbortController().signal });
    expect(child.exit_code).toBe(0);
    expect(adapter.classifyFailure(child)).toBeUndefined();
    expect(JSON.parse(Buffer.from(adapter.parseOutput(child)).toString("utf8"))).toEqual({ schema_version: "1" });
    if (kind === "claude") expect(child.stderr.toString("utf8")).toContain("deprecated model warning");
  });

  it.each(["claude", "codex"] as const)("rejects below-gate %s versions", async (kind) => {
    const target = await fakeWorkspace(kind, "old-version");
    const adapter = kind === "claude"
      ? selectCliAdapter("codex", { allow_claude_dispatch: true })
      : selectCliAdapter("claude");
    expect(await rejectedCode(adapter.preflight(target))).toBe("CLI_VERSION_UNSUPPORTED");
  });

  it.each(["claude", "codex"] as const)("rejects logged-out %s generated homes", async (kind) => {
    const target = await fakeWorkspace(kind, "logged-out");
    const adapter = kind === "claude"
      ? selectCliAdapter("codex", { allow_claude_dispatch: true })
      : selectCliAdapter("claude");
    expect(await rejectedCode(adapter.preflight(target))).toBe("AUTH_UNAVAILABLE");
  });
});

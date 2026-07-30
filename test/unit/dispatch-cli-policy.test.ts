import { describe, expect, it, vi } from "vitest";

import type { DispatchChildResult, DispatchChildSpec } from "../../src/dispatch/process.js";
import type { DispatchWorkspace } from "../../src/dispatch/workspace.js";

const { runDispatchChild, stat } = vi.hoisted(() => ({
  runDispatchChild: vi.fn(),
  stat: vi.fn(),
}));

vi.mock("node:fs/promises", async (importOriginal) => ({
  ...await importOriginal<typeof import("node:fs/promises")>(),
  stat,
}));

vi.mock("../../src/dispatch/process.js", async (importOriginal) => ({
  ...await importOriginal<typeof import("../../src/dispatch/process.js")>(),
  runDispatchChild,
}));

import { selectCliAdapter } from "../../src/dispatch/cli.js";

const workspace: DispatchWorkspace = Object.freeze({
  root: "/tmp/archflow-policy-test",
  home: "/tmp/archflow-policy-test/home",
  env: Object.freeze({ PATH: "/bin", HOME: "/tmp/archflow-policy-test/home", TMPDIR: "/tmp/archflow-policy-test", CODEX_HOME: "/tmp/archflow-policy-test/home/.codex" }),
  dispose: async () => undefined,
});

const childResult = (stdout: string): DispatchChildResult => Object.freeze({
  exit_code: 0,
  signal: null,
  stdout: Buffer.from(stdout),
  stderr: Buffer.alloc(0),
});

function successfulCodexPreflight(): void {
  runDispatchChild.mockImplementation(async (spec: DispatchChildSpec) =>
    childResult(spec.argv[0] === "--version" ? "codex-cli 0.146.0\n" : "Logged in using ChatGPT\n"));
}

describe("managed-policy disclosure", () => {
  it("treats non-ENOENT stat failures conservatively as detected paths", async () => {
    successfulCodexPreflight();
    stat.mockRejectedValue(Object.assign(new Error("permission denied"), { code: "EACCES" }));

    const result = await selectCliAdapter("claude").preflight(workspace);

    expect(result.managed_policy_present).toBe(true);
    expect(result.managed_policy_paths).toEqual([
      "/etc/codex/config.toml",
      "/etc/codex/requirements.toml",
      "/etc/codex/rules",
    ]);
  });

  it("treats only ENOENT as absent", async () => {
    successfulCodexPreflight();
    stat.mockImplementation(async (path) => {
      const code = path === "/etc/codex/rules" ? "EACCES" : "ENOENT";
      throw Object.assign(new Error(code), { code });
    });

    const result = await selectCliAdapter("claude").preflight(workspace);

    expect(result.managed_policy_present).toBe(true);
    expect(result.managed_policy_paths).toEqual(["/etc/codex/rules"]);
  });
});

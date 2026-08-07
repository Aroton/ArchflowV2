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

import { collectInitDiagnostics } from "../../src/init/diagnostics.js";

const workspace = Object.freeze({
  root: "/tmp/archflow-init-diagnostics",
  home: "/tmp/archflow-init-diagnostics/home",
  env: Object.freeze({
    PATH: "/bin",
    HOME: "/tmp/archflow-init-diagnostics/home",
    TMPDIR: "/tmp/archflow-init-diagnostics",
    CODEX_HOME: "/tmp/archflow-init-diagnostics/home/.codex",
  }),
  dispose: vi.fn(async () => undefined),
});

describe("init diagnostics", () => {
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

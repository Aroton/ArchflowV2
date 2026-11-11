import { execFileSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { afterAll, afterEach, describe, expect, it, vi } from "vitest";

import { collectInitDiagnostics } from "../../src/init/diagnostics.js";
import { runInit } from "../../src/init/index.js";
import {
  cleanupTemporaryRepositories,
  createTempRepository,
} from "../helpers/temp-repository.js";

const fakeHostCli = fileURLToPath(new URL("../fixtures/init/fake-host-cli.mjs", import.meta.url));

afterEach(() => {
  vi.unstubAllEnvs();
});

afterAll(() => {
  cleanupTemporaryRepositories();
});

describe("init orchestration", () => {
  it("binds a subdirectory invocation to the worktree root and reports a missing reviewer CLI", async () => {
    const repository = createTempRepository({ label: "init-orchestration", attributes: undefined });
    const nested = join(repository.path, "nested", "directory");
    const bin = join(repository.root, "bin");
    mkdirSync(nested, { recursive: true });
    mkdirSync(bin);

    const git = execFileSync("which", ["git"], { encoding: "utf8" }).trim();
    const gitLauncher = join(bin, "git");
    const codexLauncher = join(bin, "codex");
    writeFileSync(gitLauncher, `#!/bin/sh\nexec "${git}" "$@"\n`);
    writeFileSync(
      codexLauncher,
      `#!/bin/sh\nFAKE_HOST_ADAPTER=codex exec "${process.execPath}" "${fakeHostCli}" "$@"\n`,
    );
    chmodSync(gitLauncher, 0o755);
    chmodSync(codexLauncher, 0o755);
    vi.stubEnv("PATH", bin);
    vi.stubEnv("HOME", join(repository.root, "home"));

    const result = await runInit({ working_directory: nested });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.diagnostics.claude.error?.code).toBe("CLI_MISSING");
    expect(result.value.diagnostics.codex.version).toBe("0.146.0");
    expect(result.value.diagnostics.codex.error).toBeNull();
    expect(result.value.diagnostics.limitations.join(" ")).toContain("best-effort");
    expect(result.value.legacy_registrations).toEqual({ removed: [], left_alone: [] });
    expect(result.value.creates_commit).toBe(false);
    expect(() => JSON.stringify(result.value)).not.toThrow();

    expect(existsSync(join(repository.path, ".archflow", "config.yaml"))).toBe(true);
    expect(readFileSync(join(repository.path, ".archflow", ".gitignore"), "utf8")).toBe("/runtime/\n");
    expect(result.value.assets.runtime_gitignore).toBe("created");
    const cache = join(repository.path, ".archflow", "runtime", "tasks", "demo", "cache");
    const cached = join(cache, "result.json");
    mkdirSync(cache, { recursive: true });
    writeFileSync(cached, "{}\n");
    const status = repository.git("status", "--short", "--untracked-files=all");
    expect(status).toContain(".archflow/.gitignore");
    expect(status).toContain(".archflow/config.yaml");
    expect(status).not.toContain(".archflow/runtime/");
    expect(status).not.toContain(".archflow/workflow.yaml");
    expect(existsSync(join(repository.path, ".mcp.json"))).toBe(false);
    expect(existsSync(join(repository.path, ".codex"))).toBe(false);
    expect(existsSync(join(nested, ".archflow"))).toBe(false);
  });

  it("reports the existing below-floor and logged-out preflight errors", async () => {
    const repository = createTempRepository({ label: "init-preflight", attributes: undefined });
    const bin = join(repository.root, "bin");
    mkdirSync(bin);
    const claude = join(bin, "claude");
    const codex = join(bin, "codex");
    writeFileSync(codex, `#!/bin/sh\nFAKE_HOST_ADAPTER=codex exec "${process.execPath}" "${fakeHostCli}" "$@"\n`);
    chmodSync(codex, 0o755);
    vi.stubEnv("PATH", `${bin}:${process.env.PATH ?? ""}`);
    vi.stubEnv("HOME", join(repository.root, "home"));

    writeFileSync(claude, `#!/bin/sh\nFAKE_HOST_ADAPTER=claude FAKE_CLAUDE_VERSION=2.1.100 exec "${process.execPath}" "${fakeHostCli}" "$@"\n`);
    chmodSync(claude, 0o755);
    const belowFloor = await collectInitDiagnostics({ working_directory: repository.path });
    expect(belowFloor.claude.version).toBe("2.1.100");
    expect(belowFloor.claude.error?.code).toBe("CLI_VERSION_UNSUPPORTED");

    writeFileSync(claude, `#!/bin/sh\nFAKE_HOST_ADAPTER=claude FAKE_LOGGED_OUT=1 exec "${process.execPath}" "${fakeHostCli}" "$@"\n`);
    chmodSync(claude, 0o755);
    const loggedOut = await collectInitDiagnostics({ working_directory: repository.path });
    expect(loggedOut.claude.authenticated).toBe(false);
    expect(loggedOut.claude.error?.code).toBe("AUTH_UNAVAILABLE");
  });
});

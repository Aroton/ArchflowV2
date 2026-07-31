import { execFileSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { afterAll, afterEach, describe, expect, it, vi } from "vitest";

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

describe("phase 16 init orchestration", () => {
  it("binds a subdirectory invocation to the worktree root and reports a missing host", async () => {
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
    vi.stubEnv("FAKE_CODEX_TRUSTED", "1");

    const result = await runInit({ working_directory: nested });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.claude_registration).toBeNull();
    expect(result.value.claude_registration_error?.code).toBe("CLI_MISSING");
    expect(result.value.codex_registration?.command).toBe("archflow-mcp");
    expect(result.value.codex_registration_error).toBeNull();
    expect(result.value.diagnostics.claude.error?.code).toBe("CLI_MISSING");
    expect(result.value.diagnostics.limitations.join(" ")).toContain("best-effort");
    expect(() => JSON.stringify(result.value)).not.toThrow();

    expect(existsSync(join(repository.path, ".archflow", "workflow.yaml"))).toBe(true);
    expect(readFileSync(join(repository.path, ".codex", "config.toml"), "utf8")).toContain(
      "[mcp_servers.archflow]",
    );
    expect(existsSync(join(nested, ".archflow"))).toBe(false);
    expect(existsSync(join(nested, ".codex"))).toBe(false);
  });
});

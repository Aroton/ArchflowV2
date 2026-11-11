import { execFileSync } from "node:child_process";
import { chmod, lstat, mkdir, mkdtemp, readdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";

import { afterEach, describe, expect, it, vi, type MockInstance } from "vitest";

import { runInit, type InitReport } from "../../src/init/index.js";

const fixture = fileURLToPath(new URL("../fixtures/init/fake-host-cli.mjs", import.meta.url));
/** The `.archflow/config.yaml` an earlier init copied from the template it shipped then. */
const legacyConfig = fileURLToPath(new URL("../fixtures/foundation/config/legacy-template.yaml", import.meta.url));
const git = execFileSync("which", ["git"], { encoding: "utf8" }).trim();

/** The exact `.mcp.json` earlier versions of init left behind (claude mcp add, then the timeout patch). */
const LEGACY_CLAUDE_ENTRY = { type: "stdio", command: "archflow-mcp", args: [], timeout: 3_600_000 };
/** The exact block earlier versions of init appended to `.codex/config.toml`. */
const LEGACY_CODEX_BLOCK = "# >>> archflow managed MCP server >>>\n[mcp_servers.archflow]\ncommand = \"archflow-mcp\"\nargs = []\nstartup_timeout_sec = 30\ntool_timeout_sec = 3600\n# <<< archflow managed MCP server <<<\n";

const temporary: string[] = [];

type Sandbox = Readonly<{ repository: string; home: string }>;

/** A temp repository plus a scratch HOME seeded with a global ArchFlow entry init must never touch. */
async function sandbox(): Promise<Sandbox> {
  const root = await mkdtemp(join(tmpdir(), "archflow-init-legacy-cleanup-"));
  temporary.push(root);
  const repository = join(root, "repository");
  const home = join(root, "home");
  const bin = join(root, "bin");
  await mkdir(repository, { recursive: true });
  await mkdir(join(home, ".gemini", "config"), { recursive: true });
  await writeFile(
    join(home, ".gemini", "config", "mcp_config.json"),
    `${JSON.stringify({ mcpServers: { archflow: { command: "archflow-mcp", args: [], timeoutSeconds: 3600 } } }, null, 2)}\n`,
  );
  await writeFile(join(home, ".mcp.json"), `${JSON.stringify({ mcpServers: { archflow: LEGACY_CLAUDE_ENTRY } }, null, 2)}\n`);
  await mkdir(bin);
  await writeFile(join(bin, "git"), `#!/bin/sh\nexec "${git}" "$@"\n`);
  await chmod(join(bin, "git"), 0o755);
  for (const adapter of ["claude", "codex"] as const) {
    const launcher = join(bin, adapter);
    await writeFile(launcher, `#!/bin/sh\nFAKE_HOST_ADAPTER=${adapter} exec "${process.execPath}" "${fixture}" "$@"\n`);
    await chmod(launcher, 0o755);
  }
  execFileSync(git, ["-c", "init.defaultBranch=main", "init", "-q"], { cwd: repository });
  vi.stubEnv("PATH", bin);
  vi.stubEnv("HOME", home);
  return { repository, home };
}

/** Every file below `directory` with its bytes, skipping Git's own metadata. */
async function snapshot(directory: string): Promise<Record<string, string>> {
  const entries = await readdir(directory, { recursive: true, withFileTypes: true });
  const files: Record<string, string> = {};
  for (const entry of entries) {
    if (!entry.isFile()) continue;
    const path = join(entry.parentPath, entry.name);
    const name = relative(directory, path);
    if (name === ".git" || name.startsWith(`.git/`)) continue;
    files[name] = await readFile(path, "utf8");
  }
  return files;
}

async function exists(path: string): Promise<boolean> {
  return readFile(path).then(() => true, () => false);
}

async function initialize(repository: string): Promise<InitReport> {
  const result = await runInit({ working_directory: repository });
  if (!result.ok) throw new Error(`init failed: ${result.error.code}`);
  return result.value;
}

/** Runs init and proves the scratch HOME is byte-for-byte unchanged by it. */
async function initializeLeavingHome({ repository, home }: Sandbox): Promise<InitReport> {
  const before = await snapshot(home);
  const report = await initialize(repository);
  expect(await snapshot(home)).toEqual(before);
  return report;
}

afterEach(async () => {
  vi.unstubAllEnvs();
  await Promise.all(temporary.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

describe("init legacy registration cleanup", () => {
  it("deletes a .mcp.json whose only content is the archflow-mcp server earlier inits wrote", async () => {
    const box = await sandbox();
    const path = join(box.repository, ".mcp.json");
    await writeFile(path, `${JSON.stringify({ mcpServers: { archflow: LEGACY_CLAUDE_ENTRY } }, null, 2)}\n`);

    const report = await initializeLeavingHome(box);

    expect(report.legacy_registrations).toEqual({
      removed: [{ path: ".mcp.json", effect: "file-deleted" }],
      left_alone: [],
    });
    expect(await exists(path)).toBe(false);
    expect(report.diagnostics.claude.version).toBe("2.1.220");
    expect(report.diagnostics.codex.version).toBe("0.146.0");
    expect(report.diagnostics.limitations.join(" ")).toContain("best-effort");
  });

  it("removes only the archflow server and keeps every other server and key", async () => {
    const box = await sandbox();
    const path = join(box.repository, ".mcp.json");
    const others = {
      alpha: { command: "alpha", env: { X: "1" } },
      beta: { command: "beta", args: ["--flag"] },
    };
    await writeFile(path, `${JSON.stringify({
      $schema: "https://example.test/mcp.schema.json",
      mcpServers: { alpha: others.alpha, archflow: { ...LEGACY_CLAUDE_ENTRY, env: {} }, beta: others.beta },
    }, null, 2)}\n`);

    const report = await initializeLeavingHome(box);

    expect(report.legacy_registrations).toEqual({
      removed: [{ path: ".mcp.json", effect: "entry-removed" }],
      left_alone: [],
    });
    expect(await readFile(path, "utf8")).toBe(`${JSON.stringify({
      $schema: "https://example.test/mcp.schema.json",
      mcpServers: others,
    }, null, 2)}\n`);
  });

  it("keeps the permission bits of a rewritten .mcp.json", async () => {
    const box = await sandbox();
    const path = join(box.repository, ".mcp.json");
    const other = { command: "alpha" };
    await writeFile(path, `${JSON.stringify({ mcpServers: { alpha: other, archflow: { ...LEGACY_CLAUDE_ENTRY, env: {} } } }, null, 2)}\n`);
    await chmod(path, 0o600);

    await initializeLeavingHome(box);

    expect(JSON.parse(await readFile(path, "utf8"))).toEqual({ mcpServers: { alpha: other } });
    if (process.platform !== "win32") expect((await lstat(path)).mode & 0o777).toBe(0o600);
  });

  it("leaves an archflow server with a different command alone and reports it", async () => {
    const box = await sandbox();
    const path = join(box.repository, ".mcp.json");
    const source = JSON.stringify({ mcpServers: { archflow: { command: "/opt/custom/archflow-mcp", args: [] } } });
    await writeFile(path, source);

    const report = await initializeLeavingHome(box);

    expect(report.legacy_registrations).toEqual({
      removed: [],
      left_alone: [{ path: ".mcp.json", reason: "different-command" }],
    });
    expect(await readFile(path, "utf8")).toBe(source);
  });

  it("removes the marked Codex block and keeps the surrounding TOML byte for byte", async () => {
    const box = await sandbox();
    const path = join(box.repository, ".codex", "config.toml");
    await mkdir(join(box.repository, ".codex"));
    const prefix = "# user's comment\nmodel = \"gpt-test\"\n";
    const suffix = "\n[profiles.fast]\nmodel = \"gpt-fast\"\n";
    await writeFile(path, `${prefix}${LEGACY_CODEX_BLOCK}${suffix}`);

    const report = await initializeLeavingHome(box);

    expect(report.legacy_registrations).toEqual({
      removed: [{ path: ".codex/config.toml", effect: "entry-removed" }],
      left_alone: [],
    });
    expect(await readFile(path, "utf8")).toBe(`${prefix}${suffix}`);
  });

  it("deletes a Codex config left empty, and its directory only when nothing else is in it", async () => {
    const lone = await sandbox();
    await mkdir(join(lone.repository, ".codex"));
    await writeFile(join(lone.repository, ".codex", "config.toml"), LEGACY_CODEX_BLOCK);
    const shared = await sandbox();
    await mkdir(join(shared.repository, ".codex"));
    await writeFile(join(shared.repository, ".codex", "config.toml"), LEGACY_CODEX_BLOCK);
    await writeFile(join(shared.repository, ".codex", "notes.md"), "keep me\n");

    const loneReport = await initializeLeavingHome(lone);
    const sharedReport = await initializeLeavingHome(shared);

    for (const report of [loneReport, sharedReport]) {
      expect(report.legacy_registrations).toEqual({
        removed: [{ path: ".codex/config.toml", effect: "file-deleted" }],
        left_alone: [],
      });
    }
    expect(await readdir(lone.repository)).not.toContain(".codex");
    expect(await readdir(join(shared.repository, ".codex"))).toEqual(["notes.md"]);
  });

  it("leaves Codex content it cannot prove it wrote alone and reports it", async () => {
    const box = await sandbox();
    const path = join(box.repository, ".codex", "config.toml");
    await mkdir(join(box.repository, ".codex"));
    const changedCommand = LEGACY_CODEX_BLOCK.replace("command = \"archflow-mcp\"", "command = \"my-archflow\"");
    await writeFile(path, changedCommand);

    const changed = await initializeLeavingHome(box);
    expect(changed.legacy_registrations.left_alone).toEqual([{ path: ".codex/config.toml", reason: "different-command" }]);
    expect(await readFile(path, "utf8")).toBe(changedCommand);

    const unmatched = `${LEGACY_CODEX_BLOCK}${LEGACY_CODEX_BLOCK}`;
    await writeFile(path, unmatched);
    const duplicated = await initializeLeavingHome(box);
    expect(duplicated.legacy_registrations.left_alone).toEqual([{ path: ".codex/config.toml", reason: "unmatched-markers" }]);
    expect(await readFile(path, "utf8")).toBe(unmatched);

    const unmarked = "[mcp_servers.archflow]\ncommand = \"archflow-mcp\"\n";
    await writeFile(path, unmarked);
    const plain = await initializeLeavingHome(box);
    expect(plain.legacy_registrations).toEqual({ removed: [], left_alone: [] });
    expect(await readFile(path, "utf8")).toBe(unmarked);
  });

  it("leaves an unparseable .mcp.json that names archflow-mcp alone and reports it", async () => {
    const box = await sandbox();
    const path = join(box.repository, ".mcp.json");
    const source = '{"mcpServers": {"archflow": {"command": "archflow-mcp"},}}\n';
    await writeFile(path, source);

    const report = await initializeLeavingHome(box);

    expect(report.legacy_registrations).toEqual({
      removed: [],
      left_alone: [{ path: ".mcp.json", reason: "unreadable" }],
    });
    expect(await readFile(path, "utf8")).toBe(source);
  });

  it("never follows a symlinked .codex directory or .mcp.json out of the repository", async () => {
    const box = await sandbox();
    const outside = await mkdtemp(join(tmpdir(), "archflow-init-legacy-outside-"));
    temporary.push(outside);
    const codexOutside = join(outside, "codex");
    await mkdir(codexOutside);
    await writeFile(join(codexOutside, "config.toml"), `model = "gpt-test"\n${LEGACY_CODEX_BLOCK}`);
    await writeFile(join(outside, "mcp.json"), `${JSON.stringify({ mcpServers: { archflow: LEGACY_CLAUDE_ENTRY } }, null, 2)}\n`);
    await symlink(codexOutside, join(box.repository, ".codex"));
    await symlink(join(outside, "mcp.json"), join(box.repository, ".mcp.json"));
    const before = await snapshot(outside);

    const report = await initializeLeavingHome(box);

    expect(report.legacy_registrations).toEqual({
      removed: [],
      left_alone: [
        { path: ".mcp.json", reason: "symlink" },
        { path: ".codex/config.toml", reason: "symlink" },
      ],
    });
    expect(await snapshot(outside)).toEqual(before);
    expect((await lstat(join(box.repository, ".codex"))).isSymbolicLink()).toBe(true);
    expect((await lstat(join(box.repository, ".mcp.json"))).isSymbolicLink()).toBe(true);
  });

  it("is a no-op on a second run", async () => {
    const box = await sandbox();
    await writeFile(
      join(box.repository, ".mcp.json"),
      `${JSON.stringify({ mcpServers: { archflow: LEGACY_CLAUDE_ENTRY, other: { command: "other" } } }, null, 2)}\n`,
    );
    await mkdir(join(box.repository, ".codex"));
    await writeFile(join(box.repository, ".codex", "config.toml"), `model = "gpt-test"\n${LEGACY_CODEX_BLOCK}`);

    const first = await initializeLeavingHome(box);
    expect(first.legacy_registrations.removed).toHaveLength(2);
    const afterFirst = await snapshot(box.repository);

    const second = await initializeLeavingHome(box);

    expect(second.legacy_registrations).toEqual({ removed: [], left_alone: [] });
    expect(second.assets.created).toEqual([]);
    expect(second.assets.overwritten).toEqual([]);
    expect(await snapshot(box.repository)).toEqual(afterFirst);
  });

  describe("on a repository an earlier init left behind", () => {
    const FOREIGN_SERVER = { command: "other", args: ["--flag"] };
    const CODEX_PREFIX = "model = \"gpt-test\"\n";

    /** Seeds the old-template config plus both legacy registrations next to foreign content. */
    async function olderInitRepository(): Promise<Sandbox> {
      const box = await sandbox();
      await mkdir(join(box.repository, ".archflow"));
      await writeFile(join(box.repository, ".archflow", "config.yaml"), await readFile(legacyConfig));
      await writeFile(
        join(box.repository, ".mcp.json"),
        `${JSON.stringify({ mcpServers: { archflow: LEGACY_CLAUDE_ENTRY, other: FOREIGN_SERVER } }, null, 2)}\n`,
      );
      await mkdir(join(box.repository, ".codex"));
      await writeFile(join(box.repository, ".codex", "config.toml"), `${CODEX_PREFIX}${LEGACY_CODEX_BLOCK}`);
      return box;
    }

    async function expectRegistrationsRemovedAndForeignKept(repository: string): Promise<void> {
      expect(JSON.parse(await readFile(join(repository, ".mcp.json"), "utf8"))).toEqual({ mcpServers: { other: FOREIGN_SERVER } });
      expect(await readFile(join(repository, ".codex", "config.toml"), "utf8")).toBe(CODEX_PREFIX);
    }

    function captureStderr(): MockInstance {
      return vi.spyOn(process.stderr, "write").mockReturnValue(true);
    }

    function written(stderr: MockInstance): string[] {
      return stderr.mock.calls.map(([chunk]) => String(chunk));
    }

    afterEach(() => {
      vi.restoreAllMocks();
    });

    it("removes the legacy registrations before refusing the diverged config, and reports each removal on stderr", async () => {
      const box = await olderInitRepository();
      const configBefore = await readFile(join(box.repository, ".archflow", "config.yaml"), "utf8");
      const homeBefore = await snapshot(box.home);
      const stderr = captureStderr();

      const result = await runInit({ working_directory: box.repository });

      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.error.code).toBe("CONFIG_INVALID");
      expect(result.error.diagnostic.parameters).toEqual({ issue_code: "scaffold-diverged" });
      const lines = written(stderr);
      expect(lines.filter((line) => line.includes("scaffold differs at .archflow/config.yaml"))).toHaveLength(1);
      expect(lines.filter((line) => line.includes("legacy archflow-mcp registration in .mcp.json"))).toHaveLength(1);
      expect(lines.filter((line) => line.includes("legacy archflow-mcp registration in .codex/config.toml"))).toHaveLength(1);
      expect(lines.every((line) => line.endsWith("\n") && line.indexOf("\n") === line.length - 1)).toBe(true);
      await expectRegistrationsRemovedAndForeignKept(box.repository);
      expect(await readFile(join(box.repository, ".archflow", "config.yaml"), "utf8")).toBe(configBefore);
      expect(await snapshot(box.home)).toEqual(homeBefore);
    });

    it("reports a registration it left alone on stderr when the scaffold refuses", async () => {
      const box = await sandbox();
      await mkdir(join(box.repository, ".archflow"));
      await writeFile(join(box.repository, ".archflow", "config.yaml"), await readFile(legacyConfig));
      const source = JSON.stringify({ mcpServers: { archflow: { command: "/opt/custom/archflow-mcp", args: [] } } });
      await writeFile(join(box.repository, ".mcp.json"), source);
      const stderr = captureStderr();

      const result = await runInit({ working_directory: box.repository });

      expect(result.ok).toBe(false);
      const lines = written(stderr);
      expect(lines.filter((line) => line.includes("left an archflow registration in .mcp.json alone"))).toHaveLength(1);
      expect(lines.some((line) => line.includes("legacy archflow-mcp registration"))).toBe(false);
      expect(await readFile(join(box.repository, ".mcp.json"), "utf8")).toBe(source);
    });

    it("with force, replaces the config and lists the removals in the report", async () => {
      const box = await olderInitRepository();
      const homeBefore = await snapshot(box.home);
      const stderr = captureStderr();

      const result = await runInit({ working_directory: box.repository, force: true });

      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.value.legacy_registrations).toEqual({
        removed: [
          { path: ".mcp.json", effect: "entry-removed" },
          { path: ".codex/config.toml", effect: "entry-removed" },
        ],
        left_alone: [],
      });
      expect(result.value.assets.overwritten).toContain(".archflow/config.yaml");
      expect(written(stderr).some((line) => line.includes("legacy archflow-mcp registration"))).toBe(false);
      await expectRegistrationsRemovedAndForeignKept(box.repository);
      expect(await snapshot(box.home)).toEqual(homeBefore);
    });
  });
});

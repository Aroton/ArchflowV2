import { spawn, spawnSync } from "node:child_process";
import { chmod, cp, lstat, mkdir, mkdtemp, readFile, readdir, rm, stat, symlink, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { delimiter, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { afterEach, describe, expect, it } from "vitest";

const TEST_TIMEOUT_MS = 120_000;
const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const fakeHostFixture = join(repositoryRoot, "test", "fixtures", "init", "fake-host-cli.mjs");
const temporaryRoots: string[] = [];

async function checkoutCopy(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "archflow-install-"));
  temporaryRoots.push(root);
  await Promise.all([
    cp(join(repositoryRoot, "dist"), join(root, "dist"), { recursive: true }),
    cp(join(repositoryRoot, "assets"), join(root, "assets"), { recursive: true }),
    cp(join(repositoryRoot, "skills"), join(root, "skills"), { recursive: true }),
    cp(join(repositoryRoot, "install.sh"), join(root, "install.sh")),
    cp(join(repositoryRoot, "package.json"), join(root, "package.json")),
  ]);
  await chmod(join(root, "install.sh"), 0o755);
  return root;
}

function runInstaller(
  root: string,
  home: string,
  bin: string,
  path = `${bin}${delimiter}${process.env.PATH ?? ""}`,
  environment: NodeJS.ProcessEnv = {},
  args: string[] = ["--claude"],
) {
  return spawnSync(join(root, "install.sh"), args, {
    cwd: root,
    encoding: "utf8",
    env: { ...process.env, ...environment, HOME: home, ARCHFLOW_HOME: join(home, "archflow-home"), ARCHFLOW_BIN: bin, PATH: path },
    timeout: TEST_TIMEOUT_MS,
  });
}

function git(root: string, ...argv: string[]): void {
  const result = spawnSync("git", argv, {
    cwd: root,
    encoding: "utf8",
    env: {
      ...process.env,
      GIT_CONFIG_GLOBAL: "/dev/null",
      GIT_CONFIG_SYSTEM: "/dev/null",
      GIT_AUTHOR_NAME: "ArchFlow Test",
      GIT_AUTHOR_EMAIL: "test@example.invalid",
      GIT_COMMITTER_NAME: "ArchFlow Test",
      GIT_COMMITTER_EMAIL: "test@example.invalid",
    },
  });
  expect(result.status, result.stderr).toBe(0);
}

async function installFakeHosts(bin: string): Promise<void> {
  for (const adapter of ["claude", "codex", "agy"] as const) {
    const launcher = join(bin, adapter);
    await writeFile(launcher, `#!/bin/sh\nFAKE_HOST_ADAPTER=${adapter} exec "${process.execPath}" "${fakeHostFixture}" "$@"\n`);
    await chmod(launcher, 0o755);
  }
}

async function runInputFreeInit(
  command: string,
  cwd: string,
  environment: NodeJS.ProcessEnv,
): Promise<Readonly<{ code: number | null; stdout: string; stderr: string }>> {
  const child = spawn(command, ["init"], { cwd, env: environment, stdio: ["pipe", "pipe", "pipe"] });
  let stdout = "";
  let stderr = "";
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  child.stdout.on("data", (chunk: string) => { stdout += chunk; });
  child.stderr.on("data", (chunk: string) => { stderr += chunk; });
  const result = await new Promise<Readonly<{ code: number | null; stdout: string; stderr: string }>>((resolveResult, reject) => {
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      reject(new Error("archflow-local init waited for stdin"));
    }, 5_000);
    child.once("error", reject);
    child.once("exit", (code) => {
      clearTimeout(timer);
      resolveResult({ code, stdout, stderr });
    });
  });
  child.stdin.destroy();
  return result;
}

/** Skills earlier releases installed and the current release no longer ships. */
const RETIRED_SKILLS = [
  "archflow-prd",
  "archflow-design",
  "archflow-phase-design",
  "archflow-phase-impl",
  "archflow-status",
  "archflow-upgrade",
  "archflow-simple",
] as const;

/** The launcher earlier installers wrote for the MCP server, byte for byte. */
function oldMcpLauncher(bundleDir: string): string {
  return `#!/bin/sh\nexec node "${bundleDir}/dist/archflow-mcp.mjs" "$@"\n`;
}

function skillFile(name: string): string {
  return `---\nname: ${name}\ndescription: An ArchFlow skill an earlier release installed.\n---\n\n# ${name}\n`;
}

/** Seeds one retired skill the way an earlier install laid it out, and returns its file paths. */
async function seedRetiredSkill(skillRoot: string, skill: string): Promise<string[]> {
  await mkdir(join(skillRoot, skill, "references"), { recursive: true });
  await writeFile(join(skillRoot, skill, "SKILL.md"), skillFile(skill));
  await writeFile(join(skillRoot, skill, "references", "guide.md"), "reference\n");
  return [`${skill}/SKILL.md`, `${skill}/references/guide.md`];
}

async function exists(path: string): Promise<boolean> {
  try {
    await lstat(path);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
}

/**
 * Fingerprints every path in the developer's real home that an installer run could touch, so a
 * test can prove it ran entirely inside its scratch HOME.
 */
async function realHomeFingerprint(): Promise<Record<string, string>> {
  const home = homedir();
  const paths = [
    join(home, ".local", "bin", "archflow-local"),
    join(home, ".local", "bin", "archflow-mcp"),
    join(home, ".archflow", "bundle"),
    join(home, ".gemini", "config", "mcp_config.json"),
  ];
  for (const skillRoot of [join(home, ".claude", "skills"), join(home, ".agents", "skills"), join(home, ".gemini", "config", "skills")]) {
    paths.push(join(skillRoot, ".archflow-installed"), join(skillRoot, "archflow-init", "SKILL.md"));
    for (const skill of RETIRED_SKILLS) paths.push(join(skillRoot, skill));
  }
  const fingerprint: Record<string, string> = {};
  for (const path of paths) {
    try {
      const info = await lstat(path);
      fingerprint[path] = `${info.ino}:${info.size}:${info.mtimeMs}`;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      fingerprint[path] = "absent";
    }
  }
  return fingerprint;
}

/** Records every entry under a directory with its type, bytes, and timestamps, so a test can prove nothing changed. */
async function treeSnapshot(dir: string): Promise<Record<string, string>> {
  const snapshot: Record<string, string> = {};
  for (const entry of await readdir(dir, { recursive: true, withFileTypes: true })) {
    const path = join(entry.parentPath, entry.name);
    const info = await lstat(path);
    const content = info.isFile() ? await readFile(path, "utf8") : info.isSymbolicLink() ? "link" : "dir";
    snapshot[path.slice(dir.length + 1)] = `${info.ino}:${info.mtimeMs}:${content}`;
  }
  return snapshot;
}

afterEach(async () => {
  await Promise.all(temporaryRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("installer", () => {
  it("rejects unexpected extra arguments before doing any work", () => {
    const result = spawnSync("bash", [join(repositoryRoot, "install.sh"), "--claude", "--bogus"], {
      cwd: repositoryRoot,
      encoding: "utf8",
      timeout: TEST_TIMEOUT_MS,
    });
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("Unexpected extra arguments: --claude --bogus");
    expect(result.stderr).toContain("Usage: ./install.sh [--claude|--codex|--antigravity|--agy]");
  });

  it.each(["--antigravity", "--agy"])("installs skills selectively for Antigravity with %s", async (flag) => {
    const root = await checkoutCopy();
    const home = join(root, "home");
    const bin = join(home, "bin");
    const antigravitySkillRoot = join(home, ".gemini", "config", "skills");
    const claudeSkillRoot = join(home, ".claude", "skills");
    const codexSkillRoot = join(home, ".agents", "skills");

    const installed = runInstaller(root, home, bin, undefined, {}, [flag]);
    expect(installed.error).toBeUndefined();
    expect(installed.status, installed.stderr).toBe(0);
    expect(installed.stdout).toContain("ArchFlow Antigravity skills installed to");
    expect(installed.stdout).toContain("Antigravity: /archflow-init");
    expect(installed.stdout).not.toContain("Claude Code: /archflow-init");
    expect(installed.stdout).not.toContain("Codex: $archflow-init");

    expect(await readFile(join(antigravitySkillRoot, "archflow-init", "SKILL.md"), "utf8"))
      .toBe(await readFile(join(root, "skills", "archflow-init", "SKILL.md"), "utf8"));
    expect(await readFile(join(antigravitySkillRoot, ".archflow-installed"), "utf8")).toContain("archflow-init/SKILL.md");

    await expect(readFile(join(claudeSkillRoot, "archflow-init", "SKILL.md"))).rejects.toMatchObject({ code: "ENOENT" });
    await expect(readFile(join(codexSkillRoot, "archflow-init", "SKILL.md"))).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("installs to Claude, Codex, and Antigravity when invoked without flags", async () => {
    const root = await checkoutCopy();
    const home = join(root, "home");
    const bin = join(home, "bin");
    const claudeSkillRoot = join(home, ".claude", "skills");
    const codexSkillRoot = join(home, ".agents", "skills");
    const antigravitySkillRoot = join(home, ".gemini", "config", "skills");

    const installed = runInstaller(root, home, bin, undefined, {}, []);
    expect(installed.error).toBeUndefined();
    expect(installed.status, installed.stderr).toBe(0);
    expect(installed.stdout).toContain("ArchFlow Claude Code skills installed to");
    expect(installed.stdout).toContain("ArchFlow Codex skills installed to");
    expect(installed.stdout).toContain("ArchFlow Antigravity skills installed to");

    expect(await readFile(join(claudeSkillRoot, "archflow-init", "SKILL.md"), "utf8")).toBeDefined();
    expect(await readFile(join(codexSkillRoot, "archflow-init", "SKILL.md"), "utf8")).toBeDefined();
    expect(await readFile(join(antigravitySkillRoot, "archflow-init", "SKILL.md"), "utf8")).toBeDefined();
    const exploreSkill = await readFile(join(root, "skills", "archflow-explore", "SKILL.md"), "utf8");
    for (const skillRoot of [claudeSkillRoot, codexSkillRoot, antigravitySkillRoot]) {
      expect(await readFile(join(skillRoot, "archflow-explore", "SKILL.md"), "utf8")).toBe(exploreSkill);
      expect(await readFile(join(skillRoot, ".archflow-installed"), "utf8")).toContain("archflow-explore/SKILL.md");
    }
    const runSkill = await readFile(join(root, "skills", "archflow-run", "SKILL.md"), "utf8");
    for (const skillRoot of [claudeSkillRoot, codexSkillRoot, antigravitySkillRoot]) {
      expect(await readFile(join(skillRoot, "archflow-run", "SKILL.md"), "utf8")).toBe(runSkill);
      expect(await readFile(join(skillRoot, "archflow-run", "scripts", "counter-review.sh"), "utf8")).toContain("archflow-local} review");
    }
    expect(installed.stdout).toContain("Claude Code: /archflow-init, /archflow-constitution, /archflow-explore, /archflow-run\n");
    expect(installed.stdout).toContain("Codex: $archflow-init, $archflow-constitution, $archflow-explore\n");
    expect(installed.stdout).toContain("Antigravity: /archflow-init, /archflow-constitution, /archflow-explore\n");
    for (const skill of RETIRED_SKILLS) expect(installed.stdout).not.toContain(skill);
  });

  it("removes what an earlier install left for the MCP server, only where ArchFlow provably owns it", async () => {
    const root = await checkoutCopy();
    const home = join(root, "home");
    const bin = join(home, "bin");
    const claudeSkillRoot = join(home, ".claude", "skills");
    const codexSkillRoot = join(home, ".agents", "skills");
    const antigravitySkillRoot = join(home, ".gemini", "config", "skills");
    const realHomeBefore = await realHomeFingerprint();

    // An earlier install: the MCP launcher it wrote, and the retired skills in every location.
    await mkdir(bin, { recursive: true });
    await writeFile(join(bin, "archflow-mcp"), oldMcpLauncher(join(home, ".archflow", "bundle")));
    await chmod(join(bin, "archflow-mcp"), 0o755);
    // Claude Code: a current-style install whose owner manifest lists every retired file.
    const claudeOwned: string[] = ["archflow-init/SKILL.md"];
    for (const skill of RETIRED_SKILLS) claudeOwned.push(...await seedRetiredSkill(claudeSkillRoot, skill));
    await writeFile(join(claudeSkillRoot, ".archflow-installed"), `${claudeOwned.sort().join("\n")}\n`);
    // Codex: an install from before the owner manifest existed.
    for (const skill of RETIRED_SKILLS) await seedRetiredSkill(codexSkillRoot, skill);
    await mkdir(join(codexSkillRoot, "archflow-phase"), { recursive: true });
    await writeFile(join(codexSkillRoot, "archflow-phase", "SKILL.md"), skillFile("archflow-phase"));
    // Antigravity: an older manifest that predates some of the retired skills.
    const antigravityOwned: string[] = [];
    for (const skill of RETIRED_SKILLS) {
      const files = await seedRetiredSkill(antigravitySkillRoot, skill);
      if (skill !== "archflow-simple" && skill !== "archflow-upgrade") antigravityOwned.push(...files);
    }
    await writeFile(join(antigravitySkillRoot, ".archflow-installed"), `${antigravityOwned.sort().join("\n")}\n`);
    // A skill a person installed beside ArchFlow's is never touched.
    await mkdir(join(codexSkillRoot, "my-skill"), { recursive: true });
    await writeFile(join(codexSkillRoot, "my-skill", "SKILL.md"), skillFile("my-skill"));
    // The Antigravity registration an earlier init wrote, beside a server and a setting the person owns.
    const mcpConfig = join(home, ".gemini", "config", "mcp_config.json");
    const otherServer = { command: "/usr/local/bin/other-server", args: ["--stdio"], env: { TOKEN_FILE: "/tmp/token" } };
    await writeFile(mcpConfig, `${JSON.stringify({
      mcpServers: {
        archflow: { command: join(home, ".local", "bin", "archflow-mcp"), args: [], timeoutSeconds: 3600 },
        other: otherServer,
      },
      theme: "dark",
    }, null, 2)}\n`);
    await chmod(mcpConfig, 0o600);

    const installed = runInstaller(root, home, bin, undefined, {}, []);
    expect(installed.error).toBeUndefined();
    expect(installed.status, installed.stderr).toBe(0);

    // The MCP launcher the old installer wrote is gone; the local launcher is the only one.
    expect(await exists(join(bin, "archflow-mcp"))).toBe(false);
    expect(await readFile(join(bin, "archflow-local"), "utf8")).toContain("/dist/archflow-local.mjs");
    expect(installed.stdout).toContain(`Removed the retired archflow-mcp launcher from ${bin}/`);

    // Every retired skill directory is gone from all three locations; the surviving skills are installed.
    for (const skillRoot of [claudeSkillRoot, codexSkillRoot, antigravitySkillRoot]) {
      for (const skill of RETIRED_SKILLS) expect(await exists(join(skillRoot, skill)), `${skillRoot}/${skill}`).toBe(false);
      expect(await exists(join(skillRoot, "archflow-phase"))).toBe(false);
      expect((await readdir(skillRoot)).filter((name) => name.startsWith("archflow-")).sort())
        .toEqual(["archflow-constitution", "archflow-explore", "archflow-init", "archflow-run"]);
      const manifest = await readFile(join(skillRoot, ".archflow-installed"), "utf8");
      for (const skill of RETIRED_SKILLS) expect(manifest).not.toContain(`${skill}/`);
    }
    expect(await readFile(join(codexSkillRoot, "my-skill", "SKILL.md"), "utf8")).toBe(skillFile("my-skill"));
    expect(installed.stdout).toContain(`Removed retired ArchFlow skills from ${codexSkillRoot}/: archflow-phase ${RETIRED_SKILLS.join(" ")}`);
    expect(installed.stdout).toContain(`Removed retired ArchFlow skills from ${antigravitySkillRoot}/: archflow-upgrade archflow-simple`);

    // The Antigravity entry is removed and reported; the other server and setting are kept, as is the mode.
    expect(JSON.parse(await readFile(mcpConfig, "utf8"))).toEqual({ mcpServers: { other: otherServer }, theme: "dark" });
    expect((await stat(mcpConfig)).mode & 0o777).toBe(0o600);
    expect(installed.stdout).toContain(
      `Removed the retired "archflow" MCP server entry (command ${join(home, ".local", "bin", "archflow-mcp")}) from ${mcpConfig}`,
    );
    expect(installed.stderr).toBe("");

    // A second install finds nothing left to remove.
    const reinstalled = runInstaller(root, home, bin, undefined, {}, []);
    expect(reinstalled.status, reinstalled.stderr).toBe(0);
    expect(reinstalled.stdout).not.toContain("Removed");
    expect(reinstalled.stderr).toBe("");

    expect(await realHomeFingerprint()).toEqual(realHomeBefore);
  }, TEST_TIMEOUT_MS);

  it("keeps leftovers that are not provably ArchFlow's and says so", async () => {
    const root = await checkoutCopy();
    const home = join(root, "home");
    const bin = join(home, "bin");
    const realHomeBefore = await realHomeFingerprint();

    await mkdir(bin, { recursive: true });
    const foreignLauncher = "#!/bin/sh\nexec /opt/someone-else/archflow-mcp \"$@\"\n";
    await writeFile(join(bin, "archflow-mcp"), foreignLauncher);
    const claudeSkillRoot = join(home, ".claude", "skills");
    // A person's own skill under a retired name, and a retired directory without a SKILL.md.
    await mkdir(join(claudeSkillRoot, "archflow-design"), { recursive: true });
    await writeFile(join(claudeSkillRoot, "archflow-design", "SKILL.md"), skillFile("my-design-notes"));
    await mkdir(join(claudeSkillRoot, "archflow-status"), { recursive: true });
    await writeFile(join(claudeSkillRoot, "archflow-status", "notes.md"), "mine\n");
    // A manifest-owned file sits beside a file the person added: only the owned file goes.
    await mkdir(join(claudeSkillRoot, "archflow-prd"), { recursive: true });
    await writeFile(join(claudeSkillRoot, "archflow-prd", "SKILL.md"), skillFile("archflow-prd"));
    await writeFile(join(claudeSkillRoot, "archflow-prd", "my-notes.md"), "mine\n");
    await writeFile(join(claudeSkillRoot, ".archflow-installed"), "archflow-prd/SKILL.md\n");

    const installed = runInstaller(root, home, bin);
    expect(installed.error).toBeUndefined();
    expect(installed.status, installed.stderr).toBe(0);

    expect(await readFile(join(bin, "archflow-mcp"), "utf8")).toBe(foreignLauncher);
    expect(installed.stderr).toContain(`Kept ${join(bin, "archflow-mcp")}: it is not the archflow-mcp launcher an earlier ArchFlow install wrote.`);
    expect(installed.stdout).not.toContain("Removed the retired archflow-mcp launcher");

    expect(await readFile(join(claudeSkillRoot, "archflow-design", "SKILL.md"), "utf8")).toBe(skillFile("my-design-notes"));
    expect(installed.stderr).toContain(`Kept ${join(claudeSkillRoot, "archflow-design")}: its SKILL.md names "my-design-notes", not the retired ArchFlow skill archflow-design.`);
    expect(await readFile(join(claudeSkillRoot, "archflow-status", "notes.md"), "utf8")).toBe("mine\n");
    expect(installed.stderr).toContain(`Kept ${join(claudeSkillRoot, "archflow-status")}: it holds files but no SKILL.md naming the retired ArchFlow skill archflow-status, so they are not provably ArchFlow's.`);
    expect(await exists(join(claudeSkillRoot, "archflow-prd", "SKILL.md"))).toBe(false);
    expect(await readFile(join(claudeSkillRoot, "archflow-prd", "my-notes.md"), "utf8")).toBe("mine\n");
    expect(installed.stdout).not.toContain("Removed retired ArchFlow skills");

    expect(await realHomeFingerprint()).toEqual(realHomeBefore);
  }, TEST_TIMEOUT_MS);

  it("removes only a launcher of exactly the shape earlier installers wrote", async () => {
    const root = await checkoutCopy();
    const home = join(root, "home");
    const bin = join(home, "bin");
    await mkdir(bin, { recursive: true });
    // The old shape plus one extra line is no longer provably ArchFlow's.
    const edited = `${oldMcpLauncher("/opt/archflow/bundle")}echo edited\n`;
    await writeFile(join(bin, "archflow-mcp"), edited);
    const installed = runInstaller(root, home, bin);
    expect(installed.status, installed.stderr).toBe(0);
    expect(await readFile(join(bin, "archflow-mcp"), "utf8")).toBe(edited);
    expect(installed.stderr).toContain(`Kept ${join(bin, "archflow-mcp")}`);
  }, TEST_TIMEOUT_MS);

  it("never removes or writes anything through a symbolic link under a skills root", async () => {
    const root = await checkoutCopy();
    const home = join(root, "home");
    const bin = join(home, "bin");
    const skillRoot = join(home, ".claude", "skills");
    const outside = join(root, "dotfiles");
    const realHomeBefore = await realHomeFingerprint();

    // A retired skill and a surviving skill whose directories link to a checkout outside the skills root.
    await mkdir(join(outside, "archflow-prd", "references"), { recursive: true });
    await writeFile(join(outside, "archflow-prd", "SKILL.md"), skillFile("archflow-prd"));
    await writeFile(join(outside, "archflow-prd", "references", "guide.md"), "reference\n");
    await mkdir(join(outside, "archflow-init", "obsolete"), { recursive: true });
    await writeFile(join(outside, "archflow-init", "SKILL.md"), "my working copy\n");
    await writeFile(join(outside, "archflow-init", "obsolete", "old.md"), "old\n");
    await mkdir(skillRoot, { recursive: true });
    await symlink(join(outside, "archflow-prd"), join(skillRoot, "archflow-prd"));
    await symlink(join(outside, "archflow-init"), join(skillRoot, "archflow-init"));
    // The owner manifest lists files the release dropped, reachable only through the links.
    await writeFile(join(skillRoot, ".archflow-installed"), [
      "archflow-init/SKILL.md",
      "archflow-init/obsolete/old.md",
      "archflow-prd/SKILL.md",
      "archflow-prd/references/guide.md",
    ].join("\n") + "\n");
    const outsideBefore = await treeSnapshot(outside);

    const installed = runInstaller(root, home, bin);
    expect(installed.error).toBeUndefined();
    expect(installed.status, installed.stderr).toBe(0);

    expect(await treeSnapshot(outside)).toEqual(outsideBefore);
    expect((await lstat(join(skillRoot, "archflow-prd"))).isSymbolicLink()).toBe(true);
    expect((await lstat(join(skillRoot, "archflow-init"))).isSymbolicLink()).toBe(true);
    expect(installed.stderr).toContain(
      `Kept the files an earlier install put under ${join(skillRoot, "archflow-init")}: it is a symbolic link, so the installer does not remove anything through it.`,
    );
    expect(installed.stderr).toContain(
      `Kept the files an earlier install put under ${join(skillRoot, "archflow-prd")}: it is a symbolic link`,
    );
    expect(installed.stderr).toContain(
      `Kept ${join(skillRoot, "archflow-prd")}: it is a symbolic link, so the installer does not remove it or anything it points to.`,
    );
    expect(installed.stderr).toContain(
      `Skipped installing archflow-init into ${join(skillRoot, "archflow-init")}: it is a symbolic link`,
    );
    // The other skills install normally, and the owner manifest claims nothing behind the link.
    expect(await readFile(join(skillRoot, "archflow-run", "SKILL.md"), "utf8"))
      .toBe(await readFile(join(root, "skills", "archflow-run", "SKILL.md"), "utf8"));
    const manifest = await readFile(join(skillRoot, ".archflow-installed"), "utf8");
    expect(manifest).not.toContain("archflow-init/");
    expect(manifest).toContain("archflow-run/SKILL.md\n");
    expect(installed.stdout).toContain("Claude Code: /archflow-init, /archflow-constitution, /archflow-explore, /archflow-run\n");

    expect(await realHomeFingerprint()).toEqual(realHomeBefore);
  }, TEST_TIMEOUT_MS);

  describe("Antigravity registration cleanup", () => {
    async function installWithConfig(seed: (path: string) => Promise<void>) {
      const root = await checkoutCopy();
      const home = join(root, "home");
      const bin = join(home, "bin");
      const path = join(home, ".gemini", "config", "mcp_config.json");
      await mkdir(dirname(path), { recursive: true });
      await seed(path);
      const installed = runInstaller(root, home, bin, undefined, {}, ["--antigravity"]);
      expect(installed.error).toBeUndefined();
      expect(installed.status, installed.stderr).toBe(0);
      return { root, path, installed };
    }

    it("keeps a foreign archflow entry byte for byte", async () => {
      const source = `${JSON.stringify({ mcpServers: { archflow: { command: "/opt/tools/my-archflow-server", args: [] } } }, null, 2)}\n`;
      const { path, installed } = await installWithConfig((target) => writeFile(target, source));
      expect(await readFile(path, "utf8")).toBe(source);
      expect(installed.stderr).toContain(`Kept the "archflow" MCP server entry in ${path}: its command is not the archflow-mcp launcher ArchFlow registered.`);
      expect(installed.stdout).not.toContain("MCP server entry");
    }, TEST_TIMEOUT_MS);

    it("leaves an empty server map when the ArchFlow entry was the only content", async () => {
      const { path, installed } = await installWithConfig((target) => writeFile(target, `${JSON.stringify({
        mcpServers: { archflow: { command: "archflow-mcp", args: [], timeoutSeconds: 3600 } },
      }, null, 2)}\n`));
      expect(await readFile(path, "utf8")).toBe(`${JSON.stringify({ mcpServers: {} }, null, 2)}\n`);
      expect(installed.stdout).toContain(`Removed the retired "archflow" MCP server entry (command archflow-mcp) from ${path}`);
    }, TEST_TIMEOUT_MS);

    it("leaves invalid JSON alone and warns", async () => {
      const source = "{ \"mcpServers\": { \"archflow\": { \"command\": \"archflow-mcp\" } ";
      const { path, installed } = await installWithConfig((target) => writeFile(target, source));
      expect(await readFile(path, "utf8")).toBe(source);
      expect(installed.stderr).toContain(`Left ${path} alone: it is not valid JSON.`);
    }, TEST_TIMEOUT_MS);

    it("does not follow a symlinked config file", async () => {
      const source = `${JSON.stringify({ mcpServers: { archflow: { command: "archflow-mcp", args: [] } } }, null, 2)}\n`;
      let target = "";
      const { path, installed } = await installWithConfig(async (link) => {
        target = join(dirname(dirname(dirname(link))), "dotfiles-mcp_config.json");
        await writeFile(target, source);
        await symlink(target, link);
      });
      expect((await lstat(path)).isSymbolicLink()).toBe(true);
      expect(await readFile(target, "utf8")).toBe(source);
      expect(installed.stderr).toContain(`Left ${path} alone: it is a symbolic link.`);
    }, TEST_TIMEOUT_MS);

    it.skipIf(process.getuid?.() === 0)("leaves an unreadable config alone, warns, and still finishes the install", async () => {
      const source = `${JSON.stringify({ mcpServers: { archflow: { command: "archflow-mcp", args: [] } } }, null, 2)}\n`;
      const root = await checkoutCopy();
      const home = join(root, "home");
      const bin = join(home, "bin");
      const path = join(home, ".gemini", "config", "mcp_config.json");
      await mkdir(dirname(path), { recursive: true });
      await writeFile(path, source);
      await chmod(path, 0o000);
      const installed = runInstaller(root, home, bin, undefined, {}, ["--agy"]);
      expect(installed.error).toBeUndefined();
      expect(installed.status, installed.stderr).toBe(0);
      expect((await stat(path)).mode & 0o777).toBe(0o000);
      await chmod(path, 0o600);
      expect(await readFile(path, "utf8")).toBe(source);
      expect(installed.stderr).toContain(`Left ${path} alone: EACCES`);
      expect(installed.stderr).toContain("Remove its \"archflow\" MCP server entry by hand if it runs archflow-mcp.");
      expect(installed.stderr).not.toContain("    at ");
      expect((await readdir(dirname(path))).sort()).toEqual(["mcp_config.json", "skills"]);
      expect(installed.stdout).toContain(`ArchFlow bundle installed to ${join(home, "archflow-home", "bundle")}/`);
      expect(installed.stdout).toContain("Antigravity: /archflow-init, /archflow-constitution, /archflow-explore\n");
    }, TEST_TIMEOUT_MS);

    it("is not touched by an install that does not target Antigravity", async () => {
      const root = await checkoutCopy();
      const home = join(root, "home");
      const bin = join(home, "bin");
      const path = join(home, ".gemini", "config", "mcp_config.json");
      const source = `${JSON.stringify({ mcpServers: { archflow: { command: "archflow-mcp", args: [] } } }, null, 2)}\n`;
      await mkdir(dirname(path), { recursive: true });
      await writeFile(path, source);
      const installed = runInstaller(root, home, bin, undefined, {}, ["--claude"]);
      expect(installed.status, installed.stderr).toBe(0);
      expect(await readFile(path, "utf8")).toBe(source);
    }, TEST_TIMEOUT_MS);
  });

  it("installs a verified offline bundle and prunes only previously owned skill files", async () => {
    const root = await checkoutCopy();
    const home = join(root, "home");
    const bin = join(home, "bin");
    const skillRoot = join(home, ".claude", "skills");
    await mkdir(join(skillRoot, "unrelated"), { recursive: true });
    await mkdir(join(skillRoot, "archflow-status"), { recursive: true });
    await writeFile(join(skillRoot, "unrelated", "SKILL.md"), "human-owned\n");
    await writeFile(join(skillRoot, "archflow-status", "obsolete.md"), "obsolete\n");
    await writeFile(join(skillRoot, ".archflow-installed"), "archflow-status/obsolete.md\n");

    const installed = runInstaller(root, home, bin);
    expect(installed.error).toBeUndefined();
    expect(installed.status, installed.stderr).toBe(0);
    expect(await readFile(join(skillRoot, "unrelated", "SKILL.md"), "utf8")).toBe("human-owned\n");
    await expect(readFile(join(skillRoot, "archflow-status", "obsolete.md"))).rejects.toMatchObject({ code: "ENOENT" });
    // The directory the pruned file left empty goes with it.
    expect(await exists(join(skillRoot, "archflow-status"))).toBe(false);
    expect(await readFile(join(home, "archflow-home", "bundle", "assets", "config.template.yaml"), "utf8"))
      .toBe(await readFile(join(root, "assets", "config.template.yaml"), "utf8"));
    expect(await readFile(join(home, "archflow-home", "bundle", "assets", "archflow.gitignore"), "utf8"))
      .toBe("/runtime/\n");

    // The bundle holds exactly the runtime assets the release manifest lists, nothing else from assets/.
    const manifest = JSON.parse(await readFile(join(root, "dist", "manifest.json"), "utf8")) as { runtime_assets: Array<{ path: string }> };
    const bundledAssets = (await readdir(join(home, "archflow-home", "bundle", "assets"), { recursive: true, withFileTypes: true }))
      .filter((entry) => entry.isFile())
      .map((entry) => join(entry.parentPath, entry.name).slice(join(home, "archflow-home", "bundle").length + 1))
      .sort();
    expect(bundledAssets).toEqual(manifest.runtime_assets.map((record) => record.path).sort());
    expect(bundledAssets).not.toContain("assets/review-inputs.yaml");
    expect(bundledAssets).not.toContain("assets/rubrics/README.md");

    // The installer writes exactly one launcher, for the local CLI.
    const launcher = await readFile(join(bin, "archflow-local"), "utf8");
    expect(launcher).toBe(`#!/bin/sh\nexec node "${join(home, "archflow-home", "bundle")}/dist/archflow-local.mjs" "$@"\n`);
    await expect(readFile(join(bin, "archflow-mcp"))).rejects.toMatchObject({ code: "ENOENT" });

    git(root, "-c", "init.defaultBranch=main", "init", "-q");
    await installFakeHosts(bin);
    const hostEnvironment = {
      ...process.env,
      HOME: home,
      PATH: `${bin}${delimiter}${process.env.PATH ?? ""}`,
    };
    const initialized = await runInputFreeInit(join(bin, "archflow-local"), root, hostEnvironment);
    expect(initialized.code, initialized.stderr).toBe(0);
    const report = JSON.parse(initialized.stdout) as {
      ok: boolean;
      value: { creates_commit: boolean; assets: { created: string[]; runtime_gitignore: string } };
    };
    expect(report).toMatchObject({ ok: true, value: { creates_commit: false, assets: { runtime_gitignore: "created" } } });
    expect(report.value.assets.created).toEqual(expect.arrayContaining([
      ".archflow/.gitignore",
      ".archflow/config.yaml",
      ".archflow/constitution/README.md",
      ".archflow/constitution/custom/README.md",
    ]));
    expect(report.value).not.toHaveProperty("creates_task_state");

    // Init scaffolds policy from the installed bundle and registers no MCP server anywhere.
    expect(await readFile(join(root, ".archflow", "config.yaml"), "utf8"))
      .toBe(await readFile(join(home, "archflow-home", "bundle", "assets", "config.template.yaml"), "utf8"));
    expect(await readFile(join(root, ".archflow", ".gitignore"), "utf8")).toBe("/runtime/\n");
    for (const absent of [join(root, ".archflow", "workflow.yaml"), join(root, ".mcp.json"), join(root, ".codex", "config.toml")]) {
      await expect(readFile(absent)).rejects.toMatchObject({ code: "ENOENT" });
    }
    git(root, "add", "--", ".archflow/.gitignore", ".archflow/constitution", ".archflow/config.yaml");
    git(root, "commit", "-q", "-m", "approve policy");

    // The committed policy is portable: no machine-local install path leaks into it.
    const portable = [
      await readFile(join(root, ".archflow", "config.yaml"), "utf8"),
      await readFile(join(root, ".archflow", ".gitignore"), "utf8"),
      initialized.stdout,
    ].join("\n");
    expect(portable).not.toContain(home);
    expect(portable).not.toContain(join(home, "archflow-home"));
  }, TEST_TIMEOUT_MS);

  it("rejects a mutated runtime asset before copying it", async () => {
    const root = await checkoutCopy();
    const home = join(root, "home");
    const bin = join(home, "bin");
    await writeFile(join(root, "assets", "archflow.gitignore"), "mutated\n");
    const installed = runInstaller(root, home, bin);
    expect(installed.status).toBe(1);
    expect(installed.stderr).toContain("payload verification failed for assets/archflow.gitignore");
  }, TEST_TIMEOUT_MS);

  it("prints the exact PATH export and fails when launchers are not resolvable", async () => {
    const root = await checkoutCopy();
    const home = join(root, "home");
    const bin = join(home, "not-on-path");
    const installed = runInstaller(root, home, bin, process.env.PATH ?? "");
    expect(installed.status).toBe(1);
    expect(installed.stderr).toContain(`export PATH="${bin}:$PATH"`);
  }, TEST_TIMEOUT_MS);

  it.each(["23.99.0", "24.14.0"])("rejects unsupported Node %s before installation", async (version) => {
    const root = await checkoutCopy();
    const home = join(root, "home");
    const bin = join(home, "bin");
    await mkdir(bin, { recursive: true });
    const fakeNode = join(bin, "node");
    const fakeNodeProgram = join(bin, "fake-node.cjs");
    await writeFile(fakeNodeProgram, `Object.defineProperty(process.versions, "node", { value: process.env.FAKE_NODE_VERSION });\nif (process.argv[2] !== "-e") process.exit(92);\nconst source = process.argv[3];\nprocess.argv = [process.argv[0], ...process.argv.slice(4)];\neval(source);\n`);
    await writeFile(fakeNode, `#!/bin/sh\nexec "${process.execPath}" "${fakeNodeProgram}" "$@"\n`);
    await chmod(fakeNode, 0o755);
    const installed = runInstaller(
      root,
      home,
      bin,
      `${bin}${delimiter}${process.env.PATH ?? ""}`,
      { FAKE_NODE_VERSION: version },
    );
    expect(installed.status).toBe(1);
    expect(installed.stderr).toContain(`ArchFlow requires Node ^24.15.0; observed ${version}.`);
  }, TEST_TIMEOUT_MS);
});

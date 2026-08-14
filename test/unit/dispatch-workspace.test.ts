import { execFileSync } from "node:child_process";
import { lstat, mkdir, mkdtemp, readFile, readlink, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import { createDispatchWorkspace, materializeRepositoryView } from "../../src/dispatch/workspace.js";

const roots: string[] = [];

async function temporaryRoot(label: string): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), `archflow-workspace-test-${label}-`));
  roots.push(root);
  return root;
}

afterEach(async () => {
  vi.unstubAllEnvs();
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("dispatch workspace", () => {
  it("builds the exact allowlisted environment", async () => {
    const sourceHome = await temporaryRoot("home");
    const repository = await temporaryRoot("repository");
    vi.stubEnv("HOME", sourceHome);
    vi.stubEnv("PATH", "/fixture/bin");
    vi.stubEnv("LANG", "en_US.UTF-8");
    vi.stubEnv("LC_ALL", "C.UTF-8");
    vi.stubEnv("HTTP_PROXY", "http://proxy.invalid");
    vi.stubEnv("HTTPS_PROXY", "https://proxy.invalid");
    vi.stubEnv("NO_PROXY", "localhost");
    vi.stubEnv("NODE_EXTRA_CA_CERTS", "/fixture/ca.pem");
    vi.stubEnv("ANTHROPIC_API_KEY", "must-not-leak");
    vi.stubEnv("OPENAI_BASE_URL", "must-not-leak");
    vi.stubEnv("UNRELATED_SECRET", "must-not-leak");

    const workspace = await createDispatchWorkspace("codex-cli", repository);
    expect(workspace.env).toEqual({
      PATH: "/fixture/bin",
      HOME: workspace.home,
      LANG: "en_US.UTF-8",
      LC_ALL: "C.UTF-8",
      TMPDIR: workspace.root,
      CODEX_HOME: join(workspace.home, ".codex"),
      HTTP_PROXY: "http://proxy.invalid",
      HTTPS_PROXY: "https://proxy.invalid",
      NO_PROXY: "localhost",
      NODE_EXTRA_CA_CERTS: "/fixture/ca.pem",
    });
    await workspace.dispose();
  });

  it.each([
    ["claude-cli", ".claude", ".credentials.json"],
    ["codex-cli", ".codex", "auth.json"],
  ] as const)("links only the %s credential file without reading its value", async (adapter, directory, filename) => {
    const sourceHome = await temporaryRoot(`${adapter}-home`);
    const repository = await temporaryRoot(`${adapter}-repository`);
    const sourceDirectory = join(sourceHome, directory);
    const sourceCredential = join(sourceDirectory, filename);
    await mkdir(sourceDirectory, { recursive: true });
    await writeFile(sourceCredential, "credential-canary-never-read", "utf8");
    await writeFile(join(sourceDirectory, "unrelated-state.json"), "state-canary", "utf8");
    vi.stubEnv("HOME", sourceHome);

    const workspace = await createDispatchWorkspace(adapter, repository);
    const generatedCredential = join(workspace.home, directory, filename);
    expect((await lstat(generatedCredential)).isSymbolicLink()).toBe(true);
    expect(await readlink(generatedCredential)).toBe(sourceCredential);
    expect(await readdir(join(workspace.home, directory))).toEqual([filename]);
    expect(await readdir(workspace.home)).toEqual([directory]);
    await workspace.dispose();
  });

  it("refuses a resolved temporary directory inside the repository", async () => {
    const repository = await temporaryRoot("inside-repository");
    const nestedTemporary = join(repository, "tmp");
    await mkdir(nestedTemporary);
    vi.stubEnv("TMPDIR", nestedTemporary);

    await expect(createDispatchWorkspace("codex-cli", repository)).rejects.toThrow(
      "dispatch temporary directory must be outside the repository",
    );
    expect(await readdir(nestedTemporary)).toEqual([]);
  });

  it("materializes a git-free repository view without task state and disposes it whole", async () => {
    const sourceHome = await temporaryRoot("view-home");
    const repository = await temporaryRoot("view-repository");
    vi.stubEnv("HOME", sourceHome);
    const env = {
      ...process.env,
      GIT_CONFIG_GLOBAL: "/dev/null",
      GIT_CONFIG_SYSTEM: "/dev/null",
      GIT_AUTHOR_NAME: "ArchFlow Test",
      GIT_AUTHOR_EMAIL: "test@example.invalid",
      GIT_COMMITTER_NAME: "ArchFlow Test",
      GIT_COMMITTER_EMAIL: "test@example.invalid",
    };
    execFileSync("git", ["init", "-q", "-b", "main"], { cwd: repository, env });
    await mkdir(join(repository, "src"), { recursive: true });
    await mkdir(join(repository, ".archflow", "context"), { recursive: true });
    await mkdir(join(repository, ".archflow", "tasks", "example"), { recursive: true });
    await writeFile(join(repository, "src", "index.ts"), "export {};\n");
    await writeFile(join(repository, ".archflow", "context", "map.md"), "# context\n");
    await writeFile(join(repository, ".archflow", "tasks", "example", "state.json"), "{}\n");
    execFileSync("git", ["add", "."], { cwd: repository, env });
    execFileSync("git", ["commit", "-qm", "seed"], { cwd: repository, env });
    const commit = execFileSync("git", ["rev-parse", "HEAD"], { cwd: repository, env, encoding: "utf8" }).trim();

    const base = await createDispatchWorkspace("codex-cli", repository);
    const workspace = await materializeRepositoryView(base, repository, commit);
    const view = workspace.repository_view_root!;
    expect(view).toBe(join(workspace.root, "repo"));
    await expect(readFile(join(view, "src", "index.ts"), "utf8")).resolves.toBe("export {};\n");
    await expect(readFile(join(view, ".archflow", "context", "map.md"), "utf8")).resolves.toBe("# context\n");
    await expect(lstat(join(view, ".git"))).rejects.toMatchObject({ code: "ENOENT" });
    await expect(lstat(join(view, ".archflow", "tasks"))).rejects.toMatchObject({ code: "ENOENT" });

    await workspace.dispose();
    await expect(lstat(workspace.root)).rejects.toMatchObject({ code: "ENOENT" });
    await expect(lstat(base.root)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("refuses malformed view commits and fails closed on unresolvable ones", async () => {
    const sourceHome = await temporaryRoot("view-failure-home");
    const repository = await temporaryRoot("view-failure-repository");
    vi.stubEnv("HOME", sourceHome);
    execFileSync("git", ["init", "-q", "-b", "main"], {
      cwd: repository,
      env: { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_SYSTEM: "/dev/null" },
    });
    const workspace = await createDispatchWorkspace("codex-cli", repository);
    try {
      await expect(materializeRepositoryView(workspace, repository, "HEAD"))
        .rejects.toThrow(/full lowercase git object id/u);
      await expect(materializeRepositoryView(workspace, repository, "f".repeat(40)))
        .rejects.toThrow(/repository view materialization failed/u);
    } finally {
      await workspace.dispose();
    }
  });

  it("reconstructs a post-change repository view from retained after-images", async () => {
    const sourceHome = await temporaryRoot("produced-view-home");
    const repository = await temporaryRoot("produced-view-repository");
    vi.stubEnv("HOME", sourceHome);
    const env = {
      ...process.env,
      GIT_CONFIG_GLOBAL: "/dev/null",
      GIT_CONFIG_SYSTEM: "/dev/null",
      GIT_AUTHOR_NAME: "Test",
      GIT_AUTHOR_EMAIL: "test@example.invalid",
      GIT_COMMITTER_NAME: "Test",
      GIT_COMMITTER_EMAIL: "test@example.invalid",
    };
    execFileSync("git", ["init", "-q", "-b", "main"], { cwd: repository, env });
    await mkdir(join(repository, "src"), { recursive: true });
    await writeFile(join(repository, "src", "modify.ts"), "before\n");
    await writeFile(join(repository, "src", "delete.ts"), "remove me\n");
    execFileSync("git", ["add", "."], { cwd: repository, env });
    execFileSync("git", ["commit", "-qm", "seed"], { cwd: repository, env });
    const commit = execFileSync("git", ["rev-parse", "HEAD"], { cwd: repository, env, encoding: "utf8" }).trim();

    const plan = {
      entries: [
        { path: "src/modify.ts", desired: { state: "present", file_type: "regular", mode: "100755", bytes: new TextEncoder().encode("after\n") } },
        { path: "src/delete.ts", desired: { state: "absent" } },
        { path: "new/nested.ts", desired: { state: "present", file_type: "regular", mode: "100644", bytes: new TextEncoder().encode("new\n") } },
        { path: "src/link", desired: { state: "present", file_type: "symlink", mode: "120000", bytes: new TextEncoder().encode("modify.ts") } },
      ],
      collisions: [],
      collision_choices: ["discard-and-restore", "adopt-as-new-generation", "abort"],
    } as unknown as NonNullable<Parameters<typeof materializeRepositoryView>[3]>;
    const base = await createDispatchWorkspace("codex-cli", repository);
    const workspace = await materializeRepositoryView(base, repository, commit, plan);
    const view = workspace.repository_view_root!;

    await expect(readFile(join(view, "src", "modify.ts"), "utf8")).resolves.toBe("after\n");
    expect((await lstat(join(view, "src", "modify.ts"))).mode & 0o111).not.toBe(0);
    await expect(lstat(join(view, "src", "delete.ts"))).rejects.toMatchObject({ code: "ENOENT" });
    await expect(readFile(join(view, "new", "nested.ts"), "utf8")).resolves.toBe("new\n");
    await expect(readlink(join(view, "src", "link"))).resolves.toBe("modify.ts");
    await workspace.dispose();
  });

  it("refuses to project durable task authority into a review view", async () => {
    const sourceHome = await temporaryRoot("produced-authority-home");
    const repository = await temporaryRoot("produced-authority-repository");
    vi.stubEnv("HOME", sourceHome);
    execFileSync("git", ["init", "-q", "-b", "main"], { cwd: repository });
    await writeFile(join(repository, "tracked.txt"), "base\n");
    execFileSync("git", ["add", "."], { cwd: repository });
    execFileSync("git", ["-c", "user.name=Test", "-c", "user.email=test@example.invalid", "commit", "-qm", "seed"], { cwd: repository });
    const commit = execFileSync("git", ["rev-parse", "HEAD"], { cwd: repository, encoding: "utf8" }).trim();
    const plan = {
      entries: [{
        path: ".archflow/tasks/demo/state.json",
        desired: { state: "present", file_type: "regular", mode: "100644", bytes: new TextEncoder().encode("{}\n") },
      }],
      collisions: [],
      collision_choices: ["discard-and-restore", "adopt-as-new-generation", "abort"],
    } as unknown as NonNullable<Parameters<typeof materializeRepositoryView>[3]>;
    const workspace = await createDispatchWorkspace("codex-cli", repository);
    try {
      await expect(materializeRepositoryView(workspace, repository, commit, plan))
        .rejects.toThrow(/cannot expose task authority/u);
    } finally {
      await workspace.dispose();
    }
  });

  it("removes the workspace and makes disposal idempotent", async () => {
    const sourceHome = await temporaryRoot("cleanup-home");
    const repository = await temporaryRoot("cleanup-repository");
    vi.stubEnv("HOME", sourceHome);
    const workspace = await createDispatchWorkspace("codex-cli", repository);
    const disposal = workspace.dispose();
    expect(workspace.dispose()).toBe(disposal);
    await disposal;
    await expect(lstat(workspace.root)).rejects.toMatchObject({ code: "ENOENT" });
    await workspace.dispose();
  });
});

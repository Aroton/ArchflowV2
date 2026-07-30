import { lstat, mkdir, mkdtemp, readlink, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import { createDispatchWorkspace } from "../../src/dispatch/workspace.js";

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

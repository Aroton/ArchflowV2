import { createHash } from "node:crypto";
import { lstat, mkdir, mkdtemp, readFile, readlink, readdir, rename, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import {
  createDispatchWorkspace,
  materializeRepositoryViews,
  projectRepositoryWorkspaceBinding,
  type DispatchRepositoryView,
  type DispatchRepositoryViewPlan,
  type DispatchWorkspace,
  type ReviewProjectionPlan,
} from "../../src/dispatch/workspace.js";
import { MULTI_REPOSITORY_VIEW_NOTE, sealDispatchInput } from "../../src/review/envelopes.js";
import { cleanupTemporaryRepositories, createTempRepository, type TempRepository } from "../helpers/temp-repository.js";

const roots: string[] = [];

const sha256 = (value: string): string => createHash("sha256").update(value).digest("hex");

/**
 * The plan the standalone review builds: the work under review as `primary` (the commit plus any
 * after-images) and the same repository at the starting commit as the `baseline` secondary.
 */
function reviewPlan(repository: string, commit: string, projectionPlan?: ReviewProjectionPlan): DispatchRepositoryViewPlan {
  const member = { repository_root: repository, repository_identity_digest: sha256(repository) as never, commit: commit as never };
  return [{
    name: "primary",
    member_kind: "primary",
    ...member,
    ...(projectionPlan === undefined ? {} : { projection_plan: projectionPlan, snapshot_digest: sha256(`${commit}:snapshot`) as never }),
  }, { name: "baseline", member_kind: "secondary", ...member }];
}

/** Where a materialized workspace holds one named repository view. */
const viewOf = (workspace: DispatchWorkspace, name: string): string => join(workspace.review_root!, "repositories", name);

async function temporaryRoot(label: string): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), `archflow-workspace-test-${label}-`));
  roots.push(root);
  return root;
}

afterEach(async () => {
  vi.unstubAllEnvs();
  cleanupTemporaryRepositories();
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

/** A committed repository whose worktree the dispatch views are built from; returns it with its HEAD. */
function seededRepository(label: string, files: Readonly<Record<string, string>>): { repository: TempRepository; commit: string } {
  const repository = createTempRepository({ label, attributes: undefined });
  for (const [path, content] of Object.entries(files)) repository.write(path, content);
  repository.commitAll("seed");
  return { repository, commit: repository.git("rev-parse", "HEAD") };
}

describe("dispatch workspace", () => {
  it("builds the exact allowlisted environment", async () => {
    const sourceHome = await temporaryRoot("home");
    const repository = await temporaryRoot("repository");
    const codexHome = join(sourceHome, "custom-codex-home");
    vi.stubEnv("HOME", sourceHome);
    vi.stubEnv("CODEX_HOME", codexHome);
    vi.stubEnv("CLAUDE_CONFIG_DIR", join(sourceHome, "must-not-reach-codex"));
    vi.stubEnv("USER", "fixture-user");
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
      USER: "fixture-user",
      PATH: "/fixture/bin",
      HOME: sourceHome,
      LANG: "en_US.UTF-8",
      LC_ALL: "C.UTF-8",
      TMPDIR: workspace.root,
      CODEX_HOME: codexHome,
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
  ] as const)("uses the canonical %s credential store and preserves atomic rotation", async (adapter, directory, filename) => {
    const sourceHome = await temporaryRoot(`${adapter}-home`);
    const repository = await temporaryRoot(`${adapter}-repository`);
    const sourceDirectory = join(sourceHome, directory);
    const sourceCredential = join(sourceDirectory, filename);
    await mkdir(sourceDirectory, { recursive: true });
    await writeFile(sourceCredential, "credential-canary-never-read", "utf8");
    await writeFile(join(sourceDirectory, "unrelated-state.json"), "state-canary", "utf8");
    vi.stubEnv("HOME", sourceHome);
    if (adapter === "claude-cli") vi.stubEnv("CLAUDE_CONFIG_DIR", sourceDirectory);
    else vi.stubEnv("CODEX_HOME", sourceDirectory);

    const workspace = await createDispatchWorkspace(adapter, repository);
    const selectedDirectory = adapter === "claude-cli"
      ? workspace.env.CLAUDE_CONFIG_DIR
      : workspace.env.CODEX_HOME;
    expect(workspace.env.HOME).toBe(sourceHome);
    expect(selectedDirectory).toBe(sourceDirectory);
    expect(workspace.env).not.toHaveProperty(adapter === "claude-cli" ? "CODEX_HOME" : "CLAUDE_CONFIG_DIR");
    await expect(lstat(join(workspace.root, "home"))).rejects.toMatchObject({ code: "ENOENT" });

    const selectedCredential = join(selectedDirectory!, filename);
    const replacement = join(sourceDirectory, "rotated-credential.tmp");
    await writeFile(replacement, "rotated-credential", "utf8");
    await rename(replacement, selectedCredential);
    await workspace.dispose();
    await expect(readFile(sourceCredential, "utf8")).resolves.toBe("rotated-credential");
    await expect(readdir(sourceDirectory)).resolves.toEqual([filename, "unrelated-state.json"]);
  });

  it("uses Claude's default home credential store without inventing a config override", async () => {
    const sourceHome = await temporaryRoot("claude-default-home");
    const repository = await temporaryRoot("claude-default-repository");
    vi.stubEnv("HOME", sourceHome);
    vi.stubEnv("CLAUDE_CONFIG_DIR", undefined);

    const workspace = await createDispatchWorkspace("claude-cli", repository);
    expect(workspace.env.HOME).toBe(sourceHome);
    expect(workspace.env).not.toHaveProperty("CLAUDE_CONFIG_DIR");
    expect(workspace.env).not.toHaveProperty("CODEX_HOME");
    await workspace.dispose();
  });

  it("uses Codex's default credential home when no override is configured", async () => {
    const sourceHome = await temporaryRoot("codex-default-home");
    const repository = await temporaryRoot("codex-default-repository");
    vi.stubEnv("HOME", sourceHome);
    vi.stubEnv("CODEX_HOME", undefined);

    const workspace = await createDispatchWorkspace("codex-cli", repository);
    expect(workspace.env.HOME).toBe(sourceHome);
    expect(workspace.env.CODEX_HOME).toBe(join(sourceHome, ".codex"));
    expect(workspace.env).not.toHaveProperty("CLAUDE_CONFIG_DIR");
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

  it("materializes git-free primary and baseline views without task state and disposes them whole", async () => {
    const sourceHome = await temporaryRoot("view-home");
    vi.stubEnv("HOME", sourceHome);
    const { repository: { path: repository }, commit } = seededRepository("view-repository", {
      "src/index.ts": "export {};\n",
      ".archflow/context/map.md": "# context\n",
      ".archflow/constitution/00-rule.md": "rule\n",
      ".archflow/tasks/example/state.json": "{}\n",
    });

    const base = await createDispatchWorkspace("codex-cli", repository);
    expect(projectRepositoryWorkspaceBinding(reviewPlan(repository, commit))).toEqual({
      kind: "read-only-multi-repository-view",
      note: MULTI_REPOSITORY_VIEW_NOTE,
      repositories: [
        { name: "primary", path: "primary", repository_identity_digest: sha256(repository), commit },
        { name: "baseline", path: "baseline", repository_identity_digest: sha256(repository), commit },
      ],
    });
    const workspace = await materializeRepositoryViews(base, reviewPlan(repository, commit));
    expect(workspace.review_root).toBe(join(workspace.root, "review"));
    expect((await readdir(join(workspace.review_root!, "repositories"))).sort()).toEqual(["baseline", "primary"]);
    const view = viewOf(workspace, "primary");
    await expect(readFile(join(view, "src", "index.ts"), "utf8")).resolves.toBe("export {};\n");
    await expect(readFile(join(view, ".archflow", "context", "map.md"), "utf8")).resolves.toBe("# context\n");
    await expect(lstat(join(view, ".git"))).rejects.toMatchObject({ code: "ENOENT" });
    await expect(lstat(join(view, ".archflow", "tasks"))).rejects.toMatchObject({ code: "ENOENT" });
    await expect(lstat(join(view, ".archflow", "constitution"))).rejects.toMatchObject({ code: "ENOENT" });
    const baseline = viewOf(workspace, "baseline");
    await expect(readFile(join(baseline, "src", "index.ts"), "utf8")).resolves.toBe("export {};\n");
    await expect(lstat(join(baseline, ".git"))).rejects.toMatchObject({ code: "ENOENT" });
    await expect(lstat(join(baseline, ".archflow"))).rejects.toMatchObject({ code: "ENOENT" });

    await workspace.dispose();
    await expect(lstat(workspace.root)).rejects.toMatchObject({ code: "ENOENT" });
    await expect(lstat(base.root)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("materializes ordered named repositories and removes all secondary ArchFlow authority", async () => {
    const sourceHome = await temporaryRoot("multi-view-home");
    vi.stubEnv("HOME", sourceHome);
    const seeded = new Map(["primary", "api"].map((name) => [name, seededRepository(`multi-view-${name}`, {
      "tracked.txt": `${name}\n`,
      ".archflow/tasks/foreign/state.json": "{}\n",
      ".archflow/constitution/rule.md": "rule\n",
    })]));
    const primary = seeded.get("primary")!.repository.path;
    const api = seeded.get("api")!.repository.path;
    const secondaryProjection = {
      entries: [{
        path: "tracked.txt",
        desired: { state: "present", file_type: "regular", mode: "100644", bytes: new TextEncoder().encode("api proposed\n") },
      }],
      collisions: [],
      collision_choices: ["discard-and-restore", "adopt-as-new-generation", "abort"],
    } as unknown as NonNullable<DispatchRepositoryView["projection_plan"]>;
    const view = (name: "primary" | "api", member_kind: "primary" | "secondary", root: string): DispatchRepositoryView => ({
      name,
      member_kind,
      repository_root: root,
      repository_identity_digest: "a".repeat(64) as never,
      commit: seeded.get(name)!.commit as never,
      ...(name === "api" ? { projection_plan: secondaryProjection, snapshot_digest: "b".repeat(64) as never } : {}),
    });
    const plan = [view("primary", "primary", primary), view("api", "secondary", api)] as const;
    const binding = projectRepositoryWorkspaceBinding(plan);
    expect(binding).toMatchObject({
      kind: "read-only-multi-repository-view",
      repositories: [
        { name: "primary", path: "primary" },
        { name: "api", path: "api", snapshot_digest: "b".repeat(64) },
      ],
    });
    const envelope = sealDispatchInput("review", {
      subject: { stage: "implementation", subject_digest: "c".repeat(64) },
      ask: "Review both proposed trees.",
      plan: "Change the tracked file in each repository.",
      paths: ["tracked.txt"],
      verification: "npm test",
      workspace: binding,
      assignment: { reviewer_id: "counter-reviewer-1", focus: "general", criterion_ids: ["repository-views"] },
      rubric: { schema_version: "1", kind: "implementation", mode: "adversarial", criteria: [
        { id: "repository-views", text: "Review every authenticated proposed tree.", blocking: true },
      ] },
    });
    const childVisible = JSON.parse(new TextDecoder().decode(envelope.bytes)) as {
      workspace: { repositories: Array<{ name: string; snapshot_digest?: string }> };
    };
    expect(childVisible.workspace.repositories).toEqual([
      expect.objectContaining({ name: "primary" }),
      expect.objectContaining({ name: "api", snapshot_digest: "b".repeat(64) }),
    ]);
    const workspace = await materializeRepositoryViews(
      await createDispatchWorkspace("codex-cli", primary),
      plan,
    );

    expect(workspace.review_root).toBe(join(workspace.root, "review"));
    await expect(readFile(join(viewOf(workspace, "primary"), "tracked.txt"), "utf8")).resolves.toBe("primary\n");
    await expect(lstat(join(viewOf(workspace, "primary"), ".archflow", "constitution"))).rejects.toMatchObject({ code: "ENOENT" });
    await expect(lstat(join(viewOf(workspace, "primary"), ".archflow", "tasks"))).rejects.toMatchObject({ code: "ENOENT" });
    await expect(readFile(join(viewOf(workspace, "api"), "tracked.txt"), "utf8")).resolves.toBe("api proposed\n");
    await expect(lstat(join(viewOf(workspace, "api"), ".archflow"))).rejects.toMatchObject({ code: "ENOENT" });
    await workspace.dispose();
  });

  it("rejects unsafe, duplicate, and out-of-order repository plans before materializing", async () => {
    const sourceHome = await temporaryRoot("invalid-plan-home");
    const repository = await temporaryRoot("invalid-plan-repository");
    vi.stubEnv("HOME", sourceHome);
    const workspace = await createDispatchWorkspace("codex-cli", repository);
    const member = (name: string): DispatchRepositoryView => ({
      name: name as DispatchRepositoryView["name"],
      member_kind: name === "primary" ? "primary" : "secondary",
      repository_root: repository,
      repository_identity_digest: "a".repeat(64) as never,
      commit: "b".repeat(40) as never,
    });
    await expect(materializeRepositoryViews(workspace, [member("primary"), member("zeta"), member("alpha")]))
      .rejects.toThrow(/sorted and unique/u);
    await expect(materializeRepositoryViews(workspace, [member("primary"), member("../escape")]))
      .rejects.toThrow();
    expect(await readdir(workspace.root)).toEqual([]);
    await workspace.dispose();
  });

  it("refuses malformed view commits and fails closed on unresolvable ones", async () => {
    const sourceHome = await temporaryRoot("view-failure-home");
    vi.stubEnv("HOME", sourceHome);
    const repository = createTempRepository({ label: "view-failure-repository", attributes: undefined }).path;
    const workspace = await createDispatchWorkspace("codex-cli", repository);
    try {
      await expect(materializeRepositoryViews(workspace, reviewPlan(repository, "HEAD")))
        .rejects.toThrow(/full lowercase git object id/u);
      await expect(materializeRepositoryViews(workspace, reviewPlan(repository, "f".repeat(40))))
        .rejects.toThrow(/repository view materialization failed/u);
    } finally {
      await workspace.dispose();
    }
  });

  it("reconstructs a post-change repository view from retained after-images", async () => {
    const sourceHome = await temporaryRoot("produced-view-home");
    vi.stubEnv("HOME", sourceHome);
    const { repository: { path: repository }, commit } = seededRepository("produced-view-repository", {
      "src/modify.ts": "before\n",
      "src/delete.ts": "remove me\n",
    });

    const plan = {
      entries: [
        { path: "src/modify.ts", desired: { state: "present", file_type: "regular", mode: "100755", bytes: new TextEncoder().encode("after\n") } },
        { path: "src/delete.ts", desired: { state: "absent" } },
        { path: "new/nested.ts", desired: { state: "present", file_type: "regular", mode: "100644", bytes: new TextEncoder().encode("new\n") } },
        { path: "src/link", desired: { state: "present", file_type: "symlink", mode: "120000", bytes: new TextEncoder().encode("modify.ts") } },
      ],
      collisions: [],
      collision_choices: ["discard-and-restore", "adopt-as-new-generation", "abort"],
    } as unknown as ReviewProjectionPlan;
    const base = await createDispatchWorkspace("codex-cli", repository);
    const workspace = await materializeRepositoryViews(base, reviewPlan(repository, commit, plan));
    const view = viewOf(workspace, "primary");

    await expect(readFile(join(view, "src", "modify.ts"), "utf8")).resolves.toBe("after\n");
    expect((await lstat(join(view, "src", "modify.ts"))).mode & 0o111).not.toBe(0);
    await expect(lstat(join(view, "src", "delete.ts"))).rejects.toMatchObject({ code: "ENOENT" });
    await expect(readFile(join(view, "new", "nested.ts"), "utf8")).resolves.toBe("new\n");
    await expect(readlink(join(view, "src", "link"))).resolves.toBe("modify.ts");
    // The baseline view keeps the starting commit's bytes: after-images apply to primary only.
    const baseline = viewOf(workspace, "baseline");
    await expect(readFile(join(baseline, "src", "modify.ts"), "utf8")).resolves.toBe("before\n");
    await expect(readFile(join(baseline, "src", "delete.ts"), "utf8")).resolves.toBe("remove me\n");
    await expect(lstat(join(baseline, "new"))).rejects.toMatchObject({ code: "ENOENT" });
    await workspace.dispose();
  });

  it("omits retained task authority while applying repository outputs", async () => {
    const sourceHome = await temporaryRoot("produced-authority-home");
    vi.stubEnv("HOME", sourceHome);
    const { repository: { path: repository }, commit } = seededRepository("produced-authority-repository", {
      "tracked.txt": "base\n",
    });
    const plan = {
      entries: [{
        path: ".archflow/tasks/demo/state.json",
        desired: { state: "present", file_type: "regular", mode: "100644", bytes: new TextEncoder().encode("{}\n") },
      }, {
        path: "tracked.txt",
        desired: { state: "present", file_type: "regular", mode: "100644", bytes: new TextEncoder().encode("after\n") },
      }],
      collisions: [],
      collision_choices: ["discard-and-restore", "adopt-as-new-generation", "abort"],
    } as unknown as ReviewProjectionPlan;
    const workspace = await materializeRepositoryViews(
      await createDispatchWorkspace("codex-cli", repository), reviewPlan(repository, commit, plan),
    );
    await expect(readFile(join(viewOf(workspace, "primary"), "tracked.txt"), "utf8"))
      .resolves.toBe("after\n");
    await expect(lstat(join(viewOf(workspace, "primary"), ".archflow", "tasks")))
      .rejects.toMatchObject({ code: "ENOENT" });
    await workspace.dispose();
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

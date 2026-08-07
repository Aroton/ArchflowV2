import { execFileSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative, sep } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { scaffoldRepositoryAssets } from "../../src/init/assets.js";
import { stageLegacyUpgrade } from "../../src/init/legacy-upgrade.js";
import { createProjectionWriter, type ProjectionWriter } from "../../src/state/atomic.js";

const roots: string[] = [];
const SECRET = "ghp_" + "0123456789abcdefghijklmnopqrstuvwxyz";

const gitEnvironment: NodeJS.ProcessEnv = {
  ...process.env,
  GIT_CONFIG_GLOBAL: "/dev/null",
  GIT_CONFIG_SYSTEM: "/dev/null",
  GIT_AUTHOR_NAME: "ArchFlow Test",
  GIT_AUTHOR_EMAIL: "test@example.invalid",
  GIT_COMMITTER_NAME: "ArchFlow Test",
  GIT_COMMITTER_EMAIL: "test@example.invalid",
};

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function git(root: string, ...arguments_: readonly string[]): string {
  return execFileSync("git", [...arguments_], {
    cwd: root,
    env: gitEnvironment,
    encoding: "utf8",
  }).trim();
}

function createGitRepository(label: string): string {
  const root = mkdtempSync(join(tmpdir(), `archflow-legacy-staging-${label}-`));
  roots.push(root);
  git(root, "-c", "init.defaultBranch=main", "init", "-q");
  writeFileSync(join(root, "README.md"), "repository\n");
  git(root, "add", "--", "README.md");
  git(root, "commit", "-q", "-m", "root");
  return root;
}

async function fixture(
  label: string,
  files: Readonly<Record<string, string>> = {
    "architecture.md": "# Legacy Architecture\n",
    "phases/phase-1-first.md": "# Phase 1\n",
    "prd.md": "# Legacy PRD\n",
  },
): Promise<Readonly<{ root: string; source: string; head: string }>> {
  const root = createGitRepository(label);
  const scaffolded = await scaffoldRepositoryAssets({ working_directory: root });
  if (!scaffolded.ok) throw new Error(scaffolded.error.code);
  const source = join(root, ".archflow", "tasks", "legacy-source");
  for (const [path, bytes] of Object.entries(files)) {
    const absolute = join(source, path);
    mkdirSync(dirname(absolute), { recursive: true });
    writeFileSync(absolute, bytes);
  }
  git(root, "add", "-A");
  git(root, "commit", "-q", "-m", "policy and legacy source");
  return Object.freeze({ root, source, head: git(root, "rev-parse", "HEAD") });
}

function stageInput(fixtureValue: Readonly<{ root: string; source: string; head: string }>) {
  return {
    working_directory: fixtureValue.root,
    source_root: fixtureValue.source,
    task_id: "destination",
    policy_base_commit: fixtureValue.head,
    import_baseline_commit: fixtureValue.head,
    code_baseline_commit: fixtureValue.head,
  } as const;
}

function regularFiles(root: string): string[] {
  if (!existsSync(root)) return [];
  const files: string[] = [];
  const pending = [root];
  while (pending.length > 0) {
    const directory = pending.pop()!;
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const absolute = join(directory, entry.name);
      if (entry.isDirectory()) pending.push(absolute);
      else files.push(relative(root, absolute).split(sep).join("/"));
    }
  }
  return files.sort();
}

describe("legacy staging faults and collisions", () => {
  it("rejects two legacy files mapping to the same canonical path", async () => {
    const prepared = await fixture("legacy-collision", {
      "phases/phase-1-alpha.md": "# Alpha\n",
      "phases/phase-1-beta.md": "# Beta\n",
      "prd.md": "# Legacy PRD\n",
    });
    const result = await stageLegacyUpgrade(stageInput(prepared));

    expect(result).toMatchObject({ ok: false, error: { code: "PATH_INVALID" } });
    const destination = join(prepared.root, ".archflow", "tasks", "destination");
    expect(existsSync(join(destination, "imports"))).toBe(false);
    expect(existsSync(join(destination, "state.json"))).toBe(false);
  });

  it("rejects a legacy source owned by another repository", async () => {
    const prepared = await fixture("legacy-destination");
    const other = createGitRepository("legacy-other-repository");
    const source = join(other, "legacy-source");
    mkdirSync(source);
    writeFileSync(join(source, "prd.md"), "# Foreign Legacy PRD\n");
    git(other, "add", "--", "legacy-source/prd.md");
    git(other, "commit", "-q", "-m", "foreign legacy source");

    const result = await stageLegacyUpgrade({ ...stageInput(prepared), source_root: source });

    expect(result).toMatchObject({ ok: false, error: { code: "REPOSITORY_MISMATCH" } });
    expect(existsSync(join(prepared.root, ".archflow", "tasks", "destination"))).toBe(false);
  });

  it("rejects a secret-bearing source before any projection write", async () => {
    const prepared = await fixture("legacy-secret", { "prd.md": `${SECRET}\n` });
    let projectionWrites = 0;
    const shipped = createProjectionWriter();
    const observingWriter: ProjectionWriter = Object.freeze({
      replaceRegular: async (...arguments_) => {
        projectionWrites += 1;
        await shipped.replaceRegular(...arguments_);
      },
      replaceSymlink: shipped.replaceSymlink,
      remove: shipped.remove,
    });

    const result = await stageLegacyUpgrade({ ...stageInput(prepared), projection_writer: observingWriter });

    expect(result).toMatchObject({ ok: false, error: { code: "SECRET_DETECTED" } });
    expect(projectionWrites).toBe(0);
    const destination = join(prepared.root, ".archflow", "tasks", "destination");
    expect(existsSync(join(destination, "imports"))).toBe(false);
    expect(existsSync(join(destination, "state.json"))).toBe(false);
  });

  it("leaves only inert bytes after a mid-copy fault and converges on exact rerun", async () => {
    const prepared = await fixture("legacy-mid-copy");
    const shipped = createProjectionWriter();
    let writes = 0;
    const faultingWriter: ProjectionWriter = Object.freeze({
      replaceRegular: async (...arguments_) => {
        writes += 1;
        if (writes === 2) throw new Error("mid-copy-fault");
        await shipped.replaceRegular(...arguments_);
      },
      replaceSymlink: shipped.replaceSymlink,
      remove: shipped.remove,
    });

    const interrupted = await stageLegacyUpgrade({ ...stageInput(prepared), projection_writer: faultingWriter });

    expect(interrupted).toMatchObject({ ok: false, error: { code: "IO_ERROR" } });
    expect(writes).toBe(2);
    const destination = join(prepared.root, ".archflow", "tasks", "destination");
    expect(existsSync(join(destination, "state.json"))).toBe(false);
    const interruptedFiles = regularFiles(destination);
    expect(interruptedFiles).toHaveLength(2);
    expect(interruptedFiles).toContain("config.yaml");
    expect(interruptedFiles.some((path) => path.endsWith("/payload/architecture.md"))).toBe(true);
    expect(interruptedFiles.some((path) => path.endsWith("/manifest.json"))).toBe(false);

    const converged = await stageLegacyUpgrade(stageInput(prepared));
    expect(converged.ok).toBe(true);
    if (!converged.ok) return;
    expect(existsSync(join(destination, "state.json"))).toBe(false);
    expect(regularFiles(destination)).toEqual([
      "config.yaml",
      ...converged.value.staged_paths.map((path) => path.replace(".archflow/tasks/destination/", "")),
    ].sort());
    for (const reference of converged.value.initialization.staged_payload_refs) {
      expect(readFileSync(join(
        destination,
        "imports",
        converged.value.initialization.import_digest,
        "payload",
        reference.legacy_path,
      ))).toEqual(readFileSync(join(prepared.source, reference.legacy_path)));
    }

    const exactRerun = await stageLegacyUpgrade(stageInput(prepared));
    expect(exactRerun).toEqual(converged);
  });
});

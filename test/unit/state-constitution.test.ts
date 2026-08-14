import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { parseGitOid } from "../../src/contracts/canonical.js";
import {
  parseSafeCode,
  parseSafeInteger,
  parseTaskSlug,
} from "../../src/contracts/evidence.js";
import type { RepositoryOperationContext } from "../../src/repository/git.js";
import { createGitRunner } from "../../src/repository/git.js";
import { discoverWorktree } from "../../src/repository/identity.js";
import {
  assertResolvedConstitution,
  detectTaskLocalConstitutionEdit,
  resolvePinnedConstitution,
} from "../../src/state/constitution.js";

const roots: string[] = [];
const context: RepositoryOperationContext = {
  task_id: parseTaskSlug("mcp-integration"),
  phase_instance: "phase-impl-14" as RepositoryOperationContext["phase_instance"],
  operation: parseSafeCode("constitution-test"),
  attempt: parseSafeInteger(1),
};
const rule = (id: string, version = 1): string =>
  `---\nid: ${id}\nversion: ${version}\nstatus: active\n---\n${id} rule\n`;

function git(root: string, ...argv: string[]): string {
  return execFileSync("git", argv, { cwd: root, encoding: "utf8" }).trim();
}

async function repository(files: Readonly<Record<string, string>>) {
  const root = mkdtempSync(join(tmpdir(), "archflow-state-constitution-"));
  roots.push(root);
  git(root, "init", "-q");
  git(root, "config", "user.email", "test@example.invalid");
  git(root, "config", "user.name", "ArchFlow Test");
  mkdirSync(join(root, ".archflow", "constitution"), { recursive: true });
  for (const [name, source] of Object.entries(files)) {
    writeFileSync(join(root, ".archflow", "constitution", name), source);
  }
  git(root, "add", ".");
  git(root, "commit", "-qm", "base");
  const discovered = await discoverWorktree(createGitRunner({ cwd: root }), context);
  if (!discovered.ok) throw new Error(discovered.error.code);
  return { root, runner: discovered.value, base: parseGitOid(git(root, "rev-parse", "HEAD")) };
}

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("pinned constitution", () => {
  it("reads only numbered rules from the immutable tree and ignores worktree edits", async () => {
    const repo = await repository({
      "00-process.md": rule("process"),
      "10-data.md": rule("data"),
      "README.md": "human notes\n",
    });
    const before = await resolvePinnedConstitution(repo.runner, repo.base, context);
    expect(before.ok).toBe(true);
    if (!before.ok) return;
    expect([...before.value.rules.keys()]).toEqual(["process", "data"]);
    expect(before.value.files.map((file) => file.path)).toEqual([
      ".archflow/constitution/00-process.md",
      ".archflow/constitution/10-data.md",
    ]);

    writeFileSync(join(repo.root, ".archflow", "constitution", "00-process.md"), rule("changed"));
    const after = await resolvePinnedConstitution(repo.runner, repo.base, context);
    expect(after.ok).toBe(true);
    if (!after.ok) return;
    expect(after.value.digest).toBe(before.value.digest);
    expect([...after.value.rules]).toEqual([...before.value.rules]);
    expect(after.value.files).toEqual(before.value.files);
    expect(() => assertResolvedConstitution({
      ...before.value,
    } as never)).toThrow(/authentic resolved constitution/u);
    expect(() => (before.value.rules as Map<string, unknown>).set("forged", {}))
      .toThrow();
    expect(() => (before.value.files as unknown[]).push({}))
      .toThrow();
  });

  it("classifies an empty pinned rule registry as POLICY_BASE_INVALID", async () => {
    const repo = await repository({ "README.md": "notes only\n" });
    const result = await resolvePinnedConstitution(repo.runner, repo.base, context);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe("POLICY_BASE_INVALID");
  });

  it("detects uncommitted README changes and committed rule changes", async () => {
    const repo = await repository({
      "00-process.md": rule("process"),
      "README.md": "notes\n",
    });
    const pinned = await resolvePinnedConstitution(repo.runner, repo.base, context);
    if (!pinned.ok) throw new Error(pinned.error.code);

    writeFileSync(join(repo.root, ".archflow", "constitution", "README.md"), "changed notes\n");
    const uncommitted = await detectTaskLocalConstitutionEdit(
      repo.runner,
      repo.base,
      pinned.value.digest,
      context,
    );
    expect(uncommitted.ok && uncommitted.value?.current_constitution_digest)
      .toBe(pinned.value.digest);

    git(repo.root, "add", ".");
    git(repo.root, "commit", "-qm", "readme edit");
    writeFileSync(join(repo.root, ".archflow", "constitution", "00-process.md"), rule("process", 2));
    git(repo.root, "add", ".");
    git(repo.root, "commit", "-qm", "rule edit");
    const committed = await detectTaskLocalConstitutionEdit(
      repo.runner,
      repo.base,
      pinned.value.digest,
      context,
    );
    expect(committed.ok && committed.value).toMatchObject({
      pinned_constitution_digest: pinned.value.digest,
      changed_path_class: "task-branch-constitution",
    });
    expect(committed.ok && committed.value?.current_constitution_digest)
      .not.toBe(pinned.value.digest);
  });

  it.each([
    ["deletion", undefined],
    ["malformed rule", "---\nid: broken\nnot: valid: yaml\n"],
  ])("opens the edit gate for a committed %s without parsing the HEAD registry", async (_label, source) => {
    const repo = await repository({ "00-process.md": rule("process") });
    const pinned = await resolvePinnedConstitution(repo.runner, repo.base, context);
    if (!pinned.ok) throw new Error(pinned.error.code);
    const path = join(repo.root, ".archflow", "constitution", "00-process.md");
    if (source === undefined) {
      git(repo.root, "rm", "-q", ".archflow/constitution/00-process.md");
    } else {
      writeFileSync(path, source);
      git(repo.root, "add", ".archflow/constitution/00-process.md");
    }
    git(repo.root, "commit", "-qm", "invalid task-local constitution edit");

    const detected = await detectTaskLocalConstitutionEdit(
      repo.runner,
      repo.base,
      pinned.value.digest,
      context,
    );
    expect(detected.ok && detected.value).toMatchObject({
      pinned_constitution_digest: pinned.value.digest,
      changed_path_class: "task-branch-constitution",
    });
    expect(detected.ok && detected.value?.current_constitution_digest)
      .not.toBe(pinned.value.digest);
  });
});

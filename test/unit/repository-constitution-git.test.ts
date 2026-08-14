import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  createGitRunner,
  readCommitRangeChangedPaths,
  readCommitTreeEntries,
  readHeadCommit,
} from "../../src/repository/git.js";

const roots: string[] = [];

function repository(): string {
  const root = mkdtempSync(join(tmpdir(), "archflow-constitution-git-"));
  roots.push(root);
  execFileSync("git", ["init", "-q"], { cwd: root });
  execFileSync("git", ["config", "user.email", "test@example.invalid"], { cwd: root });
  execFileSync("git", ["config", "user.name", "ArchFlow Test"], { cwd: root });
  mkdirSync(join(root, ".archflow", "constitution"), { recursive: true });
  writeFileSync(join(root, ".archflow", "constitution", "00-process.md"), "process\n");
  writeFileSync(join(root, ".archflow", "constitution", "README.md"), "readme\n");
  execFileSync("git", ["add", "."], { cwd: root });
  execFileSync("git", ["commit", "-qm", "base"], { cwd: root });
  return root;
}

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("constitution Git readers", () => {
  it("resolves HEAD through the repository Git boundary", async () => {
    const root = repository();
    const expected = execFileSync("git", ["rev-parse", "HEAD"], {
      cwd: root,
      encoding: "utf8",
    }).trim();
    await expect(readHeadCommit(createGitRunner({ cwd: root }))).resolves.toBe(expected);
  });

  it("lists bounded blob entries from the commit tree in path order", async () => {
    const root = repository();
    const entries = await readCommitTreeEntries(
      createGitRunner({ cwd: root }),
      "HEAD",
      ".archflow/constitution",
    );
    expect(entries.map(({ path, mode }) => ({ path, mode }))).toEqual([
      { path: ".archflow/constitution/00-process.md", mode: "100644" },
      { path: ".archflow/constitution/README.md", mode: "100644" },
    ]);
    expect(entries.every((entry) => /^[0-9a-f]{40}$/u.test(entry.oid))).toBe(true);
  });

  it("detects committed policy-base-to-HEAD constitution edits", async () => {
    const root = repository();
    const base = execFileSync("git", ["rev-parse", "HEAD"], { cwd: root, encoding: "utf8" }).trim();
    writeFileSync(join(root, ".archflow", "constitution", "README.md"), "changed\n");
    execFileSync("git", ["add", "."], { cwd: root });
    execFileSync("git", ["commit", "-qm", "edit"], { cwd: root });

    await expect(readCommitRangeChangedPaths(
      createGitRunner({ cwd: root }),
      base,
      ".archflow/constitution",
    )).resolves.toEqual([".archflow/constitution/README.md"]);
  });
});

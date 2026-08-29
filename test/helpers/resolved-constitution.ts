import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { parseGitOid } from "../../src/contracts/canonical.js";
import {
  parseSafeCode,
  parseSafeInteger,
  parseTaskSlug,
} from "../../src/contracts/evidence.js";
import { parsePhaseInstanceId } from "../../src/contracts/phase-instance.js";
import { createGitRunner } from "../../src/repository/git.js";
import { discoverWorktree } from "../../src/repository/identity.js";
import {
  resolvePinnedConstitution,
  type ResolvedConstitution,
} from "../../src/state/constitution.js";

const GIT_ENV: NodeJS.ProcessEnv = {
  ...process.env,
  GIT_CONFIG_GLOBAL: "/dev/null",
  GIT_CONFIG_SYSTEM: "/dev/null",
  GIT_AUTHOR_NAME: "ArchFlow Test",
  GIT_AUTHOR_EMAIL: "test@example.invalid",
  GIT_COMMITTER_NAME: "ArchFlow Test",
  GIT_COMMITTER_EMAIL: "test@example.invalid",
};

/** Creates a real commit-tree-backed constitution capability for focused service tests. */
export async function resolvedConstitutionFixture(
  files: Readonly<Record<string, string>>,
): Promise<ResolvedConstitution> {
  const root = mkdtempSync(join(tmpdir(), "archflow-resolved-constitution-"));
  try {
    execFileSync("git", ["init", "-q"], { cwd: root, env: GIT_ENV });
    mkdirSync(join(root, ".archflow", "constitution"), { recursive: true });
    for (const [name, source] of Object.entries(files)) {
      writeFileSync(join(root, ".archflow", "constitution", name), source);
    }
    execFileSync("git", ["add", "."], { cwd: root, env: GIT_ENV });
    execFileSync("git", ["commit", "-qm", "constitution fixture"], { cwd: root, env: GIT_ENV });
    const context = {
      task_id: parseTaskSlug("constitution-fixture"),
      phase_instance: parsePhaseInstanceId("phase-impl-14"),
      operation: parseSafeCode("constitution-fixture"),
      attempt: parseSafeInteger(1),
    } as const;
    const runner = await discoverWorktree(createGitRunner({ cwd: root }), context);
    if (!runner.ok) throw new Error(runner.error.code);
    const commit = parseGitOid(execFileSync(
      "git",
      ["rev-parse", "HEAD"],
      { cwd: root, env: GIT_ENV, encoding: "utf8" },
    ).trim());
    const resolved = await resolvePinnedConstitution(runner.value, commit, context);
    if (!resolved.ok) throw new Error(resolved.error.code);
    return resolved.value;
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

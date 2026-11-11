/**
 * A committed scratch repository scaffolded the way `archflow-local init` leaves it, for the
 * real-host dispatch tests. Like `task-workspace.ts` before it, this helper deliberately builds from
 * `src/**` (the init scaffold) so the reviewer sees the same review inputs a user repository has.
 */
import { execFileSync } from "node:child_process";
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { canonicalJsonDigest, parseGitOid, type GitOid } from "../../src/contracts/canonical.js";
import type { Sha256Digest } from "../../src/contracts/evidence.js";
import { scaffoldRepositoryAssets } from "../../src/init/assets.js";

export type ReviewRepositoryOptions = Readonly<{
  label: string;
  /** Complete replacement bytes for the scaffolded `.archflow/config.yaml`. */
  configBytes?: Uint8Array;
}>;

export type ReviewRepository = Readonly<{
  root: string;
  /** The committed HEAD the reviewer's repository view is taken from. */
  commit: GitOid;
  /** The identity the standalone review records for a repository: a digest of its root path. */
  repository_identity_digest: Sha256Digest;
  dispose: () => void;
}>;

const GIT_ENVIRONMENT: NodeJS.ProcessEnv = {
  ...process.env,
  GIT_CONFIG_GLOBAL: "/dev/null",
  GIT_CONFIG_SYSTEM: "/dev/null",
  GIT_AUTHOR_NAME: "ArchFlow Test",
  GIT_AUTHOR_EMAIL: "test@example.invalid",
  GIT_COMMITTER_NAME: "ArchFlow Test",
  GIT_COMMITTER_EMAIL: "test@example.invalid",
};

function git(root: string, ...arguments_: readonly string[]): string {
  return execFileSync("git", [...arguments_], { cwd: root, env: GIT_ENVIRONMENT, encoding: "utf8" }).trim();
}

/** Creates a repository with a root commit, then commits the init scaffold (and any config override). */
export async function createReviewRepository(options: ReviewRepositoryOptions): Promise<ReviewRepository> {
  const root = realpathSync(mkdtempSync(join(tmpdir(), `archflow-${options.label}-`)));
  const dispose = (): void => rmSync(root, { recursive: true, force: true });
  try {
    git(root, "-c", "init.defaultBranch=main", "init", "-q");
    writeFileSync(join(root, "README.md"), "repository\n");
    git(root, "add", "--", "README.md");
    git(root, "commit", "-q", "-m", "root");
    const scaffolded = await scaffoldRepositoryAssets({ working_directory: root });
    if (!scaffolded.ok) throw new Error(scaffolded.error.code);
    if (options.configBytes !== undefined) writeFileSync(join(root, ".archflow", "config.yaml"), options.configBytes);
    git(root, "add", "--", ".archflow");
    git(root, "commit", "-q", "-m", "review policy");
    return Object.freeze({
      root,
      commit: parseGitOid(git(root, "rev-parse", "HEAD")),
      repository_identity_digest: canonicalJsonDigest({ root }),
      dispose,
    });
  } catch (error) {
    dispose();
    throw error;
  }
}

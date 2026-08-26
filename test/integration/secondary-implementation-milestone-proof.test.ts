import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { gitBlobOid, parseGitOid } from "../../src/contracts/canonical.js";
import type { ImplementationRepositorySectionV1 } from "../../src/contracts/durable-implementation-output.js";
import { parseSafeInteger, parseSha256Digest } from "../../src/contracts/evidence.js";
import { parseRepositoryPathClaim } from "../../src/contracts/path-claims.js";
import { createGitRunner } from "../../src/repository/git.js";
import {
  resolveImplementationRepositoryMilestoneProof,
  secondaryImplementationMilestonesProven,
} from "../../src/state/implementation-manifest.js";

const roots: string[] = [];
afterEach(() => roots.splice(0).forEach((root) => rmSync(root, { recursive: true, force: true })));

const env = {
  ...process.env,
  GIT_CONFIG_GLOBAL: "/dev/null",
  GIT_CONFIG_SYSTEM: "/dev/null",
  GIT_AUTHOR_NAME: "ArchFlow Test",
  GIT_AUTHOR_EMAIL: "test@example.invalid",
  GIT_COMMITTER_NAME: "ArchFlow Test",
  GIT_COMMITTER_EMAIL: "test@example.invalid",
};

describe("secondary implementation milestone proof", () => {
  it("requires the complete authenticated proof set and preserves exact proofs through descendants", async () => {
    const root = mkdtempSync(join(tmpdir(), "archflow-secondary-proof-"));
    roots.push(root);
    execFileSync("git", ["init", "-q", "-b", "main"], { cwd: root, env });
    writeFileSync(join(root, "seed.txt"), "seed\n");
    execFileSync("git", ["add", "."], { cwd: root, env });
    execFileSync("git", ["commit", "-qm", "seed"], { cwd: root, env });
    const baseline = parseGitOid(execFileSync("git", ["rev-parse", "HEAD"], { cwd: root, env, encoding: "utf8" }).trim());
    const bytes = Buffer.from("proposed\n");
    const path = parseRepositoryPathClaim("proposed.txt");
    const digest = parseSha256Digest("a".repeat(64));
    const section: ImplementationRepositorySectionV1 = {
      repository: "api" as never,
      repository_identity_digest: parseSha256Digest("b".repeat(64)),
      base_commit: baseline,
      index_identity_digest: parseSha256Digest("c".repeat(64)),
      worktree_identity_digest: parseSha256Digest("d".repeat(64)),
      outputs: [{ path, path_class: "repository-source", operation: "add", storage: "raw-payload",
        payload_bytes: parseSafeInteger(bytes.byteLength), payload_digest: digest, file_type: "regular",
        after: { oid: gitBlobOid(bytes), mode: "100644", size_bytes: parseSafeInteger(bytes.byteLength) } }],
      diff_digest: parseSha256Digest("e".repeat(64)),
      snapshot_digest: parseSha256Digest("f".repeat(64)),
      restore_targets: [path],
      accounting: { schema_version: "1", result_bytes: parseSafeInteger(bytes.byteLength), task_bytes: parseSafeInteger(bytes.byteLength),
        result_byte_cap: 26_214_400, task_byte_cap: 262_144_000,
        counted_entries: [{ path, storage: "raw-payload", stored_bytes: parseSafeInteger(bytes.byteLength) }], measured_at_revision: parseSafeInteger(1) },
      undeclared_changes: { scanned: true, undeclared_paths: [], unrepresentable_count: parseSafeInteger(0) },
      declared_inputs: [],
    };
    const facts = {
      repository: section.repository,
      repository_identity_digest: section.repository_identity_digest,
      target_ref: "refs/heads/main",
      target_head: baseline,
      baseline_commit: baseline,
      commit_message: "authorized secondary",
      paths: [path],
      diff_digest: section.diff_digest,
      snapshot_digest: section.snapshot_digest,
    } as const;
    const runner = createGitRunner({ cwd: root }) as never;

    await expect(resolveImplementationRepositoryMilestoneProof(runner, section, {
      ...facts, target_head: parseGitOid("1".repeat(40)),
    })).resolves.toMatchObject({ kind: "missing-from-history", reason: "target-moved" });

    writeFileSync(join(root, path), bytes);
    execFileSync("git", ["add", "--", path], { cwd: root, env });
    execFileSync("git", ["commit", "-qm", facts.commit_message], { cwd: root, env });
    const candidate = execFileSync("git", ["rev-parse", "HEAD"], { cwd: root, env, encoding: "utf8" }).trim();
    await expect(resolveImplementationRepositoryMilestoneProof(runner, section, facts))
      .resolves.toMatchObject({ kind: "proven", commit: candidate });

    const output = { secondary_repositories: [section] } as never;
    const repositories = {
      members: [{
        name: section.repository,
        mode: "writable",
        binding: { runner },
        identity: { digest: section.repository_identity_digest },
      }],
    } as never;
    await expect(secondaryImplementationMilestonesProven(output, [], repositories)).resolves.toBe(false);
    await expect(secondaryImplementationMilestonesProven(output, [{
      ...facts,
      repository_identity_digest: parseSha256Digest("9".repeat(64)),
    }], repositories)).resolves.toBe(false);
    await expect(secondaryImplementationMilestonesProven(output, [facts], repositories)).resolves.toBe(true);

    writeFileSync(join(root, "later.txt"), "later\n");
    execFileSync("git", ["add", "."], { cwd: root, env });
    execFileSync("git", ["commit", "-qm", "later descendant"], { cwd: root, env });
    await expect(resolveImplementationRepositoryMilestoneProof(runner, section, facts))
      .resolves.toMatchObject({ kind: "proven", commit: candidate });
  });
});

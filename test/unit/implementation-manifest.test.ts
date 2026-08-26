import { describe, expect, it } from "vitest";

import { gitBlobOid, parseGitOid, sha256Bytes } from "../../src/contracts/canonical.js";
import type { ImplementationRepositorySectionV1 } from "../../src/contracts/durable-implementation-output.js";
import { parseSafeInteger, parseSha256Digest } from "../../src/contracts/evidence.js";
import { parseRepositoryPathClaim, rawGitPath } from "../../src/contracts/path-claims.js";
import {
  deriveImplementationDiffDigest,
  deriveOverallImplementationDiffDigest,
  deriveOverallImplementationSnapshotDigest,
  deriveIndexIdentityDigest,
  deriveSnapshotDigest,
  deriveWorktreeIdentityDigest,
  type SnapshotObservation,
} from "../../src/state/implementation-manifest.js";

const path = parseRepositoryPathClaim("src/a.ts");
const oid = parseGitOid("0123456789abcdef0123456789abcdef01234567");
const digest = parseSha256Digest("a".repeat(64));
const undeclared = { scanned: true, undeclared_paths: [rawGitPath("scratch.txt")], unrepresentable_count: 0 as never };

function repositorySection(
  repository: string,
  baseCommit: ReturnType<typeof parseGitOid>,
  bytes: Uint8Array,
): ImplementationRepositorySectionV1 {
  const contentOid = gitBlobOid(bytes);
  const contentDigest = sha256Bytes(bytes);
  const output = {
    path,
    path_class: "repository-source" as const,
    operation: "add" as const,
    file_type: "regular" as const,
    after: { oid: contentOid, mode: "100644" as const, size_bytes: bytes.byteLength as never },
    storage: "raw-payload" as const,
    payload_bytes: bytes.byteLength as never,
    payload_digest: contentDigest,
  };
  const snapshot: readonly SnapshotObservation[] = [{
    path,
    path_class: "repository-source",
    state: "present",
    file_type: "regular",
    mode: "100644",
    size_bytes: bytes.byteLength as never,
    oid: contentOid,
    content_digest: contentDigest,
  }];
  return {
    repository,
    repository_identity_digest: digest,
    base_commit: baseCommit,
    index_identity_digest: digest,
    worktree_identity_digest: digest,
    outputs: [output],
    diff_digest: deriveImplementationDiffDigest(baseCommit, [output]),
    snapshot_digest: deriveSnapshotDigest(snapshot),
    restore_targets: [path],
    accounting: {
      schema_version: "1",
      result_bytes: parseSafeInteger(bytes.byteLength),
      task_bytes: parseSafeInteger(bytes.byteLength),
      result_byte_cap: 26_214_400,
      task_byte_cap: 262_144_000,
      counted_entries: [{ path, storage: "raw-payload", stored_bytes: parseSafeInteger(bytes.byteLength) }],
      measured_at_revision: parseSafeInteger(1),
    },
    undeclared_changes: { scanned: true, undeclared_paths: [], unrepresentable_count: 0 as never },
    declared_inputs: [],
  };
}

describe("implementation identity subjects", () => {
  it("domain-separates snapshot, index, and worktree identities", () => {
    const worktree: readonly SnapshotObservation[] = [{
      path,
      path_class: "repository-source",
      state: "present",
      file_type: "regular",
      mode: "100644",
      size_bytes: 1,
      oid,
      content_digest: digest,
    }];
    const snapshot = deriveSnapshotDigest(worktree);
    const worktreeIdentity = deriveWorktreeIdentityDigest(worktree, undeclared);
    const indexIdentity = deriveIndexIdentityDigest([{ path, state: "present", stage: 0, mode: "100644", oid }], undeclared);
    expect(new Set([snapshot, worktreeIdentity, indexIdentity]).size).toBe(3);
  });

  it("keeps retention choices out of the implementation diff", () => {
    const common = {
      path,
      path_class: "repository-source" as const,
      operation: "add" as const,
      file_type: "regular" as const,
      after: { oid, mode: "100644" as const, size_bytes: 1 as never },
    };
    const git = [{ ...common, storage: "git-object" as const }];
    const raw = [{ ...common, storage: "raw-payload" as const, payload_bytes: 1 as never, payload_digest: digest }];
    expect(deriveImplementationDiffDigest(oid, git)).toBe(deriveImplementationDiffDigest(oid, raw));
  });

  it("binds secondary bytes and bases into deterministic overall identities", () => {
    const primaryDiff = parseSha256Digest("b".repeat(64));
    const primarySnapshot = parseSha256Digest("c".repeat(64));
    const api = repositorySection("api", parseGitOid("1".repeat(40)), new TextEncoder().encode("api one\n"));
    const worker = repositorySection("worker", parseGitOid("2".repeat(40)), new TextEncoder().encode("worker\n"));
    const changedBytes = repositorySection("api", api.base_commit, new TextEncoder().encode("api two\n"));
    const changedBase = repositorySection("api", parseGitOid("3".repeat(40)), new TextEncoder().encode("api one\n"));

    const diff = deriveOverallImplementationDiffDigest(primaryDiff, [api, worker]);
    const snapshot = deriveOverallImplementationSnapshotDigest(primarySnapshot, [api, worker]);
    expect(deriveOverallImplementationDiffDigest(primaryDiff, [worker, api])).toBe(diff);
    expect(deriveOverallImplementationSnapshotDigest(primarySnapshot, [worker, api])).toBe(snapshot);
    expect(deriveOverallImplementationDiffDigest(primaryDiff, [changedBytes, worker])).not.toBe(diff);
    expect(deriveOverallImplementationSnapshotDigest(primarySnapshot, [changedBytes, worker])).not.toBe(snapshot);
    expect(deriveOverallImplementationDiffDigest(primaryDiff, [changedBase, worker])).not.toBe(diff);
    expect(deriveOverallImplementationSnapshotDigest(primarySnapshot, [changedBase, worker])).not.toBe(snapshot);
    // No secondary sections: the overall identity is the primary digest itself.
    expect(deriveOverallImplementationDiffDigest(primaryDiff, [])).toBe(primaryDiff);
    expect(deriveOverallImplementationSnapshotDigest(primarySnapshot, [])).toBe(primarySnapshot);
  });
});

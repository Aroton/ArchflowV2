import { describe, expect, it } from "vitest";

import { parseGitOid } from "../../src/contracts/canonical.js";
import { parseSha256Digest } from "../../src/contracts/evidence.js";
import { parseRepositoryPathClaim, rawGitPath } from "../../src/contracts/path-claims.js";
import {
  deriveImplementationDiffDigest,
  deriveIndexIdentityDigest,
  deriveSnapshotDigest,
  deriveWorktreeIdentityDigest,
  type SnapshotObservation,
} from "../../src/state/implementation-manifest.js";

const path = parseRepositoryPathClaim("src/a.ts");
const oid = parseGitOid("0123456789abcdef0123456789abcdef01234567");
const digest = parseSha256Digest("a".repeat(64));
const undeclared = { scanned: true, undeclared_paths: [rawGitPath("scratch.txt")], unrepresentable_count: 0 as never };

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
});

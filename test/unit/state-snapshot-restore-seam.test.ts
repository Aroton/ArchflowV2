import { chmod, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { sha256Bytes } from "../../src/contracts/canonical.js";
import type { SafeId } from "../../src/contracts/evidence.js";
import type { RepositoryPathClaim } from "../../src/contracts/path-claims.js";
import type { SecretScanner } from "../../src/contracts/secret-scan.js";
import type { ResolvedPath, ResolvedTaskPath } from "../../src/repository/paths.js";
import {
  captureProjectionTarget,
  prepareProjectionPlan,
  projectionGenerationDigest,
  type ProjectionObservation,
} from "../../src/state/snapshots.js";

const roots: string[] = [];
afterEach(async () => Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))));

const P = (value: string): RepositoryPathClaim => value as RepositoryPathClaim;
const target = (root: string, path: RepositoryPathClaim): ResolvedPath => Object.freeze({
  absolute: join(root, path) as ResolvedTaskPath,
  repositoryRelative: path,
  path_class: "repository-source",
});
const cleanScanner: SecretScanner = {
  scan: async (candidates) => ({
    schema_version: "1", outcome: "clean", detector_set_id: "test" as SafeId,
    scanned_paths: candidates.map((candidate) => candidate.virtual_path),
  }),
};

async function temporaryRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "archflow-restore-seam-"));
  roots.push(root);
  return root;
}

describe("restore projection seam", () => {
  it("captures absent, regular, and symlink generations with exact rollback images", async () => {
    const root = await temporaryRoot();
    const absent = await captureProjectionTarget(target(root, P("absent.txt")));
    expect(absent).toEqual({ observation: { state: "absent" }, rollback: { state: "absent" } });

    const regularPath = target(root, P("regular.txt"));
    const regularBytes = new Uint8Array([0, 255, 10]);
    await writeFile(regularPath.absolute, regularBytes);
    await chmod(regularPath.absolute, 0o755);
    const regular = await captureProjectionTarget(regularPath);
    expect(regular.observation).toEqual({
      state: "present", file_type: "regular", mode: "100755",
      size_bytes: regularBytes.byteLength, content_digest: sha256Bytes(regularBytes),
    });
    expect(regular.rollback).toEqual({ state: "present", file_type: "regular", mode: "100755", bytes: regularBytes });

    const linkPath = target(root, P("link"));
    await symlink("regular.txt", linkPath.absolute);
    const linkBytes = Buffer.from("regular.txt");
    const link = await captureProjectionTarget(linkPath);
    expect(link.observation).toEqual({
      state: "present", file_type: "symlink", mode: "120000",
      size_bytes: linkBytes.byteLength, content_digest: sha256Bytes(linkBytes),
    });
    expect(link.rollback).toEqual({ state: "present", file_type: "symlink", mode: "120000", bytes: linkBytes });
  });

  it("digests the complete generation rather than content bytes alone", () => {
    const content = sha256Bytes(Buffer.from("same"));
    const regular: ProjectionObservation = { state: "present", file_type: "regular", mode: "100644", size_bytes: 4, content_digest: content };
    const executable: ProjectionObservation = { ...regular, mode: "100755" };
    const symlink: ProjectionObservation = { ...regular, file_type: "symlink", mode: "120000" };
    const absent: ProjectionObservation = { state: "absent" };

    expect(projectionGenerationDigest(regular)).toBe(projectionGenerationDigest(structuredClone(regular)));
    expect(new Set([regular, executable, symlink, absent].map(projectionGenerationDigest)).size).toBe(4);
  });

  it("preserves tracking and reciprocal rename facts in prepared entries", async () => {
    const root = await temporaryRoot();
    const oldPath = P("old.txt");
    const newPath = P("new.txt");
    const oldTarget = target(root, oldPath);
    const newTarget = target(root, newPath);
    const bytes = Buffer.from("old");
    await writeFile(oldTarget.absolute, bytes);
    const before: ProjectionObservation = {
      state: "present", file_type: "regular", mode: "100644",
      size_bytes: bytes.byteLength, content_digest: sha256Bytes(bytes),
    };
    const plan = await prepareProjectionPlan([
      { path: oldPath, target: oldTarget, desired: { state: "absent" }, authenticated_before: before,
        rollback: { state: "present", file_type: "regular", mode: "100644", bytes }, git_tracked: true,
        rename_pair: { role: "source", peer_path: newPath } },
      { path: newPath, target: newTarget, desired: { state: "present", file_type: "regular", mode: "100644", bytes },
        authenticated_before: { state: "absent" }, git_tracked: true,
        rename_pair: { role: "destination", peer_path: oldPath } },
    ], cleanScanner, root as ResolvedTaskPath);

    expect(plan).toMatchObject({ ok: true, value: { entries: [
      { path: oldPath, git_tracked: true, rename_pair: { role: "source", peer_path: newPath } },
      { path: newPath, git_tracked: true, rename_pair: { role: "destination", peer_path: oldPath } },
    ] } });
  });
});

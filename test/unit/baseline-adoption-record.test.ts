import { describe, expect, it } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { sha256Bytes } from "../../src/contracts/canonical.js";
import { parseSafeId } from "../../src/contracts/evidence.js";
import type { BaselineDriftedProjection } from "../../src/state/gates.js";
import { assessBaselineRestoreSourceFreshness, baselineAdoptionRecord } from "../../src/state/gates.js";
import { prepareProjectionPlan } from "../../src/state/snapshots.js";

/**
 * The adoption record's projection sort must satisfy the durable-state schema's sorted-unique
 * refinement, which compares plain code units. `localeCompare` orders mixed-case path sets
 * differently (here: locale says a.md < B.md, code units say B.md < a.md), and once produced a
 * record that failed receipt parsing only after the decision had been archived on the live task.
 */
describe("the durable baseline adoption record", () => {
  it("orders adopted projections by code unit, not locale", () => {
    const drifted = [
      { path: "docs/a.md", recorded_digest: "0".repeat(64), observed_digest: "1".repeat(64) },
      { path: "docs/B.md", recorded_digest: "2".repeat(64), observed_digest: "3".repeat(64) },
    ] as unknown as readonly BaselineDriftedProjection[];
    // The witness: the two comparators genuinely disagree on this pair.
    expect("docs/a.md".localeCompare("docs/B.md")).toBeLessThan(0);
    expect("docs/a.md" < "docs/B.md").toBe(false);

    const record = baselineAdoptionRecord("gate-adoption" as never, 5 as never, drifted);
    expect(record.adopted_projections.map((projection) => projection.path)).toEqual(["docs/B.md", "docs/a.md"]);
    expect(record.adopted_projections.map((projection) => projection.content_digest)).toEqual(["3".repeat(64), "1".repeat(64)]);
  });

  it("preserves repository identity when the same path is adopted in two repositories", () => {
    const primary = [{ path: "src/shared.ts", recorded_digest: "0".repeat(64), observed_digest: "1".repeat(64) }] as unknown as readonly BaselineDriftedProjection[];
    const secondary = [{
      repository: "apis",
      repository_identity_digest: "2".repeat(64),
      target_ref: "refs/heads/main",
      target_head: "3".repeat(40),
      drifted_projections: [{ path: "src/shared.ts", recorded_digest: "4".repeat(64), observed_digest: "5".repeat(64) }],
      deleted_projections: [{ path: "src/gone.ts", recorded_digest: "6".repeat(64) }],
      uncommitted_paths: ["src/shared.ts"],
    }] as never;
    const record = baselineAdoptionRecord("gate-multi" as never, 6 as never, primary, [], secondary);
    expect(record.adopted_projections).toEqual([
      { path: "src/shared.ts", content_digest: "1".repeat(64) },
      { repository: "apis", path: "src/shared.ts", content_digest: "5".repeat(64) },
    ]);
    expect(record.adopted_absences).toEqual([{ repository: "apis", path: "src/gone.ts" }]);
  });

  it("checks restore freshness against live bytes rather than a retained before-image", async () => {
    const root = mkdtempSync(join(tmpdir(), "archflow-restore-freshness-"));
    try {
      const target = join(root, "file.txt");
      writeFileSync(target, "changed-again\n");
      const observedBytes = Buffer.from("human-observed\n");
      const source = {
        path: "file.txt",
        target: { absolute: target, repositoryRelative: "file.txt", path_class: "repository-source" },
        desired: { state: "present", file_type: "regular", mode: "100644", bytes: Buffer.from("recorded\n") },
        // Deliberately claims the old observation. The live reread must override it.
        authenticated_before: { state: "present", file_type: "regular", mode: "100644", content_digest: sha256Bytes(observedBytes) },
        rollback: { state: "present", file_type: "regular", mode: "100644", bytes: observedBytes },
        git_tracked: true,
      } as never;
      await expect(assessBaselineRestoreSourceFreshness(source, sha256Bytes(observedBytes))).resolves.toMatchObject({ classification: "stale" });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("prepares legitimate drift restore from the same fresh live bytes it assessed", async () => {
    const root = mkdtempSync(join(tmpdir(), "archflow-restore-observed-"));
    try {
      const target = join(root, "file.txt");
      const observedBytes = Buffer.from("human-observed\n");
      writeFileSync(target, observedBytes);
      const source = {
        path: "file.txt",
        target: { absolute: target, repositoryRelative: "file.txt", path_class: "repository-source" },
        desired: { state: "present", file_type: "regular", mode: "100644", bytes: Buffer.from("recorded\n") },
        authenticated_before: { state: "present", file_type: "regular", mode: "100644", content_digest: sha256Bytes(Buffer.from("retained-before\n")) },
        rollback: { state: "present", file_type: "regular", mode: "100644", bytes: Buffer.from("retained-before\n") },
        git_tracked: true,
      } as never;
      const assessed = await assessBaselineRestoreSourceFreshness(source, sha256Bytes(observedBytes));
      expect(assessed).toMatchObject({
        classification: "observed",
        source: { authenticated_before: { content_digest: sha256Bytes(observedBytes) } },
      });
      const plan = await prepareProjectionPlan([assessed.source], {
        scan: async () => ({ schema_version: "1", outcome: "clean", detector_set_id: parseSafeId("test-clean"), scanned_paths: ["file.txt"] as never }),
      }, root as never);
      expect(plan.ok).toBe(true);
      if (plan.ok) expect(plan.value.collisions).toEqual([]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

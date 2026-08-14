import { execFileSync } from "node:child_process";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { canonicalDocument } from "../../src/contracts/canonical.js";
import { parseLegacyImportInitialization } from "../../src/contracts/durable-legacy-import.js";
import type { TaskStateV1 } from "../../src/contracts/durable-state.js";
import { parseSafeCode, parseSafeInteger, parseSha256Digest, parseTaskSlug } from "../../src/contracts/evidence.js";
import { parseRepositoryPathClaim } from "../../src/contracts/path-claims.js";
import { parsePhaseInstanceId } from "../../src/contracts/phase-instance.js";
import { scaffoldRepositoryAssets } from "../../src/init/assets.js";
import { discardLegacyUpgrade, stageLegacyUpgrade } from "../../src/init/legacy-upgrade.js";
import type { RepositoryOperationContext } from "../../src/repository/git.js";
import { resolveLegacySourcePath } from "../../src/repository/paths.js";
import { findLegacyImportResumePhase } from "../../src/state/gates.js";
import { createProductionServices } from "../../src/state/production.js";
import { createProjectionWriter } from "../../src/state/atomic.js";

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

const gitEnv: NodeJS.ProcessEnv = {
  ...process.env,
  GIT_CONFIG_GLOBAL: "/dev/null",
  GIT_CONFIG_SYSTEM: "/dev/null",
  GIT_AUTHOR_NAME: "ArchFlow Test",
  GIT_AUTHOR_EMAIL: "test@example.invalid",
  GIT_COMMITTER_NAME: "ArchFlow Test",
  GIT_COMMITTER_EMAIL: "test@example.invalid",
};

function git(root: string, ...argv: string[]): string {
  return execFileSync("git", argv, { cwd: root, env: gitEnv, encoding: "utf8" }).trim();
}

async function fixture(): Promise<{ root: string; source: string; head: string }> {
  const root = mkdtempSync(join(tmpdir(), "archflow-legacy-upgrade-"));
  roots.push(root);
  git(root, "-c", "init.defaultBranch=main", "init", "-q");
  writeFileSync(join(root, "README.md"), "repository\n");
  git(root, "add", "--", "README.md");
  git(root, "commit", "-q", "-m", "root");
  const scaffold = await scaffoldRepositoryAssets({ working_directory: root });
  if (!scaffold.ok) throw new Error(scaffold.error.code);
  const source = join(root, ".archflow", "tasks", "legacy-task");
  mkdirSync(join(source, "phases"), { recursive: true });
  mkdirSync(join(source, "reviews"), { recursive: true });
  writeFileSync(join(source, "prd.md"), "# Legacy PRD\n");
  writeFileSync(join(source, "architecture.md"), "# Legacy Architecture\n");
  writeFileSync(join(source, "phases", "phase-1-first.md"), "# Phase 1\n");
  writeFileSync(join(source, "phases", "phase-1-first-log.md"), "# Phase 1 Log\n");
  writeFileSync(join(source, "phases", "empty.bin"), new Uint8Array());
  writeFileSync(join(source, "reviews", "phase-3-impl-counter-review.md"), "# Phase 3 implementation review\n");
  writeFileSync(join(source, "reviews", "review-findings.md"), "Nothing actionable.\n");
  git(root, "add", "--", ".gitattributes", ".archflow");
  git(root, "commit", "-q", "-m", "policy and legacy source");
  return { root, source, head: git(root, "rev-parse", "HEAD") };
}

const context: RepositoryOperationContext = Object.freeze({
  task_id: parseTaskSlug("destination"),
  phase_instance: parsePhaseInstanceId("prd"),
  operation: parseSafeCode("stage-legacy-upgrade"),
  attempt: parseSafeInteger(1),
});

describe("legacy upgrade", () => {
  it("routes staging writes through the supplied projection writer", async () => {
    const { root, source, head } = await fixture();
    const shipped = createProjectionWriter();
    const written: string[] = [];
    const staged = await stageLegacyUpgrade({
      working_directory: root,
      source_root: source,
      task_id: "destination",
      policy_base_commit: head,
      import_baseline_commit: head,
      code_baseline_commit: head,
      projection_writer: Object.freeze({
        replaceRegular: async (path, bytes, executable) => {
          written.push(path.absolute);
          await shipped.replaceRegular(path, bytes, executable);
        },
        replaceSymlink: shipped.replaceSymlink,
        remove: shipped.remove,
      }),
    });
    expect(staged.ok).toBe(true);
    if (!staged.ok) return;
    expect(written).toHaveLength(staged.value.staged_paths.length);
    expect(written.some((path) => path.endsWith("/manifest.json"))).toBe(true);
  });

  it("resolves only beneath an arbitrary read-only source frame", async () => {
    const root = mkdtempSync(join(tmpdir(), "archflow-legacy-resolver-"));
    roots.push(root);
    const source = join(root, "legacy");
    mkdirSync(source);
    writeFileSync(join(source, "prd.md"), "legacy\n");
    const accepted = await resolveLegacySourcePath({ sourceRoot: source, claim: parseRepositoryPathClaim("prd.md"), context });
    expect(accepted).toMatchObject({ ok: true, value: { sourceRelative: "prd.md" } });
    symlinkSync(join(root, "outside.md"), join(source, "escape.md"));
    writeFileSync(join(root, "outside.md"), "outside\n");
    const escaped = await resolveLegacySourcePath({ sourceRoot: source, claim: parseRepositoryPathClaim("escape.md"), context });
    expect(escaped).toMatchObject({ ok: false, error: { code: "PATH_ESCAPE" } });
  });

  it("creates an unused destination, stages canonical bytes, maps legacy layout, and derives resume", async () => {
    const { root, source, head } = await fixture();
    const staged = await stageLegacyUpgrade({
      working_directory: root,
      source_root: source,
      task_id: "destination",
      policy_base_commit: head,
      import_baseline_commit: head,
      code_baseline_commit: head,
    });
    expect(staged.ok).toBe(true);
    if (!staged.ok) return;
    expect(parseLegacyImportInitialization(staged.value.initialization)).toEqual(staged.value.initialization);
    expect(staged.value.resume_phase).toBe("phase-design-2");
    expect(staged.value.unmapped).toContain("reviews/phase-3-impl-counter-review.md");
    expect(staged.value.initialization.mapping).toEqual(expect.arrayContaining([
      expect.objectContaining({ legacy_path: "prd.md", destination_path: ".archflow/tasks/destination/prd.md", disposition: "draft" }),
      expect.objectContaining({ legacy_path: "architecture.md", destination_path: ".archflow/tasks/destination/design.md", disposition: "draft" }),
      expect.objectContaining({ legacy_path: "phases/phase-1-first.md", destination_path: ".archflow/tasks/destination/phases/1/design.md", phase_instance: "phase-design-1" }),
      expect.objectContaining({ legacy_path: "phases/phase-1-first-log.md", destination_path: ".archflow/tasks/destination/phases/1/impl-notes.md", phase_instance: "phase-impl-1" }),
    ]));
    expect(staged.value.unmapped).toContain("reviews/review-findings.md");
    expect(staged.value.initialization.staged_payload_refs.find((item) => item.legacy_path === "phases/empty.bin")?.byte_count).toBe(0);
    expect(readFileSync(join(root, staged.value.manifest_path))).toEqual(Buffer.from(canonicalDocument(staged.value.initialization).bytes));
    expect(() => readFileSync(join(root, ".archflow", "tasks", "destination", "config.yaml"))).toThrow();
    expect(readFileSync(join(root, ".archflow", "runtime", "tasks", "destination", "cache", "imports", staged.value.initialization.import_digest, "config.yaml")))
      .toEqual(readFileSync(join(root, ".archflow", "config.yaml")));
    expect(() => readFileSync(join(root, ".archflow", "tasks", "destination", "prd.md"))).toThrow();

    const repeated = await stageLegacyUpgrade({
      working_directory: root,
      source_root: source,
      task_id: "destination",
      policy_base_commit: head,
      import_baseline_commit: head,
      code_baseline_commit: head,
    });
    expect(repeated.ok && repeated.value.initialization.import_digest).toBe(staged.value.initialization.import_digest);

    const services = await createProductionServices({
      working_directory: root,
      task_id: parseTaskSlug("destination"),
      operation: parseSafeCode("legacy-nonmatching-manifest"),
    });
    if (!services.ok) throw new Error(services.error.code);
    const unmatchedState = {
      schema_version: "1", task_id: staged.value.initialization.task_id,
      repository_identity_digest: staged.value.initialization.repository_identity_digest,
      revision: parseSafeInteger(1), phase_instance: parsePhaseInstanceId("design"), step: "adjudicate", status: "succeeded",
      attempt: parseSafeInteger(1), input_fingerprint: parseSha256Digest("0".repeat(64)),
      initialization_digest: parseSha256Digest("f".repeat(64)),
      config_digest: staged.value.initialization.config_digest,
      workflow_digest: staged.value.initialization.workflow_digest,
      constitution_digest: staged.value.initialization.constitution_digest,
      policy_base_commit: staged.value.initialization.policy_base_commit,
      authoritative_results: [], approvals: [], waivers: [],
    } as TaskStateV1;
    expect(await findLegacyImportResumePhase(services.value.dependencies, services.value.authority, unmatchedState))
      .toEqual({ schema_version: "1", ok: true, value: undefined });
  });

  it("previews without writes and resumes an imported in-flight phase at implementation", async () => {
    const { root, source, head } = await fixture();
    writeFileSync(join(source, "phases", "phase-2-current.md"), "# Phase 2 current design\n");
    const preview = await stageLegacyUpgrade({
      working_directory: root,
      source_root: source,
      task_id: "destination",
      policy_base_commit: head,
      import_baseline_commit: head,
      code_baseline_commit: head,
      operation: "preview",
    });
    expect(preview).toMatchObject({ ok: true, value: { operation: "preview", resume_phase: "phase-impl-2" } });
    expect(() => readFileSync(join(root, ".archflow", "tasks", "destination", "config.yaml"))).toThrow();
    expect(() => readFileSync(join(root, ".archflow", "runtime", "tasks", "destination", "cache", "imports", preview.ok ? preview.value.initialization.import_digest : "missing", "manifest.json"))).toThrow();
    if (!preview.ok) return;
    const staged = await stageLegacyUpgrade({
      working_directory: root,
      source_root: source,
      task_id: "destination",
      policy_base_commit: head,
      import_baseline_commit: head,
      code_baseline_commit: head,
      operation: "stage",
      approved_preview_digest: preview.value.preview_digest,
    });
    expect(staged).toMatchObject({ ok: true, value: { operation: "stage", resume_phase: "phase-impl-2" } });
  });

  it("rejects source/destination overlap and an occupied canonical destination before staging", async () => {
    const { root, source, head } = await fixture();
    const overlap = await stageLegacyUpgrade({ working_directory: root, source_root: join(root, ".archflow", "tasks"), task_id: "destination", policy_base_commit: head, import_baseline_commit: head, code_baseline_commit: head });
    expect(overlap).toMatchObject({ ok: false, error: { code: "TASK_INVALID" } });
    const occupied = join(root, ".archflow", "tasks", "occupied");
    mkdirSync(occupied, { recursive: true });
    writeFileSync(join(occupied, "prd.md"), "existing\n");
    const result = await stageLegacyUpgrade({ working_directory: root, source_root: source, task_id: "occupied", policy_base_commit: head, import_baseline_commit: head, code_baseline_commit: head });
    expect(result).toMatchObject({ ok: false, error: { code: "TASK_INVALID" } });
    expect(() => readFileSync(join(occupied, "config.yaml"))).toThrow();
  });

  it("safely discards an explicitly named pre-fix stage and unchanged config side effect", async () => {
    const { root } = await fixture();
    const digest = "c".repeat(64);
    const destination = join(root, ".archflow", "tasks", "destination");
    mkdirSync(destination, { recursive: true });
    writeFileSync(join(destination, "config.yaml"), readFileSync(join(root, ".archflow", "config.yaml")));
    const importRoot = join(root, ".archflow", "runtime", "tasks", "destination", "cache", "imports", digest);
    mkdirSync(importRoot, { recursive: true });
    writeFileSync(join(importRoot, "manifest.json"), "{}\n");
    expect(await discardLegacyUpgrade({ working_directory: root, task_id: "destination", import_digest: digest }))
      .toEqual({ schema_version: "1", ok: true, value: { discarded: true } });
    expect(() => readFileSync(join(destination, "config.yaml"))).toThrow();
    expect(() => readFileSync(join(importRoot, "manifest.json"))).toThrow();
  });
});

import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, realpathSync, writeFileSync } from "node:fs";
import { rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { canonicalDocument } from "../../src/contracts/canonical.js";
import type { TaskStateV1 } from "../../src/contracts/durable-state.js";
import { parseSafeCode, parseSafeId, parseSafeInteger, parseTaskSlug } from "../../src/contracts/evidence.js";
import { encodePhaseInstance, parsePositiveSafePhaseNumber } from "../../src/contracts/phase-instance.js";
import type { DegradedReview } from "../../src/contracts/review.js";
import type { SecretScanner } from "../../src/contracts/secret-scan.js";
import { createAtomicWriter } from "../../src/state/atomic.js";
import { prepareEvidenceResult } from "../../src/state/evidence-results.js";
import { ensureResultDirectory } from "../../src/state/layout.js";
import { createProductionServices } from "../../src/state/production.js";
import { installSnapshot } from "../../src/state/snapshots.js";
import { cleanTaskWorkspace, inspectWorkspaceCleanup } from "../../src/state/workspace-cleanup.js";

const roots: string[] = [];
afterEach(async () => Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))));
const task = parseTaskSlug("production-task");
const requestedPhase = encodePhaseInstance({ kind: "phase-design", phase: parsePositiveSafePhaseNumber(2) });
const committedPhase = encodePhaseInstance({ kind: "phase-impl", phase: parsePositiveSafePhaseNumber(15) });
const environment: NodeJS.ProcessEnv = {
  ...process.env,
  GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_SYSTEM: "/dev/null",
  GIT_AUTHOR_NAME: "ArchFlow Test", GIT_AUTHOR_EMAIL: "test@example.invalid",
  GIT_COMMITTER_NAME: "ArchFlow Test", GIT_COMMITTER_EMAIL: "test@example.invalid",
};

function repository(): string {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "archflow-production-")));
  roots.push(root);
  execFileSync("git", ["-c", "init.defaultBranch=main", "init", "-q"], { cwd: root, env: environment });
  writeFileSync(join(root, "tracked.txt"), "root\n");
  execFileSync("git", ["add", "--", "tracked.txt"], { cwd: root, env: environment });
  execFileSync("git", ["commit", "-q", "-m", "root"], { cwd: root, env: environment });
  mkdirSync(join(root, ".archflow", "tasks", task), { recursive: true });
  return root;
}

const D = (character: string) => character.repeat(64) as TaskStateV1["input_fingerprint"];

describe("production dependency assembly", () => {
  it("uses caller-supplied atomic and gate secret-scanner capabilities", async () => {
    const root = repository();
    const atomic = createAtomicWriter();
    const gateSecretScanner: SecretScanner = Object.freeze({
      scan: async () => Object.freeze({
        schema_version: "1" as const,
        outcome: "clean" as const,
        detector_set_id: parseSafeId("injected-scanner"),
        scanned_paths: Object.freeze([]),
      }),
    });
    const services = await createProductionServices({
      working_directory: root,
      task_id: task,
      operation: parseSafeCode("production-overrides"),
      atomic,
      gate_secret_scanner: gateSecretScanner,
    });
    if (!services.ok) throw new Error(services.error.code);
    expect(services.value.dependencies.atomic).toBe(atomic);
    expect(services.value.dependencies.gate_secret_scanner).toBe(gateSecretScanner);
  });

  it("uses the caller phase only for bootstrap, then rebuilds authority from committed phase and attempt", async () => {
    const root = repository();
    const input = { working_directory: root, task_id: task, operation: parseSafeCode("production-test"), phase_instance: requestedPhase };
    const bootstrap = await createProductionServices(input);
    expect(bootstrap.ok).toBe(true);
    if (!bootstrap.ok) return;
    expect(bootstrap.value.state).toBeUndefined();
    expect(bootstrap.value.authority.context).toMatchObject({ phase_instance: requestedPhase, attempt: 1 });

    const state: TaskStateV1 = {
      schema_version: "1", task_id: task,
      repository_identity_digest: bootstrap.value.authority.repository_identity_digest,
      revision: parseSafeInteger(4), phase_instance: committedPhase, step: "produce", status: "running",
      attempt: parseSafeInteger(3), input_fingerprint: D("1"), initialization_digest: D("2"),
      config_digest: D("3"), workflow_digest: D("4"), constitution_digest: D("5"),
      policy_base_commit: "abcdef0123456789abcdef0123456789abcdef01" as TaskStateV1["policy_base_commit"],
      authoritative_results: [], approvals: [], waivers: [],
    };
    writeFileSync(bootstrap.value.authority.state.absolute, canonicalDocument(state).bytes);
    const resolved = await createProductionServices(input);
    expect(resolved.ok).toBe(true);
    if (!resolved.ok) return;
    expect(resolved.value.state?.value).toEqual(state);
    expect(resolved.value.authority.context).toMatchObject({ phase_instance: committedPhase, attempt: 3 });
    expect(resolved.value.dependencies).toMatchObject({
      read_state: expect.any(Function), read_config: expect.any(Function), read_receipt: expect.any(Function),
      read_retained_task_bytes: expect.any(Function), load_retained_result: expect.any(Function),
      resolve_gate_reentry_fingerprint: expect.any(Function), resolve_supplemental_review: expect.any(Function),
    });
  });

  it("rehydrates embedded retained evidence after the ignored workspace is absent", async () => {
    const root = repository();
    const input = { working_directory: root, task_id: task, operation: parseSafeCode("production-retained-test"), phase_instance: committedPhase };
    const service = await createProductionServices(input);
    if (!service.ok) throw new Error("production setup failed");
    const review: DegradedReview = {
      schema_version: "1", task_id: task, phase_instance: committedPhase, step: "counter_review", role: "counter-review",
      subject_digest: D("a"), input_fingerprint: D("b"), rubric_digest: D("c"), producer_family: "claude",
      findings: [], matched_rule_versions: [], verdict: "pass", blocking_count: 0,
      assurance: "degraded", reason: "manual fallback", model_family: "codex", model: "unknown", effort: "unknown",
    };
    const scanner: SecretScanner = { scan: async (candidates) => ({
      schema_version: "1", outcome: "clean", detector_set_id: parseSafeId("test"),
      scanned_paths: candidates.map((candidate) => candidate.virtual_path),
    }) };
    const prepared = await prepareEvidenceResult({
      authority: service.value.authority, runner: service.value.runner, result_id: parseSafeId("retained-review"),
      retained_task_bytes: parseSafeInteger(0), measured_at_revision: parseSafeInteger(4), scanner,
      value: { kind: "review", evidence: review },
    });
    if (!prepared.ok) throw new Error(`preparation failed: ${prepared.error.code}`);
    expect(prepared.value.prepared.payloads).toEqual([]);
    expect(prepared.value.prepared.manifest.value.outputs).toEqual([]);
    expect(prepared.value.prepared.manifest.value.projections).toEqual([]);
    await ensureResultDirectory(service.value.authority, prepared.value.reference.result_digest);
    const installed = await installSnapshot(
      createAtomicWriter(), prepared.value.prepared, prepared.value.manifest_target,
      service.value.runner.location.worktreeRoot as never,
    );
    expect(installed.ok, installed.ok ? undefined : JSON.stringify(installed.error)).toBe(true);
    const state: TaskStateV1 = {
      schema_version: "1", task_id: task, repository_identity_digest: service.value.authority.repository_identity_digest,
      revision: parseSafeInteger(4), phase_instance: committedPhase, step: "counter_review", status: "succeeded",
      attempt: parseSafeInteger(1), input_fingerprint: D("b"), initialization_digest: D("2"), config_digest: D("3"),
      workflow_digest: D("4"), constitution_digest: D("5"),
      policy_base_commit: "abcdef0123456789abcdef0123456789abcdef01" as TaskStateV1["policy_base_commit"],
      authoritative_results: [prepared.value.reference], approvals: [], waivers: [],
    };
    writeFileSync(service.value.authority.state.absolute, canonicalDocument(state).bytes);
    await rm(service.value.authority.workspace_root, { recursive: true, force: true });
    const restarted = await createProductionServices(input);
    if (!restarted.ok) throw new Error("production restart failed");
    const retained = await restarted.value.dependencies.load_retained_result!(prepared.value.reference);
    expect(retained.ok).toBe(true);
    if (!retained.ok) return;
    expect(retained.value.prepared.payloads).toEqual([]);
    expect(retained.value.projection_plan.entries).toEqual([]);
    expect(retained.value.prepared.manifest.value.source_artifact).toEqual(prepared.value.prepared.manifest.value.source_artifact);
    await expect(restarted.value.dependencies.read_retained_task_bytes!()).resolves.toBe(0);
  });

  it("reports and removes stale reconstructible workspace files", async () => {
    const root = repository();
    const input = { working_directory: root, task_id: task, operation: parseSafeCode("maintenance-inventory"), phase_instance: committedPhase };
    const initial = await createProductionServices(input);
    if (!initial.ok) throw new Error("production setup failed");
    const state: TaskStateV1 = {
      schema_version: "1", task_id: task, repository_identity_digest: initial.value.authority.repository_identity_digest,
      revision: parseSafeInteger(2), phase_instance: committedPhase, step: "produce", status: "running",
      attempt: parseSafeInteger(1), input_fingerprint: D("1"), initialization_digest: D("2"), config_digest: D("3"),
      workflow_digest: D("4"), constitution_digest: D("5"), policy_base_commit: "abcdef0123456789abcdef0123456789abcdef01" as TaskStateV1["policy_base_commit"],
      authoritative_results: [], approvals: [], waivers: [],
    };
    writeFileSync(initial.value.authority.state.absolute, canonicalDocument(state).bytes);
    const staleAttempt = join(initial.value.authority.workspace_root, "diagnostics", "attempts", "phase-impl-14", "attempt-one.json");
    const staleReview = join(initial.value.authority.workspace_root, "cache", "reviews", "prd.counter.md");
    mkdirSync(join(staleAttempt, ".."), { recursive: true });
    mkdirSync(join(staleReview, ".."), { recursive: true });
    writeFileSync(staleAttempt, "attempt\n");
    writeFileSync(staleReview, "review\n");
    const service = await createProductionServices(input);
    if (!service.ok) throw new Error("production restart failed");
    const inspected = await inspectWorkspaceCleanup(service.value.dependencies, service.value.authority, state);
    expect(inspected).toMatchObject({ ok: true, value: { cleanup_pending: true, retained_files: 0 } });
    const cleaned = await cleanTaskWorkspace(service.value.dependencies, service.value.authority, state);
    expect(cleaned).toMatchObject({
      ok: true,
      value: { removed_files: 2, removed_bytes: 15, retained_files: 0, cleanup_pending: false },
    });
    const after = await inspectWorkspaceCleanup(service.value.dependencies, service.value.authority, state);
    expect(after).toMatchObject({ ok: true, value: { cleanup_pending: false, retained_files: 0 } });
  });
});

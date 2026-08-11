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
import { ensurePayloadParent, ensureResultDirectory } from "../../src/state/layout.js";
import { createProductionServices } from "../../src/state/production.js";
import { enumerateMaintenanceCandidates, enumerateMaintenanceRoots } from "../../src/state/maintenance-roots.js";
import { installSnapshot } from "../../src/state/snapshots.js";
import { runLocalCommand } from "../../src/local/commands.js";

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

  it("rehydrates retained payload bytes and a non-empty projection plan", async () => {
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
    const payload = prepared.value.prepared.payloads[0]!;
    const localInstalled = await runLocalCommand({
      command: "snapshot", working_directory: root, task_id: task,
      value: {
        manifest: prepared.value.prepared.manifest.value,
        retained_task_bytes: 0,
        payloads: [{ path: payload.path, bytes_base64: Buffer.from(payload.bytes).toString("base64") }],
      },
    });
    expect(localInstalled, JSON.stringify(localInstalled)).toMatchObject({ ok: true });
    const localRestored = await runLocalCommand({
      command: "restore", working_directory: root, task_id: task,
      value: { result_digest: prepared.value.reference.result_digest, output_path: payload.path },
    });
    expect(localRestored).toMatchObject({ ok: true, value: { state: "present", bytes: Buffer.from(payload.bytes).toString("base64") } });
    await ensureResultDirectory(service.value.authority, prepared.value.reference.result_digest);
    for (const payload of prepared.value.prepared.payloads) {
      await ensurePayloadParent(service.value.authority, prepared.value.reference.result_digest, payload.target.absolute);
    }
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
    const restarted = await createProductionServices(input);
    if (!restarted.ok) throw new Error("production restart failed");
    const retained = await restarted.value.dependencies.load_retained_result!(prepared.value.reference);
    expect(retained.ok).toBe(true);
    if (!retained.ok) return;
    expect(retained.value.prepared.payloads).toHaveLength(1);
    expect(retained.value.projection_plan.entries).toHaveLength(1);
    expect(retained.value.projection_plan.entries[0]?.path).toBe(prepared.value.projection_plan.entries[0]?.path);
    await expect(restarted.value.dependencies.read_retained_task_bytes!()).resolves.toBeGreaterThan(0);
  });

  it("enumerates the exact maintenance roots and admitted candidate set", async () => {
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
    mkdirSync(join(initial.value.authority.task_root, "attempts", committedPhase), { recursive: true });
    writeFileSync(join(initial.value.authority.task_root, "attempts", committedPhase, "attempt-one.json"), "attempt\n");
    const orphanDigest = "f".repeat(64);
    mkdirSync(join(initial.value.authority.task_root, "results", "sha256", orphanDigest, "payload"), { recursive: true });
    writeFileSync(join(initial.value.authority.task_root, "results", "sha256", orphanDigest, "payload", "orphan.txt"), "orphan\n");
    const service = await createProductionServices(input);
    if (!service.ok) throw new Error("production restart failed");
    const maintenanceRoots = await enumerateMaintenanceRoots(service.value.dependencies, service.value.authority);
    expect(maintenanceRoots).toMatchObject({ ok: true, value: { current_state: state, checkpoints: [], resumable_receipts: [], decision_review_evidence: [] } });
    if (!maintenanceRoots.ok) return;
    const candidates = await enumerateMaintenanceCandidates(service.value.dependencies, service.value.authority, maintenanceRoots.value);
    expect(candidates.ok).toBe(true);
    if (!candidates.ok) return;
    expect(candidates.value.map(({ path, category }) => ({ path, category })).sort((a, b) => a.path.localeCompare(b.path))).toEqual([
      { path: `.archflow/tasks/${task}/attempts/${committedPhase}/attempt-one.json`, category: "unreferenced-attempt" },
      { path: `.archflow/tasks/${task}/results/sha256/${orphanDigest}/payload/orphan.txt`, category: "superseded-payload" },
    ].sort((a, b) => a.path.localeCompare(b.path)));
  });
});

import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { canonicalJsonDigest, parseCanonicalDocument, sha256Bytes, type CanonicalDocument } from "../../src/contracts/canonical.js";
import {
  checkpointSelfDigest,
  parseManualCheckpointImport,
  type ManualCheckpointV1,
} from "../../src/contracts/durable-checkpoint.js";
import type { IntentReceiptV1 } from "../../src/contracts/durable-intent.js";
import type { TaskStateV1 } from "../../src/contracts/durable-state.js";
import type { TaskInitializationV1 } from "../../src/contracts/durable-task-initialization.js";
import { computeInputFingerprint, type InputFingerprintSubject } from "../../src/contracts/fingerprints.js";
import { parseToolCall } from "../../src/contracts/mcp-tools.js";
import { createGitRunner, preflightGit, type RepositoryOperationContext } from "../../src/repository/git.js";
import { discoverWorktree } from "../../src/repository/identity.js";
import type { ResolvedTaskPath } from "../../src/repository/paths.js";
import type { AtomicWriter } from "../../src/state/atomic.js";
import { createInternalTransactionAuthority } from "../../src/state/authority.js";
import { runStateInitialization } from "../../src/state/initialization.js";
import { loadManualImportEvidence } from "../../src/state/manual-import.js";
import type { TransactionDependencies } from "../../src/state/transaction.js";

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

const env: NodeJS.ProcessEnv = {
  ...process.env,
  GIT_CONFIG_GLOBAL: "/dev/null",
  GIT_CONFIG_SYSTEM: "/dev/null",
  GIT_AUTHOR_NAME: "ArchFlow Test",
  GIT_AUTHOR_EMAIL: "test@example.invalid",
  GIT_COMMITTER_NAME: "ArchFlow Test",
  GIT_COMMITTER_EMAIL: "test@example.invalid",
};

describe("revision-0 state initialization", () => {
  it("installs one receipt before revision 1 and exact-replays it", async () => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), "archflow-initialization-")));
    roots.push(root);
    execFileSync("git", ["-c", "init.defaultBranch=main", "init", "-q"], { cwd: root, env });
    writeFileSync(join(root, "tracked.txt"), "root\n");
    execFileSync("git", ["add", "--", "tracked.txt"], { cwd: root, env });
    execFileSync("git", ["commit", "-q", "-m", "root"], { cwd: root, env });
    const taskId = "initialization-task" as TaskStateV1["task_id"];
    mkdirSync(join(root, ".archflow", "tasks", taskId), { recursive: true });
    const context: RepositoryOperationContext = {
      task_id: taskId,
      phase_instance: "prd" as TaskStateV1["phase_instance"],
      operation: "initialization-test" as RepositoryOperationContext["operation"],
      attempt: 1 as RepositoryOperationContext["attempt"],
    };
    const initialRunner = createGitRunner({ cwd: root });
    const discovered = await discoverWorktree(initialRunner, context);
    if (!discovered.ok) throw new Error("discovery failed");
    const preflight = await preflightGit(discovered.value, context);
    if (!preflight.ok) throw new Error("preflight failed");
    const authorityResult = await createInternalTransactionAuthority({
      runner: discovered.value, environment: preflight.value, task_id: taskId, context,
    });
    if (!authorityResult.ok) throw new Error("authority failed");
    const authority = authorityResult.value;
    const configBytes = new TextEncoder().encode('schema_version: "1"\nroles: {}\n');
    const subject: InputFingerprintSubject = {
      schema_version: "1",
      workflow_digest: "5".repeat(64) as never,
      config_digest: sha256Bytes(configBytes),
      constitution_digest: "6".repeat(64) as never,
      artifact_identities: [], upstream_identities: [], rubric_digest: "7".repeat(64) as never,
      phase_instance: context.phase_instance, declared_inputs: [],
    };
    const fingerprint = computeInputFingerprint(subject);
    const template = JSON.parse(await readFile(
      new URL("../fixtures/contracts/durable/task-initialization.valid.json", import.meta.url), "utf8",
    )) as TaskInitializationV1;
    const headCommit = execFileSync("git", ["rev-parse", "HEAD"], { cwd: root, env, encoding: "utf8" }).trim() as never;
    const artifact: TaskInitializationV1 = {
      ...template,
      task_id: taskId,
      repository_identity_digest: authority.repository_identity_digest,
      code_baseline_commit: headCommit,
      policy_base_commit: headCommit,
      canonical_paths: {
        task_root: `.archflow/tasks/${taskId}` as never,
        config: `.archflow/tasks/${taskId}/config.yaml` as never,
        state: `.archflow/tasks/${taskId}/state.json` as never,
        workflow: ".archflow/workflow.yaml" as never,
        constitution_root: ".archflow/constitution" as never,
      },
      config_digest: subject.config_digest,
      workflow_digest: subject.workflow_digest,
      constitution_digest: subject.constitution_digest,
    };
    const call = parseToolCall("archflow_state", {
      schema_version: "1", task_id: taskId, intent_id: "initialize-task", expected_revision: 0,
      input_fingerprint: fingerprint, phase_instance: context.phase_instance,
      step: "produce", status: "running", artifact,
    });

    let state: CanonicalDocument<TaskStateV1> | undefined;
    let receipt: CanonicalDocument<IntentReceiptV1> | undefined;
    const events: string[] = [];
    const atomic: AtomicWriter = {
      createExclusive: async (_path, bytes) => {
        events.push("receipt");
        if (receipt !== undefined) return "exists";
        receipt = parseCanonicalDocument<IntentReceiptV1>(bytes);
        return "created";
      },
      replace: async (_path, bytes) => {
        events.push("state");
        state = parseCanonicalDocument<TaskStateV1>(bytes);
      },
      removeGateInterface: async () => undefined,
    };
    const dependencies: TransactionDependencies = {
      runner: discovered.value,
      environment: preflight.value,
      atomic,
      lock: { runExclusive: async <T>(_root: ResolvedTaskPath, work: () => Promise<T>) => work() },
      resolve_input_fingerprint: async () => ({ schema_version: "1", ok: true, value: subject }),
      read_state: async () => state === undefined ? { kind: "missing" } : { kind: "canonical", document: state },
      read_config: async () => ({ kind: "valid", snapshot: { bytes: configBytes, digest: subject.config_digest } }),
      read_receipt: async () => receipt === undefined ? { kind: "missing" } : { kind: "canonical", document: receipt },
    };

    const first = await runStateInitialization(dependencies, { authority, call });
    expect(first.ok).toBe(true);
    if (!first.ok) return;
    expect(first.value.state.value.revision).toBe(1);
    expect(first.value.replayed).toBe(false);
    expect(events).toEqual(["receipt", "state"]);

    const replayed = await runStateInitialization(dependencies, { authority, call });
    expect(replayed.ok).toBe(true);
    if (replayed.ok) expect(replayed.value.replayed).toBe(true);
    expect(events).toEqual(["receipt", "state"]);

    // Revision-0 manual adoption replays the same transition kernel. A retry may increment
    // the phase-instance attempt, but the next step must carry it rather than reset to 1.
    state = undefined;
    receipt = undefined;
    events.length = 0;
    const initializationDigest = canonicalJsonDigest(artifact);
    const common = {
      schema_version: "1" as const,
      task_id: taskId,
      repository_identity_digest: authority.repository_identity_digest,
      phase_instance: context.phase_instance,
      input_fingerprint: fingerprint,
      assurance: "degraded" as const,
      initialization_digest: initializationDigest,
      authoritative_results: [],
      projections: [],
      evidence_chain: [],
      approvals: [],
      waivers: [],
    };
    const firstCheckpoint = {
      ...common, revision: 1 as const, step: "produce" as const, status: "running" as const,
      attempt: 1 as never, initialization: artifact,
    } as ManualCheckpointV1;
    const continued = (
      prior: ManualCheckpointV1,
      revision: number,
      step: ManualCheckpointV1["step"],
      status: ManualCheckpointV1["status"],
      attempt: number,
      authoritative_results: ManualCheckpointV1["authoritative_results"] = [],
    ): ManualCheckpointV1 => ({
      ...common,
      revision: revision as never,
      step,
      status,
      attempt: attempt as never,
      authoritative_results,
      predecessor: {
        revision: prior.revision,
        checkpoint_digest: checkpointSelfDigest(prior),
      },
    } as ManualCheckpointV1);
    const failed = continued(firstCheckpoint, 2, "produce", "failed", 1);
    const retried = continued(failed, 3, "produce", "running", 2);
    const succeeded = continued(retried, 4, "produce", "succeeded", 2);
    const reset = continued(succeeded, 5, "self_review", "running", 1);
    const manual = parseManualCheckpointImport({
      schema_version: "1",
      artifact_kind: "manual-checkpoint-import",
      task_id: taskId,
      repository_identity_digest: authority.repository_identity_digest,
      import_mode: "initial",
      chain: [firstCheckpoint, failed, retried, succeeded, reset],
    });
    const resetCall = parseToolCall("archflow_state", {
      schema_version: "1", task_id: taskId, intent_id: "initial-attempt-reset",
      expected_revision: 0, input_fingerprint: fingerprint,
      phase_instance: reset.phase_instance, step: reset.step, status: reset.status,
      artifact: manual,
    });
    const evidenceDependencies = {
      ...dependencies,
      load_retained_result: async () => { throw new Error("result loader must not be called for an empty chain"); },
    };
    const evidence = await loadManualImportEvidence({
      dependencies: evidenceDependencies,
      authority,
      artifact: manual,
    });
    expect(evidence.ok).toBe(true);
    if (!evidence.ok) return;
    const rejected = await runStateInitialization(
      evidenceDependencies,
      { authority, call: resetCall },
      evidence.value,
    );
    expect(rejected.ok).toBe(false);
    if (!rejected.ok) expect(rejected.error.code).toBe("TRANSITION_INVALID");
    expect(events).toEqual([]);

    // A hand-authored abandoned head cannot be imported through the archflow_state
    // revision-0 path, either as authenticated evidence or directly at the reducer boundary.
    const abandoned = {
      ...reset,
      revision: 6 as never,
      predecessor: { revision: reset.revision, checkpoint_digest: checkpointSelfDigest(reset) },
      terminal: "abandoned" as const,
    } as ManualCheckpointV1;
    const abandonedImport = parseManualCheckpointImport({
      schema_version: "1",
      artifact_kind: "manual-checkpoint-import",
      task_id: taskId,
      repository_identity_digest: authority.repository_identity_digest,
      import_mode: "initial",
      chain: [firstCheckpoint, failed, retried, succeeded, reset, abandoned],
    });
    const abandonedCall = parseToolCall("archflow_state", {
      schema_version: "1", task_id: taskId, intent_id: "reject-abandoned-import",
      expected_revision: 0, input_fingerprint: abandoned.input_fingerprint,
      phase_instance: abandoned.phase_instance, step: abandoned.step, status: abandoned.status,
      artifact: abandonedImport,
    });
    const abandonedEvidence = await loadManualImportEvidence({
      dependencies: evidenceDependencies,
      authority,
      artifact: abandonedImport,
    });
    expect(abandonedEvidence).toMatchObject({ ok: false, error: { code: "STATE_INVALID" } });
    const directImport = await runStateInitialization(
      evidenceDependencies,
      { authority, call: abandonedCall },
    );
    expect(directImport).toMatchObject({ ok: false, error: { code: "CONTRACT_INVALID" } });
    if (!directImport.ok) {
      expect(directImport.error.diagnostic.parameters).toMatchObject({
        issue_code: "manual-import-abandoned-authority-unauthenticated",
      });
    }
    expect(events).toEqual([]);

    // Task initialization must enter the workflow at prd/produce/running; any other
    // combination would write a revision-1 state no transition could have produced.
    const entryPointMismatches = [
      { intent_id: "wrong-phase", phase_instance: "design", step: "produce", status: "running" },
      { intent_id: "wrong-step", phase_instance: "prd", step: "self_review", status: "running" },
      { intent_id: "wrong-status", phase_instance: "prd", step: "produce", status: "succeeded" },
    ] as const;
    for (const mismatch of entryPointMismatches) {
      const mismatchCall = parseToolCall("archflow_state", {
        schema_version: "1", task_id: taskId, intent_id: mismatch.intent_id,
        expected_revision: 0, input_fingerprint: fingerprint,
        phase_instance: mismatch.phase_instance, step: mismatch.step, status: mismatch.status,
        artifact,
      });
      const outcome = await runStateInitialization(dependencies, { authority, call: mismatchCall });
      expect(outcome).toMatchObject({ ok: false, error: { code: "CONTRACT_INVALID" } });
      if (!outcome.ok) {
        expect(outcome.error.diagnostic.parameters).toMatchObject({
          issue_code: "initialization-entry-point-mismatch",
        });
      }
    }
    expect(events).toEqual([]);
  });
});

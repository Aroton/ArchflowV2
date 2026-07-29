import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { parseCanonicalDocument, sha256Bytes, type CanonicalDocument } from "../../src/contracts/canonical.js";
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
  });
});

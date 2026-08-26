import { mkdirSync, writeFileSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { join } from "node:path";

import { afterAll, describe, expect, it } from "vitest";

import { parseCanonicalDocument, sha256Bytes, type CanonicalDocument } from "../../src/contracts/canonical.js";
import { parseConfigYaml, type TaskConfigSnapshot } from "../../src/contracts/config.js";
import type { IntentReceiptV1 } from "../../src/contracts/durable-intent.js";
import type { TaskStateV1 } from "../../src/contracts/durable-state.js";
import type { TaskInitializationV1 } from "../../src/contracts/durable-task-initialization.js";
import { computeInputFingerprint, type InputFingerprintSubject } from "../../src/contracts/fingerprints.js";
import { parseToolCall } from "../../src/contracts/mcp-tools.js";
import { createGitRunner, preflightGit, type RepositoryOperationContext } from "../../src/repository/git.js";
import { discoverWorktree } from "../../src/repository/identity.js";
import type { ResolvedTaskWorkspacePath } from "../../src/repository/paths.js";
import type { AtomicWriter } from "../../src/state/atomic.js";
import { createInternalTransactionAuthority } from "../../src/state/authority.js";
import { runStateInitialization } from "../../src/state/initialization.js";
import type { TransactionDependencies } from "../../src/state/transaction.js";
import { cleanupTemporaryRepositories, createTempRepository } from "../helpers/temp-repository.js";

afterAll(cleanupTemporaryRepositories);

describe("revision-0 state initialization", () => {
  it("installs one receipt before revision 1 and exact-replays it", async () => {
    const primary = createTempRepository({ label: "initialization", attributes: undefined });
    primary.write("tracked.txt", "root\n");
    primary.commitAll("root");
    const root = primary.path;
    const secondary = createTempRepository({ label: "initialization-secondary", attributes: undefined });
    secondary.write("tracked.txt", "secondary root\n");
    secondary.commitAll("secondary root");
    const secondaryRoot = secondary.path;
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
    let configBytes = new TextEncoder().encode([
      'schema_version: "1"',
      "roles: {}",
      "repositories:",
      "  apis:",
      `    path: ${JSON.stringify(secondaryRoot)}`,
      "",
    ].join("\n"));
    const configDigest = sha256Bytes(configBytes);
    const subject: InputFingerprintSubject = {
      schema_version: "1",
      workflow_digest: "5".repeat(64) as never,
      constitution_digest: "6".repeat(64) as never,
      artifact_identities: [], upstream_identities: [], rubric_digest: "7".repeat(64) as never,
      phase_instance: context.phase_instance, declared_inputs: [],
    };
    const fingerprint = computeInputFingerprint(subject);
    const template = JSON.parse(await readFile(
      new URL("../fixtures/contracts/durable/task-initialization.valid.json", import.meta.url), "utf8",
    )) as TaskInitializationV1;
    const headCommit = primary.git("rev-parse", "HEAD") as never;
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
      config_digest: configDigest,
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
      createExclusive: async (path, bytes) => {
        if (path.path_class === "authority-initialization") {
          events.push("initialization");
          writeFileSync(path.absolute, bytes);
          return "created";
        }
        events.push("receipt");
        if (receipt !== undefined) return "exists";
        receipt = parseCanonicalDocument<IntentReceiptV1>(bytes);
        return "created";
      },
      replace: async (_path, bytes) => {
        events.push("state");
        state = parseCanonicalDocument<TaskStateV1>(bytes);
      },
      replaceTaskAsk: async () => { throw new TypeError("unexpected task ask replacement"); },
      removeGateInterface: async () => undefined,
    };
    const dependencies: TransactionDependencies = {
      runner: discovered.value,
      environment: preflight.value,
      atomic,
      lock: { runExclusive: async <T>(_root: ResolvedTaskWorkspacePath, work: () => Promise<T>) => work() },
      resolve_input_fingerprint: async () => ({ schema_version: "1", ok: true, value: { subject, fingerprint } }),
      read_state: async () => state === undefined ? { kind: "missing" } : { kind: "canonical", document: state },
      read_config: async () => ({
        kind: "valid",
        snapshot: { bytes: configBytes, digest: configDigest, parsed: parseConfigYaml(new TextDecoder().decode(configBytes), "task config") as TaskConfigSnapshot },
      }),
      read_receipt: async () => receipt === undefined ? { kind: "missing" } : { kind: "canonical", document: receipt },
    };

    const first = await runStateInitialization(dependencies, { authority, call });
    expect(first.ok).toBe(true);
    if (!first.ok) return;
    expect(first.value.state.value.revision).toBe(1);
    expect(first.value.replayed).toBe(false);
    expect(first.value.state.value.last_seen_config?.repositories).toEqual({
      apis: { path: secondaryRoot },
    });
    expect(first.value.state.value.last_seen_repository_bindings?.map((entry) => ({
      name: entry.name,
      declared_path: entry.declared_path,
    }))).toEqual([
      { name: "primary", declared_path: undefined },
      { name: "apis", declared_path: secondaryRoot },
    ]);
    expect(events).toEqual(["initialization", "receipt", "state"]);

    const replayed = await runStateInitialization(dependencies, { authority, call });
    expect(replayed.ok).toBe(true);
    if (replayed.ok) expect(replayed.value.replayed).toBe(true);
    expect(events).toEqual(["initialization", "receipt", "state"]);
    state = undefined;
    receipt = undefined;
    events.length = 0;

    // Task initialization must enter the workflow at prd/produce/running; any other
    // combination would write a revision-1 state no transition could have produced.
    const entryPointMismatches = [
      { intent_id: "wrong-phase", phase_instance: "design", step: "produce", status: "running" },
      { intent_id: "wrong-step", phase_instance: "prd", step: "counter_review", status: "running" },
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

    configBytes = new TextEncoder().encode([
      'schema_version: "1"',
      "roles: {}",
      "repositories:",
      "  missing-member:",
      `    path: ${JSON.stringify(join(secondaryRoot, "does-not-exist"))}`,
      "",
    ].join("\n"));
    const invalidCall = parseToolCall("archflow_state", {
      schema_version: "1",
      task_id: taskId,
      intent_id: "invalid-initial-secondary",
      expected_revision: 0,
      input_fingerprint: fingerprint,
      phase_instance: "prd",
      step: "produce",
      status: "running",
      artifact,
    });
    const invalid = await runStateInitialization(dependencies, { authority, call: invalidCall });
    expect(invalid).toMatchObject({
      ok: false,
      error: {
        code: "CONFIG_INVALID",
        diagnostic: { parameters: { issues: [expect.stringContaining("repositories.missing-member.path")] } },
      },
    });
    expect(events).toEqual([]);
    expect(state).toBeUndefined();
    expect(receipt).toBeUndefined();
  });
});

import { execFileSync, spawn, type ChildProcess } from "node:child_process";
import { mkdir, mkdtemp, readFile, readdir, rm, rmdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { canonicalJsonBytes, canonicalJsonDigest, sha256Bytes } from "../../src/contracts/canonical.js";
import type { TaskStateV1 } from "../../src/contracts/durable-state.js";
import { computeInputFingerprint, computeRequestDigest, type InputFingerprintSubject } from "../../src/contracts/fingerprints.js";
import {
  createInternalResultExpectation,
  parseToolCall,
  validateProjectResultStructure,
  type ParsedToolCall,
} from "../../src/contracts/mcp-tools.js";
import { parseTaskPathClaim } from "../../src/contracts/path-claims.js";
import { createGitRunner, preflightGit, type RepositoryOperationContext } from "../../src/repository/git.js";
import { discoverWorktree } from "../../src/repository/identity.js";
import { createAtomicWriter, type AtomicWriter } from "../../src/state/atomic.js";
import { createInternalTransactionAuthority, type TransactionAuthority } from "../../src/state/authority.js";
import { createTaskLock } from "../../src/state/lock.js";
import { planAbandonedLockRepair, repairAbandonedLock } from "../../src/state/repair.js";
import { readIntentReceipt, readTaskConfig, readTaskState } from "../../src/state/read.js";
import {
  runStateTransaction,
  type PreparedTransaction,
  type TransactionDependencies,
} from "../../src/state/transaction.js";

const roots: string[] = [];
const children = new Set<ChildProcess>();
const childProgram = new URL("../fixtures/state-transaction-child.mjs", import.meta.url);
const gitEnvironment: NodeJS.ProcessEnv = {
  ...process.env,
  GIT_CONFIG_GLOBAL: "/dev/null",
  GIT_CONFIG_SYSTEM: "/dev/null",
  GIT_AUTHOR_NAME: "ArchFlow Test",
  GIT_AUTHOR_EMAIL: "test@example.invalid",
  GIT_COMMITTER_NAME: "ArchFlow Test",
  GIT_COMMITTER_EMAIL: "test@example.invalid",
};

afterEach(async () => {
  for (const child of children) {
    if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
  }
  children.clear();
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

type Fixture = Readonly<{
  repository: string;
  taskRoot: string;
  authority: TransactionAuthority;
  dependencies: TransactionDependencies;
  call: Extract<ParsedToolCall, { name: "archflow_state" }>;
  prepare: () => Readonly<{
    callback: Parameters<typeof runStateTransaction<"archflow_state">>[2];
    calls: () => number;
  }>;
}>;

async function fixture(): Promise<Fixture> {
  const repository = await mkdtemp(join(tmpdir(), "archflow-transaction-crash-"));
  roots.push(repository);
  execFileSync("git", ["-c", "init.defaultBranch=main", "init", "-q"], { cwd: repository, env: gitEnvironment });
  await writeFile(join(repository, "tracked.txt"), "root\n");
  execFileSync("git", ["add", "--", "tracked.txt"], { cwd: repository, env: gitEnvironment });
  execFileSync("git", ["commit", "-q", "-m", "root"], { cwd: repository, env: gitEnvironment });
  const policyBaseCommit = execFileSync("git", ["rev-parse", "HEAD"], {
    cwd: repository,
    env: gitEnvironment,
    encoding: "utf8",
  }).trim();
  const taskId = "crash-task" as RepositoryOperationContext["task_id"];
  const taskRoot = join(repository, ".archflow", "tasks", taskId);
  await mkdir(taskRoot, { recursive: true });
  const context: RepositoryOperationContext = {
    task_id: taskId,
    phase_instance: "phase-impl-9" as RepositoryOperationContext["phase_instance"],
    operation: "transaction-crash" as RepositoryOperationContext["operation"],
    attempt: 1 as RepositoryOperationContext["attempt"],
  };
  const initialRunner = createGitRunner({ cwd: repository });
  const environment = await preflightGit(initialRunner, context);
  const discovered = await discoverWorktree(initialRunner, context);
  if (!environment.ok || !discovered.ok) throw new Error("repository fixture discovery failed");
  const authorityResult = await createInternalTransactionAuthority({
    runner: discovered.value,
    environment: environment.value,
    task_id: taskId,
    context,
  });
  if (!authorityResult.ok) throw new Error("transaction authority fixture failed");
  const authority = authorityResult.value;
  const configBytes = new TextEncoder().encode('schema_version: "1"\nroles: {}\n');
  const subject: InputFingerprintSubject = {
    schema_version: "1",
    workflow_digest: "a".repeat(64) as InputFingerprintSubject["workflow_digest"],
    config_digest: sha256Bytes(configBytes),
    constitution_digest: "b".repeat(64) as InputFingerprintSubject["constitution_digest"],
    artifact_identities: [],
    upstream_identities: [],
    rubric_digest: canonicalJsonDigest({}),
    phase_instance: context.phase_instance,
    declared_inputs: [],
  };
  const inputFingerprint = computeInputFingerprint(subject);
  const state: TaskStateV1 = {
    schema_version: "1",
    task_id: taskId,
    repository_identity_digest: authority.repository_identity_digest,
    revision: 1 as TaskStateV1["revision"],
    phase_instance: context.phase_instance,
    step: "produce",
    status: "running",
    attempt: 1 as TaskStateV1["attempt"],
    input_fingerprint: inputFingerprint,
    initialization_digest: "c".repeat(64) as TaskStateV1["initialization_digest"],
    config_digest: subject.config_digest,
    workflow_digest: subject.workflow_digest,
    constitution_digest: subject.constitution_digest,
    policy_base_commit: policyBaseCommit as TaskStateV1["policy_base_commit"],
    authoritative_results: [],
    approvals: [],
    waivers: [],
  };
  await Promise.all([
    writeFile(join(taskRoot, "config.yaml"), configBytes),
    writeFile(join(taskRoot, "state.json"), canonicalJsonBytes(state)),
  ]);
  const call = parseToolCall("archflow_state", {
    schema_version: "1",
    task_id: taskId,
    intent_id: "crash-intent",
    expected_revision: 1,
    input_fingerprint: inputFingerprint,
    phase_instance: context.phase_instance,
    step: "produce",
    status: "succeeded",
  });
  const requestDigest = computeRequestDigest({
    schema_version: "1",
    tool: "archflow_state",
    repository_identity_digest: authority.repository_identity_digest,
    task_identity_digest: authority.task_identity_digest,
    operation: "record-state-boundary",
    operation_fields: { phase_instance: context.phase_instance, step: "produce", status: "succeeded" },
    input_fingerprint: inputFingerprint,
  });
  const dependencies: TransactionDependencies = {
    runner: discovered.value,
    environment: environment.value,
    atomic: createAtomicWriter(),
    lock: createTaskLock(),
    resolve_input_fingerprint: async () => ({ schema_version: "1", ok: true, value: subject }),
    read_state: readTaskState,
    read_config: readTaskConfig,
    read_receipt: readIntentReceipt,
  };
  const prepare = () => {
    let calls = 0;
    const callback: Parameters<typeof runStateTransaction<"archflow_state">>[2] = async (current) => {
      calls += 1;
      const { revision: _revision, committed_intent: _committedIntent, ...nextState } = current.value;
      const success = {
        path: parseTaskPathClaim("state.json"),
        revision: (current.value.revision + 1) as TaskStateV1["revision"],
        status: "succeeded" as const,
      };
      const value: PreparedTransaction<"archflow_state"> = {
        expectation: createInternalResultExpectation({
          schema_version: "1",
          tool: "archflow_state",
          task_id: taskId,
          intent_id: call.input.intent_id,
          input_fingerprint: inputFingerprint,
          request_digest: requestDigest,
          result_id: "result-crash-intent",
          resulting_revision: success.revision,
          success,
        }),
        result: validateProjectResultStructure(call, { schema_version: "1", ok: true, value: success }),
        next_state: { ...nextState, status: "succeeded" },
      };
      return { schema_version: "1", ok: true, value };
    };
    return { callback, calls: () => calls };
  };
  return { repository, taskRoot, authority, dependencies, call, prepare };
}

async function run(
  input: Fixture,
  atomic: AtomicWriter,
  prepare = input.prepare(),
  call: Extract<ParsedToolCall, { name: "archflow_state" }> = input.call,
) {
  const result = await runStateTransaction(
    { ...input.dependencies, atomic },
    { call, authority: input.authority },
    prepare.callback,
  );
  return { result, prepare };
}

type CrashCutPoint = "receipt-temp" | "receipt-link" | "state-replace-before" | "state-replace-after" |
  "result-payload-link" | "result-manifest-link";

function startCrashChild(input: Fixture, cutPoint: CrashCutPoint): ChildProcess {
  const child = spawn(process.execPath, [
    childProgram.pathname,
    "run-crash-transaction",
    input.taskRoot,
    input.call.input.intent_id,
    String(input.call.input.expected_revision),
    cutPoint,
  ], {
    cwd: process.cwd(),
    stdio: ["ignore", "pipe", "pipe", "ipc"],
  });
  children.add(child);
  return child;
}

function startResultChild(input: Fixture, action: "run-result-transaction" | "run-crash-result-transaction", cutPoint?: CrashCutPoint): ChildProcess {
  const child = spawn(process.execPath, [
    childProgram.pathname, action, input.taskRoot, input.call.input.intent_id,
    String(input.call.input.expected_revision), ...(cutPoint === undefined ? [] : [cutPoint]),
  ], { cwd: process.cwd(), stdio: ["ignore", "pipe", "pipe", "ipc"] });
  children.add(child);
  return child;
}

async function killAtRealCut(input: Fixture, cutPoint: CrashCutPoint): Promise<Record<string, unknown>> {
  const child = startCrashChild(input, cutPoint);
  const event = await childEvent(child, "cut");
  await new Promise<void>((resolve, reject) => {
    if (child.exitCode !== null || child.signalCode !== null) {
      if (child.signalCode === "SIGKILL") resolve();
      else reject(new Error(`crash child exited unexpectedly: ${String(child.exitCode)}/${String(child.signalCode)}`));
      return;
    }
    child.once("exit", (code, signal) => {
      if (signal === "SIGKILL") resolve();
      else reject(new Error(`crash child exited unexpectedly: ${String(code)}/${String(signal)}`));
    });
  });
  expect(event).toMatchObject({ type: "cut", point: cutPoint });
  return event;
}

async function clearAbandonedLock(input: Fixture): Promise<void> {
  const lockPath = join(input.taskRoot, ".transaction-lock");
  expect(await readdir(input.taskRoot)).toContain(".transaction-lock");
  await rmdir(lockPath);
}

function startLockChild(taskRoot: string): ChildProcess {
  const child = spawn(process.execPath, [childProgram.pathname, "hold-lock", taskRoot], {
    cwd: process.cwd(),
    stdio: ["ignore", "pipe", "pipe", "ipc"],
  });
  children.add(child);
  return child;
}

function childEvent(child: ChildProcess, type: "entered" | "failed" | "cut" | "result"): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => finish(new Error(`timed out waiting for ${type}`)), 5_000);
    const onMessage = (message: unknown): void => {
      if ((message as { type?: unknown }).type === type) finish(undefined, message as Record<string, unknown>);
    };
    const onExit = (code: number | null, signal: NodeJS.Signals | null): void => {
      finish(new Error(`child exited before ${type}: ${String(code)}/${String(signal)}`));
    };
    const finish = (error?: Error, value?: Record<string, unknown>): void => {
      clearTimeout(timeout);
      child.off("message", onMessage);
      child.off("exit", onExit);
      if (error !== undefined) reject(error);
      else resolve(value!);
    };
    child.on("message", onMessage);
    child.once("exit", onExit);
  });
}

describe("state transaction crash boundaries", () => {
  it("leaves result bytes non-authoritative after a manifest cut and safely retries the exact installation", async () => {
    const input = await fixture();
    const killed = startResultChild(input, "run-crash-result-transaction", "result-manifest-link");
    const cut = await childEvent(killed, "cut");
    await new Promise<void>((resolve) => killed.once("exit", () => resolve()));
    expect(cut).toMatchObject({ point: "result-manifest-link" });
    expect(await readFile(String(cut.path))).not.toHaveLength(0);
    expect((await readTaskState(input.authority.state))).toMatchObject({
      kind: "canonical", document: { value: { revision: 1, authoritative_results: [] } },
    });
    await clearAbandonedLock(input);
    const retry = startResultChild(input, "run-result-transaction");
    const result = await childEvent(retry, "result");
    expect(result).toMatchObject({ ok: true, revision: 2, replayed: false, prepareCalls: 1 });
    expect((await readTaskState(input.authority.state))).toMatchObject({
      kind: "canonical", document: { value: { revision: 2, authoritative_results: [{ result_id: "result-crash-intent" }] } },
    });
  });

  it("resumes a result receipt after SIGKILL without invoking preparation", async () => {
    const input = await fixture();
    const killed = startResultChild(input, "run-crash-result-transaction", "receipt-link");
    await childEvent(killed, "cut");
    await new Promise<void>((resolve) => killed.once("exit", () => resolve()));
    expect((await readTaskState(input.authority.state))).toMatchObject({ kind: "canonical", document: { value: { revision: 1 } } });
    await clearAbandonedLock(input);
    const retry = startResultChild(input, "run-result-transaction");
    const result = await childEvent(retry, "result");
    expect(result).toMatchObject({ ok: true, revision: 2, replayed: false, prepareCalls: 0 });
  });

  it("survives SIGKILL after receipt temp sync and safely prepares again", async () => {
    const input = await fixture();
    const cut = await killAtRealCut(input, "receipt-temp");
    const abandoned = String(cut.path);
    expect(await readFile(abandoned)).not.toHaveLength(0);
    expect(await readdir(join(input.taskRoot, "intents"))).not.toContain("crash-intent.json");
    expect((await readTaskState(input.authority.state))).toMatchObject({
      kind: "canonical",
      document: { value: { revision: 1 } },
    });
    await clearAbandonedLock(input);

    const attempt = await run(input, createAtomicWriter());
    expect(attempt.result).toMatchObject({ ok: true, value: { replayed: false } });
    expect(attempt.prepare.calls()).toBe(1);
    expect(await readFile(abandoned)).not.toHaveLength(0);
  });

  it("survives SIGKILL after receipt link and resumes without preparing again", async () => {
    const input = await fixture();
    const cut = await killAtRealCut(input, "receipt-link");
    expect(await readFile(String(cut.path))).not.toHaveLength(0);
    expect(await readFile(join(input.taskRoot, "intents", "crash-intent.json"))).not.toHaveLength(0);
    expect((await readTaskState(input.authority.state))).toMatchObject({
      kind: "canonical",
      document: { value: { revision: 1 } },
    });
    await clearAbandonedLock(input);

    const restart = await run(input, createAtomicWriter());
    expect(restart.result).toMatchObject({ ok: true, value: { replayed: false, state: { value: { revision: 2 } } } });
    expect(restart.prepare.calls()).toBe(0);
  });

  it("survives SIGKILL before state replacement and resumes the installed receipt", async () => {
    const input = await fixture();
    const cut = await killAtRealCut(input, "state-replace-before");
    expect(await readFile(String(cut.path))).not.toHaveLength(0);
    expect(await readFile(join(input.taskRoot, "intents", "crash-intent.json"))).not.toHaveLength(0);
    expect((await readTaskState(input.authority.state))).toMatchObject({
      kind: "canonical",
      document: { value: { revision: 1 } },
    });
    await clearAbandonedLock(input);

    const restart = await run(input, createAtomicWriter());
    expect(restart.result).toMatchObject({ ok: true, value: { replayed: false, state: { value: { revision: 2 } } } });
    expect(restart.prepare.calls()).toBe(0);
  });

  it("survives SIGKILL after state replacement and authenticates exact replay", async () => {
    const input = await fixture();
    await killAtRealCut(input, "state-replace-after");
    expect(await readFile(join(input.taskRoot, "intents", "crash-intent.json"))).not.toHaveLength(0);
    expect((await readTaskState(input.authority.state))).toMatchObject({
      kind: "canonical",
      document: { value: { revision: 2, committed_intent: { intent_id: "crash-intent" } } },
    });
    await clearAbandonedLock(input);

    const retryCall = parseToolCall("archflow_state", { ...input.call.input, expected_revision: 2 });
    const restart = await run(input, createAtomicWriter(), input.prepare(), retryCall);
    expect(restart.result).toMatchObject({
      ok: true,
      value: { replayed: true, state: { value: { revision: 2 } } },
    });
    expect(restart.prepare.calls()).toBe(0);
  });

  it("leaves a SIGKILL-abandoned lock blocking until exact explicit confirmed repair", async () => {
    const input = await fixture();
    const killed = startLockChild(input.taskRoot);
    await childEvent(killed, "entered");
    expect(killed.kill("SIGKILL")).toBe(true);
    await new Promise<void>((resolve) => killed.once("exit", () => resolve()));
    expect(await readdir(input.taskRoot)).toContain(".transaction-lock");

    const blocked = startLockChild(input.taskRoot);
    expect(await childEvent(blocked, "failed")).toMatchObject({ name: "TaskLockError", stage: "acquire" });
    const repair = await planAbandonedLockRepair(input.authority);
    await repairAbandonedLock(input.authority, repair, true);

    const repaired = startLockChild(input.taskRoot);
    await childEvent(repaired, "entered");
    repaired.send?.({ type: "release" });
  });

  it("keeps crash controls out of shipped state modules", async () => {
    const sourceFiles = ["atomic.ts", "lock.ts", "transaction.ts"];
    const source = (await Promise.all(sourceFiles.map((name) =>
      readFile(new URL(`../../src/state/${name}`, import.meta.url), "utf8")
    ))).join("\n");
    expect(source).not.toMatch(/process\.env|ARCHFLOW[_-].*(?:FAULT|CUT)|fault[_-]?hook/iu);
    const bundle = await readFile(new URL("../../dist/archflow-mcp.mjs", import.meta.url), "utf8");
    expect(bundle).not.toMatch(/run-crash-transaction|receipt-temp|receipt-link|state-replace-before|state-replace-after/u);
  });
});

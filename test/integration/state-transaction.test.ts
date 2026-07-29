import { execFileSync, spawn, type ChildProcess } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { canonicalJsonBytes, canonicalJsonDigest, sha256Bytes } from "../../src/contracts/canonical.js";
import type { TaskStateV1 } from "../../src/contracts/durable-state.js";
import { computeInputFingerprint, type InputFingerprintSubject } from "../../src/contracts/fingerprints.js";
import { createGitRunner, preflightGit, type RepositoryOperationContext } from "../../src/repository/git.js";
import { discoverWorktree } from "../../src/repository/identity.js";
import { createInternalTransactionAuthority } from "../../src/state/authority.js";

type ChildEvent =
  | Readonly<{ type: "entered" | "released"; pid: number }>
  | Readonly<{ type: "failed"; name: string; stage?: string }>
  | Readonly<{
      type: "result";
      ok: boolean;
      code?: string;
      revision?: number;
      replayed?: boolean;
      prepareCalls: number;
    }>;

const childProgram = new URL("../fixtures/state-transaction-child.mjs", import.meta.url);
const roots: string[] = [];
const children = new Set<ChildProcess>();

afterEach(async () => {
  for (const child of children) {
    if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
  }
  children.clear();
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function taskRoot(taskId: string): Promise<string> {
  const repository = await mkdtemp(join(tmpdir(), "archflow-transaction-process-"));
  roots.push(repository);
  const root = join(repository, ".archflow", "tasks", taskId);
  await mkdir(root, { recursive: true });
  return root;
}

const gitEnvironment: NodeJS.ProcessEnv = {
  ...process.env,
  GIT_CONFIG_GLOBAL: "/dev/null",
  GIT_CONFIG_SYSTEM: "/dev/null",
  GIT_AUTHOR_NAME: "ArchFlow Test",
  GIT_AUTHOR_EMAIL: "test@example.invalid",
  GIT_COMMITTER_NAME: "ArchFlow Test",
  GIT_COMMITTER_EMAIL: "test@example.invalid",
};

async function transactionRepository(taskIds: readonly string[]): Promise<Readonly<{
  repository: string;
  taskRoots: Readonly<Record<string, string>>;
}>> {
  const repository = await mkdtemp(join(tmpdir(), "archflow-transaction-repository-"));
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
  const taskRoots: Record<string, string> = {};
  for (const taskId of taskIds) {
    const taskRoot = join(repository, ".archflow", "tasks", taskId);
    taskRoots[taskId] = taskRoot;
    await mkdir(taskRoot, { recursive: true });
    const context: RepositoryOperationContext = {
      task_id: taskId as RepositoryOperationContext["task_id"],
      phase_instance: "phase-impl-9" as RepositoryOperationContext["phase_instance"],
      operation: "transaction-integration" as RepositoryOperationContext["operation"],
      attempt: 1 as RepositoryOperationContext["attempt"],
    };
    const initialRunner = createGitRunner({ cwd: repository });
    const environment = await preflightGit(initialRunner, context);
    const discovered = await discoverWorktree(initialRunner, context);
    if (!environment.ok || !discovered.ok) throw new Error("repository fixture discovery failed");
    const authority = await createInternalTransactionAuthority({
      runner: discovered.value,
      environment: environment.value,
      task_id: context.task_id,
      context,
    });
    if (!authority.ok) throw new Error("repository fixture authority failed");
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
    const state: TaskStateV1 = {
      schema_version: "1",
      task_id: context.task_id,
      repository_identity_digest: authority.value.repository_identity_digest,
      revision: 1 as TaskStateV1["revision"],
      phase_instance: context.phase_instance,
      step: "produce",
      status: "running",
      attempt: 1 as TaskStateV1["attempt"],
      input_fingerprint: computeInputFingerprint(subject),
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
  }
  return { repository, taskRoots };
}

function startLockChild(root: string): ChildProcess {
  const child = spawn(process.execPath, [childProgram.pathname, "hold-lock", root], {
    cwd: process.cwd(),
    stdio: ["ignore", "pipe", "pipe", "ipc"],
  });
  children.add(child);
  return child;
}

function startTransactionChild(root: string, intentId: string, expectedRevision: number): ChildProcess {
  const child = spawn(process.execPath, [
    childProgram.pathname,
    "run-transaction",
    root,
    intentId,
    String(expectedRevision),
  ], {
    cwd: process.cwd(),
    stdio: ["ignore", "pipe", "pipe", "ipc"],
  });
  children.add(child);
  return child;
}

function waitForEvent(child: ChildProcess, type: ChildEvent["type"]): Promise<ChildEvent> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => finish(new Error(`timed out waiting for child ${type}`)), 5_000);
    const stderr: Buffer[] = [];
    const onStderr = (chunk: Buffer): void => { stderr.push(Buffer.from(chunk)); };
    const onMessage = (message: unknown): void => {
      if ((message as ChildEvent | undefined)?.type === type) finish(undefined, message as ChildEvent);
    };
    const onExit = (code: number | null, signal: NodeJS.Signals | null): void => {
      finish(new Error(`child exited (${String(code)}/${String(signal)}): ${Buffer.concat(stderr).toString("utf8")}`));
    };
    const finish = (error?: Error, event?: ChildEvent): void => {
      clearTimeout(timer);
      child.off("message", onMessage);
      child.off("exit", onExit);
      child.stderr?.off("data", onStderr);
      if (error !== undefined) reject(error);
      else resolve(event as ChildEvent);
    };
    child.stderr?.on("data", onStderr);
    child.on("message", onMessage);
    child.once("exit", onExit);
  });
}

async function release(child: ChildProcess): Promise<void> {
  const released = waitForEvent(child, "released");
  child.send?.({ type: "release" });
  await released;
}

describe("state transaction process coordination", () => {
  it("serializes separate processes at the canonical lock directory for one task", async () => {
    const root = await taskRoot("same-task");
    const first = startLockChild(root);
    await waitForEvent(first, "entered");

    const second = startLockChild(root);
    const secondEntered = waitForEvent(second, "entered");
    await new Promise((resolve) => setTimeout(resolve, 40));
    expect(second.exitCode).toBeNull();
    await release(first);
    await secondEntered;
    await release(second);
  });

  it("does not serialize separate processes operating on independent task roots", async () => {
    const repository = await mkdtemp(join(tmpdir(), "archflow-transaction-independent-"));
    roots.push(repository);
    const firstRoot = join(repository, ".archflow", "tasks", "task-a");
    const secondRoot = join(repository, ".archflow", "tasks", "task-b");
    await Promise.all([mkdir(firstRoot, { recursive: true }), mkdir(secondRoot, { recursive: true })]);

    const first = startLockChild(firstRoot);
    const second = startLockChild(secondRoot);
    await Promise.all([waitForEvent(first, "entered"), waitForEvent(second, "entered")]);
    await Promise.all([release(first), release(second)]);
  });

  it("commits one of two real same-task transactions and rejects the stale process by CAS", async () => {
    const fixture = await transactionRepository(["same-task"]);
    const root = fixture.taskRoots["same-task"]!;
    const first = startTransactionChild(root, "intent-a", 1);
    const second = startTransactionChild(root, "intent-b", 1);
    const outcomes = await Promise.all([
      waitForEvent(first, "result"),
      waitForEvent(second, "result"),
    ]) as Array<Extract<ChildEvent, { type: "result" }>>;

    expect(outcomes.filter((outcome) => outcome.ok)).toEqual([
      expect.objectContaining({ ok: true, revision: 2, replayed: false, prepareCalls: 1 }),
    ]);
    expect(outcomes.filter((outcome) => !outcome.ok)).toEqual([
      expect.objectContaining({ ok: false, code: "STATE_CONFLICT", prepareCalls: 0 }),
    ]);
  });

  it("commits independent tasks in separate processes and distinguishes stale CAS from replay", async () => {
    const fixture = await transactionRepository(["task-a", "task-b"]);
    const independent = await Promise.all([
      waitForEvent(startTransactionChild(fixture.taskRoots["task-a"]!, "intent-a", 1), "result"),
      waitForEvent(startTransactionChild(fixture.taskRoots["task-b"]!, "intent-b", 1), "result"),
    ]) as Array<Extract<ChildEvent, { type: "result" }>>;
    expect(independent).toEqual([
      expect.objectContaining({ ok: true, revision: 2, prepareCalls: 1 }),
      expect.objectContaining({ ok: true, revision: 2, prepareCalls: 1 }),
    ]);

    const originalCas = await waitForEvent(
      startTransactionChild(fixture.taskRoots["task-a"]!, "intent-a", 1),
      "result",
    ) as Extract<ChildEvent, { type: "result" }>;
    expect(originalCas).toEqual(expect.objectContaining({ ok: false, code: "STATE_CONFLICT", prepareCalls: 0 }));

    const refreshedCas = await waitForEvent(
      startTransactionChild(fixture.taskRoots["task-a"]!, "intent-a", 2),
      "result",
    ) as Extract<ChildEvent, { type: "result" }>;
    expect(refreshedCas).toEqual(expect.objectContaining({
      ok: true,
      revision: 2,
      replayed: true,
      prepareCalls: 0,
    }));
  });
});

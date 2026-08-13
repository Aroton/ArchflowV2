import { execFileSync, spawn, type ChildProcess } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { canonicalDocument, sha256Bytes } from "../../src/contracts/canonical.js";
import type { TaskStateV1 } from "../../src/contracts/durable-state.js";
import { parseSafeInteger, parseSha256Digest, parseTaskSlug } from "../../src/contracts/evidence.js";
import { computeInputFingerprint, type InputFingerprintSubject } from "../../src/contracts/fingerprints.js";
import { encodePhaseInstance, parsePositiveSafePhaseNumber } from "../../src/contracts/phase-instance.js";
import { createGitRunner, preflightGit, type RepositoryOperationContext } from "../../src/repository/git.js";
import { discoverWorktree } from "../../src/repository/identity.js";
import { createInternalTransactionAuthority, type TransactionAuthority } from "../../src/state/authority.js";
import { inspectAbandonedTaskLock, removeConfirmedAbandonedTaskLock } from "../../src/state/lock.js";
import { readTaskState } from "../../src/state/read.js";

const roots: string[] = [];
const children = new Set<ChildProcess>();
const childProgram = new URL("../fixtures/state-gate-child.mjs", import.meta.url);
const PHASE = encodePhaseInstance({ kind: "phase-impl", phase: parsePositiveSafePhaseNumber(12) });
const D = (byte: string) => parseSha256Digest(byte.repeat(64));
const gitEnvironment: NodeJS.ProcessEnv = {
  ...process.env, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_SYSTEM: "/dev/null",
  GIT_AUTHOR_NAME: "ArchFlow Test", GIT_AUTHOR_EMAIL: "test@example.invalid",
  GIT_COMMITTER_NAME: "ArchFlow Test", GIT_COMMITTER_EMAIL: "test@example.invalid",
};

afterEach(async () => {
  for (const child of children) if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
  children.clear();
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

type Fixture = Readonly<{ repository: string; taskRoot: string; authority: TransactionAuthority }>;

async function fixture(taskIdText = "gate-crash"): Promise<Fixture> {
  const repository = await mkdtemp(join(tmpdir(), "archflow-gate-crash-"));
  roots.push(repository);
  execFileSync("git", ["-c", "init.defaultBranch=main", "init", "-q"], { cwd: repository, env: gitEnvironment });
  await writeFile(join(repository, "tracked.txt"), "root\n");
  execFileSync("git", ["add", "--", "tracked.txt"], { cwd: repository, env: gitEnvironment });
  execFileSync("git", ["commit", "-q", "-m", "root"], { cwd: repository, env: gitEnvironment });
  const taskId = parseTaskSlug(taskIdText);
  const taskRoot = join(repository, ".archflow", "tasks", taskId);
  await mkdir(taskRoot, { recursive: true });
  const context: RepositoryOperationContext = { task_id: taskId, phase_instance: PHASE, operation: "gate-crash-test" as never, attempt: parseSafeInteger(1) };
  const runner = createGitRunner({ cwd: repository });
  const discovered = await discoverWorktree(runner, context);
  const environment = await preflightGit(runner, context);
  if (!discovered.ok || !environment.ok) throw new Error("fixture repository discovery failed");
  const authority = await createInternalTransactionAuthority({ runner: discovered.value, environment: environment.value, task_id: taskId, context });
  if (!authority.ok) throw new Error("fixture authority failed");
  const config = new TextEncoder().encode('schema_version: "1"\nroles: {}\n');
  const subject: InputFingerprintSubject = {
    schema_version: "1", workflow_digest: D("5"), config_digest: sha256Bytes(config), constitution_digest: D("6"),
    artifact_identities: [], upstream_identities: [], rubric_digest: D("7"), phase_instance: PHASE, declared_inputs: [],
  };
  const state: TaskStateV1 = {
    schema_version: "1", task_id: taskId, repository_identity_digest: authority.value.repository_identity_digest,
    revision: parseSafeInteger(7), phase_instance: PHASE, step: "produce", status: "running", attempt: parseSafeInteger(1),
    input_fingerprint: computeInputFingerprint(subject), initialization_digest: D("3"), config_digest: subject.config_digest,
    workflow_digest: subject.workflow_digest, constitution_digest: subject.constitution_digest,
    policy_base_commit: execFileSync("git", ["rev-parse", "HEAD"], { cwd: repository, env: gitEnvironment, encoding: "utf8" }).trim() as TaskStateV1["policy_base_commit"],
    authoritative_results: [], approvals: [], waivers: [],
  };
  await Promise.all([
    writeFile(join(taskRoot, "config.yaml"), config),
    writeFile(authority.value.state.absolute, canonicalDocument(state).bytes),
  ]);
  return { repository, taskRoot, authority: authority.value };
}

function start(input: Fixture, action: string, cut = "none", intent = "gate-intent", digest = "8"): ChildProcess {
  const child = spawn(process.execPath, [childProgram.pathname, action, input.taskRoot, intent, digest, cut], {
    cwd: process.cwd(), stdio: ["ignore", "pipe", "pipe", "ipc"],
  });
  children.add(child);
  return child;
}

function event(child: ChildProcess, type: "cut" | "result" | "failed", timeoutMs = 10_000): Promise<Record<string, any>> {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => finish(new Error(`timed out waiting for ${type}`)), timeoutMs);
    const onMessage = (message: unknown) => { if ((message as { type?: unknown }).type === type) finish(undefined, message as Record<string, any>); };
    const onExit = (code: number | null, signal: NodeJS.Signals | null) => finish(new Error(`child exited before ${type}: ${String(code)}/${String(signal)}`));
    const finish = (error?: Error, value?: Record<string, any>) => {
      clearTimeout(timeout); child.off("message", onMessage); child.off("exit", onExit);
      error === undefined ? resolve(value!) : reject(error);
    };
    child.on("message", onMessage); child.once("exit", onExit);
  });
}

async function repair(input: Fixture): Promise<void> {
  const plan = await inspectAbandonedTaskLock(input.authority);
  await removeConfirmedAbandonedTaskLock(input.authority, plan, true);
}

async function waitForFile(path: string): Promise<void> {
  const deadline = Date.now() + 10_000;
  while (!existsSync(path)) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${path}`);
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}

async function waitForAbsent(path: string): Promise<void> {
  const deadline = Date.now() + 10_000;
  while (existsSync(path)) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for removal of ${path}`);
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}

async function decision(input: Fixture, choice = "approve"): Promise<string> {
  const active = JSON.parse(await readFile(join(input.authority.workspace_root, "cache", "gates", "gate.json"), "utf8"));
  const requestPath = join(input.taskRoot, "authority", "decisions", active.gate_id, "request.json");
  const request = JSON.parse(await readFile(requestPath, "utf8"));
  const envelope = {
    schema_version: "1", gate_id: request.gate_id, task_id: request.task_id, phase_instance: request.phase_instance,
    kind: request.kind, subject_digest: request.subject_digest, context_digest: request.context_digest,
    human_provenance: { schema_version: "1", actor_class: "human", assurance: "declared-local-trace", channel: "archflow-local", decision_event_id: "crash-decision", helper_invocation_id: "crash-helper", recorded_at: "2026-07-30T12:00:00.000Z" },
    payload: { decision: choice, reason: "Human reviewed the phase" },
  };
  await writeFile(join(input.authority.workspace_root, "cache", "gates", "gate.decision"), canonicalDocument(envelope).bytes);
  return request.gate_id;
}

describe("gate process and SIGKILL boundaries", { timeout: 20_000 }, () => {
  it("serializes conflicting opens and leaves the losing process without a request", async () => {
    const input = await fixture();
    const winner = start(input, "open-hold", "gate-published", "winner-intent", "8");
    await event(winner, "cut");
    const loser = start(input, "open", "none", "loser-intent", "2");
    const lost = await event(loser, "result");
    expect(lost.result).toMatchObject({ ok: false, error: { code: "IO_ERROR" } });
    winner.send?.({ type: "release" });
    expect((await event(winner, "result")).result).toMatchObject({ ok: true });
    const state = await readTaskState(input.authority.state);
    expect(state).toMatchObject({ kind: "canonical", document: { value: { revision: 8, open_gate: { gate_id: expect.any(String) } } } });
    expect((await readFile(join(input.authority.workspace_root, "cache", "gates", "gate.json"), "utf8"))).toContain("winner-intent");
    expect((await readFile(join(input.authority.workspace_root, "cache", "gates", "gate.json"), "utf8"))).not.toContain("loser-intent");
    expect(await readdir(join(input.taskRoot, "authority", "decisions"))).toHaveLength(1);
  });

  it("serializes conflicting resolves and appends one approval", async () => {
    const input = await fixture();
    expect((await event(start(input, "open"), "result")).result.ok).toBe(true);
    await decision(input);
    const winner = start(input, "run-hold", "archive-created");
    await event(winner, "cut");
    const loser = start(input, "run");
    expect((await event(loser, "result")).result).toMatchObject({ ok: false, error: { code: "IO_ERROR" } });
    winner.send?.({ type: "release" });
    expect((await event(winner, "result")).result).toMatchObject({ ok: true });
    const state = await readTaskState(input.authority.state);
    expect(state.kind === "canonical" ? state.document.value.approvals : []).toHaveLength(1);
  });

  it("waits independently on two tasks without holding either task lock", async () => {
    const first = await fixture("gate-wait-one");
    const second = await fixture("gate-wait-two");
    const left = start(first, "run");
    const right = start(second, "run");
    await Promise.all([waitForFile(join(first.authority.workspace_root, "cache", "gates", "gate.json")), waitForFile(join(second.authority.workspace_root, "cache", "gates", "gate.json"))]);
    await Promise.all([waitForAbsent(join(first.authority.workspace_root, "transient", ".transaction-lock")), waitForAbsent(join(second.authority.workspace_root, "transient", ".transaction-lock"))]);
    expect(existsSync(join(first.authority.workspace_root, "transient", ".transaction-lock"))).toBe(false);
    expect(existsSync(join(second.authority.workspace_root, "transient", ".transaction-lock"))).toBe(false);
    await Promise.all([decision(first), decision(second)]);
    const [leftResult, rightResult] = await Promise.all([event(left, "result"), event(right, "result")]);
    expect(leftResult.result.ok).toBe(true);
    expect(rightResult.result.ok).toBe(true);
  });

  for (const cut of ["request-created", "gate-published", "state-opened"] as const) {
    it(`resumes after real SIGKILL at open cut ${cut}`, async () => {
      const input = await fixture();
      const killed = start(input, "open-kill", cut);
      await event(killed, "cut");
      await new Promise<void>((resolve) => killed.once("exit", () => resolve()));
      await repair(input);
      const resumed = start(input, "open");
      expect((await event(resumed, "result")).result).toMatchObject({ ok: true });
      const state = await readTaskState(input.authority.state);
      expect(state).toMatchObject({ kind: "canonical", document: { value: { revision: 8, open_gate: { gate_id: expect.any(String) } } } });
    });
  }

  it("preserves a decision written after gate publication but before state names it", async () => {
    const input = await fixture();
    const killed = start(input, "open-kill", "gate-published");
    await event(killed, "cut");
    await new Promise<void>((resolve) => killed.once("exit", () => resolve()));
    const gateId = await decision(input);
    await repair(input);
    expect((await event(start(input, "run"), "result")).result).toMatchObject({ ok: true });
    const state = await readTaskState(input.authority.state);
    expect(state.kind === "canonical" ? state.document.value.approvals : []).toHaveLength(1);
    expect(existsSync(join(input.taskRoot, "authority", "decisions", gateId, "decision.json"))).toBe(true);
  });

  for (const cut of ["archive-created", "receipt-created", "state-resolved", "interface-remove-before"] as const) {
    it(`resumes exactly once after real SIGKILL at resolve cut ${cut}`, async () => {
      const input = await fixture();
      expect((await event(start(input, "open"), "result")).result.ok).toBe(true);
      const gateId = await decision(input);
      const killed = start(input, "run-kill", cut);
      await event(killed, "cut");
      await new Promise<void>((resolve) => killed.once("exit", () => resolve()));
      await repair(input);
      const result = await event(start(input, "run"), "result");
      expect(result.result).toMatchObject({ ok: true });
      const state = await readTaskState(input.authority.state);
      expect(state.kind === "canonical" ? state.document.value.approvals : []).toHaveLength(1);
      expect(existsSync(join(input.taskRoot, "authority", "decisions", gateId, "decision.json"))).toBe(true);
      expect(existsSync(join(input.authority.workspace_root, "cache", "gates", "gate.json"))).toBe(false);
      expect(existsSync(join(input.authority.workspace_root, "cache", "gates", "gate.decision"))).toBe(false);
    });
  }

  it.each([
    ["reentry", "revise", 2],
    ["exhaustion", "retry-once", 3],
  ] as const)(
    "resumes an already archived %s decision onto exactly one enacted re-entry",
    async (kind, choice, attempt) => {
      const input = await fixture(`gate-crash-${kind}`);
      const before = await readTaskState(input.authority.state);
      if (before.kind !== "canonical") throw new Error("fixture state unavailable");
      await writeFile(input.authority.state.absolute, canonicalDocument({
        ...before.document.value,
        step: "triage",
        status: "succeeded",
        attempt: parseSafeInteger(attempt),
      } as TaskStateV1).bytes);

      expect((await event(start(input, `${kind}-open`), "result")).result.ok).toBe(true);
      const gateId = await decision(input, choice);
      const killed = start(input, `${kind}-run-kill`, "archive-created");
      await event(killed, "cut");
      await new Promise<void>((resolve) => killed.once("exit", () => resolve()));
      await repair(input);

      expect((await event(start(input, `${kind}-run`), "result")).result).toMatchObject({
        ok: true,
        value: { effect: "retry" },
      });
      const after = await readTaskState(input.authority.state);
      expect(after).toMatchObject({
        kind: "canonical",
        document: {
          value: {
            step: "produce",
            status: "running",
            attempt: choice === "retry-once" ? attempt + 1 : attempt,
            input_fingerprint: D("e"),
          },
        },
      });
      expect(existsSync(join(input.taskRoot, "authority", "decisions", gateId, "decision.json"))).toBe(true);
      expect(existsSync(join(input.authority.workspace_root, "cache", "gates", "gate.json"))).toBe(false);
      expect(existsSync(join(input.authority.workspace_root, "cache", "gates", "gate.decision"))).toBe(false);
    },
  );
});

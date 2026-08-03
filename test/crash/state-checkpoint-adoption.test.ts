import { execFileSync, spawn, type ChildProcess } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { canonicalJsonBytes, canonicalJsonDigest, sha256Bytes } from "../../src/contracts/canonical.js";
import { checkpointSelfDigest, parseManualCheckpointImport, type ManualCheckpointImportV1, type ManualCheckpointV1 } from "../../src/contracts/durable-checkpoint.js";
import type { TaskStateV1 } from "../../src/contracts/durable-state.js";
import { computeInputFingerprint, type InputFingerprintSubject } from "../../src/contracts/fingerprints.js";
import { createGitRunner, preflightGit, type RepositoryOperationContext } from "../../src/repository/git.js";
import { discoverWorktree } from "../../src/repository/identity.js";
import { createInternalTransactionAuthority } from "../../src/state/authority.js";
import { inspectAbandonedTaskLock, removeConfirmedAbandonedTaskLock } from "../../src/state/lock.js";
import { readTaskState } from "../../src/state/read.js";

const childProgram = new URL("../fixtures/state-phase10-child.mjs", import.meta.url);
const roots: string[] = [];
const children = new Set<ChildProcess>();
const env: NodeJS.ProcessEnv = { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_SYSTEM: "/dev/null",
  GIT_AUTHOR_NAME: "ArchFlow Test", GIT_AUTHOR_EMAIL: "test@example.invalid",
  GIT_COMMITTER_NAME: "ArchFlow Test", GIT_COMMITTER_EMAIL: "test@example.invalid" };

afterEach(async () => {
  for (const child of children) if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
  children.clear();
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

const message = (child: ChildProcess, type: string): Promise<Record<string, unknown>> => new Promise((resolve, reject) => {
  const timer = setTimeout(() => reject(new Error(`child did not emit ${type}`)), 10_000);
  child.on("message", (value) => { const record = value as Record<string, unknown>; if (record.type === type) { clearTimeout(timer); resolve(record); } });
  child.on("error", reject);
});

function start(taskRoot: string, cut: "receipt-only" | "state-before" | "state-after" | "none"): ChildProcess {
  const child = spawn(process.execPath, [childProgram.pathname, "adopt", taskRoot, cut], {
    cwd: process.cwd(), stdio: ["ignore", "pipe", "pipe", "ipc"],
  });
  children.add(child); return child;
}

async function setup() {
  const repository = await mkdtemp(join(tmpdir(), "archflow-adoption-crash-")); roots.push(repository);
  execFileSync("git", ["-c", "init.defaultBranch=main", "init", "-q"], { cwd: repository, env });
  await writeFile(join(repository, "tracked.txt"), "root\n"); execFileSync("git", ["add", "--", "tracked.txt"], { cwd: repository, env });
  execFileSync("git", ["commit", "-q", "-m", "root"], { cwd: repository, env });
  const taskId = "adoption-crash" as RepositoryOperationContext["task_id"];
  const taskRoot = join(repository, ".archflow", "tasks", taskId); await mkdir(taskRoot, { recursive: true });
  const context: RepositoryOperationContext = { task_id: taskId, phase_instance: "phase-impl-10" as never,
    operation: "adoption-crash" as never, attempt: 1 as never };
  const runner0 = createGitRunner({ cwd: repository }); const discovered = await discoverWorktree(runner0, context);
  const preflight = discovered.ok ? await preflightGit(discovered.value, context) : discovered;
  if (!discovered.ok || !preflight.ok) throw new Error("repository setup failed");
  const authority = await createInternalTransactionAuthority({ runner: discovered.value, environment: preflight.value, task_id: taskId, context });
  if (!authority.ok) throw new Error("authority failed");
  const config = new TextEncoder().encode('schema_version: "1"\nroles: {}\n'); await writeFile(join(taskRoot, "config.yaml"), config);
  const subject: InputFingerprintSubject = { schema_version: "1", workflow_digest: "5".repeat(64) as never,
    config_digest: sha256Bytes(config), constitution_digest: "6".repeat(64) as never, artifact_identities: [], upstream_identities: [],
    rubric_digest: "7".repeat(64) as never, phase_instance: context.phase_instance, declared_inputs: [] };
  const fingerprint = computeInputFingerprint(subject);
  const state: TaskStateV1 = { schema_version: "1", task_id: taskId, repository_identity_digest: authority.value.repository_identity_digest,
    revision: 4 as never, phase_instance: context.phase_instance, step: "produce", status: "running", attempt: 1 as never,
    input_fingerprint: fingerprint, initialization_digest: "3".repeat(64) as never, config_digest: subject.config_digest,
    workflow_digest: subject.workflow_digest, constitution_digest: subject.constitution_digest,
    policy_base_commit: execFileSync("git", ["rev-parse", "HEAD"], { cwd: repository, env, encoding: "utf8" }).trim() as never,
    authoritative_results: [], approvals: [], waivers: [] };
  await writeFile(join(taskRoot, "state.json"), canonicalJsonBytes(state));
  const imported = JSON.parse(await readFile(new URL("../fixtures/contracts/durable/manual-checkpoint-import.valid.json", import.meta.url), "utf8")) as ManualCheckpointImportV1;
  const anchor = { anchor_kind: "state" as const, state_revision: state.revision, state_digest: canonicalJsonDigest(state) };
  const firstTemplate = structuredClone(imported.chain[1]!); delete (firstTemplate as { predecessor?: unknown }).predecessor;
  const first = { ...firstTemplate, task_id: taskId, repository_identity_digest: state.repository_identity_digest,
    revision: state.revision + 1, phase_instance: context.phase_instance, step: "produce", status: "failed",
    input_fingerprint: fingerprint, initialization_digest: state.initialization_digest, state_anchor: anchor,
    authoritative_results: [], projections: [], evidence_chain: [], approvals: [], waivers: [] } as unknown as ManualCheckpointV1;
  const second = { ...structuredClone(imported.chain[1]!), task_id: taskId, repository_identity_digest: state.repository_identity_digest,
    revision: first.revision + 1, phase_instance: context.phase_instance, step: "produce", status: "running", attempt: 2,
    input_fingerprint: fingerprint, initialization_digest: state.initialization_digest,
    authoritative_results: [], projections: [], evidence_chain: [], approvals: [], waivers: [],
    predecessor: { revision: first.revision, checkpoint_digest: checkpointSelfDigest(first) } } as unknown as ManualCheckpointV1;
  const artifact = parseManualCheckpointImport({ schema_version: "1", artifact_kind: "manual-checkpoint-import", task_id: taskId,
    repository_identity_digest: state.repository_identity_digest, import_mode: "state-anchored", state_anchor: anchor, chain: [first, second] });
  await writeFile(join(taskRoot, "phase10-child-input.json"), JSON.stringify({ context, subject, call: { schema_version: "1", task_id: taskId,
    intent_id: "adopt-checkpoints", expected_revision: state.revision, input_fingerprint: fingerprint, phase_instance: context.phase_instance,
    step: "produce", status: "running", artifact } }));
  return { taskRoot, authority: authority.value, prior: state.revision, head: second.revision };
}

describe("whole-chain adoption crash cuts", () => {
  for (const cut of ["receipt-only", "state-before", "state-after"] as const) {
    it(`exposes only prior or complete head at ${cut}`, async () => {
      const fixture = await setup(); const child = start(fixture.taskRoot, cut); await message(child, "cut");
      await new Promise<void>((resolve) => child.once("exit", () => resolve()));
      const observed = await readTaskState(fixture.authority.state); expect(observed.kind).toBe("canonical");
      if (observed.kind !== "canonical") return;
      expect(observed.document.value.revision).toBe(cut === "state-after" ? fixture.prior + 1 : fixture.prior);
      expect(observed.document.value.adopted_checkpoint?.revision).toBe(cut === "state-after" ? fixture.head : undefined);
      expect(existsSync(join(fixture.taskRoot, "checkpoints"))).toBe(false);
      const plan = await inspectAbandonedTaskLock(fixture.authority); await removeConfirmedAbandonedTaskLock(fixture.authority, plan, true);
      if (cut === "state-after") {
        const inputPath = join(fixture.taskRoot, "phase10-child-input.json");
        const input = JSON.parse(await readFile(inputPath, "utf8")) as { call: { expected_revision: number } };
        input.call.expected_revision = fixture.prior + 1;
        await writeFile(inputPath, JSON.stringify(input));
      }
      const resumed = start(fixture.taskRoot, "none"); const result = await message(resumed, "result");
      expect(result).toMatchObject({ ok: true, revision: fixture.prior + 1 });
      const final = await readTaskState(fixture.authority.state);
      if (final.kind === "canonical") expect(final.document.value.adopted_checkpoint?.revision).toBe(fixture.head);
    }, 20_000);
  }

  for (const [field, replacement] of [
    ["phase_instance", "phase-impl-11"],
    ["step", "counter_review"],
    ["status", "failed"],
    ["input_fingerprint", "9".repeat(64)],
  ] as const) {
    it(`rejects call/head ${field} mismatch through the transaction kernel`, async () => {
      const fixture = await setup();
      const inputPath = join(fixture.taskRoot, "phase10-child-input.json");
      const input = JSON.parse(await readFile(inputPath, "utf8")) as { call: Record<string, unknown> };
      input.call[field] = replacement;
      await writeFile(inputPath, JSON.stringify(input));
      const child = start(fixture.taskRoot, "none");
      const result = await message(child, "result");
      expect(result.ok).toBe(false);
      const observed = await readTaskState(fixture.authority.state);
      expect(observed.kind).toBe("canonical");
      if (observed.kind === "canonical") {
        expect(observed.document.value.revision).toBe(fixture.prior);
        expect(observed.document.value.adopted_checkpoint).toBeUndefined();
      }
      expect(existsSync(join(fixture.taskRoot, "intents", "adopt-checkpoints.json"))).toBe(false);
    }, 20_000);
  }

  it("re-reads and resumes an exact retained adoption receipt", async () => {
    const fixture = await setup();
    const crashed = start(fixture.taskRoot, "receipt-only"); await message(crashed, "cut");
    await new Promise<void>((resolve) => crashed.once("exit", () => resolve()));
    const lockPlan = await inspectAbandonedTaskLock(fixture.authority);
    await removeConfirmedAbandonedTaskLock(fixture.authority, lockPlan, true);
    const resumed = start(fixture.taskRoot, "none");
    expect(await message(resumed, "result")).toMatchObject({ ok: true, revision: fixture.prior + 1, replayed: false });
    const state = await readTaskState(fixture.authority.state);
    if (state.kind === "canonical") expect(state.document.value.adopted_checkpoint?.revision).toBe(fixture.head);
  }, 20_000);

  it("rejects a retained adoption receipt whose prepared head differs from the request artifact", async () => {
    const fixture = await setup();
    const crashed = start(fixture.taskRoot, "receipt-only"); await message(crashed, "cut");
    await new Promise<void>((resolve) => crashed.once("exit", () => resolve()));
    const receiptPath = join(fixture.taskRoot, "intents", "adopt-checkpoints.json");
    const receipt = JSON.parse(await readFile(receiptPath, "utf8")) as {
      prepared_state: TaskStateV1; prepared_state_digest: string;
    };
    receipt.prepared_state = { ...receipt.prepared_state, adopted_checkpoint: {
      revision: fixture.head - 1 as never, checkpoint_digest: "0".repeat(64) as never,
    } };
    receipt.prepared_state_digest = canonicalJsonDigest(receipt.prepared_state);
    await writeFile(receiptPath, canonicalJsonBytes(receipt as never));
    const lockPlan = await inspectAbandonedTaskLock(fixture.authority);
    await removeConfirmedAbandonedTaskLock(fixture.authority, lockPlan, true);
    const resumed = start(fixture.taskRoot, "none");
    expect(await message(resumed, "result")).toMatchObject({ ok: false, code: "TASK_INVALID" });
    const state = await readTaskState(fixture.authority.state);
    if (state.kind === "canonical") expect(state.document.value.revision).toBe(fixture.prior);
  }, 20_000);

  it("returns INTENT_MISMATCH for a substituted-chain retry of a retained adoption intent", async () => {
    const fixture = await setup();
    const crashed = start(fixture.taskRoot, "receipt-only"); await message(crashed, "cut");
    await new Promise<void>((resolve) => crashed.once("exit", () => resolve()));
    const inputPath = join(fixture.taskRoot, "phase10-child-input.json");
    const input = JSON.parse(await readFile(inputPath, "utf8")) as {
      call: { artifact: { chain: Array<Record<string, unknown>> } };
    };
    input.call.artifact.chain.at(-1)!.attempt = 3;
    await writeFile(inputPath, JSON.stringify(input));
    const lockPlan = await inspectAbandonedTaskLock(fixture.authority);
    await removeConfirmedAbandonedTaskLock(fixture.authority, lockPlan, true);
    const retried = start(fixture.taskRoot, "none");
    expect(await message(retried, "result")).toMatchObject({ ok: false, code: "INTENT_MISMATCH" });
    const state = await readTaskState(fixture.authority.state);
    if (state.kind === "canonical") expect(state.document.value.adopted_checkpoint).toBeUndefined();
  }, 20_000);
});

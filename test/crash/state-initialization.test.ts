import { execFileSync, spawn, type ChildProcess } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { canonicalJsonDigest, sha256Bytes } from "../../src/contracts/canonical.js";
import type { TaskInitializationV1 } from "../../src/contracts/durable-task-initialization.js";
import type { LegacyImportInitializationV1 } from "../../src/contracts/durable-legacy-import.js";
import { checkpointSelfDigest, parseManualCheckpointImport, type ManualCheckpointImportV1, type ManualCheckpointV1 } from "../../src/contracts/durable-checkpoint.js";
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
  child.on("message", (value) => {
    const record = value as Record<string, unknown>;
    if (record.type !== type) return;
    clearTimeout(timer); resolve(record);
  });
  child.on("error", reject);
});

function start(taskRoot: string, cut: "receipt-only" | "state-before" | "state-after" | "none"): ChildProcess {
  const child = spawn(process.execPath, [childProgram.pathname, "initialize", taskRoot, cut], {
    cwd: process.cwd(), stdio: ["ignore", "pipe", "pipe", "ipc"],
  });
  children.add(child);
  return child;
}

async function setup(kind: "normal" | "legacy" | "chain" = "normal") {
  const repository = await mkdtemp(join(tmpdir(), "archflow-init-crash-")); roots.push(repository);
  execFileSync("git", ["-c", "init.defaultBranch=main", "init", "-q"], { cwd: repository, env });
  await writeFile(join(repository, "tracked.txt"), "root\n");
  execFileSync("git", ["add", "--", "tracked.txt"], { cwd: repository, env });
  execFileSync("git", ["commit", "-q", "-m", "root"], { cwd: repository, env });
  const taskId = "init-crash" as RepositoryOperationContext["task_id"];
  const taskRoot = join(repository, ".archflow", "tasks", taskId); await mkdir(taskRoot, { recursive: true });
  const context: RepositoryOperationContext = { task_id: taskId, phase_instance: "prd" as never,
    operation: "init-crash" as never, attempt: 1 as never };
  const runner0 = createGitRunner({ cwd: repository });
  const discovered = await discoverWorktree(runner0, context); const preflight = discovered.ok ? await preflightGit(discovered.value, context) : discovered;
  if (!discovered.ok || !preflight.ok) throw new Error("repository setup failed");
  const authority = await createInternalTransactionAuthority({ runner: discovered.value, environment: preflight.value, task_id: taskId, context });
  if (!authority.ok) throw new Error("authority setup failed");
  const config = new TextEncoder().encode('schema_version: "1"\nroles: {}\n'); await writeFile(join(taskRoot, "config.yaml"), config);
  const subject: InputFingerprintSubject = { schema_version: "1", workflow_digest: "5".repeat(64) as never,
    config_digest: sha256Bytes(config), constitution_digest: "6".repeat(64) as never, artifact_identities: [],
    upstream_identities: [], rubric_digest: "7".repeat(64) as never, phase_instance: context.phase_instance, declared_inputs: [] };
  const fingerprint = computeInputFingerprint(subject);
  const headCommit = execFileSync("git", ["rev-parse", "HEAD"], { cwd: repository, env, encoding: "utf8" }).trim() as never;
  const templateName = kind === "legacy" ? "legacy-import-initialization.valid.json" : "task-initialization.valid.json";
  const template = JSON.parse(await readFile(new URL(`../fixtures/contracts/durable/${templateName}`, import.meta.url), "utf8")) as TaskInitializationV1 | LegacyImportInitializationV1;
  const common = { ...template, task_id: taskId, repository_identity_digest: authority.value.repository_identity_digest,
    code_baseline_commit: headCommit, policy_base_commit: headCommit,
    canonical_paths: { task_root: `.archflow/tasks/${taskId}` as never, config: `.archflow/tasks/${taskId}/config.yaml` as never,
      state: `.archflow/tasks/${taskId}/state.json` as never, workflow: ".archflow/workflow.yaml" as never,
      constitution_root: ".archflow/constitution" as never }, config_digest: subject.config_digest,
    workflow_digest: subject.workflow_digest, constitution_digest: subject.constitution_digest };
  let artifact: TaskInitializationV1 | LegacyImportInitializationV1 | ManualCheckpointImportV1 = kind === "legacy"
    ? { ...common, import_baseline_commit: headCommit } as LegacyImportInitializationV1
    : common as TaskInitializationV1;
  let callPhase = "prd";
  let callStep = "produce";
  let callStatus = "running";
  if (kind === "chain") {
    const imported = JSON.parse(await readFile(new URL("../fixtures/contracts/durable/manual-checkpoint-import.valid.json", import.meta.url), "utf8")) as ManualCheckpointImportV1;
    const initialization = common as TaskInitializationV1;
    const first = { ...structuredClone(imported.chain[0]!), task_id: taskId,
      repository_identity_digest: authority.value.repository_identity_digest, phase_instance: "prd", step: "produce", status: "succeeded",
      attempt: 1, input_fingerprint: fingerprint, initialization_digest: canonicalJsonDigest(initialization), initialization,
      authoritative_results: [], projections: [], evidence_chain: [], approvals: [], waivers: [] } as unknown as ManualCheckpointV1;
    const second = { ...structuredClone(imported.chain[1]!), task_id: taskId,
      repository_identity_digest: authority.value.repository_identity_digest, phase_instance: "prd", step: "self_review", status: "running",
      attempt: 1, input_fingerprint: fingerprint, initialization_digest: first.initialization_digest,
      authoritative_results: [], projections: [], evidence_chain: [], approvals: [], waivers: [],
      predecessor: { revision: first.revision, checkpoint_digest: checkpointSelfDigest(first) } } as unknown as ManualCheckpointV1;
    artifact = parseManualCheckpointImport({ schema_version: "1", artifact_kind: "manual-checkpoint-import", task_id: taskId,
      repository_identity_digest: authority.value.repository_identity_digest, import_mode: "initial", chain: [first, second] });
    callStep = "self_review";
  }
  await writeFile(join(taskRoot, "phase10-child-input.json"), JSON.stringify({ context, subject, call: { schema_version: "1", task_id: taskId,
    intent_id: "initialize", expected_revision: 0, input_fingerprint: fingerprint, phase_instance: callPhase, step: callStep, status: callStatus, artifact } }));
  return { taskRoot, authority: authority.value };
}

describe("revision-0 crash cuts", () => {
  for (const cut of ["receipt-only", "state-before", "state-after"] as const) {
    it(`leaves prior or complete revision 1 at ${cut}`, async () => {
      const fixture = await setup();
      const child = start(fixture.taskRoot, cut); await message(child, "cut");
      await new Promise<void>((resolve) => child.once("exit", () => resolve()));
      const observed = await readTaskState(fixture.authority.state);
      if (cut === "state-after") {
        expect(observed.kind).toBe("canonical");
        if (observed.kind === "canonical") expect(observed.document.value.revision).toBe(1);
      } else expect(observed.kind).toBe("missing");
      expect(existsSync(join(fixture.taskRoot, ".transaction-lock"))).toBe(true);
      const plan = await inspectAbandonedTaskLock(fixture.authority);
      await removeConfirmedAbandonedTaskLock(fixture.authority, plan, true);
      const resumed = start(fixture.taskRoot, "none");
      const result = await message(resumed, "result");
      expect(result).toMatchObject({ ok: true, revision: 1 });
    }, 20_000);
  }

  for (const [label, mutate] of [
    ["wrong canonical paths", (artifact: Record<string, any>) => { artifact.canonical_paths.state = ".archflow/tasks/other/state.json"; }],
    ["missing code baseline commit", (artifact: Record<string, any>) => { artifact.code_baseline_commit = "1".repeat(40); }],
    ["missing policy base commit", (artifact: Record<string, any>) => { artifact.policy_base_commit = "2".repeat(40); }],
  ] as const) {
    it(`rejects ${label} before receipt installation`, async () => {
      const fixture = await setup();
      const inputPath = join(fixture.taskRoot, "phase10-child-input.json");
      const input = JSON.parse(await readFile(inputPath, "utf8")) as { call: { artifact: Record<string, any> } };
      mutate(input.call.artifact);
      await writeFile(inputPath, JSON.stringify(input));
      const child = start(fixture.taskRoot, "none");
      const result = await message(child, "result");
      expect(result.ok).toBe(false);
      expect((await readTaskState(fixture.authority.state)).kind).toBe("missing");
      expect(existsSync(join(fixture.taskRoot, "intents", "initialize.json"))).toBe(false);
    }, 20_000);
  }

  for (const field of ["import_baseline_commit", "code_baseline_commit"] as const) {
    it(`validates the legacy ${field} as a current-repository commit`, async () => {
      const fixture = await setup("legacy");
      const inputPath = join(fixture.taskRoot, "phase10-child-input.json");
      const input = JSON.parse(await readFile(inputPath, "utf8")) as { call: { artifact: Record<string, unknown> } };
      input.call.artifact[field] = "3".repeat(40);
      await writeFile(inputPath, JSON.stringify(input));
      const child = start(fixture.taskRoot, "none");
      const result = await message(child, "result");
      expect(result.ok).toBe(false);
      expect((await readTaskState(fixture.authority.state)).kind).toBe("missing");
      expect(existsSync(join(fixture.taskRoot, "intents", "initialize.json"))).toBe(false);
    }, 20_000);
  }

  it("rejects an existing uncommitted object used as a policy commit", async () => {
    const fixture = await setup();
    const repository = fixture.taskRoot.slice(0, fixture.taskRoot.indexOf("/.archflow/tasks/"));
    const blob = execFileSync("git", ["hash-object", "-w", "--stdin"], {
      cwd: repository, env, encoding: "utf8", input: "not a commit\n",
    }).trim();
    const inputPath = join(fixture.taskRoot, "phase10-child-input.json");
    const input = JSON.parse(await readFile(inputPath, "utf8")) as { call: { artifact: Record<string, unknown> } };
    input.call.artifact.policy_base_commit = blob;
    await writeFile(inputPath, JSON.stringify(input));
    const child = start(fixture.taskRoot, "none");
    const result = await message(child, "result");
    expect(result.ok).toBe(false);
    expect((await readTaskState(fixture.authority.state)).kind).toBe("missing");
    expect(existsSync(join(fixture.taskRoot, "intents", "initialize.json"))).toBe(false);
  }, 20_000);

  it("adopts a legal initial multi-checkpoint chain in one revision-1 commit", async () => {
    const fixture = await setup("chain");
    const child = start(fixture.taskRoot, "none");
    const result = await message(child, "result");
    expect(result).toMatchObject({ ok: true, revision: 1 });
    const state = await readTaskState(fixture.authority.state);
    expect(state.kind).toBe("canonical");
    if (state.kind === "canonical") expect(state.document.value.adopted_checkpoint?.revision).toBe(2);
  }, 20_000);

  it("rejects an illegal workflow jump inside an initial chain before receipt", async () => {
    const fixture = await setup("chain");
    const inputPath = join(fixture.taskRoot, "phase10-child-input.json");
    const input = JSON.parse(await readFile(inputPath, "utf8")) as {
      call: { step: string; artifact: { chain: Array<Record<string, unknown>> } };
    };
    input.call.step = "triage";
    input.call.artifact.chain[1]!.step = "triage";
    await writeFile(inputPath, JSON.stringify(input));
    const child = start(fixture.taskRoot, "none");
    const result = await message(child, "result");
    expect(result.ok).toBe(false);
    expect((await readTaskState(fixture.authority.state)).kind).toBe("missing");
    expect(existsSync(join(fixture.taskRoot, "intents", "initialize.json"))).toBe(false);
  }, 20_000);

  it("returns INTENT_MISMATCH for a changed-artifact retry of a committed initialization", async () => {
    const fixture = await setup();
    const first = start(fixture.taskRoot, "none");
    expect(await message(first, "result")).toMatchObject({ ok: true, revision: 1 });
    const inputPath = join(fixture.taskRoot, "phase10-child-input.json");
    const input = JSON.parse(await readFile(inputPath, "utf8")) as { call: { artifact: Record<string, unknown> } };
    input.call.artifact.code_baseline_commit = "4".repeat(40);
    await writeFile(inputPath, JSON.stringify(input));
    const retried = start(fixture.taskRoot, "none");
    expect(await message(retried, "result")).toMatchObject({ ok: false, code: "INTENT_MISMATCH" });
    const state = await readTaskState(fixture.authority.state);
    if (state.kind === "canonical") expect(state.document.value.revision).toBe(1);
  }, 20_000);
});

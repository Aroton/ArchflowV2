import { spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  cpSync,
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  readlinkSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { canonicalDocument, canonicalJsonDigest, gitBlobOid, sha256Bytes } from "../../src/contracts/canonical.js";
import { currentEvidenceSetRef } from "../../src/contracts/trust.js";
import {
  deriveDeclaredSnapshotDigest,
  projectionGenerationDigest,
  RESULT_BYTE_CAP,
  TASK_BYTE_CAP,
} from "../../src/state/snapshots.js";
import { realHostsEnabled } from "../helpers/real-host.js";

// These slices install and exercise the bundled launchers without model dispatch or credential
// access. The explicit opt-in is sufficient; availability/auth probing belongs to dispatch suites.
const enabled = realHostsEnabled();
const TIMEOUT = 30_000;
const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const roots: string[] = [];
let installationRoot = "";
let checkoutRoot = "";
let scratchHome = "";
let scratchBin = "";
let installedEnvironment: NodeJS.ProcessEnv;
let developerSkillsBefore = "";

const gitIdentity: NodeJS.ProcessEnv = {
  GIT_CONFIG_GLOBAL: "/dev/null",
  GIT_CONFIG_SYSTEM: "/dev/null",
  GIT_AUTHOR_NAME: "ArchFlow Installed Journey",
  GIT_AUTHOR_EMAIL: "journey@example.invalid",
  GIT_COMMITTER_NAME: "ArchFlow Installed Journey",
  GIT_COMMITTER_EMAIL: "journey@example.invalid",
};

function digestTree(paths: readonly string[]): string {
  const hash = createHash("sha256");
  const visit = (path: string, label: string): void => {
    if (!existsSync(path)) {
      hash.update(`missing\0${label}\0`);
      return;
    }
    const stat = lstatSync(path);
    hash.update(`${stat.isDirectory() ? "d" : stat.isSymbolicLink() ? "l" : "f"}\0${label}\0${stat.mode}\0`);
    if (stat.isDirectory()) {
      for (const name of readdirSync(path).sort()) visit(join(path, name), `${label}/${name}`);
    } else if (stat.isSymbolicLink()) hash.update(readlinkSync(path));
    else hash.update(readFileSync(path));
  };
  paths.forEach((path, index) => visit(path, String(index)));
  return hash.digest("hex");
}

function git(root: string, ...argv: string[]): string {
  return spawnSync("git", argv, {
    cwd: root,
    env: { ...process.env, ...gitIdentity },
    encoding: "utf8",
    timeout: TIMEOUT,
  }).stdout.trim();
}

function makeRepository(name: string): string {
  const root = mkdtempSync(join(tmpdir(), `archflow-installed-${name}-`));
  roots.push(root);
  expect(spawnSync("git", ["-c", "init.defaultBranch=main", "init", "-q"], { cwd: root }).status).toBe(0);
  writeFileSync(join(root, "README.md"), "installed journey\n");
  git(root, "add", "--", "README.md");
  git(root, "commit", "-q", "-m", "root");
  return root;
}

function local(root: string, task: string | undefined, command: string, value?: unknown) {
  const argv = [command, ...(task === undefined ? [] : ["--task", task])];
  const result = spawnSync("archflow-local", argv, {
    cwd: root,
    env: installedEnvironment,
    input: value === undefined ? undefined : JSON.stringify(value),
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
    timeout: TIMEOUT,
  });
  return {
    status: result.status,
    stderr: result.stderr,
    value: result.stdout.trim() === "" ? undefined : JSON.parse(result.stdout),
  };
}

function structured(response: Record<string, any>): any {
  return response.result?.structuredContent;
}

async function mcpTool(
  root: string,
  tool: "archflow_gate" | "archflow_state",
  input: unknown,
  requestId: string,
  whileWaiting?: () => Promise<void>,
): Promise<any> {
  const child = spawn("archflow-mcp", [], { cwd: root, env: installedEnvironment, stdio: ["pipe", "pipe", "pipe"] });
  const stdout: Buffer[] = [];
  const stderr: Buffer[] = [];
  child.stdout.on("data", (chunk: Buffer) => stdout.push(Buffer.from(chunk)));
  child.stderr.on("data", (chunk: Buffer) => stderr.push(Buffer.from(chunk)));
  const waitForLines = async (count: number): Promise<void> => {
    if (Buffer.concat(stdout).toString("utf8").split("\n").length - 1 >= count) return;
    await new Promise<void>((resolveWait, reject) => {
      const timer = setTimeout(() => reject(new Error(`installed MCP timed out waiting for ${count} lines`)), TIMEOUT);
      const onData = (): void => {
        if (Buffer.concat(stdout).toString("utf8").split("\n").length - 1 >= count) {
          clearTimeout(timer);
          child.stdout.off("data", onData);
          resolveWait();
        }
      };
      child.stdout.on("data", onData);
    });
  };
  child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id: "init", method: "initialize", params: {
      protocolVersion: "2025-11-25", capabilities: {},
      clientInfo: { name: "codex-mcp-client", version: "0.146.0" },
    } })}\n`);
  await waitForLines(1);
  child.stdin.write(`${[
    JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }),
    JSON.stringify({ jsonrpc: "2.0", id: requestId, method: "tools/call", params: {
      name: tool, arguments: input,
    } }),
  ].join("\n")}\n`);
  if (whileWaiting !== undefined) {
    try {
      await whileWaiting();
    } catch (error) {
      child.kill("SIGKILL");
      throw error;
    }
  }
  await waitForLines(2);
  child.stdin.end();
  const exit = await new Promise<number | null>((resolveExit, reject) => {
    const timer = setTimeout(() => { child.kill("SIGKILL"); reject(new Error("installed MCP timed out")); }, TIMEOUT);
    child.once("error", reject);
    child.once("exit", (code) => { clearTimeout(timer); resolveExit(code); });
  });
  expect(exit, Buffer.concat(stderr).toString("utf8")).toBe(0);
  const lines = Buffer.concat(stdout).toString("utf8").trim().split("\n").map((line) => JSON.parse(line));
  const response = lines.find((line) => line.id === requestId);
  expect(response, `${Buffer.concat(stderr).toString("utf8")}\nstdout=${Buffer.concat(stdout).toString("utf8")}`).toBeDefined();
  return structured(response);
}

async function mcpState(root: string, input: unknown, requestId: string): Promise<any> {
  return mcpTool(root, "archflow_state", input, requestId);
}

async function waitForFile(path: string): Promise<void> {
  const deadline = Date.now() + TIMEOUT;
  while (!existsSync(path)) {
    if (Date.now() >= deadline) throw new Error(`timed out waiting for ${path}`);
    await new Promise((resolveWait) => setTimeout(resolveWait, 25));
  }
}

function generationDigest(bytes: Buffer): string {
  return projectionGenerationDigest({
    state: "present", file_type: "regular", mode: "100644",
    size_bytes: bytes.byteLength, content_digest: sha256Bytes(bytes),
  });
}

function installedEvidence(subjectDigest: string): any {
  return currentEvidenceSetRef([
    {
      role: "counter-review", evidence_digest: sha256Bytes(Buffer.from(`counter:${subjectDigest}`)),
      assurance: "server-attested", producer_family: "claude", reviewer_family: "codex",
      independence: "opposite-family",
    },
  ] as never);
}

async function decideInstalledGate(root: string, task: string, decision: string): Promise<any> {
  const gatePath = join(root, ".archflow", "tasks", task, "gate.json");
  await waitForFile(gatePath);
  const gate = JSON.parse(readFileSync(gatePath, "utf8"));
  const status = local(root, task, "status");
  expect(status.value).toMatchObject({ ok: true, value: { open_gate: { gate_id: gate.gate_id } } });
  const template = structuredClone(status.value.value.open_gate.decision_templates.find(
    (candidate: any) => candidate.payload?.decision === decision,
  ));
  expect(template, `missing ${decision} template in ${gatePath}`).toBeDefined();
  template.payload.reason = `Installed ${decision} decision`;
  if (decision === "adopt-as-new-generation") {
    template.payload.rationale = "The changed installed generation is intentional";
  }
  template.human_provenance = {
    schema_version: "1", actor_class: "human", assurance: "declared-local-trace",
    channel: "archflow-local", decision_event_id: `installed-${decision}`,
    helper_invocation_id: `installed-${decision}-helper`, recorded_at: new Date().toISOString(),
  };
  const written = local(root, task, "decide", { kind: "interface", value: template });
  expect(written.value).toMatchObject({ ok: true, value: { gate_id: gate.gate_id } });
  return template;
}

function commitPolicy(root: string): string {
  git(root, "add", "--", ".gitattributes", ".archflow/workflow.yaml", ".archflow/constitution", ".archflow/config.yaml");
  git(root, "commit", "-q", "-m", "approve policy base");
  return git(root, "rev-parse", "HEAD");
}

function snapshotFixture(task: string, state: any, bytes: Buffer, retained: number) {
  const path = `.archflow/tasks/${task}/prd.md`;
  const byteCount = bytes.byteLength;
  const digest = sha256Bytes(bytes);
  const output = {
    path, path_class: "document", operation: "add", storage: "raw-payload",
    payload_bytes: byteCount, payload_digest: digest, file_type: "regular",
    after: { oid: gitBlobOid(bytes), mode: "100644", size_bytes: byteCount },
  };
  const projections = [{ path, content_digest: digest }];
  const snapshotDigest = deriveDeclaredSnapshotDigest([output] as never, projections as never);
  const artifact = {
    schema_version: "1", artifact_kind: "document", task_id: task, phase_instance: "prd", step: "produce",
    document_path: "prd.md", path_class: "document", byte_count: byteCount, content_digest: digest,
    declared_inputs: [], input_fingerprint: state.input_fingerprint, snapshot_digest: snapshotDigest,
    projection_target: path,
  };
  return {
    manifest: {
      schema_version: "1", task_id: task, repository_identity_digest: state.repository_identity_digest,
      result_id: `installed-snapshot-${byteCount}`, phase_instance: "prd", step: "produce",
      artifact_digest: canonicalJsonDigest(artifact), source_artifact: artifact,
      input_fingerprint: state.input_fingerprint, snapshot_digest: snapshotDigest, outputs: [output], projections,
      accounting: {
        schema_version: "1", result_bytes: Math.min(RESULT_BYTE_CAP, byteCount),
        task_bytes: Math.min(TASK_BYTE_CAP, retained + byteCount),
        result_byte_cap: RESULT_BYTE_CAP, task_byte_cap: TASK_BYTE_CAP,
        counted_entries: [{ path, storage: "raw-payload", stored_bytes: byteCount }],
        measured_at_revision: state.revision,
      },
      secret_scan: { schema_version: "1", outcome: "clean", detector_set_id: "installed-journey", scanned_paths: [path] },
    },
    payload: { path, bytes_base64: bytes.toString("base64") },
  };
}

async function adopt(root: string, task: string, artifact: any, intent: string, transmittedArtifact = artifact): Promise<any> {
  const draft = {
    schema_version: "1", task_id: task, intent_id: intent, expected_revision: 0,
    input_fingerprint: "0".repeat(64), phase_instance: "prd", step: "produce", status: "running", artifact,
  };
  const envelope = local(root, task, "envelope", { tool: "archflow_state", input: draft });
  expect(envelope.value).toMatchObject({ ok: true });
  // The resolved request is the tool call; only the deliberate artifact swap the forgery
  // journeys exercise is layered on top of it.
  return mcpState(root, {
    ...envelope.value.value.request.input,
    artifact: transmittedArtifact,
  }, intent);
}

function taskState(root: string, task: string): any {
  return JSON.parse(readFileSync(join(root, ".archflow", "tasks", task, "state.json"), "utf8"));
}

// build-request kind "initialize" is the one composer legal before durable state exists; the
// staged task-initialization artifact rides inside the composed revision-0 request.
function stagedInitialization(root: string, task: string): any {
  const composed = local(root, task, "build-request", { kind: "initialize" });
  expect(composed.value).toMatchObject({ ok: true, value: { tool: "archflow_state" } });
  return composed.value.value.request.input.artifact;
}

function writeTaskState(root: string, task: string, state: any): void {
  writeFileSync(join(root, ".archflow", "tasks", task, "state.json"), canonicalDocument(state).bytes);
}

async function replayInitialization(root: string, task: string, artifact: any, intent: string): Promise<any> {
  const draft = {
    schema_version: "1", task_id: task, intent_id: intent, expected_revision: 1,
    input_fingerprint: "0".repeat(64), phase_instance: "prd", step: "produce", status: "running", artifact,
  };
  const envelope = local(root, task, "envelope", { tool: "archflow_state", input: draft });
  expect(envelope.value).toMatchObject({ ok: true });
  return mcpState(root, envelope.value.value.request.input, `${intent}-replay`);
}

async function installedImplementationFixture(root: string, task: string, content: string, intent: string) {
  const staged = stagedInitialization(root, task);
  expect(await adopt(root, task, staged, `${intent}-init`)).toMatchObject({ ok: true, value: { revision: 1 } });
  const current = taskState(root, task);
  const implementationState = {
    ...current,
    phase_instance: "phase-impl-1",
    step: "produce",
    status: "running",
  };
  writeTaskState(root, task, implementationState);
  writeFileSync(join(root, "README.md"), content);
  const composed = local(root, task, "build-request", {
    intent_id: `${intent}-produce`,
    kind: "produce",
    implementation: {
      base_commit: git(root, "rev-parse", "HEAD"),
      outputs: ["README.md"],
      restore_targets: ["README.md"],
      parent_documents: [],
      declared_inputs: [],
    },
  });
  expect(composed.value).toMatchObject({ ok: true, value: { tool: "archflow_state" } });
  const request = composed.value.value.request.input;
  expect(request.artifact).toMatchObject({ artifact_kind: "implementation-output" });
  return { artifact: request.artifact, request, state: implementationState };
}

async function installedRestoreCollisionFixture(
  root: string,
  task: string,
  intent: string,
  changedFingerprint: boolean,
) {
  expect(local(root, undefined, "init").value).toMatchObject({ ok: true });
  commitPolicy(root);
  const staged = stagedInitialization(root, task);
  expect(await adopt(root, task, staged, `${intent}-init`)).toMatchObject({ ok: true, value: { revision: 1 } });

  const target = join(root, ".archflow", "tasks", task, "prd.md");
  const retained = Buffer.from("retained installed generation\n");
  writeFileSync(target, retained);
  let state = taskState(root, task);
  const composed = local(root, task, "build-request", {
    intent_id: `${intent}-produce`, kind: "produce",
    document: { document_path: "prd.md", declared_inputs: [] },
  });
  expect(composed.value).toMatchObject({ ok: true, value: { tool: "archflow_state" } });
  const artifact = composed.value.value.request.input.artifact;
  expect(artifact).toMatchObject({ artifact_kind: "document" });
  const produced = await mcpState(root, composed.value.value.request.input, `${intent}-produce`);
  expect(produced, JSON.stringify(produced)).toMatchObject({ ok: true, value: { revision: 2 } });

  state = taskState(root, task);
  const retainedFingerprint = state.authoritative_results.at(-1).input_fingerprint;
  if (changedFingerprint) {
    writeFileSync(join(root, "README.md"), "changed declared input for installed adoption\n");
    const { last_transition: _lastTransition, ...stateWithoutIntent } = state;
    state = {
      ...stateWithoutIntent,
      input_fingerprint: canonicalJsonDigest({
        schema_version: "1",
        prior_input_fingerprint: retainedFingerprint,
        changed_input_digest: sha256Bytes(readFileSync(join(root, "README.md"))),
      }),
    };
    // This fixture begins at the recovery boundary: durable state already records the changed
    // input fingerprint whose exact authority the installed restore gate must require and bind.
    writeTaskState(root, task, state);
    expect(state.input_fingerprint).not.toBe(retainedFingerprint);
  }

  const collision = Buffer.from("intentional installed collision\n");
  writeFileSync(target, collision);
  return {
    artifact,
    collision,
    retained,
    retainedFingerprint,
    state,
    target,
  };
}

beforeAll(() => {
  if (!enabled) return;
  const developerHome = process.env.HOME;
  if (developerHome === undefined) throw new Error("HOME is required for the non-mutation assertion");
  developerSkillsBefore = digestTree([
    join(developerHome, ".claude", "skills"),
    join(developerHome, ".agents", "skills"),
  ]);
  installationRoot = mkdtempSync(join(tmpdir(), "archflow-installed-launchers-"));
  checkoutRoot = join(installationRoot, "checkout");
  scratchHome = join(installationRoot, "home");
  scratchBin = join(installationRoot, "bin");
  mkdirSync(scratchHome, { recursive: true });
  mkdirSync(scratchBin, { recursive: true });
  mkdirSync(checkoutRoot, { recursive: true });
  for (const path of ["dist", "assets", "skills"]) {
    cpSync(join(repositoryRoot, path), join(checkoutRoot, path), { recursive: true });
  }
  for (const path of ["install.sh", "package.json"]) {
    cpSync(join(repositoryRoot, path), join(checkoutRoot, path));
  }
  cpSync(
    join(repositoryRoot, "test", "fixtures", "legacy"),
    join(checkoutRoot, "test", "fixtures", "legacy"),
    { recursive: true },
  );
  chmodSync(join(checkoutRoot, "install.sh"), 0o755);
  installedEnvironment = {
    ...process.env,
    ...gitIdentity,
    HOME: scratchHome,
    ARCHFLOW_HOME: join(installationRoot, "archflow-home"),
    ARCHFLOW_BIN: scratchBin,
    PATH: `${scratchBin}:${process.env.PATH ?? ""}`,
  };
  const installed = spawnSync("./install.sh", [], {
    cwd: checkoutRoot, env: installedEnvironment, encoding: "utf8", timeout: TIMEOUT,
  });
  expect(installed.status, installed.stderr).toBe(0);
  expect(digestTree([join(developerHome, ".claude", "skills"), join(developerHome, ".agents", "skills")]))
    .toBe(developerSkillsBefore);
}, TIMEOUT);

afterAll(() => {
  const developerHome = process.env.HOME;
  if (enabled && developerHome !== undefined) {
    expect(digestTree([join(developerHome, ".claude", "skills"), join(developerHome, ".agents", "skills")]))
      .toBe(developerSkillsBefore);
  }
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
  if (installationRoot !== "") rmSync(installationRoot, { recursive: true, force: true });
});

describe.skipIf(!enabled)("installed terminal journeys", () => {
  it("keeps repository initialization and policy-base failure ownership at archflow-local, then adopts revision 1 over stdio", async () => {
    const missing = makeRepository("missing-policy");
    expect(local(missing, "missing-policy", "build-request", { kind: "initialize" }).value)
      .toMatchObject({ ok: false, error: { code: "IO_ERROR" } });

    const root = makeRepository("normal");
    expect(local(root, undefined, "init").value).toMatchObject({ ok: true });
    expect(local(root, "normal-task", "build-request", { kind: "initialize" }).value)
      .toMatchObject({ ok: false, error: { code: "POLICY_BASE_INVALID" } });
    commitPolicy(root);
    const staged = stagedInitialization(root, "normal-task");
    expect(staged).toMatchObject({ artifact_kind: "task-initialization" });
    const adopted = await adopt(root, "normal-task", staged, "installed-normal-init");
    expect(adopted).toMatchObject({ ok: true, value: { revision: 1 } });

    const statePath = join(root, ".archflow", "tasks", "normal-task", "state.json");
    const revision = JSON.parse(readFileSync(statePath, "utf8")).revision;
    const taskConfig = join(root, ".archflow", "tasks", "normal-task", "config.yaml");
    writeFileSync(taskConfig, `${readFileSync(taskConfig, "utf8")}# byte-level pin mismatch\n`);
    const mismatch = await mcpState(root, {
      schema_version: "1", task_id: "normal-task", intent_id: "installed-config-mismatch",
      expected_revision: revision, input_fingerprint: "0".repeat(64), phase_instance: "prd",
      step: "produce", status: "running",
    }, "installed-config-mismatch");
    expect(mismatch).toMatchObject({ ok: false, error: { code: "PINNED_CONFIG_MISMATCH" } });
  }, TIMEOUT);

  it.each([
    ["artifact", (artifact: any) => ({ ...artifact, config_digest: "0".repeat(64) }), "PINNED_CONFIG_MISMATCH"],
    ["commit", (artifact: any) => ({ ...artifact, code_baseline_commit: "f".repeat(40) }), "CONTRACT_INVALID"],
  ] as const)("rejects a mismatched task-initialization %s at the installed MCP boundary", async (_kind, mutate, expectedCode) => {
    const root = makeRepository(`initialization-${_kind}`);
    expect(local(root, undefined, "init").value).toMatchObject({ ok: true });
    commitPolicy(root);
    const task = `mismatch-${_kind}`;
    const staged = stagedInitialization(root, task);
    const rejected = await adopt(
      root,
      task,
      staged,
      `installed-${_kind}-mismatch`,
      mutate(staged),
    );
    expect(rejected).toMatchObject({ ok: false, error: { code: expectedCode } });
    expect(existsSync(join(root, ".archflow", "tasks", task, "state.json"))).toBe(false);
  }, TIMEOUT);

  it("round-trips an installed snapshot and rejects the first byte above either cap", async () => {
    const root = makeRepository("snapshots");
    expect(local(root, undefined, "init").value).toMatchObject({ ok: true });
    commitPolicy(root);
    const task = "snapshot-task";
    const staged = stagedInitialization(root, task);
    expect(await adopt(root, task, staged, "installed-snapshot-init"))
      .toMatchObject({ ok: true, value: { revision: 1 } });
    const state = JSON.parse(readFileSync(join(root, ".archflow", "tasks", task, "state.json"), "utf8"));

    const ordinary = snapshotFixture(task, state, Buffer.from("snapshot bytes\n"), 0);
    expect(local(root, task, "snapshot", {
      manifest: ordinary.manifest, retained_task_bytes: 0, payloads: [ordinary.payload],
    }).value).toMatchObject({ ok: true });
    expect(local(root, task, "restore", {
      result_digest: canonicalJsonDigest(ordinary.manifest), output_path: ordinary.payload.path,
    }).value).toMatchObject({ ok: true, value: { state: "present", bytes: ordinary.payload.bytes_base64 } });

    const resultOverflow = snapshotFixture(task, state, Buffer.alloc(RESULT_BYTE_CAP + 1), 0);
    const resultLimited = local(root, task, "snapshot", {
      manifest: resultOverflow.manifest, retained_task_bytes: 0, payloads: [resultOverflow.payload],
    });
    expect(resultLimited.value).toMatchObject({
      ok: false,
      error: {
        code: "SNAPSHOT_LIMIT",
        diagnostic: {
          parameters: {
            limit_scope: "result",
            current_bytes: RESULT_BYTE_CAP + 1,
            byte_cap: RESULT_BYTE_CAP,
          },
        },
      },
    });
    const taskOverflow = snapshotFixture(task, state, Buffer.from("x"), TASK_BYTE_CAP);
    expect(local(root, task, "snapshot", {
      manifest: taskOverflow.manifest, retained_task_bytes: TASK_BYTE_CAP, payloads: [taskOverflow.payload],
    }).value).toMatchObject({ ok: false, error: { code: "SNAPSHOT_LIMIT" } });
  }, TIMEOUT);

  it("replays initialization exactly in a dirty worktree without touching unrelated bytes", async () => {
    const root = makeRepository("dirty-replay");
    expect(local(root, undefined, "init").value).toMatchObject({ ok: true });
    commitPolicy(root);
    const task = "dirty-replay-task";
    const staged = stagedInitialization(root, task);
    const first = await adopt(root, task, staged, "installed-dirty-init");
    expect(first).toMatchObject({ ok: true, value: { revision: 1 } });
    const taskRoot = join(root, ".archflow", "tasks", task);
    const authorityBefore = digestTree([taskRoot]);
    writeFileSync(join(root, "README.md"), "unrelated tracked dirty bytes\n");
    writeFileSync(join(root, "unrelated-untracked.bin"), Buffer.from([0, 255, 1, 254]));
    const trackedBefore = readFileSync(join(root, "README.md"));
    const untrackedBefore = readFileSync(join(root, "unrelated-untracked.bin"));

    expect(await replayInitialization(root, task, staged, "installed-dirty-init")).toEqual(first);
    expect(digestTree([taskRoot])).toBe(authorityBefore);
    expect(readFileSync(join(root, "README.md"))).toEqual(trackedBefore);
    expect(readFileSync(join(root, "unrelated-untracked.bin"))).toEqual(untrackedBefore);
  }, TIMEOUT);

  it.each([
    ["discard-and-restore", false],
    ["adopt-as-new-generation", true],
    ["abort", false],
  ] as const)("resolves an installed restore collision with %s", async (decision, changedFingerprint) => {
    const root = makeRepository(`restore-${decision}`);
    const task = `restore-${decision}`;
    const fixture = await installedRestoreCollisionFixture(
      root,
      task,
      `installed-${decision}`,
      changedFingerprint,
    );
    const before = taskState(root, task);
    const subjectDigest = canonicalJsonDigest(fixture.artifact);
    const context: any = {
      path: "prd.md",
      recorded_generation_digest: generationDigest(fixture.retained),
      current_generation_digest: generationDigest(fixture.collision),
    };
    if (decision === "adopt-as-new-generation") {
      const authority = {
        purpose: "restore-adoption",
        proposed_generation_digest: context.current_generation_digest,
        changed_input_fingerprint: before.input_fingerprint,
      };
      context.adoption_candidate = {
        ...authority,
        link_digest: canonicalJsonDigest({ schema_version: "1", ...authority }),
      };
      expect(before.input_fingerprint).not.toBe(fixture.retainedFingerprint);
    }
    const draft = {
      schema_version: "1", task_id: task, intent_id: `installed-${decision}-gate`,
      expected_revision: before.revision, input_fingerprint: before.input_fingerprint,
      phase_instance: "prd", summary: `Resolve installed ${decision} collision`,
      subject_digest: subjectDigest, current_evidence: installedEvidence(subjectDigest),
      kind: "restore-collision", context,
    };
    const envelope = local(root, task, "envelope", { tool: "archflow_gate", input: draft });
    expect(envelope.value).toMatchObject({ ok: true, value: { input_fingerprint: before.input_fingerprint } });
    const resolved = await mcpTool(
      root,
      "archflow_gate",
      draft,
      `installed-${decision}-gate`,
      async () => { await decideInstalledGate(root, task, decision); },
    );
    expect(resolved).toMatchObject({
      ok: true,
      value: { kind: "restore-collision", decision: { payload: { decision } } },
    });

    const after = taskState(root, task);
    if (decision === "discard-and-restore") {
      expect(readFileSync(fixture.target)).toEqual(fixture.retained);
      expect(after.approvals).toHaveLength(before.approvals.length + 1);
    } else if (decision === "adopt-as-new-generation") {
      expect(readFileSync(fixture.target)).toEqual(fixture.collision);
      expect(resolved.value.decision.payload).toMatchObject({
        adoption_authority: context.adoption_candidate,
        rationale: "The changed installed generation is intentional",
      });
      expect(after.approvals).toHaveLength(before.approvals.length + 1);
    } else {
      expect(readFileSync(fixture.target)).toEqual(fixture.collision);
      expect(after.approvals).toEqual(before.approvals);
      expect({
        phase_instance: after.phase_instance,
        step: after.step,
        status: after.status,
        attempt: after.attempt,
        input_fingerprint: after.input_fingerprint,
        authoritative_results: after.authoritative_results,
      }).toEqual({
        phase_instance: before.phase_instance,
        step: before.step,
        status: before.status,
        attempt: before.attempt,
        input_fingerprint: before.input_fingerprint,
        authoritative_results: before.authoritative_results,
      });
    }
    expect(existsSync(join(root, ".archflow", "tasks", task, "gate.json"))).toBe(false);
    expect(existsSync(join(root, ".archflow", "tasks", task, "gate.decision"))).toBe(false);
  }, TIMEOUT);

  it("cleans reconstructible task work without creating a maintenance record", async () => {
    const root = makeRepository("clean");
    expect(local(root, undefined, "init").value).toMatchObject({ ok: true });
    commitPolicy(root);
    const task = "maintenance-task";
    const staged = stagedInitialization(root, task);
    expect(await adopt(root, task, staged, "installed-clean-init"))
      .toMatchObject({ ok: true, value: { revision: 1 } });
    const orphan = join(root, ".archflow", "work", "tasks", task, "diagnostics", "attempts", "phase-impl-21", "orphan.json");
    mkdirSync(dirname(orphan), { recursive: true });
    writeFileSync(orphan, "installed orphan attempt\n");

    expect(local(root, task, "clean").value).toMatchObject({
      ok: true,
      value: {
        removed_files: 1,
        removed_bytes: Buffer.byteLength("installed orphan attempt\n"),
        cleanup_pending: false,
      },
    });
    expect(existsSync(orphan)).toBe(false);
    expect(existsSync(join(root, ".archflow", "tasks", task, "maintenance"))).toBe(false);
  }, TIMEOUT);

  it("rejects a secret-bearing implementation output before projection or state advancement", async () => {
    const root = makeRepository("secret-output");
    expect(local(root, undefined, "init").value).toMatchObject({ ok: true });
    commitPolicy(root);
    const task = "secret-output-task";
    const secret = "ghp_" + "0123456789abcdefghijklmnopqrstuvwxyz";
    const fixture = await installedImplementationFixture(root, task, `${secret}\n`, "installed-secret");
    expect(fixture.artifact.secret_scan).toMatchObject({ outcome: "detected" });
    const stateBefore = readFileSync(join(root, ".archflow", "tasks", task, "state.json"));
    const readmeBefore = readFileSync(join(root, "README.md"));
    const taskRoot = join(root, ".archflow", "tasks", task);
    const durableBefore = digestTree([taskRoot]);
    const rejected = await mcpState(root, fixture.request, "installed-secret-output");
    expect(rejected).toMatchObject({ ok: false, error: { code: "SECRET_DETECTED" } });
    expect(readFileSync(join(root, "README.md"))).toEqual(readmeBefore);
    expect(readFileSync(join(root, ".archflow", "tasks", task, "state.json"))).toEqual(stateBefore);
    expect(digestTree([taskRoot])).toBe(durableBefore);
  }, TIMEOUT);

  it("runs a legacy upgrade through installed launchers, preserving source and rerun authority", async () => {
    const root = makeRepository("upgrade");
    expect(local(root, undefined, "init").value).toMatchObject({ ok: true });
    const source = join(root, ".archflow", "tasks", "legacy-source");
    mkdirSync(dirname(source), { recursive: true });
    cpSync(join(checkoutRoot, "test", "fixtures", "legacy"), source, { recursive: true });
    const head = commitPolicy(root);
    git(root, "add", "--", ".archflow/tasks/legacy-source");
    git(root, "commit", "-q", "-m", "legacy source");
    const baseline = git(root, "rev-parse", "HEAD");
    const sourceBefore = digestTree([source]);
    const value = {
      source_root: source, task_id: "upgrade-task", policy_base_commit: head,
      import_baseline_commit: baseline, code_baseline_commit: baseline,
    };
    const first = local(root, "upgrade-task", "upgrade", value);
    expect(first.value).toMatchObject({ ok: true, value: { resume_phase: "phase-design-4" } });
    const destination = join(root, ".archflow", "tasks", "upgrade-task");
    const firstDestination = digestTree([destination]);
    // Model the last pre-authority crash point: payloads exist, but the manifest that makes
    // them discoverable was not installed. A launcher rerun must converge exactly.
    rmSync(join(root, first.value.value.manifest_path));
    expect(existsSync(join(root, first.value.value.manifest_path))).toBe(false);
    const recovered = local(root, "upgrade-task", "upgrade", value);
    expect(recovered.value).toEqual(first.value);
    expect(digestTree([destination])).toBe(firstDestination);
    const second = local(root, "upgrade-task", "upgrade", value);
    expect(second.value).toEqual(first.value);
    expect(digestTree([destination])).toBe(firstDestination);
    expect(existsSync(join(destination, "decisions"))).toBe(false);
    expect(digestTree([source])).toBe(sourceBefore);

    expect(await adopt(root, "upgrade-task", first.value.value.initialization, "installed-upgrade-normal"))
      .toMatchObject({ ok: true, value: { revision: 1 } });
    expect(digestTree([source])).toBe(sourceBefore);
  }, TIMEOUT);
});

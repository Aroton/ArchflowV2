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

import { canonicalJsonDigest, gitBlobOid, sha256Bytes } from "../../src/contracts/canonical.js";
import { deriveDeclaredSnapshotDigest, RESULT_BYTE_CAP, TASK_BYTE_CAP } from "../../src/state/snapshots.js";
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

async function mcpState(root: string, input: unknown, requestId: string): Promise<any> {
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
      name: "archflow_state", arguments: input,
    } }),
  ].join("\n")}\n`);
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
        schema_version: "1", result_bytes: byteCount, task_bytes: Math.min(TASK_BYTE_CAP, retained + byteCount),
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
  return mcpState(root, {
    ...draft,
    artifact: transmittedArtifact,
    input_fingerprint: envelope.value.value.input_fingerprint,
  }, intent);
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
    expect(local(missing, "missing-policy", "task-init").value)
      .toMatchObject({ ok: false, error: { code: "IO_ERROR" } });

    const root = makeRepository("normal");
    expect(local(root, undefined, "init").value).toMatchObject({ ok: true });
    expect(local(root, "normal-task", "task-init").value)
      .toMatchObject({ ok: false, error: { code: "POLICY_BASE_INVALID" } });
    commitPolicy(root);
    const staged = local(root, "normal-task", "task-init");
    expect(staged.value).toMatchObject({ ok: true, value: { artifact_kind: "task-initialization" } });
    const adopted = await adopt(root, "normal-task", staged.value.value, "installed-normal-init");
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
    const staged = local(root, task, "task-init");
    expect(staged.value).toMatchObject({ ok: true });
    const rejected = await adopt(
      root,
      task,
      staged.value.value,
      `installed-${_kind}-mismatch`,
      mutate(staged.value.value),
    );
    expect(rejected).toMatchObject({ ok: false, error: { code: expectedCode } });
    expect(existsSync(join(root, ".archflow", "tasks", task, "state.json"))).toBe(false);
  }, TIMEOUT);

  it("round-trips an installed manual checkpoint slice without duplicate checkpoint bytes", async () => {
    const root = makeRepository("manual");
    expect(local(root, undefined, "init").value).toMatchObject({ ok: true });
    commitPolicy(root);
    const staged = local(root, "manual-task", "task-init").value.value;
    const bootstrap = {
      schema_version: "1", operation: "bootstrap", initialization: staged,
    };
    expect(local(root, "manual-task", "manual-next", bootstrap).value)
      .toMatchObject({ ok: true, value: { revision: 1 } });
    const checkpointRoot = join(root, ".archflow", "tasks", "manual-task", "manual", "checkpoints");
    const firstDigest = digestTree([checkpointRoot]);
    expect(local(root, "manual-task", "manual-next", {
      schema_version: "1", operation: "step", phase_instance: "prd", step: "produce", status: "failed",
    }).value).toMatchObject({ ok: true, value: { revision: 2 } });
    expect(digestTree([checkpointRoot])).not.toBe(firstDigest);
    const importCall = local(root, "manual-task", "manual-next", {
      schema_version: "1", operation: "import-call", intent_id: "installed-manual-import",
    });
    expect(importCall.value).toMatchObject({ ok: true, value: { call: { input: { expected_revision: 0 } } } });
    const adopted = await mcpState(root, importCall.value.value.call.input, "installed-manual-import");
    expect(adopted).toMatchObject({ ok: true, value: { revision: 1, status: "failed" } });
  }, TIMEOUT);

  it("round-trips an installed snapshot and rejects the first byte above either cap", async () => {
    const root = makeRepository("snapshots");
    expect(local(root, undefined, "init").value).toMatchObject({ ok: true });
    commitPolicy(root);
    const task = "snapshot-task";
    const staged = local(root, task, "task-init").value.value;
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
    // The durable schema rejects an over-cap declared result before prepareSnapshot can classify
    // it as SNAPSHOT_LIMIT. Pin that installed boundary separately from the retained-task cap.
    expect(resultLimited).toMatchObject({ status: 1, value: undefined });
    expect(resultLimited.stderr).toContain("/accounting/result_bytes must be <= 26214400");
    const taskOverflow = snapshotFixture(task, state, Buffer.from("x"), TASK_BYTE_CAP);
    expect(local(root, task, "snapshot", {
      manifest: taskOverflow.manifest, retained_task_bytes: TASK_BYTE_CAP, payloads: [taskOverflow.payload],
    }).value).toMatchObject({ ok: false, error: { code: "SNAPSHOT_LIMIT" } });
  }, TIMEOUT);

  it("runs normal and manual legacy upgrades through installed launchers, preserving source and rerun authority", async () => {
    for (const mode of ["normal", "manual"] as const) {
      const root = makeRepository(`upgrade-${mode}`);
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
        source_root: source, task_id: `upgrade-${mode}`, policy_base_commit: head,
        import_baseline_commit: baseline, code_baseline_commit: baseline,
      };
      const first = local(root, `upgrade-${mode}`, "upgrade", value);
      expect(first.value).toMatchObject({ ok: true, value: { resume_phase: "phase-design-4" } });
      const destination = join(root, ".archflow", "tasks", `upgrade-${mode}`);
      const firstDestination = digestTree([destination]);
      if (mode === "normal") {
        // Model the last pre-authority crash point: payloads exist, but the manifest that makes
        // them discoverable was not installed. A launcher rerun must converge exactly.
        rmSync(join(root, first.value.value.manifest_path));
        expect(existsSync(join(root, first.value.value.manifest_path))).toBe(false);
        const recovered = local(root, `upgrade-${mode}`, "upgrade", value);
        expect(recovered.value).toEqual(first.value);
        expect(digestTree([destination])).toBe(firstDestination);
      }
      const second = local(root, `upgrade-${mode}`, "upgrade", value);
      expect(second.value).toEqual(first.value);
      expect(digestTree([destination])).toBe(firstDestination);
      expect(existsSync(join(destination, "decisions"))).toBe(false);
      expect(digestTree([source])).toBe(sourceBefore);

      if (mode === "normal") {
        expect(await adopt(root, `upgrade-${mode}`, first.value.value.initialization, "installed-upgrade-normal"))
          .toMatchObject({ ok: true, value: { revision: 1 } });
      } else {
        expect(local(root, `upgrade-${mode}`, "manual-next", {
          schema_version: "1", operation: "bootstrap", initialization: first.value.value.initialization,
        }).value).toMatchObject({ ok: true, value: { revision: 1 } });
        const call = local(root, `upgrade-${mode}`, "manual-next", {
          schema_version: "1", operation: "import-call", intent_id: "installed-upgrade-manual",
        });
        expect(await mcpState(root, call.value.value.call.input, "installed-upgrade-manual"))
          .toMatchObject({ ok: true, value: { revision: 1 } });
      }
      expect(digestTree([source])).toBe(sourceBefore);
    }
  }, TIMEOUT);
});

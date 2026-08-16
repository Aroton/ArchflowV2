import { spawn, spawnSync, execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";

import { canonicalDocument } from "../../src/contracts/canonical.js";
import { parseGateRequest } from "../../src/contracts/durable-gate.js";
import { parseSafeCode, parseSafeInteger, parseSha256Digest, parseTaskSlug } from "../../src/contracts/evidence.js";
import { computeGateContextDigest, computeGateId } from "../../src/contracts/fingerprints.js";
import { parseToolCall } from "../../src/contracts/mcp-tools.js";
import { scaffoldRepositoryAssets } from "../../src/init/assets.js";
import { stageTaskInitialization } from "../../src/init/task-initialization.js";
import { runStateInitialization } from "../../src/state/initialization.js";
import { createProductionServices } from "../../src/state/production.js";
import { identifyTransactionRequest } from "../../src/state/request.js";

const TIMEOUT = 30_000;
const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const roots: string[] = [];
const task = parseTaskSlug("local-cli");
const digest = (character: string) => parseSha256Digest(character.repeat(64));
let bundleRoot = "";
let localBundle = "";

const gitEnvironment: NodeJS.ProcessEnv = {
  ...process.env,
  GIT_CONFIG_GLOBAL: "/dev/null",
  GIT_CONFIG_SYSTEM: "/dev/null",
  GIT_AUTHOR_NAME: "ArchFlow Test",
  GIT_AUTHOR_EMAIL: "test@example.invalid",
  GIT_COMMITTER_NAME: "ArchFlow Test",
  GIT_COMMITTER_EMAIL: "test@example.invalid",
};

beforeAll(async () => {
  bundleRoot = await mkdtemp(resolve(tmpdir(), "archflow-local-cli-"));
  localBundle = resolve(bundleRoot, "archflow-local.mjs");
  const program = [
    'import { build } from "esbuild";',
    'const [root, outfile] = process.argv.slice(1);',
    'await build({absWorkingDir:root,entryPoints:["src/local/main.ts"],outfile,bundle:true,platform:"node",format:"esm",target:"node24",banner:{js:\'import { createRequire as __createRequire } from "node:module"; const require = __createRequire(import.meta.url);\'}});',
  ].join("");
  const built = spawnSync(process.execPath, ["--input-type=module", "--eval", program, repositoryRoot, localBundle], {
    cwd: repositoryRoot, encoding: "utf8", timeout: TIMEOUT,
  });
  expect(built.status, built.stderr).toBe(0);
}, TIMEOUT);

afterAll(async () => { if (bundleRoot !== "") await rm(bundleRoot, { recursive: true, force: true }); });
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

function git(root: string, ...argv: string[]): string {
  return execFileSync("git", argv, { cwd: root, env: gitEnvironment, encoding: "utf8" }).trim();
}

function cli(root: string, command: string, value?: unknown): Readonly<{ status: number | null; stdout: string; stderr: string; value?: any }> {
  const result = spawnSync(process.execPath, [localBundle, command, "--task", task], {
    cwd: root,
    env: gitEnvironment,
    input: value === undefined ? undefined : JSON.stringify(value),
    encoding: "utf8",
    timeout: TIMEOUT,
  });
  return {
    status: result.status,
    stdout: result.stdout,
    stderr: result.stderr,
    ...(result.stdout === "" ? {} : { value: JSON.parse(result.stdout) }),
  };
}

async function repository() {
  const root = mkdtempSync(join(tmpdir(), "archflow-local-cli-repo-"));
  roots.push(root);
  git(root, "-c", "init.defaultBranch=main", "init", "-q");
  writeFileSync(join(root, "README.md"), "repository\n");
  git(root, "add", "--", "README.md");
  git(root, "commit", "-q", "-m", "root");
  const scaffolded = await scaffoldRepositoryAssets({ working_directory: root });
  if (!scaffolded.ok) throw new Error(scaffolded.error.code);
  git(root, "add", "--", ".gitattributes", ".archflow/.gitignore", ".archflow/workflow.yaml", ".archflow/constitution", ".archflow/config.yaml");
  git(root, "commit", "-q", "-m", "policy");
  const staged = await stageTaskInitialization({ working_directory: root, task_id: task });
  if (!staged.ok) throw new Error(staged.error.code);
  return { root, initialization: staged.value };
}

describe("bundled local CLI", () => {
  it("wires all envelopes, the no-state identification seam, request composition, validation, and full status", async () => {
    const fixture = await repository();
    const placeholder = digest("0");
    // build-request composes the entire revision-0 initialization request before any durable
    // state exists; envelope over its output exercises the no-state identification seam and must
    // land on the same digests.
    const composedInit = cli(fixture.root, "build-request", { intent_id: "initialize-cli", kind: "initialize" });
    expect(composedInit).toMatchObject({ status: 0, value: { ok: true, value: { tool: "archflow_state" } } });
    const initialRequest = composedInit.value.value.request;
    expect(initialRequest.input).toMatchObject({
      task_id: task, intent_id: "initialize-cli", expected_revision: 0,
      phase_instance: "prd", step: "produce", status: "running",
      artifact: fixture.initialization,
    });
    const first = cli(fixture.root, "envelope", initialRequest);
    expect(first).toMatchObject({ status: 0, value: { ok: true, value: { tool: "archflow_state" } } });
    expect(first.value.value.request_digest).toBe(composedInit.value.value.request_digest);

    const bootstrap = await createProductionServices({
      working_directory: fixture.root, task_id: task, operation: parseSafeCode("cli-bootstrap"),
    });
    if (!bootstrap.ok || bootstrap.value.state !== undefined) throw new Error("bootstrap services unavailable");
    const initialized = await runStateInitialization(bootstrap.value.dependencies, {
      authority: bootstrap.value.authority,
      call: parseToolCall("archflow_state", initialRequest.input),
    });
    expect(initialized.ok).toBe(true);
    if (!initialized.ok) return;
    expect(initialized.value.state.value.last_transition?.request_digest).toBe(first.value.value.request_digest);

    writeFileSync(join(bootstrap.value.authority.task_root, "prd.md"), "# PRD\n");

    // build-request composes the whole terminal produce request from one intent line: canonical
    // document defaults, the built artifact, and internal fingerprint resolution — its output is
    // exactly an envelope output, with nothing left to transcribe.
    writeFileSync(join(bootstrap.value.authority.task_root, "ask.md"), "Ship the CLI.\n");
    const composed = cli(fixture.root, "build-request", { intent_id: "produce-prd" });
    expect(composed).toMatchObject({ status: 0, value: { ok: true, value: { tool: "archflow_state" } } });
    const composedRequest = composed.value.value.request;
    expect(composedRequest.input).toMatchObject({
      task_id: task, intent_id: "produce-prd", step: "produce", status: "succeeded",
      input_fingerprint: composed.value.value.input_fingerprint,
      artifact: {
        artifact_kind: "document", document_path: "prd.md",
        input_fingerprint: composed.value.value.input_fingerprint,
        declared_inputs: [{ input_id: "user-ask" }],
      },
    });
    const builtArtifact = composedRequest.input.artifact;
    expect(cli(fixture.root, "validate", { kind: "document", value: builtArtifact }))
      .toMatchObject({ status: 0, value: { artifact_kind: "document" } });
    const composedFixedPoint = cli(fixture.root, "envelope", composedRequest);
    expect(composedFixedPoint).toMatchObject({ status: 0, value: { ok: true, value: {
      request_digest: composed.value.value.request_digest,
      artifact_digest: composed.value.value.artifact_digest,
    } } });

    // build-request composes an implementation-output produce request once the durable position
    // is a phase-impl produce step; the same command covers both artifact families.
    const baseCommit = git(fixture.root, "rev-parse", "HEAD");
    writeFileSync(join(fixture.root, "README.md"), "repository changed\n");
    const statePath = join(bootstrap.value.authority.task_root, "state.json");
    const stateBytesBefore = readFileSync(statePath);
    const { last_transition: _transition, ...stateWithoutTransition } = JSON.parse(stateBytesBefore.toString("utf8"));
    writeFileSync(statePath, canonicalDocument({
      ...stateWithoutTransition,
      phase_instance: "phase-impl-1", step: "produce", status: "running",
    }).bytes);
    const verificationPath = join(fixture.root, ".archflow", "runtime", "tasks", task, "cache", "phases", "1", "verification.txt");
    mkdirSync(dirname(verificationPath), { recursive: true });
    writeFileSync(verificationPath, "npm test: passed\n");
    const revisedPhaseDesign = join(bootstrap.value.authority.task_root, "phases", "1", "design.md");
    mkdirSync(dirname(revisedPhaseDesign), { recursive: true });
    writeFileSync(revisedPhaseDesign, "# Revised phase 1 design\n");
    const implementation = cli(fixture.root, "build-request", {
      intent_id: "produce-impl", kind: "produce",
      implementation: {
        base_commit: baseCommit, outputs: ["README.md"], restore_targets: ["README.md"],
        parent_documents: [{ document_path: "prd.md", role: "prd" }], declared_inputs: [],
      },
    });
    expect(implementation).toMatchObject({ status: 0, value: { ok: true, value: { tool: "archflow_state" } } });
    const implementationArtifact = implementation.value.value.request.input.artifact;
    const phaseDesignOutput = `.archflow/tasks/${task}/phases/1/design.md`;
    expect(implementationArtifact).toMatchObject({
      artifact_kind: "implementation-output",
      outputs: expect.arrayContaining([expect.objectContaining({ path: phaseDesignOutput })]),
      restore_targets: expect.arrayContaining([phaseDesignOutput]),
      parent_documents: expect.arrayContaining([expect.objectContaining({
        document_path: "phases/1/design.md",
        role: "phase-design",
      })]),
    });
    expect(cli(fixture.root, "validate", { kind: "implementation-output", value: implementationArtifact }))
      .toMatchObject({ status: 0, value: { artifact_kind: "implementation-output" } });
    writeFileSync(statePath, stateBytesBefore);

    const production = await createProductionServices({
      working_directory: fixture.root, task_id: task, operation: parseSafeCode("cli-envelope-tools"),
    });
    if (!production.ok || production.value.state === undefined) throw new Error("production services unavailable");
    const state = production.value.state.value;
    const common = { schema_version: "1", task_id: task, expected_revision: state.revision, input_fingerprint: placeholder };
    const evidence = {
      set_digest: digest("a"),
      slots: [
        { role: "counter-review", evidence_digest: digest("c"), assurance: "server-attested", producer_family: "claude", reviewer_family: "codex", independence: "opposite-family" },
      ],
    };
    const calls = [
      { tool: "archflow_state", input: { ...common, intent_id: "state-cli", phase_instance: "prd", step: "counter_review", status: "running" } },
      { tool: "archflow_counter_review", input: { ...common, intent_id: "counter-cli", artifact_path: "prd.md" } },
    ];
    for (const call of calls) {
      expect(cli(fixture.root, "envelope", call)).toMatchObject({ status: 0, value: { ok: true, value: { tool: call.tool } } });
    }

    const produceTemplate = {
      ...common, intent_id: "produce-cli", phase_instance: "prd", step: "produce", status: "succeeded",
      artifact: { ...builtArtifact, input_fingerprint: placeholder },
    };
    // One envelope pass resolves the fingerprint into both bound places and returns the exact
    // request the digests describe; no client-side substitute-and-rehash pass exists anymore.
    const produce = cli(fixture.root, "envelope", { tool: "archflow_state", input: produceTemplate });
    expect(produce).toMatchObject({ status: 0, value: { ok: true } });
    const resolved = produce.value.value;
    expect(resolved.request.tool).toBe("archflow_state");
    expect(resolved.request.input.input_fingerprint).toBe(resolved.input_fingerprint);
    expect(resolved.request.input.artifact.input_fingerprint).toBe(resolved.input_fingerprint);
    const identified = identifyTransactionRequest(
      parseToolCall("archflow_state", resolved.request.input),
      production.value.authority,
      resolved.input_fingerprint,
    );
    expect(resolved.request_digest).toBe(identified.request_digest);
    // Envelope over its own output is a fixed point: same digests, same resolved request.
    const fixedPoint = cli(fixture.root, "envelope", resolved.request);
    expect(fixedPoint).toMatchObject({ status: 0, value: { ok: true, value: {
      input_fingerprint: resolved.input_fingerprint,
      request_digest: resolved.request_digest,
    } } });
    expect(fixedPoint.value.value.request).toEqual(resolved.request);

    const gateInput = {
      ...common, intent_id: "gate-cli", phase_instance: "prd", summary: "Approve PRD",
      subject_digest: digest("d"), current_evidence: evidence, kind: "artifact-approval",
      context: { artifact_kind: "prd" }, preview_digest: digest("9"),
      decision: { choice: "approve", reason: "The PRD is ready." },
    };
    const gate = cli(fixture.root, "envelope", { tool: "archflow_gate", input: gateInput });
    expect(gate).toMatchObject({ status: 0, value: { ok: true, value: { gate: {
      decision_path: `.archflow/runtime/tasks/${task}/cache/gates/gate.decision`,
    } } } });
    expect(gate.value.value.request.input.input_fingerprint).toBe(gate.value.value.input_fingerprint);
    expect(gate.value.value.gate.gate_id).toBe(computeGateId({
      task_identity_digest: production.value.authority.task_identity_digest,
      intent_id: gateInput.intent_id as never,
      request_digest: gate.value.value.request_digest,
    }));

    const originGateId = "origin-cli";
    const rule = { rule_id: "review-rule", rule_version: 1 };
    const scope = { operation: "review-trigger", boundary: "subject" };
    const originContext = { constitution: "pass", failed_rules: [], uncertain_rules: [], matched_trigger_rules: [rule], uncertain_trigger_rules: [], eligible_waivers: [{ rule, scope }] };
    const originContextDigest = computeGateContextDigest("constitution-review", originContext as never);
    const request = parseGateRequest({
      schema_version: "1", gate_id: originGateId, intent_id: "origin-intent", request_digest: digest("e"), task_id: task,
      phase_instance: "prd", summary: "Review", subject_digest: digest("f"), context_digest: originContextDigest,
      current_evidence: evidence, kind: "constitution-review", context: originContext,
      allowed_decisions: ["approve", "revise", "reject", "waiver-requested", "cancel"], opened_at_revision: parseSafeInteger(state.revision),
    });
    const originAuthority = join(production.value.authority.task_root, "authority", "decisions", originGateId);
    mkdirSync(originAuthority, { recursive: true });
    writeFileSync(join(originAuthority, "request.json"), canonicalDocument(request).bytes);
    const waiver = cli(fixture.root, "envelope", { tool: "archflow_waiver", input: {
      ...common, intent_id: "waiver-cli", rationale: "Rule does not apply.",
      preview_digest: digest("9"), decision: { choice: "grant", reason: "Grant this bounded exception." },
      origin: { origin_gate_id: originGateId, origin_decision_digest: digest("1"), origin_context_digest: originContextDigest,
        task_id: task, phase_instance: "prd", subject_digest: request.subject_digest,
        current_evidence_set_digest: evidence.set_digest, rule, scope },
    } });
    expect(waiver).toMatchObject({ status: 0, value: { ok: true, value: { tool: "archflow_waiver", gate: {
      decision_path: `.archflow/runtime/tasks/${task}/cache/gates/gate.decision`,
    } } } });

    const status = cli(fixture.root, "status");
    expect(status).toMatchObject({ status: 0, value: { ok: true, value: {
      task_id: task, state: "active", revision: state.revision, phase_instance: "prd", step: "produce", status: "running",
      input_fingerprint: state.input_fingerprint, config: { verified: true }, next_action: { code: expect.any(String) },
    } } });
  }, TIMEOUT);

  it("does not read stdin for status", async () => {
    const fixture = await repository();
    const child = spawn(process.execPath, [localBundle, "status", "--task", task], {
      cwd: fixture.root, env: gitEnvironment, stdio: ["pipe", "pipe", "pipe"],
    });
    const result = await new Promise<{ code: number | null; stdout: string }>((resolveResult, reject) => {
      let stdout = "";
      child.stdout.setEncoding("utf8");
      child.stdout.on("data", (chunk: string) => { stdout += chunk; });
      const timer = setTimeout(() => { child.kill("SIGKILL"); reject(new Error("status waited for stdin")); }, 5_000);
      child.once("error", reject);
      child.once("exit", (code) => { clearTimeout(timer); resolveResult({ code, stdout }); });
    });
    expect(result.code).toBe(0);
    expect(JSON.parse(result.stdout)).toMatchObject({ ok: true, value: { state: "missing" } });
    child.stdin.destroy();
  }, TIMEOUT);

  it("archflow-local reports a failed result through the process exit code", async () => {
    const fixture = await repository();
    // A structured project failure keeps its full JSON body on stdout — scripts still parse the
    // error — while the exit code turns nonzero so an unchecked shell pipeline cannot mistake the
    // failure for success.
    const unavailable = cli(fixture.root, "envelope", {
      tool: "archflow_gate",
      input: { schema_version: "1", task_id: task, intent_id: "missing-state", expected_revision: 0,
        input_fingerprint: digest("0"), phase_instance: "prd", summary: "Missing", subject_digest: digest("1"),
        current_evidence: { set_digest: digest("2"), slots: [
          { role: "counter-review", evidence_digest: digest("4"), assurance: "server-attested", producer_family: "claude", reviewer_family: "codex", independence: "opposite-family" },
        ] }, kind: "artifact-approval", context: { artifact_kind: "prd" }, preview_digest: digest("3"),
        decision: { choice: "approve", reason: "Approve the missing-state fixture." } },
    });
    expect(unavailable).toMatchObject({ status: 1, value: { ok: false, error: { code: "STATE_MISSING" } } });

    const composerUnavailable = cli(fixture.root, "build-request", { intent_id: "no-state" });
    expect(composerUnavailable).toMatchObject({ status: 1, value: { ok: false, error: { code: "STATE_MISSING" } } });
  }, TIMEOUT);
});

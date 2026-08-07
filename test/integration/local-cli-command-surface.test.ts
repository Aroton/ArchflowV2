import { spawn, spawnSync, execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
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
  git(root, "add", "--", ".gitattributes", ".archflow/workflow.yaml", ".archflow/constitution", ".archflow/config.yaml");
  git(root, "commit", "-q", "-m", "policy");
  const staged = await stageTaskInitialization({ working_directory: root, task_id: task });
  if (!staged.ok) throw new Error(staged.error.code);
  return { root, initialization: staged.value };
}

describe("bundled local CLI", () => {
  it("wires all envelopes, the no-state identification seam, builders, validation, and full status", async () => {
    const fixture = await repository();
    const placeholder = digest("0");
    const initialInput = {
      schema_version: "1", task_id: task, intent_id: "initialize-cli", expected_revision: 0,
      input_fingerprint: placeholder, phase_instance: "prd", step: "produce", status: "running",
      artifact: fixture.initialization,
    };
    const first = cli(fixture.root, "envelope", { tool: "archflow_state", input: initialInput });
    expect(first).toMatchObject({ status: 0, value: { ok: true, value: { tool: "archflow_state" } } });

    const bootstrap = await createProductionServices({
      working_directory: fixture.root, task_id: task, operation: parseSafeCode("cli-bootstrap"),
    });
    if (!bootstrap.ok || bootstrap.value.state !== undefined) throw new Error("bootstrap services unavailable");
    const initialized = await runStateInitialization(bootstrap.value.dependencies, {
      authority: bootstrap.value.authority,
      call: parseToolCall("archflow_state", { ...initialInput, input_fingerprint: first.value.value.input_fingerprint }),
    });
    expect(initialized.ok).toBe(true);
    if (!initialized.ok) return;
    expect(initialized.value.state.value.committed_intent?.request_digest).toBe(first.value.value.request_digest);

    writeFileSync(join(bootstrap.value.authority.task_root, "prd.md"), "# PRD\n");
    const built = cli(fixture.root, "build-document", {
      phase_instance: "prd", step: "produce", document_path: "prd.md", declared_inputs: [],
      input_fingerprint: initialized.value.state.value.input_fingerprint,
    });
    expect(built).toMatchObject({ status: 0, value: { ok: true, value: { artifact_kind: "document", document_path: "prd.md" } } });
    expect(cli(fixture.root, "validate", { kind: "document", value: built.value.value }))
      .toMatchObject({ status: 0, value: { artifact_kind: "document" } });

    const baseCommit = git(fixture.root, "rev-parse", "HEAD");
    writeFileSync(join(fixture.root, "README.md"), "repository changed\n");
    const implementation = cli(fixture.root, "build-implementation-output", {
      phase_instance: "phase-impl-1", step: "produce", base_commit: baseCommit,
      outputs: ["README.md"], restore_targets: ["README.md"],
      parent_documents: [{ document_path: "prd.md", role: "prd" }], declared_inputs: [],
      input_fingerprint: initialized.value.state.value.input_fingerprint,
    });
    expect(implementation).toMatchObject({ status: 0, value: { ok: true, value: { artifact_kind: "implementation-output" } } });
    expect(cli(fixture.root, "validate", { kind: "implementation-output", value: implementation.value.value }))
      .toMatchObject({ status: 0, value: { artifact_kind: "implementation-output" } });

    const production = await createProductionServices({
      working_directory: fixture.root, task_id: task, operation: parseSafeCode("cli-envelope-tools"),
    });
    if (!production.ok || production.value.state === undefined) throw new Error("production services unavailable");
    const state = production.value.state.value;
    const common = { schema_version: "1", task_id: task, expected_revision: state.revision, input_fingerprint: placeholder };
    const evidence = {
      set_digest: digest("a"),
      slots: [
        { role: "self-review", evidence_digest: digest("b"), assurance: "agent-declared", producer_family: "claude", reviewer_family: "claude", independence: "same-family-self" },
        { role: "counter-review", evidence_digest: digest("c"), assurance: "server-attested", producer_family: "claude", reviewer_family: "codex", independence: "opposite-family" },
      ],
    };
    const rubric = { schema_version: "1", kind: "artifact", mode: "adversarial", criteria: [{ id: "scope", text: "Check scope.", blocking: true }] };
    const calls = [
      { tool: "archflow_state", input: { ...common, intent_id: "state-cli", phase_instance: "prd", step: "self_review", status: "running" } },
      { tool: "archflow_counter_review", input: { ...common, intent_id: "counter-cli", artifact_path: "prd.md", rubric } },
      { tool: "archflow_adjudicate", input: { ...common, intent_id: "adjudicate-cli", artifact_path: "prd.md", upstream_paths: [] } },
    ];
    for (const call of calls) {
      expect(cli(fixture.root, "envelope", call)).toMatchObject({ status: 0, value: { ok: true, value: { tool: call.tool } } });
    }

    const produceTemplate = {
      ...common, intent_id: "produce-cli", phase_instance: "prd", step: "produce", status: "succeeded",
      artifact: { ...built.value.value, input_fingerprint: placeholder },
    };
    const produceFirst = cli(fixture.root, "envelope", { tool: "archflow_state", input: produceTemplate });
    expect(produceFirst).toMatchObject({ status: 0, value: { ok: true } });
    const produceInput = {
      ...produceTemplate,
      input_fingerprint: produceFirst.value.value.input_fingerprint,
      artifact: { ...produceTemplate.artifact, input_fingerprint: produceFirst.value.value.input_fingerprint },
    };
    const produceSecond = cli(fixture.root, "envelope", { tool: "archflow_state", input: produceInput });
    expect(produceSecond).toMatchObject({ status: 0, value: { ok: true } });
    const identified = identifyTransactionRequest(
      parseToolCall("archflow_state", produceInput),
      production.value.authority,
      produceSecond.value.value.input_fingerprint,
    );
    expect(produceSecond.value.value.request_digest).toBe(identified.request_digest);

    const gateInput = {
      ...common, intent_id: "gate-cli", phase_instance: "prd", summary: "Approve PRD",
      subject_digest: digest("d"), current_evidence: evidence, kind: "artifact-approval",
      context: { artifact_kind: "prd" },
    };
    const gate = cli(fixture.root, "envelope", { tool: "archflow_gate", input: gateInput });
    expect(gate).toMatchObject({ status: 0, value: { ok: true, value: { gate: { decision_path: "gate.decision" } } } });
    expect(gate.value.value.gate.gate_id).toBe(computeGateId({
      task_identity_digest: production.value.authority.task_identity_digest,
      intent_id: gateInput.intent_id as never,
      request_digest: gate.value.value.request_digest,
    }));

    const originGateId = "origin-cli";
    const rule = { rule_id: "review-rule", rule_version: 1 };
    const scope = { operation: "review-trigger", boundary: "subject" };
    const originContext = { matched_rules: [rule], uncertain_rules: [], eligible_waiver_rules: [rule], waiver_scope: scope };
    const originContextDigest = computeGateContextDigest("review-trigger", originContext as never);
    const request = parseGateRequest({
      schema_version: "1", gate_id: originGateId, intent_id: "origin-intent", request_digest: digest("e"), task_id: task,
      phase_instance: "prd", summary: "Review", subject_digest: digest("f"), context_digest: originContextDigest,
      current_evidence: evidence, kind: "review-trigger", context: originContext,
      allowed_decisions: ["approve", "revise", "reject", "waiver-requested", "cancel"], opened_at_revision: parseSafeInteger(state.revision),
    });
    mkdirSync(join(production.value.authority.task_root, "decisions", originGateId), { recursive: true });
    writeFileSync(join(production.value.authority.task_root, "decisions", originGateId, "request.json"), canonicalDocument(request).bytes);
    const waiver = cli(fixture.root, "envelope", { tool: "archflow_waiver", input: {
      ...common, intent_id: "waiver-cli", rationale: "Rule does not apply.",
      origin: { origin_gate_id: originGateId, origin_decision_digest: digest("1"), origin_context_digest: originContextDigest,
        task_id: task, phase_instance: "prd", subject_digest: request.subject_digest,
        current_evidence_set_digest: evidence.set_digest, rule, scope },
    } });
    expect(waiver).toMatchObject({ status: 0, value: { ok: true, value: { tool: "archflow_waiver", gate: { decision_path: "gate.decision" } } } });

    const status = cli(fixture.root, "status");
    expect(status).toMatchObject({ status: 0, value: { ok: true, value: {
      task_id: task, state: "active", revision: state.revision, phase_instance: "prd", step: "produce", status: "running",
      input_fingerprint: state.input_fingerprint, config: { verified: true }, next_action: { code: expect.any(String) },
    } } });
  }, TIMEOUT);

  it("does not read stdin for status and keeps structured project failures on exit zero", async () => {
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

    const unavailable = cli(fixture.root, "envelope", {
      tool: "archflow_gate",
      input: { schema_version: "1", task_id: task, intent_id: "missing-state", expected_revision: 0,
        input_fingerprint: digest("0"), phase_instance: "prd", summary: "Missing", subject_digest: digest("1"),
        current_evidence: { set_digest: digest("2"), slots: [
          { role: "self-review", evidence_digest: digest("3"), assurance: "agent-declared", producer_family: "claude", reviewer_family: "claude", independence: "same-family-self" },
          { role: "counter-review", evidence_digest: digest("4"), assurance: "server-attested", producer_family: "claude", reviewer_family: "codex", independence: "opposite-family" },
        ] }, kind: "artifact-approval", context: { artifact_kind: "prd" } },
    });
    expect(unavailable).toMatchObject({ status: 0, value: { ok: false, error: { code: "STATE_MISSING" } } });
  }, TIMEOUT);
});

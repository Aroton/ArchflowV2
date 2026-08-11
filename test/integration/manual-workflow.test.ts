import { spawn, spawnSync, execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";

import { canonicalDocument, canonicalJsonDigest, parseGitOid } from "../../src/contracts/canonical.js";
import { connectionContextFactory, createInvocationContext } from "../../src/contracts/contexts.js";
import { parseGateDecisionRecord, parseGateRequest } from "../../src/contracts/durable-gate.js";
import { parseSafeCode, parseSha256Digest, parseTaskSlug } from "../../src/contracts/evidence.js";
import { computeGateContextDigest, computeInputFingerprint } from "../../src/contracts/fingerprints.js";
import { parsePhaseInstanceId } from "../../src/contracts/phase-instance.js";
import { parseToolCall } from "../../src/contracts/mcp-tools.js";
import { scaffoldRepositoryAssets } from "../../src/init/assets.js";
import { stageTaskInitialization } from "../../src/init/task-initialization.js";
import { computeCallEnvelope } from "../../src/local/envelope.js";
import { createToolHandlers } from "../../src/mcp/handlers/index.js";
import { createToolBoundary } from "../../src/mcp/server.js";
import { runStateInitialization } from "../../src/state/initialization.js";
import { createProductionServices } from "../../src/state/production.js";

const TIMEOUT = 30_000;
const repositoryRoot = resolve(import.meta.dirname, "../..");
const task = "manual-workflow";
const roots: string[] = [];
let bundleRoot = "";
let localBundle = "";

const environment: NodeJS.ProcessEnv = {
  ...process.env,
  GIT_CONFIG_GLOBAL: "/dev/null",
  GIT_CONFIG_SYSTEM: "/dev/null",
  GIT_AUTHOR_NAME: "ArchFlow Test",
  GIT_AUTHOR_EMAIL: "test@example.invalid",
  GIT_COMMITTER_NAME: "ArchFlow Test",
  GIT_COMMITTER_EMAIL: "test@example.invalid",
};

beforeAll(async () => {
  bundleRoot = await mkdtemp(resolve(tmpdir(), "archflow-local-manual-"));
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
  return execFileSync("git", argv, { cwd: root, env: environment, encoding: "utf8" }).trim();
}

function cli(root: string, command: string, value?: unknown) {
  const result = spawnSync(process.execPath, [localBundle, command, "--task", task], {
    cwd: root, env: environment,
    input: value === undefined ? undefined : JSON.stringify(value),
    encoding: "utf8", timeout: TIMEOUT,
  });
  return { status: result.status, stderr: result.stderr, value: result.stdout === "" ? undefined : JSON.parse(result.stdout) };
}

async function repository(): Promise<string> {
  const root = mkdtempSync(join(tmpdir(), "archflow-manual-repo-"));
  roots.push(root);
  git(root, "-c", "init.defaultBranch=main", "init", "-q");
  writeFileSync(join(root, "README.md"), "repository\n");
  git(root, "add", "--", "README.md");
  git(root, "commit", "-q", "-m", "root");
  const scaffolded = await scaffoldRepositoryAssets({ working_directory: root });
  if (!scaffolded.ok) throw new Error(scaffolded.error.code);
  git(root, "add", "--", ".gitattributes", ".archflow/workflow.yaml", ".archflow/constitution", ".archflow/config.yaml");
  git(root, "commit", "-q", "-m", "policy");
  mkdirSync(join(root, ".archflow", "tasks"), { recursive: true });
  return root;
}

async function invokeState(root: string, input: unknown, id: string) {
  const connection = connectionContextFactory.captureStartup({
    connection_id: `${id}-connection`,
    startup_repository_candidate: { working_directory: root },
  }).initialize({
    client: { name: "codex-mcp-client", version: "0.146.0" },
    host: "codex",
    protocol_version: "2025-11-25",
  });
  const invocation = createInvocationContext(connection, {
    invocation_id: id,
    transport_metadata: { request_id: `${id}-request`, operation: "tools/call" },
  }, new AbortController().signal);
  return createToolBoundary(createToolHandlers()).invoke("archflow_state", input, invocation);
}

async function initializeNormalState(root: string): Promise<void> {
  const taskId = parseTaskSlug(task);
  const staged = await stageTaskInitialization({ working_directory: root, task_id: taskId });
  if (!staged.ok) throw new Error(staged.error.code);
  const services = await createProductionServices({
    working_directory: root,
    task_id: taskId,
    operation: parseSafeCode("manual-normal-bootstrap"),
  });
  if (!services.ok) throw new Error(services.error.code);
  const placeholder = parseSha256Digest("0".repeat(64));
  const initialInput = {
    schema_version: "1" as const,
    task_id: taskId,
    intent_id: "manual-normal-initialize",
    expected_revision: 0,
    input_fingerprint: placeholder,
    phase_instance: "prd" as const,
    step: "produce" as const,
    status: "running" as const,
    artifact: staged.value,
  };
  const envelope = await computeCallEnvelope(services.value, { tool: "archflow_state", input: initialInput });
  if (!envelope.ok) throw new Error(envelope.error.code);
  const call = parseToolCall("archflow_state", {
    ...initialInput,
    input_fingerprint: envelope.value.input_fingerprint,
  });
  const initialized = await runStateInitialization(services.value.dependencies, {
    authority: services.value.authority,
    call,
  });
  if (!initialized.ok) throw new Error(initialized.error.code);
}

async function committedImplementationState(root: string, plannedFinalPhase: number): Promise<{
  gate_id: string;
  state_revision: number;
  result_id: string;
  artifact: any;
}> {
  await initializeNormalState(root);
  const statePath = join(root, ".archflow", "tasks", task, "state.json");
  let state = JSON.parse(readFileSync(statePath, "utf8"));
  const fingerprint = computeInputFingerprint({
    schema_version: "1", workflow_digest: state.workflow_digest, config_digest: state.config_digest,
    constitution_digest: state.constitution_digest, artifact_identities: [], upstream_identities: [],
    rubric_digest: canonicalJsonDigest({}), phase_instance: parsePhaseInstanceId("phase-impl-2"), declared_inputs: [],
  });
  writeFileSync(join(root, ".archflow", "tasks", task, "design.md"), "# Design\n");
  writeFileSync(statePath, canonicalDocument({
    ...state, phase_instance: "phase-impl-2", step: "produce", status: "running", attempt: 1,
    input_fingerprint: fingerprint, planned_final_phase: plannedFinalPhase,
  }).bytes);
  const baseCommit = git(root, "rev-parse", "HEAD");
  writeFileSync(join(root, "README.md"), `implementation for phase ${plannedFinalPhase}\n`);
  const built = cli(root, "build-implementation-output", {
    phase_instance: "phase-impl-2", step: "produce", base_commit: baseCommit,
    outputs: ["README.md"], restore_targets: ["README.md"],
    parent_documents: [{ document_path: "design.md", role: "design" }], declared_inputs: [],
    input_fingerprint: fingerprint,
  });
  expect(built, JSON.stringify(built)).toMatchObject({ status: 0, value: { ok: true } });
  const produced = await invokeState(root, {
    schema_version: "1", task_id: task, intent_id: `manual-implementation-${plannedFinalPhase}`,
    expected_revision: state.revision, phase_instance: "phase-impl-2", step: "produce", status: "succeeded",
    input_fingerprint: fingerprint, artifact: built.value.value,
  }, `manual-implementation-${plannedFinalPhase}`);
  expect(produced).toMatchObject({ kind: "project-result", result: { ok: true } });
  state = JSON.parse(readFileSync(statePath, "utf8"));
  const reference = state.authoritative_results.find((candidate: any) =>
    candidate.phase_instance === "phase-impl-2" && candidate.step === "produce");
  expect(reference).toBeDefined();
  const subjectDigest = canonicalJsonDigest(built.value.value);
  const gateId = `manual-commit-${plannedFinalPhase}`;
  const context = {
    target_ref: git(root, "symbolic-ref", "HEAD"), diff_digest: built.value.value.diff_digest,
    current_artifact_digests: [subjectDigest],
    parent_document_digests: built.value.value.parent_documents.map((parent: any) => parent.content_digest).sort(),
  };
  const contextDigest = computeGateContextDigest("commit-authorization", context);
  const evidence = { set_digest: parseSha256Digest("a".repeat(64)), slots: [
    { role: "counter-review", evidence_digest: parseSha256Digest("c".repeat(64)), assurance: "server-attested", producer_family: "claude", reviewer_family: "codex", independence: "opposite-family" },
  ] } as const;
  const request = parseGateRequest({
    schema_version: "1", gate_id: gateId, intent_id: `manual-commit-intent-${plannedFinalPhase}`,
    request_digest: parseSha256Digest("d".repeat(64)), task_id: task, phase_instance: "phase-impl-2",
    summary: "Authorize implementation commit", subject_digest: subjectDigest, context_digest: contextDigest,
    current_evidence: evidence, kind: "commit-authorization", context,
    allowed_decisions: ["authorize-commit", "revise", "abort", "cancel"], opened_at_revision: state.revision,
  });
  const decision = parseGateDecisionRecord({
    schema_version: "1", gate_id: gateId, task_id: task, phase_instance: "phase-impl-2",
    kind: "commit-authorization", subject_digest: subjectDigest, context_digest: contextDigest,
    supplemental: [], outcome: "decided", envelope: {
      schema_version: "1", gate_id: gateId, task_id: task, phase_instance: "phase-impl-2",
      kind: "commit-authorization", subject_digest: subjectDigest, context_digest: contextDigest,
      human_provenance: { schema_version: "1", actor_class: "human", assurance: "declared-local-trace",
        channel: "archflow-local", decision_event_id: `manual-commit-decision-${plannedFinalPhase}`,
        helper_invocation_id: `manual-commit-helper-${plannedFinalPhase}`, recorded_at: "2026-08-03T12:00:00.000Z" },
      payload: { decision: "authorize-commit", reason: "Reviewed and committed" },
    },
  });
  const archive = join(root, ".archflow", "tasks", task, "decisions", gateId);
  mkdirSync(archive, { recursive: true });
  writeFileSync(join(archive, "request.json"), canonicalDocument(request).bytes);
  writeFileSync(join(archive, "decision.json"), canonicalDocument(decision).bytes);
  git(root, "add", "--", "README.md");
  git(root, "commit", "-q", "-m", `phase ${plannedFinalPhase} implementation`);
  writeFileSync(statePath, canonicalDocument({
    ...state, step: "adjudicate", status: "succeeded", planned_final_phase: plannedFinalPhase,
    approvals: [{ gate_id: gateId, gate_kind: "commit-authorization", subject_digest: subjectDigest,
      decision_digest: canonicalDocument(decision).digest, resolved_at_revision: state.revision }],
  }).bytes);
  return { gate_id: gateId, state_revision: state.revision, result_id: reference.result_id, artifact: built.value.value };
}

describe("bundled manual workflow", () => {
  it.each(["unexpected-filename", "corrupt-checkpoint"] as const)(
    "keeps representative invalid inventory non-advancing: %s",
    async (variant) => {
      const root = await repository();
      const initialized = cli(root, "task-init");
      expect(initialized).toMatchObject({ status: 0, value: { ok: true } });
      expect(cli(root, "manual-next", {
        schema_version: "1", operation: "bootstrap", initialization: initialized.value.value,
      })).toMatchObject({ status: 0, value: { ok: true } });
      const checkpointRoot = join(root, ".archflow", "tasks", task, "manual", "checkpoints");
      const name = variant === "unexpected-filename"
        ? "README.txt"
        : `999-${"0".repeat(64)}.json`;
      writeFileSync(join(checkpointRoot, name), variant === "unexpected-filename" ? "invalid\n" : "{not-json}\n");
      const status = cli(root, "manual-status");
      expect(status).toMatchObject({
        status: 0,
        value: { ok: true, value: {
          mode: "repair-required",
          next_action: { code: "repair-manual-authority", command: "archflow-local manual-status" },
        } },
      });
      expect(Object.keys(status.value.value).filter((key) => key === "next_action")).toHaveLength(1);
    },
    TIMEOUT,
  );

  it("stops a divergent manual handoff without changing either head or fabricating a record", async () => {
    const parent = mkdtempSync(join(tmpdir(), "archflow-manual-divergent-handoff-"));
    roots.push(parent);
    const upstream = join(parent, "upstream");
    const clone = join(parent, "clone");
    git(parent, "-c", "init.defaultBranch=main", "init", "-q", upstream);
    writeFileSync(join(upstream, "README.md"), "repository\n");
    git(upstream, "add", "--", "README.md");
    git(upstream, "commit", "-q", "-m", "root");
    const scaffolded = await scaffoldRepositoryAssets({ working_directory: upstream });
    if (!scaffolded.ok) throw new Error(scaffolded.error.code);
    git(upstream, "add", "-A");
    git(upstream, "commit", "-q", "-m", "policy");
    git(upstream, "config", "receive.denyCurrentBranch", "updateInstead");
    git(parent, "clone", "-q", upstream, clone);

    const initialized = cli(clone, "task-init");
    expect(initialized).toMatchObject({ status: 0, value: { ok: true } });
    expect(cli(clone, "manual-next", {
      schema_version: "1", operation: "bootstrap", initialization: initialized.value.value,
    })).toMatchObject({ status: 0, value: { ok: true } });
    git(clone, "add", "-A");
    git(clone, "commit", "-q", "-m", "manual checkpoint");
    git(clone, "push", "-q");

    writeFileSync(join(clone, "local.txt"), "local\n");
    git(clone, "add", "--", "local.txt");
    git(clone, "commit", "-q", "-m", "local writer");
    const localHead = git(clone, "rev-parse", "HEAD");
    writeFileSync(join(upstream, "remote.txt"), "remote\n");
    git(upstream, "add", "--", "remote.txt");
    git(upstream, "commit", "-q", "-m", "remote writer");
    const upstreamHead = git(upstream, "rev-parse", "HEAD");
    git(clone, "fetch", "-q");

    const handoff = cli(clone, "manual-handoff", { expected_head: localHead });
    expect(handoff).toMatchObject({
      status: 0,
      value: { ok: false, error: { code: "GIT_DIVERGED" } },
    });
    expect(git(clone, "rev-parse", "HEAD")).toBe(localHead);
    expect(git(clone, "rev-parse", "origin/main")).toBe(upstreamHead);
    expect(() => readFileSync(join(clone, ".archflow", "tasks", task, "maintenance", "handoff-record.json")))
      .toThrow();
  }, TIMEOUT);

  it("builds all three import wrappers and adopts both mature modes through the real handler", async () => {
    const initialRoot = await repository();
    const initialized = cli(initialRoot, "task-init");
    expect(initialized).toMatchObject({ status: 0, value: { ok: true } });
    expect(cli(initialRoot, "manual-next", {
      schema_version: "1", operation: "bootstrap", initialization: initialized.value.value,
    })).toMatchObject({ status: 0, value: { ok: true } });
    expect(cli(initialRoot, "manual-next", {
      schema_version: "1", operation: "step", phase_instance: "prd", step: "produce", status: "failed",
    })).toMatchObject({ status: 0, value: { ok: true } });
    const initialImport = cli(initialRoot, "manual-next", {
      schema_version: "1", operation: "import-call", intent_id: "manual-import-initial",
    });
    expect(initialImport).toMatchObject({ status: 0, value: { ok: true, value: { call: { input: {
      expected_revision: 0, artifact: { import_mode: "initial" },
    } } } } });
    const initialHandled = await invokeState(initialRoot, initialImport.value.value.call.input, "manual-initial-handler");
    expect(initialHandled).toMatchObject({ kind: "project-result", result: { ok: true, value: {
      revision: 1, status: "failed",
    } } });
    const initialState = JSON.parse(readFileSync(
      join(initialRoot, ".archflow", "tasks", task, "state.json"), "utf8",
    ));
    expect(initialState).toMatchObject({
      input_fingerprint: initialImport.value.value.call.envelope.input_fingerprint,
      committed_intent: { request_digest: initialImport.value.value.call.envelope.request_digest },
    });

    const matureRoot = await repository();
    await initializeNormalState(matureRoot);
    const anchored = cli(matureRoot, "manual-next", {
      schema_version: "1", operation: "step", phase_instance: "prd", step: "produce", status: "failed",
    });
    expect(anchored).toMatchObject({ status: 0, value: { ok: true, value: { revision: 2 } } });
    const stateAnchoredImport = cli(matureRoot, "manual-next", {
      schema_version: "1", operation: "import-call", intent_id: "manual-import-state-anchor",
    });
    expect(stateAnchoredImport).toMatchObject({ status: 0, value: { ok: true, value: { call: { input: {
      expected_revision: 1, artifact: { import_mode: "state-anchored", state_anchor: { state_revision: 1 } },
    } } } } });
    const anchoredHandled = await invokeState(
      matureRoot,
      stateAnchoredImport.value.value.call.input,
      "manual-state-anchored-handler",
    );
    expect(anchoredHandled).toMatchObject({ kind: "project-result", result: { ok: true, value: {
      revision: 2, status: "failed",
    } } });
    const anchoredState = JSON.parse(readFileSync(
      join(matureRoot, ".archflow", "tasks", task, "state.json"), "utf8",
    ));
    expect(anchoredState).toMatchObject({
      input_fingerprint: stateAnchoredImport.value.value.call.envelope.input_fingerprint,
      committed_intent: { request_digest: stateAnchoredImport.value.value.call.envelope.request_digest },
    });
    const anchoredReplay = await invokeState(matureRoot, {
      ...stateAnchoredImport.value.value.call.input,
      expected_revision: 2,
    }, "manual-state-anchored-replay");
    expect(anchoredReplay).toEqual(anchoredHandled);

    const continued = cli(matureRoot, "manual-next", {
      schema_version: "1", operation: "step", phase_instance: "prd", step: "produce", status: "running",
    });
    expect(continued).toMatchObject({ status: 0, value: { ok: true, value: { revision: 3 } } });
    const continuationImport = cli(matureRoot, "manual-next", {
      schema_version: "1", operation: "import-call", intent_id: "manual-import-continuation",
    });
    expect(continuationImport).toMatchObject({ status: 0, value: { ok: true, value: { call: { input: {
      expected_revision: 2, artifact: { import_mode: "continuation", expected_state_revision: 2 },
    } } } } });
    const continuedHandled = await invokeState(
      matureRoot,
      continuationImport.value.value.call.input,
      "manual-continuation-handler",
    );
    expect(continuedHandled).toMatchObject({ kind: "project-result", result: { ok: true, value: {
      revision: 3, status: "running",
    } } });
    const continuedState = JSON.parse(readFileSync(
      join(matureRoot, ".archflow", "tasks", task, "state.json"), "utf8",
    ));
    expect(continuedState).toMatchObject({
      input_fingerprint: continuationImport.value.value.call.envelope.input_fingerprint,
      committed_intent: { request_digest: continuationImport.value.value.call.envelope.request_digest },
    });
    const continuationReplay = await invokeState(matureRoot, {
      ...continuationImport.value.value.call.input,
      expected_revision: 3,
    }, "manual-continuation-replay");
    expect(continuationReplay).toEqual(continuedHandled);

    const statePath = join(matureRoot, ".archflow", "tasks", task, "state.json");
    const beforeRejectedImport = readFileSync(statePath);
    const rejected = await invokeState(matureRoot, {
      ...continuationImport.value.value.call.input,
      intent_id: "manual-import-stale-predecessor",
      expected_revision: 1,
    }, "manual-rejected-mature-handler");
    expect(rejected).toMatchObject({ kind: "project-result", result: { ok: false } });
    expect(readFileSync(statePath)).toEqual(beforeRejectedImport);
  }, TIMEOUT);

  it("derives gate and waiver archives from selectors before checkpoint import", async () => {
    const root = await repository();
    const initialized = cli(root, "task-init");
    expect(initialized).toMatchObject({ status: 0, value: { ok: true } });
    expect(cli(root, "manual-next", {
      schema_version: "1", operation: "bootstrap", initialization: initialized.value.value,
    })).toMatchObject({ status: 0, value: { ok: true } });
    const checkpointRoot = join(root, ".archflow", "tasks", task, "manual", "checkpoints");
    const head = () => {
      const names = readdirSync(checkpointRoot);
      const revision = Math.max(...names.map((name) => Number(name.slice(0, name.indexOf("-")))));
      const name = names.find((candidate) => candidate.startsWith(`${revision}-`))!;
      return JSON.parse(readFileSync(join(checkpointRoot, name), "utf8"));
    };

    mkdirSync(join(root, ".archflow", "tasks", task), { recursive: true });
    writeFileSync(join(root, ".archflow", "tasks", task, "prd.md"), "# PRD\n");
    const built = cli(root, "build-document", {
      phase_instance: "prd", step: "produce", document_path: "prd.md", declared_inputs: [],
      input_fingerprint: head().input_fingerprint,
    });
    expect(built).toMatchObject({ status: 0, value: { ok: true } });
    expect(cli(root, "manual-next", {
      schema_version: "1", operation: "step", phase_instance: "prd", step: "produce", status: "succeeded",
      result: { result_id: "manual-gate-produce", artifact: built.value.value },
    })).toMatchObject({ status: 0, value: { ok: true } });
    const resultRoot = join(root, ".archflow", "tasks", task, "results", "sha256");
    const produceManifest = JSON.parse(readFileSync(join(resultRoot, readdirSync(resultRoot)[0]!, "manifest.json"), "utf8"));
    const subjectDigest = produceManifest.artifact_digest;
    const review = () => ({
      schema_version: "1", task_id: task, phase_instance: "prd",
      step: "counter_review", role: "counter-review",
      subject_digest: subjectDigest, input_fingerprint: head().input_fingerprint,
      rubric_digest: canonicalJsonDigest({ schema_version: "1", rubric: "manual" }),
      producer_family: "claude", findings: [], matched_rule_versions: [], verdict: "pass", blocking_count: 0,
      assurance: "degraded",
      model_family: "codex", model: "fixture", effort: "unknown",
      reason: "manual fallback",
    });
    {
      expect(cli(root, "manual-next", {
        schema_version: "1", operation: "step", phase_instance: "prd", step: "counter_review", status: "running",
      })).toMatchObject({ status: 0, value: { ok: true } });
      const installed = cli(root, "manual-next", {
        schema_version: "1", operation: "step", phase_instance: "prd",
        step: "counter_review", status: "succeeded",
        result: { result_id: "manual-counter-review", evidence: { kind: "review", evidence: review() } },
      });
      const taskEntries = readdirSync(join(root, ".archflow", "tasks", task)).sort();
      const reviewEntries = taskEntries.includes("reviews")
        ? readdirSync(join(root, ".archflow", "tasks", task, "reviews")).sort()
        : [];
      expect(installed, `counter-review: ${installed.stderr}\n${JSON.stringify(installed.value)}\n${JSON.stringify({ taskEntries, reviewEntries })}`)
        .toMatchObject({ status: 0, value: { ok: true } });
    }

    const rule = { rule_id: "review-rule", rule_version: 1 };
    const scope = { operation: "review-trigger", boundary: "subject" };
    const published = cli(root, "manual-next", {
      schema_version: "1", operation: "gate", action: { kind: "publish", selector: {
        kind: "gate", gate_kind: "review-trigger", summary: "Review PRD",
        context: { matched_rules: [rule], uncertain_rules: [], eligible_waiver_rules: [rule], waiver_scope: scope },
      } },
    });
    const postPublishEntries = readdirSync(join(root, ".archflow", "tasks", task)).sort();
    const decisionEntries = postPublishEntries.includes("decisions")
      ? readdirSync(join(root, ".archflow", "tasks", task, "decisions")).sort()
      : [];
    expect(published, JSON.stringify({ published, postPublishEntries, decisionEntries })).toMatchObject({ status: 0, value: { ok: true, value: {
      kind: "checkpoint", status: { next_action: { code: "resolve-open-gate" } },
    } } });
    const activeGate = JSON.parse(readFileSync(join(root, ".archflow", "tasks", task, "gate.json"), "utf8"));
    const reloadedGate = cli(root, "manual-next", {
      schema_version: "1", operation: "gate", action: { kind: "reload", gate_id: activeGate.gate_id },
    });
    expect(reloadedGate, `${reloadedGate.stderr}\n${JSON.stringify(reloadedGate.value)}`).toMatchObject({ status: 0, value: { ok: true, value: {
      kind: "gate-awaiting", gate: { request: { value: { kind: "review-trigger" } } },
    } } });
    const gate = reloadedGate.value.value.gate;
    const waiverRequested = gate.decision_templates.find((template: any) => template.payload?.decision === "waiver-requested");
    expect(waiverRequested).toBeDefined();
    const provenance = (suffix: string) => ({
      schema_version: "1", actor_class: "human", assurance: "declared-local-trace", channel: "archflow-local",
      decision_event_id: `manual-${suffix}-decision`, helper_invocation_id: `manual-${suffix}-helper`,
      recorded_at: "2026-08-03T12:00:00.000Z",
    });
    writeFileSync(join(root, ".archflow", "tasks", task, "gate.decision"), canonicalDocument({
      ...waiverRequested, human_provenance: provenance("gate"),
    }).bytes);
    const resolvedGate = cli(root, "manual-next", {
      schema_version: "1", operation: "gate", action: {
        kind: "resolve", gate_id: gate.gate_id, input_fingerprint: head().input_fingerprint,
      },
    });
    expect(resolvedGate, JSON.stringify(resolvedGate)).toMatchObject({ status: 0, value: { ok: true } });
    expect(JSON.parse(readFileSync(join(root, ".archflow", "tasks", task, "decisions", gate.gate_id, "decision.json"), "utf8")))
      .toMatchObject({ outcome: "decided", envelope: { payload: { decision: "waiver-requested" } } });

    const publishedWaiver = cli(root, "manual-next", {
      schema_version: "1", operation: "gate", action: { kind: "publish", selector: {
        kind: "waiver", origin_gate_id: gate.gate_id, summary: "Waive review rule", rationale: "Not applicable",
      } },
    });
    expect(publishedWaiver, JSON.stringify(publishedWaiver)).toMatchObject({ status: 0, value: { ok: true, value: {
      kind: "checkpoint", status: { next_action: { code: "resolve-open-gate" } },
    } } });
    const activeWaiver = JSON.parse(readFileSync(join(root, ".archflow", "tasks", task, "gate.json"), "utf8"));
    const reloadedWaiver = cli(root, "manual-next", {
      schema_version: "1", operation: "gate", action: { kind: "reload", gate_id: activeWaiver.gate_id },
    });
    expect(reloadedWaiver).toMatchObject({ status: 0, value: { ok: true, value: {
      kind: "gate-awaiting", gate: { request: { value: { context: { origin: { origin_gate_id: gate.gate_id } } } } },
    } } });
    const waiver = reloadedWaiver.value.value.gate;
    const granted = waiver.decision_templates.find((template: any) => template.granted === true);
    expect(granted).toBeDefined();
    writeFileSync(join(root, ".archflow", "tasks", task, "gate.decision"), canonicalDocument({
      ...granted, human_provenance: provenance("waiver"),
    }).bytes);
    expect(cli(root, "manual-next", {
      schema_version: "1", operation: "gate", action: {
        kind: "resolve", gate_id: waiver.gate_id, input_fingerprint: head().input_fingerprint,
      },
    })).toMatchObject({ status: 0, value: { ok: true } });
    expect(JSON.parse(readFileSync(join(root, ".archflow", "tasks", task, "decisions", waiver.gate_id, "decision.json"), "utf8")))
      .toMatchObject({ outcome: "waiver-decided", granted: true });

    const importCall = cli(root, "manual-next", {
      schema_version: "1", operation: "import-call", intent_id: "manual-gate-waiver-import",
    });
    expect(importCall, JSON.stringify(importCall)).toMatchObject({ status: 0, value: { ok: true, value: { call: { input: {
      artifact: { import_mode: "initial" },
    } } } } });
    const imported = await invokeState(root, importCall.value.value.call.input, "manual-gate-waiver-handler");
    expect(imported).toMatchObject({ kind: "project-result", result: { ok: true } });
    const state = JSON.parse(readFileSync(join(root, ".archflow", "tasks", task, "state.json"), "utf8"));
    expect(state).not.toHaveProperty("open_gate");
    expect(state.waivers).toMatchObject([{ gate_id: waiver.gate_id, granted: true }]);
  }, TIMEOUT);

  it("imports authenticated committed implementation successors and final completion through the real handler", async () => {
    const finalRoot = await repository();
    await committedImplementationState(finalRoot, 2);
    const completedCheckpoint = cli(finalRoot, "manual-next", {
      schema_version: "1", operation: "terminal", terminal: "complete",
    });
    expect(completedCheckpoint, JSON.stringify(completedCheckpoint)).toMatchObject({
      status: 0, value: { ok: true, value: { kind: "checkpoint", status: { next_action: { code: "task-complete" } } } },
    });
    const completedImport = cli(finalRoot, "manual-next", {
      schema_version: "1", operation: "import-call", intent_id: "manual-final-commit-import",
    });
    expect(completedImport, JSON.stringify(completedImport)).toMatchObject({
      status: 0, value: { ok: true, value: { call: { input: { artifact: { import_mode: "state-anchored" } } } } },
    });
    const completed = await invokeState(finalRoot, completedImport.value.value.call.input, "manual-final-commit-handler");
    expect(completed, JSON.stringify(completed)).toMatchObject({ kind: "project-result", result: { ok: true } });
    const completedState = JSON.parse(readFileSync(join(finalRoot, ".archflow", "tasks", task, "state.json"), "utf8"));
    expect(completedState).toMatchObject({ terminal: "complete", planned_final_phase: 2,
      adopted_checkpoint: { revision: completedCheckpoint.value.value.revision } });
    const completedReplay = await invokeState(finalRoot, {
      ...completedImport.value.value.call.input, expected_revision: completedState.revision,
    }, "manual-final-commit-replay");
    expect(completedReplay).toEqual(completed);

    const successorRoot = await repository();
    await committedImplementationState(successorRoot, 3);
    const successorCheckpoint = cli(successorRoot, "manual-next", {
      schema_version: "1", operation: "step", phase_instance: "phase-design-3", step: "produce", status: "running",
    });
    expect(successorCheckpoint, JSON.stringify(successorCheckpoint)).toMatchObject({
      status: 0, value: { ok: true, value: { kind: "checkpoint", status: {
        phase_instance: "phase-design-3", step: "produce", status: "running",
      } } },
    });
    const successorImport = cli(successorRoot, "manual-next", {
      schema_version: "1", operation: "import-call", intent_id: "manual-nonfinal-commit-import",
    });
    expect(successorImport, JSON.stringify(successorImport)).toMatchObject({ status: 0, value: { ok: true } });
    const advanced = await invokeState(successorRoot, successorImport.value.value.call.input, "manual-nonfinal-commit-handler");
    expect(advanced).toMatchObject({ kind: "project-result", result: { ok: true, value: { status: "running" } } });
    const advancedState = JSON.parse(readFileSync(join(successorRoot, ".archflow", "tasks", task, "state.json"), "utf8"));
    expect(advancedState).toMatchObject({ phase_instance: "phase-design-3", planned_final_phase: 3 });
    expect(advancedState).not.toHaveProperty("terminal");
  }, TIMEOUT);

  it("classifies bootstrap without stdin and installs the initial derived checkpoint", async () => {
    const root = await repository();
    const child = spawn(process.execPath, [localBundle, "manual-status", "--task", task], {
      cwd: root, env: environment, stdio: ["pipe", "pipe", "pipe"],
    });
    const first = await new Promise<string>((resolveResult, reject) => {
      let stdout = "";
      child.stdout.setEncoding("utf8");
      child.stdout.on("data", (chunk: string) => { stdout += chunk; });
      const timer = setTimeout(() => { child.kill("SIGKILL"); reject(new Error("manual-status waited for stdin")); }, 5_000);
      child.once("error", reject);
      child.once("exit", (code) => {
        clearTimeout(timer);
        if (code !== 0) reject(new Error(`manual-status exited ${code}`));
        else resolveResult(stdout);
      });
    });
    child.stdin.destroy();
    expect(JSON.parse(first)).toMatchObject({ ok: true, value: { mode: "degraded", next_action: { code: "create-task" } } });

    const initialized = cli(root, "task-init");
    expect(initialized).toMatchObject({ status: 0, value: { ok: true, value: { artifact_kind: "task-initialization" } } });
    const advanced = cli(root, "manual-next", {
      schema_version: "1",
      operation: "bootstrap",
      initialization: initialized.value.value,
    });
    expect(advanced).toMatchObject({
      status: 0,
      value: { ok: true, value: { revision: 1, status: { mode: "degraded", authority_kind: "continuation" } } },
    });
    expect(cli(root, "manual-status")).toMatchObject({
      status: 0, value: { ok: true, value: {
        mode: "degraded", revision: 1, authority_kind: "continuation",
        next_action: { code: "gather-next-manual-milestone" },
      } },
    });

    const second = cli(root, "manual-next", {
      schema_version: "1", operation: "step", phase_instance: "prd", step: "produce", status: "failed",
    });
    expect(second).toMatchObject({
      status: 0,
      value: { ok: true, value: { revision: 2, status: { mode: "degraded", authority_kind: "continuation", revision: 2 } } },
    });
    const checkpointRoot = join(root, ".archflow", "tasks", task, "manual", "checkpoints");
    const secondName = readdirSync(checkpointRoot).find((name) => name.startsWith("2-"));
    expect(secondName).toBeDefined();
    const secondCheckpoint = JSON.parse(readFileSync(join(checkpointRoot, secondName!), "utf8"));
    expect(secondCheckpoint).toMatchObject({ revision: 2, predecessor: { revision: 1 } });

    const recovery = cli(root, "manual-next", {
      schema_version: "1", operation: "import-call", intent_id: "recover-manual-chain",
    });
    expect(recovery).toMatchObject({
      status: 0, value: { ok: true, value: { kind: "import-call", call: {
        input: {
          expected_revision: 0, input_fingerprint: secondCheckpoint.input_fingerprint,
          phase_instance: "prd", step: "produce", status: "failed",
          artifact: { artifact_kind: "manual-checkpoint-import", import_mode: "initial" },
        },
        envelope: { tool: "archflow_state", input_fingerprint: secondCheckpoint.input_fingerprint },
      } } },
    });

    expect(cli(root, "manual-next", {
      schema_version: "1", operation: "terminal", terminal: "complete",
    })).toMatchObject({
      status: 0, value: { ok: false, error: { code: "STATE_INVALID" } },
    });
    expect(cli(root, "manual-next", {
      schema_version: "1", operation: "terminal", terminal: "abandoned",
    })).toMatchObject({
      status: 0, value: { ok: false, error: { code: "STATE_INVALID" } },
    });

    const fallbackInputs = [
      { tool: "archflow_state", proposed_call: { step: "produce" } },
      { tool: "archflow_counter_review", proposed_call: { artifact_path: "prd.md" }, source_artifact: { path: "prd.md" }, rubric: { criteria: [] }, upstreams: [], producer_family: "claude" },
      { tool: "archflow_adjudicate", proposed_call: { artifact_path: "prd.md" }, source_artifact: { path: "prd.md" }, evidence: [], upstreams: [] },
      { tool: "archflow_gate", proposed_call: { kind: "artifact-approval" }, request_material: { kind: "artifact-approval" }, decision_templates: [{ decision: "approve" }] },
      { tool: "archflow_waiver", proposed_call: { origin: "gate" }, request_material: { kind: "waiver" }, decision_templates: [{ granted: false }] },
    ] as const;
    for (const fallbackInput of fallbackInputs) {
      const fallbackResult = cli(root, "manual-next", {
        schema_version: "1",
        operation: "fallback",
        fallback_input: fallbackInput,
      });
      expect(fallbackResult).toMatchObject({
        status: 0,
        value: { ok: true, value: { kind: "fallback", fallback: {
          tool: fallbackInput.tool,
          resume_action: {
            code: "resume-manual-next",
            command: "archflow-local manual-next",
            input: { schema_version: "1", operation: fallbackInput.tool, task_id: task },
          },
        } } },
      });
      const fallback = fallbackResult.value.value.fallback;
      if (fallbackInput.tool === "archflow_state") {
        expect(fallback).toMatchObject({
          kind: "checkpoint",
          material: {
            action: "build-and-install-derived-checkpoint",
            proposed_call: fallbackInput.proposed_call,
          },
        });
      } else if (fallbackInput.tool === "archflow_counter_review") {
        expect(fallback).toMatchObject({
          kind: "prompt",
          material: {
            proposed: {
              proposed_call: fallbackInput.proposed_call,
              source_artifact: fallbackInput.source_artifact,
              rubric: fallbackInput.rubric,
              upstreams: fallbackInput.upstreams,
              reviewer_family: "codex",
            },
          },
        });
        expect(fallback.material.prompt).toContain("Do not change files or advance the workflow.");
      } else if (fallbackInput.tool === "archflow_adjudicate") {
        expect(fallback).toMatchObject({
          kind: "prompt",
          material: { proposed: { evidence: [], upstreams: [] } },
        });
        expect(fallback.material.prompt).toContain("uncertain");
        expect(fallback.material.prompt).toContain("open a human gate");
      } else {
        expect(fallback).toMatchObject({
          kind: "gate-interface",
          material: {
            action: fallbackInput.tool === "archflow_waiver"
              ? "publish-waiver-request-and-decision-templates"
              : "publish-gate-request-and-decision-templates",
            request_material: fallbackInput.request_material,
            decision_templates: fallbackInput.decision_templates,
            stop_until: "A canonical request-bound decision is atomically archived.",
          },
        });
      }
    }
    expect(cli(root, "manual-next", {
      schema_version: "1",
      operation: "fallback",
      fallback_input: { tool: "unknown-tool", proposed_call: {} },
    })).toMatchObject({
      status: 0,
      value: { ok: false, error: { code: "STATE_INVALID" } },
    });

    const retried = cli(root, "manual-next", {
      schema_version: "1", operation: "step", phase_instance: "prd", step: "produce", status: "running",
    });
    expect(retried).toMatchObject({ status: 0, value: { ok: true, value: { revision: 3 } } });
    const thirdName = readdirSync(checkpointRoot).find((name) => name.startsWith("3-"));
    const thirdCheckpoint = JSON.parse(readFileSync(join(checkpointRoot, thirdName!), "utf8"));
    mkdirSync(join(root, ".archflow", "tasks", task), { recursive: true });
    writeFileSync(join(root, ".archflow", "tasks", task, "prd.md"), "# PRD\n");
    const built = cli(root, "build-document", {
      phase_instance: "prd", step: "produce", document_path: "prd.md", declared_inputs: [],
      input_fingerprint: thirdCheckpoint.input_fingerprint,
    });
    expect(built).toMatchObject({ status: 0, value: { ok: true, value: { artifact_kind: "document" } } });
    const resultMilestone = {
      schema_version: "1", operation: "step", phase_instance: "prd", step: "produce", status: "succeeded",
      result: { result_id: "manual-prd", artifact: built.value.value },
    } as const;
    const installedResult = cli(root, "manual-next", resultMilestone);
    expect(installedResult, JSON.stringify(installedResult)).toMatchObject({
      status: 0, value: { ok: true, value: { revision: 4 } },
    });
    const resultRoot = join(root, ".archflow", "tasks", task, "results", "sha256");
    const generations = readdirSync(resultRoot).sort();
    expect(generations).toHaveLength(1);
    // Whether the already-landed state treats a repeated milestone as a no-op or a rejected
    // transition, retry preparation must reuse and revalidate the one immutable generation.
    cli(root, "manual-next", resultMilestone);
    expect(readdirSync(resultRoot).sort()).toEqual(generations);

    // A legacy/caller-authored abandoned checkpoint is never interpreted as authenticated
    // completion. It stops degraded advancement and requires authority repair.
    const checkpointNames = readdirSync(checkpointRoot);
    const lastRevision = Math.max(...checkpointNames.map((name) => Number(name.slice(0, name.indexOf("-")))));
    const lastName = checkpointNames.find((name) => name.startsWith(`${lastRevision}-`))!;
    const lastCheckpoint = JSON.parse(readFileSync(join(checkpointRoot, lastName), "utf8"));
    const predecessorDigest = lastName.slice(lastName.indexOf("-") + 1, -5);
    const abandoned = canonicalDocument({
      ...lastCheckpoint,
      revision: lastRevision + 1,
      predecessor: { revision: lastRevision, checkpoint_digest: predecessorDigest },
      terminal: "abandoned",
    });
    writeFileSync(join(checkpointRoot, `${lastRevision + 1}-${abandoned.digest}.json`), abandoned.bytes);
    expect(cli(root, "manual-status")).toMatchObject({
      status: 0,
      value: { ok: true, value: { mode: "repair-required", next_action: { code: "repair-manual-authority" } } },
    });
  }, TIMEOUT);
});

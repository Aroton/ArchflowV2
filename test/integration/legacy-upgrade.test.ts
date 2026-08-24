import { execFileSync, spawnSync } from "node:child_process";
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";

import { canonicalDocument, canonicalJsonDigest, sha256Bytes } from "../../src/contracts/canonical.js";
import { connectionContextFactory, createInvocationContext } from "../../src/contracts/contexts.js";
import { parseLegacyImportInitialization } from "../../src/contracts/durable-legacy-import.js";
import { parsePathSafeId, parseSafeCode, parseSafeId, parseSafeInteger, parseTaskSlug } from "../../src/contracts/evidence.js";
import { computeGateContextDigest } from "../../src/contracts/fingerprints.js";
import { parseToolCall } from "../../src/contracts/mcp-tools.js";
import { parseTaskPathClaim } from "../../src/contracts/path-claims.js";
import { parsePhaseInstanceId } from "../../src/contracts/phase-instance.js";
import { currentEvidenceSetRef } from "../../src/contracts/trust.js";
import { scaffoldRepositoryAssets } from "../../src/init/assets.js";
import { computeCallEnvelope } from "../../src/local/call-envelope.js";
import { handleState } from "../../src/mcp/handlers/state.js";
import { prepareDocumentResult } from "../../src/mcp/handlers/state-results.js";
import type { ResolvedTaskWorkspacePath } from "../../src/repository/paths.js";
import { buildDocumentArtifact } from "../../src/state/document-artifact.js";
import { openDurableGate } from "../../src/state/gates.js";
import { ensurePayloadParent, ensureResultDirectory } from "../../src/state/layout.js";
import { createProductionServices } from "../../src/state/production.js";
import { installSnapshot } from "../../src/state/snapshots.js";
import { runStateInitialization } from "../../src/state/initialization.js";
import { ordinaryApprovalFacts } from "../helpers/ordinary-approval.js";
import { resolveInterfaceGateDecision } from "../helpers/resolve-interface-gate.js";

const TIMEOUT = 30_000;
const repositoryRoot = resolve(import.meta.dirname, "../..");
const task = parseTaskSlug("legacy-upgraded");
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
  bundleRoot = await mkdtemp(resolve(tmpdir(), "archflow-local-upgrade-"));
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
    cwd: root, env: environment, input: value === undefined ? undefined : JSON.stringify(value),
    encoding: "utf8", timeout: TIMEOUT,
  });
  return { status: result.status, stderr: result.stderr, value: result.stdout === "" ? undefined : JSON.parse(result.stdout) };
}

async function repository(): Promise<{ root: string; source: string; head: string }> {
  const root = mkdtempSync(join(tmpdir(), "archflow-upgrade-repo-"));
  roots.push(root);
  git(root, "-c", "init.defaultBranch=main", "init", "-q");
  writeFileSync(join(root, "README.md"), "repository\n");
  git(root, "add", "--", "README.md");
  git(root, "commit", "-q", "-m", "root");
  const scaffolded = await scaffoldRepositoryAssets({ working_directory: root });
  if (!scaffolded.ok) throw new Error(scaffolded.error.code);
  const source = join(root, ".archflow", "tasks", "legacy-fixture");
  mkdirSync(source, { recursive: true });
  cpSync(join(repositoryRoot, "test", "fixtures", "legacy"), source, { recursive: true });
  git(root, "add", "-A");
  git(root, "commit", "-q", "-m", "policy and legacy source");
  return { root, source, head: git(root, "rev-parse", "HEAD") };
}

async function invokeState(root: string, input: unknown, id: string) {
  const connection = connectionContextFactory.captureStartup({
    connection_id: `${id}-connection`, startup_repository_candidate: { working_directory: root },
  }).initialize({ client: { name: "codex-mcp-client", version: "0.146.0" }, host: "codex", protocol_version: "2025-11-25" });
  // The retained internal state service, invoked directly the way the semantic handler drives it.
  return handleState(parseToolCall("archflow_state", input), createInvocationContext(connection, {
    invocation_id: id, transport_metadata: { request_id: `${id}-request`, operation: "tools/call" },
  }, new AbortController().signal));
}

function stage(root: string, source: string, head: string) {
  const descriptor = {
    source_root: source, task_id: task, policy_base_commit: head,
    import_baseline_commit: head, code_baseline_commit: head,
  };
  const preview = cli(root, "upgrade", { operation: "preview", ...descriptor });
  expect(preview.status, preview.stderr).toBe(0);
  const result = cli(root, "upgrade", {
    operation: "stage", approved_preview_digest: preview.value.value.preview_digest, ...descriptor,
  });
  expect(result.status, result.stderr).toBe(0);
  expect(result.value).toMatchObject({ ok: true, value: { resume_phase: "phase-impl-3" } });
  return result.value.value;
}

async function initializationCall(root: string, initialization: ReturnType<typeof parseLegacyImportInitialization>, intentId: string) {
  const services = await createProductionServices({ working_directory: root, task_id: task, operation: parseSafeCode(intentId) });
  if (!services.ok) throw new Error(services.error.code);
  const draft = {
    schema_version: "1" as const, task_id: task, intent_id: intentId, expected_revision: 0,
    input_fingerprint: "0".repeat(64), phase_instance: "design" as const, step: "produce" as const,
    status: "running" as const, artifact: initialization,
  };
  const envelope = await computeCallEnvelope(services.value, { tool: "archflow_state", input: draft });
  if (!envelope.ok) throw new Error(JSON.stringify(envelope.error));
  return { ...draft, input_fingerprint: envelope.value.input_fingerprint };
}

describe("bundled legacy upgrade workflow", () => {
  it("publishes no visible destination when a staged payload fails authentication", async () => {
    const { root, source, head } = await repository();
    const emitted = stage(root, source, head);
    const initialization = parseLegacyImportInitialization(emitted.initialization);
    const reference = initialization.staged_payload_refs.find((item) =>
      initialization.mapping.some((mapping) => mapping.legacy_path === item.legacy_path));
    if (reference === undefined) throw new Error("mapped payload missing");
    writeFileSync(join(root, `.archflow/runtime/tasks/${task}/cache/imports/${initialization.import_digest}/payload/${reference.legacy_path}`), "tampered\n");
    const call = await initializationCall(root, initialization, "legacy-invalid-payload");
    expect(await invokeState(root, call, "legacy-invalid-payload")).toMatchObject({
      ok: false,
    });
    expect(() => readFileSync(join(root, `.archflow/tasks/${task}/config.yaml`))).toThrow();
    expect(() => readFileSync(join(root, `.archflow/tasks/${task}/state.json`))).toThrow();
  }, TIMEOUT);

  it("stages unchanged legacy material before task services and initializes with replay protection", async () => {
    const { root, source, head } = await repository();
    const emitted = stage(root, source, head);
    const initialization = parseLegacyImportInitialization(emitted.initialization);
    expect(emitted.audit_context).toMatchObject({
      source_identity_digest: initialization.source_identity_digest,
      import_digest: initialization.import_digest,
    });
    expect(emitted.audit_context.code_baseline_digest).not.toBe(emitted.audit_context.policy_baseline_digest);
    expect(emitted.unmapped).toContain("reviews/review-findings.md");
    expect(initialization.mapping).toEqual(expect.arrayContaining([
      expect.objectContaining({ legacy_path: "phases/phase-3-unlogged-review.md", phase_instance: "phase-design-3" }),
      expect.objectContaining({ legacy_path: "phases/phase-2-mapping-log.md", phase_instance: "phase-impl-2" }),
    ]));
    expect(initialization.mapping.some((entry) => entry.legacy_path === "phases/phase-3-unlogged-review-log.md")).toBe(false);
    for (const reference of initialization.staged_payload_refs) {
      expect(readFileSync(join(root, `.archflow/runtime/tasks/${task}/cache/imports/${initialization.import_digest}/payload/${reference.legacy_path}`)))
        .toEqual(readFileSync(join(source, reference.legacy_path)));
    }
    expect(JSON.parse(readFileSync(join(root, emitted.manifest_path), "utf8"))).toEqual(initialization);
    const call = await initializationCall(root, initialization, "legacy-initialization");
    const initialized = await invokeState(root, call, "legacy-initialization");
    expect(initialized).toMatchObject({ ok: true, value: { revision: 1 } });
    expect(readFileSync(join(root, `.archflow/tasks/${task}/prd.md`))).toEqual(readFileSync(join(source, "prd.md")));
    expect(readFileSync(join(root, `.archflow/tasks/${task}/design.md`))).toEqual(readFileSync(join(source, "architecture.md")));
    expect(readFileSync(join(root, `.archflow/tasks/${task}/phases/3/design.md`))).toEqual(readFileSync(join(source, "phases/phase-3-unlogged-review.md")));
    const replayServices = await createProductionServices({ working_directory: root, task_id: task, operation: parseSafeCode("legacy-replay") });
    if (!replayServices.ok) throw new Error(replayServices.error.code);
    expect(await runStateInitialization(replayServices.value.dependencies, {
      authority: replayServices.value.authority, call: parseToolCall("archflow_state", call),
    })).toMatchObject({ ok: true, value: { replayed: true, outcome: { revision: 1 } } });
    const changed = { ...call, artifact: { ...initialization, import_digest: "f".repeat(64) } };
    expect(await runStateInitialization(replayServices.value.dependencies, {
      authority: replayServices.value.authority, call: parseToolCall("archflow_state", changed),
    })).toMatchObject({ ok: false });
  }, TIMEOUT);

  it("opens a real migration audit only over approved design authority and authenticates the resume jump", async () => {
    const { root, source, head } = await repository();
    const emitted = stage(root, source, head);
    const initialization = parseLegacyImportInitialization(emitted.initialization);
    const initialCall = await initializationCall(root, initialization, "legacy-audit-initialization");
    const initialized = await invokeState(root, initialCall, "legacy-audit-initialization");
    expect(initialized).toMatchObject({ ok: true });

    let services = await createProductionServices({ working_directory: root, task_id: task, operation: parseSafeCode("legacy-retain-documents") });
    if (!services.ok || services.value.state === undefined) throw new Error("services unavailable");
    const scanner = { scan: async (candidates: readonly { virtual_path: string }[]) => ({
      schema_version: "1" as const, outcome: "clean" as const, detector_set_id: parseSafeId("upgrade-integration"),
      scanned_paths: candidates.map((candidate) => candidate.virtual_path as never),
    }) };
    const references = [];
    let retainedBytes = parseSafeInteger(0);
    for (const [index, spec] of [
      { phase: parsePhaseInstanceId("prd"), path: parseTaskPathClaim("prd.md") },
      { phase: parsePhaseInstanceId("design"), path: parseTaskPathClaim("design.md") },
    ].entries()) {
      const draft = emitted.draft_sources.find((entry: { destination_path: string }) => entry.destination_path.endsWith(`/${spec.path}`));
      if (draft === undefined) throw new Error(`missing ${spec.path} draft`);
      const seeded = readFileSync(join(root, draft.staged_path));
      writeFileSync(
        join(services.value.authority.task_root, spec.path),
        seeded,
      );
      const artifact = await buildDocumentArtifact(services.value.runner, services.value.authority, {
        phase_instance: spec.phase, step: "produce", document_path: spec.path,
        declared_inputs: [], input_fingerprint: services.value.state.value.input_fingerprint,
      });
      if (!artifact.ok) throw new Error(artifact.error.code);
      const prepared = await prepareDocumentResult({
        services: services.value, artifact: artifact.value, result_id: parseSafeId(`legacy-document-${index}`),
        retained_task_bytes: retainedBytes, measured_at_revision: parseSafeInteger(1), scanner,
      });
      if (!prepared.ok) throw new Error(prepared.error.code);
      await ensureResultDirectory(services.value.authority, prepared.value.reference.result_digest);
      for (const payload of prepared.value.prepared.payloads) {
        await ensurePayloadParent(services.value.authority, prepared.value.reference.result_digest, payload.target.absolute as ResolvedTaskWorkspacePath);
      }
      const installed = await installSnapshot(services.value.dependencies.atomic, prepared.value.prepared,
        prepared.value.manifest_target, services.value.runner.location.worktreeRoot as never);
      if (!installed.ok) throw new Error(installed.error.code);
      references.push(prepared.value.reference);
      retainedBytes = parseSafeInteger(retainedBytes + prepared.value.prepared.manifest.value.accounting.result_bytes);
    }
    const { last_transition: _initialTransition, ...initializedState } = services.value.state.value;
    writeFileSync(services.value.authority.state.absolute, canonicalDocument({
      ...initializedState, phase_instance: "design", step: "triage", status: "succeeded",
      authoritative_results: [...references].sort((left, right) =>
        `${left.phase_instance}\0${left.step}`.localeCompare(`${right.phase_instance}\0${right.step}`)),
      planned_final_phase: 3,
    }).bytes);

    const evidence = currentEvidenceSetRef([
      { role: "counter-review", evidence_digest: sha256Bytes(new TextEncoder().encode("legacy-counter")), assurance: "server-attested", producer_family: "claude", reviewer_family: "codex" },
    ]);
    for (const [index, reference] of references.entries()) {
      services = await createProductionServices({ working_directory: root, task_id: task, operation: parseSafeCode(`legacy-approve-${index}`) });
      if (!services.ok || services.value.state === undefined) throw new Error(`approval services unavailable: ${JSON.stringify(services)}`);
      const retained = await services.value.dependencies.load_retained_result!(reference);
      if (!retained.ok) throw new Error(retained.error.code);
      const subject = retained.value.prepared.manifest.value.artifact_digest;
      if (index === 1) {
        expect(retained.value.prepared.manifest.value.source_artifact).toMatchObject({
          artifact_kind: "document", phase_instance: "design", step: "produce", document_path: "design.md",
        });
      }
      const context = {
        artifact_kind: index === 0 ? "prd" as const : "design" as const,
        ...ordinaryApprovalFacts(index === 0 ? "prd" : "design", subject),
      };
      const gateInput = {
        authority: services.value.authority, expected_revision: services.value.state.value.revision,
        intent_id: parsePathSafeId(`legacy-approve-${index}`), request_digest: sha256Bytes(new TextEncoder().encode(`approve-request-${index}`)),
        input_fingerprint: services.value.state.value.input_fingerprint,
        phase_instance: parsePhaseInstanceId(index === 0 ? "prd" : "design"),
        summary: "Approve rerun imported document", subject_digest: subject, current_evidence: evidence,
        kind: "artifact-approval" as const, context,
      };
      const opened = await openDurableGate(services.value.dependencies, gateInput);
      if (!opened.ok) throw new Error(JSON.stringify(opened));
      mkdirSync(join(services.value.authority.workspace_root, "cache", "gates"), { recursive: true });
      writeFileSync(join(services.value.authority.workspace_root, "cache", "gates", "gate.decision"), canonicalDocument({
        schema_version: "1", gate_id: opened.value.gate_id, task_id: task, phase_instance: gateInput.phase_instance,
        kind: "artifact-approval", subject_digest: subject, context_digest: computeGateContextDigest("artifact-approval", context),
        human_provenance: { schema_version: "1", actor_class: "human", assurance: "declared-local-trace", channel: "archflow-local",
          decision_event_id: `legacy-approve-decision-${index}`, helper_invocation_id: `legacy-approve-helper-${index}`, recorded_at: "2026-08-03T12:00:00.000Z" },
        payload: { decision: "approve", reason: "Reviewed current canonical document" },
      }).bytes);
      const resolved = await resolveInterfaceGateDecision(services.value.dependencies, services.value.authority, opened.value.gate_id);
      if (!resolved.ok) throw new Error(JSON.stringify(resolved));
    }

    services = await createProductionServices({ working_directory: root, task_id: task, operation: parseSafeCode("legacy-open-audit") });
    if (!services.ok || services.value.state === undefined) throw new Error("audit services unavailable");
    const designReference = references[1]!;
    const retainedDesign = await services.value.dependencies.load_retained_result!(designReference);
    if (!retainedDesign.ok) throw new Error(retainedDesign.error.code);
    const designSubject = retainedDesign.value.prepared.manifest.value.artifact_digest;
    const auditInput = {
      authority: services.value.authority, expected_revision: services.value.state.value.revision,
      intent_id: parsePathSafeId("legacy-migration-audit"), request_digest: sha256Bytes(new TextEncoder().encode("legacy-audit-request")),
      input_fingerprint: services.value.state.value.input_fingerprint, phase_instance: parsePhaseInstanceId("design"),
      summary: "Audit retained legacy history", subject_digest: designSubject, current_evidence: evidence,
      kind: "migration-audit" as const, context: emitted.audit_context,
    };
    expect(await openDurableGate(services.value.dependencies, { ...auditInput, subject_digest: "e".repeat(64) as never }))
      .toMatchObject({ ok: false, error: { code: "STATE_INVALID" } });
    const opened = await openDurableGate(services.value.dependencies, auditInput);
    if (!opened.ok) throw new Error(JSON.stringify(opened));
    mkdirSync(join(services.value.authority.workspace_root, "cache", "gates"), { recursive: true });
    writeFileSync(join(services.value.authority.workspace_root, "cache", "gates", "gate.decision"), canonicalDocument({
      schema_version: "1", gate_id: opened.value.gate_id, task_id: task, phase_instance: "design", kind: "migration-audit",
      subject_digest: designSubject, context_digest: computeGateContextDigest("migration-audit", emitted.audit_context),
      human_provenance: { schema_version: "1", actor_class: "human", assurance: "declared-local-trace", channel: "archflow-local",
        decision_event_id: "legacy-audit-decision", helper_invocation_id: "legacy-audit-helper", recorded_at: "2026-08-03T12:00:00.000Z" },
      payload: { decision: "accept-import-audit", reason: "Reviewed retained history and canonical reruns" },
    }).bytes);
    const resolved = await resolveInterfaceGateDecision(services.value.dependencies, services.value.authority, opened.value.gate_id);
    expect(resolved).toMatchObject({ ok: true, value: { state: { value: { phase_instance: "design", approvals: expect.any(Array) } } } });

    git(root, "add", "--", `.archflow/tasks/${task}`);
    git(root, "commit", "-q", "-m", emitted.audit_context.commit_message);

    services = await createProductionServices({ working_directory: root, task_id: task, operation: parseSafeCode("legacy-jump") });
    if (!services.ok || services.value.state === undefined) throw new Error("jump services unavailable");
    const draftCall = {
      schema_version: "1" as const, task_id: task, intent_id: "legacy-jump", expected_revision: services.value.state.value.revision,
      input_fingerprint: services.value.state.value.input_fingerprint, phase_instance: "phase-impl-3" as const,
      step: "produce" as const, status: "running" as const,
    };
    const envelope = await computeCallEnvelope(services.value, { tool: "archflow_state", input: draftCall });
    if (!envelope.ok) throw new Error(JSON.stringify(envelope));
    const jumped = await invokeState(root, { ...draftCall, input_fingerprint: envelope.value.input_fingerprint }, "legacy-jump");
    expect(jumped, JSON.stringify(jumped)).toMatchObject({ ok: true, value: { status: "running" } });
    const afterJump = await createProductionServices({ working_directory: root, task_id: task, operation: parseSafeCode("legacy-after-jump") });
    if (!afterJump.ok || afterJump.value.state === undefined) throw new Error("jumped state unavailable");
    expect(afterJump.value.state.value).toMatchObject({
      phase_instance: "phase-impl-3", step: "produce", status: "running", attempt: 1,
    });
    expect(afterJump.value.state.value.authoritative_results).toEqual(expect.arrayContaining(references));

  }, TIMEOUT);
});

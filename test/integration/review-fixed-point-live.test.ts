import { execFileSync } from "node:child_process";
import { chmodSync, cpSync, mkdirSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { canonicalDocument, canonicalJsonDigest, parseGitOid, sha256Bytes } from "../../src/contracts/canonical.js";
import type { ConfigV1 } from "../../src/contracts/config.js";
import { connectionContextFactory, createInvocationContext } from "../../src/contracts/contexts.js";
import type { TaskStateV1 } from "../../src/contracts/durable-state.js";
import { parsePathSafeId, parseSafeCode, parseSafeId, parseSafeInteger, parseTaskSlug } from "../../src/contracts/evidence.js";
import { computeGateContextDigest, computeInputFingerprint } from "../../src/contracts/fingerprints.js";
import { parseToolCall } from "../../src/contracts/mcp-tools.js";
import { encodePhaseInstance, parsePositiveSafePhaseNumber } from "../../src/contracts/phase-instance.js";
import { parseRepositoryPathClaim, parseTaskPathClaim } from "../../src/contracts/path-claims.js";
import { currentEvidenceSetRef } from "../../src/contracts/trust.js";
import { createToolHandlers } from "../../src/mcp/handlers/index.js";
import { prepareDocumentResult } from "../../src/mcp/handlers/state-results.js";
import { createToolBoundary } from "../../src/mcp/server.js";
import { runCounterReview } from "../../src/review/counter-review.js";
import { assessCurrentEvidence } from "../../src/review/fixed-point.js";
import { resolvePinnedConstitution } from "../../src/state/constitution.js";
import { buildDocumentArtifact } from "../../src/state/document-artifact.js";
import { buildImplementationOutput } from "../../src/state/implementation-manifest.js";
import { createProductionServices, type ProductionServices } from "../../src/state/production.js";
import { openDurableGate, runDurableGate } from "../../src/state/gates.js";
import { ensurePayloadParent, ensureResultDirectory } from "../../src/state/layout.js";
import { installSnapshot } from "../../src/state/snapshots.js";
import { readTaskConfig } from "../../src/state/read.js";
import { loadCurrentReviewSet, loadRetainedEvidence } from "../../src/state/evidence-results.js";

const roots: string[] = [];
afterEach(async () => Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))));

const task = parseTaskSlug("live-fixed-point");
const phase = encodePhaseInstance({ kind: "phase-impl", phase: parsePositiveSafePhaseNumber(17) });
const environment: NodeJS.ProcessEnv = {
  ...process.env,
  GIT_CONFIG_GLOBAL: "/dev/null",
  GIT_CONFIG_SYSTEM: "/dev/null",
  GIT_AUTHOR_NAME: "ArchFlow Test",
  GIT_AUTHOR_EMAIL: "test@example.invalid",
  GIT_COMMITTER_NAME: "ArchFlow Test",
  GIT_COMMITTER_EMAIL: "test@example.invalid",
};
const config: ConfigV1 = {
  schema_version: "1",
  roles: {
    producer: { model: "claude-fixture", effort: "high" },
    "counter-reviewer": { model: "gpt-fixture", effort: "high" },
    adjudicator: { model: "gpt-fixture", effort: "high" },
  },
};
const configYaml = `schema_version: "1"\nroles:\n  producer:\n    model: claude-fixture\n    effort: high\n  counter-reviewer:\n    model: gpt-fixture\n    effort: high\n  adjudicator:\n    model: gpt-fixture\n    effort: high\n`;
const rubric = {
  schema_version: "1",
  kind: "implementation",
  mode: "adversarial",
  criteria: [{ id: "correctness", text: "Check the implementation.", blocking: true }],
} as const;

async function fixture() {
  const root = realpathSync(await mkdtemp(join(tmpdir(), "archflow-live-fixed-point-")));
  roots.push(root);
  execFileSync("git", ["init", "-q", "-b", "main"], { cwd: root, env: environment });
  mkdirSync(join(root, ".archflow", "constitution"), { recursive: true });
  mkdirSync(join(root, ".archflow", "tasks", task, "phases"), { recursive: true });
  cpSync(join(process.cwd(), "assets", "workflow.yaml"), join(root, ".archflow", "workflow.yaml"));
  cpSync(join(process.cwd(), "assets", "constitution"), join(root, ".archflow", "constitution"), { recursive: true });
  rmSync(join(root, ".archflow", "constitution"), { recursive: true, force: true });
  mkdirSync(join(root, ".archflow", "constitution"), { recursive: true });
  // Deliberately no active rules: these regressions target the state/evidence pipeline, so the
  // merged counter-review must report the constitution review as not-run instead of launching
  // the second, adjudicating dispatch.
  writeFileSync(join(root, ".archflow", "constitution", "00-review.md"), `---\nid: review-implementation\nversion: 1\nstatus: deprecated\n---\nReview the retained implementation subject.\n`);
  writeFileSync(join(root, ".archflow", "tasks", task, "config.yaml"), configYaml);
  writeFileSync(join(root, "tracked.txt"), "root\n");
  execFileSync("git", ["add", ".archflow/workflow.yaml", ".archflow/constitution", "tracked.txt"], { cwd: root, env: environment });
  execFileSync("git", ["commit", "-qm", "policy base"], { cwd: root, env: environment });
  const policyBase = execFileSync("git", ["rev-parse", "HEAD"], { cwd: root, env: environment, encoding: "utf8" }).trim() as TaskStateV1["policy_base_commit"];

  const bootstrap = await createProductionServices({
    working_directory: root,
    task_id: task,
    operation: parseSafeCode("live-bootstrap"),
    phase_instance: phase,
  });
  if (!bootstrap.ok) throw new Error(bootstrap.error.code);
  const constitution = await resolvePinnedConstitution(bootstrap.value.runner, policyBase, bootstrap.value.authority.context);
  if (!constitution.ok) throw new Error(constitution.error.code);
  const workflowBytes = new Uint8Array(await readFile(join(root, ".archflow", "workflow.yaml")));
  const configBytes = new TextEncoder().encode(configYaml);
  const state: TaskStateV1 = {
    schema_version: "1",
    task_id: task,
    repository_identity_digest: bootstrap.value.authority.repository_identity_digest,
    revision: parseSafeInteger(4),
    phase_instance: phase,
    step: "counter_review",
    status: "running",
    attempt: parseSafeInteger(1),
    input_fingerprint: "0".repeat(64) as TaskStateV1["input_fingerprint"],
    initialization_digest: canonicalJsonDigest({ initialization: 1 }),
    config_digest: sha256Bytes(configBytes),
    workflow_digest: sha256Bytes(workflowBytes),
    constitution_digest: constitution.value.digest,
    policy_base_commit: policyBase,
    authoritative_results: [],
    approvals: [],
    waivers: [],
  };
  await writeFile(bootstrap.value.authority.state.absolute, canonicalDocument(state).bytes);
  const services = await createProductionServices({
    working_directory: root,
    task_id: task,
    operation: parseSafeCode("live-resolve"),
  });
  if (!services.ok || services.value.state === undefined) throw new Error("production services unavailable");
  const liveConfig = await readTaskConfig(services.value.authority.config);
  if (liveConfig.kind !== "valid") throw new Error("live config unavailable");
  return { root, services: services.value, liveConfig: liveConfig.snapshot };
}

describe("live fixed-point regressions", () => {
  it("installs successive implementation outputs through the real state handler", async () => {
    const h = await fixture();
    const initial = h.services.state!.value;
    const baseCommit = parseGitOid(execFileSync("git", ["rev-parse", "HEAD"], {
      cwd: h.root, env: environment, encoding: "utf8",
    }).trim());
    const outputPath = parseRepositoryPathClaim("tracked.txt");
    const parentDocument = parseTaskPathClaim("design.md");
    await writeFile(join(h.services.authority.task_root, parentDocument), "# Test design\n");
    const fingerprint = computeInputFingerprint({
      schema_version: "1", workflow_digest: initial.workflow_digest, config_digest: initial.config_digest,
      constitution_digest: initial.constitution_digest, artifact_identities: [], upstream_identities: [],
      rubric_digest: canonicalJsonDigest({}), phase_instance: phase, declared_inputs: [],
    });
    const connection = connectionContextFactory.captureStartup({
      connection_id: "live-implementation-produce",
      startup_repository_candidate: { working_directory: h.root },
    }).initialize({
      client: { name: "claude-code", version: "2.1.220" }, host: "claude", protocol_version: "2025-11-25",
    });
    const invokeState = async (input: unknown, id: string) => {
      const outcome = await createToolBoundary(createToolHandlers()).invoke(
        "archflow_state",
        input,
        createInvocationContext(connection, {
          invocation_id: id,
          transport_metadata: { request_id: `${id}-request`, operation: "tools/call" },
        }, new AbortController().signal),
      );
      if (outcome.kind !== "project-result" || !outcome.result.ok) throw new Error(JSON.stringify(outcome));
      return outcome.result.value;
    };
    const build = async (
      services: ProductionServices,
      phaseInstance = phase,
      inputFingerprint = fingerprint,
    ) => {
      const built = await buildImplementationOutput(
        services.dependencies,
        services.authority,
        services.state!,
        {
          phase_instance: phaseInstance,
          step: "produce",
          base_commit: baseCommit,
          outputs: [outputPath],
          restore_targets: [outputPath],
          parent_documents: [{ document_path: parentDocument, role: "design" }],
          declared_inputs: [],
          input_fingerprint: inputFingerprint,
        },
      );
      if (!built.ok) throw new Error(JSON.stringify(built));
      return built.value;
    };

    await writeFile(h.services.authority.state.absolute, canonicalDocument({
      ...initial, step: "produce", status: "running", input_fingerprint: fingerprint,
    }).bytes);
    await writeFile(join(h.root, outputPath), "first implementation generation\n");
    let services = await createProductionServices({
      working_directory: h.root, task_id: task, operation: parseSafeCode("implementation-produce-first"),
    });
    if (!services.ok) throw new Error(services.error.code);
    const first = await build(services.value);
    await invokeState({
      schema_version: "1", task_id: task, intent_id: "implementation-produce-first",
      expected_revision: 4, phase_instance: phase, step: "produce", status: "succeeded",
      input_fingerprint: fingerprint, artifact: first,
    }, "implementation-produce-first");

    services = await createProductionServices({
      working_directory: h.root, task_id: task, operation: parseSafeCode("implementation-reentry"),
    });
    if (!services.ok) throw new Error(services.error.code);
    await writeFile(services.value.authority.state.absolute, canonicalDocument({
      ...services.value.state!.value,
      step: "triage",
      status: "succeeded",
    }).bytes);
    await invokeState({
      schema_version: "1", task_id: task, intent_id: "implementation-reentry",
      expected_revision: 5, phase_instance: phase, step: "produce", status: "running",
      input_fingerprint: fingerprint,
    }, "implementation-reentry");
    await writeFile(join(h.root, outputPath), "second implementation generation\n");
    services = await createProductionServices({
      working_directory: h.root, task_id: task, operation: parseSafeCode("implementation-produce-second"),
    });
    if (!services.ok) throw new Error(services.error.code);
    const second = await build(services.value);
    expect(second.accounting.task_bytes).toBeGreaterThan(second.accounting.result_bytes);
    await invokeState({
      schema_version: "1", task_id: task, intent_id: "implementation-produce-second",
      expected_revision: 6, phase_instance: phase, step: "produce", status: "succeeded",
      input_fingerprint: fingerprint, artifact: second,
    }, "implementation-produce-second");

    const final = await createProductionServices({
      working_directory: h.root, task_id: task, operation: parseSafeCode("implementation-produce-proof"),
    });
    if (!final.ok) throw new Error(final.error.code);
    const reference = final.value.state!.value.authoritative_results.find((entry) =>
      entry.phase_instance === phase && entry.step === "produce");
    if (reference === undefined) throw new Error("second implementation result missing");
    const retained = await final.value.dependencies.load_retained_result!(reference);
    if (!retained.ok) throw new Error(retained.error.code);
    expect(retained.value.prepared.manifest.value.source_artifact.artifact_kind).toBe("implementation-output");
    expect(retained.value.prepared.manifest.value.accounting).toEqual(second.accounting);
    expect(retained.value.prepared.manifest.value.secret_scan).toMatchObject({ outcome: "clean" });

    const approveCommit = async (currentServices: ProductionServices, subject: typeof second) => {
      const subjectDigest = canonicalJsonDigest(subject);
      const evidence = currentEvidenceSetRef([
          { role: "counter-review" as const, evidence_digest: sha256Bytes(new TextEncoder().encode(`counter-${subjectDigest}`)), assurance: "server-attested" as const, producer_family: "claude" as const, reviewer_family: "codex" as const, independence: "opposite-family" as const },
      ]);
      const context = {
        target_ref: "refs/heads/main",
        diff_digest: subject.diff_digest,
        current_artifact_digests: [subjectDigest],
        parent_document_digests: subject.parent_documents.map((document) => document.content_digest),
      } as const;
      const input = {
        authority: currentServices.authority,
        expected_revision: currentServices.state!.value.revision,
        intent_id: parsePathSafeId(`commit-approval-${currentServices.state!.value.phase_instance}`),
        request_digest: sha256Bytes(new TextEncoder().encode(`request-${subjectDigest}`)),
        input_fingerprint: currentServices.state!.value.input_fingerprint,
        phase_instance: currentServices.state!.value.phase_instance,
        summary: "Authorize the tested implementation commit",
        subject_digest: subjectDigest,
        current_evidence: evidence,
        kind: "commit-authorization" as const,
        context,
      };
      const opened = await openDurableGate(currentServices.dependencies, input);
      if (!opened.ok) throw new Error(JSON.stringify(opened));
      await writeFile(join(currentServices.authority.task_root, "gate.decision"), canonicalDocument({
        schema_version: "1",
        gate_id: opened.value.gate_id,
        task_id: task,
        phase_instance: currentServices.state!.value.phase_instance,
        kind: "commit-authorization",
        subject_digest: subjectDigest,
        context_digest: computeGateContextDigest("commit-authorization", context),
        human_provenance: {
          schema_version: "1", actor_class: "human", assurance: "declared-local-trace",
          channel: "archflow-local", decision_event_id: `decision-${currentServices.state!.value.phase_instance}`,
          helper_invocation_id: `helper-${currentServices.state!.value.phase_instance}`,
          recorded_at: "2026-08-03T12:00:00.000Z",
        },
        payload: { decision: "authorize-commit", reason: "Reviewed for handler completion proof" },
      }).bytes);
      const resolved = await runDurableGate(currentServices.dependencies, {
        ...input, signal: new AbortController().signal,
      });
      if (!resolved.ok) throw new Error(JSON.stringify(resolved));
    };

    await writeFile(final.value.authority.state.absolute, canonicalDocument({
      ...final.value.state!.value,
      step: "triage", status: "succeeded", planned_final_phase: parseSafeInteger(18),
    }).bytes);
    let completion = await createProductionServices({
      working_directory: h.root, task_id: task, operation: parseSafeCode("non-final-approval"),
    });
    if (!completion.ok) throw new Error(completion.error.code);
    await approveCommit(completion.value, second);
    execFileSync("git", ["add", "--", outputPath], { cwd: h.root, env: environment });
    execFileSync("git", ["commit", "-qm", "first implementation"], { cwd: h.root, env: environment });
    completion = await createProductionServices({
      working_directory: h.root, task_id: task, operation: parseSafeCode("non-final-advance"),
    });
    if (!completion.ok) throw new Error(completion.error.code);
    const phaseDesign18 = encodePhaseInstance({ kind: "phase-design", phase: parsePositiveSafePhaseNumber(18) });
    const phaseDesignFingerprint = computeInputFingerprint({
      schema_version: "1", workflow_digest: initial.workflow_digest, config_digest: initial.config_digest,
      constitution_digest: initial.constitution_digest, artifact_identities: [], upstream_identities: [],
      rubric_digest: canonicalJsonDigest({}), phase_instance: phaseDesign18, declared_inputs: [],
    });
    await invokeState({
      schema_version: "1", task_id: task, intent_id: "non-final-advance",
      expected_revision: completion.value.state!.value.revision,
      phase_instance: phaseDesign18, step: "produce", status: "running",
      input_fingerprint: phaseDesignFingerprint,
    }, "non-final-advance");
    let advanced = await createProductionServices({
      working_directory: h.root, task_id: task, operation: parseSafeCode("non-final-observed"),
    });
    if (!advanced.ok) throw new Error(advanced.error.code);
    expect(advanced.value.state!.value).toMatchObject({
      phase_instance: "phase-design-18", planned_final_phase: 18,
    });
    expect(advanced.value.state!.value.terminal).toBeUndefined();

    const finalPhase = encodePhaseInstance({ kind: "phase-impl", phase: parsePositiveSafePhaseNumber(18) });
    const finalFingerprint = computeInputFingerprint({
      schema_version: "1", workflow_digest: initial.workflow_digest, config_digest: initial.config_digest,
      constitution_digest: initial.constitution_digest, artifact_identities: [], upstream_identities: [],
      rubric_digest: canonicalJsonDigest({}), phase_instance: finalPhase, declared_inputs: [],
    });
    await writeFile(advanced.value.authority.state.absolute, canonicalDocument({
      ...advanced.value.state!.value,
      phase_instance: finalPhase, step: "produce", status: "running", attempt: parseSafeInteger(1),
      input_fingerprint: finalFingerprint,
    }).bytes);
    await writeFile(join(h.root, outputPath), "final implementation generation\n");
    advanced = await createProductionServices({
      working_directory: h.root, task_id: task, operation: parseSafeCode("final-produce"),
    });
    if (!advanced.ok) throw new Error(advanced.error.code);
    const finalOutput = await build(advanced.value, finalPhase, finalFingerprint);
    await invokeState({
      schema_version: "1", task_id: task, intent_id: "final-produce",
      expected_revision: advanced.value.state!.value.revision,
      phase_instance: finalPhase, step: "produce", status: "succeeded",
      input_fingerprint: finalFingerprint, artifact: finalOutput,
    }, "final-produce");
    completion = await createProductionServices({
      working_directory: h.root, task_id: task, operation: parseSafeCode("final-approval-state"),
    });
    if (!completion.ok) throw new Error(completion.error.code);
    await writeFile(completion.value.authority.state.absolute, canonicalDocument({
      ...completion.value.state!.value, step: "triage", status: "succeeded",
    }).bytes);
    completion = await createProductionServices({
      working_directory: h.root, task_id: task, operation: parseSafeCode("final-approval"),
    });
    if (!completion.ok) throw new Error(completion.error.code);
    await approveCommit(completion.value, finalOutput);
    execFileSync("git", ["add", "--", outputPath], { cwd: h.root, env: environment });
    execFileSync("git", ["commit", "-qm", "second implementation"], { cwd: h.root, env: environment });
    completion = await createProductionServices({
      working_directory: h.root, task_id: task, operation: parseSafeCode("final-completion"),
    });
    if (!completion.ok) throw new Error(completion.error.code);
    // The completion signal fires from triage-succeeded: re-recording the same position with
    // the commit observed and the commit-authorization approval durable marks the task complete.
    await invokeState({
      schema_version: "1", task_id: task, intent_id: "final-completion",
      expected_revision: completion.value.state!.value.revision,
      phase_instance: finalPhase, step: "triage", status: "succeeded",
      input_fingerprint: finalFingerprint,
    }, "final-completion");
    const completed = await createProductionServices({
      working_directory: h.root, task_id: task, operation: parseSafeCode("final-completed-observed"),
    });
    if (!completed.ok) throw new Error(completed.error.code);
    expect(completed.value.state!.value).toMatchObject({
      phase_instance: finalPhase, planned_final_phase: 18, terminal: "complete",
    });
  });

  it("closes the real handler pipeline on the retained produce artifact digest", async () => {
    const h = await fixture();
    const documentPath = parseTaskPathClaim("phases/17/impl-notes.md");
    mkdirSync(join(h.root, ".archflow", "tasks", task, "phases", "17"), { recursive: true });
    mkdirSync(join(h.root, ".archflow", "tasks", task, "reviews"), { recursive: true });
    await writeFile(join(h.root, ".archflow", "tasks", task, documentPath), "implemented change\n");

    const initial = h.services.state!.value;
    const upstreamSpecs = [
      { phase_instance: encodePhaseInstance({ kind: "phase-design", phase: parsePositiveSafePhaseNumber(17) }), path: parseTaskPathClaim("phases/17/design.md"), artifact_kind: "phase-design" as const },
      { phase_instance: encodePhaseInstance({ kind: "design" }), path: parseTaskPathClaim("design.md"), artifact_kind: "design" as const },
    ];
    const upstreamReferences = [];
    let retainedBytes = parseSafeInteger(0);
    const scanner = {
      scan: async (candidates: readonly { virtual_path: ReturnType<typeof parseRepositoryPathClaim> }[]) => ({
        schema_version: "1" as const, outcome: "clean" as const, detector_set_id: parseSafeId("upstream-test"),
        scanned_paths: candidates.map((candidate) => candidate.virtual_path),
      }),
    };
    for (const [index, spec] of upstreamSpecs.entries()) {
      const absolute = join(h.services.authority.task_root, spec.path);
      mkdirSync(join(absolute, ".."), { recursive: true });
      await writeFile(absolute, `approved ${spec.artifact_kind} upstream\n`);
      const artifact = await buildDocumentArtifact(h.services.runner, h.services.authority, {
        phase_instance: spec.phase_instance, step: "produce", document_path: spec.path,
        declared_inputs: [], input_fingerprint: initial.input_fingerprint,
      });
      if (!artifact.ok) throw new Error(artifact.error.code);
      const prepared = await prepareDocumentResult({
        services: h.services,
        artifact: artifact.value,
        result_id: parseSafeId(`upstream-result-${index}`),
        retained_task_bytes: retainedBytes,
        measured_at_revision: parseSafeInteger(4),
        scanner,
      });
      if (!prepared.ok) throw new Error(prepared.error.code);
      await ensureResultDirectory(h.services.authority, prepared.value.reference.result_digest);
      for (const payload of prepared.value.prepared.payloads) {
        await ensurePayloadParent(h.services.authority, prepared.value.reference.result_digest, payload.target.absolute);
      }
      const installed = await installSnapshot(
        h.services.dependencies.atomic, prepared.value.prepared, prepared.value.manifest_target,
        h.services.runner.location.worktreeRoot as never,
      );
      if (!installed.ok) throw new Error(installed.error.code);
      retainedBytes = parseSafeInteger(retainedBytes + prepared.value.prepared.manifest.value.accounting.result_bytes);
      upstreamReferences.push(prepared.value.reference);
    }
    let approvalState: TaskStateV1 = {
      ...initial, step: "triage", status: "succeeded",
      authoritative_results: [...upstreamReferences].sort((left, right) =>
        `${left.phase_instance}\0${left.step}`.localeCompare(`${right.phase_instance}\0${right.step}`)),
    };
    await writeFile(h.services.authority.state.absolute, canonicalDocument(approvalState).bytes);
    const approvalEvidence = currentEvidenceSetRef([
      { role: "counter-review", evidence_digest: sha256Bytes(new TextEncoder().encode("upstream-counter")), assurance: "server-attested", producer_family: "claude", reviewer_family: "codex", independence: "opposite-family" },
    ]);
    for (const [index, spec] of upstreamSpecs.entries()) {
      const services = await createProductionServices({ working_directory: h.root, task_id: task, operation: parseSafeCode(`upstream-approval-${index}`) });
      if (!services.ok) throw new Error(JSON.stringify(services));
      const reference = upstreamReferences[index]!;
      const retained = await services.value.dependencies.load_retained_result!(reference);
      if (!retained.ok) throw new Error(retained.error.code);
      const subject = retained.value.prepared.manifest.value.artifact_digest;
      const gateInput = {
        authority: services.value.authority, expected_revision: services.value.state!.value.revision,
        intent_id: parsePathSafeId(`upstream-approval-${index}`),
        request_digest: sha256Bytes(new TextEncoder().encode(`upstream-request-${index}`)),
        input_fingerprint: services.value.state!.value.input_fingerprint,
        phase_instance: phase, summary: `Approve ${spec.artifact_kind} upstream`, subject_digest: subject,
        current_evidence: approvalEvidence, kind: "artifact-approval" as const,
        context: { artifact_kind: spec.artifact_kind },
      };
      const opened = await openDurableGate(services.value.dependencies, gateInput);
      if (!opened.ok) throw new Error(JSON.stringify(opened));
      await writeFile(join(services.value.authority.task_root, "gate.decision"), canonicalDocument({
        schema_version: "1", gate_id: opened.value.gate_id, task_id: task, phase_instance: phase,
        kind: "artifact-approval", subject_digest: subject,
        context_digest: computeGateContextDigest("artifact-approval", gateInput.context),
        human_provenance: { schema_version: "1", actor_class: "human", assurance: "declared-local-trace", channel: "archflow-local", decision_event_id: `upstream-decision-${index}`, helper_invocation_id: `upstream-helper-${index}`, recorded_at: "2026-08-03T12:00:00.000Z" },
        payload: { decision: "approve", reason: "Approved canonical retained upstream" },
      }).bytes);
      const resolved = await runDurableGate(services.value.dependencies, { ...gateInput, signal: new AbortController().signal });
      if (!resolved.ok || !("state" in resolved.value)) throw new Error(JSON.stringify(resolved));
      approvalState = resolved.value.state.value;
    }
    const { committed_intent: _approvalIntent, ...approvalAuthority } = approvalState;
    const produceRunning: TaskStateV1 = {
      ...approvalAuthority, revision: parseSafeInteger(4), step: "produce", status: "running",
      authoritative_results: approvalState.authoritative_results,
    };
    await writeFile(h.services.authority.state.absolute, canonicalDocument(produceRunning).bytes);
    const placeholder = await buildDocumentArtifact(h.services.runner, h.services.authority, {
      phase_instance: phase, step: "produce", document_path: documentPath,
      declared_inputs: [], input_fingerprint: initial.input_fingerprint,
    });
    if (!placeholder.ok) throw new Error(placeholder.error.code);
    const produceTemplate = parseToolCall("archflow_state", {
      schema_version: "1", task_id: task, intent_id: "pipeline-produce", expected_revision: 4,
      phase_instance: phase, step: "produce", status: "succeeded",
      input_fingerprint: initial.input_fingerprint, artifact: placeholder.value,
    });
    const produceSubject = await h.services.dependencies.resolve_input_fingerprint({
      runner: h.services.runner, authority: h.services.authority,
      state: canonicalDocument(produceRunning), call: produceTemplate,
      live_config: h.liveConfig, context: h.services.authority.context,
    });
    if (!produceSubject.ok) throw new Error(produceSubject.error.code);
    const produceFingerprint = computeInputFingerprint(produceSubject.value);
    const produceArtifact = { ...placeholder.value, input_fingerprint: produceFingerprint };
    const nonProduceFingerprint = computeInputFingerprint({
      schema_version: "1", workflow_digest: initial.workflow_digest, config_digest: initial.config_digest,
      constitution_digest: initial.constitution_digest, artifact_identities: [], upstream_identities: [],
      rubric_digest: canonicalJsonDigest({}), phase_instance: phase, declared_inputs: [],
    });

    const bin = join(h.root, "bin");
    const sourceHome = join(h.root, "source-home");
    mkdirSync(join(sourceHome, ".codex"), { recursive: true });
    mkdirSync(bin, { recursive: true });
    writeFileSync(join(sourceHome, ".codex", "auth.json"), "{}\n");
    const executable = join(bin, "codex");
    writeFileSync(executable, `#!/usr/bin/env node
import { writeFile } from "node:fs/promises";
const argv = process.argv.slice(2);
if (argv.length === 1 && argv[0] === "--version") process.stdout.write("codex-cli 0.146.0\\n");
else if (argv[0] === "login" && argv[1] === "status") process.stdout.write("Logged in using ChatGPT\\n");
else {
  const chunks = []; for await (const chunk of process.stdin) chunks.push(chunk);
  const envelope = JSON.parse(Buffer.concat(chunks).toString("utf8")); const subject = envelope.subject;
  const output = subject.role === "counter-review" ? {
    schema_version: "1", task_id: subject.task_id, phase_instance: subject.phase_instance,
    step: "counter_review", role: "counter-review", subject_digest: subject.subject_digest,
    input_fingerprint: subject.input_fingerprint, rubric_digest: subject.rubric_digest,
    producer_family: subject.producer_family, findings: [], matched_rule_versions: [], verdict: "pass", blocking_count: 0
  } : {
    schema_version: "1", task_id: subject.task_id, phase_instance: subject.phase_instance,
    step: "adjudicate", subject_digest: subject.subject_digest, input_fingerprint: subject.input_fingerprint,
    pinned_constitution_digest: subject.pinned_constitution_digest,
    approved_upstream_digests: subject.approved_upstream_digests,
    source_evidence_set_digest: subject.source_evidence_set_digest,
    rule_findings: envelope.rules.map((rule) => ({ rule_id: rule.id, rule_version: rule.version,
      compliance: rule.enforced_by.length === 0 ? "pass" : "uncertain",
      rationale: "Checked retained implementation evidence.",
      trigger: "not-matched", trigger_evidence: "No review trigger matched.",
      enforced_by: rule.enforced_by.map((mechanism) => ({ mechanism, state: "unknown", details: "No mechanical result supplied." })) })),
    drift_findings: subject.approved_upstream_digests.map((upstream_digest) => ({ upstream_digest, drift: "aligned", affected_claim_ids: [], rationale: "No upstream drift found." })), constitution: envelope.rules.some((rule) => rule.enforced_by.length > 0) ? "uncertain" : "pass",
    drift: "aligned", matched_rule_versions: [],
    uncertain_rule_versions: []
  };
  await writeFile(argv[argv.indexOf("-o") + 1], JSON.stringify(output) + "\\n");
  process.stdout.write('{"type":"turn.completed"}\\n');
}`);
    chmodSync(executable, 0o755);
    const saved = { PATH: process.env.PATH, HOME: process.env.HOME };
    process.env.PATH = `${bin}:${saved.PATH ?? ""}`;
    process.env.HOME = sourceHome;
    const connection = connectionContextFactory.captureStartup({
      connection_id: "live-pipeline", startup_repository_candidate: { working_directory: h.root },
    }).initialize({ client: { name: "claude-code", version: "2.1.220" }, host: "claude", protocol_version: "2025-11-25" });
    const invoke = async (name: Parameters<ReturnType<typeof createToolBoundary>["invoke"]>[0], input: unknown, id: string) => {
      const result = await createToolBoundary(createToolHandlers()).invoke(name, input, createInvocationContext(connection, {
        invocation_id: id, transport_metadata: { request_id: `${id}-request`, operation: "tools/call" },
      }, new AbortController().signal));
      if (result.kind !== "project-result" || !result.result.ok) throw new Error(JSON.stringify(result));
      return result.result.value;
    };
    try {
      await invoke("archflow_state", { ...produceTemplate.input, input_fingerprint: produceFingerprint, artifact: produceArtifact }, "produce");
      const produceDigest = canonicalJsonDigest(produceArtifact);
      await invoke("archflow_state", { schema_version: "1", task_id: task, intent_id: "counter-running", expected_revision: 5,
        phase_instance: phase, step: "counter_review", status: "running", input_fingerprint: nonProduceFingerprint }, "counter-running");
      await invoke("archflow_counter_review", { schema_version: "1", task_id: task, intent_id: "counter-succeeded", expected_revision: 6,
        input_fingerprint: nonProduceFingerprint, artifact_path: documentPath, rubric }, "counter-succeeded");
      const afterCounter = await createProductionServices({ working_directory: h.root, task_id: task, operation: parseSafeCode("pipeline-after-counter") });
      if (!afterCounter.ok) throw new Error(afterCounter.error.code);
      const directReviews = await loadCurrentReviewSet({ read_state: afterCounter.value.dependencies.read_state,
        load_retained_result: afterCounter.value.dependencies.load_retained_result! }, afterCounter.value.authority, phase);
      if (!directReviews.ok) throw new Error(`direct reviews: ${JSON.stringify(directReviews)}`);
      const current = directReviews.value.current_evidence_set;
      await invoke("archflow_state", { schema_version: "1", task_id: task, intent_id: "triage-running", expected_revision: 7,
        phase_instance: phase, step: "triage", status: "running", input_fingerprint: nonProduceFingerprint }, "triage-running");
      await invoke("archflow_state", { schema_version: "1", task_id: task, intent_id: "triage-succeeded", expected_revision: 8,
        phase_instance: phase, step: "triage", status: "succeeded", input_fingerprint: nonProduceFingerprint,
        artifact: { schema_version: "1", artifact_kind: "triage", evidence: { schema_version: "1", task_id: task,
          phase_instance: phase, step: "triage", subject_digest: produceDigest, input_fingerprint: nonProduceFingerprint,
          current_evidence_set_digest: current.set_digest, source_evidence_digests: current.slots.map((slot) => slot.evidence_digest),
          dispositions: [], accepted_count: 0, rejected_count: 0, accepted_editorial_count: 0 } } }, "triage-succeeded");
      const finalServices = await createProductionServices({ working_directory: h.root, task_id: task, operation: parseSafeCode("pipeline-final") });
      if (!finalServices.ok) throw new Error(finalServices.error.code);
      const retained = await loadRetainedEvidence({ load_retained_result: finalServices.value.dependencies.load_retained_result! },
        finalServices.value.state!.value, phase);
      const constitution = await resolvePinnedConstitution(finalServices.value.runner,
        finalServices.value.state!.value.policy_base_commit, finalServices.value.authority.context);
      if (!retained.ok || !constitution.ok) throw new Error("final retained authority unavailable");
      const approvedUpstreamDigests = [];
      for (const reference of upstreamReferences) {
        const loaded = await finalServices.value.dependencies.load_retained_result!(reference);
        if (!loaded.ok) throw new Error(loaded.error.code);
        approvedUpstreamDigests.push(loaded.value.prepared.manifest.value.artifact_digest);
      }
      approvedUpstreamDigests.sort();
      // With no active rules the merged review carried no constitution evidence, and the
      // completed triage alone closes the loop: no separate adjudication position exists.
      expect(assessCurrentEvidence(finalServices.value.state!.value, retained.value, {
        subject_digest: produceDigest, input_fingerprint: nonProduceFingerprint, constitution: constitution.value,
        approved_upstream_digests: approvedUpstreamDigests,
        authenticated_gate_approvals: [],
      })).toMatchObject({ next: "advance", current: ["counter_review", "triage"] });
    } finally {
      if (saved.PATH === undefined) delete process.env.PATH; else process.env.PATH = saved.PATH;
      if (saved.HOME === undefined) delete process.env.HOME; else process.env.HOME = saved.HOME;
    }
  });

  it("uses one production fingerprint across non-produce selectors and rubrics", async () => {
    const h = await fixture();
    const common = {
      schema_version: "1" as const,
      task_id: task,
      expected_revision: 4,
      input_fingerprint: "0".repeat(64),
    };
    const calls = [
      parseToolCall("archflow_state", { ...common, intent_id: "counter-entry", phase_instance: phase, step: "counter_review", status: "running" }),
      parseToolCall("archflow_state", { ...common, intent_id: "triage", phase_instance: phase, step: "triage", status: "running" }),
      parseToolCall("archflow_counter_review", { ...common, intent_id: "counter", artifact_path: "prd.md", rubric }),
      parseToolCall("archflow_counter_review", { ...common, intent_id: "counter-two", artifact_path: "design.md", rubric: { ...rubric, criteria: [{ ...rubric.criteria[0], text: "Changed rubric." }] } }),
    ];
    const fingerprints = [];
    for (const call of calls) {
      const subject = await h.services.dependencies.resolve_input_fingerprint({
        runner: h.services.runner,
        authority: h.services.authority,
        state: h.services.state!,
        call,
        live_config: h.liveConfig,
        context: h.services.authority.context,
      });
      if (!subject.ok) throw new Error(subject.error.code);
      fingerprints.push(computeInputFingerprint(subject.value));
    }
    expect(new Set(fingerprints)).toHaveLength(1);
  });

  it("refuses counter-review installation when dispatch changes the artifact", async () => {
    const h = await fixture();
    const artifactPath = join(h.root, ".archflow", "tasks", task, "phases", "17", "impl-notes.md");
    mkdirSync(join(artifactPath, ".."), { recursive: true });
    await writeFile(artifactPath, "before\n");
    const before = sha256Bytes(new Uint8Array(await readFile(artifactPath)));
    const call = parseToolCall("archflow_counter_review", {
      schema_version: "1", task_id: task, intent_id: "counter-mutation", expected_revision: 4,
      input_fingerprint: "0".repeat(64), artifact_path: "phases/17/impl-notes.md", rubric,
    });
    const result = await runCounterReview({
      transaction: h.services.dependencies,
      dispatch: async () => {
        await writeFile(artifactPath, "after\n");
        return { cli_version: "fixture-1", extracted_output_bytes: new Uint8Array() };
      },
      reobserve_projection_digest: async () => ({
        schema_version: "1", ok: true,
        value: sha256Bytes(new Uint8Array(await readFile(artifactPath))),
      }),
      prepare_evidence: async () => { throw new Error("stale evidence reached preparation"); },
    }, {
      authority: h.services.authority,
      call,
      config,
      phase_kind: "phase-impl",
      producer_family: "claude",
      measured_at_revision: parseSafeInteger(4),
      envelope: {
        artifact: "before\n",
        rubric,
        context: [],
        subject: {
          task_id: task, phase_instance: phase, role: "counter-review", step: "counter_review",
          subject_digest: before, input_fingerprint: call.input.input_fingerprint,
          rubric_digest: canonicalJsonDigest(rubric), producer_family: "claude",
          invocation_id: parseSafeId("counter-mutation-invocation"), result_id: parseSafeId("counter-mutation-result"),
        },
      },
      projection_digest: before,
    });
    expect(result).toMatchObject({
      ok: false,
      error: {
        code: "STATE_INVALID",
        diagnostic: { parameters: { issue_code: "counter-review-subject-not-current" } },
      },
    });
  });
});

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { afterAll, describe, expect, it } from "vitest";

import { canonicalDocument, canonicalJsonDigest, gitBlobOid, parseCanonicalDocument, parseGitOid, sha256Bytes } from "../../src/contracts/canonical.js";
import type { DocumentArtifactV1 } from "../../src/contracts/durable-document.js";
import { connectionContextFactory, createInvocationContext } from "../../src/contracts/contexts.js";
import type { TaskStateV1 } from "../../src/contracts/durable-state.js";
import { parseSafeCode, parseSafeInteger, parseTaskSlug } from "../../src/contracts/evidence.js";
import { computeInputFingerprint } from "../../src/contracts/fingerprints.js";
import { encodePhaseInstance, parsePositiveSafePhaseNumber } from "../../src/contracts/phase-instance.js";
import { parseRepositoryPathClaim, parseTaskPathClaim } from "../../src/contracts/path-claims.js";
import { handleState } from "../../src/mcp/handlers/state.js";
import { parseToolCall } from "../../src/contracts/mcp-tools.js";
import { createGitRunner, preflightGit } from "../../src/repository/git.js";
import { discoverWorktree } from "../../src/repository/identity.js";
import { createInternalTransactionAuthority } from "../../src/state/authority.js";
import { resolvePinnedConstitution } from "../../src/state/constitution.js";
import { createProductionServices } from "../../src/state/production.js";
import { composeRequest } from "../../src/state/request-composition.js";
import { deriveDeclaredSnapshotDigest } from "../../src/state/snapshots.js";
import { cleanupTemporaryRepositories, createTempRepository } from "../helpers/temp-repository.js";

const TASK = parseTaskSlug("handler-state-replay");
const PHASE = encodePhaseInstance({ kind: "phase-impl", phase: parsePositiveSafePhaseNumber(15) });
const CONFIG = "schema_version: \"1\"\nroles: {}\n";

afterAll(cleanupTemporaryRepositories);

async function fixture() {
  const repository = createTempRepository({ label: "handler-state-replay" });
  const workflow = readFileSync(new URL("../../assets/workflow.yaml", import.meta.url));
  repository.write(".archflow/workflow.yaml", workflow);
  repository.write(".archflow/constitution/00-process.md", `---
id: process
version: 1
status: active
---
Preserve explicit human review gates.
`);
  repository.write(`.archflow/tasks/${TASK}/config.yaml`, CONFIG);
  repository.write("tracked.txt", "base\n");
  repository.commitAll("policy base");

  const context = {
    task_id: TASK,
    phase_instance: PHASE,
    operation: parseSafeCode("handler-state-fixture"),
    attempt: parseSafeInteger(1),
  } as const;
  const discovered = await discoverWorktree(createGitRunner({ cwd: repository.path }), context);
  if (!discovered.ok) throw new Error(discovered.error.code);
  const environment = await preflightGit(discovered.value, context);
  if (!environment.ok) throw new Error(environment.error.code);
  const authority = await createInternalTransactionAuthority({
    runner: discovered.value,
    environment: environment.value,
    task_id: TASK,
    context,
  });
  if (!authority.ok) throw new Error(authority.error.code);
  const policyBaseCommit = parseGitOid(repository.git("rev-parse", "HEAD"));
  const constitution = await resolvePinnedConstitution(discovered.value, policyBaseCommit, context);
  if (!constitution.ok) throw new Error(constitution.error.code);
  const configDigest = sha256Bytes(new TextEncoder().encode(CONFIG));
  const workflowDigest = sha256Bytes(workflow);
  const fingerprint = computeInputFingerprint({
    schema_version: "1",
    workflow_digest: workflowDigest,
    config_digest: configDigest,
    constitution_digest: constitution.value.digest,
    artifact_identities: [],
    upstream_identities: [],
    rubric_digest: canonicalJsonDigest({}),
    phase_instance: PHASE,
    declared_inputs: [],
  });
  const state: TaskStateV1 = {
    schema_version: "1",
    task_id: TASK,
    repository_identity_digest: authority.value.repository_identity_digest,
    revision: parseSafeInteger(4),
    phase_instance: PHASE,
    step: "produce",
    status: "running",
    attempt: parseSafeInteger(1),
    input_fingerprint: fingerprint,
    initialization_digest: canonicalJsonDigest({ fixture: "state-handler" }),
    config_digest: configDigest,
    workflow_digest: workflowDigest,
    constitution_digest: constitution.value.digest,
    policy_base_commit: policyBaseCommit,
    authoritative_results: [],
    approvals: [],
    waivers: [],
  };
  mkdirSync(authority.value.task_root, { recursive: true });
  mkdirSync(join(authority.value.workspace_root, "transient"), { recursive: true });
  writeFileSync(authority.value.state.absolute, canonicalDocument(state).bytes);
  const documentPath = parseTaskPathClaim("phases/15/impl-notes.md");
  const projectionTarget = parseRepositoryPathClaim(`.archflow/tasks/${TASK}/${documentPath}`);
  const documentBytes = new TextEncoder().encode("Implementation notes\n");
  mkdirSync(join(authority.value.task_root, "phases", "15"), { recursive: true });
  writeFileSync(join(authority.value.task_root, documentPath), documentBytes);
  const byteCount = parseSafeInteger(documentBytes.byteLength);
  const contentDigest = sha256Bytes(documentBytes);
  const output = {
    path: projectionTarget,
    path_class: "document" as const,
    operation: "add" as const,
    storage: "raw-payload" as const,
    payload_bytes: byteCount,
    payload_digest: contentDigest,
    file_type: "regular" as const,
    after: { oid: gitBlobOid(documentBytes), mode: "100644" as const, size_bytes: byteCount },
  };
  const artifact: DocumentArtifactV1 = {
    schema_version: "1",
    artifact_kind: "document",
    task_id: TASK,
    phase_instance: PHASE,
    step: "produce",
    document_path: documentPath,
    path_class: "document",
    byte_count: byteCount,
    content_digest: contentDigest,
    declared_inputs: [],
    input_fingerprint: fingerprint,
    snapshot_digest: deriveDeclaredSnapshotDigest(
      [output],
      [{ path: projectionTarget, content_digest: contentDigest }],
    ),
    projection_target: projectionTarget,
  };

  const connection = connectionContextFactory.captureStartup({
    connection_id: "handler-state-replay-connection",
    startup_repository_candidate: { working_directory: repository.path },
  }).initialize({
    client: { name: "codex-mcp-client", version: "0.146.0" },
    host: "codex",
    protocol_version: "2025-11-25",
  });
  const invocation = (id: string) => createInvocationContext(connection, {
    invocation_id: id,
    transport_metadata: { request_id: `${id}-request`, operation: "tools/call" },
  }, new AbortController().signal);
  const args = {
    schema_version: "1",
    task_id: TASK,
    intent_id: "state-replay-intent",
    expected_revision: 4,
    input_fingerprint: fingerprint,
    phase_instance: PHASE,
    step: "produce",
    status: "succeeded",
    artifact,
  } as const;
  return { args, authority: authority.value, invocation, repository };
}

describe("state handler durable integration", () => {
  it("installs a real document result and returns the byte-identical outcome on exact replay", async () => {
    const h = await fixture();
    const first = await handleState(parseToolCall("archflow_state", h.args), h.invocation("state-first"));
    expect(first).toMatchObject({
      schema_version: "1", ok: true, value: { path: "state.json", revision: 5, status: "succeeded" },
    });
    const stateAfterFirst = readFileSync(h.authority.state.absolute);
    const committed = parseCanonicalDocument<TaskStateV1>(stateAfterFirst, "committed state").value;
    expect(committed.authoritative_results).toHaveLength(1);
    const reference = committed.authoritative_results[0]!;
    expect(existsSync(join(h.authority.task_root, "authority", "results", `${reference.result_digest}.json`))).toBe(true);

    const replay = await handleState(
      parseToolCall("archflow_state", { ...h.args, expected_revision: 5 }),
      h.invocation("state-replay"),
    );
    expect(replay).toEqual(first);
    expect(readFileSync(h.authority.state.absolute)).toEqual(stateAfterFirst);
  });

  it("restarts directly to PRD without requiring a current implementation result", async () => {
    const h = await fixture();
    const services = await createProductionServices({
      working_directory: h.repository.path,
      task_id: TASK,
      operation: parseSafeCode("compose-planning-restart"),
    });
    if (!services.ok || services.value.state === undefined) throw new Error("restart services unavailable");

    // The PRD restart appends the human request to the pinned ask record before landing.
    writeFileSync(join(h.authority.task_root, "ask.md"), "# Original ask\n");

    // Documents the abandoned forward work left behind. The milestone commit that follows the
    // redone planning covers the whole task directory, so leaving these here would sweep unreviewed
    // documents into it and make that commit unprovable — with no way to retry it.
    const phaseRoot = join(h.repository.path, ".archflow", "tasks", TASK, "phases", "15");
    mkdirSync(phaseRoot, { recursive: true });
    writeFileSync(join(phaseRoot, "design.md"), "# Superseded phase design\n");
    writeFileSync(join(phaseRoot, "impl-notes.md"), "# Superseded attempt\n");

    const composed = await composeRequest(services.value, {
      kind: "planning-restart",
      intent_id: "restart-to-prd",
      invocation: { skill: "archflow-prd", intent: "reopen" },
      reason: "Implementation exposed incorrect product requirements.",
    });
    expect(composed.ok).toBe(true);
    if (!composed.ok) return;
    const first = await handleState(
      parseToolCall("archflow_state", composed.value.envelope.request.input),
      h.invocation("restart-to-prd-call"),
    );
    expect(first).toMatchObject({
      ok: true, value: { revision: 5, status: "running" },
    });
    const restarted = parseCanonicalDocument<TaskStateV1>(
      readFileSync(h.authority.state.absolute), "restarted state",
    ).value;
    expect(restarted).toMatchObject({
      phase_instance: "prd",
      step: "produce",
      status: "running",
      attempt: 1,
      restart_history: [{
        source_phase_instance: PHASE,
        target_phase_instance: "prd",
        reason: "Implementation exposed incorrect product requirements.",
        human_provenance: {
          assurance: "connected-request-trace",
          channel: "connected-host",
          connection_id: "handler-state-replay-connection",
          invocation_id: "restart-to-prd-call",
        },
      }],
    });
    expect(existsSync(join(phaseRoot, "design.md"))).toBe(false);
    expect(existsSync(join(phaseRoot, "impl-notes.md"))).toBe(false);
    const replay = await handleState(
      parseToolCall("archflow_state", {
        ...(composed.value.envelope.request.input as Record<string, unknown>),
        expected_revision: 5,
      }),
      h.invocation("restart-to-prd-replay"),
    );
    expect(replay).toEqual(first);
  });
});

import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { canonicalDocument, canonicalJsonDigest, sha256Bytes } from "../../src/contracts/canonical.js";
import { parseActiveGate, parseGateRequest } from "../../src/contracts/durable-gate.js";
import { intentOutcomeDigest, parseIntentReceipt } from "../../src/contracts/durable-intent.js";
import type { TaskStateV1 } from "../../src/contracts/durable-state.js";
import { parsePathSafeId, parseSafeCode, parseSafeId, parseSafeInteger, parseSha256Digest, parseTaskSlug } from "../../src/contracts/evidence.js";
import { computeGateContextDigest } from "../../src/contracts/fingerprints.js";
import { parseRepositoryPathClaim } from "../../src/contracts/path-claims.js";
import { discoverReconciliationInput } from "../../src/state/reconciliation-discovery.js";
import { reconcileCurrentAuthority } from "../../src/state/reconciliation.js";
import { createProductionServices } from "../../src/state/production.js";

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
const TASK = parseTaskSlug("discovery-task");
const PHASE = "phase-impl-17" as TaskStateV1["phase_instance"];
const D = (character: string) => parseSha256Digest(character.repeat(64));
const env = {
  ...process.env,
  GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_SYSTEM: "/dev/null",
  GIT_AUTHOR_NAME: "ArchFlow Test", GIT_AUTHOR_EMAIL: "test@example.invalid",
  GIT_COMMITTER_NAME: "ArchFlow Test", GIT_COMMITTER_EMAIL: "test@example.invalid",
};

async function harness() {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "archflow-reconciliation-discovery-")));
  roots.push(root);
  execFileSync("git", ["-c", "init.defaultBranch=main", "init", "-q"], { cwd: root, env });
  writeFileSync(join(root, "tracked.txt"), "root\n");
  execFileSync("git", ["add", "--", "tracked.txt"], { cwd: root, env });
  execFileSync("git", ["commit", "-q", "-m", "root"], { cwd: root, env });
  mkdirSync(join(root, ".archflow", "tasks", TASK, "intents"), { recursive: true });
  const created = await createProductionServices({
    working_directory: root,
    task_id: TASK,
    operation: parseSafeCode("reconciliation-discovery-test"),
    phase_instance: PHASE,
  });
  if (!created.ok) throw new Error(`production setup failed: ${created.error.code}`);
  const state = (extra: Partial<TaskStateV1> = {}): TaskStateV1 => ({
    schema_version: "1", task_id: TASK,
    repository_identity_digest: created.value.authority.repository_identity_digest,
    revision: parseSafeInteger(4), phase_instance: PHASE, step: "produce", status: "running",
    attempt: parseSafeInteger(1), input_fingerprint: D("2"), initialization_digest: D("3"),
    config_digest: D("4"), workflow_digest: D("5"), constitution_digest: D("6"),
    policy_base_commit: "abcdef0123456789abcdef0123456789abcdef01" as TaskStateV1["policy_base_commit"],
    authoritative_results: [], approvals: [], waivers: [], ...extra,
  });
  return { root, services: created.value, state };
}

function receipt(state: TaskStateV1, intentId: string, marker: string) {
  const outcome = { path: "state.json", revision: state.revision + 1, status: "succeeded" };
  const prepared = { ...state, revision: parseSafeInteger(state.revision + 1), status: "succeeded" as const };
  return canonicalDocument(parseIntentReceipt({
    schema_version: "1", intent_id: parsePathSafeId(intentId), task_id: state.task_id,
    repository_identity_digest: state.repository_identity_digest, tool: "archflow_state",
    operation: parseSafeCode("record-state-boundary"), request_digest: D(marker),
    input_fingerprint: state.input_fingerprint, prior_revision: state.revision,
    resulting_revision: prepared.revision, result_id: parseSafeId(`state-${marker}`),
    outcome_digest: intentOutcomeDigest(outcome), outcome,
    prepared_state_digest: canonicalJsonDigest(prepared), prepared_state: prepared,
  }));
}

describe("discoverReconciliationInput", () => {
  it("ignores accumulated historical receipts on a healthy task", async () => {
    const h = await harness();
    const current = h.state();
    writeFileSync(join(h.services.authority.task_root, "intents", "old-a.json"), receipt(h.state({ revision: parseSafeInteger(2) }), "old-a", "7").bytes);
    writeFileSync(join(h.services.authority.task_root, "intents", "old-b.json"), receipt(h.state({ revision: parseSafeInteger(3) }), "old-b", "8").bytes);

    const discovered = await discoverReconciliationInput(h.services.dependencies, h.services.authority, canonicalDocument(current));
    expect(discovered).toMatchObject({ ok: true, value: { active_heads: {} } });
    if (!discovered.ok) return;
    expect(discovered.value.intent).toBeUndefined();
    expect(reconcileCurrentAuthority(discovered.value)).toEqual({ classification: "consistent", findings: [] });
  });

  it("offers the one prepared successor left by a receipt-before-state crash", async () => {
    const h = await harness();
    const current = h.state();
    const orphan = receipt(current, "orphan", "9");
    writeFileSync(join(h.services.authority.task_root, "intents", "orphan.json"), orphan.bytes);

    const discovered = await discoverReconciliationInput(h.services.dependencies, h.services.authority, canonicalDocument(current));
    expect(discovered).toMatchObject({ ok: true, value: { intent: { request_digest: D("9"), receipt: { digest: orphan.digest } } } });
    if (!discovered.ok) return;
    expect(reconcileCurrentAuthority(discovered.value).findings).toContainEqual(expect.objectContaining({ kind: "receipt-only" }));
  });

  it("reports ambiguity instead of guessing between two valid successors", async () => {
    const h = await harness();
    const current = h.state();
    writeFileSync(join(h.services.authority.task_root, "intents", "orphan-a.json"), receipt(current, "orphan-a", "a").bytes);
    writeFileSync(join(h.services.authority.task_root, "intents", "orphan-b.json"), receipt(current, "orphan-b", "b").bytes);

    const discovered = await discoverReconciliationInput(h.services.dependencies, h.services.authority, canonicalDocument(current));
    expect(discovered).toMatchObject({
      ok: true,
      value: { blocking_reasons: ["retained-receipt-ambiguity"] },
    });
    if (discovered.ok) expect(discovered.value.intent).toBeUndefined();
  });

  it("discovers retained/current projections and a matching gate head", async () => {
    const h = await harness();
    const projectionPath = parseRepositoryPathClaim("tracked.txt");
    const projectionDigest = sha256Bytes(Buffer.from("root\n"));
    const reference = {
      phase_instance: PHASE, step: "produce", result_digest: D("7"), result_id: parseSafeId("result-1"),
      input_fingerprint: D("2"),
      manifest_path: parseRepositoryPathClaim(`.archflow/tasks/${TASK}/results/sha256/${D("7")}/manifest.json`),
    } as TaskStateV1["authoritative_results"][number];

    const gateId = parsePathSafeId("gate-1");
    const gateContext = { artifact_kind: "phase-implementation" } as const;
    const contextDigest = computeGateContextDigest("artifact-approval", gateContext);
    const slot = () => ({
      role: "counter-review" as const, evidence_digest: D("9"),
      assurance: "server-attested" as const,
      producer_family: "claude" as const,
      reviewer_family: "codex" as const,
      independence: "opposite-family" as const,
    });
    const request = parseGateRequest({
      schema_version: "1", gate_id: gateId, intent_id: "gate-intent", request_digest: D("a"),
      task_id: TASK, phase_instance: PHASE, summary: "Approve", subject_digest: D("b"),
      context_digest: contextDigest, current_evidence: { set_digest: D("c"), slots: [slot()] },
      kind: "artifact-approval", context: gateContext,
      allowed_decisions: ["approve", "revise", "reject", "cancel"], opened_at_revision: 4,
    });
    const active = parseActiveGate({
      ...request, status: "awaiting-human", supplemental: [],
      decision_template: {
        schema_version: "1", gate_id: gateId, task_id: TASK, phase_instance: PHASE,
        kind: request.kind, subject_digest: request.subject_digest, context_digest: request.context_digest,
        required_fields: ["payload", "human_provenance"],
        cancellation_fields: ["cancelled", "reason", "human_provenance"],
      },
    });
    mkdirSync(join(h.services.authority.task_root, "decisions", gateId), { recursive: true });
    writeFileSync(join(h.services.authority.task_root, "gate.json"), canonicalDocument(active).bytes);
    writeFileSync(join(h.services.authority.task_root, "decisions", gateId, "request.json"), canonicalDocument(request).bytes);

    const current = h.state({
      authoritative_results: [reference],
      open_gate: {
        gate_id: gateId, gate_kind: request.kind, subject_digest: request.subject_digest,
        context_digest: request.context_digest, frozen_state_digest: D("e"), opened_at_revision: parseSafeInteger(4),
      },
    });
    const dependencies = {
      ...h.services.dependencies,
      load_retained_result: async () => ({
        schema_version: "1" as const, ok: true as const,
        value: {
          prepared: { manifest: { value: {
            outputs: [{ path: projectionPath, path_class: "repository-source", operation: "modify" }],
            projections: [{ path: projectionPath, content_digest: projectionDigest }],
            accounting: { measured_at_revision: 4 },
          } } },
        } as never,
      }),
    };
    const discovered = await discoverReconciliationInput(dependencies, h.services.authority, canonicalDocument(current));
    expect(discovered).toMatchObject({
      ok: true,
      value: {
        recorded_projections: [{ path: projectionPath, content_digest: projectionDigest }],
        current_projections: [{ path: projectionPath, content_digest: projectionDigest }],
        active_heads: {
          gate: { gate_id: gateId, subject_digest: request.subject_digest, context_digest: request.context_digest },
        },
      },
    });
    if (discovered.ok) expect(reconcileCurrentAuthority(discovered.value)).toEqual({ classification: "consistent", findings: [] });
  });

  it("uses the newest manifest generation when phases record the same projection path", async () => {
    const h = await harness();
    const path = parseRepositoryPathClaim("tracked.txt");
    const currentDigest = sha256Bytes(Buffer.from("root\n"));
    const older = {
      phase_instance: "design", step: "produce", result_digest: D("7"), result_id: parseSafeId("older"),
      input_fingerprint: D("2"),
      manifest_path: parseRepositoryPathClaim(`.archflow/tasks/${TASK}/results/sha256/${D("7")}/manifest.json`),
    } as TaskStateV1["authoritative_results"][number];
    const newer = {
      phase_instance: PHASE, step: "produce", result_digest: D("8"), result_id: parseSafeId("newer"),
      input_fingerprint: D("2"),
      manifest_path: parseRepositoryPathClaim(`.archflow/tasks/${TASK}/results/sha256/${D("8")}/manifest.json`),
    } as TaskStateV1["authoritative_results"][number];
    const dependencies = {
      ...h.services.dependencies,
      load_retained_result: async (reference: typeof older) => ({
        schema_version: "1" as const, ok: true as const,
        value: { prepared: { manifest: { value: {
          outputs: [{ path, path_class: "repository-source", operation: "modify" }],
          projections: [{ path, content_digest: reference.result_id === older.result_id ? D("a") : currentDigest }],
          accounting: { measured_at_revision: reference.result_id === older.result_id ? 3 : 4 },
        } } } } as never,
      }),
    };
    const discovered = await discoverReconciliationInput(
      dependencies, h.services.authority,
      canonicalDocument(h.state({ authoritative_results: [older, newer] })),
    );
    expect(discovered).toMatchObject({
      ok: true,
      value: {
        recorded_projections: [{ path, content_digest: currentDigest }],
        current_projections: [{ path, content_digest: currentDigest }],
      },
    });
  });
});

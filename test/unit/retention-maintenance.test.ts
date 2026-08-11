import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import { canonicalDocument, canonicalJsonDigest, sha256Bytes } from "../../src/contracts/canonical.js";
import type { IntentReceiptV1 } from "../../src/contracts/durable-intent.js";
import type { ResultManifestV1 } from "../../src/contracts/durable-result-manifest.js";
import type { TaskStateV1 } from "../../src/contracts/durable-state.js";
import { parseSafeInteger, parseSha256Digest, type SafeInteger, type Sha256Digest } from "../../src/contracts/evidence.js";
import type { PlainJsonValue } from "../../src/contracts/plain-json.js";
import type { RepositoryPathClaim } from "../../src/contracts/path-claims.js";
import type { ResolvedPath, ResolvedTaskPath } from "../../src/repository/paths.js";
import { runLocalCommand } from "../../src/local/commands.js";
import { computeMaintenanceProof, type MaintenanceCandidate, type MaintenanceManifest, type MaintenanceReferenceRoot } from "../../src/state/maintenance.js";
import { enumerateMaintenanceRoots, pruneSupersededResultPayloads } from "../../src/state/maintenance-roots.js";
import { createTaskWorkspace, type TaskWorkspace } from "../helpers/task-workspace.js";

const retainedManifests = vi.hoisted(() => new Map<string, ReturnType<typeof canonicalDocument<ResultManifestV1>>>());
vi.mock("../../src/state/snapshots.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../src/state/snapshots.js")>();
  return {
    ...actual,
    readSnapshot: vi.fn(async (input: { expected_result_digest: string }) => {
      const manifest = retainedManifests.get(input.expected_result_digest);
      if (manifest === undefined) throw new Error("unexpected retained result digest");
      return Object.freeze({ schema_version: "1", ok: true, value: manifest });
    }),
  };
});

const workspaces: TaskWorkspace[] = [];
afterEach(() => {
  retainedManifests.clear();
  for (const workspace of workspaces.splice(0)) workspace.dispose();
});

const digest = (character: string): Sha256Digest => parseSha256Digest(character.repeat(64));
const claim = (value: string): RepositoryPathClaim => value as RepositoryPathClaim;

function reference(
  taskId: string,
  resultDigest: Sha256Digest,
  phase: TaskStateV1["phase_instance"],
  step: TaskStateV1["step"],
): TaskStateV1["authoritative_results"][number] {
  return {
    phase_instance: phase,
    step,
    result_digest: resultDigest,
    result_id: `retained-${step.replaceAll("_", "-")}` as TaskStateV1["authoritative_results"][number]["result_id"],
    input_fingerprint: digest(step === "produce" ? "a" : "b"),
    manifest_path: claim(`.archflow/tasks/${taskId}/results/sha256/${resultDigest}/manifest.json`),
  };
}

function root(taskId: string, references: TaskStateV1["authoritative_results"]): MaintenanceReferenceRoot {
  return { task_id: taskId, authoritative_results: references } as MaintenanceReferenceRoot;
}

function manifest(taskId: string, outputPath: string): MaintenanceManifest {
  const value = {
    schema_version: "1",
    task_id: taskId,
    outputs: [{ path: claim(outputPath), storage: "raw-payload" }],
  } as unknown as ResultManifestV1;
  const resultDigest = canonicalJsonDigest(value);
  return {
    result_digest: resultDigest,
    manifest_path: claim(`.archflow/tasks/${taskId}/results/sha256/${resultDigest}/manifest.json`),
    manifest: value,
  };
}

function candidate(path: RepositoryPathClaim): MaintenanceCandidate {
  const bytes = Buffer.from(path);
  return {
    path,
    target: {
      absolute: `/tmp/${sha256Bytes(bytes)}` as ResolvedTaskPath,
      repositoryRelative: path,
      path_class: "result-payload",
    } as ResolvedPath,
    digest: sha256Bytes(bytes),
    byte_count: parseSafeInteger(bytes.byteLength),
    category: "superseded-payload",
  };
}

describe("retention, maintenance, and accounting", () => {
  it("keeps results reachable from checkpoint, resumable-receipt, and decision/review evidence roots", () => {
    const taskId = "retention-roots";
    const checkpointManifest = manifest(taskId, "checkpoint.md");
    const receiptManifest = manifest(taskId, "receipt.md");
    const evidenceManifest = manifest(taskId, "evidence.md");
    const manifests = [checkpointManifest, receiptManifest, evidenceManifest];
    const refs = manifests.map((item, index) => reference(
      taskId,
      item.result_digest,
      "phase-impl-20" as TaskStateV1["phase_instance"],
      ["produce", "counter_review", "triage"][index] as TaskStateV1["step"],
    ));
    const payloadPath = (item: MaintenanceManifest): RepositoryPathClaim =>
      claim(`${item.manifest_path.slice(0, -"manifest.json".length)}payload/${item.manifest.outputs[0]!.path}`);
    const livePaths = manifests.map(payloadPath);
    const orphan = claim(`.archflow/tasks/${taskId}/results/sha256/${digest("f")}/payload/orphan.md`);

    const proof = computeMaintenanceProof({
      roots: {
        inventory_complete: true,
        current_state: root(taskId, []) as TaskStateV1,
        checkpoints: [root(taskId, [refs[0]!])],
        resumable_receipts: [{ prepared_state: root(taskId, [refs[1]!]) as TaskStateV1 }],
        decision_review_evidence: [root(taskId, [refs[2]!])],
      },
      manifests,
      candidates: [...livePaths.map(candidate), candidate(orphan)],
    });

    expect(proof.reachable_manifests).toEqual(manifests.map((item) => item.manifest_path).sort());
    expect(proof.reachable_payloads).toEqual([...livePaths].sort());
    expect(proof.permitted_deletions.map((item) => item.path)).toEqual([orphan]);
  });

  it("runs the local maintain command and writes the reachability-bound record before pruning", async () => {
    const workspace = await createTaskWorkspace({ taskId: "retention-maintain", label: "retention-maintain" });
    workspaces.push(workspace);
    const attemptPath = join(workspace.services.authority.task_root, "attempts", "phase-impl-20", "orphan.json");
    mkdirSync(join(attemptPath, ".."), { recursive: true });
    writeFileSync(attemptPath, "orphan attempt\n");

    const result = await runLocalCommand({
      command: "maintain",
      working_directory: workspace.root,
      task_id: workspace.taskId,
      value: { maintenance_id: "prune-test", human_reason: "remove unreachable attempt" },
    });

    expect(result).toEqual({ record: "created", deleted: 1 });
    expect(() => readFileSync(attemptPath)).toThrow(/ENOENT/u);
    const record = JSON.parse(readFileSync(
      join(workspace.services.authority.task_root, "maintenance", "prune-test.json"),
      "utf8",
    )) as {
      reachability_proof_digest: string;
      deletions: readonly { path: string; byte_count: number; category: string }[];
      total_bytes_deleted: number;
    };
    expect(record.reachability_proof_digest).toMatch(/^[0-9a-f]{64}$/u);
    expect(record.deletions).toEqual([{
      path: `.archflow/tasks/${workspace.taskId}/attempts/phase-impl-20/orphan.json`,
      byte_count: Buffer.byteLength("orphan attempt\n"),
      category: "unreferenced-attempt",
      digest: sha256Bytes(Buffer.from("orphan attempt\n")),
    }]);
    expect(record.total_bytes_deleted).toBe(Buffer.byteLength("orphan attempt\n"));
  });

  it("accumulates injected nonzero accounting scalars across more than one retained result", async () => {
    const workspace = await createTaskWorkspace({ taskId: "retention-accounting", label: "retention-accounting" });
    workspaces.push(workspace);
    const current = workspace.services.state!.value;
    const makeRetained = (resultBytes: number, step: TaskStateV1["step"]) => {
      const value = {
        schema_version: "1",
        task_id: workspace.taskId,
        result_id: `retained-${step.replaceAll("_", "-")}`,
        phase_instance: "phase-impl-20",
        step,
        input_fingerprint: digest(step === "produce" ? "a" : "b"),
        outputs: [],
        projections: [],
        accounting: { result_bytes: parseSafeInteger(resultBytes) },
      } as unknown as ResultManifestV1;
      const document = canonicalDocument(value);
      retainedManifests.set(document.digest, document);
      return reference(workspace.taskId, document.digest, value.phase_instance, step);
    };
    const first = makeRetained(17, "produce");
    const second = makeRetained(29, "counter_review");
    writeFileSync(workspace.services.authority.state.absolute, canonicalDocument({
      ...current,
      authoritative_results: [second, first],
    }).bytes);

    await expect(workspace.services.dependencies.read_retained_task_bytes!()).resolves.toBe(46 as SafeInteger);
  });

  it("keeps the committed and successor receipts as roots and drops retired receipts", async () => {
    const workspace = await createTaskWorkspace({ taskId: "retention-receipts", label: "retention-receipts" });
    workspaces.push(workspace);
    const { authority, dependencies } = workspace.services;
    const current = workspace.services.state!.value;

    const live = await enumerateMaintenanceRoots(dependencies, authority);
    if (!live.ok) throw new Error(live.error.code);
    expect(live.value.resumable_receipts).toHaveLength(1);

    // Advance the durable revision past the initialization receipt: a retired receipt replays
    // from its recorded outcome bytes and must no longer pin result payloads.
    writeFileSync(authority.state.absolute, canonicalDocument({
      ...current,
      revision: parseSafeInteger(current.revision + 1),
    }).bytes);
    const advanced = await enumerateMaintenanceRoots(dependencies, authority);
    if (!advanced.ok) throw new Error(advanced.error.code);
    expect(advanced.value.resumable_receipts).toHaveLength(0);
  });

  it("prunes only unreachable payloads, keeps every manifest, and writes the accounting record", async () => {
    const workspace = await createTaskWorkspace({ taskId: "retention-prune", label: "retention-prune" });
    workspaces.push(workspace);
    const { authority, dependencies } = workspace.services;
    const current = workspace.services.state!.value;
    const taskRoot = authority.task_root;

    const writeResultDirectory = (outputPath: string, payload: string) => {
      const manifest = {
        schema_version: "1",
        task_id: workspace.taskId,
        outputs: [{ path: claim(outputPath), storage: "raw-payload" }],
      } as unknown as ResultManifestV1;
      const document = canonicalDocument(manifest as never);
      const directory = join(taskRoot, "results", "sha256", document.digest);
      mkdirSync(join(directory, "payload"), { recursive: true });
      writeFileSync(join(directory, "manifest.json"), document.bytes);
      writeFileSync(join(directory, "payload", outputPath), payload);
      return {
        digest: document.digest,
        manifest_absolute: join(directory, "manifest.json"),
        payload_absolute: join(directory, "payload", outputPath),
      };
    };
    const currentResult = writeResultDirectory("current.md", "current copy");
    const supersededResult = writeResultDirectory("old.md", "stale document copy");
    const successorResult = writeResultDirectory("successor.md", "successor copy");
    const decisionResult = writeResultDirectory("evidence.md", "decision-bound copy");

    // Current state references currentResult; successorResult is referenced only by a
    // not-yet-promoted successor receipt (the crash-arbitration reader's input);
    // decisionResult only by an archived gate decision; supersededResult by nothing.
    const phase = "phase-impl-20" as TaskStateV1["phase_instance"];
    const currentReference = reference(workspace.taskId, currentResult.digest, phase, "produce");
    writeFileSync(authority.state.absolute, canonicalDocument({
      ...current,
      authoritative_results: [currentReference],
    }).bytes);

    const { committed_intent: _committed, ...base } = current;
    const preparedState = {
      ...base,
      revision: parseSafeInteger(current.revision + 1),
      authoritative_results: [reference(workspace.taskId, successorResult.digest, phase, "counter_review")],
    } as TaskStateV1;
    const outcome = { path: "prd.md", revision: current.revision + 1, status: "succeeded" } as PlainJsonValue;
    const receipt = {
      schema_version: "1",
      intent_id: "successor-intent",
      task_id: workspace.taskId,
      repository_identity_digest: current.repository_identity_digest,
      tool: "archflow_state",
      operation: "record-document-artifact",
      request_digest: digest("c"),
      input_fingerprint: digest("a"),
      prior_revision: current.revision,
      resulting_revision: parseSafeInteger(current.revision + 1),
      result_id: "successor-result",
      outcome_digest: canonicalJsonDigest(outcome),
      outcome,
      prepared_state_digest: canonicalJsonDigest(preparedState as never),
      prepared_state: preparedState,
    } as unknown as IntentReceiptV1;
    writeFileSync(join(taskRoot, "intents", "successor-intent.json"), canonicalDocument(receipt as never).bytes);

    mkdirSync(join(taskRoot, "decisions", "gate-1"), { recursive: true });
    writeFileSync(join(taskRoot, "decisions", "gate-1", "decision.json"), canonicalDocument({
      schema_version: "1",
      gate_id: "gate-1",
      task_id: workspace.taskId,
      evidence_result_digest: decisionResult.digest,
    } as never).bytes);

    const attemptPath = join(taskRoot, "attempts", phase, "failed-dispatch.json");
    mkdirSync(join(attemptPath, ".."), { recursive: true });
    writeFileSync(attemptPath, "failed dispatch forensics\n");

    const pruned = await pruneSupersededResultPayloads(dependencies, authority);
    expect(pruned).toMatchObject({ ok: true, value: { deleted: 1 } });

    expect(existsSync(supersededResult.payload_absolute)).toBe(false);
    expect(existsSync(supersededResult.manifest_absolute)).toBe(true);
    expect(existsSync(currentResult.payload_absolute)).toBe(true);
    expect(existsSync(successorResult.payload_absolute)).toBe(true);
    expect(existsSync(decisionResult.payload_absolute)).toBe(true);
    expect(existsSync(attemptPath)).toBe(true);

    const record = JSON.parse(readFileSync(
      join(taskRoot, "maintenance", `auto-prune-r${current.revision}.json`),
      "utf8",
    )) as { performed_at_revision: number; deletions: readonly { path: string; category: string }[] };
    expect(record.performed_at_revision).toBe(current.revision);
    expect(record.deletions).toEqual([{
      path: `.archflow/tasks/${workspace.taskId}/results/sha256/${supersededResult.digest}/payload/old.md`,
      category: "superseded-payload",
      byte_count: Buffer.byteLength("stale document copy"),
      digest: sha256Bytes(Buffer.from("stale document copy")),
    }]);

    // Idempotent second pass: nothing left to reclaim, and no record collision.
    await expect(pruneSupersededResultPayloads(dependencies, authority))
      .resolves.toMatchObject({ ok: true, value: { deleted: 0 } });
  });
});

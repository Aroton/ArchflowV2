import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import { canonicalDocument, canonicalJsonDigest, sha256Bytes } from "../../src/contracts/canonical.js";
import type { ResultManifestV1 } from "../../src/contracts/durable-result-manifest.js";
import type { TaskStateV1 } from "../../src/contracts/durable-state.js";
import { parseSafeInteger, parseSha256Digest, type SafeInteger, type Sha256Digest } from "../../src/contracts/evidence.js";
import type { RepositoryPathClaim } from "../../src/contracts/path-claims.js";
import type { ResolvedPath, ResolvedTaskPath } from "../../src/repository/paths.js";
import { runLocalCommand } from "../../src/local/commands.js";
import { computeMaintenanceProof, type MaintenanceCandidate, type MaintenanceManifest, type MaintenanceReferenceRoot } from "../../src/state/maintenance.js";
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
    input_fingerprint: digest(step === "self_review" ? "a" : "b"),
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

describe("Phase 20 retention, maintenance, and accounting", () => {
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
      ["self_review", "counter_review", "triage"][index] as TaskStateV1["step"],
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
      value: { maintenance_id: "phase20-prune", human_reason: "remove unreachable Phase 20 attempt" },
    });

    expect(result).toEqual({ record: "created", deleted: 1 });
    expect(() => readFileSync(attemptPath)).toThrow(/ENOENT/u);
    const record = JSON.parse(readFileSync(
      join(workspace.services.authority.task_root, "maintenance", "phase20-prune.json"),
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
        input_fingerprint: digest(step === "self_review" ? "a" : "b"),
        outputs: [],
        projections: [],
        accounting: { result_bytes: parseSafeInteger(resultBytes) },
      } as unknown as ResultManifestV1;
      const document = canonicalDocument(value);
      retainedManifests.set(document.digest, document);
      return reference(workspace.taskId, document.digest, value.phase_instance, step);
    };
    const first = makeRetained(17, "self_review");
    const second = makeRetained(29, "counter_review");
    writeFileSync(workspace.services.authority.state.absolute, canonicalDocument({
      ...current,
      authoritative_results: [second, first],
    }).bytes);

    await expect(workspace.services.dependencies.read_retained_task_bytes!()).resolves.toBe(46 as SafeInteger);
  });
});

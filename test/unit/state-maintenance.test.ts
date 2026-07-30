import { mkdtemp, mkdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { canonicalJsonDigest, sha256Bytes } from "../../src/contracts/canonical.js";
import type { MaintenanceRecordV1 } from "../../src/contracts/durable-maintenance.js";
import type { TaskStateV1 } from "../../src/contracts/durable-state.js";
import type { PathSafeId, SafeInteger, Sha256Digest, TaskSlug } from "../../src/contracts/evidence.js";
import type { RepositoryPathClaim } from "../../src/contracts/path-claims.js";
import type { ResolvedPath, ResolvedTaskPath } from "../../src/repository/paths.js";
import { createAtomicWriter } from "../../src/state/atomic.js";
import {
  computeMaintenanceProof,
  performMaintenance,
  type MaintenanceCandidate,
  type MaintenanceManifest,
  type MaintenanceProof,
} from "../../src/state/maintenance.js";
import type { SnapshotManifest } from "../../src/state/snapshots.js";

const roots: string[] = [];
afterEach(async () => Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))));
const TASK = "demo" as TaskSlug;
const P = (value: string): RepositoryPathClaim => value as RepositoryPathClaim;
const D = (value: string): Sha256Digest => value.repeat(64).slice(0, 64) as Sha256Digest;
function resolved(absolute: string, path_class: ResolvedPath["path_class"], claim: RepositoryPathClaim): ResolvedPath { return { absolute: absolute as ResolvedTaskPath, path_class, repositoryRelative: claim }; }
function emptyState(results: TaskStateV1["authoritative_results"] = []): TaskStateV1 {
  return { task_id: TASK, authoritative_results: results } as unknown as TaskStateV1;
}
function rootSet(current_state: TaskStateV1) {
  return { inventory_complete: true as const, current_state, checkpoints: [], resumable_receipts: [], decision_review_evidence: [] };
}
function suppliedManifest(path: RepositoryPathClaim, outputs: SnapshotManifest["outputs"] = []): MaintenanceManifest {
  const manifest = { schema_version: "1", outputs } as unknown as SnapshotManifest;
  return { result_digest: canonicalJsonDigest(manifest), manifest_path: path, manifest };
}
function maintenanceRecord(proof: MaintenanceProof): MaintenanceRecordV1 {
  return {
    schema_version: "1", maintenance_id: "m1" as PathSafeId, task_id: TASK,
    performed_at_revision: 1 as SafeInteger, human_reason: "remove superseded retained bytes",
    reachability_proof_digest: proof.digest,
    deletions: proof.permitted_deletions.map(({ target: _target, ...deletion }) => deletion),
    total_bytes_deleted: proof.permitted_deletions.reduce((total, deletion) => total + deletion.byte_count, 0) as SafeInteger,
  };
}

describe("bounded maintenance", () => {
  it("fails closed when a named manifest is absent", () => {
    const state = { task_id: TASK, authoritative_results: [{ result_digest: D("1"), manifest_path: P(".archflow/tasks/demo/results/sha256/x/manifest.json") }] } as unknown as TaskStateV1;
    expect(() => computeMaintenanceProof({ roots: { inventory_complete: true, current_state: state, checkpoints: [], resumable_receipts: [], decision_review_evidence: [] }, manifests: [], candidates: [] })).toThrow(/not supplied/u);
  });

  it("rejects split-observation inputs and binds every supplied manifest to its content address", () => {
    const manifestPath = P(".archflow/tasks/demo/results/sha256/x/manifest.json");
    const supplied = suppliedManifest(manifestPath);
    const state = emptyState([{ result_digest: supplied.result_digest, manifest_path: manifestPath }] as unknown as TaskStateV1["authoritative_results"]);
    const input = {
      roots: rootSet(state),
      get manifests() { return [supplied]; },
      candidates: [],
    };
    expect(() => computeMaintenanceProof(input)).toThrow(/own enumerable data property/u);
    expect(computeMaintenanceProof({ roots: rootSet(state), manifests: [supplied], candidates: [] }).reachable_manifests).toEqual([manifestPath]);
    expect(() => computeMaintenanceProof({
      roots: rootSet(emptyState()),
      manifests: [{ ...supplied, result_digest: D("f") }],
      candidates: [],
    })).toThrow(/content address disagrees/u);
    expect(() => computeMaintenanceProof({
      roots: rootSet(emptyState()), manifests: [],
      candidates: [{
        digest: D("a"), path: P(".archflow/tasks/demo/results/sha256/x/payload/a"), byte_count: 1 as SafeInteger,
        category: "superseded-payload",
        target: resolved("/tmp/b", "result-payload", P(".archflow/tasks/demo/results/sha256/x/payload/b")),
      }],
    })).toThrow(/resolved target disagree/u);
  });

  it("refuses a reachable payload and deletes only the superseded payload", async () => {
    const directory = await mkdtemp(join(tmpdir(), "archflow-maintenance-")); roots.push(directory);
    await mkdir(join(directory, "maintenance"));
    const manifestPath = P(".archflow/tasks/demo/results/sha256/x/manifest.json");
    const livePath = P(".archflow/tasks/demo/results/sha256/x/payload/live.txt");
    const stalePath = P(".archflow/tasks/demo/results/sha256/old/payload/stale.txt");
    const liveAbsolute = join(directory, "live.txt");
    const staleAbsolute = join(directory, "stale.txt");
    const liveBytes = Buffer.from("live");
    const staleBytes = Buffer.from("stale");
    await writeFile(liveAbsolute, liveBytes);
    await writeFile(staleAbsolute, staleBytes);
    const output = {
      path: P("live.txt"), storage: "raw-payload",
    } as unknown as SnapshotManifest["outputs"][number];
    const supplied = suppliedManifest(manifestPath, [output]);
    const state = emptyState([{ result_digest: supplied.result_digest, manifest_path: manifestPath }] as unknown as TaskStateV1["authoritative_results"]);
    const candidate = (path: RepositoryPathClaim, absolute: string, bytes: Uint8Array): MaintenanceCandidate => ({
      digest: sha256Bytes(bytes), path, byte_count: bytes.byteLength as SafeInteger,
      category: "superseded-payload", target: resolved(absolute, "result-payload", path),
    });
    const proof = computeMaintenanceProof({
      roots: rootSet(state), manifests: [supplied],
      candidates: [candidate(livePath, liveAbsolute, liveBytes), candidate(stalePath, staleAbsolute, staleBytes)],
    });
    expect(proof.reachable_payloads).toEqual([livePath]);
    expect(proof.permitted_deletions.map((item) => item.path)).toEqual([stalePath]);
    const recordTarget = resolved(join(directory, "maintenance", "m1.json"), "maintenance-record", P(".archflow/tasks/demo/maintenance/m1.json"));
    await expect(performMaintenance({
      atomic: createAtomicWriter(), record_target: recordTarget, record: maintenanceRecord(proof), proof,
      validate_record: (value: unknown) => value as MaintenanceRecordV1,
    })).resolves.toEqual({ record: "created", deleted: 1 });
    expect(await readFile(liveAbsolute)).toEqual(liveBytes);
    await expect(readFile(staleAbsolute)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("writes the immutable record before idempotently deleting an admitted candidate", async () => {
    const directory = await mkdtemp(join(tmpdir(), "archflow-maintenance-")); roots.push(directory);
    await mkdir(join(directory, "maintenance"));
    const candidatePath = P(".archflow/tasks/demo/attempts/phase-impl-1/attempt.json");
    const candidateTarget = resolved(join(directory, "attempt.json"), "attempt", candidatePath);
    const bytes = Buffer.from("attempt"); await writeFile(candidateTarget.absolute, bytes);
    const state = { task_id: TASK, authoritative_results: [] } as unknown as TaskStateV1;
    const candidate = { digest: sha256Bytes(bytes), path: candidatePath, byte_count: bytes.byteLength as SafeInteger, category: "unreferenced-attempt", target: candidateTarget } as const;
    const proof = computeMaintenanceProof({ roots: { inventory_complete: true, current_state: state, checkpoints: [], resumable_receipts: [], decision_review_evidence: [] }, manifests: [], candidates: [candidate] });
    const record: MaintenanceRecordV1 = { schema_version: "1", maintenance_id: "m1" as PathSafeId, task_id: TASK, performed_at_revision: 1 as SafeInteger, human_reason: "remove failed attempt", reachability_proof_digest: proof.digest, deletions: [{ digest: candidate.digest, path: candidate.path, byte_count: candidate.byte_count, category: candidate.category }], total_bytes_deleted: candidate.byte_count };
    const recordTarget = resolved(join(directory, "maintenance", "m1.json"), "maintenance-record", P(".archflow/tasks/demo/maintenance/m1.json"));
    const input = { atomic: createAtomicWriter(), record_target: recordTarget, record, proof, validate_record: (value: unknown) => value as MaintenanceRecordV1 };
    await expect(performMaintenance(input)).resolves.toEqual({ record: "created", deleted: 1 });
    await expect(performMaintenance(input)).resolves.toEqual({ record: "reused", deleted: 0 });
    await expect(readFile(candidateTarget.absolute)).rejects.toMatchObject({ code: "ENOENT" });
    expect(await readFile(recordTarget.absolute)).toBeTruthy();
  });

  it("leaves a record before a candidate identity failure and never follows a candidate symlink", async () => {
    const directory = await mkdtemp(join(tmpdir(), "archflow-maintenance-")); roots.push(directory);
    await mkdir(join(directory, "maintenance"));
    const realPath = join(directory, "real-payload");
    const linkPath = join(directory, "payload-link");
    const bytes = Buffer.from("retained");
    await writeFile(realPath, bytes);
    await symlink(realPath, linkPath);
    const candidatePath = P(".archflow/tasks/demo/results/sha256/old/payload/value");
    const candidate: MaintenanceCandidate = {
      digest: sha256Bytes(bytes), path: candidatePath, byte_count: bytes.byteLength as SafeInteger,
      category: "superseded-payload", target: resolved(linkPath, "result-payload", candidatePath),
    };
    const proof = computeMaintenanceProof({ roots: rootSet(emptyState()), manifests: [], candidates: [candidate] });
    const recordTarget = resolved(join(directory, "maintenance", "m1.json"), "maintenance-record", P(".archflow/tasks/demo/maintenance/m1.json"));
    await expect(performMaintenance({
      atomic: createAtomicWriter(), record_target: recordTarget, record: maintenanceRecord(proof), proof,
      validate_record: (value: unknown) => value as MaintenanceRecordV1,
    })).rejects.toMatchObject({ code: expect.stringMatching(/ELOOP|EMLINK/u) });
    expect(await readFile(recordTarget.absolute)).toBeTruthy();
    expect(await readFile(realPath)).toEqual(bytes);
  });
});

import { unlink } from "node:fs/promises";
import { dirname } from "node:path";

import { canonicalDocument, canonicalJsonDigest, sha256Bytes } from "../contracts/canonical.js";
import type { MaintenanceDeletion, MaintenanceRecordV1 } from "../contracts/durable-maintenance.js";
import type { AuthoritativeResultRef, TaskStateV1 } from "../contracts/durable-state.js";
import type { Sha256Digest, TaskSlug } from "../contracts/evidence.js";
import type { RepositoryPathClaim } from "../contracts/path-claims.js";
import { assertPlainJson, type PlainJsonValue } from "../contracts/plain-json.js";
import { openResolved, type ResolvedPath } from "../repository/paths.js";
import type { AtomicWriter } from "./atomic.js";
import type { SnapshotManifest } from "./snapshots.js";

export type MaintenanceReferenceRoot = Readonly<{
  task_id: TaskSlug;
  authoritative_results: readonly AuthoritativeResultRef[];
}>;

export type MaintenanceRoots = Readonly<{
  inventory_complete: true;
  current_state: TaskStateV1;
  checkpoints: readonly MaintenanceReferenceRoot[];
  resumable_receipts: readonly Readonly<{ prepared_state: TaskStateV1 }>[];
  decision_review_evidence: readonly MaintenanceReferenceRoot[];
}>;

export type MaintenanceManifest = Readonly<{
  result_digest: Sha256Digest;
  manifest_path: RepositoryPathClaim;
  manifest: SnapshotManifest;
}>;

export type MaintenanceCandidate = MaintenanceDeletion & Readonly<{ target: ResolvedPath }>;

export type MaintenanceProof = Readonly<{
  task_id: TaskSlug;
  reachable_manifests: readonly RepositoryPathClaim[];
  reachable_payloads: readonly RepositoryPathClaim[];
  permitted_deletions: readonly MaintenanceCandidate[];
  digest: Sha256Digest;
}>;

function ownEnumerableData(value: object, key: string): unknown {
  const descriptor = Object.getOwnPropertyDescriptor(value, key);
  if (descriptor === undefined || !("value" in descriptor) || !descriptor.enumerable) {
    throw new TypeError(`${key} must be an own enumerable data property`);
  }
  return descriptor.value;
}

function ordinal(left: string, right: string): number { return left < right ? -1 : left > right ? 1 : 0; }

/** Fixed two-step walk: supplied roots -> their named manifests -> those manifests' named payloads. */
export function computeMaintenanceProof(input: Readonly<{
  roots: MaintenanceRoots;
  manifests: readonly MaintenanceManifest[];
  candidates: readonly MaintenanceCandidate[];
}>): MaintenanceProof {
  const rootsValue = ownEnumerableData(input, "roots");
  assertPlainJson(rootsValue, "maintenance roots");
  const roots = structuredClone(rootsValue) as MaintenanceRoots;
  const manifestsValue = ownEnumerableData(input, "manifests");
  assertPlainJson(manifestsValue, "maintenance manifests");
  const manifestItems = structuredClone(manifestsValue) as unknown as readonly MaintenanceManifest[];
  const candidatesValue = ownEnumerableData(input, "candidates");
  assertPlainJson(candidatesValue, "maintenance candidates");
  const candidates = structuredClone(candidatesValue) as unknown as readonly MaintenanceCandidate[];
  if (roots.inventory_complete !== true) throw new TypeError("maintenance root inventory is incomplete");
  const taskId = roots.current_state.task_id;
  const rootDocuments: readonly MaintenanceReferenceRoot[] = [
    roots.current_state,
    ...roots.checkpoints,
    ...roots.resumable_receipts.map((receipt) => receipt.prepared_state),
    ...roots.decision_review_evidence,
  ];
  if (rootDocuments.some((root) => root.task_id !== taskId)) throw new TypeError("maintenance root task mismatch");

  const manifests = new Map<Sha256Digest, MaintenanceManifest>();
  for (const item of manifestItems) {
    if (canonicalJsonDigest(item.manifest) !== item.result_digest) {
      throw new TypeError("supplied result manifest content address disagrees");
    }
    if (manifests.has(item.result_digest)) throw new TypeError("duplicate supplied result manifest");
    manifests.set(item.result_digest, item);
  }
  const reachableManifests = new Set<RepositoryPathClaim>();
  const reachablePayloads = new Set<RepositoryPathClaim>();
  for (const root of rootDocuments) {
    for (const reference of root.authoritative_results) {
      const item = manifests.get(reference.result_digest);
      if (item === undefined) throw new TypeError("a named result manifest was not supplied");
      if (item.manifest_path !== reference.manifest_path || item.result_digest !== reference.result_digest) {
        throw new TypeError("result reference and supplied manifest disagree");
      }
      reachableManifests.add(item.manifest_path);
      const payloadRoot = `${dirname(item.manifest_path)}/payload`;
      for (const output of item.manifest.outputs) {
        if (output.storage === "raw-payload") {
          reachablePayloads.add(`${payloadRoot}/${output.path}` as RepositoryPathClaim);
        }
      }
    }
  }

  const permitted = candidates.filter((candidate) => {
    if (candidate.path !== candidate.target.repositoryRelative) {
      throw new TypeError("maintenance candidate and resolved target disagree");
    }
    if (candidate.category === "unreferenced-attempt") {
      return candidate.target.path_class === "attempt";
    }
    return candidate.target.path_class === "result-payload" && !reachablePayloads.has(candidate.path);
  }).sort((left, right) => ordinal(left.digest, right.digest));
  if (new Set(permitted.map((item) => item.digest)).size !== permitted.length) {
    throw new TypeError("maintenance candidates must have unique digests");
  }

  const reachableManifestList = [...reachableManifests].sort(ordinal);
  const reachablePayloadList = [...reachablePayloads].sort(ordinal);
  const subject = {
    schema_version: "1",
    digest_kind: "maintenance-reachability",
    task_id: taskId,
    reachable_manifests: reachableManifestList,
    reachable_payloads: reachablePayloadList,
    permitted_deletions: permitted.map(({ target: _target, ...deletion }) => deletion),
  } as const satisfies PlainJsonValue;
  return Object.freeze({
    task_id: taskId,
    reachable_manifests: Object.freeze(reachableManifestList),
    reachable_payloads: Object.freeze(reachablePayloadList),
    permitted_deletions: Object.freeze(permitted),
    digest: canonicalJsonDigest(subject),
  });
}

async function readResolved(path: ResolvedPath): Promise<Uint8Array> {
  const handle = await openResolved(path.absolute, 0);
  try {
    return await handle.readFile();
  } finally {
    await handle.close();
  }
}

function sameDeletion(left: MaintenanceDeletion, right: MaintenanceCandidate): boolean {
  return left.digest === right.digest && left.path === right.path && left.byte_count === right.byte_count && left.category === right.category;
}

/** Writes the immutable record before deleting only candidates admitted by the proof. */
export async function performMaintenance(input: Readonly<{
  atomic: AtomicWriter;
  record_target: ResolvedPath;
  record: MaintenanceRecordV1;
  proof: MaintenanceProof;
  validate_record: (value: unknown) => MaintenanceRecordV1;
}>): Promise<Readonly<{ record: "created" | "reused"; deleted: number }>> {
  if (input.record_target.path_class !== "maintenance-record") throw new TypeError("maintenance record target has wrong class");
  assertPlainJson(input.record, "maintenance record");
  const record = structuredClone(input.record);
  input.validate_record(record);
  if (record.task_id !== input.proof.task_id || record.reachability_proof_digest !== input.proof.digest) {
    throw new TypeError("maintenance record does not bind the supplied reachability proof");
  }
  if (record.deletions.length !== input.proof.permitted_deletions.length ||
      record.deletions.some((deletion, index) => !sameDeletion(deletion, input.proof.permitted_deletions[index]!))) {
    throw new TypeError("maintenance record deletion set is not exactly the permitted set");
  }
  const document = canonicalDocument(record);
  let installation = await input.atomic.createExclusive(input.record_target, document.bytes);
  if (installation === "exists") {
    const existing = await readResolved(input.record_target);
    if (!Buffer.from(existing).equals(Buffer.from(document.bytes))) throw new TypeError("maintenance record address disagrees");
  }

  let deleted = 0;
  for (const candidate of input.proof.permitted_deletions) {
    try {
      const bytes = await readResolved(candidate.target);
      if (bytes.byteLength !== candidate.byte_count || sha256Bytes(bytes) !== candidate.digest) {
        throw new TypeError("maintenance candidate identity disagrees");
      }
      await unlink(candidate.target.absolute);
      deleted += 1;
    } catch (error) {
      if ((error as { code?: unknown }).code !== "ENOENT") throw error;
    }
  }
  return Object.freeze({ record: installation === "created" ? "created" : "reused", deleted });
}

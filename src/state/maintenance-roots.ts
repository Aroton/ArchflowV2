import { constants as fsConstants } from "node:fs";
import { readdir } from "node:fs/promises";
import { join, relative, sep } from "node:path";

import { parseCanonicalDocument, sha256Bytes } from "../contracts/canonical.js";
import { parseIntentReceipt } from "../contracts/durable-intent.js";
import type { TaskStateV1 } from "../contracts/durable-state.js";
import { createProjectError, type ProjectResult } from "../contracts/errors.js";
import { parseTaskPathClaim } from "../contracts/path-claims.js";
import { assertPlainJson, type PlainJsonValue } from "../contracts/plain-json.js";
import { openResolved, resolveTaskPath, type ResolvedTaskPath } from "../repository/paths.js";
import type { TransactionAuthority } from "./authority.js";
import { assertInternalTransactionAuthority } from "./authority.js";
import type { MaintenanceCandidate, MaintenanceManifest, MaintenanceReferenceRoot, MaintenanceRoots } from "./maintenance.js";
import { readManualCheckpoints } from "./manual-checkpoints.js";
import { readTaskState } from "./read.js";
import type { SnapshotManifest } from "./snapshots.js";
import type { TransactionDependencies } from "./transaction.js";

const ok = <T>(value: T): ProjectResult<T> => Object.freeze({ schema_version: "1", ok: true, value });
const fail = (authority: TransactionAuthority, operation: string): ProjectResult<never> => Object.freeze({
  schema_version: "1", ok: false,
  error: createProjectError("IO_ERROR", { operation, attempt: authority.context.attempt }),
});

async function regularFiles(root: string, prefix = ""): Promise<string[]> {
  let entries;
  try { entries = await readdir(join(root, prefix), { withFileTypes: true }); }
  catch (error) { if ((error as { code?: string }).code === "ENOENT") return []; throw error; }
  const files: string[] = [];
  for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
    if (entry.isSymbolicLink()) throw new TypeError("maintenance inventory contains a symlink");
    const path = prefix ? `${prefix}/${entry.name}` : entry.name;
    if (entry.isDirectory()) files.push(...await regularFiles(root, path));
    else if (entry.isFile()) files.push(path);
    else throw new TypeError("maintenance inventory contains a non-regular entry");
  }
  return files;
}

async function readTaskFile(authority: TransactionAuthority, path: string): Promise<Uint8Array> {
  const absolute = join(authority.task_root, ...path.split("/"));
  const rel = relative(authority.task_root, absolute);
  if (rel === ".." || rel.startsWith(`..${sep}`)) throw new TypeError("maintenance path escaped task root");
  const handle = await openResolved(absolute as ResolvedTaskPath, fsConstants.O_RDONLY);
  try { return new Uint8Array(await handle.readFile()); } finally { await handle.close(); }
}

function referenceRoot(value: PlainJsonValue, taskId: string): MaintenanceReferenceRoot | undefined {
  if (value === null || Array.isArray(value) || typeof value !== "object") return undefined;
  const candidate = value as Record<string, PlainJsonValue>;
  if (candidate.task_id !== taskId || !Array.isArray(candidate.authoritative_results)) return undefined;
  return candidate as unknown as MaintenanceReferenceRoot;
}

export async function enumerateMaintenanceRoots(
  dependencies: TransactionDependencies,
  authority: TransactionAuthority,
): Promise<ProjectResult<MaintenanceRoots>> {
  assertInternalTransactionAuthority(authority, dependencies);
  const stateRead = await readTaskState(authority.state);
  if (stateRead.kind !== "canonical") return fail(authority, "enumerate-maintenance-state");
  const checkpoints = await readManualCheckpoints(dependencies, authority);
  if (!checkpoints.ok) return checkpoints;
  try {
    const receipts = [];
    for (const path of await regularFiles(join(authority.task_root, "intents"))) {
      if (!path.endsWith(".json")) throw new TypeError("invalid intent inventory");
      const document = parseCanonicalDocument<PlainJsonValue>(await readTaskFile(authority, `intents/${path}`), "intent receipt");
      receipts.push({ prepared_state: parseIntentReceipt(document.value).prepared_state });
    }
    const decisionReviewEvidence: MaintenanceReferenceRoot[] = [];
    for (const directory of ["decisions", "reviews"] as const) {
      for (const path of await regularFiles(join(authority.task_root, directory))) {
        if (!path.endsWith(".json")) continue;
        const document = parseCanonicalDocument<PlainJsonValue>(await readTaskFile(authority, `${directory}/${path}`), "decision/review evidence");
        assertPlainJson(document.value, "decision/review evidence");
        const root = referenceRoot(document.value, authority.task_id);
        if (root !== undefined) decisionReviewEvidence.push(root);
      }
    }
    return ok(Object.freeze({
      inventory_complete: true as const,
      current_state: stateRead.document.value,
      checkpoints: Object.freeze(checkpoints.value.map((document) => document.value)),
      resumable_receipts: Object.freeze(receipts),
      decision_review_evidence: Object.freeze(decisionReviewEvidence),
    }));
  } catch { return fail(authority, "enumerate-maintenance-roots"); }
}

export async function enumerateMaintenanceManifests(
  dependencies: TransactionDependencies,
  authority: TransactionAuthority,
  roots: MaintenanceRoots,
): Promise<ProjectResult<readonly MaintenanceManifest[]>> {
  assertInternalTransactionAuthority(authority, dependencies);
  const references = new Map<string, string>();
  for (const root of [roots.current_state, ...roots.checkpoints, ...roots.resumable_receipts.map((item) => item.prepared_state), ...roots.decision_review_evidence]) {
    for (const reference of root.authoritative_results) references.set(reference.result_digest, reference.manifest_path);
  }
  try {
    const manifests: MaintenanceManifest[] = [];
    for (const [resultDigest, manifestPath] of [...references].sort()) {
      const prefix = `.archflow/tasks/${authority.task_id}/`;
      if (!manifestPath.startsWith(prefix)) throw new TypeError("manifest outside task");
      const document = parseCanonicalDocument<SnapshotManifest>(await readTaskFile(authority, manifestPath.slice(prefix.length)), "result manifest");
      manifests.push({ result_digest: resultDigest as MaintenanceManifest["result_digest"], manifest_path: manifestPath as MaintenanceManifest["manifest_path"], manifest: document.value });
    }
    return ok(Object.freeze(manifests));
  } catch { return fail(authority, "enumerate-maintenance-manifests"); }
}

export async function enumerateMaintenanceCandidates(
  dependencies: TransactionDependencies,
  authority: TransactionAuthority,
  roots: MaintenanceRoots,
): Promise<ProjectResult<readonly MaintenanceCandidate[]>> {
  assertInternalTransactionAuthority(authority, dependencies);
  const referenced = new Set([roots.current_state, ...roots.checkpoints, ...roots.resumable_receipts.map((item) => item.prepared_state), ...roots.decision_review_evidence]
    .flatMap((root) => root.authoritative_results.map((item) => item.result_digest)));
  try {
    const candidates: MaintenanceCandidate[] = [];
    for (const path of await regularFiles(join(authority.task_root, "attempts"))) {
      const claim = parseTaskPathClaim(`attempts/${path}`);
      const target = await resolveTaskPath({ runner: dependencies.runner, taskId: authority.task_id, claim, expectedClass: "attempt", context: authority.context });
      if (!target.ok) return target;
      const bytes = await readTaskFile(authority, claim);
      candidates.push({ path: target.value.repositoryRelative, target: target.value, digest: sha256Bytes(bytes), byte_count: bytes.byteLength as MaintenanceCandidate["byte_count"], category: "unreferenced-attempt" });
    }
    for (const path of await regularFiles(join(authority.task_root, "results", "sha256"))) {
      const match = path.match(/^([0-9a-f]{64})\/payload\/(.+)$/u);
      if (!match || referenced.has(match[1] as never)) continue;
      const claim = parseTaskPathClaim(`results/sha256/${path}`);
      const target = await resolveTaskPath({ runner: dependencies.runner, taskId: authority.task_id, claim, expectedClass: "result-payload", context: authority.context });
      if (!target.ok) return target;
      const bytes = await readTaskFile(authority, claim);
      candidates.push({ path: target.value.repositoryRelative, target: target.value, digest: sha256Bytes(bytes), byte_count: bytes.byteLength as MaintenanceCandidate["byte_count"], category: "superseded-payload" });
    }
    return ok(Object.freeze(candidates.sort((a, b) => a.digest.localeCompare(b.digest))));
  } catch { return fail(authority, "enumerate-maintenance-candidates"); }
}

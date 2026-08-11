import { constants as fsConstants } from "node:fs";
import { mkdir, readdir } from "node:fs/promises";
import { join, relative, sep } from "node:path";

import { parseCanonicalDocument, sha256Bytes } from "../contracts/canonical.js";
import { parseIntentReceipt } from "../contracts/durable-intent.js";
import {
  MAINTENANCE_DELETION_CATEGORIES,
  type MaintenanceDeletionCategory,
  type MaintenanceRecordV1,
} from "../contracts/durable-maintenance.js";
import type { TaskStateV1 } from "../contracts/durable-state.js";
import { createProjectError, type ProjectResult } from "../contracts/errors.js";
import { parsePathSafeId, parseSafeInteger } from "../contracts/evidence.js";
import { parseRepositoryPathClaim, parseTaskPathClaim } from "../contracts/path-claims.js";
import { assertPlainJson, type PlainJsonValue } from "../contracts/plain-json.js";
import maintenanceRecordSchema from "../contracts/schemas/v1/maintenance-record.schema.json" with { type: "json" };
import pathClaimSchema from "../contracts/schemas/v1/path-claim.schema.json" with { type: "json" };
import primitivesSchema from "../contracts/schemas/v1/primitives.schema.json" with { type: "json" };
import { createJsonSchemaValidator } from "../contracts/validators.js";
import { openResolved, resolveTaskPath, type ResolvedTaskPath } from "../repository/paths.js";
import type { TransactionAuthority } from "./authority.js";
import { assertInternalTransactionAuthority } from "./authority.js";
import {
  computeMaintenanceProof,
  performMaintenance,
  type MaintenanceCandidate,
  type MaintenanceIntentInventory,
  type MaintenanceManifest,
  type MaintenanceReferenceRoot,
  type MaintenanceRoots,
} from "./maintenance.js";
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
    const intents: MaintenanceIntentInventory[] = [];
    const stagedRequests = new Set<string>();
    // Repository-relative, matching how candidates report themselves, so the proof can compare
    // the retained set against candidate paths directly.
    const intentClaim = (name: string) =>
      parseRepositoryPathClaim(`.archflow/tasks/${authority.task_id}/intents/${name}`);
    const intentFiles = await regularFiles(join(authority.task_root, "intents"));
    for (const path of intentFiles) {
      if (!path.endsWith(".json")) throw new TypeError("invalid intent inventory");
      // Staged requests share the intents directory under the reserved `.request.json` suffix.
      // They are convenience bytes the request digest re-authenticates on use, never roots:
      // treating one as a receipt would both fail receipt parsing and, worse, let a stale
      // staged file pin superseded payloads. A staged request for a retired intent is simply
      // deletable — collected here so the proof can decide that rather than a delete-site filter.
      if (path.endsWith(".request.json")) { stagedRequests.add(path); continue; }
      const document = parseCanonicalDocument<PlainJsonValue>(await readTaskFile(authority, `intents/${path}`), "intent receipt");
      const receipt = parseIntentReceipt(document.value);
      // Only receipts arbitration can still consume pin results: the receipt committed at the
      // current revision and any not-yet-promoted successor (crash between receipt and state
      // write). A retired receipt's replay reads its own recorded outcome bytes, never result
      // payloads, so its prepared_state must not keep superseded payloads reachable forever.
      if (receipt.resulting_revision >= stateRead.document.value.revision) {
        receipts.push({ prepared_state: receipt.prepared_state });
      }
      const stagedName = `${receipt.intent_id}.request.json`;
      intents.push(Object.freeze({
        path: intentClaim(path),
        intent_id: receipt.intent_id,
        operation: receipt.operation,
        resulting_revision: receipt.resulting_revision,
        ...(intentFiles.includes(stagedName) ? { staged_request_path: intentClaim(stagedName) } : {}),
      }));
    }
    for (const intent of intents) stagedRequests.delete(`${intent.intent_id}.request.json`);
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
      intents: Object.freeze(intents),
      unreceipted_staged_requests: Object.freeze([...stagedRequests].sort().map(intentClaim)),
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

/**
 * Digest-shaped strings observed anywhere in the gate archive, retained review records, the
 * manual checkpoint chain, or the live gate interface. The match is deliberately lexical rather
 * than parsed: those documents reference results through several envelope shapes (authority
 * links, evidence slots, supersession refs), and an unrecognized future shape must fail toward
 * keeping bytes, never toward deleting them.
 */
async function conservativelyReferencedDigests(authority: TransactionAuthority): Promise<ReadonlySet<string>> {
  const digests = new Set<string>();
  const decoder = new TextDecoder("utf-8");
  const collect = (bytes: Uint8Array): void => {
    for (const match of decoder.decode(bytes).matchAll(/[0-9a-f]{64}/gu)) digests.add(match[0]);
  };
  for (const directory of ["decisions", "reviews", "manual"] as const) {
    for (const path of await regularFiles(join(authority.task_root, directory))) {
      collect(await readTaskFile(authority, `${directory}/${path}`));
    }
  }
  for (const name of ["gate.json", "gate.decision"] as const) {
    try {
      collect(await readTaskFile(authority, name));
    } catch (error) {
      if ((error as { code?: unknown }).code !== "ENOENT") throw error;
    }
  }
  return digests;
}

export async function enumerateMaintenanceCandidates(
  dependencies: TransactionDependencies,
  authority: TransactionAuthority,
  roots: MaintenanceRoots,
  categories: readonly MaintenanceDeletionCategory[] = MAINTENANCE_DELETION_CATEGORIES,
): Promise<ProjectResult<readonly MaintenanceCandidate[]>> {
  assertInternalTransactionAuthority(authority, dependencies);
  const referenced = new Set([roots.current_state, ...roots.checkpoints, ...roots.resumable_receipts.map((item) => item.prepared_state), ...roots.decision_review_evidence]
    .flatMap((root) => root.authoritative_results.map((item) => item.result_digest)));
  try {
    const candidates: MaintenanceCandidate[] = [];
    if (categories.includes("unreferenced-attempt")) {
      for (const path of await regularFiles(join(authority.task_root, "attempts"))) {
        const claim = parseTaskPathClaim(`attempts/${path}`);
        const target = await resolveTaskPath({ runner: dependencies.runner, taskId: authority.task_id, claim, expectedClass: "attempt", context: authority.context });
        if (!target.ok) return target;
        const bytes = await readTaskFile(authority, claim);
        candidates.push({ path: target.value.repositoryRelative, target: target.value, digest: sha256Bytes(bytes), byte_count: bytes.byteLength as MaintenanceCandidate["byte_count"], category: "unreferenced-attempt" });
      }
    }
    if (categories.includes("superseded-payload")) {
      const protectedDigests = await conservativelyReferencedDigests(authority);
      for (const path of await regularFiles(join(authority.task_root, "results", "sha256"))) {
        const match = path.match(/^([0-9a-f]{64})\/payload\/(.+)$/u);
        if (!match || referenced.has(match[1] as never) || protectedDigests.has(match[1]!)) continue;
        const claim = parseTaskPathClaim(`results/sha256/${path}`);
        const target = await resolveTaskPath({ runner: dependencies.runner, taskId: authority.task_id, claim, expectedClass: "result-payload", context: authority.context });
        if (!target.ok) return target;
        const bytes = await readTaskFile(authority, claim);
        candidates.push({ path: target.value.repositoryRelative, target: target.value, digest: sha256Bytes(bytes), byte_count: bytes.byteLength as MaintenanceCandidate["byte_count"], category: "superseded-payload" });
      }
    }
    const wantsIntents = categories.includes("retired-intent");
    const wantsStaged = categories.includes("retired-staged-request");
    if (wantsIntents || wantsStaged) {
      for (const path of await regularFiles(join(authority.task_root, "intents"))) {
        const staged = path.endsWith(".request.json");
        if (staged ? !wantsStaged : !wantsIntents) continue;
        const claim = parseTaskPathClaim(`intents/${path}`);
        const target = await resolveTaskPath({
          runner: dependencies.runner,
          taskId: authority.task_id,
          claim,
          expectedClass: staged ? "staged-request" : "intent",
          context: authority.context,
        });
        if (!target.ok) return target;
        const bytes = await readTaskFile(authority, claim);
        candidates.push({
          path: target.value.repositoryRelative,
          target: target.value,
          digest: sha256Bytes(bytes),
          byte_count: bytes.byteLength as MaintenanceCandidate["byte_count"],
          category: staged ? "retired-staged-request" : "retired-intent",
        });
      }
    }
    return ok(Object.freeze(candidates.sort((a, b) => a.digest.localeCompare(b.digest))));
  } catch { return fail(authority, "enumerate-maintenance-candidates"); }
}

const maintenanceRecordValidator = createJsonSchemaValidator<MaintenanceRecordV1>(
  maintenanceRecordSchema,
  [primitivesSchema, pathClaimSchema],
);

/**
 * Reclaims result payload bytes and intent records no reader can reach any more. Manifests are
 * never candidates — `results/sha256/<digest>/manifest.json` remains the permanent digest-bound
 * authority record; only the byte copies under `payload/` go. Attempts are never candidates here
 * either: failed-dispatch records are forensic evidence and only the human-run `maintain` command
 * may remove them. Retired boundary receipts and their staged requests are candidates because
 * nothing reads them: reconciliation keeps only the receipt at the current revision, and the
 * retired-receipt readers (adjudication replay, gate replay) never target a boundary marker.
 * Any pass that deletes something writes an immutable maintenance record first, so every
 * reclamation is accounted for.
 */
export async function pruneSupersededResultPayloads(
  dependencies: TransactionDependencies,
  authority: TransactionAuthority,
): Promise<ProjectResult<Readonly<{ deleted: number }>>> {
  assertInternalTransactionAuthority(authority, dependencies);
  const roots = await enumerateMaintenanceRoots(dependencies, authority);
  if (!roots.ok) return roots;
  const manifests = await enumerateMaintenanceManifests(dependencies, authority, roots.value);
  if (!manifests.ok) return manifests;
  const candidates = await enumerateMaintenanceCandidates(
    dependencies,
    authority,
    roots.value,
    ["superseded-payload", "retired-intent", "retired-staged-request"],
  );
  if (!candidates.ok) return candidates;
  try {
    const proof = computeMaintenanceProof({ roots: roots.value, manifests: manifests.value, candidates: candidates.value });
    if (proof.permitted_deletions.length === 0) return ok(Object.freeze({ deleted: 0 }));
    // One pass per revision: the task lock serializes commits, so the id cannot collide, and an
    // interrupted pass retried at the same revision reuses its identical record idempotently.
    const maintenanceId = parsePathSafeId(`auto-prune-r${roots.value.current_state.revision}`);
    await mkdir(join(authority.task_root, "maintenance")).catch((error: { code?: string }) => {
      if (error.code !== "EEXIST") throw error;
    });
    const target = await resolveTaskPath({
      runner: dependencies.runner,
      taskId: authority.task_id,
      claim: parseTaskPathClaim(`maintenance/${maintenanceId}.json`),
      expectedClass: "maintenance-record",
      context: authority.context,
    });
    if (!target.ok) return target;
    const deletions = proof.permitted_deletions.map(({ target: _target, ...deletion }) => deletion);
    const record: MaintenanceRecordV1 = {
      schema_version: "1",
      maintenance_id: maintenanceId,
      task_id: authority.task_id,
      performed_at_revision: roots.value.current_state.revision,
      human_reason: "automatic post-commit reclamation of superseded result payloads and retired intent records",
      reachability_proof_digest: proof.digest,
      deletions,
      total_bytes_deleted: parseSafeInteger(deletions.reduce((total, deletion) => total + deletion.byte_count, 0)),
    };
    const performed = await performMaintenance({
      atomic: dependencies.atomic,
      record_target: target.value,
      record,
      proof,
      validate_record: (candidate) => maintenanceRecordValidator.assert(candidate, "maintenance record"),
    });
    return ok(Object.freeze({ deleted: performed.deleted }));
  } catch { return fail(authority, "prune-superseded-payloads"); }
}

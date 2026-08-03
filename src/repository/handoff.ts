import { canonicalDocument, parseCanonicalDocument, type CanonicalDocument, type GitOid } from "../contracts/canonical.js";
import {
  checkpointLinkBreak,
  checkpointSelfBreak,
  checkpointSelfDigest,
  parseManualCheckpoint,
  type ManualCheckpointV1,
  type PredecessorLink,
} from "../contracts/durable-checkpoint.js";
import {
  parseHandoffRecord,
  type HandoffRecordV1,
  type PreservedHandoffHead,
} from "../contracts/durable-handoff.js";
import type { TaskStateV1 } from "../contracts/durable-state.js";
import { validateDurableSemantics } from "../contracts/durable.js";
import { createProjectError, type ProjectError, type ProjectResult } from "../contracts/errors.js";
import { parseSafeInteger } from "../contracts/evidence.js";
import { assertPlainJson } from "../contracts/plain-json.js";
import type { RepositoryPathClaim } from "../contracts/path-claims.js";
import type { TransactionAuthority } from "../state/authority.js";
import { assertInternalTransactionAuthority } from "../state/authority.js";
import type { AtomicWriter } from "../state/atomic.js";
import { classifyMutationReadiness, readHistoryStatus } from "./history.js";
import { readChangedGitPaths, readCommitTreeBlob, readGitBlobBytes } from "./git.js";
import type { ResolvedPath } from "./paths.js";
import type { RootBoundGitRunner } from "./identity.js";

declare const divergencePreservationBrand: unique symbol;
export type DivergencePreservation = Readonly<{
  preserved_heads: readonly [PreservedHandoffHead, PreservedHandoffHead];
  common_authoritative_checkpoint: PredecessorLink;
}> & { readonly [divergencePreservationBrand]: true };

export type CheckpointChainEvidence = readonly CanonicalDocument<ManualCheckpointV1>[];

export type HandoffDependencies = Readonly<{
  runner: RootBoundGitRunner;
}>;

const ok = <T>(value: T): ProjectResult<T> => Object.freeze({ schema_version: "1", ok: true, value });
const fail = <T = never>(error: ProjectError): ProjectResult<T> => Object.freeze({ schema_version: "1", ok: false, error });
const authenticPreservations = new WeakMap<object, Readonly<{
  value: Readonly<{
    preserved_heads: readonly [PreservedHandoffHead, PreservedHandoffHead];
    common_authoritative_checkpoint: PredecessorLink;
  }>;
  authority: TransactionAuthority;
  runner: RootBoundGitRunner;
}>>();

function invalid(authority: TransactionAuthority, issue_code: string): ProjectResult<never> {
  return fail(createProjectError("TASK_INVALID", { task_id: authority.task_id, issue_code }));
}

function ownData(value: object, field: string, label: string): unknown {
  const descriptor = Object.getOwnPropertyDescriptor(value, field);
  if (descriptor === undefined || !("value" in descriptor) || !descriptor.enumerable) {
    throw new TypeError(`${label}.${field} must be an own enumerable data property`);
  }
  return descriptor.value;
}

function materializeChain(
  authority: TransactionAuthority,
  chain: CheckpointChainEvidence,
): ProjectResult<readonly CanonicalDocument<ManualCheckpointV1>[]> {
  if (!Array.isArray(chain) || chain.length === 0) return invalid(authority, "handoff-checkpoint-chain-empty");
  const materialized: CanonicalDocument<ManualCheckpointV1>[] = [];
  try {
    for (const supplied of chain) {
      const suppliedValue = ownData(supplied, "value", "handoff checkpoint document");
      const suppliedDigest = ownData(supplied, "digest", "handoff checkpoint document");
      assertPlainJson(suppliedValue, "handoff checkpoint value");
      const checkpoint = parseManualCheckpoint(structuredClone(suppliedValue));
      const digest = checkpointSelfDigest(checkpoint);
      if (digest !== suppliedDigest || checkpointSelfBreak(checkpoint) !== undefined) {
        return invalid(authority, "handoff-checkpoint-chain-invalid");
      }
      if (checkpoint.task_id !== authority.task_id || checkpoint.repository_identity_digest !== authority.repository_identity_digest) {
        return invalid(authority, "handoff-checkpoint-chain-foreign");
      }
      materialized.push(canonicalDocument(checkpoint));
    }
  } catch {
    return invalid(authority, "handoff-checkpoint-chain-invalid");
  }
  for (let index = 1; index < materialized.length; index += 1) {
    if (checkpointLinkBreak(materialized[index - 1]!.value, materialized[index]!.value) !== undefined) {
      return invalid(authority, "handoff-checkpoint-chain-invalid");
    }
  }
  return ok(Object.freeze(materialized));
}

function refOf(document: CanonicalDocument<ManualCheckpointV1>): PredecessorLink {
  return Object.freeze({ revision: parseSafeInteger(document.value.revision), checkpoint_digest: document.digest });
}

/**
 * Captures both OIDs from an actually divergent Git observation. It records no selection and makes
 * no merge, push, commit, or cross-clone exclusion claim.
 */
export async function observeDivergentHeads(
  dependencies: HandoffDependencies,
  authority: TransactionAuthority,
  checkpoints: Readonly<{
    local_chain: CheckpointChainEvidence;
    upstream_chain: CheckpointChainEvidence;
    common: PredecessorLink;
  }>,
): Promise<ProjectResult<DivergencePreservation>> {
  assertInternalTransactionAuthority(authority);
  assertPlainJson(checkpoints.common, "divergence common checkpoint evidence");
  const common = structuredClone(checkpoints.common);
  const local = materializeChain(authority, checkpoints.local_chain);
  if (!local.ok) return local;
  const upstream = materializeChain(authority, checkpoints.upstream_chain);
  if (!upstream.ok) return upstream;
  const status = await readHistoryStatus(dependencies.runner, authority.context);
  if (!status.ok) return status;
  const readiness = classifyMutationReadiness(status.value, authority.context);
  if (readiness.ok || readiness.error.code !== "GIT_DIVERGED") {
    return readiness.ok
      ? fail(createProjectError("HANDOFF_REQUIRED", { phase_instance: authority.context.phase_instance }))
      : readiness;
  }
  if (status.value.head === undefined || status.value.upstream.kind !== "tracked") {
    return invalid(authority, "handoff-divergent-heads-missing");
  }
  const localContainsCommon = local.value.some((entry) => entry.value.revision === common.revision && entry.digest === common.checkpoint_digest);
  const upstreamContainsCommon = upstream.value.some((entry) => entry.value.revision === common.revision && entry.digest === common.checkpoint_digest);
  if (!localContainsCommon || !upstreamContainsCommon) {
    return invalid(authority, "handoff-common-checkpoint-mismatch");
  }
  const localHead = refOf(local.value.at(-1)!);
  const upstreamHead = refOf(upstream.value.at(-1)!);
  const facts = Object.freeze({
    preserved_heads: Object.freeze([
      Object.freeze({ head_oid: status.value.head, authoritative_checkpoint: localHead }),
      Object.freeze({ head_oid: status.value.upstream.upstreamOid, authoritative_checkpoint: upstreamHead }),
    ]) as readonly [PreservedHandoffHead, PreservedHandoffHead],
    common_authoritative_checkpoint: Object.freeze(common),
  });
  const capability = facts as DivergencePreservation;
  authenticPreservations.set(capability, Object.freeze({ value: facts, authority, runner: dependencies.runner }));
  return ok(capability);
}

/** Finalizes evidence only after Git is clean and state names the selected head's checkpoint. */
export async function planCleanHandoff(
  dependencies: HandoffDependencies,
  authority: TransactionAuthority,
  state: CanonicalDocument<TaskStateV1>,
  preservation: DivergencePreservation,
  selected_successor_head: GitOid,
): Promise<ProjectResult<CanonicalDocument<HandoffRecordV1>>> {
  assertInternalTransactionAuthority(authority);
  const authenticated = authenticPreservations.get(preservation);
  if (authenticated === undefined || authenticated.authority !== authority || authenticated.runner !== dependencies.runner) {
    return invalid(authority, "handoff-preservation-not-authentic");
  }
  const stateValue = ownData(state, "value", "clean handoff state");
  const stateDigest = ownData(state, "digest", "clean handoff state");
  assertPlainJson({ state: stateValue, selected_successor_head }, "clean handoff input");
  const current = structuredClone(stateValue) as TaskStateV1;
  const retained = authenticated.value;
  const status = await readHistoryStatus(dependencies.runner, authority.context);
  if (!status.ok) return status;
  const readiness = classifyMutationReadiness(status.value, authority.context);
  if (!readiness.ok) return readiness;

  const selected = retained.preserved_heads.find((head) => head.head_oid === selected_successor_head);
  if (retained.preserved_heads[0].head_oid === retained.preserved_heads[1].head_oid) return invalid(authority, "handoff-heads-not-distinct");
  if (selected === undefined) return invalid(authority, "handoff-successor-not-preserved");
  if (status.value.head !== selected_successor_head) return invalid(authority, "handoff-clean-head-mismatch");
  if (current.task_id !== authority.task_id || current.repository_identity_digest !== authority.repository_identity_digest) {
    return invalid(authority, "handoff-authority-mismatch");
  }
  if (current.adopted_checkpoint === undefined ||
      current.adopted_checkpoint.revision !== selected.authoritative_checkpoint.revision ||
      current.adopted_checkpoint.checkpoint_digest !== selected.authoritative_checkpoint.checkpoint_digest) {
    return invalid(authority, "handoff-selected-checkpoint-mismatch");
  }
  const record = parseHandoffRecord({
    schema_version: "1",
    record_kind: "handoff-record",
    task_id: authority.task_id,
    repository_identity_digest: authority.repository_identity_digest,
    preserved_heads: retained.preserved_heads,
    common_authoritative_checkpoint: retained.common_authoritative_checkpoint,
    selected_successor_head,
    clean_handoff: {
      head_oid: selected_successor_head,
      state_revision: current.revision,
      state_digest: stateDigest,
      authoritative_checkpoint: selected.authoritative_checkpoint,
    },
  });
  return ok(canonicalDocument(record));
}

/** Installs one immutable maintenance record. Existing targets are collisions, never overwritten. */
export async function installHandoffRecord(
  atomic: AtomicWriter,
  target: ResolvedPath,
  record: CanonicalDocument<HandoffRecordV1>,
): Promise<"created" | "exists"> {
  if (target.path_class !== "maintenance-record") throw new TypeError("handoff target must be a maintenance-record path");
  return atomic.createExclusive(target, record.bytes);
}

export type SelectedManualHandoffAuthority =
  | Readonly<{
      kind: "normal";
      path: RepositoryPathClaim;
      document: CanonicalDocument<TaskStateV1>;
    }>
  | Readonly<{
      kind: "manual";
      path: RepositoryPathClaim;
      document: CanonicalDocument<ManualCheckpointV1>;
    }>;

export type ManualHandoffInput = Readonly<{
  dependencies: HandoffDependencies;
  transaction_authority: TransactionAuthority;
  /** Opaque ManualAuthority (or the normal-state authority token) minted by the caller's loader. */
  selected_authority: object;
  resolve_selected_authority: (authority: object) => SelectedManualHandoffAuthority;
  expected_head: GitOid;
}>;

export type ManualHandoffResult = Readonly<{
  status: "ready";
  mode: "normal" | "manual";
  head_oid: GitOid;
  branch: string;
  authority_path: RepositoryPathClaim;
  authority_digest: CanonicalDocument<TaskStateV1 | ManualCheckpointV1>["digest"];
  authority_revision: TaskStateV1["revision"] | ManualCheckpointV1["revision"];
  protocol: readonly [
    "commit-authenticated-authority",
    "push-selected-branch",
    "clean-pull-in-next-writer",
    "rerun-manual-status-before-mutation",
  ];
}>;

/**
 * Verifies readiness for the documented one-writer handoff. A successful routine handoff returns
 * guidance only; it never fabricates `HandoffRecordV1`. Divergence remains the existing
 * `GIT_DIVERGED` failure and is repaired through `observeDivergentHeads`/`planCleanHandoff`.
 */
export async function inspectManualHandoff(
  input: ManualHandoffInput,
): Promise<ProjectResult<ManualHandoffResult>> {
  const { dependencies, transaction_authority: authority } = input;
  assertInternalTransactionAuthority(authority);
  if (input.selected_authority === null || typeof input.selected_authority !== "object") {
    throw new TypeError("selected handoff authority must be an object");
  }
  let selected: SelectedManualHandoffAuthority;
  try {
    selected = input.resolve_selected_authority(input.selected_authority);
  } catch {
    return invalid(authority, "handoff-selected-authority-not-authentic");
  }

  let document: CanonicalDocument<TaskStateV1 | ManualCheckpointV1>;
  try {
    const suppliedValue = ownData(selected.document, "value", "selected handoff authority");
    const suppliedDigest = ownData(selected.document, "digest", "selected handoff authority");
    const suppliedBytes = ownData(selected.document, "bytes", "selected handoff authority");
    if (!(suppliedBytes instanceof Uint8Array)) throw new TypeError("authority bytes must be Uint8Array");
    const parsed = selected.kind === "normal"
      ? parseCanonicalDocument<TaskStateV1>(suppliedBytes, "selected handoff state")
      : parseCanonicalDocument<ManualCheckpointV1>(suppliedBytes, "selected handoff checkpoint");
    assertPlainJson(suppliedValue, "selected handoff authority value");
    if (parsed.digest !== suppliedDigest) throw new TypeError("authority digest does not bind bytes");
    if (selected.kind === "manual") {
      parseManualCheckpoint(parsed.value);
      if (checkpointSelfBreak(parsed.value as ManualCheckpointV1) !== undefined) {
        throw new TypeError("manual authority checkpoint self digest is invalid");
      }
    } else if (!validateDurableSemantics({ state: parsed as CanonicalDocument<TaskStateV1> }).ok) {
      throw new TypeError("normal authority state is invalid");
    }
    document = parsed as CanonicalDocument<TaskStateV1 | ManualCheckpointV1>;
  } catch {
    return invalid(authority, "handoff-selected-authority-invalid");
  }
  if (document.value.task_id !== authority.task_id ||
      document.value.repository_identity_digest !== authority.repository_identity_digest) {
    return invalid(authority, "handoff-authority-mismatch");
  }

  const status = await readHistoryStatus(dependencies.runner, authority.context);
  if (!status.ok) return status;
  const readiness = classifyMutationReadiness(status.value, authority.context);
  if (!readiness.ok) return readiness;
  if (status.value.head === undefined || status.value.head !== input.expected_head) {
    return invalid(authority, "handoff-clean-head-mismatch");
  }
  if (status.value.upstream.kind !== "tracked" || status.value.upstream.ahead !== 0 ||
      status.value.upstream.behind !== 0 || status.value.upstream.upstreamOid !== status.value.head) {
    return fail(createProjectError("HANDOFF_REQUIRED", { phase_instance: authority.context.phase_instance }));
  }

  try {
    const changed = await readChangedGitPaths(dependencies.runner);
    if (changed.paths.length !== 0 || changed.unrepresentable_count !== 0) {
      return fail(createProjectError("HANDOFF_REQUIRED", { phase_instance: authority.context.phase_instance }));
    }
    const committed = await readCommitTreeBlob(dependencies.runner, status.value.head, selected.path);
    if (committed === undefined || committed.mode !== "100644") {
      return invalid(authority, "handoff-authority-not-committed");
    }
    const committedBytes = await readGitBlobBytes(dependencies.runner, committed.oid);
    if (!Buffer.from(committedBytes).equals(Buffer.from(document.bytes))) {
      return invalid(authority, "handoff-authority-commit-mismatch");
    }
  } catch {
    return invalid(authority, "handoff-authority-commit-unreadable");
  }

  const protocol: ManualHandoffResult["protocol"] = Object.freeze([
    "commit-authenticated-authority",
    "push-selected-branch",
    "clean-pull-in-next-writer",
    "rerun-manual-status-before-mutation",
  ]);
  return ok<ManualHandoffResult>(Object.freeze({
    status: "ready",
    mode: selected.kind,
    head_oid: status.value.head,
    branch: status.value.branch,
    authority_path: selected.path,
    authority_digest: document.digest,
    authority_revision: document.value.revision,
    protocol,
  }));
}

import type { GitOid, GitTreeMode } from "./canonical.js";
import { canonicalJsonDigest, sha256Bytes } from "./canonical.js";
import type { ProjectResult } from "./errors.js";
import { createProjectError } from "./errors.js";
import type { SafeCode, SafeId, Sha256Digest } from "./evidence.js";
import type { RepositoryPathClaim } from "./path-claims.js";
import type { PhaseInstanceId } from "./phase-instance.js";
import { assertPlainJson, type PlainJsonObject, type PlainJsonValue } from "./plain-json.js";
import type { ToolName } from "./tool-names.js";

export interface DeclaredInputRef {
  readonly input_id: SafeId;
  readonly digest: Sha256Digest;
}

export interface GitIdentityRef {
  readonly path: RepositoryPathClaim;
  readonly mode: GitTreeMode;
  readonly oid: GitOid;
}

export interface InputFingerprintSubject {
  readonly schema_version: "1";
  readonly workflow_digest: Sha256Digest;
  readonly config_digest: Sha256Digest;
  readonly constitution_digest: Sha256Digest;
  /** SET — sorted by `path` and checked for duplicates before hashing. */
  readonly artifact_identities: readonly GitIdentityRef[];
  /** SET — sorted by `path` and checked for duplicates before hashing. */
  readonly upstream_identities: readonly GitIdentityRef[];
  readonly rubric_digest: Sha256Digest;
  readonly phase_instance: PhaseInstanceId;
  /** SET — sorted by `input_id` and checked for duplicates before hashing. */
  readonly declared_inputs: readonly DeclaredInputRef[];
}

export interface RequestDigestSubject {
  readonly schema_version: "1";
  readonly tool: ToolName;
  readonly repository_identity_digest: Sha256Digest;
  readonly task_identity_digest: Sha256Digest;
  readonly operation: SafeCode;
  readonly operation_fields: PlainJsonObject;
  readonly input_fingerprint: Sha256Digest;
}

/**
 * Names that may never appear in `operation_fields`. The exclusions are the security property of
 * the request digest, so they are asserted rather than filtered: silently dropping a field would
 * let a caller believe a value participated in the digest when it did not. The list covers the
 * receipt identifier, the optimistic-concurrency revision, connection and transport identifiers,
 * timestamps, attempt counters, timeout and cancellation state, and retry metadata.
 *
 * KNOWN LIMITATION, deliberately not closed in Phase 6. `operation_fields` is an open
 * `PlainJsonObject`, so this exact-name denylist cannot catch every spelling of a volatile value:
 * `started_at`, `finished_at`, `attempt_number`, `retry_reason`, and `timed_out` all pass and would
 * change the digest, letting two callers encode the same volatile state under different names and
 * disagree. The correct fix is a *closed* per-operation semantic-field schema, so that only
 * approved fields ever reach canonical hashing — an allowlist, not a denylist. That is not built
 * here because Phase 6 defines no operations and wires no handler: there is nothing yet to close
 * over, and an operation-field registry invented now would be speculative machinery. Padding this
 * list with further guessed spellings was also rejected — it trades a visible gap for a hidden one.
 * OWNER: the phase that defines the per-operation request field sets must replace this denylist
 * with closed schemas and delete this note.
 *
 * A retry after `SUPPLEMENTAL_REVIEW_REQUIRED` therefore reuses the same request digest with a
 * refreshed `expected_revision`.
 */
export const EXCLUDED_REQUEST_DIGEST_FIELDS: readonly string[] = Object.freeze([
  "intent_id",
  "expected_revision",
  "observed_revision",
  "connection_id",
  "invocation_id",
  "transport_request_id",
  "request_id",
  "session_id",
  "client_id",
  "timestamp",
  "created_at",
  "updated_at",
  "received_at",
  "attempt",
  "attempt_count",
  "retry_count",
  "retry_after_ms",
  "timeout_ms",
  "deadline_ms",
  "cancelled",
  "cancellation_reason",
]);

const EXCLUDED_FIELD_SET = new Set(EXCLUDED_REQUEST_DIGEST_FIELDS);

/**
 * Takes the one snapshot every later step reads.
 *
 * Both digest functions used to traverse the caller's live object more than once — an exclusion
 * walk or a sort-key read, then canonical hashing — so an enumerable getter could show a safe value
 * to the check and a different one to the hash. `assertPlainJson` already rejects accessor
 * properties outright (and non-plain prototypes, symbol keys, and values that mutate mid-inspection),
 * so validating the whole subject first turns that trick into a thrown error rather than a digest.
 * `structuredClone` then detaches the validated data, so even an exotic value that somehow survived
 * validation can no longer differ between traversals: every subsequent step reads this copy, never
 * the caller's object.
 *
 * The subject types are `PlainJsonValue`-shaped but are declared as interfaces carrying branded
 * strings, so they are not *structurally* assignable to `PlainJsonObject`; the generic parameter is
 * the narrow, deliberate conversion at that boundary and keeps the public signatures unchanged.
 */
function materialize<T>(subject: T, label: string): T {
  assertPlainJson(subject, label);
  return structuredClone(subject) as T;
}

function ordinal(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/**
 * Sorts a collection that is semantically a set, rejecting duplicate keys. `canonicalJsonBytes`
 * sorts object keys but deliberately preserves array order, so an unsorted collection would let
 * two callers hash identical logical inputs to different fingerprints — a divergence that would
 * only surface much later as a spurious `INPUT_FINGERPRINT_MISMATCH`. A duplicate key throws
 * rather than being deduplicated: two entries claiming the same key with different values is a
 * caller bug, not something this layer may silently resolve.
 */
function sortedSet<T>(items: readonly T[], key: (item: T) => string, label: string): readonly T[] {
  const seen = new Set<string>();
  for (const item of items) {
    const value = key(item);
    if (seen.has(value)) throw new TypeError(`${label} is a set: duplicate key ${JSON.stringify(value)}`);
    seen.add(value);
  }
  return [...items].sort((left, right) => ordinal(key(left), key(right)));
}

const identityJson = (identity: GitIdentityRef): PlainJsonObject => ({
  path: identity.path,
  mode: identity.mode,
  oid: identity.oid,
});

const declaredInputJson = (input: DeclaredInputRef): PlainJsonObject => ({
  input_id: input.input_id,
  digest: input.digest,
});

/**
 * The declared-input fingerprint. `InputFingerprintSubject` contains no semantic sequences: all
 * three collections are sets and are sorted before hashing. The caller's own `input_fingerprint`
 * is always an assertion, never authority — the server recomputes it through this function.
 */
export function computeInputFingerprint(subject: InputFingerprintSubject): Sha256Digest {
  const snapshot = materialize(subject, "input fingerprint subject");
  return canonicalJsonDigest({
    schema_version: snapshot.schema_version,
    workflow_digest: snapshot.workflow_digest,
    config_digest: snapshot.config_digest,
    constitution_digest: snapshot.constitution_digest,
    artifact_identities: sortedSet(snapshot.artifact_identities, (item) => item.path, "artifact_identities").map(identityJson),
    upstream_identities: sortedSet(snapshot.upstream_identities, (item) => item.path, "upstream_identities").map(identityJson),
    rubric_digest: snapshot.rubric_digest,
    phase_instance: snapshot.phase_instance,
    declared_inputs: sortedSet(snapshot.declared_inputs, (item) => item.input_id, "declared_inputs").map(declaredInputJson),
  });
}

function assertNoExcludedFields(value: PlainJsonValue, path: string): void {
  if (Array.isArray(value)) {
    (value as readonly PlainJsonValue[]).forEach((entry, index) => { assertNoExcludedFields(entry, `${path}[${String(index)}]`); });
    return;
  }
  if (value === null || typeof value !== "object") return;
  for (const [key, entry] of Object.entries(value as PlainJsonObject)) {
    if (EXCLUDED_FIELD_SET.has(key)) {
      throw new TypeError(`operation_fields must not contain the excluded request-digest field ${JSON.stringify(key)} at ${path}`);
    }
    assertNoExcludedFields(entry, `${path}.${key}`);
  }
}

/**
 * The request digest has one closed field list: schema version, logical tool name, repository
 * identity, task identity, operation tag, that operation's request-specific semantic fields, and
 * the recomputed declared-input fingerprint. Nothing else participates. `operation_fields` needs
 * no ordering rule — canonical JSON already sorts object keys.
 */
export function computeRequestDigest(subject: RequestDigestSubject): Sha256Digest {
  const snapshot = materialize(subject, "request digest subject");
  assertNoExcludedFields(snapshot.operation_fields, "operation_fields");
  return canonicalJsonDigest({
    schema_version: snapshot.schema_version,
    tool: snapshot.tool,
    repository_identity_digest: snapshot.repository_identity_digest,
    task_identity_digest: snapshot.task_identity_digest,
    operation: snapshot.operation,
    operation_fields: snapshot.operation_fields,
    input_fingerprint: snapshot.input_fingerprint,
  });
}

/**
 * Config pinning is `sha256` over the exact whole `config.yaml` bytes. There is no in-task
 * amendment and no re-pin schema: an intentional routing, model, or effort change requires a
 * distinct task or the explicit upgrade flow.
 */
export function computePinnedConfigDigest(configBytes: Uint8Array): Sha256Digest {
  return sha256Bytes(configBytes);
}

/**
 * Any byte difference produces `PINNED_CONFIG_MISMATCH` carrying only the two digests. The error
 * never carries config content: the pinned config is exactly the kind of document whose bytes must
 * not leak into a diagnostic.
 */
export function verifyPinnedConfig(expected: Sha256Digest, observedBytes: Uint8Array): ProjectResult<Sha256Digest> {
  const observed = computePinnedConfigDigest(observedBytes);
  if (observed === expected) return { schema_version: "1", ok: true, value: observed };
  return {
    schema_version: "1",
    ok: false,
    error: createProjectError("PINNED_CONFIG_MISMATCH", { expected_digest: expected, observed_digest: observed }),
  };
}

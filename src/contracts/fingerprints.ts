import type { GitOid, GitTreeMode } from "./canonical.js";
import { canonicalJsonDigest, sha256Bytes } from "./canonical.js";
import type { ProjectResult } from "./errors.js";
import { createProjectError } from "./errors.js";
import type { PathSafeId, SafeId, Sha256Digest } from "./evidence.js";
import type { GateContext, GateKind, WaiverOriginRef } from "./gates.js";
import type { AdjudicateInput, CommonToolInput, CounterReviewInput, GateInput, StateInput, ToolInput, WaiverInput } from "./mcp-tools.js";
import type { RepositoryPathClaim } from "./path-claims.js";
import type { PhaseInstanceId } from "./phase-instance.js";
import { assertPlainJson, type PlainJsonObject, type PlainJsonValue } from "./plain-json.js";
import type { ToolName } from "./tool-names.js";

export type DeclaredInputRef = {
  readonly input_id: SafeId;
  readonly digest: Sha256Digest;
};

export type GitIdentityRef = {
  readonly path: RepositoryPathClaim;
  readonly mode: GitTreeMode;
  readonly oid: GitOid;
};

export type InputFingerprintSubject = {
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
};

type RequestDigestCommon = {
  readonly schema_version: "1";
  readonly repository_identity_digest: Sha256Digest;
  readonly task_identity_digest: Sha256Digest;
  readonly input_fingerprint: Sha256Digest;
};

export type StateArtifactOperation =
  | "adopt-task-initialization"
  | "adopt-legacy-import-initialization"
  | "record-document-artifact"
  | "record-implementation-output"
  | "adopt-manual-checkpoint-import"
  | "record-triage";

export type PinnedConstitutionFile = Readonly<{
  path: RepositoryPathClaim;
  oid: GitOid;
}>;

export type StateArtifactOperationFields = Pick<StateInput, "phase_instance" | "step" | "status"> & {
  readonly artifact_kind: NonNullable<StateInput["artifact"]>["artifact_kind"];
  readonly artifact_digest: Sha256Digest;
};

export type RequestDigestSubject = RequestDigestCommon & ({
  readonly tool: "archflow_state";
  readonly operation: "record-state-boundary";
  readonly operation_fields: Pick<StateInput, "phase_instance" | "step" | "status">;
} | {
  readonly tool: "archflow_state";
  readonly operation: StateArtifactOperation;
  readonly operation_fields: StateArtifactOperationFields;
} | {
  readonly tool: "archflow_counter_review";
  readonly operation: "counter-review";
  readonly operation_fields: Pick<CounterReviewInput, "artifact_path" | "rubric">;
} | {
  readonly tool: "archflow_adjudicate";
  readonly operation: "adjudicate";
  readonly operation_fields: Pick<AdjudicateInput, "artifact_path" | "upstream_paths">;
} | {
  readonly tool: "archflow_gate";
  readonly operation: "gate";
  readonly operation_fields: Pick<GateInput, "phase_instance" | "summary" | "subject_digest" | "current_evidence" | "supersedes" | "kind" | "context">;
} | {
  readonly tool: "archflow_waiver";
  readonly operation: "waiver";
  readonly operation_fields: Pick<WaiverInput, "origin" | "rationale">;
});

type SelectorKeys = {
  readonly archflow_state: "phase_instance" | "step" | "status" | "artifact";
  readonly archflow_counter_review: "artifact_path" | "rubric";
  readonly archflow_adjudicate: "artifact_path" | "upstream_paths";
  readonly archflow_gate: "phase_instance" | "summary" | "subject_digest" | "current_evidence" | "supersedes" | "supplemental_outcome" | "kind" | "context";
  readonly archflow_waiver: "origin" | "rationale" | "supplemental_outcome";
};
type ExactSelectorCoverage = {
  readonly [K in ToolName]: Exclude<keyof ToolInput<K>, keyof CommonToolInput> extends SelectorKeys[K]
    ? Exclude<SelectorKeys[K], Exclude<keyof ToolInput<K>, keyof CommonToolInput>> extends never ? true : never
    : never;
};
const exactSelectorCoverage: ExactSelectorCoverage = {
  archflow_state: true,
  archflow_counter_review: true,
  archflow_adjudicate: true,
  archflow_gate: true,
  archflow_waiver: true,
};
void exactSelectorCoverage;

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
 * The subject types are `PlainJsonValue`-shaped but are declared as `interface`s, so they are not
 * *structurally* assignable to `PlainJsonObject`: TypeScript grants the implicit index signature
 * that assignability needs to type aliases only, never to interfaces. The branded string fields are
 * not the cause — a type alias carrying branded fields satisfies the constraint — the declaration
 * form is. The generic parameter is the narrow, deliberate conversion at that boundary and keeps the
 * public signatures unchanged.
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

/**
 * Identifies the immutable constitution registry by commit-tree membership and blob identity.
 * Callers must supply the complete pinned tree listing; worktree discovery is not an input.
 */
export function computePinnedConstitutionDigest(
  files: readonly PinnedConstitutionFile[],
): Sha256Digest {
  const snapshot = materialize(files, "pinned constitution files");
  return canonicalJsonDigest({
    schema_version: "1",
    digest_kind: "pinned-constitution",
    files: sortedSet(snapshot, (file) => file.path, "pinned constitution files").map(
      ({ path, oid }) => ({ path, oid }),
    ),
  });
}

const exactFields = (value: object, expected: readonly string[]): void => {
  const actual = Object.keys(value).sort();
  const wanted = [...expected].sort();
  if (actual.length !== wanted.length || actual.some((key, index) => key !== wanted[index])) {
    throw new TypeError(`operation_fields must contain exactly ${wanted.join(", ")}`);
  }
};

function closedOperationFields(subject: RequestDigestSubject): PlainJsonObject {
  switch (subject.tool) {
    case "archflow_state": {
      const fields = (subject as Extract<RequestDigestSubject, { tool: "archflow_state" }>).operation_fields;
      if (subject.operation === "record-state-boundary") {
        exactFields(fields, ["phase_instance", "step", "status"]);
        return { phase_instance: fields.phase_instance, step: fields.step, status: fields.status };
      }
      const artifactFields = fields as StateArtifactOperationFields;
      const operationForKind: Readonly<Record<StateArtifactOperationFields["artifact_kind"], StateArtifactOperation>> = {
        "task-initialization": "adopt-task-initialization",
        "legacy-import-initialization": "adopt-legacy-import-initialization",
        document: "record-document-artifact",
        "implementation-output": "record-implementation-output",
        "manual-checkpoint-import": "adopt-manual-checkpoint-import",
        triage: "record-triage",
      };
      if (operationForKind[artifactFields.artifact_kind] !== subject.operation) {
        throw new TypeError("invalid archflow_state operation for artifact_kind");
      }
      exactFields(artifactFields, ["phase_instance", "step", "status", "artifact_kind", "artifact_digest"]);
      return {
        phase_instance: artifactFields.phase_instance,
        step: artifactFields.step,
        status: artifactFields.status,
        artifact_kind: artifactFields.artifact_kind,
        artifact_digest: artifactFields.artifact_digest,
      };
    }
    case "archflow_counter_review": {
      const fields = (subject as Extract<RequestDigestSubject, { tool: "archflow_counter_review" }>).operation_fields;
      if (subject.operation !== "counter-review") throw new TypeError("invalid archflow_counter_review operation");
      exactFields(fields, ["artifact_path", "rubric"]);
      return { artifact_path: fields.artifact_path, rubric: fields.rubric as unknown as PlainJsonValue };
    }
    case "archflow_adjudicate": {
      const fields = (subject as Extract<RequestDigestSubject, { tool: "archflow_adjudicate" }>).operation_fields;
      if (subject.operation !== "adjudicate") throw new TypeError("invalid archflow_adjudicate operation");
      exactFields(fields, ["artifact_path", "upstream_paths"]);
      return { artifact_path: fields.artifact_path, upstream_paths: fields.upstream_paths };
    }
    case "archflow_gate": {
      const fields = (subject as Extract<RequestDigestSubject, { tool: "archflow_gate" }>).operation_fields;
      if (subject.operation !== "gate") throw new TypeError("invalid archflow_gate operation");
      const expected = ["phase_instance", "summary", "subject_digest", "current_evidence", "kind", "context"];
      if (fields.supersedes !== undefined) expected.push("supersedes");
      exactFields(fields, expected);
      const selected = {
        phase_instance: fields.phase_instance,
        summary: fields.summary,
        subject_digest: fields.subject_digest,
        current_evidence: fields.current_evidence as unknown as PlainJsonValue,
        kind: fields.kind,
        context: fields.context as unknown as PlainJsonValue,
        ...(fields.supersedes === undefined ? {} : { supersedes: fields.supersedes as unknown as PlainJsonValue }),
      } satisfies PlainJsonObject;
      return selected as PlainJsonObject;
    }
    case "archflow_waiver": {
      const fields = (subject as Extract<RequestDigestSubject, { tool: "archflow_waiver" }>).operation_fields;
      if (subject.operation !== "waiver") throw new TypeError("invalid archflow_waiver operation");
      exactFields(fields, ["origin", "rationale"]);
      return { origin: fields.origin as unknown as PlainJsonValue, rationale: fields.rationale };
    }
    default: {
      const exhaustive: never = subject;
      throw new TypeError(`unknown request tool ${String((exhaustive as { tool?: unknown }).tool)}`);
    }
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
  const operationFields = closedOperationFields(snapshot);
  return canonicalJsonDigest({
    schema_version: snapshot.schema_version,
    tool: snapshot.tool,
    repository_identity_digest: snapshot.repository_identity_digest,
    task_identity_digest: snapshot.task_identity_digest,
    operation: snapshot.operation,
    operation_fields: operationFields,
    input_fingerprint: snapshot.input_fingerprint,
  });
}

export function computeGateId(subject: {
  readonly task_identity_digest: Sha256Digest;
  readonly intent_id: PathSafeId;
  readonly request_digest: Sha256Digest;
}): PathSafeId {
  const snapshot = materialize(subject, "gate identity subject");
  return `g-${canonicalJsonDigest({
    schema_version: "1",
    digest_kind: "gate-identity",
    task_identity_digest: snapshot.task_identity_digest,
    intent_id: snapshot.intent_id,
    request_digest: snapshot.request_digest,
  })}` as PathSafeId;
}

export function computeGateContextDigest<K extends GateKind>(kind: K, context: GateContext<K>): Sha256Digest;
export function computeGateContextDigest(kind: "waiver", context: { readonly origin: WaiverOriginRef; readonly rationale: string }): Sha256Digest;
export function computeGateContextDigest(
  kind: GateKind | "waiver",
  context: GateContext<GateKind> | { readonly origin: WaiverOriginRef; readonly rationale: string },
): Sha256Digest {
  const snapshot = materialize(context, "gate context digest subject");
  return kind === "waiver"
    ? canonicalJsonDigest({ schema_version: "1", digest_kind: "waiver-context", ...snapshot })
    : canonicalJsonDigest({ schema_version: "1", digest_kind: "gate-context", kind, context: snapshot });
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

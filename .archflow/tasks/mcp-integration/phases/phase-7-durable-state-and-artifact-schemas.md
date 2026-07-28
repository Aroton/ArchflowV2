# Phase 7: Durable State and Artifact Schemas

**Status**: DRAFT — not an approved design
**Task**: mcp-integration
**Goal**: Define every persisted shape as a versioned normative schema with one cross-document semantic authority.
**Depends on**: Phase 6
**Requirements completed**: none
**Requirements advanced**: REQ-04, REQ-11, REQ-13, REQ-14, REQ-21, REQ-26, REQ-39, REQ-50

> **Read this before treating anything below as settled.** This document preserves the reviewed durable-schema material that was carved out of the original combined Phase 6 design, so that work is not lost. It has **not** passed a design gate, has **not** been counter-reviewed, and was written *before* Phase 6 was implemented. Every Phase 6 interface it references is therefore **provisional**: the names, shapes, and brands pinned here are what the combined design intended, not what Phase 6 actually exported. Before any of this is implemented, run `archflow-phase-design mcp-integration 7` properly, against Phase 6's implementation log and its real exported signatures, and reconcile every reference in the "Consumed from Phase 6" section. Treat a difference as a design defect to resolve at that gate, not something to patch around during implementation.

**This phase completes no requirement.** It wires no handler, performs no mutation, and reads nothing at runtime; it defines file formats. What each requirement receives is an exact slice. REQ-04 gets the `task-initialization` and `legacy-import-initialization` shapes that *carry* the pinned identity, base commit, workflow, constitution, and config digests — but nothing records or enforces them until the transaction kernel lands. REQ-11 gets the evidence-chain and document shapes that hold review provenance; the review schemas, canonical rendering, and finding IDs are Phase 2's and the attestation is Phase 11's. REQ-13 gets the digest-bound fields that later freshness comparisons read, not the fixed-point loop. REQ-14 and REQ-21 get the `state.json` schema — the *format* of the truth `archflow-status` will one day read, with no reader and no writer here. REQ-26 gets the `path_class` constraints that bound what an implementation output may claim, enforced only when a handler calls them. REQ-39 gets the manual-checkpoint chain format. REQ-50 gets the legacy-import manifest. Completion for all eight belongs to the phases that integrate and verify the behaviour.

## Context

Phase 6 established the first filesystem and Git code in `src/`: canonical JSON, in-process Git blob OIDs, tree modes, three path brands, path classes and containment, repository and task identity, whole-file `config.yaml` pinning, the request digest and declared-input fingerprint, divergence and conflict detection, and the secret-scan *result* contract. Phase 5 set the precedent this phase follows for purely internal shapes: `release-manifest` and `release-legal-review` have JSON Schema authority, one consolidated semantic validator, and no Zod mirror.

This phase authors nine durable shapes and one cross-document validator. It implements **no** state mutation, transaction kernel, lock, CAS, intent receipt, atomic write, snapshot materialisation, payload restore, gate lifecycle, dispatch, or secret-scanning engine, and adds **no runtime dependency**.

## Consumed from Phase 6 — provisional

Everything in this list is what the combined design pinned. **Verify each against Phase 6's implementation log before use**; a mismatch is a gate-time correction, not an implementation-time improvisation.

| Symbol | Module | Used for |
|---|---|---|
| `Sha256Digest`, `SafeId`, `SafeInteger`, `SafeCode`, `SafeVersion` | `src/contracts/evidence.ts` | every digest, identifier, and count |
| `PathSafeId` | `src/contracts/evidence.ts` | `gate_id`, `intent_id`, `attempt_id`, `maintenance_id` — every ID that becomes a filename component |
| `TaskSlug` | `src/contracts/evidence.ts` | `task_id` |
| `RepositoryPathClaim`, `TaskPathClaim` | `src/contracts/path-claims.ts` | every persisted path, in its declared frame |
| `PathClass`, `PATH_CLASSES`, `TASK_PATH_CLASSES`, `REPOSITORY_PATH_CLASSES` | `src/contracts/path-claims.ts` | output classification and its constraints |
| `GitOid`, `GitTreeMode`, `ArchflowTreeMode` | `src/contracts/canonical.ts` | tracked-output identity |
| `CanonicalDocument<T>`, `canonicalJsonBytes`, `canonicalJsonDigest`, `parseCanonicalDocument`, `gitBlobOid`, `sha256Bytes` | `src/contracts/canonical.ts` | document bytes, digests, and byte authority |
| `SecretScanResult` | `src/contracts/secret-scan.ts` | embedded in `implementation-output` |
| `PhaseInstanceId`, `PositiveSafePhaseNumber` | `src/contracts/phase-instance.ts` | phase instances (Phase 1) |
| `ReviewEvidenceSlot`, `Assurance` | `src/contracts/trust.ts` | evidence-chain provenance (Phase 2) |
| `ProjectResult<T>`, `createProjectError` | `src/contracts/errors.ts` | the validator's return channel (Phase 2) |

Phase 6's failure convention applies unchanged: **parsers and assertion helpers throw; orchestrating readers return `ProjectResult<T>`; pure derivations return their value.** `validateDurableSemantics` is an orchestrating reader and returns `ProjectResult`. Every `parse*` in this phase throws.

## What We're Building

Nine versioned durable shapes, each with a JSON Schema authority in `src/contracts/schemas/v1/`, plus Zod mirrors where a shape crosses the MCP boundary, plus one consolidated semantic validator for everything the schemas structurally cannot express.

Three structural devices carry the design, and each exists because chunks are delegated to fresh-context agents that never read each other's code:

- **Every root document is pinned, not just the shared `$defs`.** The previous revision pinned `OutputEntry` and `PredecessorLink` and left `TaskStateV1` and all six artifact roots as prose noun-lists. That was the single largest defect: a fresh-context agent authoring `implementation-output` and another authoring `validateDurableSemantics` would have invented different field names for the same concept, and nothing would have caught it. Every root shape below has declared properties, required fields, discriminants, and cross-document keys.
- **`validateDurableSemantics` is typed against those roots**, not against `PlainJsonObject`. Its correlations are then compile-time checkable, so a renamed field breaks the build rather than silently disabling a check.
- **One integration chunk owns every shared file.** `SCHEMA_IDS`, `SCHEMA_FILES`, and `src/contracts/index.ts` are not append-only-by-convention; they are written once, by one agent, from a pinned table.

## Interfaces and Contracts

### Shared `$defs` — chunk 1, lands first

Chunks 2–7 embed these by name and must not rename them. Chunk 1 owns `src/contracts/durable-primitives.ts` and `durable-primitives.schema.json`, and imports `DeclaredInputRef` and `GitIdentityRef` from Phase 6's `fingerprints.ts`.

```ts
import type { Assurance, ReviewEvidenceSlot } from "./trust.js";

export const OUTPUT_OPERATIONS = ["add", "modify", "delete", "rename"] as const;
export type OutputOperation = (typeof OUTPUT_OPERATIONS)[number];
export const OUTPUT_FILE_TYPES = ["regular", "symlink"] as const;
export type OutputFileType = (typeof OUTPUT_FILE_TYPES)[number];
export const OUTPUT_STORAGE = ["git-object", "raw-payload"] as const;
export type OutputStorage = (typeof OUTPUT_STORAGE)[number];

export interface BlobIdentity {
  readonly oid: GitOid;
  readonly mode: GitTreeMode;                // "160000" rejected
  readonly size_bytes: SafeInteger;
}

export interface OutputEntry {
  readonly path: RepositoryPathClaim;
  readonly path_class: PathClass;
  readonly operation: OutputOperation;
  readonly previous_path?: RepositoryPathClaim;
  readonly file_type: OutputFileType;
  readonly storage: OutputStorage;
  readonly before?: BlobIdentity;
  readonly after?: BlobIdentity;
  readonly payload_bytes?: SafeInteger;
  readonly payload_digest?: Sha256Digest;
}

/** Composition, not modification: the slot is an unmodified evidence-slots member. */
export type EvidenceChainEntry =
  | Readonly<{ kind: "review"; slot: ReviewEvidenceSlot; authority_link_digest: Sha256Digest }>
  | Readonly<{
      kind: "adjudication" | "triage";
      evidence_digest: Sha256Digest;
      assurance: Assurance;
      authority_link_digest: Sha256Digest;
    }>;

export interface PredecessorLink {
  readonly revision: SafeInteger;                        // >= 1
  readonly predecessor_checkpoint_digest?: Sha256Digest; // absent iff revision === 1
  readonly predecessor_revision?: SafeInteger;           // absent iff revision === 1; else < revision
}

export interface SnapshotAccountingEntry {
  readonly path: RepositoryPathClaim;
  readonly storage: OutputStorage;
  readonly stored_bytes: SafeInteger;        // exactly 0 iff storage === "git-object"
}
export interface SnapshotAccountingV1 {
  readonly schema_version: "1";
  readonly result_bytes: SafeInteger;        // sum of counted_entries[].stored_bytes
  readonly task_bytes: SafeInteger;          // >= result_bytes
  readonly result_byte_cap: 26214400;        // 25 MiB, const
  readonly task_byte_cap: 262144000;         // 250 MiB, const
  readonly counted_entries: readonly SnapshotAccountingEntry[];
  readonly measured_at_revision: SafeInteger;
}
export const snapshotAccountingV1Schema: z.ZodType<SnapshotAccountingV1>;
export function parseSnapshotAccounting(value: unknown): SnapshotAccountingV1;
```

#### `EvidenceChainEntry` composes the slot — the earlier `$ref`-the-fields instruction is withdrawn

An earlier revision said `EvidenceChainEntry` should `$ref` `evidence-slots.schema.json` for its role/assurance/`gate_id` correlations while carrying `role`, `assurance`, `evidence_digest`, `authority_link_digest`, and an optional `gate_id` as flat siblings. **Verified against live code, that is impossible.** `evidence-slots.schema.json`'s `self`, `counter`, and `gateCounter` each `require` `producer_family`, `reviewer_family`, and `independence`, are `additionalProperties: false`, and contain no `authority_link_digest`. A flat entry omits three required properties and adds a forbidden one, so no Ajv/Zod agreement is achievable under that reuse. The flat shape also silently dropped correlations those `$defs` already enforce: `self-review ⇒ agent-declared`, `counter-review | gate-counter-review ⇒ server-attested | degraded`, and the family-difference rules expressed as `oneOf` branches.

The fix is **composition**: a review chain entry carries the slot object *unmodified* under a `slot` key and adds `authority_link_digest` as a sibling of `slot`, not of the slot's own properties. `additionalProperties: false` is respected because nothing is added inside the slot; every correlation survives untouched; and the two non-review roles get their own branch of a `kind`-discriminated union rather than being forced into a vocabulary that does not describe them.

**Ownership is explicit**: `evidence-slots.schema.json` (Phase 2) remains the sole owner of the three slot `$defs` and is **not edited by this phase**. `durable-primitives.schema.json` (chunk 1) owns only the wrapper, whose review branch is `{"kind": {"const": "review"}, "slot": {"oneOf": [{"$ref": "urn:archflow:schema:v1:evidence-slots#/$defs/self"}, {"$ref": "…#/$defs/counter"}, {"$ref": "…#/$defs/gateCounter"}]}, "authority_link_digest": {"$ref": "…primitives#/$defs/sha256Digest"}}`. The Zod mirror reuses `trust.ts`'s exported `ReviewEvidenceSlot` union directly, so the two authorities cannot drift. `"triage"` is included as a chain role deliberately: a checkpoint's evidence chain must reference the triage record that dispositioned findings, and triage has its own `triage.schema.json`; it is a chain member, not a review role, which is why it lives in the non-review branch rather than being appended to `REVIEW_ROLES`.

#### `OutputEntry`'s legal combinations

Every cell is normative; anything not in the table is rejected.

| `operation` | `before` | `after` | `storage` | `payload_bytes` / `payload_digest` | `previous_path` |
|---|---|---|---|---|---|
| `add` | absent | required | either | present iff `raw-payload` | absent |
| `modify` | required | required | either | present iff `raw-payload` | absent |
| `delete` | required | absent | **`git-object` forced** | absent | absent |
| `rename` | required | required | either | present iff `raw-payload` | required |

`delete` forces `git-object` because there is no post-state content to store; a `raw-payload` delete would demand bytes for a file that no longer exists. One invariant closes the redundancy between `file_type` and the tree mode: **`file_type === "symlink"` if and only if the surviving `BlobIdentity`'s mode is `120000`** — `after.mode` for `add`/`modify`/`rename`, `before.mode` for `delete`.

#### The table is structurally total but not integrity-total, and the gap is attributed

Nothing above requires `payload_bytes` to equal the length of the bytes actually retained, `payload_digest` to equal SHA-256 of those bytes, or `after.oid` to equal `gitBlobOid(bytes)`. The snapshot-accounting invariants only equate `stored_bytes` with the *asserted* `payload_bytes`, so a manifest can be fully internally consistent and still describe bytes that do not exist anywhere. This is a real gap and it is **deliberate, bounded, and attributed** rather than left unowned:

> **In Phase 7 these three fields are assertions. In Phase 9 they become verified facts.** Phase 9 (Snapshots, Implementation Manifests, and Restore) is the layer that retains the bytes, and it is the layer that must verify, at materialisation time, that the retained payload's length equals `payload_bytes`, that `sha256Bytes(payload)` equals `payload_digest`, and that `gitBlobOid(payload)` equals `after.oid` for a tracked output. Phase 7 cannot check any of this, because it never sees a byte.

Phase 7's own contribution to closing the gap is to make the assertions *checkable later* — every field needed for the Phase 9 comparison is present, typed, and required — and to say plainly that a Phase 7 validation pass is not evidence that the bytes exist.

#### `path_class` is constrained by path and operation

An unconstrained `path_class` lets an implementation output claim `task-state` or a shared class and thereby assert authority over a file the server owns. The constraint has three parts, all enforced in `validateDurableSemantics`:

| Rule | Detail |
|---|---|
| Frame agreement | `path_class ∈ REPOSITORY_PATH_CLASSES` iff `path` is not under `.archflow/`; a `.archflow/`-rooted path must carry a task class. |
| Claimable set | An `implementation-output` entry may claim only `repository-source`, `document`, `review`, `result-payload`, `manual-checkpoint`, `import`, or `task-branch-constitution`. |
| Server-owned set | `task-config`, `task-state`, `gate-interface`, `intent`, `attempt`, `decision`, `result-manifest`, `maintenance-record`, `shared-workflow`, and `shared-constitution` are **never** claimable by an implementation output; a manifest asserting one is rejected outright, not merely warned. |

`task-branch-constitution` is claimable only when the manifest also carries the constitution-edit gate reference, because that is the one path on which a task-branch edit is a legitimate declared output rather than a policy violation.

**The rename cross-class rule**: `previous_path` must classify to the **same** `path_class` as `path`. A cross-class rename — moving a `repository-source` file into `document`, or a `review` into `result-payload` — is rejected. Such a move is representable as a `delete` plus an `add`, which forces the manifest to state both classes explicitly instead of laundering an authority change through a rename.

#### `SnapshotAccountingV1`'s invariants

Five, all checked in `validateDurableSemantics` rather than in the schema: `result_bytes` equals the sum of `counted_entries[].stored_bytes`; `result_bytes <= result_byte_cap`; `task_bytes >= result_bytes`; `task_bytes <= task_byte_cap`; and the **cross-shape** invariant — `counted_entries` is in one-to-one correspondence with the owning `implementation-output`'s `outputs` by `path`, with matching `storage`, `stored_bytes === payload_bytes` for `raw-payload` entries, and `stored_bytes === 0` for `git-object` entries. The accounting block is never independent of the manifest it accompanies. `26214400 = 25 × 1048576` and `262144000 = 250 × 1048576`.

### Root shapes — every field pinned

These are the seams that a fresh-context agent cannot infer. Each is an exact interface; the JSON Schema is its mirror, and where a Zod mirror is required the three must agree.

#### `TaskStateV1` — chunk 2, server-internal, no Zod mirror

```ts
export const STEP_STATUSES = ["running", "succeeded", "failed"] as const;
export type StepStatus = (typeof STEP_STATUSES)[number];

export interface AuthoritativeResultRef {
  readonly phase_instance: PhaseInstanceId;
  readonly step: PipelineStep;                 // vocabulary.ts PIPELINE_STEPS
  readonly result_digest: Sha256Digest;
  readonly result_id: SafeId;
  readonly input_fingerprint: Sha256Digest;
  readonly manifest_path: RepositoryPathClaim;
}
export interface ApprovalRef {
  readonly gate_id: PathSafeId;
  readonly gate_kind: GateKind;                // gates.ts GATE_KINDS
  readonly subject_digest: Sha256Digest;
  readonly decision_digest: Sha256Digest;
  readonly resolved_at_revision: SafeInteger;
}
export interface OpenGateRef {
  readonly gate_id: PathSafeId;
  readonly gate_kind: GateKind;
  readonly subject_digest: Sha256Digest;
  readonly context_digest: Sha256Digest;
  readonly opened_at_revision: SafeInteger;
}
export interface WaiverRef {
  readonly gate_id: PathSafeId;
  readonly rule_id: SafeId;
  readonly rule_version: SafeInteger;
  readonly subject_digest: Sha256Digest;
  readonly granted: boolean;
  readonly expires: "task-complete";
  readonly granted_at_revision: SafeInteger;
}
export interface PreparedIntentRef {
  readonly intent_id: PathSafeId;
  readonly request_digest: Sha256Digest;
  readonly prior_revision: SafeInteger;
}

export interface TaskStateV1 {
  readonly schema_version: "1";
  readonly task_id: TaskSlug;
  readonly repository_identity_digest: Sha256Digest;
  readonly revision: SafeInteger;              // strictly monotonic, >= 1
  readonly phase_instance: PhaseInstanceId;
  readonly step: PipelineStep;
  readonly status: StepStatus;
  readonly attempt: SafeInteger;               // >= 1
  readonly initialization_digest: Sha256Digest;  // the adopted task- or legacy-import-initialization
  readonly config_digest: Sha256Digest;
  readonly workflow_digest: Sha256Digest;
  readonly constitution_digest: Sha256Digest;
  readonly policy_base_commit: GitOid;
  readonly authoritative_results: readonly AuthoritativeResultRef[];
  readonly approvals: readonly ApprovalRef[];
  readonly open_gate?: OpenGateRef;             // at most one; absent when no gate is pending
  readonly waivers: readonly WaiverRef[];
  readonly prepared_intent?: PreparedIntentRef;
  readonly terminal?: "complete" | "abandoned";
}
```

**Cross-document keys** (what `validateDurableSemantics` correlates on): `initialization_digest` → the initialization artifact's canonical digest; `authoritative_results[*].result_digest` → a result manifest; `approvals[*].gate_id` and `open_gate.gate_id` → decision records; `waivers[*].gate_id` → an approval whose `gate_kind` is a waiver-bearing kind. **Discriminant**: none — `state.json` is not a union. **Sorted-set fields**: `authoritative_results` by `(phase_instance, step)`, `approvals` and `waivers` by `gate_id`, all ordinal, all duplicate-rejecting.

#### `MaintenanceRecordV1` — chunk 2, server-internal, no Zod mirror

```ts
export interface MaintenanceDeletion {
  readonly digest: Sha256Digest;
  readonly path: RepositoryPathClaim;
  readonly byte_count: SafeInteger;
  readonly category: "unreferenced-attempt" | "superseded-payload";
}
export interface MaintenanceRecordV1 {
  readonly schema_version: "1";
  readonly maintenance_id: PathSafeId;
  readonly task_id: TaskSlug;
  readonly performed_at_revision: SafeInteger;
  readonly human_reason: string;               // 1..4096 bytes, bounded like other prose fields
  readonly reachability_proof_digest: Sha256Digest;
  readonly deletions: readonly MaintenanceDeletion[];  // sorted by digest, non-empty, unique
  readonly total_bytes_deleted: SafeInteger;   // equals the sum of deletions[].byte_count
}
```

#### `TaskInitializationV1` — chunk 3, Zod mirror

```ts
export interface TaskInitializationV1 {
  readonly schema_version: "1";
  readonly artifact_kind: "task-initialization";        // discriminant of the archflow_state union
  readonly task_id: TaskSlug;
  readonly repository_identity_digest: Sha256Digest;
  readonly code_baseline_commit: GitOid;
  readonly policy_base_commit: GitOid;                  // explicitly approved, human-committed
  readonly constitution_digest: Sha256Digest;
  readonly workflow_digest: Sha256Digest;
  readonly config_digest: Sha256Digest;                 // exact whole-file config.yaml bytes
  readonly canonical_paths: CanonicalTaskPaths;
}
export interface CanonicalTaskPaths {
  readonly task_root: RepositoryPathClaim;              // .archflow/tasks/<task_id>
  readonly config: RepositoryPathClaim;
  readonly state: RepositoryPathClaim;
  readonly workflow: RepositoryPathClaim;               // .archflow/workflow.yaml
  readonly constitution_root: RepositoryPathClaim;      // .archflow/constitution
}
```

#### `LegacyImportInitializationV1` — chunk 3, Zod mirror

```ts
export interface LegacyImportInitializationV1 {
  readonly schema_version: "1";
  readonly artifact_kind: "legacy-import-initialization";
  readonly task_id: TaskSlug;                           // the destination task
  readonly repository_identity_digest: Sha256Digest;
  readonly source_identity_digest: Sha256Digest;        // the selected legacy source, never mutated
  readonly import_digest: Sha256Digest;                 // immutable staged import
  readonly import_baseline_commit: GitOid;
  readonly code_baseline_commit: GitOid;
  readonly policy_base_commit: GitOid;
  readonly constitution_digest: Sha256Digest;
  readonly workflow_digest: Sha256Digest;
  readonly config_digest: Sha256Digest;                 // the DESTINATION's config bytes
  readonly canonical_paths: CanonicalTaskPaths;
  readonly mapping: readonly LegacyMappingEntry[];      // sorted by destination_path, unique
  readonly staged_payload_refs: readonly StagedPayloadRef[];  // sorted by legacy_path, unique
}
export interface LegacyMappingEntry {
  readonly legacy_path: RepositoryPathClaim;
  readonly destination_path: RepositoryPathClaim;
  readonly phase_instance: PhaseInstanceId;
  readonly disposition: "draft" | "historical";         // never "approved"
}
export interface StagedPayloadRef {
  readonly legacy_path: RepositoryPathClaim;
  readonly digest: Sha256Digest;
  readonly byte_count: SafeInteger;
}
```

#### `DocumentArtifactV1` — chunk 4, Zod mirror

```ts
export interface DocumentArtifactV1 {
  readonly schema_version: "1";
  readonly artifact_kind: "document";
  readonly task_id: TaskSlug;
  readonly phase_instance: PhaseInstanceId;
  readonly document_path: TaskPathClaim;                // task-relative, class `document`
  readonly path_class: "document";
  readonly byte_count: SafeInteger;
  readonly content_digest: Sha256Digest;
  readonly declared_inputs: readonly DeclaredInputRef[];   // set: sorted by input_id, unique
  readonly input_fingerprint: Sha256Digest;               // recomputed; the caller's is an assertion
  readonly snapshot_digest: Sha256Digest;                 // the retained result this projects
  readonly projection_target: RepositoryPathClaim;
}
```

#### `ImplementationOutputV1` — chunk 5, Zod mirror, the largest shape

```ts
export interface ImplementationOutputV1 {
  readonly schema_version: "1";
  readonly artifact_kind: "implementation-output";
  readonly task_id: TaskSlug;
  readonly phase_instance: PhaseInstanceId;              // always phase-impl-<n>
  readonly base_commit: GitOid;                          // immutable; the tree the diff is against
  readonly index_identity_digest: Sha256Digest;
  readonly worktree_identity_digest: Sha256Digest;
  readonly outputs: readonly OutputEntry[];              // set: sorted by path, unique, non-empty
  readonly parent_documents: readonly ParentDocumentRef[];  // set: sorted by document_path, unique
  readonly diff_digest: Sha256Digest;                    // the exact review/commit-authorization subject
  readonly snapshot_digest: Sha256Digest;
  readonly restore_targets: readonly RepositoryPathClaim[];  // subset of outputs[].path, sorted
  readonly accounting: SnapshotAccountingV1;
  readonly secret_scan: SecretScanResult;
  readonly undeclared_changes: UndeclaredChangeReport;
  readonly declared_inputs: readonly DeclaredInputRef[];
  readonly input_fingerprint: Sha256Digest;
  readonly constitution_edit_gate_id?: PathSafeId;       // required iff any output claims task-branch-constitution
}
export interface ParentDocumentRef {
  readonly document_path: TaskPathClaim;
  readonly content_digest: Sha256Digest;
  readonly role: "prd" | "design" | "phase-design" | "impl-notes";
}
export interface UndeclaredChangeReport {
  readonly scanned: boolean;
  readonly undeclared_paths: readonly RawGitPath[];      // raw: a repo may hold unrepresentable names
  readonly unrepresentable_count: SafeInteger;
}
```

`undeclared_paths` is `RawGitPath[]`, not `RepositoryPathClaim[]`, for the reason Phase 6 established: a valid repository may contain a dirty file whose name has a colon, trailing dot, non-NFC text, or newline, and reporting undeclared changes must not throw when it meets one.

#### `ManualCheckpointV1` — chunk 6, Zod mirror

```ts
export interface ManualCheckpointV1 {
  readonly schema_version: "1";
  readonly artifact_kind: "manual-checkpoint";
  readonly task_id: TaskSlug;
  readonly link: PredecessorLink;
  readonly checkpoint_digest: Sha256Digest;             // self-digest over canonical bytes minus this field
  readonly phase_instance: PhaseInstanceId;
  readonly step: PipelineStep;
  readonly status: StepStatus;
  readonly input_fingerprint: Sha256Digest;
  readonly authoritative_results: readonly AuthoritativeResultRef[];
  readonly projection_digests: readonly ProjectionDigestRef[];  // set: sorted by path, unique
  readonly evidence_chain: readonly EvidenceChainEntry[];       // sequence: production order, not sorted
  readonly approvals: readonly ApprovalRef[];
  readonly open_gate?: OpenGateRef;
  readonly waivers: readonly WaiverRef[];
  readonly assurance: "degraded";                        // always; manual mode is never attested
  readonly initialization_digest?: Sha256Digest;         // required iff link.revision === 1
}
export interface ProjectionDigestRef {
  readonly path: RepositoryPathClaim;
  readonly content_digest: Sha256Digest;
}
```

`evidence_chain` is the one **sequence** in this phase, not a set: the order in which evidence was produced is semantic, since triage follows the reviews it dispositions. Every other collection is a set with a declared ordinal sort key and duplicate rejection, for the determinism reason Phase 6 pinned for the input fingerprint — `canonicalJsonBytes` preserves array order, so an unsorted set lets two callers digest identical logical content differently.

#### `ManualCheckpointImportV1` — chunk 6, Zod mirror

```ts
export interface ManualCheckpointImportV1 {
  readonly schema_version: "1";
  readonly artifact_kind: "manual-checkpoint-import";
  readonly task_id: TaskSlug;
  readonly repository_identity_digest: Sha256Digest;
  readonly chain: readonly ManualCheckpointV1[];         // sequence: ascending link.revision, no gaps
  readonly head_digest: Sha256Digest;                    // equals chain[chain.length - 1].checkpoint_digest
  readonly head_revision: SafeInteger;
  readonly expected_state_revision?: SafeInteger;        // absent iff adopting from no-state
}
```

### `validateDurableSemantics` — chunk 7, typed against the roots

```ts
export type DurableArtifact =
  | TaskInitializationV1
  | LegacyImportInitializationV1
  | DocumentArtifactV1
  | ImplementationOutputV1
  | ManualCheckpointImportV1;

export interface DurableSemanticSubject {
  readonly state?: CanonicalDocument<TaskStateV1>;
  readonly artifact?: CanonicalDocument<DurableArtifact>;
  readonly checkpointChain?: readonly CanonicalDocument<ManualCheckpointV1>[];
  readonly maintenance?: CanonicalDocument<MaintenanceRecordV1>;
}
export function validateDurableSemantics(
  subject: DurableSemanticSubject,
): ProjectResult<DurableSemanticSubject>;
```

Typing the subject against the pinned roots rather than `PlainJsonObject` is what makes the validator's correlations checkable at compile time: renaming `initialization_digest` in chunk 2 breaks chunk 7's build instead of silently disabling the check that uses it. `DurableArtifact` is discriminated on `artifact_kind`, which is exactly the `archflow_state.artifact` tagged union — `manual-checkpoint` itself is not a union member, only its import wrapper is, which is why it appears in `checkpointChain` and not in `DurableArtifact`.

The validator owns exactly these correlation classes and nothing else: predecessor-chain continuity and gaps; digest agreement between a reference and its target; phase-instance validity and `phase-impl-<n>` restriction for implementation outputs; the five snapshot-accounting invariants; the `OutputEntry` table, `file_type`/mode equivalence, `path_class` constraints, and the rename cross-class rule; set sorting and duplicate rejection for every declared set; the one-active-gate rule; and `initialization_digest` presence exactly at revision 1. Structural rejection of unknown fields comes free from `.strict()` and `additionalProperties: false` and is not the validator's job.

### The Zod-mirror rule, applied

A durable shape gets a Zod mirror **if and only if it is reachable from an `archflow_state.artifact` union member**, because those shapes cross the MCP tool boundary where schemas are Zod-derived and Ajv/Zod agreement is required. Purely server-internal shapes get JSON Schema authority plus the semantic validator, exactly as Phase 5 did for `release-manifest` and `release-legal-review`.

| Shape | Union-reachable | Mirror | Reason |
|---|---|---|---|
| `task-state` | no | no | server-internal; never an artifact |
| `maintenance-record` | no | no | server-internal |
| `task-initialization` | yes | yes | union member |
| `legacy-import-initialization` | yes | yes | union member |
| `document` | yes | yes | union member |
| `implementation-output` | yes | yes | union member |
| `manual-checkpoint-import` | yes | yes | union member |
| `manual-checkpoint` | yes | yes | reachable from `manual-checkpoint-import.chain` |
| `snapshot-accounting` | yes | yes | embedded in `implementation-output.accounting` |

### Schema, module, and registry ownership — chunk 8 writes the shared files

The previous revision made `SCHEMA_IDS`, `SCHEMA_FILES`, and `src/contracts/index.ts` append-only in numeric chunk order. **That is not safe for fresh-context delegation.** Seven independent agents editing the same object literal and the same export list produce patch conflicts, duplicate export lines, and — worst — one agent regenerating a file from its own view and silently dropping another's row. The `satisfies Record<keyof typeof SCHEMA_IDS, string>` constraint catches a *missing* pair, but not a dropped pair, a duplicated export, or a merge that loses one edit.

**Chunk 8 has sole write access to all three files.** Leaf chunks 1–7 author only their own modules, schemas, and tests; none of them touches a registry or the barrel, and none of them can run the registry test until chunk 8 lands. Chunk 8's work is mechanical because every row is pinned here:

| Leaf chunk | `SCHEMA_IDS` key | Schema filename | Barrel export |
|---|---|---|---|
| 1 | `durablePrimitives` | `durable-primitives.schema.json` | `export * from "./durable-primitives.js";` |
| 2 | `taskState` | `task-state.schema.json` | *(type-only; no runtime export)* |
| 2 | `maintenanceRecord` | `maintenance-record.schema.json` | *(type-only)* |
| 3 | `taskInitialization` | `task-initialization.schema.json` | `export * from "./artifacts/task-initialization.js";` |
| 3 | `legacyImportInitialization` | `legacy-import-initialization.schema.json` | `export * from "./artifacts/legacy-import-initialization.js";` |
| 4 | `documentArtifact` | `document-artifact.schema.json` | `export * from "./artifacts/document.js";` |
| 5 | `implementationOutput` | `implementation-output.schema.json` | `export * from "./artifacts/implementation-output.js";` |
| 6 | `manualCheckpoint` | `manual-checkpoint.schema.json` | `export * from "./artifacts/manual-checkpoint.js";` |
| 6 | `manualCheckpointImport` | `manual-checkpoint-import.schema.json` | `export * from "./artifacts/manual-checkpoint-import.js";` |
| 7 | — | — | `export * from "./durable.js";` |

All `$id` values are `urn:archflow:schema:v1:<kebab-name>`, matching the 22-of-24 majority; the two `https://archflow.dev/...` IDs are legacy and are not a precedent. Ten `SCHEMA_IDS` keys, nine schema files, and eight barrel lines — a mechanical transcription, not a judgement call.

**Correction carried from the combined design**: it listed chunk 1 as a registry editor. Phase 6's chunk 1 added no schema, so it had no registry row; here, chunk 1 does add `durable-primitives.schema.json`, but it still does not edit the registry — chunk 8 does, for every row including chunk 1's.

## Files

| Action | File | Chunk | Purpose |
|--------|------|-------|---------|
| Create | `src/contracts/durable-primitives.ts`, `src/contracts/schemas/v1/durable-primitives.schema.json`, `test/unit/durable-primitives.test.ts` | 1 | Shared `$defs`, the composed evidence-chain entry, snapshot accounting. |
| Create | `src/contracts/schemas/v1/task-state.schema.json`, `maintenance-record.schema.json`, `src/contracts/state-types.ts` | 2 | Server-internal shapes: JSON Schema authority plus type-only declarations. |
| Create | `src/contracts/artifacts/task-initialization.ts`, `legacy-import-initialization.ts` and their two schemas | 3 | Both initialization authorities with Zod mirrors. |
| Create | `src/contracts/artifacts/document.ts`, `document-artifact.schema.json` | 4 | The document artifact with its Zod mirror. |
| Create | `src/contracts/artifacts/implementation-output.ts`, `implementation-output.schema.json` | 5 | The largest shape, entirely by `$ref`/import into chunk 1's files. |
| Create | `src/contracts/artifacts/manual-checkpoint.ts`, `manual-checkpoint-import.ts` and their two schemas | 6 | The predecessor-linked chain and its adoption wrapper. |
| Create | `src/contracts/durable.ts`, `test/contracts/durable-contracts.test.ts` | 7 | The sole semantic authority and its rejection matrix. |
| Create | `test/fixtures/contracts/durable/**` | 1–7 | Per-shape valid samples and rejection corpora, each owned by its authoring chunk. |
| Modify | `src/contracts/versions.ts`, `test/contracts/schema-registry.test.ts`, `src/contracts/index.ts` | **8 only** | Sole registry and barrel ownership, transcribed from the pinned table. |
| Create | `test/contracts/durable-agreement.test.ts` | 8 | Ajv/Zod agreement across every union-reachable shape, once all leaves exist. |

`package.json` and `.github/workflows/ci.yml` are not modified: `vitest.config.ts` already includes `test/**/*.test.ts`, so `npm test` picks these up. No runtime dependency is added.

## Contract and Semantic Rules

- **JSON Schema is the structural authority for every shape.** Where a Zod mirror exists it is a mirror, never a second model, and `assertZodAgreement` proves it over a shared corpus. Where no mirror exists — `task-state`, `maintenance-record` — there is exactly one shape model and one semantic validator, following the Phase 5 precedent.
- **Unknown fields come free** from Zod `.strict()` and JSON Schema `additionalProperties: false`. The semantic validator never re-checks structure.
- **Every collection declares whether it is a set or a sequence.** Sets carry an ordinal sort key and reject duplicates before any digest is taken; the only sequences in this phase are `ManualCheckpointV1.evidence_chain` and `ManualCheckpointImportV1.chain`, both of which are semantic orderings. This mirrors the rule Phase 6 pinned for `computeInputFingerprint`, and for the same reason: `canonicalJsonBytes` preserves array order, so an unsorted set produces caller-dependent digests.
- **Digest fields are references, not authority.** A digest-shaped string never establishes that its target exists; the validator resolves what the subject supplies and reports what it cannot resolve. Phase 5 established this rule for release evidence and it holds unchanged.
- **`payload_bytes`, `payload_digest`, and `after.oid` are assertions in this phase and verified facts in Phase 9.** See the attribution above; a passing Phase 7 validation is never evidence that the described bytes exist.
- **`path_class` is constrained by path and operation**, with a closed claimable set and a closed server-owned set, and renames may not cross classes.
- **The one-active-gate rule** is structural: `open_gate` is a single optional object, not an array, in both `TaskStateV1` and `ManualCheckpointV1`. Nesting is unrepresentable rather than merely forbidden.
- **`initialization_digest` is present exactly at revision 1** in a checkpoint chain, and `predecessor_checkpoint_digest`/`predecessor_revision` are absent exactly at revision 1. Absence is expressed with `.optional()` and omission from `required`, never with `null`: across all schemas in `src/contracts/schemas/v1/` there are zero occurrences of `"null"`, and across `src/contracts/*.ts` zero `z.null`/`.nullable()` uses; the established convention is `gates.ts:95` and `mcp-tools.ts:59`. `SafeInteger` is branded and cannot be widened to admit `null` anyway.
- **No new error code.** Every failure this phase produces uses an existing code — `STATE_INVALID`, `SNAPSHOT_INVALID`, `TASK_INVALID`, `CONTRACT_INVALID`, `INPUT_FINGERPRINT_MISMATCH`. `test/unit/errors.test.ts` asserts exactly 52 project codes and `test/contracts/gate-error-supplemental-exhaustive.test.ts` asserts exactly 56 total rows; both must still pass unchanged.
- **`evidence-slots.schema.json` is not edited.** Phase 2 owns it; this phase composes with it.

## Work Breakdown

1. **Shared `$defs`**: Implement `durable-primitives.ts` and its schema — `BlobIdentity`, `OutputEntry` under its operation × storage table, the `kind`-discriminated `EvidenceChainEntry` composing unmodified `evidence-slots` members plus `authority_link_digest`, `PredecessorLink` under the absent convention, and `SnapshotAccountingV1` with its Zod mirror. Author no registry row.
2. **Server-internal shapes**: Author `task-state.schema.json` and `maintenance-record.schema.json` against the pinned `TaskStateV1` and `MaintenanceRecordV1` interfaces, with type-only TypeScript declarations and deliberately no Zod mirror.
3. **Initialization authorities**: Author `task-initialization` and `legacy-import-initialization` with Zod mirrors against the pinned interfaces, including `CanonicalTaskPaths`, the legacy mapping with its `draft`/`historical` disposition, and staged payload refs.
4. **Document artifact**: Author `document-artifact` with its Zod mirror, binding the task-relative path, byte count, content digest, declared inputs, recomputed fingerprint, snapshot, and projection target.
5. **Implementation-output artifact**: Author the largest shape and its mirror entirely by `$ref` and import into chunk 1's files, editing nothing chunk 1 owns. Include `ParentDocumentRef`, `UndeclaredChangeReport` with its raw paths, the embedded accounting and secret-scan results, and the conditional constitution-edit gate reference.
6. **Manual checkpoint chain**: Author `manual-checkpoint` and `manual-checkpoint-import` with their mirrors, using `PredecessorLink` and `EvidenceChainEntry`, the self-digest rule, and the ascending-no-gaps chain constraint.
7. **Cross-document semantics and corpus**: Implement `validateDurableSemantics` typed against the pinned roots, covering exactly the correlation classes listed above. Build the full rejection matrix over the per-chunk fixtures.
8. **Registry, barrel, and agreement integration**: Transcribe the ten `SCHEMA_IDS` keys, nine `SCHEMA_FILES` rows, and eight barrel exports from the pinned table; add the cross-shape Ajv/Zod agreement suite; run the aggregate. Sole writer of all three shared files.

**Eight chunks, at the top of the 7–8 target.** The reduction path to seven, if needed, is merging chunk 4 into chunk 3 — `document-artifact` is the smallest artifact and shares no file with the initialization shapes. Chunks 1 and 8 must stay isolated: chunk 1 is the seam every other chunk builds on, and chunk 8's whole value is being the only writer of the shared files.

## Success Criteria

- [ ] Every root shape — `TaskStateV1`, `MaintenanceRecordV1`, and all six artifact roots — has declared properties, required fields, its `artifact_kind` discriminant where applicable, and named cross-document keys in both TypeScript and JSON Schema. No root document is specified only in prose.
- [ ] `validateDurableSemantics` is typed against those roots, not `PlainJsonObject`; renaming a correlated field in any leaf chunk fails `tsc --noEmit` in chunk 7.
- [ ] `EvidenceChainEntry` composes unmodified `evidence-slots` members under a `slot` key with `authority_link_digest` as a sibling. `evidence-slots.schema.json` is unedited, `additionalProperties: false` is never violated, and a `self-review` slot with `server-attested` assurance or matching families is rejected by the inherited `oneOf` correlations.
- [ ] All nine shapes round-trip valid samples through their normative JSON Schemas; every union-reachable shape — including `snapshot-accounting` and `manual-checkpoint` — passes Ajv/Zod agreement; `task-state` and `maintenance-record` have exactly one shape model each.
- [ ] Every `OutputEntry` combination outside the operation × storage table is rejected, and `file_type === "symlink"` holds iff the surviving `BlobIdentity` mode is `120000`.
- [ ] `path_class` is rejected when it disagrees with the path's frame, when an implementation output claims any server-owned class, when `task-branch-constitution` appears without `constitution_edit_gate_id`, and when a `rename` crosses classes.
- [ ] The document states plainly that `payload_bytes`, `payload_digest`, and `after.oid` are assertions here and names **Phase 9** as the layer that verifies them against retained bytes; no success criterion in this phase claims byte existence.
- [ ] All five snapshot-accounting invariants fail closed through `validateDurableSemantics`, including the one-to-one cross-shape correspondence with `outputs`.
- [ ] Every declared set is sorted by its declared ordinal key with duplicates rejected; the two sequences are not sorted; permutation fixtures prove a shuffled set is rejected rather than silently re-digested.
- [ ] Predecessor gaps, non-monotonic revisions, a predecessor field present at revision 1, a missing `initialization_digest` at revision 1, a `head_digest` disagreeing with the chain tail, and a second `open_gate` all fail with stable existing error codes.
- [ ] No schema contains `"null"` and no Zod module uses `.nullable()`; absence is `.optional()` plus omission from `required` throughout.
- [ ] Leaf chunks 1–7 modify no registry file and no barrel. Chunk 8 is the sole writer of `versions.ts`, `schema-registry.test.ts`, and `index.ts`, transcribing exactly ten keys, nine filenames, and eight exports; the bijection test and `satisfies Record<keyof typeof SCHEMA_IDS, string>` constraint both hold.
- [ ] No new error code is added; the 52-code and 56-row assertions still pass; `package.json` is unchanged in both `dependencies` and `scripts`.
- [ ] No state mutation, transaction kernel, snapshot materialisation, or payload restore is implemented; the full aggregate passes on Node `24.15.0` and `24.18.0`.

## Verification Steps

1. **Before anything else, reconcile the "Consumed from Phase 6" table against Phase 6's implementation log and its real exported signatures.** Report every difference as a design defect at the `archflow-phase-design mcp-integration 7` gate. Do not begin implementation from this document's provisional references.
2. Round-trip one valid sample per shape through its JSON Schema, and through `assertZodAgreement` for every union-reachable shape. Confirm `task-state` and `maintenance-record` have no second shape model by grepping for any Zod schema naming their fields.
3. Compose an `EvidenceChainEntry` review branch from each of the three `evidence-slots` `$defs` and assert Ajv accepts it. Then assert rejection of: a slot missing `producer_family`; a slot carrying `authority_link_digest` *inside* it; `self-review` with `server-attested`; `counter-review` with matching families; `gate-counter-review` without `gate_id`. Confirm `evidence-slots.schema.json` is byte-unchanged.
4. Run the `OutputEntry` rejection matrix: `delete` with `storage: "raw-payload"`; `git-object` with `payload_digest`; `raw-payload` without `payload_digest`; `delete` carrying `after`; `add` carrying `before`; `rename` without `previous_path`; `file_type: "regular"` with `after.mode: "120000"`; `after.mode: "160000"`.
5. Run the `path_class` matrix: an output under `.archflow/` claiming `repository-source`; an output outside `.archflow/` claiming `document`; an implementation output claiming each of the ten server-owned classes; `task-branch-constitution` without `constitution_edit_gate_id`; a `rename` from `repository-source` to `document`.
6. Run the accounting matrix: `result_bytes` disagreeing with the sum of `counted_entries`; `result_bytes` above 26214400; `task_bytes` above 262144000; `task_bytes` below `result_bytes`; a `git-object` entry with non-zero `stored_bytes`; a `counted_entries` path with no matching `OutputEntry`; an `OutputEntry` with no matching `counted_entries` row; `stored_bytes` disagreeing with `payload_bytes`.
7. Run the chain matrix: a missing predecessor at `revision > 1`; a predecessor field present at `revision === 1`; `predecessor_revision >= revision`; a digest mismatch against the named predecessor; a gap in `chain` revisions; `head_digest` disagreeing with the tail's `checkpoint_digest`; a missing `initialization_digest` at revision 1; two `open_gate` entries expressed as an array (assert the schema makes this unrepresentable rather than merely invalid).
8. Run the ordering matrix: shuffle each declared set and assert rejection; duplicate a key in each and assert rejection; shuffle `evidence_chain` and `chain` and assert **acceptance**, since those are sequences.
9. Assert the registry invariants after chunk 8: `SCHEMA_IDS` and `src/contracts/schemas/v1/` in exact bijection with `SCHEMA_FILES` satisfying its `Record<keyof typeof SCHEMA_IDS, string>` constraint; every new `$id` matching its file and compiling against all others; ten keys, nine files, eight exports, no duplicate export line; no leaf chunk's diff touching any of the three shared files.
10. Confirm the exclusions: no `"null"` in any schema, no `.nullable()` in any module, no new error code, 52/56 assertions green, `package.json` byte-identical, and no code in this phase that writes a file, acquires a lock, or materialises a payload. Run `npm run check` **invoking the exact `24.15.0` and `24.18.0` binaries explicitly** — the ambient developer Node is `24.11.1`, below the project's `>=24.15.0` floor, and Phase 5's implementation log recorded the same trap.

---
*Drafted: 2026-07-28 — preserved from the combined Phase 6 design; not gate-approved*

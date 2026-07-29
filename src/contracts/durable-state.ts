import type { GitOid } from "./canonical.js";
import type { PathSafeId, SafeId, SafeInteger, Sha256Digest, TaskSlug } from "./evidence.js";
import type { GateKind } from "./gates.js";
import type { RepositoryPathClaim } from "./path-claims.js";
import type { PhaseInstanceId } from "./phase-instance.js";
import type { PipelineStep } from "./vocabulary.js";

/**
 * `state.json` — the durable state of truth for one task.
 *
 * **This module declares no Zod schema (D2), and it must not.** `TaskStateV1` is one of the phase's
 * two purely server-internal shapes: no agent ever supplies it across the MCP tool boundary, so
 * there is no untrusted-input parse boundary for a mirror to guard. `task-state.schema.json` is its
 * sole shape authority, and `validateDurableSemantics` is the sole authority for everything the
 * schema cannot express. This follows Phase 5's precedent, where `release-manifest.schema.json` has
 * JSON Schema authority and no TypeScript module at all. Do not add a mirror here; a success
 * criterion greps for one.
 *
 * Every type below is a `type` alias rather than an `interface` (D1): `CanonicalDocument<T extends
 * PlainJsonValue>` grants the implicit index signature it needs only to aliases, and it checks the
 * whole reachable graph, so an `interface` anywhere below the root fails the constraint at the root.
 */

export const STEP_STATUSES = ["running", "succeeded", "failed"] as const;
export type StepStatus = (typeof STEP_STATUSES)[number];

export const TERMINAL_STATES = ["complete", "abandoned"] as const;
export type TerminalState = (typeof TERMINAL_STATES)[number];

/**
 * D21 — the four cross-shape reference shapes live here, with `task-state`, and
 * `task-state.schema.json` owns each `$def`. They were briefly moved into `durable-primitives`
 * when a *mirrored* `ManualCheckpointV1` also consumed them and needed a pinned Zod name to
 * compose. The Phase 8 split removed that second consumer, so each is now consumed by exactly one
 * unmirrored root — the same condition under which `PreparedIntentRef` and `MaintenanceDeletion`
 * already stay where they are. Phase 8 reaches them by `$ref` and authors its own mirrors then.
 * The reason is recorded so they are not moved back on the strength of the retired rationale.
 *
 * Every digest field here is a *reference*, not authority: a digest-shaped string never establishes
 * that its target exists. `result_digest` names a result manifest, `gate_id` names a decision
 * record, and `validateDurableSemantics` resolves none of them — its subject has no slot that could
 * carry the target. Each pointer's resolution belongs to the phase that materializes it.
 */
export type AuthoritativeResultRef = {
  readonly phase_instance: PhaseInstanceId;
  readonly step: PipelineStep;
  readonly result_digest: Sha256Digest;
  readonly result_id: SafeId;
  readonly input_fingerprint: Sha256Digest;
  readonly manifest_path: RepositoryPathClaim;
};

export type ApprovalRef = {
  readonly gate_id: PathSafeId;
  readonly gate_kind: GateKind;
  readonly subject_digest: Sha256Digest;
  readonly decision_digest: Sha256Digest;
  /** `>= 1`. `SafeInteger` admits `0` and there is no revision `0`, so the schema pins its own minimum (D8). */
  readonly resolved_at_revision: SafeInteger;
};

export type OpenGateRef = {
  readonly gate_id: PathSafeId;
  readonly gate_kind: GateKind;
  readonly subject_digest: Sha256Digest;
  readonly context_digest: Sha256Digest;
  /** `>= 1` (D8). */
  readonly opened_at_revision: SafeInteger;
};

/**
 * `expires` is the const `"task-complete"` — the narrowest representation of the only expiry this
 * project has. That is a *format* decision. Waiver scope and expiry *policy* are Phase 11's.
 */
export type WaiverRef = {
  readonly gate_id: PathSafeId;
  readonly rule_id: SafeId;
  /** `>= 1` (D8). */
  readonly rule_version: SafeInteger;
  readonly subject_digest: Sha256Digest;
  readonly granted: boolean;
  readonly expires: "task-complete";
  /** `>= 1` (D8). */
  readonly granted_at_revision: SafeInteger;
};

export type PreparedIntentRef = {
  readonly intent_id: PathSafeId;
  readonly request_digest: Sha256Digest;
  /** `>= 1` (D8). */
  readonly prior_revision: SafeInteger;
};

/**
 * The five pinned-input fields `repository_identity_digest`, `config_digest`, `workflow_digest`,
 * `constitution_digest`, and `policy_base_commit` also live in whichever initialization document
 * `initialization_digest` names. **The duplication is deliberate**: `archflow-status` reads
 * `state.json` alone, without loading the initialization document (REQ-14, REQ-21). What keeps the
 * two from disagreeing is not deduplication but comparison — `validateDurableSemantics` compares
 * every one of them, one field at a time.
 *
 * **There is deliberately no recorded blocking reason (D13).** REQ-14's blocking reason is a
 * *function* of `open_gate`, `terminal`, `prepared_intent`, and attempt exhaustion; recording it
 * would create a second source of truth that can disagree with the first. Phase 16 derives and
 * reports it. Do not add a field for it.
 */
export type TaskStateV1 = {
  readonly schema_version: "1";
  readonly task_id: TaskSlug;
  readonly repository_identity_digest: Sha256Digest;
  /** `>= 1` (D8), strictly monotonic — the monotonicity is Phase 9's. */
  readonly revision: SafeInteger;
  readonly phase_instance: PhaseInstanceId;
  readonly step: PipelineStep;
  readonly status: StepStatus;
  /** `>= 1` (D8). */
  readonly attempt: SafeInteger;
  /**
   * D13 — the **in-flight** step's declared-input fingerprint, not a completed one's. Without it
   * the in-flight fingerprint is unrepresentable and Phase 9 cannot raise
   * `INPUT_FINGERPRINT_MISMATCH` *before* a transition. The per-result fingerprints are in
   * `authoritative_results[*].input_fingerprint`.
   */
  readonly input_fingerprint: Sha256Digest;
  /** The adopted task-initialization or legacy-import-initialization document. */
  readonly initialization_digest: Sha256Digest;
  readonly config_digest: Sha256Digest;
  readonly workflow_digest: Sha256Digest;
  readonly constitution_digest: Sha256Digest;
  readonly policy_base_commit: GitOid;
  /** SET — sorted by the tuple `(phase_instance, step)`, duplicates rejected. */
  readonly authoritative_results: readonly AuthoritativeResultRef[];
  /** SET — sorted by `gate_id`, duplicates rejected. */
  readonly approvals: readonly ApprovalRef[];
  /** SET — sorted by `gate_id`, duplicates rejected. */
  readonly waivers: readonly WaiverRef[];
  /**
   * At most one, and a single optional object rather than an array: a nested or concurrent gate is
   * *unrepresentable* rather than merely rejected. Phase 11 owns the one-active-gate lifecycle —
   * when this may be set, cleared, or superseded. Phase 7 owns only the shape.
   */
  readonly open_gate?: OpenGateRef;
  readonly prepared_intent?: PreparedIntentRef;
  readonly terminal?: TerminalState;
};

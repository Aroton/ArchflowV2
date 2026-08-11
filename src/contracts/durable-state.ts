import { z } from "zod";

import type { GitOid } from "./canonical.js";
import { gitOidV1Schema } from "./canonical.js";
import type { PathSafeId, SafeId, SafeInteger, Sha256Digest, TaskSlug } from "./evidence.js";
import { pathSafeIdV1Schema, safeIdV1Schema, safeIntegerV1Schema, sha256DigestV1Schema, taskSlugV1Schema } from "./evidence.js";
import type { GateKind, WaiverScope } from "./gates.js";
import { GATE_KINDS } from "./gates.js";
import type { RepositoryPathClaim } from "./path-claims.js";
import { repositoryPathClaimV1Schema } from "./path-claims.js";
import type { PhaseInstanceId } from "./phase-instance.js";
import { phaseInstanceIdV1Schema } from "./phase-instance.js";
import { isSortedUniqueBy, tupleKey } from "./validators.js";
import type { PipelineStep } from "./vocabulary.js";
import { PIPELINE_STEPS } from "./vocabulary.js";

/**
 * `state.json` — the durable state of truth for one task.
 *
 * `taskStateV1Schema` below is a Zod *mirror* of `task-state.schema.json`, written so Zod can become
 * the single shape authority; the JSON Schema stays the runtime-authoritative validator, and nothing
 * in production parses state through this mirror yet. The mirror is a mirror and never a second
 * model: `test/contracts/durable-state-agreement.test.ts` proves the two authorities accept and
 * reject the same values, and `validateDurableSemantics` remains the sole authority for everything
 * neither shape language expresses.
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
 * unmirrored root — the same condition under which `CommittedIntentRef` and `MaintenanceDeletion`
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
  /** Domain-separated digest of this open revision excluding `open_gate` and `committed_intent`. */
  readonly frozen_state_digest: Sha256Digest;
  /** Present only for a waiver gate and names the gate whose decision requested the waiver. */
  readonly waiver_origin_gate_id?: PathSafeId;
  /** `>= 1` (D8). */
  readonly opened_at_revision: SafeInteger;
};

/**
 * `expires` is the const `"task-complete"` — the narrowest representation of the only expiry this
 * project has. That is a *format* decision. Phase 12 records waiver scope; Phase 14 owns expiry
 * policy enforcement.
 */
export type WaiverRef = {
  readonly gate_id: PathSafeId;
  readonly rule_id: SafeId;
  /** `>= 1` (D8). */
  readonly rule_version: SafeInteger;
  readonly subject_digest: Sha256Digest;
  readonly scope: WaiverScope;
  readonly granted: boolean;
  readonly expires: "task-complete";
  /** `>= 1` (D8). */
  readonly granted_at_revision: SafeInteger;
};

export type CommittedIntentRef = {
  readonly intent_id: PathSafeId;
  readonly request_digest: Sha256Digest;
  readonly receipt_digest: Sha256Digest;
  readonly outcome_digest: Sha256Digest;
  /** `>= 0`; initialization may commit from the synthetic predecessor revision 0. */
  readonly prior_revision: SafeInteger;
  /** `>= 1`. */
  readonly resulting_revision: SafeInteger;
  readonly result_id: SafeId;
};

/**
 * Legacy: written only by the retired manual checkpoint import flow. Tolerated so pre-retirement
 * task states still parse; nothing writes it anymore, and a state carrying it is preserved verbatim.
 */
export type AdoptedCheckpointRef = {
  /** `>= 1` (D8). */
  readonly revision: SafeInteger;
  readonly checkpoint_digest: Sha256Digest;
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
 * *function* of `open_gate`, `terminal`, and attempt exhaustion; recording it would create a second
 * source of truth that can disagree with the first. A receipt not yet referenced by state is
 * deliberately invisible to state-only status until Phase 17 adds reconciliation-aware status.
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
   * Human-approved final implementation phase from the current approved design's consecutive exact
   * `### Phase N: Name` headings. Absence requires its explicit open-ended marker; design approval is
   * the only normal-mode writer.
   */
  readonly planned_final_phase?: SafeInteger;
  /**
   * At most one, and a single optional object rather than an array: a nested or concurrent gate is
   * *unrepresentable* rather than merely rejected. Phase 12 owns the one-active-gate lifecycle —
   * when this may be set, cleared, or superseded. Phase 7 owns only the shape.
   */
  readonly open_gate?: OpenGateRef;
  readonly committed_intent?: CommittedIntentRef;
  /** Legacy — tolerated for pre-retirement task states; never written, preserved verbatim. */
  readonly adopted_checkpoint?: AdoptedCheckpointRef;
  readonly terminal?: TerminalState;
};

const sha256Digest = sha256DigestV1Schema as unknown as z.ZodType<Sha256Digest>;

/**
 * `>= 1` (D8) — mirrors every inline `{ "type": "integer", "minimum": 1, "maximum": 9007199254740991 }`
 * in `task-state.schema.json`, which pins its own minimum rather than `$ref`ing `safeInteger`
 * because `SafeInteger` admits `0` and there is no revision, attempt, phase, or rule version `0`.
 */
const positiveSafeInteger = z.number().int().min(1).max(Number.MAX_SAFE_INTEGER);

/**
 * Module-private mirrors of the `$defs` this schema owns (D21). Nothing outside this module
 * composes them: every other root reaches the shapes by `$ref` and authors its own mirror.
 */
const authoritativeResultRefV1Schema = z.object({
  phase_instance: phaseInstanceIdV1Schema,
  step: z.enum(PIPELINE_STEPS),
  result_digest: sha256Digest,
  result_id: safeIdV1Schema,
  input_fingerprint: sha256Digest,
  manifest_path: repositoryPathClaimV1Schema,
}).strict();

const approvalRefV1Schema = z.object({
  gate_id: pathSafeIdV1Schema,
  gate_kind: z.enum(GATE_KINDS),
  subject_digest: sha256Digest,
  decision_digest: sha256Digest,
  resolved_at_revision: positiveSafeInteger,
}).strict();

const waiverRefV1Schema = z.object({
  gate_id: pathSafeIdV1Schema,
  rule_id: safeIdV1Schema,
  rule_version: positiveSafeInteger,
  subject_digest: sha256Digest,
  scope: z.object({
    operation: z.enum(["review-trigger", "adjudication-failure"]),
    boundary: z.enum(["subject", "phase", "task"]),
  }).strict(),
  granted: z.boolean(),
  expires: z.literal("task-complete"),
  granted_at_revision: positiveSafeInteger,
}).strict();

const openGateRefV1Schema = z.object({
  gate_id: pathSafeIdV1Schema,
  gate_kind: z.enum(GATE_KINDS),
  subject_digest: sha256Digest,
  context_digest: sha256Digest,
  frozen_state_digest: sha256Digest,
  waiver_origin_gate_id: pathSafeIdV1Schema.optional(),
  opened_at_revision: positiveSafeInteger,
}).strict();

const committedIntentRefV1Schema = z.object({
  intent_id: pathSafeIdV1Schema,
  request_digest: sha256Digest,
  receipt_digest: sha256Digest,
  outcome_digest: sha256Digest,
  prior_revision: safeIntegerV1Schema,
  resulting_revision: positiveSafeInteger,
  result_id: safeIdV1Schema,
}).strict();

const adoptedCheckpointRefV1Schema = z.object({
  revision: positiveSafeInteger,
  checkpoint_digest: sha256Digest,
}).strict();

/**
 * The mirror. Each of the three set fields calls `isSortedUniqueBy` with `tupleKey` over the same
 * property list its `x-archflow-sorted-unique-by` keyword names — the same two exported functions
 * the Ajv keyword registration calls — so each ordering rule is literally one predicate across both
 * authorities and cannot drift. `.strict()` matches `additionalProperties: false`; absence is
 * `.optional()` plus omission from `required`, never `null`.
 */
export const taskStateV1Schema = z.object({
  schema_version: z.literal("1"),
  task_id: taskSlugV1Schema,
  repository_identity_digest: sha256Digest,
  revision: positiveSafeInteger,
  phase_instance: phaseInstanceIdV1Schema,
  step: z.enum(PIPELINE_STEPS),
  status: z.enum(STEP_STATUSES),
  attempt: positiveSafeInteger,
  input_fingerprint: sha256Digest,
  initialization_digest: sha256Digest,
  config_digest: sha256Digest,
  workflow_digest: sha256Digest,
  constitution_digest: sha256Digest,
  policy_base_commit: gitOidV1Schema,
  authoritative_results: z.array(authoritativeResultRefV1Schema)
    .refine((items) => isSortedUniqueBy(items, tupleKey(["phase_instance", "step"])), "authoritative_results must be sorted by (phase_instance, step) with no duplicates"),
  approvals: z.array(approvalRefV1Schema)
    .refine((items) => isSortedUniqueBy(items, tupleKey("gate_id")), "approvals must be sorted by gate_id with no duplicates"),
  waivers: z.array(waiverRefV1Schema)
    .refine((items) => isSortedUniqueBy(items, tupleKey("gate_id")), "waivers must be sorted by gate_id with no duplicates"),
  planned_final_phase: positiveSafeInteger.optional(),
  open_gate: openGateRefV1Schema.optional(),
  committed_intent: committedIntentRefV1Schema.optional(),
  adopted_checkpoint: adoptedCheckpointRefV1Schema.optional(),
  terminal: z.enum(TERMINAL_STATES).optional(),
}).strict() as unknown as z.ZodType<TaskStateV1>;

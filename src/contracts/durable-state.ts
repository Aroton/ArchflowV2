import { z } from "zod";

import type { GitOid } from "./canonical.js";
import { gitOidV1Schema } from "./canonical.js";
import type { TaskConfigSnapshot, WorkflowSubject } from "./config.js";
import { approvalRulesSchema, configOverridesSchema, configRolesSchema, configRouteSchema, configV1Schema, workflowSubjectV1Schema } from "./config.js";
import type { PathSafeId, SafeCode, SafeId, SafeInteger, Sha256Digest, TaskSlug } from "./evidence.js";
import { pathSafeIdV1Schema, safeCodeV1Schema, safeIdV1Schema, safeIntegerV1Schema, sha256DigestV1Schema, taskSlugV1Schema } from "./evidence.js";
import type { GateKind, WaiverScope } from "./gates.js";
import { GATE_KINDS } from "./gates.js";
import type { PlainJsonValue } from "./plain-json.js";
import type { ProjectionDigestRef } from "./durable-primitives.js";
import { repositoryPathClaimV1Schema } from "./path-claims.js";
import type { PhaseInstanceId } from "./phase-instance.js";
import { isStrictlyEarlierPlanningPhase, phaseInstanceIdV1Schema } from "./phase-instance.js";
import { isSortedUniqueBy, tupleKey } from "./validators.js";
import type { PipelineStep } from "./vocabulary.js";
import { PIPELINE_STEPS } from "./vocabulary.js";
import type { ToolName } from "./tool-names.js";
import { TOOL_NAMES } from "./tool-names.js";

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
 * unmirrored root. Phase 8 reaches them by `$ref` and authors its own mirrors then.
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
  /** Domain-separated digest of this open revision excluding `open_gate`. */
  readonly frozen_state_digest: Sha256Digest;
  /** Present only for a waiver gate and names the gate whose decision requested the waiver. */
  readonly waiver_origin_gate_id?: PathSafeId;
  /** `>= 1` (D8). */
  readonly opened_at_revision: SafeInteger;
};

export const HUMAN_REVISION_CLASSIFICATIONS = ["simple", "significant"] as const;
export type HumanRevisionClassification = (typeof HUMAN_REVISION_CLASSIFICATIONS)[number];
export const HUMAN_REVISION_GATE_KINDS = [
  "artifact-approval", "design-approval", "constitution-review", "material-drift", "attempts-exhausted",
  "commit-authorization", "migration-audit",
] as const satisfies readonly GateKind[];

/**
 * A human gate has requested changed bytes, but the producer has not recorded those bytes yet.
 * The evidence snapshot is captured at the gate boundary so the later classification cannot
 * silently preserve or archive a different review cycle.
 */
export type PendingHumanRevision = {
  readonly gate_id: PathSafeId;
  readonly gate_kind: GateKind;
  readonly predecessor_subject_digest: Sha256Digest;
  readonly predecessor_input_fingerprint: Sha256Digest;
  readonly requested_at_revision: SafeInteger;
  readonly attempt: SafeInteger;
  readonly evidence: readonly AuthoritativeResultRef[];
};

/** Records the user's explicit override of the producer's initial complexity judgment. */
export type HumanRevisionOverride = {
  readonly agent_classification: HumanRevisionClassification;
  readonly rationale: string;
};

/** Durable history for a completed human-requested revision. */
export type HumanRevisionRecord = {
  readonly phase_instance: PhaseInstanceId;
  readonly gate_id: PathSafeId;
  readonly gate_kind: GateKind;
  readonly predecessor_subject_digest: Sha256Digest;
  readonly predecessor_input_fingerprint: Sha256Digest;
  readonly resulting_subject_digest: Sha256Digest;
  readonly resulting_result_digest: Sha256Digest;
  readonly classification: HumanRevisionClassification;
  readonly rationale: string;
  readonly user_override?: HumanRevisionOverride;
  readonly previous_attempt: SafeInteger;
  readonly resulting_attempt: SafeInteger;
  /** Preserved for a simple revision and archived out of the current set for a significant one. */
  readonly evidence: readonly AuthoritativeResultRef[];
};

/**
 * Server-attested provenance for a planning restart decided through a connected host: the request
 * the server actually authenticated is bound by digest, not merely declared.
 */
export type PlanningRestartConnectedProvenance = {
  readonly schema_version: "1";
  readonly actor_class: "human";
  readonly assurance: "connected-request-trace";
  readonly channel: "connected-host";
  readonly connection_id: SafeId;
  readonly invocation_id: SafeId;
  readonly request_id_digest: Sha256Digest;
  readonly request_digest: Sha256Digest;
};

/** Human provenance captured for an explicit planning restart through either supported channel. */
export type PlanningRestartHumanProvenance = {
  readonly schema_version: "1";
  readonly actor_class: "human";
  readonly assurance: "declared-local-trace";
  readonly channel: "connected-host";
  readonly decision_event_id: string;
  readonly connection_id: string;
  readonly request_id_digest: Sha256Digest;
  readonly recorded_at: string;
} | {
  readonly schema_version: "1";
  readonly actor_class: "human";
  readonly assurance: "declared-local-trace";
  readonly channel: "archflow-local";
  readonly decision_event_id: string;
  readonly helper_invocation_id: string;
  readonly recorded_at: string;
} | PlanningRestartConnectedProvenance;

/** Audit authority moved out of the active graph by one explicit backward planning restart. */
export type PlanningRestartRecord = {
  readonly restart_id: PathSafeId;
  readonly source_phase_instance: PhaseInstanceId;
  readonly target_phase_instance: PhaseInstanceId;
  readonly reason: string;
  readonly restarted_at_revision: SafeInteger;
  readonly superseded_results: readonly AuthoritativeResultRef[];
  readonly cleared_waivers: readonly WaiverRef[];
  readonly cleared_pending_human_revision?: PendingHumanRevision;
  readonly human_provenance: PlanningRestartHumanProvenance;
};

/**
 * One human-approved re-baseline of drifted projections to their observed bytes. Reconciliation
 * overlays these newest-per-path over the retained result manifests' own projections, using
 * `adopted_at_revision` as the ordering key — so a later implementation produce still supersedes
 * an adoption for the paths it re-projects. `gate_id` must resolve to an archived
 * `baseline-adoption` decision whose `subject_digest` is the drift digest the human saw.
 */
export type BaselineAdoptionRecord = {
  readonly gate_id: PathSafeId;
  /** `>= 1` (D8). The revision at which the adoption decision landed. */
  readonly adopted_at_revision: SafeInteger;
  /** SET — sorted by `path`, duplicates rejected. The observed digests the human adopted. */
  readonly adopted_projections: readonly ProjectionDigestRef[];
  /**
   * SET — sorted, duplicates rejected, disjoint from `adopted_projections`' paths. Paths whose
   * committed absence the human adopted: the deletion was already part of git history (typically
   * an authorized milestone commit), so the record retires the recorded presence instead of
   * binding replacement bytes. Discovery overlays these as absence observations newest-per-path.
   */
  readonly adopted_absences?: readonly ProjectionDigestRef["path"][];
};

export type RuleSettlementConclusionV1 =
  | { readonly wait: false; readonly match: null }
  | {
    readonly wait: true;
    readonly match:
      | { readonly kind: "subject"; readonly subject: WorkflowSubject }
      | { readonly kind: "content"; readonly paths: readonly string[] };
  };

/**
 * The rule decision frozen by the transaction that first establishes a clean final-review fixed
 * point. Both outcomes are recorded. During the staged rollout they are evaluation evidence,
 * not approval authority; `wait:true` also preserves the exact trigger for human presentation.
 */
export type RuleSettlementV1 = {
  readonly task_id: TaskSlug;
  readonly phase_instance: PhaseInstanceId;
  readonly step: PipelineStep;
  readonly subject_digest: Sha256Digest;
  readonly conclusion: RuleSettlementConclusionV1;
  readonly config_digest: Sha256Digest;
  /** `>= 1` (D8), and no later than the containing state's revision. */
  readonly settled_at_revision: SafeInteger;
};

/**
 * Canonical order for settlements. Unlike `tupleKey`, the final component remains numeric, so
 * revision 9 sorts before 10 (and 99 before 100). Construction and validation share this exact
 * comparator, and equality across all three components identifies a duplicate.
 */
export function compareRuleSettlements(left: RuleSettlementV1, right: RuleSettlementV1): number {
  const phase = left.phase_instance < right.phase_instance ? -1 : left.phase_instance > right.phase_instance ? 1 : 0;
  if (phase !== 0) return phase;
  const digest = left.subject_digest < right.subject_digest ? -1 : left.subject_digest > right.subject_digest ? 1 : 0;
  if (digest !== 0) return digest;
  return left.settled_at_revision - right.settled_at_revision;
}

export function isSortedUniqueRuleSettlements(items: readonly RuleSettlementV1[]): boolean {
  return items.every((item, index) => index === 0 || compareRuleSettlements(items[index - 1]!, item) < 0);
}

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

/**
 * A self-contained record of the most recently committed mutation. Unlike the retired receipt
 * pointer, this remains exactly replayable after transaction recovery files are removed.
 */
export type LastTransition = {
  readonly schema_version: "1";
  readonly tool: ToolName;
  readonly operation: SafeCode;
  readonly intent_id: PathSafeId;
  readonly request_digest: Sha256Digest;
  readonly input_fingerprint: Sha256Digest;
  readonly result_id: SafeId;
  readonly outcome: PlainJsonValue;
  readonly outcome_digest: Sha256Digest;
  /** `>= 0`; initialization may commit from the synthetic predecessor revision 0. */
  readonly prior_revision: SafeInteger;
  /** `>= 1`. */
  readonly resulting_revision: SafeInteger;
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
  readonly pending_human_revision?: PendingHumanRevision;
  readonly human_revision_history?: readonly HumanRevisionRecord[];
  /** Sorted by `restart_id`; absent means no planning restart has occurred. */
  readonly restart_history?: readonly PlanningRestartRecord[];
  /** Human-approved re-baselines of drifted projections; see `BaselineAdoptionRecord`. */
  readonly baseline_adoptions?: readonly BaselineAdoptionRecord[];
  /**
   * Approval-rule settlements, written for both evaluated outcomes by the transaction
   * that first establishes the clean fixed point. SET — sorted by the tuple
   * `(phase_instance, subject_digest, settled_at_revision)`, duplicates rejected. The triple, not
   * the pair: an exact planning restart that ends in byte-identical re-production legally
   * re-settles the same `(phase_instance, subject_digest)` at the new revision.
   */
  readonly rule_settlements?: readonly RuleSettlementV1[];
  /**
   * The parsed config this task's state last transacted against — the baseline the status change
   * notice diffs the live parsed config over. Written only by commit-time normalization and
   * revision-zero seeding; a settlement commit that never reads config leaves it unchanged. Absent
   * (pre-cutover tasks) records nothing and notices nothing.
   */
  readonly last_seen_config?: TaskConfigSnapshot;
  readonly last_transition?: LastTransition;
  readonly terminal?: TerminalState;
};

/**
 * One leaf-level config change for the status change notice: `path` is a dot-separated segment
 * string (array items addressed by index); an absent side omits its field (added or removed leaf).
 * Informational only — a change entry is never a blocker and never changes an action kind.
 */
export type ConfigChangeEntry = {
  readonly path: string;
  readonly before?: PlainJsonValue;
  readonly after?: PlainJsonValue;
};

const sha256Digest = sha256DigestV1Schema as unknown as z.ZodType<Sha256Digest>;

/** Emitted as the `stepStatus` `$def`; the root reaches it by `$ref`. */
export const stepStatusV1Schema = z.enum(STEP_STATUSES);

/**
 * Emitted as the `gateKind` `$def` — declared once and shared by `approvalRef` and `openGateRef`,
 * exactly as the schema `$ref`s it from both, rather than two structurally equal enums.
 */
export const gateKindV1Schema = z.enum(GATE_KINDS);

/**
 * `>= 1` (D8) — mirrors every inline `{ "type": "integer", "minimum": 1, "maximum": 9007199254740991 }`
 * in `task-state.schema.json`, which pins its own minimum rather than `$ref`ing `safeInteger`
 * because `SafeInteger` admits `0` and there is no revision, attempt, phase, or rule version `0`.
 */
const positiveSafeInteger = z.number().int().min(1).max(Number.MAX_SAFE_INTEGER);

/**
 * Mirrors of the `$defs` this schema owns (D21), exported for schema generation only. Nothing else
 * outside this module composes them: every other root reaches the shapes by `$ref` and authors its
 * own mirror.
 */
export const authoritativeResultRefV1Schema = z.object({
  phase_instance: phaseInstanceIdV1Schema,
  step: z.enum(PIPELINE_STEPS),
  result_digest: sha256Digest,
  result_id: safeIdV1Schema,
  input_fingerprint: sha256Digest,
}).strict();

export const approvalRefV1Schema = z.object({
  gate_id: pathSafeIdV1Schema,
  gate_kind: gateKindV1Schema,
  subject_digest: sha256Digest,
  decision_digest: sha256Digest,
  resolved_at_revision: positiveSafeInteger,
}).strict();

export const waiverRefV1Schema = z.object({
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

export const openGateRefV1Schema = z.object({
  gate_id: pathSafeIdV1Schema,
  gate_kind: gateKindV1Schema,
  subject_digest: sha256Digest,
  context_digest: sha256Digest,
  frozen_state_digest: sha256Digest,
  waiver_origin_gate_id: pathSafeIdV1Schema.optional(),
  opened_at_revision: positiveSafeInteger,
}).strict();

export const humanRevisionClassificationV1Schema = z.enum(HUMAN_REVISION_CLASSIFICATIONS);

export const humanRevisionOverrideV1Schema = z.object({
  agent_classification: humanRevisionClassificationV1Schema,
  rationale: z.string().min(1).max(4096).regex(/\S/u),
}).strict();

const humanRevisionEvidenceV1Schema = z.array(authoritativeResultRefV1Schema)
  .refine((items) => isSortedUniqueBy(items, tupleKey(["phase_instance", "step"])), "human revision evidence must be sorted by (phase_instance, step) with no duplicates")
  .refine((items) => items.every((reference) =>
    reference.step === "counter_review" || reference.step === "adjudicate" || reference.step === "triage"),
  "human revision evidence must contain review, constitution, or triage results");

export const pendingHumanRevisionV1Schema = z.object({
  gate_id: pathSafeIdV1Schema,
  gate_kind: z.enum(HUMAN_REVISION_GATE_KINDS),
  predecessor_subject_digest: sha256Digest,
  predecessor_input_fingerprint: sha256Digest,
  requested_at_revision: positiveSafeInteger,
  attempt: positiveSafeInteger,
  evidence: humanRevisionEvidenceV1Schema,
}).strict() as unknown as z.ZodType<PendingHumanRevision>;

export const humanRevisionRecordV1Schema = z.object({
  phase_instance: phaseInstanceIdV1Schema,
  gate_id: pathSafeIdV1Schema,
  gate_kind: z.enum(HUMAN_REVISION_GATE_KINDS),
  predecessor_subject_digest: sha256Digest,
  predecessor_input_fingerprint: sha256Digest,
  resulting_subject_digest: sha256Digest,
  resulting_result_digest: sha256Digest,
  classification: humanRevisionClassificationV1Schema,
  rationale: z.string().min(1).max(4096).regex(/\S/u),
  user_override: humanRevisionOverrideV1Schema.optional(),
  previous_attempt: positiveSafeInteger,
  resulting_attempt: positiveSafeInteger,
  evidence: humanRevisionEvidenceV1Schema,
}).strict().superRefine((record, context) => {
  if (record.user_override?.agent_classification === record.classification) {
    context.addIssue({ code: "custom", path: ["user_override", "agent_classification"], message: "an override must change the classification" });
  }
  if (record.classification === "simple" && record.previous_attempt !== record.resulting_attempt) {
    context.addIssue({ code: "custom", path: ["resulting_attempt"], message: "a simple revision preserves its attempt" });
  }
  if (record.classification === "significant" && record.resulting_attempt !== 1) {
    context.addIssue({ code: "custom", path: ["resulting_attempt"], message: "a significant revision resets to attempt 1" });
  }
  if (record.predecessor_subject_digest === record.resulting_subject_digest) {
    context.addIssue({ code: "custom", path: ["resulting_subject_digest"], message: "a human revision must change the subject" });
  }
  if (record.evidence.some((reference) => reference.phase_instance !== record.phase_instance)) {
    context.addIssue({ code: "custom", path: ["evidence"], message: "human revision evidence must belong to its phase" });
  }
}) as unknown as z.ZodType<HumanRevisionRecord>;

const planningRestartConnectedHostProvenanceV1Schema = z.object({
  schema_version: z.literal("1"),
  actor_class: z.literal("human"),
  assurance: z.literal("declared-local-trace"),
  channel: z.literal("connected-host"),
  decision_event_id: safeIdV1Schema,
  connection_id: safeIdV1Schema,
  request_id_digest: sha256Digest,
  recorded_at: z.string().datetime({ offset: false, local: false, precision: 3 }),
}).strict();

const planningRestartLocalProvenanceV1Schema = z.object({
  schema_version: z.literal("1"),
  actor_class: z.literal("human"),
  assurance: z.literal("declared-local-trace"),
  channel: z.literal("archflow-local"),
  decision_event_id: safeIdV1Schema,
  helper_invocation_id: safeIdV1Schema,
  recorded_at: z.string().datetime({ offset: false, local: false, precision: 3 }),
}).strict();

/** Server-attested arm: the server binds the authenticated request by digest at record time. */
const planningRestartServerAttestedProvenanceV1Schema = z.object({
  schema_version: z.literal("1"),
  actor_class: z.literal("human"),
  assurance: z.literal("connected-request-trace"),
  channel: z.literal("connected-host"),
  connection_id: safeIdV1Schema,
  invocation_id: safeIdV1Schema,
  request_id_digest: sha256Digest,
  request_digest: sha256Digest,
}).strict();

export const planningRestartHumanProvenanceV1Schema = z.union([
  planningRestartConnectedHostProvenanceV1Schema,
  planningRestartLocalProvenanceV1Schema,
  planningRestartServerAttestedProvenanceV1Schema,
]) as unknown as z.ZodType<PlanningRestartHumanProvenance>;

// Task-state owns its own projection-ref mirror rather than $ref-ing result-manifest's def: this
// schema catalogue stays self-contained, exactly like the shared reference shapes above.
const adoptedProjectionRefV1Schema = z.object({
  path: repositoryPathClaimV1Schema,
  content_digest: sha256Digest,
}).strict();

export const baselineAdoptionRecordV1Schema = z.object({
  gate_id: pathSafeIdV1Schema,
  adopted_at_revision: positiveSafeInteger,
  adopted_projections: z.array(adoptedProjectionRefV1Schema)
    .refine((items) => isSortedUniqueBy(items, tupleKey("path")), "adopted projections must be sorted by path with no duplicates"),
  adopted_absences: z.array(repositoryPathClaimV1Schema).optional()
    .refine((items) => isSortedUniqueBy(items), "adopted absences must be sorted with no duplicates"),
}).strict() as unknown as z.ZodType<BaselineAdoptionRecord>;

const ruleSettlementMatchV1Schema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("subject"), subject: workflowSubjectV1Schema }).strict(),
  z.object({
    kind: z.literal("content"),
    paths: z.array(z.string()).min(1)
      .refine((items) => isSortedUniqueBy(items), "content match paths must be sorted with no duplicates"),
  }).strict(),
]);

export const ruleSettlementConclusionV1Schema = z.discriminatedUnion("wait", [
  z.object({ wait: z.literal(false), match: z.literal(null) }).strict(),
  z.object({ wait: z.literal(true), match: ruleSettlementMatchV1Schema }).strict(),
]) as unknown as z.ZodType<RuleSettlementConclusionV1>;

export const ruleSettlementV1Schema = z.object({
  task_id: taskSlugV1Schema,
  phase_instance: phaseInstanceIdV1Schema,
  step: z.enum(PIPELINE_STEPS),
  subject_digest: sha256Digest,
  conclusion: ruleSettlementConclusionV1Schema,
  config_digest: sha256Digest,
  settled_at_revision: positiveSafeInteger,
}).strict() as unknown as z.ZodType<RuleSettlementV1>;

export const planningRestartRecordV1Schema = z.object({
  restart_id: pathSafeIdV1Schema,
  source_phase_instance: phaseInstanceIdV1Schema,
  target_phase_instance: phaseInstanceIdV1Schema,
  reason: z.string().min(1).max(4096).regex(/\S/u),
  restarted_at_revision: positiveSafeInteger,
  superseded_results: z.array(authoritativeResultRefV1Schema)
    .refine((items) => isSortedUniqueBy(items, tupleKey(["phase_instance", "step"])), "superseded_results must be sorted by (phase_instance, step) with no duplicates"),
  cleared_waivers: z.array(waiverRefV1Schema)
    .refine((items) => isSortedUniqueBy(items, tupleKey("gate_id")), "cleared_waivers must be sorted by gate_id with no duplicates"),
  cleared_pending_human_revision: pendingHumanRevisionV1Schema.optional(),
  human_provenance: planningRestartHumanProvenanceV1Schema,
}).strict().superRefine((record, context) => {
  if (!isStrictlyEarlierPlanningPhase(record.target_phase_instance, record.source_phase_instance)) {
    context.addIssue({ code: "custom", path: ["target_phase_instance"], message: "restart target must be a strictly earlier planning phase" });
  }
}) as unknown as z.ZodType<PlanningRestartRecord>;

/** Recursive JSON value used by `lastTransitionV1Schema`; overridden during JSON Schema emission. */
export const lastTransitionOutcomeV1Schema = z.json();

export const lastTransitionV1Schema = z.object({
  schema_version: z.literal("1"),
  tool: z.enum(TOOL_NAMES),
  operation: safeCodeV1Schema,
  intent_id: pathSafeIdV1Schema,
  request_digest: sha256Digest,
  input_fingerprint: sha256Digest,
  result_id: safeIdV1Schema,
  outcome: lastTransitionOutcomeV1Schema,
  outcome_digest: sha256Digest,
  prior_revision: safeIntegerV1Schema,
  resulting_revision: positiveSafeInteger,
}).strict() as unknown as z.ZodType<LastTransition>;

// Task-state owns its own config-snapshot mirror rather than $ref-ing the `config` document's
// defs — the same self-containment rule as the projection-ref mirror above. Every config schema
// instance is registered under `config#/$defs/...`, and task-state does not carry that document,
// so a shared instance would emit an unresolvable cross-document `$ref` here. Each level is a
// parentless clone that keeps its source's own def and re-parents its nested schemas onto the
// clones, so the mirror shares every check with the config parser and re-derives its structure
// from the source shapes at module load — it cannot drift silently. The clones register as this
// document's own `$defs` (see the schema-generation manifest), so each shape emits once.
export const taskConfigRouteV1Schema = configRouteSchema.clone(configRouteSchema.def);
export const taskConfigRolesV1Schema = configRolesSchema.clone({
  ...configRolesSchema.def,
  shape: Object.fromEntries(
    Object.entries(configRolesSchema.shape).map(([role]) => [role, taskConfigRouteV1Schema.optional()]),
  ) as typeof configRolesSchema.shape,
});
export const taskConfigOverridesV1Schema = configOverridesSchema.clone({
  ...configOverridesSchema.def,
  shape: Object.fromEntries(
    Object.entries(configOverridesSchema.shape).map(([phase]) => [phase, taskConfigRolesV1Schema.optional()]),
  ) as typeof configOverridesSchema.shape,
});
export const taskConfigApprovalRulesV1Schema = approvalRulesSchema.clone(approvalRulesSchema.def);
export const taskConfigSnapshotV1Schema = configV1Schema.clone({
  ...configV1Schema.def,
  shape: {
    ...configV1Schema.shape,
    roles: taskConfigRolesV1Schema,
    overrides: taskConfigOverridesV1Schema.optional(),
    approval_rules: taskConfigApprovalRulesV1Schema.optional(),
  },
});

/**
 * The authority. Each of the three set fields calls `isSortedUniqueBy` with `tupleKey` over its
 * pinned property list — the shared exported ordering predicates — so each ordering rule is
 * literally one predicate across every shape. `.strict()` matches `additionalProperties: false`; absence is
 * `.optional()` plus omission from `required`, never `null`.
 */
export const taskStateV1Schema = z.object({
  schema_version: z.literal("1"),
  task_id: taskSlugV1Schema,
  repository_identity_digest: sha256Digest,
  revision: positiveSafeInteger,
  phase_instance: phaseInstanceIdV1Schema,
  step: z.enum(PIPELINE_STEPS),
  status: stepStatusV1Schema,
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
  pending_human_revision: pendingHumanRevisionV1Schema.optional(),
  human_revision_history: z.array(humanRevisionRecordV1Schema)
    .refine((items) => isSortedUniqueBy(items, tupleKey("gate_id")), "human_revision_history must be sorted by gate_id with no duplicates")
    .optional(),
  restart_history: z.array(planningRestartRecordV1Schema)
    .refine((items) => isSortedUniqueBy(items, tupleKey("restart_id")), "restart_history must be sorted by restart_id with no duplicates")
    .optional(),
  baseline_adoptions: z.array(baselineAdoptionRecordV1Schema)
    .refine((items) => isSortedUniqueBy(items, tupleKey("gate_id")), "baseline_adoptions must be sorted by gate_id with no duplicates")
    .optional(),
  rule_settlements: z.array(ruleSettlementV1Schema)
    .refine(isSortedUniqueRuleSettlements, "rule_settlements must be sorted by (phase_instance, subject_digest, settled_at_revision) with no duplicates")
    .optional(),
  last_seen_config: taskConfigSnapshotV1Schema.optional(),
  last_transition: lastTransitionV1Schema.optional(),
  terminal: z.enum(TERMINAL_STATES).optional(),
}).strict().superRefine((state, context) => {
  state.restart_history?.forEach((restart, index) => {
    if (restart.restarted_at_revision > state.revision) {
      context.addIssue({ code: "custom", path: ["restart_history", index, "restarted_at_revision"], message: "restart revision cannot exceed the current state revision" });
    }
  });
  state.baseline_adoptions?.forEach((adoption, index) => {
    if (adoption.adopted_at_revision > state.revision) {
      context.addIssue({ code: "custom", path: ["baseline_adoptions", index, "adopted_at_revision"], message: "baseline adoption revision cannot exceed the current state revision" });
    }
  });
  state.rule_settlements?.forEach((settlement, index) => {
    if (settlement.settled_at_revision > state.revision) {
      context.addIssue({ code: "custom", path: ["rule_settlements", index, "settled_at_revision"], message: "rule settlement revision cannot exceed the current state revision" });
    }
  });
  const pending = state.pending_human_revision;
  if (pending === undefined) return;
  if (state.open_gate !== undefined || state.terminal !== undefined || state.step !== "produce" ||
      state.status === "succeeded" || state.attempt !== pending.attempt ||
      pending.requested_at_revision > state.revision ||
      pending.evidence.some((reference) => reference.phase_instance !== state.phase_instance)) {
    context.addIssue({ code: "custom", path: ["pending_human_revision"], message: "pending human revision does not match its active produce state" });
  }
}) as unknown as z.ZodType<TaskStateV1>;

import { z } from "zod";

import type { TaskStateV1 } from "./durable-state.js";
import type { Sha256Digest, TaskSlug } from "./evidence.js";
import { sha256DigestV1Schema, taskSlugV1Schema } from "./evidence.js";
import type { PlainJsonValue } from "./plain-json.js";
import { assertPlainJson } from "./plain-json.js";
import type { PhaseInstanceId } from "./phase-instance.js";
import { positiveSafePhaseNumberV1Schema } from "./phase-instance.js";
import { REVIEW_FINDING_SEVERITIES } from "./review.js";

const nonBlank = z.string().min(1).regex(/\S/u);
const boundedText = nonBlank.max(4096);
const digest = sha256DigestV1Schema as unknown as z.ZodType<Sha256Digest>;

export const WORKFLOW_CONDITIONS = ["awaiting-client", "awaiting-human", "ready", "blocked", "complete"] as const;
export type WorkflowConditionV1 = (typeof WORKFLOW_CONDITIONS)[number];

export type WorkflowResourceV1 = {
  readonly role: string;
  readonly path: string;
  readonly access: "read" | "write" | "read-write";
};

export type PublicFindingDispositionV1 =
  | { readonly disposition: "accepted" | "accepted-editorial"; readonly rationale: string; readonly revision_intent: string }
  | { readonly disposition: "rejected"; readonly rationale: string; readonly evidence: string };

export type PublicFindingV1 = {
  readonly finding_id: string;
  readonly severity: "blocker" | "major" | "minor";
  readonly blocking: boolean;
  readonly summary: string;
  readonly evidence: string;
  readonly suggested_resolution: string;
  readonly current_disposition?: PublicFindingDispositionV1;
};
export type PublicTriageDispositionV1 = PublicFindingDispositionV1 & { readonly finding_id: string };

export type PublicConstitutionRuleV1 = {
  readonly id: string;
  readonly version: number;
  readonly text: string;
  readonly review_trigger?: string;
  readonly enforced_by?: readonly string[];
};

export type PublicRubricCriterionV1 = { readonly id: string; readonly text: string; readonly blocking: boolean };
export type PublicRubricV1 = {
  readonly schema_version: "1";
  readonly kind: "artifact" | "implementation";
  readonly mode: "adversarial";
  readonly criteria: readonly PublicRubricCriterionV1[];
};
export type PublicReviewContextV1 = {
  readonly rubric: PublicRubricV1;
  readonly active_rules: readonly PublicConstitutionRuleV1[];
};

export type HumanPresentationOptionV1 = { readonly token: string; readonly label: string; readonly consequence: string };
export type HumanPresentationV1 = {
  readonly title: string;
  readonly summary: string;
  readonly details?: readonly string[];
  readonly question: string;
  readonly options: readonly HumanPresentationOptionV1[];
};

export type WorkflowPositionV1 =
  | { readonly kind: "prd" | "design" }
  | { readonly kind: "phase-design" | "phase-impl"; readonly phase: number };

export type WorkflowInvocationV1 =
  | { readonly skill: "archflow-prd"; readonly intent: "resume" | "reopen" }
  | { readonly skill: "archflow-design"; readonly intent: "resume" | "reopen" }
  | { readonly skill: "archflow-phase-design"; readonly phase: number; readonly intent: "resume" | "reopen" }
  | { readonly skill: "archflow-phase-impl"; readonly phase: number; readonly intent: "resume" };

export type WorkflowReopenImpactV1 = {
  readonly target: WorkflowPositionV1;
  readonly affected_positions: readonly WorkflowPositionV1[];
  readonly authority_effects: readonly (
    | "supersede-results"
    | "clear-active-waivers"
    | "clear-pending-human-revision"
    | "clear-planned-final-phase"
  )[];
  readonly planned_final_phase: "clear" | "retain";
  readonly preserves_existing_git_index_and_worktree_bytes: true;
  readonly appends_prd_ask_history: boolean;
  readonly requires_fresh_review_and_approval: true;
};

export const SEMANTIC_ACTION_KINDS = [
  "initialize-task", "begin-work", "submit-work", "review", "triage", "revise", "reopen",
  "open-waiver", "decide", "commit", "start-next-skill", "finish-task", "inspect", "none",
] as const;
export type SemanticActionKindV1 = (typeof SEMANTIC_ACTION_KINDS)[number];
export const APPLY_SUBMISSION_KINDS = ["none", "task-ask", "work-result", "triage", "gate-summary", "reopening-request", "decision"] as const;
export type ApplySubmissionKindV1 = (typeof APPLY_SUBMISSION_KINDS)[number];

export type SemanticNextActionV1 = {
  readonly kind: SemanticActionKindV1;
  readonly instruction: string;
  readonly offer?: string;
  readonly expected_submission?: ApplySubmissionKindV1;
  readonly skill?: string;
  readonly skill_args?: readonly string[];
  readonly commit?: {
    readonly path: string;
    readonly message: string;
    readonly target_ref: string;
    readonly baseline: string;
    readonly requires_human_confirmation: boolean;
  };
  readonly reopen?: WorkflowReopenImpactV1;
};

export type WorkflowViewV1 = {
  readonly schema_version: "1";
  readonly task_id: string;
  readonly condition: WorkflowConditionV1;
  readonly headline: string;
  readonly detail: string;
  readonly position?: WorkflowPositionV1;
  readonly resources: readonly WorkflowResourceV1[];
  readonly next_action: SemanticNextActionV1;
  readonly findings?: readonly PublicFindingV1[];
  readonly review_context?: PublicReviewContextV1;
  readonly presentation?: HumanPresentationV1;
};

export type HumanRevisionDeclarationV1 = {
  readonly classification: "simple" | "significant";
  readonly rationale: string;
  readonly user_override?: { readonly agent_classification: "simple" | "significant"; readonly rationale: string };
};

export type ApplySubmissionV1 =
  | { readonly kind: "task-ask"; readonly text: string }
  | { readonly kind: "reopening-request"; readonly request: string }
  | {
      readonly kind: "work-result";
      readonly outcome: "succeeded";
      readonly implementation?: {
        readonly base_commit: string;
        readonly outputs: readonly string[];
        readonly restore_targets: readonly string[];
        readonly declared_inputs: readonly { readonly input_id: string; readonly path: string }[];
      };
      readonly human_revision?: HumanRevisionDeclarationV1;
    }
  | { readonly kind: "work-result"; readonly outcome: "failed"; readonly reason: string }
  | { readonly kind: "triage"; readonly dispositions: readonly PublicTriageDispositionV1[] }
  | { readonly kind: "gate-summary"; readonly summary: string }
  | { readonly kind: "decision"; readonly choice: string; readonly reason: string; readonly option_rationale?: string };

export type ArchFlowStatusInputV1 = {
  readonly schema_version: "1";
  readonly task_id: string;
  readonly invocation?: WorkflowInvocationV1;
};

export type ArchFlowApplyInputV1 = {
  readonly schema_version: "1";
  readonly task_id: string;
  readonly invocation: WorkflowInvocationV1;
  readonly action: { readonly offer: string; readonly submission?: ApplySubmissionV1 };
};

/** Internal, authenticated join used to project one public status response. */
export type SemanticStatusSnapshotV1 = {
  readonly schema_version: "1";
  readonly repository_identity_digest: Sha256Digest;
  readonly state?: TaskStateV1;
  readonly status: PlainJsonValue;
  readonly full_findings: readonly PublicFindingV1[];
  readonly pending_waiver_origin?: PlainJsonValue;
  readonly archived_decision?: PlainJsonValue;
  readonly revision_checkpoint?: PlainJsonValue;
  readonly reopen_impacts: readonly WorkflowReopenImpactV1[];
};

export type SemanticActionOfferV1 = {
  readonly schema_version: "1";
  readonly repository_identity_digest: Sha256Digest;
  readonly task_id: TaskSlug;
  readonly revision: number;
  readonly input_fingerprint: Sha256Digest;
  readonly invocation: WorkflowInvocationV1;
  readonly action_kind: SemanticActionKindV1;
  readonly next_action_code: string;
  readonly expected_submission: ApplySubmissionKindV1;
  readonly phase_instance?: PhaseInstanceId;
  readonly attempt?: number;
  readonly subject_digest?: Sha256Digest;
  readonly evidence_digest?: Sha256Digest;
  readonly gate_digest?: Sha256Digest;
  readonly commit_digest?: Sha256Digest;
  readonly archived_decision_digest?: Sha256Digest;
  readonly reopen?: WorkflowReopenImpactV1;
};

export const SEMANTIC_SUBSTEPS = [
  "initialize-task", "begin-work", "submit-work", "review-enter", "review-run", "review-empty-triage",
  "triage", "revise-enter", "reopen", "open-gate", "open-waiver", "decision-archive",
  "decision-settle", "start-next-skill", "finish-task",
] as const;
export type SemanticSubstepV1 = (typeof SEMANTIC_SUBSTEPS)[number];

export type SemanticOperationKeyV1 = {
  readonly schema_version: "1";
  readonly offer_digest: Sha256Digest;
  readonly repository_identity_digest: Sha256Digest;
  readonly task_id: TaskSlug;
  readonly invocation: WorkflowInvocationV1;
  readonly action_kind: SemanticActionKindV1;
  readonly phase_instance?: PhaseInstanceId;
  readonly attempt?: number;
  readonly subject_digest?: Sha256Digest;
  readonly submission_digest: Sha256Digest;
};

export type SemanticSuccessV1 = { readonly schema_version: "1"; readonly ok: true; readonly value: WorkflowViewV1 };
export type SemanticErrorSummaryV1 = { readonly code: string; readonly message: string; readonly retryable: boolean };
export type SemanticFailureV1 = { readonly schema_version: "1"; readonly ok: false; readonly error: SemanticErrorSummaryV1; readonly view?: WorkflowViewV1 };
export type SemanticResultV1 = SemanticSuccessV1 | SemanticFailureV1;

export const workflowResourceV1Schema = z.object({ role: nonBlank, path: nonBlank, access: z.enum(["read", "write", "read-write"]) }).strict();
const findingDispositionV1Schema = z.discriminatedUnion("disposition", [
  z.object({ disposition: z.enum(["accepted", "accepted-editorial"]), rationale: boundedText, revision_intent: boundedText }).strict(),
  z.object({ disposition: z.literal("rejected"), rationale: boundedText, evidence: boundedText }).strict(),
]);
const triageDispositionV1Schema = z.discriminatedUnion("disposition", [
  z.object({ finding_id: nonBlank, disposition: z.enum(["accepted", "accepted-editorial"]), rationale: boundedText, revision_intent: boundedText }).strict(),
  z.object({ finding_id: nonBlank, disposition: z.literal("rejected"), rationale: boundedText, evidence: boundedText }).strict(),
]);
export const publicFindingV1Schema = z.object({
  finding_id: nonBlank,
  severity: z.enum(REVIEW_FINDING_SEVERITIES),
  blocking: z.boolean(),
  summary: nonBlank,
  evidence: nonBlank,
  suggested_resolution: nonBlank,
  current_disposition: findingDispositionV1Schema.optional(),
}).strict().superRefine((finding, context) => {
  if (finding.blocking !== (finding.severity === "blocker")) context.addIssue({ code: "custom", path: ["blocking"], message: "only blocker findings are blocking" });
});
const publicConstitutionRuleV1Schema = z.object({ id: nonBlank, version: positiveSafePhaseNumberV1Schema, text: nonBlank, review_trigger: nonBlank.optional(), enforced_by: z.array(nonBlank).min(1).optional() }).strict();
const rubricCriterionV1Schema = z.object({ id: nonBlank, text: nonBlank, blocking: z.boolean() }).strict();
const publicRubricV1Schema = z.object({ schema_version: z.literal("1"), kind: z.enum(["artifact", "implementation"]), mode: z.literal("adversarial"), criteria: z.array(rubricCriterionV1Schema).min(1) }).strict();
const publicReviewContextV1Schema = z.object({ rubric: publicRubricV1Schema, active_rules: z.array(publicConstitutionRuleV1Schema) }).strict();
const humanPresentationV1Schema = z.object({ title: nonBlank, summary: nonBlank, details: z.array(nonBlank).optional(), question: nonBlank, options: z.array(z.object({ token: nonBlank, label: nonBlank, consequence: nonBlank }).strict()).min(1) }).strict();
export const workflowPositionV1Schema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("prd") }).strict(),
  z.object({ kind: z.literal("design") }).strict(),
  z.object({ kind: z.literal("phase-design"), phase: positiveSafePhaseNumberV1Schema }).strict(),
  z.object({ kind: z.literal("phase-impl"), phase: positiveSafePhaseNumberV1Schema }).strict(),
]);
export const workflowInvocationV1Schema = z.discriminatedUnion("skill", [
  z.object({ skill: z.literal("archflow-prd"), intent: z.enum(["resume", "reopen"]) }).strict(),
  z.object({ skill: z.literal("archflow-design"), intent: z.enum(["resume", "reopen"]) }).strict(),
  z.object({ skill: z.literal("archflow-phase-design"), phase: positiveSafePhaseNumberV1Schema, intent: z.enum(["resume", "reopen"]) }).strict(),
  z.object({ skill: z.literal("archflow-phase-impl"), phase: positiveSafePhaseNumberV1Schema, intent: z.literal("resume") }).strict(),
]) as unknown as z.ZodType<WorkflowInvocationV1>;
const reopenImpactV1Schema = z.object({
  target: workflowPositionV1Schema,
  affected_positions: z.array(workflowPositionV1Schema),
  authority_effects: z.array(z.enum(["supersede-results", "clear-active-waivers", "clear-pending-human-revision", "clear-planned-final-phase"])),
  planned_final_phase: z.enum(["clear", "retain"]),
  preserves_existing_git_index_and_worktree_bytes: z.literal(true),
  appends_prd_ask_history: z.boolean(),
  requires_fresh_review_and_approval: z.literal(true),
}).strict();
const commitInstructionV1Schema = z.object({ path: nonBlank, message: nonBlank, target_ref: nonBlank, baseline: nonBlank, requires_human_confirmation: z.boolean() }).strict();
export const semanticNextActionV1Schema = z.object({ kind: z.enum(SEMANTIC_ACTION_KINDS), instruction: nonBlank, offer: z.string().regex(/^af1_[0-9a-f]{64}$/u).optional(), expected_submission: z.enum(APPLY_SUBMISSION_KINDS).optional(), skill: nonBlank.optional(), skill_args: z.array(z.string()).optional(), commit: commitInstructionV1Schema.optional(), reopen: reopenImpactV1Schema.optional() }).strict();
export const workflowViewV1Schema = z.object({ schema_version: z.literal("1"), task_id: taskSlugV1Schema, condition: z.enum(WORKFLOW_CONDITIONS), headline: nonBlank, detail: nonBlank, position: workflowPositionV1Schema.optional(), resources: z.array(workflowResourceV1Schema), next_action: semanticNextActionV1Schema, findings: z.array(publicFindingV1Schema).optional(), review_context: publicReviewContextV1Schema.optional(), presentation: humanPresentationV1Schema.optional() }).strict() as unknown as z.ZodType<WorkflowViewV1>;

const humanRevisionDeclarationV1Schema = z.object({ classification: z.enum(["simple", "significant"]), rationale: boundedText, user_override: z.object({ agent_classification: z.enum(["simple", "significant"]), rationale: boundedText }).strict().optional() }).strict().superRefine((revision, context) => {
  if (revision.user_override?.agent_classification === revision.classification) context.addIssue({ code: "custom", path: ["user_override", "agent_classification"], message: "an override must change the classification" });
});
const implementationFactsV1Schema = z.object({ base_commit: nonBlank, outputs: z.array(nonBlank), restore_targets: z.array(nonBlank), declared_inputs: z.array(z.object({ input_id: nonBlank, path: nonBlank }).strict()) }).strict();
export const applySubmissionV1Schema = z.union([
  z.object({ kind: z.literal("task-ask"), text: boundedText }).strict(),
  z.object({ kind: z.literal("reopening-request"), request: boundedText }).strict(),
  z.object({ kind: z.literal("work-result"), outcome: z.literal("succeeded"), implementation: implementationFactsV1Schema.optional(), human_revision: humanRevisionDeclarationV1Schema.optional() }).strict(),
  z.object({ kind: z.literal("work-result"), outcome: z.literal("failed"), reason: boundedText }).strict(),
  z.object({ kind: z.literal("triage"), dispositions: z.array(triageDispositionV1Schema) }).strict(),
  z.object({ kind: z.literal("gate-summary"), summary: boundedText }).strict(),
  z.object({ kind: z.literal("decision"), choice: nonBlank, reason: boundedText, option_rationale: boundedText.optional() }).strict(),
]) as unknown as z.ZodType<ApplySubmissionV1>;

/** Plain object root; all variants are nested below `invocation` and `action.submission`. */
export const archFlowApplyInputV1Schema = z.object({ schema_version: z.literal("1"), task_id: taskSlugV1Schema, invocation: workflowInvocationV1Schema, action: z.object({ offer: z.string().regex(/^af1_[0-9a-f]{64}$/u), submission: applySubmissionV1Schema.optional() }).strict() }).strict() as unknown as z.ZodType<ArchFlowApplyInputV1>;
export const archFlowStatusInputV1Schema = z.object({ schema_version: z.literal("1"), task_id: taskSlugV1Schema, invocation: workflowInvocationV1Schema.optional() }).strict() as unknown as z.ZodType<ArchFlowStatusInputV1>;

const parseMaterialized = <T>(schema: z.ZodType<T>, value: unknown, label: string): T => {
  assertPlainJson(value, label);
  return schema.parse(structuredClone(value));
};
export const parseWorkflowViewV1 = (value: unknown): WorkflowViewV1 => parseMaterialized(workflowViewV1Schema, value, "workflow view");
export const parseWorkflowInvocationV1 = (value: unknown): WorkflowInvocationV1 => parseMaterialized(workflowInvocationV1Schema, value, "workflow invocation");
export const parseArchFlowStatusInputV1 = (value: unknown): ArchFlowStatusInputV1 => parseMaterialized(archFlowStatusInputV1Schema, value, "archflow status input");
export const parseArchFlowApplyInputV1 = (value: unknown): ArchFlowApplyInputV1 => parseMaterialized(archFlowApplyInputV1Schema, value, "archflow apply input");
export const parseApplySubmissionV1 = (value: unknown): ApplySubmissionV1 => parseMaterialized(applySubmissionV1Schema, value, "archflow apply submission");

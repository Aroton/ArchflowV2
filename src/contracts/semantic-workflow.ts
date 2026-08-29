import { z } from "zod";

import { gitOidV1Schema, type GitOid } from "./canonical.js";
import { configRouteSchema, type ModelRouteV1 } from "./config.js";
import { repositoryNameV1Schema, type RepositoryName } from "./config.js";
import {
  publicDispatchFailureV1Schema,
  type PublicDispatchFailureV1,
} from "./dispatch-failure.js";
import type { ConfigChangeEntry, TaskStateV1 } from "./durable-state.js";
import type { Sha256Digest, TaskSlug } from "./evidence.js";
import { sha256DigestV1Schema, taskSlugV1Schema } from "./evidence.js";
import type { ReviewRouteSetV1, RouteOverrideDeclaration } from "./mcp-tools.js";
import type { PlainJsonValue } from "./plain-json.js";
import { assertPlainJson } from "./plain-json.js";
import type { PhaseInstanceId } from "./phase-instance.js";
import { positiveSafePhaseNumberV1Schema } from "./phase-instance.js";
import { REVIEW_FINDING_SEVERITIES } from "./review.js";

const nonBlank = z.string().min(1).regex(/\S/u);
const boundedText = nonBlank.max(4096);
const digest = sha256DigestV1Schema as unknown as z.ZodType<Sha256Digest>;
export const workflowRepositoryNameV1Schema = repositoryNameV1Schema.clone(repositoryNameV1Schema.def);

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
  readonly assignments?: readonly PublicReviewAssignmentV1[];
  readonly active_rules: readonly PublicConstitutionRuleV1[];
};
export type PublicReviewAssignmentV1 = {
  readonly reviewer_id: string;
  readonly focus: "general" | "tests";
  readonly criterion_ids: readonly string[];
};

/** One counter-review round of the current phase instance: what it raised and what triage accepted. */
export type PublicReviewRoundV1 = {
  readonly attempt: number;
  readonly findings: number;
  readonly blocking: number;
  readonly accepted: number;
};

/**
 * How strong the current review evidence is, for the human who is about to approve on it. Every
 * field restates retained provenance or triage authority; none of it is producer prose. A
 * same-family reviewer, a low effort, or a pass that came from a remediation round are all legal
 * configurations — this projection exists so they are never invisible at the gate.
 */
export type PublicReviewStrengthV1 = {
  readonly reviewer_model: string;
  readonly reviewer_effort: string;
  readonly reviewer_family: string;
  readonly producer_family: string;
  readonly same_family: boolean;
  readonly attempt: number;
  /** True when the current review ran against pinned prior triage rather than as a first, full-scope review. */
  readonly remediation_round: boolean;
  readonly rounds: readonly PublicReviewRoundV1[];
  readonly reviewers?: readonly PublicReviewerStrengthV1[];
};
export type PublicReviewerStrengthV1 = {
  readonly reviewer_id: string;
  readonly focus: "general" | "tests";
  readonly model: string;
  readonly effort: string;
  readonly reviewer_family: string;
  readonly same_family: boolean;
  readonly finding_count: number;
};

export type HumanPresentationOptionV1 = { readonly token: string; readonly label: string; readonly consequence: string };
export type HumanPresentationReasonV1 = {
  readonly class: "configured-approval" | "exception";
  readonly text: string;
};
export type HumanPresentationV1 = {
  readonly class: "configured-approval" | "exception";
  readonly title: string;
  readonly summary: string;
  readonly details?: readonly string[];
  readonly question: string;
  readonly reasons: readonly HumanPresentationReasonV1[];
  readonly options: readonly HumanPresentationOptionV1[];
};

export type WorkflowPositionV1 =
  | { readonly kind: "prd" | "design" }
  | { readonly kind: "phase-design" | "phase-impl"; readonly phase: number };

/** Public route declaration repeated unchanged for one producer skill invocation. */
export type WorkflowReviewRoutesV1 = ReviewRouteSetV1;
export type WorkflowGeneralReviewRoutesV1 = Omit<ReviewRouteSetV1, "test-reviewer">;

export type WorkflowInvocationV1 =
  | { readonly skill: "archflow-prd"; readonly intent: "resume" | "reopen"; readonly review_routes?: WorkflowGeneralReviewRoutesV1 }
  | { readonly skill: "archflow-design"; readonly intent: "resume" | "reopen"; readonly review_routes?: WorkflowGeneralReviewRoutesV1 }
  | { readonly skill: "archflow-phase-design"; readonly phase: number; readonly intent: "resume" | "reopen"; readonly review_routes?: WorkflowReviewRoutesV1 }
  | { readonly skill: "archflow-phase-impl"; readonly phase: number; readonly intent: "resume"; readonly review_routes?: WorkflowReviewRoutesV1 };

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
  "open-waiver", "decide", "refresh-milestone-baseline", "recover-milestone-authority", "refresh-stale-baseline",
  "commit", "start-next-skill", "finish-task", "inspect", "none",
] as const;
export type SemanticActionKindV1 = (typeof SEMANTIC_ACTION_KINDS)[number];
export const APPLY_SUBMISSION_KINDS = ["none", "task-ask", "work-result", "triage", "gate-summary", "reopening-request", "decision", "review-dispatch"] as const;
export type ApplySubmissionKindV1 = (typeof APPLY_SUBMISSION_KINDS)[number];

export type SemanticNextActionV1 = {
  readonly kind: SemanticActionKindV1;
  readonly instruction: string;
  readonly offer?: string;
  readonly expected_submission?: ApplySubmissionKindV1;
  readonly skill?: string;
  readonly skill_args?: readonly string[];
  readonly commit?: {
    readonly paths: readonly string[];
    readonly message: string;
    readonly target_ref: string;
    readonly baseline: string;
    /** Present for a secondary; omitted means the primary repository. */
    readonly repository?: { readonly name: RepositoryName; readonly location: string };
  };
  readonly reopen?: WorkflowReopenImpactV1;
};

/** Live, informational repository-set member exposed by status and semantic workflow views. */
export type RepositoryStatusV1 = {
  readonly name: string;
  readonly mode: "context-only" | "writable";
  readonly location: string;
  readonly head?: GitOid;
  readonly last_reviewed_commit?: GitOid;
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
  /** Present whenever current counter-review evidence exists; see {@link PublicReviewStrengthV1}. */
  readonly review_strength?: PublicReviewStrengthV1;
  readonly presentation?: HumanPresentationV1;
  readonly dispatch_failure?: PublicDispatchFailureV1;
  /**
   * Live repository set, resolved from task config on every status read. It is a projection only:
   * review authority comes from authenticated retained evidence and write authority from declared
   * implementation sections, never from this list.
   */
  readonly repositories?: readonly RepositoryStatusV1[];
  /**
   * Informational field-level config changes since the last config-observing commit, projected
   * verbatim from the status notice. Never changes the condition or the next action.
   */
  readonly config_change?: readonly ConfigChangeEntry[];
};

export type HumanRevisionDeclarationV1 = {
  readonly classification: "simple" | "significant";
  readonly rationale: string;
  readonly user_override?: { readonly agent_classification: "simple" | "significant"; readonly rationale: string };
};

export type ImplementationDeclaredInputV1 = {
  readonly input_id: string;
  readonly path: string;
};

export type ImplementationRepositoryDeclarationV1 = {
  readonly name: RepositoryName;
  readonly base_commit: string;
  readonly outputs: readonly string[];
  readonly restore_targets: readonly string[];
  readonly declared_inputs: readonly ImplementationDeclaredInputV1[];
};

export type ImplementationDeclarationV1 = {
  readonly base_commit: string;
  readonly outputs: readonly string[];
  readonly restore_targets: readonly string[];
  readonly declared_inputs: readonly ImplementationDeclaredInputV1[];
  /** Exactly one ordinal-sorted section for every configured writable secondary. */
  readonly repositories?: readonly ImplementationRepositoryDeclarationV1[];
};

export type ApplySubmissionV1 =
  | { readonly kind: "task-ask"; readonly text: string }
  | { readonly kind: "reopening-request"; readonly request: string }
  | {
      readonly kind: "work-result";
      readonly outcome: "succeeded";
      readonly implementation?: ImplementationDeclarationV1;
      readonly human_revision?: HumanRevisionDeclarationV1;
    }
  | { readonly kind: "work-result"; readonly outcome: "failed"; readonly reason: string }
  | { readonly kind: "triage"; readonly dispositions: readonly PublicTriageDispositionV1[] }
  | { readonly kind: "gate-summary"; readonly summary: string }
  | { readonly kind: "decision"; readonly choice: string; readonly reason: string; readonly option_rationale?: string }
  | { readonly kind: "review-dispatch"; readonly route_override: RouteOverrideDeclaration };

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
  /** Digest of the exact canonical state document read for this snapshot. */
  readonly state_document_digest?: Sha256Digest;
  /** Digest of the live parsed task config read inside the same coherent status computation. */
  readonly live_config_digest?: Sha256Digest;
  /** Authenticated initialization binding; used only to retain legacy migration-audit ownership. */
  readonly legacy_import_initialization?: true;
  readonly status: PlainJsonValue;
  readonly full_findings: readonly PublicFindingV1[];
  /** Per-attempt finding and acceptance counts for the current phase instance, from retained review and triage. */
  readonly review_rounds?: readonly PublicReviewRoundV1[];
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
  "triage-enter", "triage", "revise-enter", "reopen", "open-gate", "open-waiver", "decision-archive",
  "decision-settle", "refresh-milestone-baseline", "start-next-skill", "finish-task",
  "recover-milestone-authority", "refresh-stale-baseline",
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
export type SemanticToolContractMap = {
  readonly archflow_status: { readonly input: ArchFlowStatusInputV1; readonly result: SemanticResultV1 };
  readonly archflow_apply: { readonly input: ArchFlowApplyInputV1; readonly result: SemanticResultV1 };
};

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
const publicReviewAssignmentV1Schema = z.object({ reviewer_id: nonBlank, focus: z.enum(["general", "tests"]), criterion_ids: z.array(nonBlank).min(1) }).strict();
const publicReviewContextV1Schema = z.object({ rubric: publicRubricV1Schema, assignments: z.array(publicReviewAssignmentV1Schema).min(1).optional(), active_rules: z.array(publicConstitutionRuleV1Schema) }).strict();
const roundCount = z.number().int().min(0).max(Number.MAX_SAFE_INTEGER);
export const publicReviewRoundV1Schema = z.object({ attempt: z.number().int().min(1).max(Number.MAX_SAFE_INTEGER), findings: roundCount, blocking: roundCount, accepted: roundCount }).strict() as unknown as z.ZodType<PublicReviewRoundV1>;
const publicReviewerStrengthV1Schema = z.object({ reviewer_id: nonBlank, focus: z.enum(["general", "tests"]), model: nonBlank, effort: nonBlank, reviewer_family: nonBlank, same_family: z.boolean(), finding_count: roundCount }).strict();
export const publicReviewStrengthV1Schema = z.object({ reviewer_model: nonBlank, reviewer_effort: nonBlank, reviewer_family: nonBlank, producer_family: nonBlank, same_family: z.boolean(), attempt: z.number().int().min(1).max(Number.MAX_SAFE_INTEGER), remediation_round: z.boolean(), rounds: z.array(publicReviewRoundV1Schema), reviewers: z.array(publicReviewerStrengthV1Schema).min(1).optional() }).strict() as unknown as z.ZodType<PublicReviewStrengthV1>;
const presentationClass = z.enum(["configured-approval", "exception"]);
const humanPresentationV1Schema = z.object({ class: presentationClass, title: nonBlank, summary: nonBlank, details: z.array(nonBlank).optional(), question: nonBlank, reasons: z.array(z.object({ class: presentationClass, text: nonBlank }).strict()).min(1), options: z.array(z.object({ token: nonBlank, label: nonBlank, consequence: nonBlank }).strict()).min(1) }).strict().superRefine((presentation, context) => {
  const expected = presentation.reasons.some((reason) => reason.class === "exception") ? "exception" : "configured-approval";
  if (presentation.class !== expected) context.addIssue({ code: "custom", path: ["class"], message: `presentation class must be ${expected}` });
});
export const workflowPositionV1Schema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("prd") }).strict(),
  z.object({ kind: z.literal("design") }).strict(),
  z.object({ kind: z.literal("phase-design"), phase: positiveSafePhaseNumberV1Schema }).strict(),
  z.object({ kind: z.literal("phase-impl"), phase: positiveSafePhaseNumberV1Schema }).strict(),
]);
export const workflowReviewModelRouteV1Schema = configRouteSchema.clone(configRouteSchema.def) as z.ZodType<ModelRouteV1>;
export const workflowReviewRoutesV1Schema = z.object({
  "counter-reviewer": workflowReviewModelRouteV1Schema.optional(),
  "test-reviewer": workflowReviewModelRouteV1Schema.optional(),
  adjudicator: workflowReviewModelRouteV1Schema.optional(),
}).strict().superRefine((routes, context) => {
  if (routes["counter-reviewer"] === undefined && routes["test-reviewer"] === undefined && routes.adjudicator === undefined) {
    context.addIssue({ code: "custom", message: "review_routes must name counter-reviewer, test-reviewer, adjudicator, or a combination" });
  }
}) as z.ZodType<ReviewRouteSetV1>;
export const workflowGeneralReviewRoutesV1Schema = z.object({
  "counter-reviewer": workflowReviewModelRouteV1Schema.optional(),
  adjudicator: workflowReviewModelRouteV1Schema.optional(),
}).strict().superRefine((routes, context) => {
  if (routes["counter-reviewer"] === undefined && routes.adjudicator === undefined) {
    context.addIssue({ code: "custom", message: "review_routes must name counter-reviewer, adjudicator, or both" });
  }
}) as z.ZodType<WorkflowGeneralReviewRoutesV1>;
export const workflowInvocationV1Schema = z.discriminatedUnion("skill", [
  z.object({ skill: z.literal("archflow-prd"), intent: z.enum(["resume", "reopen"]), review_routes: workflowGeneralReviewRoutesV1Schema.optional() }).strict(),
  z.object({ skill: z.literal("archflow-design"), intent: z.enum(["resume", "reopen"]), review_routes: workflowGeneralReviewRoutesV1Schema.optional() }).strict(),
  z.object({ skill: z.literal("archflow-phase-design"), phase: positiveSafePhaseNumberV1Schema, intent: z.enum(["resume", "reopen"]), review_routes: workflowReviewRoutesV1Schema.optional() }).strict(),
  z.object({ skill: z.literal("archflow-phase-impl"), phase: positiveSafePhaseNumberV1Schema, intent: z.literal("resume"), review_routes: workflowReviewRoutesV1Schema.optional() }).strict(),
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
const commitInstructionV1Schema = z.object({ paths: z.array(nonBlank).min(1), message: nonBlank, target_ref: nonBlank, baseline: nonBlank, repository: z.object({ name: workflowRepositoryNameV1Schema, location: nonBlank }).strict().optional() }).strict().superRefine((commit, context) => {
  if (commit.paths.some((path, index) => index > 0 && commit.paths[index - 1]! > path)) {
    context.addIssue({ code: "custom", path: ["paths"], message: "commit paths must be sorted ascending" });
  }
});
export const semanticNextActionV1Schema = z.object({ kind: z.enum(SEMANTIC_ACTION_KINDS), instruction: nonBlank, offer: z.string().regex(/^af1_[0-9a-f]{64}$/u).optional(), expected_submission: z.enum(APPLY_SUBMISSION_KINDS).optional(), skill: nonBlank.optional(), skill_args: z.array(z.string()).optional(), commit: commitInstructionV1Schema.optional(), reopen: reopenImpactV1Schema.optional() }).strict();
/**
 * This document's own plain-json value instance, shared by both sides of a config-change entry —
 * the same self-containment rule as `task-state`'s and `intent-receipt`'s `plainJson` defs: one
 * instance, registered once, so every appearance `$ref`s it instead of minting shared defs.
 */
export const configChangeValueV1Schema = z.json();

/** Mirrors `ConfigChangeEntry` (durable-state) for the view's informational `config_change` field. */
export const configChangeEntryV1Schema = z.object({
  path: z.string(),
  before: configChangeValueV1Schema.optional(),
  after: configChangeValueV1Schema.optional(),
}).strict() as unknown as z.ZodType<ConfigChangeEntry>;

export const repositoryStatusV1Schema = z.object({
  name: nonBlank,
  mode: z.enum(["context-only", "writable"]),
  location: nonBlank,
  head: gitOidV1Schema.optional(),
  last_reviewed_commit: gitOidV1Schema.optional(),
}).strict() as unknown as z.ZodType<RepositoryStatusV1>;

export const workflowViewV1Schema = z.object({ schema_version: z.literal("1"), task_id: taskSlugV1Schema, condition: z.enum(WORKFLOW_CONDITIONS), headline: nonBlank, detail: nonBlank, position: workflowPositionV1Schema.optional(), resources: z.array(workflowResourceV1Schema), next_action: semanticNextActionV1Schema, findings: z.array(publicFindingV1Schema).optional(), review_context: publicReviewContextV1Schema.optional(), review_strength: publicReviewStrengthV1Schema.optional(), presentation: humanPresentationV1Schema.optional(), dispatch_failure: publicDispatchFailureV1Schema.optional(), repositories: z.array(repositoryStatusV1Schema).optional(), config_change: z.array(configChangeEntryV1Schema).optional() }).strict() as unknown as z.ZodType<WorkflowViewV1>;

export const semanticErrorSummaryV1Schema = z.object({
  code: nonBlank.max(128),
  message: nonBlank.max(4096),
  retryable: z.boolean(),
}).strict() as unknown as z.ZodType<SemanticErrorSummaryV1>;

export const semanticSuccessV1Schema = z.object({ schema_version: z.literal("1"), ok: z.literal(true), value: workflowViewV1Schema }).strict() as unknown as z.ZodType<SemanticSuccessV1>;
export const semanticFailureV1Schema = z.object({ schema_version: z.literal("1"), ok: z.literal(false), error: semanticErrorSummaryV1Schema, view: workflowViewV1Schema.optional() }).strict() as unknown as z.ZodType<SemanticFailureV1>;
export const semanticResultV1Schema = z.union([semanticSuccessV1Schema, semanticFailureV1Schema]) as unknown as z.ZodType<SemanticResultV1>;



const humanRevisionDeclarationV1Schema = z.object({ classification: z.enum(["simple", "significant"]), rationale: boundedText, user_override: z.object({ agent_classification: z.enum(["simple", "significant"]), rationale: boundedText }).strict().optional() }).strict().superRefine((revision, context) => {
  if (revision.user_override?.agent_classification === revision.classification) context.addIssue({ code: "custom", path: ["user_override", "agent_classification"], message: "an override must change the classification" });
});
const implementationDeclaredInputV1Schema = z.object({ input_id: nonBlank, path: nonBlank }).strict();
const implementationRepositoryFactsV1Schema = z.object({
  name: workflowRepositoryNameV1Schema,
  base_commit: nonBlank,
  outputs: z.array(nonBlank),
  restore_targets: z.array(nonBlank),
  declared_inputs: z.array(implementationDeclaredInputV1Schema),
}).strict();
const implementationFactsV1Schema = z.object({
  base_commit: nonBlank,
  outputs: z.array(nonBlank).min(1),
  restore_targets: z.array(nonBlank),
  declared_inputs: z.array(implementationDeclaredInputV1Schema),
  repositories: z.array(implementationRepositoryFactsV1Schema).optional(),
}).strict();
// A parentless clone, for the same reason as mcp-tools' `overrideRoute`: the shared instance is
// registered as `config#/$defs/route`, and the advertised catalogue carries no config document, so
// a cross-document reference to it would be unresolvable there. The clone inlines inside this
// document's `applySubmission` def instead.
const overrideRoute = configRouteSchema.clone(configRouteSchema.def) as z.ZodType<ModelRouteV1>;
const routeOverrideDeclarationV1Schema = z.object({
  reason: boundedText,
  "counter-reviewer": overrideRoute.optional(),
  "test-reviewer": overrideRoute.optional(),
  adjudicator: overrideRoute.optional(),
}).strict().superRefine((override, context) => {
  if (override["counter-reviewer"] === undefined && override["test-reviewer"] === undefined && override.adjudicator === undefined) {
    context.addIssue({ code: "custom", message: "route_override must name counter-reviewer, test-reviewer, adjudicator, or a combination" });
  }
});
export const applySubmissionV1Schema = z.union([
  z.object({ kind: z.literal("task-ask"), text: boundedText }).strict(),
  z.object({ kind: z.literal("reopening-request"), request: boundedText }).strict(),
  z.object({ kind: z.literal("work-result"), outcome: z.literal("succeeded"), implementation: implementationFactsV1Schema.optional(), human_revision: humanRevisionDeclarationV1Schema.optional() }).strict(),
  z.object({ kind: z.literal("work-result"), outcome: z.literal("failed"), reason: boundedText }).strict(),
  z.object({ kind: z.literal("triage"), dispositions: z.array(triageDispositionV1Schema) }).strict(),
  z.object({ kind: z.literal("gate-summary"), summary: boundedText }).strict(),
  z.object({ kind: z.literal("decision"), choice: nonBlank, reason: boundedText, option_rationale: boundedText.optional() }).strict(),
  z.object({ kind: z.literal("review-dispatch"), route_override: routeOverrideDeclarationV1Schema }).strict(),
]) as unknown as z.ZodType<ApplySubmissionV1>;

/** Plain object root; all variants are nested below `invocation` and `action.submission`. */
export const archFlowApplyInputV1Schema = z.object({ schema_version: z.literal("1"), task_id: taskSlugV1Schema, invocation: workflowInvocationV1Schema, action: z.object({ offer: z.string().regex(/^af1_[0-9a-f]{64}$/u), submission: applySubmissionV1Schema.optional() }).strict() }).strict().superRefine((input, context) => {
  const submission = input.action.submission;
  if (
    (input.invocation.skill === "archflow-prd" || input.invocation.skill === "archflow-design") &&
    submission?.kind === "review-dispatch" &&
    submission.route_override["test-reviewer"] !== undefined
  ) {
    context.addIssue({
      code: "custom",
      path: ["action", "submission", "route_override", "test-reviewer"],
      message: "test-reviewer overrides are available only for phase design and phase implementation",
    });
  }
}) as unknown as z.ZodType<ArchFlowApplyInputV1>;
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
export const parseSemanticResultV1 = (value: unknown): SemanticResultV1 => parseMaterialized(semanticResultV1Schema, value, "semantic result");

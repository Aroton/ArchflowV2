import { isDeepStrictEqual } from "node:util";

import { z } from "zod";

import type { GitOid } from "./canonical.js";
import { canonicalJsonDigest, gitOidV1Schema } from "./canonical.js";
import type { Sha256Digest } from "./evidence.js";
import { pathSafeIdV1Schema, taskSlugV1Schema, type PathSafeId, type SafeInteger, type TaskSlug } from "./evidence.js";
import { safeIdV1Schema } from "./evidence.js";
import { assertPlainJson } from "./plain-json.js";
import { decodePhaseInstance, phaseInstanceIdV1Schema, type PhaseInstanceId } from "./phase-instance.js";
import { repositoryPathClaimV1Schema, taskPathClaimV1Schema, type PathClass, type RepositoryPathClaim, type TaskPathClaim } from "./path-claims.js";
import { PIPELINE_STEPS, type PipelineStep } from "./vocabulary.js";
import { REPOSITORY_NAME_MESSAGE, REPOSITORY_NAME_PATTERN, type RepositoryName } from "./config.js";
// Document-local instance of the shared repository-name vocabulary.
export const gateRepositoryNameV1Schema = z.string().regex(REPOSITORY_NAME_PATTERN, REPOSITORY_NAME_MESSAGE);

export type RuleVersionRef = { readonly rule_id: string; readonly rule_version: number };
export type EvidenceIdentityKind = "prd" | "architecture" | "phase-design" | "implementation-result" | "review" | "adjudication" | "constitution" | "workflow" | "import";
export type EvidenceIdentityRef = { readonly kind: EvidenceIdentityKind; readonly digest: Sha256Digest };
export type ValidationOverrideRequestV1 = { readonly displaced_validations: readonly string[] };
export const REVIEW_PUSH_THROUGH_MIN_ATTEMPT = 2 as const;
export type ReviewAcceptedOccurrenceV1 = {
  readonly review_evidence_digest: Sha256Digest;
  readonly finding_id: string;
};
export type ReviewPushThroughContextV1 = {
  readonly minimum_attempt: typeof REVIEW_PUSH_THROUGH_MIN_ATTEMPT;
  readonly current_evidence_set_digest: Sha256Digest;
  readonly triage_result_digest: Sha256Digest;
  readonly accepted_occurrences: readonly ReviewAcceptedOccurrenceV1[];
};
/**
 * The axis of a constitution verdict a waiver covers. Compliance ("did the subject violate this
 * rule") and trigger ("does this rule's review_trigger condition apply here") are separate
 * judgments about the same rule, so a waiver must name which one it exempts. These are no longer
 * gate kinds: both axes are decided at one `constitution-review` gate.
 */
export type WaivableOperation = "review-trigger" | "adjudication-failure";
export type WaiverScope = { readonly operation: WaivableOperation; readonly boundary: "subject" | "phase" | "task" };
/** One rule the human may waive, and the axis that waiver would cover. */
export type EligibleWaiver = { readonly rule: RuleVersionRef; readonly scope: WaiverScope };
export type DesignPolicyFinding = RuleVersionRef & {
  readonly compliance: "pass" | "fail" | "uncertain";
  readonly rationale: string;
  readonly trigger: "not-matched" | "matched" | "uncertain";
  readonly trigger_evidence: string;
};

export type ApprovalRuleSettlementRef = {
  readonly subject_digest: Sha256Digest;
  readonly config_digest: Sha256Digest;
  readonly settled_at_revision: number;
};
export type ApprovalRuleConclusion =
  | { readonly wait: false; readonly match: null }
  | {
    readonly wait: true;
    readonly match:
      | { readonly kind: "subject"; readonly subject: "prd" | "design" | "phase-design" | "phase-impl" }
      | { readonly kind: "content"; readonly paths: readonly string[] };
  };
export type RuleSettlementApprovalTrigger = {
  readonly kind: "rule-settlement";
  readonly settlement: ApprovalRuleSettlementRef;
  readonly conclusion: ApprovalRuleConclusion;
  readonly rule_authority: "authenticated" | "unavailable";
};
export type HumanRevisionReapprovalTrigger = {
  readonly kind: "human-revision-reapproval";
  readonly prior_gate: {
    readonly gate_id: PathSafeId;
    readonly decision_digest: Sha256Digest;
    readonly class: "configured-approval" | "exception";
  };
  readonly revision_checkpoint: {
    readonly classification: "simple";
    readonly predecessor_subject_digest: Sha256Digest;
    readonly subject_digest: Sha256Digest;
  };
};
export type ApprovalTrigger = RuleSettlementApprovalTrigger | HumanRevisionReapprovalTrigger;

type OrdinaryPolicyContext = {
  readonly constitution: "pass" | "fail" | "uncertain";
  readonly policy_findings: readonly DesignPolicyFinding[];
  readonly eligible_waivers: readonly EligibleWaiver[];
  readonly approval_trigger: ApprovalTrigger;
};

type WaiverRequestedDecision = {
  readonly decision: "waiver-requested";
  readonly reason: string;
  readonly rule: RuleVersionRef;
  readonly operation: WaivableOperation;
  readonly rationale: string;
};

export type SecondaryCommitAuthorizationV1 = {
  readonly repository: RepositoryName;
  readonly repository_identity_digest: Sha256Digest;
  readonly target_ref: string;
  readonly target_head: GitOid;
  readonly baseline_commit: GitOid;
  readonly commit_message: string;
  readonly paths: readonly RepositoryPathClaim[];
  readonly diff_digest: Sha256Digest;
  readonly snapshot_digest: Sha256Digest;
};

export type LegacyArtifactApprovalContextV1 = {
  readonly artifact_kind: "prd" | "design" | "phase-design" | "phase-implementation";
};
export type LegacyDesignApprovalContextV1 = Omit<GateContractByKind["design-approval"]["context"], "approval_trigger">;
export type LegacyExactCommitAuthorizationContextV1 = Omit<
  GateContractByKind["commit-authorization"]["context"],
  "constitution" | "policy_findings" | "eligible_waivers" | "approval_trigger"
>;
export type ArchivedPreExactCommitAuthorizationContextV1 = Omit<
  LegacyExactCommitAuthorizationContextV1,
  "baseline_commit" | "commit_message" | "paths"
>;

export type HumanDecisionProvenance =
  | Readonly<{ schema_version: "1"; actor_class: "human" | "archforge"; assurance: "declared-local-trace"; channel: "connected-host"; decision_event_id: string; connection_id: string; request_id_digest: Sha256Digest; recorded_at: string }>
  | Readonly<{ schema_version: "1"; actor_class: "human" | "archforge"; assurance: "declared-local-trace"; channel: "archflow-local"; decision_event_id: string; helper_invocation_id: string; recorded_at: string }>;

export type AuthorityLinkRef = {
  readonly link_digest: Sha256Digest;
  readonly purpose: "restore-adoption";
  readonly proposed_generation_digest: Sha256Digest;
  readonly changed_input_fingerprint: Sha256Digest;
}

export type GateContractByKind = {
  readonly "artifact-approval": { readonly context: OrdinaryPolicyContext & { readonly artifact_kind: "prd" | "design" | "phase-design" | "phase-implementation" }; readonly decision: { readonly decision: "approve" | "revise" | "reject"; readonly reason: string } | WaiverRequestedDecision };
  /** One final design decision that includes any constitution findings and authorizes its milestone commit. */
  readonly "design-approval": { readonly context: {
    readonly artifact_kind: "design" | "phase-design";
    readonly constitution: "pass" | "fail" | "uncertain";
    readonly policy_findings: readonly DesignPolicyFinding[];
    readonly eligible_waivers: readonly EligibleWaiver[];
    readonly approval_trigger: ApprovalTrigger;
    readonly target_ref: string;
    readonly baseline_commit: GitOid;
    readonly commit_message: string;
  }; readonly decision:
    | { readonly decision: "approve" | "revise" | "reject"; readonly reason: string }
    | WaiverRequestedDecision };
  /**
   * One human decision per constitution review. Compliance and trigger are separate judgments that
   * frequently share a root cause, so the gate discloses both axes at once rather than asking twice
   * about one rule; `eligible_waivers` names each rule the human may waive and on which axis.
   */
  readonly "constitution-review": { readonly context: { readonly constitution: "pass" | "fail" | "uncertain"; readonly failed_rules: readonly RuleVersionRef[]; readonly uncertain_rules: readonly RuleVersionRef[]; readonly matched_trigger_rules: readonly RuleVersionRef[]; readonly uncertain_trigger_rules: readonly RuleVersionRef[]; readonly eligible_waivers: readonly EligibleWaiver[] }; readonly decision: { readonly decision: "approve" | "revise" | "reject"; readonly reason: string } | { readonly decision: "waiver-requested"; readonly reason: string; readonly rule: RuleVersionRef; readonly operation: WaivableOperation; readonly rationale: string } };
  readonly "material-drift": { readonly context: { readonly affected_upstream: EvidenceIdentityRef; readonly drift: "material"; readonly affected_claim_ids: readonly string[] }; readonly decision: { readonly decision: "amend-upstream" | "revise-current" | "reject"; readonly reason: string } };
  readonly "attempts-exhausted": { readonly context: { readonly step: PipelineStep; readonly attempts: number; readonly maximum_attempts: number; readonly review_push_through?: ReviewPushThroughContextV1 }; readonly decision: { readonly decision: "retry-once" | "revise" | "abort" | "push-through-review"; readonly reason: string } };
  readonly "validation-override": { readonly context: {
    readonly request_revision: SafeInteger;
    readonly input_fingerprint: Sha256Digest;
    readonly governing_phase_design_digest: Sha256Digest;
    readonly displaced_validations: readonly string[];
    readonly producer_reason: string;
  }; readonly decision: { readonly decision: "grant-validation-override" | "deny-validation-override"; readonly reason: string } };
  readonly "constitution-edit": { readonly context: { readonly pinned_constitution_digest: Sha256Digest; readonly current_constitution_digest: Sha256Digest; readonly changed_path_class: "task-branch-constitution" }; readonly decision: { readonly decision: "revert-edit" | "start-base-amendment" | "abort"; readonly reason: string } };
  readonly "commit-authorization": { readonly context: OrdinaryPolicyContext & { readonly target_ref: string; readonly baseline_commit: GitOid; readonly commit_message: string; readonly paths: readonly RepositoryPathClaim[]; readonly diff_digest: Sha256Digest; readonly current_artifact_digests: readonly Sha256Digest[]; readonly parent_document_digests: readonly Sha256Digest[]; readonly secondary_commits?: readonly SecondaryCommitAuthorizationV1[] }; readonly decision: { readonly decision: "authorize-commit" | "revise" | "abort"; readonly reason: string } | WaiverRequestedDecision };
  readonly "restore-collision": { readonly context: { readonly path: TaskPathClaim; readonly recorded_generation_digest: Sha256Digest; readonly current_generation_digest: Sha256Digest; readonly adoption_candidate?: AuthorityLinkRef }; readonly decision: { readonly decision: "discard-and-restore" | "abort"; readonly reason: string } | { readonly decision: "adopt-as-new-generation"; readonly reason: string; readonly adoption_authority: AuthorityLinkRef; readonly rationale: string } };
  /**
   * One projection whose recorded review bytes no longer match the worktree. Binding both digests
   * pins the exact byte set the human decision covers: the adoption records `observed_digest`, the
   * restore rewrites to `recorded_digest`, and neither can be re-pointed at other bytes.
   */
  readonly "baseline-adoption": { readonly context: {
    readonly drifted_projections: readonly BaselineDriftedProjection[];
    /** Absent on archives written before deletion adoption existed; fresh contexts always carry it. */
    readonly deleted_projections?: readonly BaselineDeletedProjection[];
    /**
     * Present together on newly composed requests. The target head is the disclosed continuity
     * anchor; `uncommitted_paths` is the complete committedness classification for the drift set.
     * Legacy archives omit the whole trio and remain readable.
     */
    readonly target_ref?: string;
    readonly target_head?: GitOid;
    readonly uncommitted_paths?: readonly RepositoryPathClaim[];
    readonly secondary_targets?: readonly SecondaryBaselineAdoptionTargetV1[];
  }; readonly decision: { readonly decision: "adopt-current-bytes" | "restore-recorded-bytes" | "adopt-committed-deletions" | "abort"; readonly reason: string } };
  readonly "migration-audit": { readonly context: { readonly source_identity_digest: Sha256Digest; readonly destination_identity_digest: Sha256Digest; readonly import_digest: Sha256Digest; readonly code_baseline_digest: Sha256Digest; readonly policy_baseline_digest: Sha256Digest; readonly resume_phase?: PhaseInstanceId; readonly planned_final_phase?: number; readonly imported_documents?: readonly { readonly path: RepositoryPathClaim; readonly content_digest: Sha256Digest }[]; readonly target_ref?: string; readonly baseline_commit?: GitOid; readonly commit_message?: string }; readonly decision: { readonly decision: "accept-import-audit" | "revise" | "abort"; readonly reason: string } };
}

export const GATE_KINDS = ["artifact-approval", "design-approval", "constitution-review", "material-drift", "attempts-exhausted", "validation-override", "constitution-edit", "commit-authorization", "restore-collision", "baseline-adoption", "migration-audit"] as const;
export type GateKind = keyof GateContractByKind;
export type GateContext<K extends GateKind> = GateContractByKind[K]["context"];
export type GateDecisionPayload<K extends GateKind> = GateContractByKind[K]["decision"];
export type GateEffect = "advance" | "retry" | "redirect-waiver" | "redirect-upstream" | "validation-resume" | "non-advancing";

export type BaselineDriftedProjection = {
  readonly path: RepositoryPathClaim;
  /** Digest the newest retained projection records for this path. */
  readonly recorded_digest: Sha256Digest;
  /** Digest of the live bytes the human is asked to judge; always differs from `recorded_digest`. */
  readonly observed_digest: Sha256Digest;
};

/**
 * One projection whose recorded bytes outlive the file itself: the worktree copy is gone and the
 * deletion is already committed, so there are no live bytes to adopt and (when the newest record
 * is an adoption) no retained bytes to restore. Binding the recorded digest pins exactly which
 * claimed presence the human decision retires.
 */
export type BaselineDeletedProjection = {
  readonly path: RepositoryPathClaim;
  /** Digest the newest retained projection still records for this path. */
  readonly recorded_digest: Sha256Digest;
};

export type SecondaryBaselineAdoptionTargetV1 = {
  readonly repository: RepositoryName;
  readonly repository_identity_digest: Sha256Digest;
  readonly target_ref: string;
  readonly target_head: GitOid;
  readonly drifted_projections: readonly BaselineDriftedProjection[];
  readonly deleted_projections?: readonly BaselineDeletedProjection[];
  readonly uncommitted_paths: readonly RepositoryPathClaim[];
};

/**
 * The `current_evidence` of a `baseline-adoption` gate. Every other gate kind opens after a
 * counter-review exists and cites that evidence set; baseline adoption can open mid-pipeline,
 * before any review of the current phase, so the observation the human decides on is the drift
 * set itself — bound to the task, phase, and state revision it was measured at.
 */
export type BaselineObservationRef = Readonly<{
  readonly schema_version: "1";
  readonly observation_kind: "projection-drift";
  readonly task_id: TaskSlug;
  readonly phase_instance: PhaseInstanceId;
  /** The state revision at which the drift was measured live. */
  readonly observed_at_revision: SafeInteger;
  /** Domain-separated digest of the drifted-projection list; equals the gate's `subject_digest`. */
  readonly drift_digest: Sha256Digest;
}>;

/** Authenticated request evidence for a validation-override gate; it is not review evidence. */
export type ValidationOverrideRequestRefV1 = {
  readonly schema_version: "1";
  readonly evidence_kind: "validation-override-request";
  readonly task_id: TaskSlug;
  readonly phase_instance: PhaseInstanceId;
  readonly input_fingerprint: Sha256Digest;
  readonly governing_phase_design_digest: Sha256Digest;
  readonly request_revision: SafeInteger;
  readonly validation_request_subject_digest: Sha256Digest;
};

export type ValidationOverrideSubjectV1 = {
  readonly task_id: TaskSlug;
  readonly phase_instance: PhaseInstanceId;
  readonly input_fingerprint: Sha256Digest;
  readonly governing_phase_design_digest: Sha256Digest;
  readonly displaced_validations: readonly string[];
};

export type GateDecisionEnvelopeBase = { readonly schema_version: "1"; readonly gate_id: PathSafeId; readonly task_id: TaskSlug; readonly phase_instance: PhaseInstanceId; readonly subject_digest: Sha256Digest; readonly context_digest: Sha256Digest; readonly human_provenance: HumanDecisionProvenance };
export type GateDecisionEnvelope<K extends GateKind = GateKind> = { readonly [P in K]: GateDecisionEnvelopeBase & { readonly kind: P; readonly payload: GateDecisionPayload<P> } }[K];

/** Exact archived origin binding consumed by the later waiver owner. */
export type WaiverOriginRef = {
  readonly origin_gate_id: PathSafeId;
  readonly origin_decision_digest: Sha256Digest;
  readonly origin_context_digest: Sha256Digest;
  readonly task_id: TaskSlug;
  readonly phase_instance: PhaseInstanceId;
  readonly subject_digest: Sha256Digest;
  readonly current_evidence_set_digest: Sha256Digest;
  readonly rule: RuleVersionRef;
  readonly scope: WaiverScope;
}

const safeId = safeIdV1Schema;
// Mirrors the canonical review finding-id grammar without importing the review subsystem.
const reviewFindingId = z.string().regex(/^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/u);
const boundedText = z.string().min(1).max(4096).regex(/\S/u);
const digest = z.string().regex(/^[0-9a-f]{64}$/u);
const safeInteger = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
const rule = z.object({ rule_id: safeId, rule_version: z.number().int().positive().max(Number.MAX_SAFE_INTEGER) }).strict();
const waiverScope = z.object({ operation: z.enum(["review-trigger", "adjudication-failure"]), boundary: z.enum(["subject", "phase", "task"]) }).strict();
const eligibleWaiver = z.object({ rule, scope: waiverScope }).strict();
const authorityLink = z.object({ link_digest: digest, purpose: z.literal("restore-adoption"), proposed_generation_digest: digest, changed_input_fingerprint: digest }).strict();
const reason = boundedText;
const decision = <T extends readonly [string, ...string[]]>(values: T) => z.object({ decision: z.enum(values), reason }).strict();
const sortedUnique = <T>(items: readonly T[], compare: (left: T, right: T) => number): boolean => items.every((item, index) => index === 0 || compare(items[index - 1]!, item) < 0);
export const displacedValidationsV1Schema = z.array(z.string().min(1).max(1024).regex(/\S/u)).min(1).max(32)
  .superRefine((items, context) => {
    if (!sortedUnique(items, (left, right) => left.localeCompare(right))) {
      context.addIssue({ code: "custom", message: "displaced validations must be localeCompare-sorted with no duplicates" });
    }
  });
export const validationOverrideRequestV1Schema = z.object({
  displaced_validations: displacedValidationsV1Schema,
}).strict() as unknown as z.ZodType<ValidationOverrideRequestV1>;
export const reviewAcceptedOccurrenceV1Schema = z.object({
  review_evidence_digest: digest,
  finding_id: reviewFindingId,
}).strict() as unknown as z.ZodType<ReviewAcceptedOccurrenceV1>;
const compareReviewAcceptedOccurrences = (left: ReviewAcceptedOccurrenceV1, right: ReviewAcceptedOccurrenceV1): number =>
  left.review_evidence_digest.localeCompare(right.review_evidence_digest) || left.finding_id.localeCompare(right.finding_id);
export const reviewAcceptedOccurrencesV1Schema = z.array(reviewAcceptedOccurrenceV1Schema).min(1)
  .superRefine((items, context) => {
    if (!sortedUnique(items, compareReviewAcceptedOccurrences)) {
      context.addIssue({ code: "custom", message: "accepted occurrences must be localeCompare-sorted with no duplicates" });
    }
  });
export const reviewPushThroughContextV1Schema = z.object({
  minimum_attempt: z.literal(REVIEW_PUSH_THROUGH_MIN_ATTEMPT),
  current_evidence_set_digest: digest,
  triage_result_digest: digest,
  accepted_occurrences: reviewAcceptedOccurrencesV1Schema,
}).strict() as unknown as z.ZodType<ReviewPushThroughContextV1>;
const compareRules = (left: RuleVersionRef, right: RuleVersionRef): number => left.rule_id.localeCompare(right.rule_id) || left.rule_version - right.rule_version;
const canonicalRules = z.array(rule).superRefine((items, context) => { if (!sortedUnique(items, compareRules)) context.addIssue({ code: "custom", message: "rules must be sorted and unique" }); });
const compareEligibleWaivers = (left: EligibleWaiver, right: EligibleWaiver): number => compareRules(left.rule, right.rule) || left.scope.operation.localeCompare(right.scope.operation);
const canonicalEligibleWaivers = z.array(eligibleWaiver).superRefine((items, context) => { if (!sortedUnique(items, compareEligibleWaivers)) context.addIssue({ code: "custom", message: "eligible waivers must be sorted and unique by rule and operation" }); });
const canonicalStrings = z.array(safeId).superRefine((items, context) => { if (!sortedUnique(items, (a, b) => a.localeCompare(b))) context.addIssue({ code: "custom", message: "values must be sorted and unique" }); });
const canonicalDigests = z.array(digest).superRefine((items, context) => { if (!sortedUnique(items, (a, b) => a.localeCompare(b))) context.addIssue({ code: "custom", message: "digests must be sorted and unique" }); });
const designPolicyFinding = rule.extend({
  compliance: z.enum(["pass", "fail", "uncertain"]),
  rationale: boundedText,
  trigger: z.enum(["not-matched", "matched", "uncertain"]),
  trigger_evidence: boundedText,
}).strict();
const canonicalDesignPolicyFindings = z.array(designPolicyFinding).superRefine((items, context) => {
  if (!sortedUnique(items, (a, b) => compareRules(a, b))) context.addIssue({ code: "custom", message: "policy findings must be sorted and unique by rule" });
});

const ruleSettlementMatch = z.union([
  z.object({ kind: z.literal("subject"), subject: z.enum(["prd", "design", "phase-design", "phase-impl"]) }).strict(),
  z.object({
    kind: z.literal("content"),
    paths: z.array(z.string()).superRefine((items, context) => {
      if (!sortedUnique(items, (left, right) => left.localeCompare(right))) context.addIssue({ code: "custom", message: "content match paths must be sorted with no duplicates" });
    }),
    secondary_paths: z.array(z.object({
      repository: gateRepositoryNameV1Schema,
      paths: z.array(z.string()).min(1).superRefine((items, context) => {
        if (!sortedUnique(items, (left, right) => left.localeCompare(right))) context.addIssue({ code: "custom", message: "secondary content paths must be sorted with no duplicates" });
      }),
    }).strict()).superRefine((items, context) => {
      if (!sortedUnique(items, (left, right) => left.repository.localeCompare(right.repository))) context.addIssue({ code: "custom", message: "secondary_paths must be sorted by repository with no duplicates" });
    }).optional(),
  }).strict().superRefine((match, context) => {
    if (match.paths.length === 0 && (match.secondary_paths?.length ?? 0) === 0) context.addIssue({ code: "custom", message: "content match must contain at least one primary or secondary path" });
  }),
]);
const approvalRuleConclusion = z.discriminatedUnion("wait", [
  z.object({ wait: z.literal(false), match: z.null() }).strict(),
  z.object({ wait: z.literal(true), match: ruleSettlementMatch }).strict(),
]);
const approvalTrigger = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("rule-settlement"),
    settlement: z.object({ subject_digest: digest, config_digest: digest, settled_at_revision: z.number().int().min(1).max(Number.MAX_SAFE_INTEGER) }).strict(),
    conclusion: approvalRuleConclusion,
    rule_authority: z.enum(["authenticated", "unavailable"]),
  }).strict(),
  z.object({
    kind: z.literal("human-revision-reapproval"),
    prior_gate: z.object({ gate_id: pathSafeIdV1Schema, decision_digest: digest, class: z.enum(["configured-approval", "exception"]) }).strict(),
    revision_checkpoint: z.object({ classification: z.literal("simple"), predecessor_subject_digest: digest, subject_digest: digest }).strict(),
  }).strict(),
]);

const ordinaryPolicyFields = {
  constitution: z.enum(["pass", "fail", "uncertain"]),
  policy_findings: canonicalDesignPolicyFindings,
  eligible_waivers: canonicalEligibleWaivers,
  approval_trigger: approvalTrigger,
} as const;

function validateOrdinaryPolicyContext(
  value: Readonly<{ constitution: "pass" | "fail" | "uncertain"; policy_findings: readonly DesignPolicyFinding[]; eligible_waivers: readonly EligibleWaiver[] }>,
  context: z.core.$RefinementCtx,
): void {
  const compliance = new Set(value.policy_findings.filter((item) => item.compliance !== "pass").map(ruleKey));
  const trigger = new Set(value.policy_findings.filter((item) => item.trigger !== "not-matched").map(ruleKey));
  const expected = value.policy_findings.some((item) => item.compliance === "fail")
    ? "fail"
    : value.policy_findings.some((item) => item.compliance === "uncertain") ? "uncertain" : "pass";
  if (value.constitution !== expected) context.addIssue({ code: "custom", message: `constitution must be ${expected}` });
  for (const item of value.eligible_waivers) {
    const available = item.scope.operation === "adjudication-failure" ? compliance : trigger;
    if (!available.has(ruleKey(item.rule))) context.addIssue({ code: "custom", message: "eligible waiver must name a policy finding on the selected axis" });
  }
}

export const legacyArtifactApprovalContextSchema = z.object({ artifact_kind: z.enum(["prd", "design", "phase-design", "phase-implementation"]) }).strict();
export const legacyDesignApprovalContextSchema = z.object({
  artifact_kind: z.enum(["design", "phase-design"]),
  constitution: z.enum(["pass", "fail", "uncertain"]),
  policy_findings: canonicalDesignPolicyFindings,
  eligible_waivers: canonicalEligibleWaivers,
  target_ref: boundedText,
  baseline_commit: gitOidV1Schema,
  commit_message: boundedText,
}).strict().superRefine(validateOrdinaryPolicyContext);
export const legacyExactCommitAuthorizationContextSchema = z.object({
  target_ref: boundedText,
  baseline_commit: gitOidV1Schema,
  commit_message: boundedText,
  paths: z.array(repositoryPathClaimV1Schema).min(1)
    .refine((items) => sortedUnique(items, (a, b) => (a < b ? -1 : a > b ? 1 : 0)) || sortedUnique(items, (a, b) => a.localeCompare(b)), "paths must be sorted with no duplicates"),
  diff_digest: digest,
  current_artifact_digests: canonicalDigests.min(1),
  parent_document_digests: canonicalDigests.min(1),
}).strict();
export const archivedPreExactCommitAuthorizationContextSchema = legacyExactCommitAuthorizationContextSchema.omit({ baseline_commit: true, commit_message: true, paths: true });
export const legacyAttemptsExhaustedContextSchema = z.object({
  step: z.enum(PIPELINE_STEPS),
  attempts: safeInteger,
  maximum_attempts: safeInteger,
}).strict().refine((value) => value.attempts >= value.maximum_attempts, "attempts must be at least maximum_attempts");
export const reviewPushThroughAttemptsExhaustedContextSchema = z.object({
  step: z.enum(PIPELINE_STEPS),
  attempts: safeInteger,
  maximum_attempts: safeInteger,
  review_push_through: reviewPushThroughContextV1Schema,
}).strict().superRefine((value, context) => {
  if (value.attempts < value.maximum_attempts) context.addIssue({ code: "custom", path: ["attempts"], message: "attempts must be at least maximum_attempts" });
  if (value.attempts < value.review_push_through.minimum_attempt) {
    context.addIssue({ code: "custom", path: ["review_push_through", "minimum_attempt"], message: "attempts must meet the review push-through minimum" });
  }
});

const contexts = {
  "artifact-approval": z.object({ artifact_kind: z.enum(["prd", "design", "phase-design", "phase-implementation"]), ...ordinaryPolicyFields }).strict().superRefine(validateOrdinaryPolicyContext),
  "design-approval": z.object({
    artifact_kind: z.enum(["design", "phase-design"]),
    ...ordinaryPolicyFields,
    target_ref: boundedText,
    baseline_commit: gitOidV1Schema,
    commit_message: boundedText,
  }).strict().superRefine(validateOrdinaryPolicyContext),
  "constitution-review": z.object({ constitution: z.enum(["pass", "fail", "uncertain"]), failed_rules: canonicalRules, uncertain_rules: canonicalRules, matched_trigger_rules: canonicalRules, uncertain_trigger_rules: canonicalRules, eligible_waivers: canonicalEligibleWaivers }).strict().superRefine((value, context) => {
    const compliance = new Set([...value.failed_rules, ...value.uncertain_rules].map(ruleKey));
    const trigger = new Set([...value.matched_trigger_rules, ...value.uncertain_trigger_rules].map(ruleKey));
    // The gate exists to carry a question; one with nothing to decide must never open.
    if (compliance.size === 0 && trigger.size === 0) context.addIssue({ code: "custom", message: "constitution review must identify a rule" });
    if ((value.constitution === "pass") !== (compliance.size === 0)) context.addIssue({ code: "custom", message: "constitution must be pass exactly when no rule failed or is uncertain" });
    for (const item of value.eligible_waivers) {
      const available = item.scope.operation === "adjudication-failure" ? compliance : trigger;
      if (!available.has(ruleKey(item.rule))) context.addIssue({ code: "custom", message: "eligible waiver must name a rule on the axis its operation covers" });
    }
  }),
  "material-drift": z.object({ affected_upstream: z.object({ kind: z.enum(["prd", "architecture", "phase-design", "implementation-result", "review", "adjudication", "constitution", "workflow", "import"]), digest }).strict(), drift: z.literal("material"), affected_claim_ids: canonicalStrings.min(1) }).strict(),
  "attempts-exhausted": z.object({ step: z.enum(PIPELINE_STEPS), attempts: safeInteger, maximum_attempts: safeInteger, review_push_through: reviewPushThroughContextV1Schema.optional() }).strict().superRefine((value, context) => {
    if (value.attempts < value.maximum_attempts) context.addIssue({ code: "custom", path: ["attempts"], message: "attempts must be at least maximum_attempts" });
    if (value.review_push_through !== undefined && value.attempts < value.review_push_through.minimum_attempt) {
      context.addIssue({ code: "custom", path: ["review_push_through", "minimum_attempt"], message: "attempts must meet the review push-through minimum" });
    }
  }),
  "validation-override": z.object({
    request_revision: z.number().int().min(1).max(Number.MAX_SAFE_INTEGER),
    input_fingerprint: digest,
    governing_phase_design_digest: digest,
    displaced_validations: displacedValidationsV1Schema,
    producer_reason: boundedText,
  }).strict(),
  "constitution-edit": z.object({ pinned_constitution_digest: digest, current_constitution_digest: digest, changed_path_class: z.literal("task-branch-constitution" satisfies PathClass) }).strict(),
  "commit-authorization": z.object({
    ...ordinaryPolicyFields,
    target_ref: boundedText,
    baseline_commit: gitOidV1Schema,
    commit_message: boundedText,
    paths: z.array(repositoryPathClaimV1Schema).min(1)
      // Either ascending order — code-unit or localeCompare — with uniqueness. Composers emit
      // code-unit (the rule every other sorted-path contract applies), but commit-authorization
      // archives written by the previous bundle store locale-ordered lists; requiring one order
      // would strand those archives and block every gate that authenticates them. Rewriting the
      // archives would break their digest pinning, so both orders parse until the legacy
      // archives age out.
      .refine((items) => sortedUnique(items, (a, b) => (a < b ? -1 : a > b ? 1 : 0)) || sortedUnique(items, (a, b) => a.localeCompare(b)), "paths must be sorted with no duplicates"),
    diff_digest: digest,
    current_artifact_digests: canonicalDigests.min(1),
    parent_document_digests: canonicalDigests.min(1),
    secondary_commits: z.array(z.object({
      repository: gateRepositoryNameV1Schema,
      repository_identity_digest: digest,
      target_ref: boundedText,
      target_head: gitOidV1Schema,
      baseline_commit: gitOidV1Schema,
      commit_message: boundedText,
      paths: z.array(repositoryPathClaimV1Schema).min(1)
        .refine((items) => sortedUnique(items, (a, b) => a < b ? -1 : a > b ? 1 : 0), "paths must be sorted with no duplicates"),
      diff_digest: digest,
      snapshot_digest: digest,
    }).strict()).refine((items) => sortedUnique(items, (a, b) => a.repository < b.repository ? -1 : a.repository > b.repository ? 1 : 0), "secondary_commits must be sorted by repository with no duplicates").optional(),
  }).strict().superRefine(validateOrdinaryPolicyContext),
  "restore-collision": z.object({ path: taskPathClaimV1Schema, recorded_generation_digest: digest, current_generation_digest: digest, adoption_candidate: authorityLink.optional() }).strict(),
  "baseline-adoption": z.object({
    drifted_projections: z.array(z.object({ path: repositoryPathClaimV1Schema, recorded_digest: digest, observed_digest: digest }).strict(),
      ),
    // Optional, not defaulted: archives written before deletion adoption existed carry no such
    // field, and the published contract must describe those archives as valid — a JSON Schema
    // `default` is an annotation, so a required-but-defaulted field would retroactively reject
    // decisions a human already made.
    deleted_projections: z.array(z.object({ path: repositoryPathClaimV1Schema, recorded_digest: digest }).strict()).optional(),
    target_ref: boundedText.optional(),
    target_head: gitOidV1Schema.optional(),
    uncommitted_paths: z.array(repositoryPathClaimV1Schema).optional(),
    secondary_targets: z.array(z.object({
      repository: gateRepositoryNameV1Schema,
      repository_identity_digest: digest,
      target_ref: boundedText,
      target_head: gitOidV1Schema,
      drifted_projections: z.array(z.object({ path: repositoryPathClaimV1Schema, recorded_digest: digest, observed_digest: digest }).strict()),
      deleted_projections: z.array(z.object({ path: repositoryPathClaimV1Schema, recorded_digest: digest }).strict()).optional(),
      uncommitted_paths: z.array(repositoryPathClaimV1Schema),
    }).strict().superRefine((target, targetContext) => {
      const deleted = target.deleted_projections ?? [];
      if (!sortedUnique(target.drifted_projections, (left, right) => left.path.localeCompare(right.path))) targetContext.addIssue({ code: "custom", path: ["drifted_projections"], message: "drifted projections must be sorted by path with no duplicates" });
      if (target.drifted_projections.some((item) => item.recorded_digest === item.observed_digest)) targetContext.addIssue({ code: "custom", path: ["drifted_projections"], message: "a drifted projection must differ between its recorded and observed digests" });
      if (!sortedUnique(deleted, (left, right) => left.path.localeCompare(right.path))) targetContext.addIssue({ code: "custom", path: ["deleted_projections"], message: "deleted projections must be sorted by path with no duplicates" });
      if (!sortedUnique(target.uncommitted_paths, (left, right) => left.localeCompare(right))) targetContext.addIssue({ code: "custom", path: ["uncommitted_paths"], message: "uncommitted paths must be sorted with no duplicates" });
      if (target.drifted_projections.length === 0 && deleted.length === 0) targetContext.addIssue({ code: "custom", message: "a secondary baseline target must name drifted or deleted projections" });
      if (target.uncommitted_paths.some((path) => !target.drifted_projections.some((entry) => entry.path === path) && !deleted.some((entry) => entry.path === path))) targetContext.addIssue({ code: "custom", path: ["uncommitted_paths"], message: "uncommitted paths must belong to the target drift set" });
    })).refine((items) => sortedUnique(items, (left, right) => left.repository < right.repository ? -1 : left.repository > right.repository ? 1 : 0), "secondary_targets must be sorted by repository with no duplicates").optional(),
  }).strict().superRefine((value, context) => {
    const deleted = value.deleted_projections ?? [];
    if (!sortedUnique(value.drifted_projections, (left, right) => left.path.localeCompare(right.path))) context.addIssue({ code: "custom", message: "drifted projections must be sorted by path with no duplicates" });
    if (value.drifted_projections.some((item) => item.recorded_digest === item.observed_digest)) context.addIssue({ code: "custom", message: "a drifted projection must differ between its recorded and observed digests" });
    const targetFacts = [value.target_ref, value.target_head, value.uncommitted_paths];
    if (targetFacts.some((item) => item !== undefined) && targetFacts.some((item) => item === undefined)) {
      context.addIssue({ code: "custom", path: ["target_ref"], message: "baseline target ref, head, and uncommitted paths must be written together" });
    }
    if (value.uncommitted_paths !== undefined &&
        !sortedUnique(value.uncommitted_paths, (left, right) => left.localeCompare(right))) {
      context.addIssue({ code: "custom", path: ["uncommitted_paths"], message: "uncommitted paths must be sorted with no duplicates" });
    }
    if (value.uncommitted_paths?.some((path) =>
      !value.drifted_projections.some((entry) => entry.path === path) &&
      !deleted.some((entry) => entry.path === path))) {
      context.addIssue({ code: "custom", path: ["uncommitted_paths"], message: "uncommitted paths must belong to the complete drift set" });
    }
    if (!sortedUnique(deleted, (left, right) => left.path.localeCompare(right.path))) context.addIssue({ code: "custom", message: "deleted projections must be sorted by path with no duplicates" });
    if (value.drifted_projections.length === 0 && deleted.length === 0 && (value.secondary_targets?.length ?? 0) === 0) context.addIssue({ code: "custom", message: "a baseline adoption must name at least one drifted or deleted projection" });
    const driftedPaths = new Set(value.drifted_projections.map((item) => item.path));
    if (deleted.some((item) => driftedPaths.has(item.path))) context.addIssue({ code: "custom", message: "a projection cannot be both drifted and deleted" });
  }),
  "migration-audit": z.object({
    source_identity_digest: digest,
    destination_identity_digest: digest,
    import_digest: digest,
    code_baseline_digest: digest,
    policy_baseline_digest: digest,
    resume_phase: phaseInstanceIdV1Schema.optional(),
    planned_final_phase: safeInteger.optional(),
    imported_documents: z.array(z.object({ path: repositoryPathClaimV1Schema, content_digest: digest }).strict()).optional(),
    target_ref: boundedText.optional(),
    baseline_commit: gitOidV1Schema.optional(),
    commit_message: boundedText.optional(),
  }).strict(),
} as const;

/**
 * A commit-authorization context as it may appear in the archive: the current shape, or the one
 * written before `baseline_commit`, `commit_message` and `paths` became required. The retired arm
 * is derived by omission from the current schema so the two cannot drift — every surviving field
 * keeps its exact current constraints, and because the source is `.strict()` the retired arm
 * rejects the three fields outright rather than making them optional. Read-only: new requests are
 * still composed and validated against `contexts["commit-authorization"]`.
 */
export const archivedCommitAuthorizationContextSchema = z.union([
  contexts["commit-authorization"],
  legacyExactCommitAuthorizationContextSchema,
  archivedPreExactCommitAuthorizationContextSchema,
]);

/** `contexts`, with strict explicit compatibility arms for the retired ordinary-gate shapes. */
const archivedContexts = {
  ...contexts,
  "artifact-approval": z.union([contexts["artifact-approval"], legacyArtifactApprovalContextSchema]),
  "design-approval": z.union([contexts["design-approval"], legacyDesignApprovalContextSchema]),
  "commit-authorization": archivedCommitAuthorizationContextSchema,
} as const;

const decisions = {
  "artifact-approval": z.union([decision(["approve", "revise", "reject"]), z.object({ decision: z.literal("waiver-requested"), reason, rule, operation: z.enum(["review-trigger", "adjudication-failure"]), rationale: boundedText }).strict()]),
  "design-approval": z.union([decision(["approve", "revise", "reject"]), z.object({ decision: z.literal("waiver-requested"), reason, rule, operation: z.enum(["review-trigger", "adjudication-failure"]), rationale: boundedText }).strict()]),
  "constitution-review": z.union([decision(["approve", "revise", "reject"]), z.object({ decision: z.literal("waiver-requested"), reason, rule, operation: z.enum(["review-trigger", "adjudication-failure"]), rationale: boundedText }).strict()]),
  "material-drift": decision(["amend-upstream", "revise-current", "reject"]),
  "attempts-exhausted": decision(["retry-once", "revise", "abort", "push-through-review"]),
  "validation-override": decision(["grant-validation-override", "deny-validation-override"]),
  "constitution-edit": decision(["revert-edit", "start-base-amendment", "abort"]),
  "commit-authorization": z.union([decision(["authorize-commit", "revise", "abort"]), z.object({ decision: z.literal("waiver-requested"), reason, rule, operation: z.enum(["review-trigger", "adjudication-failure"]), rationale: boundedText }).strict()]),
  "restore-collision": z.union([decision(["discard-and-restore", "abort"]), z.object({ decision: z.literal("adopt-as-new-generation"), reason, adoption_authority: authorityLink, rationale: boundedText }).strict()]),
  "baseline-adoption": decision(["adopt-current-bytes", "restore-recorded-bytes", "adopt-committed-deletions", "abort"]),
  "migration-audit": decision(["accept-import-audit", "revise", "abort"]),
} as const;

const effects = Object.freeze({
  approve: "advance", revise: "retry", reject: "non-advancing", "waiver-requested": "redirect-waiver", "amend-upstream": "redirect-upstream", "revise-current": "retry", "retry-once": "retry", abort: "non-advancing", "push-through-review": "advance", "grant-validation-override": "validation-resume", "deny-validation-override": "validation-resume", "revert-edit": "retry", "start-base-amendment": "redirect-upstream", "authorize-commit": "advance", "discard-and-restore": "advance", "adopt-as-new-generation": "advance", "adopt-current-bytes": "advance", "restore-recorded-bytes": "advance", "adopt-committed-deletions": "advance", "accept-import-audit": "advance",
} as const satisfies Readonly<Record<GateDecisionPayload<GateKind>["decision"], GateEffect>>);

export const GATE_CONTRACTS = Object.freeze(Object.fromEntries(GATE_KINDS.map((kind) => [kind, Object.freeze({ context: contexts[kind], decision: decisions[kind] })]))) as Readonly<{ [K in GateKind]: { readonly context: (typeof contexts)[K]; readonly decision: (typeof decisions)[K] } }>;

const connectedProvenance = z.object({ schema_version: z.literal("1"), actor_class: z.enum(["human", "archforge"]), assurance: z.literal("declared-local-trace"), channel: z.literal("connected-host"), decision_event_id: safeId, connection_id: safeId, request_id_digest: digest, recorded_at: z.string().datetime({ offset: false, local: false, precision: 3 }) }).strict();
const localProvenance = z.object({ schema_version: z.literal("1"), actor_class: z.enum(["human", "archforge"]), assurance: z.literal("declared-local-trace"), channel: z.literal("archflow-local"), decision_event_id: safeId, helper_invocation_id: safeId, recorded_at: z.string().datetime({ offset: false, local: false, precision: 3 }) }).strict();
export const humanDecisionProvenanceV1Schema = z.union([connectedProvenance, localProvenance]);

/**
 * The `gate-decision.schema.json` `$defs` the generator emits, keyed by committed def name.
 * `mcp-tools.schema.json` reaches `connected` and `local` by `$ref`, so both names are pinned.
 */
export const gateDecisionSchemaDefs: Readonly<Record<string, z.ZodType>> = Object.freeze({
  connected: connectedProvenance,
  local: localProvenance,
});
const envelopeBase = { schema_version: z.literal("1"), gate_id: pathSafeIdV1Schema, task_id: taskSlugV1Schema, phase_instance: z.string().regex(/^(?:prd|design|phase-(?:design|impl)-[1-9][0-9]*)$/u).refine((value) => { try { decodePhaseInstance(value); return true; } catch { return false; } }), subject_digest: digest, context_digest: digest, human_provenance: z.union([connectedProvenance, localProvenance]) } as const;

export const baselineObservationRefV1Schema = z.object({
  schema_version: z.literal("1"),
  observation_kind: z.literal("projection-drift"),
  task_id: taskSlugV1Schema,
  phase_instance: phaseInstanceIdV1Schema,
  observed_at_revision: z.number().int().min(1).max(Number.MAX_SAFE_INTEGER),
  drift_digest: digest,
}).strict();

export const validationOverrideRequestRefV1Schema = z.object({
  schema_version: z.literal("1"),
  evidence_kind: z.literal("validation-override-request"),
  task_id: taskSlugV1Schema,
  phase_instance: phaseInstanceIdV1Schema,
  input_fingerprint: digest,
  governing_phase_design_digest: digest,
  request_revision: z.number().int().min(1).max(Number.MAX_SAFE_INTEGER),
  validation_request_subject_digest: digest,
}).strict() as unknown as z.ZodType<ValidationOverrideRequestRefV1>;

export function parseBaselineObservationRef(value: unknown): BaselineObservationRef {
  assertPlainJson(value, "baseline observation reference");
  return baselineObservationRefV1Schema.parse(value) as BaselineObservationRef;
}

export function validationOverrideSubjectDigest(value: ValidationOverrideSubjectV1): Sha256Digest {
  assertPlainJson(value, "validation override subject");
  const subject = z.object({
    task_id: taskSlugV1Schema,
    phase_instance: phaseInstanceIdV1Schema,
    input_fingerprint: digest,
    governing_phase_design_digest: digest,
    displaced_validations: displacedValidationsV1Schema,
  }).strict().parse(structuredClone(value));
  return canonicalJsonDigest({ schema_version: "1", digest_kind: "validation-override-subject", ...subject });
}

export function parseValidationOverrideRequestRef(value: unknown): ValidationOverrideRequestRefV1 {
  assertPlainJson(value, "validation override request reference");
  return validationOverrideRequestRefV1Schema.parse(value);
}

const contractArms = Object.fromEntries(GATE_KINDS.map((kind) => [
  kind,
  z.object({ kind: z.literal(kind), context: contexts[kind], payload: decisions[kind] }).strict(),
])) as unknown as Readonly<Record<GateKind, z.ZodType>>;

export const gateContractV1Schema = z.discriminatedUnion("kind", GATE_KINDS.map((kind) => contractArms[kind]) as unknown as [z.ZodObject, ...z.ZodObject[]]);

/**
 * The `gate-contract.schema.json` `$defs` the generator emits, keyed by committed def name. The
 * per-kind arms keep the pinned `<arm>/properties/context` pointer paths `mcp-tools.schema.json`
 * reaches into; the context and decision entries name the shared objects other gate documents
 * embed, so their emissions become `$ref`s instead of inline copies.
 */
export const gateContractSchemaDefs: Readonly<Record<string, z.ZodType>> = Object.freeze({
  // `canonicalDigests` stays unregistered: both uses derive `.min(1)` from it, and a derivation of
  // a registered def emits as a bare `$ref` plus `minItems`, which Ajv strict mode rejects.
  digest, text: boundedText, safeInteger, rule, rules: canonicalRules,
  repositoryName: gateRepositoryNameV1Schema,
  waiverScope, eligibleWaiver, eligibleWaivers: canonicalEligibleWaivers, authorityLink,
  approvalTrigger,
  artifactApprovalContext: contexts["artifact-approval"],
  designApprovalContext: contexts["design-approval"],
  constitutionReviewContext: contexts["constitution-review"],
  materialDriftContext: contexts["material-drift"],
  attemptsExhaustedContext: contexts["attempts-exhausted"],
  validationOverrideContext: contexts["validation-override"],
  constitutionEditContext: contexts["constitution-edit"],
  commitAuthorizationContext: contexts["commit-authorization"],
  restoreCollisionContext: contexts["restore-collision"],
  baselineAdoptionContext: contexts["baseline-adoption"],
  migrationAuditContext: contexts["migration-audit"],
  artifactApprovalDecision: decisions["artifact-approval"],
  designApprovalDecision: decisions["design-approval"],
  constitutionReviewDecision: decisions["constitution-review"],
  materialDriftDecision: decisions["material-drift"],
  attemptsExhaustedDecision: decisions["attempts-exhausted"],
  validationOverrideDecision: decisions["validation-override"],
  constitutionEditDecision: decisions["constitution-edit"],
  commitAuthorizationDecision: decisions["commit-authorization"],
  restoreCollisionDecision: decisions["restore-collision"],
  baselineAdoptionDecision: decisions["baseline-adoption"],
  migrationAuditDecision: decisions["migration-audit"],
  artifactApproval: contractArms["artifact-approval"],
  designApproval: contractArms["design-approval"],
  constitutionReview: contractArms["constitution-review"],
  materialDrift: contractArms["material-drift"],
  attemptsExhausted: contractArms["attempts-exhausted"],
  validationOverride: contractArms["validation-override"],
  constitutionEdit: contractArms["constitution-edit"],
  commitAuthorization: contractArms["commit-authorization"],
  restoreCollision: contractArms["restore-collision"],
  baselineAdoption: contractArms["baseline-adoption"],
  migrationAudit: contractArms["migration-audit"],
});

/** The shared rule and waiver-scope objects the archived gate documents embed by reference. */
export const gateRuleVersionRefSchema = rule;
export const gateWaiverScopeSchema = waiverScope;

export const gateDecisionEnvelopeV1Schema = z.discriminatedUnion("kind", [
  z.object({ ...envelopeBase, kind: z.literal("artifact-approval"), payload: decisions["artifact-approval"] }).strict(),
  z.object({ ...envelopeBase, kind: z.literal("design-approval"), payload: decisions["design-approval"] }).strict(),
  z.object({ ...envelopeBase, kind: z.literal("constitution-review"), payload: decisions["constitution-review"] }).strict(),
  z.object({ ...envelopeBase, kind: z.literal("material-drift"), payload: decisions["material-drift"] }).strict(),
  z.object({ ...envelopeBase, kind: z.literal("attempts-exhausted"), payload: decisions["attempts-exhausted"] }).strict(),
  z.object({ ...envelopeBase, kind: z.literal("validation-override"), payload: decisions["validation-override"] }).strict(),
  z.object({ ...envelopeBase, kind: z.literal("constitution-edit"), payload: decisions["constitution-edit"] }).strict(),
  z.object({ ...envelopeBase, kind: z.literal("commit-authorization"), payload: decisions["commit-authorization"] }).strict(),
  z.object({ ...envelopeBase, kind: z.literal("restore-collision"), payload: decisions["restore-collision"] }).strict(),
  z.object({ ...envelopeBase, kind: z.literal("baseline-adoption"), payload: decisions["baseline-adoption"] }).strict(),
  z.object({ ...envelopeBase, kind: z.literal("migration-audit"), payload: decisions["migration-audit"] }).strict(),
]);

function ruleKey(value: RuleVersionRef): string { return `${value.rule_id}:${value.rule_version}`; }

export function parseGateContext<K extends GateKind>(kind: K, value: unknown): GateContext<K> {
  assertPlainJson(value, `${kind} gate context`);
  return contexts[kind].parse(value) as GateContext<K>;
}

export function parseGateDecisionEnvelope(value: unknown): GateDecisionEnvelope {
  assertPlainJson(value, "gate decision envelope");
  const parsed = gateDecisionEnvelopeV1Schema.parse(value) as GateDecisionEnvelope;
  if (parsed.kind === "restore-collision" && parsed.payload.decision === "adopt-as-new-generation") return parsed;
  return parsed;
}

export function parseGateContract(value: unknown): Readonly<{ [K in GateKind]: { readonly kind: K; readonly context: GateContext<K>; readonly payload: GateDecisionPayload<K> } }[GateKind]> {
  assertPlainJson(value, "gate contract");
  const parsed = gateContractV1Schema.parse(value) as Readonly<{ [K in GateKind]: { readonly kind: K; readonly context: GateContext<K>; readonly payload: GateDecisionPayload<K> } }[GateKind]>;
  validateGateDecision(parsed.kind, parsed.context, parsed.payload);
  return parsed;
}

function validateDecisionAgainst<K extends GateKind>(
  contextSchemas: typeof contexts | typeof archivedContexts,
  kind: K,
  context: GateContext<K>,
  payload: GateDecisionPayload<K>,
): GateDecisionPayload<K> {
  assertPlainJson(context, `${kind} gate context`);
  contextSchemas[kind].parse(context);
  assertPlainJson(payload, `${kind} gate decision`);
  const parsed = decisions[kind].parse(payload) as GateDecisionPayload<K>;
  if ((kind === "artifact-approval" || kind === "design-approval" || kind === "constitution-review" || kind === "commit-authorization") && parsed.decision === "waiver-requested") {
    // A waiver names both a rule and the axis it exempts, so both must be offered by the gate.
    const eligible = (context as GateContext<"artifact-approval"> | GateContext<"design-approval"> | GateContext<"constitution-review"> | GateContext<"commit-authorization">).eligible_waivers;
    if (!eligible.some((item) => ruleKey(item.rule) === ruleKey(parsed.rule) && item.scope.operation === parsed.operation)) throw new TypeError("waiver-requested rule and operation must be eligible");
  }
  if (kind === "restore-collision" && parsed.decision === "adopt-as-new-generation") {
    const candidate = (context as GateContext<"restore-collision">).adoption_candidate;
    const adoptionPayload = parsed as Extract<GateDecisionPayload<"restore-collision">, { decision: "adopt-as-new-generation" }>;
    if (candidate === undefined || !isDeepStrictEqual(candidate, adoptionPayload.adoption_authority)) throw new TypeError("restore adoption authority must exactly match the context candidate");
  }
  if (kind === "attempts-exhausted" && parsed.decision === "push-through-review" &&
      (context as GateContext<"attempts-exhausted">).review_push_through === undefined) {
    throw new TypeError("push-through-review requires authenticated review push-through context");
  }
  return parsed;
}

export function validateGateDecision<K extends GateKind>(kind: K, context: GateContext<K>, payload: GateDecisionPayload<K>): GateDecisionPayload<K> {
  return validateDecisionAgainst(contexts, kind, context, payload);
}

/**
 * `validateGateDecision` for a request read out of the archive: identical except that a
 * commit-authorization context predating `baseline_commit`/`commit_message`/`paths` is accepted.
 * Live gate paths must keep using `validateGateDecision`.
 */
export function validateArchivedGateDecision<K extends GateKind>(kind: K, context: GateContext<K>, payload: GateDecisionPayload<K>): GateDecisionPayload<K> {
  return validateDecisionAgainst(archivedContexts, kind, context, payload);
}

export function gateDecisionEffect(payload: GateDecisionPayload<GateKind>): GateEffect { return effects[payload.decision]; }

import { z } from "zod";

import { gitOidV1Schema, type GitOid } from "./canonical.js";
import { REPOSITORY_NAME_MESSAGE, REPOSITORY_NAME_PATTERN } from "./config.js";
import type { ReferencedEvidence, Sha256Digest, TaskSlug } from "./evidence.js";
import { createTaskSlugV1Schema } from "./evidence.js";
import { assertPlainJson } from "./plain-json.js";
import { effortEvidenceSchema, type EffortEvidence } from "./effort-review.js";

export const CLAIM_TYPES = ["defect", "risk", "gap", "preference"] as const;
export const CONFIDENCE_LEVELS = ["certain", "likely", "suspicion"] as const;
export const REVIEW_VERDICTS = ["pass", "advisory", "review-raised"] as const;
export const LEGACY_REVIEW_VERDICTS = ["pass", "advisory", "fail"] as const;
export const REVIEW_ROLES = ["counter-review"] as const;
export const LEGACY_REVIEW_FINDING_SEVERITIES = ["blocker", "major", "minor"] as const;
/** @deprecated Read compatibility for archived V1 review records only. */
export const REVIEW_FINDING_SEVERITIES = LEGACY_REVIEW_FINDING_SEVERITIES;
export const MODEL_FAMILIES = ["claude", "codex", "gemini"] as const;
export const ADAPTER_IDS = ["claude-cli", "codex-cli", "antigravity-cli"] as const;
export const EFFORT_VALUES = ["low", "medium", "high", "xhigh", "max", "ultra"] as const;

export type ReviewVerdict = (typeof REVIEW_VERDICTS)[number];
export type LegacyReviewVerdict = (typeof LEGACY_REVIEW_VERDICTS)[number];
export type ReviewRole = (typeof REVIEW_ROLES)[number];
export type ClaimType = (typeof CLAIM_TYPES)[number];
export type ConfidenceLevel = (typeof CONFIDENCE_LEVELS)[number];
export type LegacyReviewFindingSeverity = (typeof LEGACY_REVIEW_FINDING_SEVERITIES)[number];
/** @deprecated Read compatibility for archived V1 review records only. */
export type ReviewFindingSeverity = LegacyReviewFindingSeverity;
export type ModelFamily = (typeof MODEL_FAMILIES)[number];
export type AdapterId = (typeof ADAPTER_IDS)[number];
export type DeclaredEffort = (typeof EFFORT_VALUES)[number] | "unknown";

/** One repository snapshot whose exact identity and commit were observed by the server. */
export type ReviewedRepositoryV1 = {
  readonly name: string;
  readonly repository_identity_digest: Sha256Digest;
  readonly commit: GitOid;
};

export type RuleVersionRef = {
  readonly rule_id: string;
  readonly rule_version: number;
};

export type ReviewFindingV2 = {
  readonly finding_id: string;
  readonly claim_type: ClaimType;
  readonly confidence: ConfidenceLevel;
  readonly falsifier: string;
  readonly summary: string;
  readonly evidence: string;
  readonly suggested_resolution: string;
};

export type RawGeneralReviewFindingV3 = ReviewFindingV2 & {
  readonly criterion_id: string;
};

export type RawTestReviewFindingV3 = {
  readonly finding_id: string;
  readonly criterion_id: string;
  readonly claim_type: ClaimType;
  readonly confidence: ConfidenceLevel;
  readonly falsifier: string;
  readonly required_behavior_or_risk_boundary: string;
  readonly coverage_or_oracle_problem: string;
  readonly consequence: string;
  readonly proposed_verification_change: string;
};

export type ReviewFindingAttributionV3 = {
  readonly reviewer_id: string;
  readonly reviewer_focus: (typeof REVIEW_RUN_FOCUSES)[number];
  readonly routing_role: (typeof REVIEW_RUN_ROLES)[number];
};

export type GeneralReviewFindingV3 = RawGeneralReviewFindingV3 & ReviewFindingAttributionV3 & {
  readonly reviewer_focus: "general";
  readonly routing_role: "counter-reviewer";
};

export type TestReviewFindingV3 = RawTestReviewFindingV3 & ReviewFindingAttributionV3 & {
  readonly reviewer_focus: "tests";
  readonly routing_role: "test-reviewer";
};

export type ReviewFindingV3 = GeneralReviewFindingV3 | TestReviewFindingV3;

export type UpstreamAlignmentV1 = {
  readonly upstream_digest: Sha256Digest;
  readonly drift: "aligned" | "incidental" | "material";
  readonly affected_claim_ids: readonly string[];
  readonly rationale: string;
};

export type LegacyConfirmationAssignmentV1 = {
  readonly finding_id: string;
  readonly criterion_ids: readonly string[];
};

export type ResolvedLegacyConfirmationV1 = {
  readonly finding_id: string;
  readonly status: "resolved";
  readonly evidence: string;
};

export type UnresolvedGeneralLegacyConfirmationV1 = Omit<RawGeneralReviewFindingV3, "finding_id"> & {
  readonly finding_id: string;
  readonly status: "unresolved";
};

export type UnresolvedTestLegacyConfirmationV1 = Omit<RawTestReviewFindingV3, "finding_id"> & {
  readonly finding_id: string;
  readonly status: "unresolved";
};

export type GeneralLegacyConfirmationV1 = ResolvedLegacyConfirmationV1 | UnresolvedGeneralLegacyConfirmationV1;
export type TestLegacyConfirmationV1 = ResolvedLegacyConfirmationV1 | UnresolvedTestLegacyConfirmationV1;

export type ReviewOutputSchemaOptionsV3 = {
  readonly criterion_ids: readonly string[];
  /** Presence grants the primary alignment responsibility; an empty array is meaningful. */
  readonly expected_upstream_digests?: readonly Sha256Digest[];
  /** Present only for bounded re-checks of accepted criterion-less archive findings. */
  readonly legacy_confirmations?: readonly LegacyConfirmationAssignmentV1[];
};

export type FindingPartitionCounts = Readonly<Record<`${ClaimType}:${ConfidenceLevel}`, number>>;

export type LegacyReviewFinding = {
  readonly finding_id: string;
  readonly severity: LegacyReviewFindingSeverity;
  readonly blocking: boolean;
  readonly summary: string;
  readonly evidence: string;
  readonly suggested_resolution: string;
};

export type RawReviewV1 = {
  readonly schema_version: "1";
  readonly task_id: TaskSlug;
  readonly phase_instance: string;
  readonly step: "counter_review";
  readonly role: ReviewRole;
  readonly subject_digest: Sha256Digest;
  readonly input_fingerprint: Sha256Digest;
  readonly rubric_digest: Sha256Digest;
  readonly producer_family: ModelFamily;
  readonly findings: readonly LegacyReviewFinding[];
  readonly matched_rule_versions: readonly RuleVersionRef[];
  readonly verdict: LegacyReviewVerdict;
  readonly blocking_count: number;
};

export type RawReviewV2 = {
  readonly schema_version: "2";
  readonly task_id: TaskSlug;
  readonly phase_instance: string;
  readonly step: "counter_review";
  readonly role: ReviewRole;
  readonly subject_digest: Sha256Digest;
  readonly input_fingerprint: Sha256Digest;
  readonly rubric_digest: Sha256Digest;
  readonly producer_family: ModelFamily;
  readonly findings: readonly ReviewFindingV2[];
  readonly matched_rule_versions: readonly RuleVersionRef[];
  readonly verdict: ReviewVerdict;
  readonly total_findings: number;
  readonly partition_counts: FindingPartitionCounts;
};

type RawReviewV3Base = {
  readonly schema_version: "3";
  readonly task_id: TaskSlug;
  readonly phase_instance: string;
  readonly step: "counter_review";
  readonly role: ReviewRole;
  readonly subject_digest: Sha256Digest;
  readonly input_fingerprint: Sha256Digest;
  readonly rubric_digest: Sha256Digest;
  readonly producer_family: ModelFamily;
};

export type RawGeneralReviewV3 = RawReviewV3Base & {
  readonly findings: readonly RawGeneralReviewFindingV3[];
  readonly upstream_alignment?: readonly UpstreamAlignmentV1[];
  readonly legacy_confirmations?: readonly GeneralLegacyConfirmationV1[];
};

export type RawTestReviewV3 = RawReviewV3Base & {
  readonly findings: readonly RawTestReviewFindingV3[];
  readonly legacy_confirmations?: readonly TestLegacyConfirmationV1[];
};

/** Fresh child output. Summary values are deliberately absent and are minted by the server. */
export type ChildReviewOutputV2 = Omit<RawReviewV2, "schema_version" | "verdict" | "total_findings" | "partition_counts">;

export type RawReview = RawReviewV1 | RawReviewV2;
export type ReviewFinding = ReviewFindingV2;

/** Semantically checked review data. This type intentionally carries no authority brand. */
export type DerivedReview = RawReview;

const nonBlank = z.string().min(1).regex(/\S/, "must contain a non-whitespace character");
const boundedNonBlank = z.string().min(1).max(4096).regex(/\S/, "must contain a non-whitespace character");
const id = z.string().regex(/^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/u);
const digest = z.string().regex(/^[0-9a-f]{64}$/u) as unknown as z.ZodType<Sha256Digest>;
const taskSlug = createTaskSlugV1Schema();
const phaseInstance = z.string().regex(/^(?:prd|design|phase-(?:design|impl)-[1-9][0-9]*)$/u);
const safePositive = z.number().int().positive().safe();
const safeCount = z.number().int().min(0).max(Number.MAX_SAFE_INTEGER);

const repositoryName = z.union([
  z.literal("primary"),
  z.string().regex(REPOSITORY_NAME_PATTERN, REPOSITORY_NAME_MESSAGE),
]);
export const reviewedRepositoryV1Schema = z.object({
  name: repositoryName,
  repository_identity_digest: digest,
  commit: gitOidV1Schema,
}).strict();

function validateReviewedRepositories(repositories: readonly ReviewedRepositoryV1[]): void {
  if (repositories.length === 0 || repositories[0]?.name !== "primary") {
    throw new TypeError("reviewed repositories must begin with primary");
  }
  const names = repositories.map((repository) => repository.name);
  if (new Set(names).size !== names.length || names.some((name, index) => index > 1 && names[index - 1]! >= name)) {
    throw new TypeError("reviewed repositories must contain unique names sorted after primary");
  }
}

export const reviewedRepositoriesV1Schema = z.array(reviewedRepositoryV1Schema).superRefine((repositories, context) => {
  try { validateReviewedRepositories(repositories); }
  catch (error) { context.addIssue({ code: "custom", message: error instanceof Error ? error.message : "invalid reviewed repositories" }); }
});

export function parseReviewedRepositoriesV1(value: unknown): readonly ReviewedRepositoryV1[] {
  assertPlainJson(value, "reviewed repositories");
  return reviewedRepositoriesV1Schema.parse(structuredClone(value)) as readonly ReviewedRepositoryV1[];
}

export const ruleVersionRefSchema = z.object({ rule_id: id, rule_version: safePositive }).strict();
export const legacyReviewFindingV1Schema = z.object({
  finding_id: id,
  severity: z.enum(LEGACY_REVIEW_FINDING_SEVERITIES),
  blocking: z.boolean(),
  summary: nonBlank,
  evidence: nonBlank,
  suggested_resolution: nonBlank,
}).strict().superRefine((finding, context) => {
  if (finding.blocking !== (finding.severity === "blocker")) {
    context.addIssue({ code: "custom", path: ["blocking"], message: "only blocker findings are blocking" });
  }
});

export const reviewFindingV2Schema = z.object({
  finding_id: id,
  claim_type: z.enum(CLAIM_TYPES),
  confidence: z.enum(CONFIDENCE_LEVELS),
  falsifier: boundedNonBlank,
  summary: nonBlank,
  evidence: nonBlank,
  suggested_resolution: nonBlank,
}).strict();

export const rawGeneralReviewFindingV3Schema = reviewFindingV2Schema.safeExtend({
  criterion_id: id,
}).strict();

export const rawTestReviewFindingV3Schema = z.object({
  finding_id: id,
  criterion_id: id,
  claim_type: z.enum(CLAIM_TYPES),
  confidence: z.enum(CONFIDENCE_LEVELS),
  falsifier: boundedNonBlank,
  required_behavior_or_risk_boundary: nonBlank,
  coverage_or_oracle_problem: nonBlank,
  consequence: nonBlank,
  proposed_verification_change: nonBlank,
}).strict();

const upstreamAlignmentV1StructuralSchema = z.object({
  upstream_digest: digest,
  drift: z.enum(["aligned", "incidental", "material"]),
  affected_claim_ids: z.array(id),
  rationale: nonBlank,
}).strict();

export const upstreamAlignmentV1Schema = upstreamAlignmentV1StructuralSchema.superRefine((entry, context) => {
  if ((entry.drift === "aligned") !== (entry.affected_claim_ids.length === 0)) {
    context.addIssue({ code: "custom", path: ["affected_claim_ids"], message: "aligned upstreams have no affected claims; non-aligned upstreams must identify claims" });
  }
  if (new Set(entry.affected_claim_ids).size !== entry.affected_claim_ids.length) {
    context.addIssue({ code: "custom", path: ["affected_claim_ids"], message: "affected claim ids must be unique" });
  }
});

export const legacyConfirmationAssignmentV1Schema = z.object({
  finding_id: id,
  criterion_ids: z.array(id).min(1),
}).strict().superRefine((assignment, context) => {
  if (new Set(assignment.criterion_ids).size !== assignment.criterion_ids.length) {
    context.addIssue({ code: "custom", path: ["criterion_ids"], message: "legacy confirmation criteria must be unique" });
  }
});

/** @deprecated V1 finding parser retained for archived callers. */
export const reviewFindingSchema = legacyReviewFindingV1Schema;

const findingPartitionShape = Object.fromEntries(
  CLAIM_TYPES.flatMap((claimType) => CONFIDENCE_LEVELS.map((confidence) => [`${claimType}:${confidence}`, safeCount])),
) as Record<`${ClaimType}:${ConfidenceLevel}`, typeof safeCount>;
export const findingPartitionCountsSchema = z.object(findingPartitionShape).strict();

const rawReviewCommonShape = {
  task_id: taskSlug,
  phase_instance: phaseInstance,
  step: z.literal("counter_review"),
  role: z.enum(REVIEW_ROLES),
  subject_digest: digest,
  input_fingerprint: digest,
  rubric_digest: digest,
  producer_family: z.enum(MODEL_FAMILIES),
  matched_rule_versions: z.array(ruleVersionRefSchema),
} as const;

const rawReviewV3CommonShape = {
  task_id: taskSlug,
  phase_instance: phaseInstance,
  step: z.literal("counter_review"),
  role: z.enum(REVIEW_ROLES),
  subject_digest: digest,
  input_fingerprint: digest,
  rubric_digest: digest,
  producer_family: z.enum(MODEL_FAMILIES),
} as const;

function exactCriterionSchema(criterionIds: readonly string[]): z.ZodType<string> {
  criterionIds.forEach((criterionId) => id.parse(criterionId));
  if (new Set(criterionIds).size !== criterionIds.length) throw new TypeError("criterion_ids must be unique");
  if (criterionIds.length === 0) return z.never() as unknown as z.ZodType<string>;
  return z.enum(criterionIds as [string, ...string[]]);
}

function generalFindingSchemaFor(criteria: z.ZodType<string>) {
  return z.object({
    finding_id: id,
    criterion_id: criteria,
    claim_type: z.enum(CLAIM_TYPES),
    confidence: z.enum(CONFIDENCE_LEVELS),
    falsifier: boundedNonBlank,
    summary: nonBlank,
    evidence: nonBlank,
    suggested_resolution: nonBlank,
  }).strict();
}

function testFindingSchemaFor(criteria: z.ZodType<string>) {
  return z.object({
    finding_id: id,
    criterion_id: criteria,
    claim_type: z.enum(CLAIM_TYPES),
    confidence: z.enum(CONFIDENCE_LEVELS),
    falsifier: boundedNonBlank,
    required_behavior_or_risk_boundary: nonBlank,
    coverage_or_oracle_problem: nonBlank,
    consequence: nonBlank,
    proposed_verification_change: nonBlank,
  }).strict();
}

function validateOutputSchemaOptions(options: ReviewOutputSchemaOptionsV3): ReviewOutputSchemaOptionsV3 {
  assertPlainJson(options, "review output schema options");
  const materialized = structuredClone(options);
  exactCriterionSchema(materialized.criterion_ids);
  if (materialized.expected_upstream_digests !== undefined) {
    materialized.expected_upstream_digests.forEach((value) => digest.parse(value));
    if (new Set(materialized.expected_upstream_digests).size !== materialized.expected_upstream_digests.length ||
        materialized.expected_upstream_digests.some((value, index) => index > 0 && materialized.expected_upstream_digests![index - 1]! >= value)) {
      throw new TypeError("expected_upstream_digests must be sorted and unique");
    }
  }
  if (materialized.legacy_confirmations !== undefined) {
    if (materialized.legacy_confirmations.length === 0) throw new TypeError("legacy_confirmations must not be empty when present");
    const parsed = z.array(legacyConfirmationAssignmentV1Schema).parse(materialized.legacy_confirmations);
    if (new Set(parsed.map((entry) => entry.finding_id)).size !== parsed.length) throw new TypeError("legacy confirmation finding ids must be unique");
  }
  if (materialized.criterion_ids.length === 0 && materialized.expected_upstream_digests === undefined && materialized.legacy_confirmations === undefined) {
    throw new TypeError("a review output schema requires criteria, alignment, or legacy confirmation responsibility");
  }
  return materialized;
}

function generalLegacyConfirmationSchema(options: ReviewOutputSchemaOptionsV3) {
  const assignments = options.legacy_confirmations;
  if (assignments === undefined) return undefined;
  const findingIds = assignments.map((entry) => entry.finding_id) as [string, ...string[]];
  const criterionIds = [...new Set(assignments.flatMap((entry) => [...entry.criterion_ids]))];
  const findingIdSchema = z.enum(findingIds);
  const resolved = z.object({ finding_id: findingIdSchema, status: z.literal("resolved"), evidence: nonBlank }).strict();
  const unresolved = generalFindingSchemaFor(exactCriterionSchema(criterionIds)).safeExtend({ finding_id: findingIdSchema, status: z.literal("unresolved") }).strict();
  return z.discriminatedUnion("status", [resolved, unresolved]);
}

function testLegacyConfirmationSchema(options: ReviewOutputSchemaOptionsV3) {
  const assignments = options.legacy_confirmations;
  if (assignments === undefined) return undefined;
  const findingIds = assignments.map((entry) => entry.finding_id) as [string, ...string[]];
  const criterionIds = [...new Set(assignments.flatMap((entry) => [...entry.criterion_ids]))];
  const findingIdSchema = z.enum(findingIds);
  const resolved = z.object({ finding_id: findingIdSchema, status: z.literal("resolved"), evidence: nonBlank }).strict();
  const unresolved = testFindingSchemaFor(exactCriterionSchema(criterionIds)).safeExtend({ finding_id: findingIdSchema, status: z.literal("unresolved") }).strict();
  return z.discriminatedUnion("status", [resolved, unresolved]);
}

function validateLegacyConfirmationCoverage(
  confirmations: readonly { readonly finding_id: string; readonly status: "resolved" | "unresolved"; readonly criterion_id?: string }[],
  assignments: readonly LegacyConfirmationAssignmentV1[],
  context: z.RefinementCtx,
): void {
  const expected = assignments.map((entry) => entry.finding_id);
  const actual = confirmations.map((entry) => entry.finding_id);
  if (actual.length !== expected.length || new Set(actual).size !== actual.length || expected.some((value) => !actual.includes(value))) {
    context.addIssue({ code: "custom", path: ["legacy_confirmations"], message: "legacy confirmations must exactly cover assigned findings" });
    return;
  }
  confirmations.forEach((confirmation, index) => {
    if (confirmation.status !== "unresolved") return;
    const assignment = assignments.find((entry) => entry.finding_id === confirmation.finding_id);
    if (assignment === undefined || confirmation.criterion_id === undefined || !assignment.criterion_ids.includes(confirmation.criterion_id)) {
      context.addIssue({ code: "custom", path: ["legacy_confirmations", index, "criterion_id"], message: "legacy confirmation criterion is outside its assignment" });
    }
  });
}

function validateAlignmentCoverage(
  alignment: readonly UpstreamAlignmentV1[],
  expected: readonly Sha256Digest[],
  context: z.RefinementCtx,
): void {
  const actual = alignment.map((entry) => entry.upstream_digest);
  if (actual.length !== expected.length || actual.some((value, index) => value !== expected[index])) {
    context.addIssue({ code: "custom", path: ["upstream_alignment"], message: "upstream alignment must exactly cover expected upstream digests in canonical order" });
  }
}

export function createGeneralReviewOutputV3Schema(options: ReviewOutputSchemaOptionsV3) {
  const materialized = validateOutputSchemaOptions(options);
  const criteria = exactCriterionSchema(materialized.criterion_ids);
  const confirmation = generalLegacyConfirmationSchema(materialized);
  const shape = {
    schema_version: z.literal("3"),
    ...rawReviewV3CommonShape,
    findings: materialized.criterion_ids.length === 0
      ? z.array(rawGeneralReviewFindingV3Schema).max(0)
      : z.array(generalFindingSchemaFor(criteria)),
    ...(materialized.expected_upstream_digests === undefined ? {} : { upstream_alignment: z.array(upstreamAlignmentV1Schema) }),
    ...(confirmation === undefined ? {} : { legacy_confirmations: z.array(confirmation) }),
  } as const;
  return z.object(shape).strict().superRefine((review, context) => {
    const findingIds = review.findings.map((finding) => finding.finding_id);
    if (new Set(findingIds).size !== findingIds.length) context.addIssue({ code: "custom", path: ["findings"], message: "review finding ids must be unique" });
    if (materialized.expected_upstream_digests !== undefined && "upstream_alignment" in review) {
      validateAlignmentCoverage(review.upstream_alignment as readonly UpstreamAlignmentV1[], materialized.expected_upstream_digests, context);
    }
    if (materialized.legacy_confirmations !== undefined && "legacy_confirmations" in review) {
      validateLegacyConfirmationCoverage(review.legacy_confirmations as readonly GeneralLegacyConfirmationV1[], materialized.legacy_confirmations, context);
    }
  }) as unknown as z.ZodType<RawGeneralReviewV3>;
}

export function createTestReviewOutputV3Schema(options: Omit<ReviewOutputSchemaOptionsV3, "expected_upstream_digests">) {
  const materialized = validateOutputSchemaOptions(options);
  const criteria = exactCriterionSchema(materialized.criterion_ids);
  const confirmation = testLegacyConfirmationSchema(materialized);
  const shape = {
    schema_version: z.literal("3"),
    ...rawReviewV3CommonShape,
    findings: materialized.criterion_ids.length === 0
      ? z.array(rawTestReviewFindingV3Schema).max(0)
      : z.array(testFindingSchemaFor(criteria)),
    ...(confirmation === undefined ? {} : { legacy_confirmations: z.array(confirmation) }),
  } as const;
  return z.object(shape).strict().superRefine((review, context) => {
    const findingIds = review.findings.map((finding) => finding.finding_id);
    if (new Set(findingIds).size !== findingIds.length) context.addIssue({ code: "custom", path: ["findings"], message: "review finding ids must be unique" });
    if (materialized.legacy_confirmations !== undefined && "legacy_confirmations" in review) {
      validateLegacyConfirmationCoverage(review.legacy_confirmations as readonly TestLegacyConfirmationV1[], materialized.legacy_confirmations, context);
    }
  }) as unknown as z.ZodType<RawTestReviewV3>;
}

export function parseGeneralReviewOutputV3(value: unknown, options: ReviewOutputSchemaOptionsV3): RawGeneralReviewV3 {
  assertPlainJson(value, "general review output");
  return createGeneralReviewOutputV3Schema(options).parse(structuredClone(value));
}

export function parseTestReviewOutputV3(value: unknown, options: Omit<ReviewOutputSchemaOptionsV3, "expected_upstream_digests">): RawTestReviewV3 {
  assertPlainJson(value, "test review output");
  return createTestReviewOutputV3Schema(options).parse(structuredClone(value));
}

const resolvedLegacyConfirmationV1Schema = z.object({ finding_id: id, status: z.literal("resolved"), evidence: nonBlank }).strict();
const unresolvedGeneralLegacyConfirmationV1Schema = rawGeneralReviewFindingV3Schema.safeExtend({ status: z.literal("unresolved") }).strict();
const unresolvedTestLegacyConfirmationV1Schema = rawTestReviewFindingV3Schema.safeExtend({ status: z.literal("unresolved") }).strict();
const generalLegacyConfirmationV1Schema = z.discriminatedUnion("status", [resolvedLegacyConfirmationV1Schema, unresolvedGeneralLegacyConfirmationV1Schema]);
const testLegacyConfirmationV1Schema = z.discriminatedUnion("status", [resolvedLegacyConfirmationV1Schema, unresolvedTestLegacyConfirmationV1Schema]);

/** Generic publication roots; dispatch replaces criterion/census members with assignment constants. */
export const rawGeneralReviewOutputV3Schema = z.object({
  schema_version: z.literal("3"),
  ...rawReviewV3CommonShape,
  findings: z.array(rawGeneralReviewFindingV3Schema),
  upstream_alignment: z.array(upstreamAlignmentV1Schema).optional(),
  legacy_confirmations: z.array(generalLegacyConfirmationV1Schema).optional(),
}).strict();
export const rawTestReviewOutputV3Schema = z.object({
  schema_version: z.literal("3"),
  ...rawReviewV3CommonShape,
  findings: z.array(rawTestReviewFindingV3Schema),
  legacy_confirmations: z.array(testLegacyConfirmationV1Schema).optional(),
}).strict();
/**
 * Plain-object publication root. Role-specific dispatch never validates against this widened
 * inventory: it uses the two factories above, which close every finding and responsibility to
 * one assignment. Keeping the union below the root preserves host schema transport.
 */
export const rawReviewOutputV3Schema = z.object({
  schema_version: z.literal("3"),
  ...rawReviewV3CommonShape,
  findings: z.array(z.union([rawGeneralReviewFindingV3Schema, rawTestReviewFindingV3Schema])),
  upstream_alignment: z.array(upstreamAlignmentV1Schema).optional(),
  legacy_confirmations: z.array(z.union([generalLegacyConfirmationV1Schema, testLegacyConfirmationV1Schema])).optional(),
}).strict();

function validateUniqueReviewMembers(
  review: { readonly findings: readonly { readonly finding_id: string }[]; readonly matched_rule_versions: readonly RuleVersionRef[] },
  context: z.RefinementCtx,
): void {
  const findingIds = new Set<string>();
  review.findings.forEach((finding, index) => {
    if (findingIds.has(finding.finding_id)) context.addIssue({ code: "custom", path: ["findings", index, "finding_id"], message: "duplicate finding_id" });
    findingIds.add(finding.finding_id);
  });
  const rules = new Set<string>();
  review.matched_rule_versions.forEach((rule, index) => {
    const key = `${rule.rule_id}:${rule.rule_version}`;
    if (rules.has(key)) context.addIssue({ code: "custom", path: ["matched_rule_versions", index], message: "duplicate rule version" });
    rules.add(key);
  });
}

const rawReviewV1StructuralSchema = z.object({
  schema_version: z.literal("1"),
  ...rawReviewCommonShape,
  findings: z.array(legacyReviewFindingV1Schema),
  verdict: z.enum(LEGACY_REVIEW_VERDICTS),
  blocking_count: safeCount,
}).strict();

export const rawReviewV1Schema = rawReviewV1StructuralSchema.superRefine((review, context) => {
  validateUniqueReviewMembers(review, context);
  const expected = expectedLegacyReviewSummary(review.findings);
  if (review.blocking_count !== expected.blocking_count) context.addIssue({ code: "custom", path: ["blocking_count"], message: `review blocking_count must be ${expected.blocking_count}` });
  if (review.verdict !== expected.verdict) context.addIssue({ code: "custom", path: ["verdict"], message: `review verdict must be ${expected.verdict}` });
});

const rawReviewV2StructuralSchema = z.object({
  schema_version: z.literal("2"),
  ...rawReviewCommonShape,
  findings: z.array(reviewFindingV2Schema),
  verdict: z.enum(REVIEW_VERDICTS),
  total_findings: safeCount,
  partition_counts: findingPartitionCountsSchema,
}).strict();

export const rawReviewV2Schema = rawReviewV2StructuralSchema.superRefine((review, context) => {
  validateUniqueReviewMembers(review, context);
  validateV2Summary(review, context);
});

export const childReviewOutputV2Schema = z.object({
  ...rawReviewCommonShape,
  findings: z.array(reviewFindingV2Schema),
}).strict().superRefine(validateUniqueReviewMembers);

export const rawReviewSchema = z.discriminatedUnion("schema_version", [rawReviewV1Schema, rawReviewV2Schema]);

function expectedLegacyReviewSummary(findings: readonly LegacyReviewFinding[]): Readonly<{ blocking_count: number; verdict: LegacyReviewVerdict }> {
  const blocking_count = findings.filter((finding) => finding.blocking).length;
  return { blocking_count, verdict: blocking_count > 0 ? "fail" : findings.length > 0 ? "advisory" : "pass" };
}

export function computeFindingPartitionCounts(findings: readonly (ReviewFindingV2 | ReviewFindingV3)[]): FindingPartitionCounts {
  const counts = Object.fromEntries(
    CLAIM_TYPES.flatMap((claimType) => CONFIDENCE_LEVELS.map((confidence) => [`${claimType}:${confidence}`, 0])),
  ) as Record<`${ClaimType}:${ConfidenceLevel}`, number>;
  for (const finding of findings) counts[`${finding.claim_type}:${finding.confidence}`] += 1;
  return Object.freeze(counts);
}

export function isSubstantiveClaim(finding: ReviewFindingV2 | ReviewFindingV3 | LegacyReviewFinding): boolean {
  if ("claim_type" in finding && typeof finding.claim_type === "string") {
    return finding.claim_type === "defect" || finding.claim_type === "risk" || finding.claim_type === "gap";
  }
  return "blocking" in finding && typeof finding.blocking === "boolean" ? finding.blocking : false;
}

export function expectedReviewSummaryV2(findings: readonly (ReviewFindingV2 | ReviewFindingV3)[]): Readonly<{
  verdict: ReviewVerdict;
  total_findings: number;
  partition_counts: FindingPartitionCounts;
}> {
  return Object.freeze({
    verdict: findings.some(isSubstantiveClaim) ? "review-raised" : findings.length > 0 ? "advisory" : "pass",
    total_findings: findings.length,
    partition_counts: computeFindingPartitionCounts(findings),
  });
}

function validateV2Summary(review: RawReviewV2, context: z.RefinementCtx): void {
  const expected = expectedReviewSummaryV2(review.findings);
  if (review.total_findings !== expected.total_findings) context.addIssue({ code: "custom", path: ["total_findings"], message: `review total_findings must be ${expected.total_findings}` });
  if (review.verdict !== expected.verdict) context.addIssue({ code: "custom", path: ["verdict"], message: `review verdict must be ${expected.verdict}` });
  for (const key of Object.keys(expected.partition_counts) as Array<keyof FindingPartitionCounts>) {
    if (review.partition_counts[key] !== expected.partition_counts[key]) context.addIssue({ code: "custom", path: ["partition_counts", key], message: `review partition count must be ${expected.partition_counts[key]}` });
  }
}

/**
 * The generated `review.schema.json` `$defs` layout. The def names are load-bearing:
 * `projectCliOutputSchema` rewrites `taskSlug` (lookahead simplification) before handing the document to a child host, and the
 * document must stay self-contained because hosts cannot resolve cross-document references.
 */
export const reviewDocumentDefs = {
  id,
  taskSlug,
  digest,
  phaseInstance,
  nonBlank,
  finding: reviewFindingV2Schema,
} as const;

export function parseAndDeriveReview(value: unknown): DerivedReview {
  assertPlainJson(value, "review");
  const parsed = rawReviewSchema.parse(structuredClone(value));
  return parsed as DerivedReview;
}

/**
 * Records that this dispatch ran on a human-authorized substitute route instead of the pinned
 * one. The pinned config is never amended, so without this the deviation would be invisible at
 * the approval gate: `reason` is the human's words, and the pinned fields say what was displaced.
 */
export type RouteOverrideRecord = {
  readonly reason: string;
  // Absent when the config pinned no route for this role at all — the override supplied one that
  // never existed, so there is nothing it displaced.
  readonly pinned_model?: string;
  readonly pinned_effort?: (typeof EFFORT_VALUES)[number];
  readonly pinned_provider?: string;
};

export const ROUTE_SOURCE_PROVENANCES = ["configured", "invocation-declared", "route-override"] as const;
export const DISPLACED_ROUTE_SOURCES = ["configured", "invocation-declared"] as const;

/** Raw route facts displaced by a higher-precedence selection; dispatchability is not implied. */
export type DisplacedRouteRecord = {
  readonly source: (typeof DISPLACED_ROUTE_SOURCES)[number];
  readonly model: string;
  readonly effort: (typeof EFFORT_VALUES)[number];
  readonly provider?: string;
};

/** Truthful source of the route that produced freshly server-attested evidence. */
export type RouteSourceRecord = {
  readonly provenance: (typeof ROUTE_SOURCE_PROVENANCES)[number];
  readonly displaced?: DisplacedRouteRecord;
};

type ReviewProvenanceBaseV1 = RawReviewV1 & {
  readonly model_family: ModelFamily | "unknown";
  readonly model: string;
  readonly effort: DeclaredEffort;
};
type ReviewProvenanceBaseV2 = RawReviewV2 & {
  readonly model_family: ModelFamily | "unknown";
  readonly model: string;
  readonly effort: DeclaredEffort;
};

export const REVIEW_RUN_FOCUSES = ["general", "tests"] as const;
export const REVIEW_RUN_ROLES = ["counter-reviewer", "test-reviewer"] as const;
export type ReviewerRunV1 = {
  readonly reviewer_id: string;
  readonly focus: (typeof REVIEW_RUN_FOCUSES)[number];
  readonly routing_role: (typeof REVIEW_RUN_ROLES)[number];
  readonly criterion_ids: readonly string[];
  readonly rubric_digest: Sha256Digest;
  readonly model_family: ModelFamily;
  readonly model: string;
  readonly effort: Exclude<DeclaredEffort, "unknown">;
  readonly adapter: AdapterId;
  readonly cli_version: string;
  readonly invocation_id: string;
  readonly envelope_input_digest: Sha256Digest;
  readonly observed_output_digest: Sha256Digest;
  readonly finding_ids: readonly string[];
  readonly provider?: string;
  readonly route_source: RouteSourceRecord;
  readonly route_override?: RouteOverrideRecord;
};

/** Fresh reviewer provenance, including the non-rubric responsibilities sealed into its envelope. */
export type ReviewerRunV2 = Omit<ReviewerRunV1, "criterion_ids"> & {
  readonly criterion_ids: readonly string[];
  /** Presence identifies the sole primary alignment owner; an empty plan is meaningful. */
  readonly expected_upstream_digests?: readonly Sha256Digest[];
  readonly legacy_confirmations?: readonly LegacyConfirmationAssignmentV1[];
};

type ServerAttestedReviewFields = {
  readonly assurance: "server-attested";
  readonly adapter: AdapterId;
  readonly cli_version: string;
  readonly model_family: ModelFamily;
  readonly effort: Exclude<DeclaredEffort, "unknown">;
  readonly invocation_id: string;
  readonly envelope_input_digest: Sha256Digest;
  readonly observed_output_digest: Sha256Digest;
  readonly result_id: string;
  /** Optional on read for archived evidence; every fresh server mint supplies it when used. */
  readonly provider?: string;
  /** Optional on read for archived evidence; every fresh server mint supplies it. */
  readonly route_source?: RouteSourceRecord;
  readonly route_override?: RouteOverrideRecord;
  /**
   * Optional on read: evidence archived before repository sets existed (including the durable gate
   * fixtures under `test/fixtures/contracts`) carries no pins, so the schema cannot require it
   * without invalidating those archives. Every fresh server mint supplies it. The pins are display
   * only — status compares them with live HEADs for the human, but a context-only member moving
   * after review never stales the evidence or its gate.
   */
  readonly repositories?: readonly ReviewedRepositoryV1[];
  /** Ordered contributor provenance for fresh multi/specialist reviews; absent on archived evidence. */
  readonly reviewer_runs?: readonly ReviewerRunV1[];
  /** Optional on read for archives; required on fresh phase-design evidence by server policy. */
  readonly effort_review?: EffortEvidence;
};
export type ServerAttestedReviewV1 = Omit<ReviewProvenanceBaseV1, "model_family" | "effort"> & ServerAttestedReviewFields;
export type ServerAttestedReviewV2 = Omit<ReviewProvenanceBaseV2, "model_family" | "effort"> & ServerAttestedReviewFields;
export type ServerAttestedReviewV3 = RawReviewV3Base & {
  readonly findings: readonly ReviewFindingV3[];
  readonly verdict: ReviewVerdict;
  readonly total_findings: number;
  readonly partition_counts: FindingPartitionCounts;
  readonly upstream_alignment?: readonly UpstreamAlignmentV1[];
  readonly drift?: "aligned" | "incidental" | "material";
  readonly assurance: "server-attested";
  readonly adapter: AdapterId;
  readonly cli_version: string;
  readonly model_family: ModelFamily;
  readonly model: string;
  readonly effort: Exclude<DeclaredEffort, "unknown">;
  readonly invocation_id: string;
  readonly envelope_input_digest: Sha256Digest;
  readonly observed_output_digest: Sha256Digest;
  readonly result_id: string;
  readonly provider?: string;
  readonly route_source: RouteSourceRecord;
  readonly route_override?: RouteOverrideRecord;
  readonly repositories: readonly ReviewedRepositoryV1[];
  readonly reviewer_runs: readonly ReviewerRunV2[];
  readonly effort_review?: EffortEvidence;
};
export type ServerAttestedReview = ServerAttestedReviewV1 | ServerAttestedReviewV2 | ServerAttestedReviewV3;
export type DegradedReviewV1 = ReviewProvenanceBaseV1 & {
  readonly assurance: "degraded";
  readonly reason: string;
};
export type DegradedReviewV2 = ReviewProvenanceBaseV2 & {
  readonly assurance: "degraded";
  readonly reason: string;
};
export type DegradedReview = DegradedReviewV1 | DegradedReviewV2;
export type ReviewEvidence = ServerAttestedReview | DegradedReview;
export const routeOverrideRecordSchema = z.object({
  reason: nonBlank,
  pinned_model: nonBlank.optional(),
  pinned_effort: z.enum(EFFORT_VALUES).optional(),
  pinned_provider: nonBlank.optional(),
}).strict();
export const displacedRouteRecordSchema = z.object({
  source: z.enum(DISPLACED_ROUTE_SOURCES),
  model: nonBlank,
  effort: z.enum(EFFORT_VALUES),
  provider: nonBlank.optional(),
}).strict();
export const routeSourceRecordSchema = z.object({
  provenance: z.enum(ROUTE_SOURCE_PROVENANCES),
  displaced: displacedRouteRecordSchema.optional(),
}).strict();
export const reviewerRunV1Schema = z.object({
  reviewer_id: id,
  focus: z.enum(REVIEW_RUN_FOCUSES),
  routing_role: z.enum(REVIEW_RUN_ROLES),
  criterion_ids: z.array(id).min(1),
  rubric_digest: digest,
  model_family: z.enum(MODEL_FAMILIES),
  model: nonBlank,
  effort: z.enum(EFFORT_VALUES),
  adapter: z.enum(ADAPTER_IDS),
  cli_version: nonBlank,
  invocation_id: id,
  envelope_input_digest: digest,
  observed_output_digest: digest,
  finding_ids: z.array(id),
  provider: nonBlank.optional(),
  route_source: routeSourceRecordSchema,
  route_override: routeOverrideRecordSchema.optional(),
}).strict().superRefine((run, context) => {
  if (new Set(run.criterion_ids).size !== run.criterion_ids.length) {
    context.addIssue({ code: "custom", path: ["criterion_ids"], message: "reviewer run criteria must be unique" });
  }
  if (new Set(run.finding_ids).size !== run.finding_ids.length) {
    context.addIssue({ code: "custom", path: ["finding_ids"], message: "reviewer run findings must be unique" });
  }
});

export const reviewerRunV2Schema = z.object({
  reviewer_id: id,
  focus: z.enum(REVIEW_RUN_FOCUSES),
  routing_role: z.enum(REVIEW_RUN_ROLES),
  criterion_ids: z.array(id),
  expected_upstream_digests: z.array(digest).optional(),
  legacy_confirmations: z.array(legacyConfirmationAssignmentV1Schema).min(1).optional(),
  rubric_digest: digest,
  model_family: z.enum(MODEL_FAMILIES),
  model: nonBlank,
  effort: z.enum(EFFORT_VALUES),
  adapter: z.enum(ADAPTER_IDS),
  cli_version: nonBlank,
  invocation_id: id,
  envelope_input_digest: digest,
  observed_output_digest: digest,
  finding_ids: z.array(id),
  provider: nonBlank.optional(),
  route_source: routeSourceRecordSchema,
  route_override: routeOverrideRecordSchema.optional(),
}).strict().superRefine((run, context) => {
  for (const [field, values] of [
    ["criterion_ids", run.criterion_ids],
    ["expected_upstream_digests", run.expected_upstream_digests ?? []],
    ["finding_ids", run.finding_ids],
  ] as const) {
    if (new Set(values).size !== values.length) context.addIssue({ code: "custom", path: [field], message: `${field} must be unique` });
  }
  if (run.expected_upstream_digests?.some((value, index) => index > 0 && run.expected_upstream_digests![index - 1]! >= value)) {
    context.addIssue({ code: "custom", path: ["expected_upstream_digests"], message: "expected upstream digests must use canonical order" });
  }
  if (run.legacy_confirmations !== undefined && new Set(run.legacy_confirmations.map((entry) => entry.finding_id)).size !== run.legacy_confirmations.length) {
    context.addIssue({ code: "custom", path: ["legacy_confirmations"], message: "legacy confirmation finding ids must be unique" });
  }
  if (run.criterion_ids.length === 0 && run.expected_upstream_digests === undefined && run.legacy_confirmations === undefined) {
    context.addIssue({ code: "custom", path: ["criterion_ids"], message: "a reviewer run requires criteria, alignment, or legacy confirmation responsibility" });
  }
  if (run.focus === "general" && run.routing_role !== "counter-reviewer") {
    context.addIssue({ code: "custom", path: ["routing_role"], message: "general runs use the counter-reviewer route" });
  }
  if (run.focus === "tests" && run.routing_role !== "test-reviewer") {
    context.addIssue({ code: "custom", path: ["routing_role"], message: "test runs use the test-reviewer route" });
  }
  if (run.focus === "tests" && run.expected_upstream_digests !== undefined) {
    context.addIssue({ code: "custom", path: ["expected_upstream_digests"], message: "test runs cannot own upstream alignment" });
  }
});

export const generalReviewFindingV3Schema = rawGeneralReviewFindingV3Schema.safeExtend({
  reviewer_id: id,
  reviewer_focus: z.literal("general"),
  routing_role: z.literal("counter-reviewer"),
}).strict();

export const testReviewFindingV3Schema = rawTestReviewFindingV3Schema.safeExtend({
  reviewer_id: id,
  reviewer_focus: z.literal("tests"),
  routing_role: z.literal("test-reviewer"),
}).strict();

export const reviewFindingV3Schema = z.discriminatedUnion("reviewer_focus", [
  generalReviewFindingV3Schema,
  testReviewFindingV3Schema,
]);

export function reviewFindingDisplayDetail(finding: ReviewFindingV2 | LegacyReviewFinding | ReviewFindingV3): Readonly<{
  summary: string;
  evidence: string;
  suggested_resolution: string;
}> {
  if ("reviewer_focus" in finding && finding.reviewer_focus === "tests") {
    return Object.freeze({
      summary: finding.required_behavior_or_risk_boundary,
      evidence: `${finding.coverage_or_oracle_problem} Consequence: ${finding.consequence}`,
      suggested_resolution: finding.proposed_verification_change,
    });
  }
  return Object.freeze({ summary: finding.summary, evidence: finding.evidence, suggested_resolution: finding.suggested_resolution });
}
const provenanceFields = {
  model_family: z.union([z.enum(MODEL_FAMILIES), z.literal("unknown")]),
  model: nonBlank,
  effort: z.union([z.enum(EFFORT_VALUES), z.literal("unknown")]),
} as const;
const serverAttestedFields = {
  assurance: z.literal("server-attested"),
  adapter: z.enum(ADAPTER_IDS),
  cli_version: nonBlank,
  model_family: z.enum(MODEL_FAMILIES),
  effort: z.enum(EFFORT_VALUES),
  invocation_id: id,
  envelope_input_digest: digest,
  observed_output_digest: digest,
  result_id: id,
  provider: nonBlank.optional(),
  route_source: routeSourceRecordSchema.optional(),
  route_override: routeOverrideRecordSchema.optional(),
  repositories: reviewedRepositoriesV1Schema.optional(),
  reviewer_runs: z.array(reviewerRunV1Schema).min(1).optional(),
  effort_review: z.lazy(() => effortEvidenceSchema).optional(),
} as const;
const degradedFields = {
  ...provenanceFields,
  assurance: z.literal("degraded"),
  reason: nonBlank,
} as const;

function validateReviewerRuns(
  review: {
    readonly findings: readonly { readonly finding_id: string }[];
    readonly reviewer_runs?: readonly { readonly reviewer_id: string; readonly finding_ids: readonly string[] }[] | undefined;
  },
  context: z.RefinementCtx,
): void {
  if (review.reviewer_runs === undefined) return;
  const reviewerIds = review.reviewer_runs.map((run) => run.reviewer_id);
  if (new Set(reviewerIds).size !== reviewerIds.length) {
    context.addIssue({ code: "custom", path: ["reviewer_runs"], message: "reviewer run ids must be unique" });
  }
  const owned = review.reviewer_runs.flatMap((run) => run.finding_ids);
  const findings = review.findings.map((finding) => finding.finding_id);
  if (owned.length !== findings.length || new Set(owned).size !== owned.length ||
      findings.some((finding) => !owned.includes(finding))) {
    context.addIssue({ code: "custom", path: ["reviewer_runs"], message: "reviewer runs must partition review findings exactly" });
  }
}

export const serverAttestedReviewV1Schema = rawReviewV1StructuralSchema.safeExtend({
  ...provenanceFields,
  ...serverAttestedFields,
}).strict().superRefine((review, context) => {
  validateUniqueReviewMembers(review, context);
  const expected = expectedLegacyReviewSummary(review.findings);
  if (review.blocking_count !== expected.blocking_count) context.addIssue({ code: "custom", path: ["blocking_count"], message: `review blocking_count must be ${expected.blocking_count}` });
  if (review.verdict !== expected.verdict) context.addIssue({ code: "custom", path: ["verdict"], message: `review verdict must be ${expected.verdict}` });
  validateReviewerRuns(review, context);
});

export const serverAttestedReviewV2Schema = rawReviewV2StructuralSchema.safeExtend({
  ...provenanceFields,
  ...serverAttestedFields,
}).strict().superRefine((review, context) => {
  // Summary values are authenticated archival facts for this assurance arm. Do not recompute
  // them during later reads, because doing so could strand evidence minted by an older server.
  validateUniqueReviewMembers(review, context);
  validateReviewerRuns(review, context);
});

const serverAttestedReviewV3StructuralSchema = z.object({
  schema_version: z.literal("3"),
  ...rawReviewV3CommonShape,
  findings: z.array(reviewFindingV3Schema),
  verdict: z.enum(REVIEW_VERDICTS),
  total_findings: safeCount,
  partition_counts: findingPartitionCountsSchema,
  upstream_alignment: z.array(upstreamAlignmentV1Schema).optional(),
  drift: z.enum(["aligned", "incidental", "material"]).optional(),
  assurance: z.literal("server-attested"),
  adapter: z.enum(ADAPTER_IDS),
  cli_version: nonBlank,
  model_family: z.enum(MODEL_FAMILIES),
  model: nonBlank,
  effort: z.enum(EFFORT_VALUES),
  invocation_id: id,
  envelope_input_digest: digest,
  observed_output_digest: digest,
  result_id: id,
  provider: nonBlank.optional(),
  route_source: routeSourceRecordSchema,
  route_override: routeOverrideRecordSchema.optional(),
  repositories: reviewedRepositoriesV1Schema,
  reviewer_runs: z.array(reviewerRunV2Schema).min(1),
  effort_review: z.lazy(() => effortEvidenceSchema).optional(),
}).strict();

export function expectedUpstreamDrift(alignment: readonly UpstreamAlignmentV1[]): "aligned" | "incidental" | "material" {
  return alignment.some((entry) => entry.drift === "material")
    ? "material"
    : alignment.some((entry) => entry.drift === "incidental") ? "incidental" : "aligned";
}

function validateServerAttestedReviewV3(review: ServerAttestedReviewV3, context: z.RefinementCtx): void {
  const findingIds = review.findings.map((finding) => finding.finding_id);
  if (new Set(findingIds).size !== findingIds.length) context.addIssue({ code: "custom", path: ["findings"], message: "review finding ids must be unique" });

  const expectedSummary = expectedReviewSummaryV2(review.findings);
  if (review.verdict !== expectedSummary.verdict) context.addIssue({ code: "custom", path: ["verdict"], message: `review verdict must be ${expectedSummary.verdict}` });
  if (review.total_findings !== expectedSummary.total_findings) context.addIssue({ code: "custom", path: ["total_findings"], message: `review total_findings must be ${expectedSummary.total_findings}` });
  for (const key of Object.keys(expectedSummary.partition_counts) as Array<keyof FindingPartitionCounts>) {
    if (review.partition_counts[key] !== expectedSummary.partition_counts[key]) context.addIssue({ code: "custom", path: ["partition_counts", key], message: `review partition count must be ${expectedSummary.partition_counts[key]}` });
  }

  const reviewerIds = review.reviewer_runs.map((run) => run.reviewer_id);
  if (new Set(reviewerIds).size !== reviewerIds.length) context.addIssue({ code: "custom", path: ["reviewer_runs"], message: "reviewer run ids must be unique" });
  const runFindingIds = review.reviewer_runs.flatMap((run) => run.finding_ids);
  if (runFindingIds.length !== findingIds.length || new Set(runFindingIds).size !== runFindingIds.length || findingIds.some((findingId) => !runFindingIds.includes(findingId))) {
    context.addIssue({ code: "custom", path: ["reviewer_runs"], message: "reviewer runs must partition review findings exactly" });
  }
  review.findings.forEach((finding, index) => {
    const owners = review.reviewer_runs.filter((run) => run.finding_ids.includes(finding.finding_id));
    const owner = owners[0];
    if (owners.length !== 1 || owner === undefined) return;
    const confirmation = owner.legacy_confirmations?.find((entry) => entry.finding_id === finding.finding_id);
    if (finding.reviewer_id !== owner.reviewer_id || finding.reviewer_focus !== owner.focus || finding.routing_role !== owner.routing_role ||
        (!owner.criterion_ids.includes(finding.criterion_id) && !(confirmation?.criterion_ids.includes(finding.criterion_id) ?? false))) {
      context.addIssue({ code: "custom", path: ["findings", index], message: "finding attribution and criterion must match its reviewer run" });
    }
    if (confirmation === undefined && !finding.finding_id.startsWith(`${owner.reviewer_id}-`)) {
      context.addIssue({ code: "custom", path: ["findings", index, "finding_id"], message: "finding id prefix must match its reviewer run" });
    }
  });

  const alignmentRuns = review.reviewer_runs.filter((run) => run.expected_upstream_digests !== undefined);
  if ((review.upstream_alignment === undefined) !== (review.drift === undefined)) {
    context.addIssue({ code: "custom", path: ["upstream_alignment"], message: "upstream alignment and drift must be present together" });
  }
  if (review.upstream_alignment === undefined) {
    if (alignmentRuns.length !== 0) context.addIssue({ code: "custom", path: ["reviewer_runs"], message: "alignment owner requires an upstream census" });
  } else {
    if (alignmentRuns.length !== 1 || alignmentRuns[0] !== review.reviewer_runs[0] || alignmentRuns[0]?.focus !== "general") {
      context.addIssue({ code: "custom", path: ["reviewer_runs"], message: "only the primary general reviewer run may own upstream alignment" });
    } else {
      const expected = alignmentRuns[0].expected_upstream_digests!;
      const actual = review.upstream_alignment.map((entry) => entry.upstream_digest);
      if (actual.length !== expected.length || actual.some((value, index) => value !== expected[index])) {
        context.addIssue({ code: "custom", path: ["upstream_alignment"], message: "upstream alignment must exactly cover the primary reviewer plan" });
      }
    }
    const expectedDrift = expectedUpstreamDrift(review.upstream_alignment);
    if (review.drift !== expectedDrift) context.addIssue({ code: "custom", path: ["drift"], message: `review drift must be ${expectedDrift}` });
  }
}

export const serverAttestedReviewV3Schema = serverAttestedReviewV3StructuralSchema.superRefine((review, context) => {
  validateServerAttestedReviewV3(review as ServerAttestedReviewV3, context);
});

export const degradedReviewV1Schema = rawReviewV1StructuralSchema.safeExtend(degradedFields).strict().superRefine((review, context) => {
  validateUniqueReviewMembers(review, context);
  const expected = expectedLegacyReviewSummary(review.findings);
  if (review.blocking_count !== expected.blocking_count) context.addIssue({ code: "custom", path: ["blocking_count"], message: `review blocking_count must be ${expected.blocking_count}` });
  if (review.verdict !== expected.verdict) context.addIssue({ code: "custom", path: ["verdict"], message: `review verdict must be ${expected.verdict}` });
});
export const degradedReviewV2Schema = rawReviewV2StructuralSchema.safeExtend(degradedFields).strict().superRefine((review, context) => {
  validateUniqueReviewMembers(review, context);
  validateV2Summary(review, context);
});

const v1EvidenceSchema = z.discriminatedUnion("assurance", [serverAttestedReviewV1Schema, degradedReviewV1Schema]);
const v2EvidenceSchema = z.discriminatedUnion("assurance", [serverAttestedReviewV2Schema, degradedReviewV2Schema]);
export const reviewEvidenceSchema = z.discriminatedUnion("schema_version", [v1EvidenceSchema, v2EvidenceSchema, serverAttestedReviewV3Schema]);

export function parseReviewEvidence(value: unknown): ReviewEvidence {
  assertPlainJson(value, "review evidence");
  const parsed = reviewEvidenceSchema.parse(structuredClone(value));
  // `assertPlainJson` rejects an explicit `undefined` member, and zod omits an absent optional key
  // rather than materializing it, so the parsed value never carries `route_override: undefined`.
  // The assertion only narrows zod's `| undefined` inference back to the exact persisted shape.
  return parsed as ReviewEvidence;
}

const referencedReviewWrapperSchema = z.object({ evidence_digest: digest, evidence: z.unknown() }).strict();
export function parseReferencedReviewEvidence(value: unknown): ReferencedEvidence<ReviewEvidence> {
  assertPlainJson(value, "referenced review evidence");
  const wrapper = referencedReviewWrapperSchema.parse(structuredClone(value));
  const evidence = reviewEvidenceSchema.parse(wrapper.evidence) as ReviewEvidence;
  return { evidence_digest: wrapper.evidence_digest, evidence };
}

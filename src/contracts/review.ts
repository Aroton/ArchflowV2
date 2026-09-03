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
  return reviewedRepositoriesV1Schema.parse(value) as readonly ReviewedRepositoryV1[];
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

export function computeFindingPartitionCounts(findings: readonly ReviewFindingV2[]): FindingPartitionCounts {
  const counts = Object.fromEntries(
    CLAIM_TYPES.flatMap((claimType) => CONFIDENCE_LEVELS.map((confidence) => [`${claimType}:${confidence}`, 0])),
  ) as Record<`${ClaimType}:${ConfidenceLevel}`, number>;
  for (const finding of findings) counts[`${finding.claim_type}:${finding.confidence}`] += 1;
  return Object.freeze(counts);
}

export function isSubstantiveClaim(finding: ReviewFindingV2 | LegacyReviewFinding): boolean {
  if ("claim_type" in finding && typeof finding.claim_type === "string") {
    return finding.claim_type === "defect" || finding.claim_type === "risk" || finding.claim_type === "gap";
  }
  return "blocking" in finding && typeof finding.blocking === "boolean" ? finding.blocking : false;
}

export function expectedReviewSummaryV2(findings: readonly ReviewFindingV2[]): Readonly<{
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
  const parsed = rawReviewSchema.parse(value);
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
export type ServerAttestedReview = ServerAttestedReviewV1 | ServerAttestedReviewV2;
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
export const reviewEvidenceSchema = z.discriminatedUnion("schema_version", [v1EvidenceSchema, v2EvidenceSchema]);

export function parseReviewEvidence(value: unknown): ReviewEvidence {
  assertPlainJson(value, "review evidence");
  const parsed = reviewEvidenceSchema.parse(value);
  // `assertPlainJson` rejects an explicit `undefined` member, and zod omits an absent optional key
  // rather than materializing it, so the parsed value never carries `route_override: undefined`.
  // The assertion only narrows zod's `| undefined` inference back to the exact persisted shape.
  return parsed as ReviewEvidence;
}

const referencedReviewWrapperSchema = z.object({ evidence_digest: digest, evidence: z.unknown() }).strict();
export function parseReferencedReviewEvidence(value: unknown): ReferencedEvidence<ReviewEvidence> {
  assertPlainJson(value, "referenced review evidence");
  const wrapper = referencedReviewWrapperSchema.parse(value);
  return { evidence_digest: wrapper.evidence_digest, evidence: parseReviewEvidence(wrapper.evidence) };
}

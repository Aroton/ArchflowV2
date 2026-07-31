import { z } from "zod";

import type { ReferencedEvidence, Sha256Digest, TaskSlug } from "./evidence.js";
import { taskSlugV1Schema } from "./evidence.js";
import { assertPlainJson } from "./plain-json.js";

export const REVIEW_VERDICTS = ["pass", "advisory", "fail"] as const;
export const REVIEW_ROLES = ["self-review", "counter-review", "gate-counter-review"] as const;
export const REVIEW_FINDING_SEVERITIES = ["blocker", "major", "minor"] as const;
export const MODEL_FAMILIES = ["claude", "codex"] as const;
export const ADAPTER_IDS = ["claude-cli", "codex-cli"] as const;
export const EFFORT_VALUES = ["low", "medium", "high", "xhigh", "max", "ultra"] as const;

export type ReviewVerdict = (typeof REVIEW_VERDICTS)[number];
export type ReviewRole = (typeof REVIEW_ROLES)[number];
export type ReviewFindingSeverity = (typeof REVIEW_FINDING_SEVERITIES)[number];
export type ModelFamily = (typeof MODEL_FAMILIES)[number];
export type AdapterId = (typeof ADAPTER_IDS)[number];
export type DeclaredEffort = (typeof EFFORT_VALUES)[number] | "unknown";

export type RuleVersionRef = {
  readonly rule_id: string;
  readonly rule_version: number;
};

export type ReviewFinding = {
  readonly finding_id: string;
  readonly severity: ReviewFindingSeverity;
  readonly blocking: boolean;
  readonly summary: string;
  readonly evidence: string;
  readonly suggested_resolution: string;
};

export type RawReview = {
  readonly schema_version: "1";
  readonly task_id: TaskSlug;
  readonly phase_instance: string;
  readonly step: "self_review" | "counter_review";
  readonly role: ReviewRole;
  readonly subject_digest: Sha256Digest;
  readonly input_fingerprint: Sha256Digest;
  readonly rubric_digest: Sha256Digest;
  readonly producer_family: ModelFamily;
  readonly findings: readonly ReviewFinding[];
  readonly matched_rule_versions: readonly RuleVersionRef[];
  readonly verdict: ReviewVerdict;
  readonly blocking_count: number;
};

/** Semantically checked review data. This type intentionally carries no authority brand. */
export type DerivedReview = RawReview;

const nonBlank = z.string().min(1).refine((value) => value.trim().length > 0, "must contain a non-whitespace character");
const id = z.string().regex(/^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/u);
const digest = z.string().regex(/^[0-9a-f]{64}$/u) as unknown as z.ZodType<Sha256Digest>;
const safePositive = z.number().int().positive().safe();

export const ruleVersionRefSchema = z.object({ rule_id: id, rule_version: safePositive }).strict();
export const reviewFindingSchema = z.object({
  finding_id: id,
  severity: z.enum(REVIEW_FINDING_SEVERITIES),
  blocking: z.boolean(),
  summary: nonBlank,
  evidence: nonBlank,
  suggested_resolution: nonBlank,
}).strict().superRefine((finding, context) => {
  if (finding.blocking !== (finding.severity === "blocker")) {
    context.addIssue({ code: "custom", path: ["blocking"], message: "only blocker findings are blocking" });
  }
});

export const rawReviewSchema = z.object({
  schema_version: z.literal("1"),
  task_id: taskSlugV1Schema,
  phase_instance: z.string().regex(/^(?:prd|design|phase-(?:design|impl)-[1-9][0-9]*)$/u),
  step: z.enum(["self_review", "counter_review"]),
  role: z.enum(REVIEW_ROLES),
  subject_digest: digest,
  input_fingerprint: digest,
  rubric_digest: digest,
  producer_family: z.enum(MODEL_FAMILIES),
  findings: z.array(reviewFindingSchema),
  matched_rule_versions: z.array(ruleVersionRefSchema),
  verdict: z.enum(REVIEW_VERDICTS),
  blocking_count: z.number().int().nonnegative().safe(),
}).strict().superRefine((review, context) => {
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
  if (review.role === "self-review" && review.step !== "self_review") context.addIssue({ code: "custom", path: ["step"], message: "self-review role requires self_review step" });
  if (review.role !== "self-review" && review.step !== "counter_review") context.addIssue({ code: "custom", path: ["step"], message: "counter-review roles require counter_review step" });
  const expected = expectedReviewSummary(review.findings);
  if (review.blocking_count !== expected.blocking_count) context.addIssue({ code: "custom", path: ["blocking_count"], message: `review blocking_count must be ${expected.blocking_count}` });
  if (review.verdict !== expected.verdict) context.addIssue({ code: "custom", path: ["verdict"], message: `review verdict must be ${expected.verdict}` });
});

function expectedReviewSummary(findings: readonly ReviewFinding[]): Readonly<{ blocking_count: number; verdict: ReviewVerdict }> {
  const blocking_count = findings.filter((finding) => finding.blocking).length;
  return { blocking_count, verdict: blocking_count > 0 ? "fail" : findings.length > 0 ? "advisory" : "pass" };
}

function validateReviewClaims(parsed: RawReview): void {
  const expected = expectedReviewSummary(parsed.findings);
  if (parsed.blocking_count !== expected.blocking_count) throw new TypeError(`review blocking_count must be ${expected.blocking_count}`);
  if (parsed.verdict !== expected.verdict) throw new TypeError(`review verdict must be ${expected.verdict}`);
}

export function parseAndDeriveReview(value: unknown): DerivedReview {
  assertPlainJson(value, "review");
  const parsed = rawReviewSchema.parse(value);
  validateReviewClaims(parsed);
  return parsed;
}

type ReviewProvenanceBase = DerivedReview & {
  readonly model_family: ModelFamily | "unknown";
  readonly model: string;
  readonly effort: DeclaredEffort;
};

export type AgentDeclaredReview = ReviewProvenanceBase & {
  readonly assurance: "agent-declared";
};
export type ServerAttestedReview = Omit<ReviewProvenanceBase, "model_family" | "effort"> & {
  readonly assurance: "server-attested";
  readonly adapter: AdapterId;
  readonly cli_version: string;
  readonly model_family: ModelFamily;
  readonly effort: Exclude<DeclaredEffort, "unknown">;
  readonly invocation_id: string;
  readonly envelope_input_digest: Sha256Digest;
  readonly observed_output_digest: Sha256Digest;
  readonly result_id: string;
};
export type DegradedReview = ReviewProvenanceBase & {
  readonly assurance: "degraded";
  readonly reason: string;
};
export type ReviewEvidence = AgentDeclaredReview | ServerAttestedReview | DegradedReview;

const provenanceBase = rawReviewSchema.safeExtend({
  model_family: z.union([z.enum(MODEL_FAMILIES), z.literal("unknown")]),
  model: nonBlank,
  effort: z.union([z.enum(EFFORT_VALUES), z.literal("unknown")]),
});
const agentDeclaredReviewSchema = provenanceBase.safeExtend({ assurance: z.literal("agent-declared") }).strict();
const serverAttestedReviewSchema = provenanceBase.safeExtend({
  assurance: z.literal("server-attested"),
  adapter: z.enum(ADAPTER_IDS),
  cli_version: nonBlank,
  model_family: z.enum(MODEL_FAMILIES),
  effort: z.enum(EFFORT_VALUES),
  invocation_id: id,
  envelope_input_digest: digest,
  observed_output_digest: digest,
  result_id: id,
}).strict().superRefine((review, context) => {
  if (review.role === "self-review") context.addIssue({ code: "custom", path: ["role"], message: "self-review cannot be server-attested" });
  const expectedReviewer = review.producer_family === "claude" ? "codex" : "claude";
  if (review.model_family !== expectedReviewer) context.addIssue({ code: "custom", path: ["model_family"], message: "server-attested review must be opposite-family" });
});
const degradedReviewSchema = provenanceBase.safeExtend({ assurance: z.literal("degraded"), reason: nonBlank }).strict();
export const reviewEvidenceSchema = z.discriminatedUnion("assurance", [agentDeclaredReviewSchema, serverAttestedReviewSchema, degradedReviewSchema]);

export function parseReviewEvidence(value: unknown): ReviewEvidence {
  assertPlainJson(value, "review evidence");
  const parsed = reviewEvidenceSchema.parse(value);
  validateReviewClaims(parsed);
  return parsed;
}

export function parseReferencedReviewEvidence(value: unknown): ReferencedEvidence<ReviewEvidence> {
  assertPlainJson(value, "referenced review evidence");
  const wrapper = z.object({ evidence_digest: digest, evidence: z.unknown() }).strict().parse(value);
  return { evidence_digest: wrapper.evidence_digest, evidence: parseReviewEvidence(wrapper.evidence) };
}

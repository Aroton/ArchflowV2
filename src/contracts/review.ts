import { z } from "zod";

import { gitOidV1Schema, type GitOid } from "./canonical.js";
import { REPOSITORY_NAME_MESSAGE, REPOSITORY_NAME_PATTERN } from "./config.js";
import type { ReferencedEvidence, Sha256Digest, TaskSlug } from "./evidence.js";
import { createTaskSlugV1Schema } from "./evidence.js";
import { assertPlainJson } from "./plain-json.js";

export const REVIEW_VERDICTS = ["pass", "advisory", "fail"] as const;
export const REVIEW_ROLES = ["counter-review"] as const;
export const REVIEW_FINDING_SEVERITIES = ["blocker", "major", "minor"] as const;
export const MODEL_FAMILIES = ["claude", "codex", "gemini"] as const;
export const ADAPTER_IDS = ["claude-cli", "codex-cli"] as const;
export const EFFORT_VALUES = ["low", "medium", "high", "xhigh", "max", "ultra"] as const;

export type ReviewVerdict = (typeof REVIEW_VERDICTS)[number];
export type ReviewRole = (typeof REVIEW_ROLES)[number];
export type ReviewFindingSeverity = (typeof REVIEW_FINDING_SEVERITIES)[number];
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
  readonly step: "counter_review";
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

const nonBlank = z.string().min(1).regex(/\S/, "must contain a non-whitespace character");
const id = z.string().regex(/^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/u);
const digest = z.string().regex(/^[0-9a-f]{64}$/u) as unknown as z.ZodType<Sha256Digest>;
const taskSlug = createTaskSlugV1Schema();
const phaseInstance = z.string().regex(/^(?:prd|design|phase-(?:design|impl)-[1-9][0-9]*)$/u);
const safePositive = z.number().int().positive().safe();

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
  task_id: taskSlug,
  phase_instance: phaseInstance,
  step: z.literal("counter_review"),
  role: z.enum(REVIEW_ROLES),
  subject_digest: digest,
  input_fingerprint: digest,
  rubric_digest: digest,
  producer_family: z.enum(MODEL_FAMILIES),
  findings: z.array(reviewFindingSchema),
  matched_rule_versions: z.array(ruleVersionRefSchema),
  verdict: z.enum(REVIEW_VERDICTS),
  blocking_count: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER),
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

/**
 * The generated `review.schema.json` `$defs` layout. The def names are load-bearing:
 * `projectCliOutputSchema` rewrites `taskSlug` (lookahead simplification) and `finding`
 * (severity/blocking branches) by name before handing the document to a child host, and the
 * document must stay self-contained because hosts cannot resolve cross-document references.
 */
export const reviewDocumentDefs = {
  id,
  taskSlug,
  digest,
  phaseInstance,
  nonBlank,
  finding: reviewFindingSchema,
} as const;

export function parseAndDeriveReview(value: unknown): DerivedReview {
  assertPlainJson(value, "review");
  const parsed = rawReviewSchema.parse(value);
  validateReviewClaims(parsed);
  return parsed;
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

type ReviewProvenanceBase = DerivedReview & {
  readonly model_family: ModelFamily | "unknown";
  readonly model: string;
  readonly effort: DeclaredEffort;
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
};
export type DegradedReview = ReviewProvenanceBase & {
  readonly assurance: "degraded";
  readonly reason: string;
};
export type ReviewEvidence = ServerAttestedReview | DegradedReview;

const provenanceBase = rawReviewSchema.safeExtend({
  model_family: z.union([z.enum(MODEL_FAMILIES), z.literal("unknown")]),
  model: nonBlank,
  effort: z.union([z.enum(EFFORT_VALUES), z.literal("unknown")]),
});
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
  provider: nonBlank.optional(),
  route_source: routeSourceRecordSchema.optional(),
  route_override: routeOverrideRecordSchema.optional(),
  repositories: reviewedRepositoriesV1Schema.optional(),
}).strict();
const degradedReviewSchema = provenanceBase.safeExtend({ assurance: z.literal("degraded"), reason: nonBlank }).strict();
export const reviewEvidenceSchema = z.discriminatedUnion("assurance", [serverAttestedReviewSchema, degradedReviewSchema]);

export function parseReviewEvidence(value: unknown): ReviewEvidence {
  assertPlainJson(value, "review evidence");
  const parsed = reviewEvidenceSchema.parse(value);
  validateReviewClaims(parsed);
  // `assertPlainJson` rejects an explicit `undefined` member, and zod omits an absent optional key
  // rather than materializing it, so the parsed value never carries `route_override: undefined`.
  // The assertion only narrows zod's `| undefined` inference back to the exact persisted shape.
  return parsed as ReviewEvidence;
}

export function parseReferencedReviewEvidence(value: unknown): ReferencedEvidence<ReviewEvidence> {
  assertPlainJson(value, "referenced review evidence");
  const wrapper = z.object({ evidence_digest: digest, evidence: z.unknown() }).strict().parse(value);
  return { evidence_digest: wrapper.evidence_digest, evidence: parseReviewEvidence(wrapper.evidence) };
}

import { reviewReportOutputSchema } from "./review.js";
import { dispatchUsageSchema } from "./dispatch-usage.js";
import { z } from "zod";
import { configRouteSchema } from "./config.js";
import { adjudicationJudgmentV2Schema } from "./adjudication.js";
import { assertPlainJson } from "./plain-json.js";
import { pathClaimLexicalV1Schema } from "./path-claims.js";

const text = z.string().min(1).regex(/\S/u);
const digest = z.string().regex(/^[0-9a-f]{64}$/u);
const path = pathClaimLexicalV1Schema.refine((value) => !value.split("/").includes(".git") &&
  value !== ".archflow/tasks" && !value.startsWith(".archflow/tasks/"), "must be a repository-relative file outside Git and workflow task storage");
export const simpleReviewInputSchema = z.object({
  schema_version: z.literal("1"),
  stage: z.enum(["plan", "implementation"]),
  ask: text,
  plan: text,
  base_commit: z.string().regex(/^[0-9a-f]{40}$/u).describe("Full HEAD commit recorded before this simple task; HEAD must still match."),
  paths: z.array(path).refine((paths) => new Set(paths).size === paths.length, "paths must be unique").describe("Declared output file paths, including planned additions and deletions; no directories or other task storage."),
  verification: text.optional(),
  review_routes: z.object({
    "counter-reviewer": configRouteSchema.optional(),
    "test-reviewer": configRouteSchema.optional(),
    adjudicator: configRouteSchema.optional(),
  }).strict().optional(),
  expected_policy_digest: digest.optional().describe("For implementation, carry the policy_digest returned by plan review to detect policy drift before dispatch."),
}).strict().superRefine((value, ctx) => {
  if (value.stage === "implementation" && value.verification === undefined) {
    ctx.addIssue({ code: "custom", path: ["verification"], message: "implementation review requires verification evidence (including checks unavailable or not applicable)" });
  }
});
const role = z.enum(["counter-reviewer", "test-reviewer", "adjudicator"]);
const route = configRouteSchema.extend({ adapter: text, family: text }).strict();
const report = z.union([
  reviewReportOutputSchema.extend({ role: z.enum(["counter-reviewer", "test-reviewer"]), reviewer_id: text, route, usage: dispatchUsageSchema.optional() }).strict(),
  z.object({ role: z.literal("adjudicator"), reviewer_id: text, route, report: z.string(), usage: dispatchUsageSchema.optional() }).strict(),
]);
const judgment = adjudicationJudgmentV2Schema.extend({ rule_id: text, rule_version: z.number().int().positive() }).strict();
const failure = z.object({ role, reviewer_id: text, route, code: text, message: text }).strict();
export const simpleReviewResultSchema = z.object({
  schema_version: z.literal("1"),
  ok: z.boolean(),
  value: z.object({
    stage: z.enum(["plan", "implementation"]),
    subject_digest: digest,
    policy_digest: digest,
    config_digest: digest,
    constitution_digest: digest,
    reports: z.array(report),
    constitution: z.object({ status: z.enum(["complete", "not-applicable", "failed"]), judgments: z.array(judgment) }).strict(),
    human_review_reasons: z.array(text),
    failures: z.array(failure),
  }).strict().optional(),
  error: z.object({ code: text, message: text, retryable: z.boolean() }).strict().optional(),
}).strict().superRefine((value, ctx) => {
  if (value.ok && (value.value === undefined || value.error !== undefined || value.value.failures.length > 0 || value.value.constitution.status === "failed")) {
    ctx.addIssue({ code: "custom", message: "successful review requires complete coverage and no error" });
  }
  if (!value.ok && value.error === undefined) ctx.addIssue({ code: "custom", message: "failed review requires an error" });
});
export type SimpleReviewInput = z.infer<typeof simpleReviewInputSchema>;
export type SimpleReviewResult = z.infer<typeof simpleReviewResultSchema>;
export function parseSimpleReviewInput(value: unknown): SimpleReviewInput {
  assertPlainJson(value, "simple review input");
  return simpleReviewInputSchema.parse(structuredClone(value));
}
export function parseSimpleReviewResult(value: unknown): SimpleReviewResult {
  assertPlainJson(value, "simple review result");
  return simpleReviewResultSchema.parse(structuredClone(value));
}

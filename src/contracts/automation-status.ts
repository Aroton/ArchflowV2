import { z } from "zod";

import { canonicalJsonDigest } from "./canonical.js";
import type { SafeInteger, Sha256Digest, TaskSlug } from "./evidence.js";
import { safeIntegerV1Schema, sha256DigestV1Schema, taskSlugV1Schema } from "./evidence.js";
import { assertPlainJson, type PlainJsonValue } from "./plain-json.js";
import { workflowPositionV1Schema, type WorkflowPositionV1 } from "./semantic-workflow.js";

const nonBlank = z.string().min(1).regex(/\S/u);
const boundedText = nonBlank.max(4096);
const digest = sha256DigestV1Schema as unknown as z.ZodType<Sha256Digest>;
const revision = safeIntegerV1Schema as unknown as z.ZodType<SafeInteger>;

export const AUTOMATION_SKILLS = [
  "archflow-upgrade",
  "archflow-prd",
  "archflow-design",
  "archflow-phase-design",
  "archflow-phase-impl",
] as const;
export type AutomationSkillV1 = (typeof AUTOMATION_SKILLS)[number];

export const AUTOMATION_BLOCKED_CATEGORIES = [
  "inspect-state",
  "resume-exact-intent",
  "inspect-retained-receipt",
  "create-fresh-intent",
  "resolve-current-authority",
  "state-unreadable",
  "legacy-upgrade-staged",
  "legacy-upgrade-restart-required",
  "archived-decision-invalid",
  "revision-checkpoint-invalid",
  "waiver-origin-invalid",
  "presentation-unavailable",
  "commit-facts-unavailable",
] as const;
export type AutomationBlockedCategoryV1 = (typeof AUTOMATION_BLOCKED_CATEGORIES)[number];
export const AUTOMATION_POSITIONLESS_BLOCKED_CATEGORIES = [
  "state-unreadable",
  "legacy-upgrade-staged",
  "legacy-upgrade-restart-required",
] as const;
export type AutomationPositionlessBlockedCategoryV1 = (typeof AUTOMATION_POSITIONLESS_BLOCKED_CATEGORIES)[number];
export type AutomationPositionedBlockedCategoryV1 = Exclude<
  AutomationBlockedCategoryV1,
  AutomationPositionlessBlockedCategoryV1
>;

export type AutomationSkillActionV1 = {
  readonly actor: "skill";
  readonly kind: "continue-skill";
  readonly skill: AutomationSkillV1;
  readonly task_id: TaskSlug;
  readonly skill_args: readonly string[];
  readonly instruction: string;
};

export type AutomationHumanActionV1 = {
  readonly actor: "human";
  readonly kind: "respond-in-session";
  readonly skill: AutomationSkillV1;
  readonly task_id: TaskSlug;
  readonly skill_args: readonly string[];
  readonly instruction: string;
};

export type AutomationLaunchActionV1 = {
  readonly actor: "orchestrator";
  readonly kind: "launch-skill";
  readonly skill: AutomationSkillV1;
  readonly task_id: TaskSlug;
  readonly skill_args: readonly string[];
  readonly instruction: string;
};

export type AutomationRepairActionV1 = {
  readonly actor: "operator";
  readonly kind: "repair";
  readonly instruction: string;
};

export type AutomationNoneActionV1 = {
  readonly actor: "none";
  readonly kind: "none";
  readonly instruction: string;
};

export type AutomationHumanBoundaryReasonV1 = {
  readonly class: "configured-approval" | "exception";
  readonly text: string;
};

export type AutomationHumanBoundaryV1 =
  | {
      readonly source: "presentation";
      readonly class: "configured-approval" | "exception";
      readonly headline: string;
      readonly summary: string;
      readonly question: string;
      readonly reasons: readonly AutomationHumanBoundaryReasonV1[];
    }
  | {
      readonly source: "dispatch-failure";
      readonly class: "exception";
      readonly headline: string;
      readonly summary: string;
      readonly question: string;
      readonly reasons: readonly AutomationHumanBoundaryReasonV1[];
      readonly failed_role: "counter-reviewer" | "adjudicator";
      readonly failure_code: string;
    };

export type AutomationBlockedV1 = {
  readonly category: AutomationBlockedCategoryV1;
  readonly reasons: readonly string[];
};

type AutomationStatusCommonV1 = {
  readonly schema_version: "1";
  readonly task_id: TaskSlug;
  readonly observation_id: Sha256Digest;
  readonly state_revision: SafeInteger | null;
};

type AutomationPositionedStatusCommonV1 = AutomationStatusCommonV1 & {
  readonly position: WorkflowPositionV1;
};

type AutomationPositionlessStatusCommonV1 = AutomationStatusCommonV1 & {
  readonly position: null;
};

export type AutomationStatusV1 =
  | (AutomationPositionedStatusCommonV1 & {
      readonly condition: "awaiting-client";
      readonly next_action: AutomationSkillActionV1;
    })
  | (AutomationPositionedStatusCommonV1 & {
      readonly condition: "awaiting-human";
      readonly next_action: AutomationHumanActionV1;
      readonly human_boundary: AutomationHumanBoundaryV1;
    })
  | (AutomationPositionedStatusCommonV1 & {
      readonly condition: "ready";
      readonly next_action: AutomationLaunchActionV1;
    })
  | (AutomationPositionedStatusCommonV1 & {
      readonly condition: "blocked";
      readonly next_action: AutomationRepairActionV1;
      readonly blocked: AutomationBlockedV1 & { readonly category: AutomationPositionedBlockedCategoryV1 };
    })
  | (AutomationPositionlessStatusCommonV1 & {
      readonly condition: "blocked";
      readonly next_action: AutomationRepairActionV1;
      readonly blocked: AutomationBlockedV1 & { readonly category: AutomationPositionlessBlockedCategoryV1 };
    })
  | (AutomationPositionedStatusCommonV1 & {
      readonly condition: "complete";
      readonly next_action: AutomationNoneActionV1;
    });

export type AutomationStatusWithoutIdV1 =
  AutomationStatusV1 extends infer Arm
    ? Arm extends AutomationStatusV1 ? Omit<Arm, "observation_id"> : never
    : never;

/** Internal identity facts bound into an observation ID but never exposed as workflow authority. */
export type AutomationObservationAuthorityV1 =
  | {
      readonly kind: "readable";
      readonly repository_identity_digest: Sha256Digest;
      readonly state_document_digest: Sha256Digest;
      readonly live_config_digest: Sha256Digest | null;
      readonly semantic_snapshot_digest: Sha256Digest;
    }
  | {
      readonly kind: "absent";
      readonly repository_identity_digest: Sha256Digest;
      readonly live_config_digest: Sha256Digest | null;
    }
  | {
      readonly kind: "staged";
      readonly repository_identity_digest: Sha256Digest;
      readonly classification: "current" | "restart-required";
      readonly identity_digest: Sha256Digest;
      readonly live_config_digest: Sha256Digest | null;
    }
  | {
      readonly kind: "unreadable";
      readonly repository_identity_digest: Sha256Digest;
      readonly classification: "invalid" | "noncanonical";
      readonly identity_digest: Sha256Digest;
      readonly live_config_digest: Sha256Digest | null;
    };

const skill = z.enum(AUTOMATION_SKILLS);
const skillArgs = z.array(z.string().max(256));
const skillActionV1Schema = z.object({
  actor: z.literal("skill"), kind: z.literal("continue-skill"), skill,
  task_id: taskSlugV1Schema, skill_args: skillArgs, instruction: boundedText,
}).strict();
const humanActionV1Schema = z.object({
  actor: z.literal("human"), kind: z.literal("respond-in-session"), skill,
  task_id: taskSlugV1Schema, skill_args: skillArgs, instruction: boundedText,
}).strict();
const launchActionV1Schema = z.object({
  actor: z.literal("orchestrator"), kind: z.literal("launch-skill"), skill,
  task_id: taskSlugV1Schema, skill_args: skillArgs, instruction: boundedText,
}).strict();
const repairActionV1Schema = z.object({
  actor: z.literal("operator"), kind: z.literal("repair"), instruction: boundedText,
}).strict();
const noneActionV1Schema = z.object({
  actor: z.literal("none"), kind: z.literal("none"), instruction: boundedText,
}).strict();

const humanBoundaryReasonV1Schema = z.object({
  class: z.enum(["configured-approval", "exception"]), text: boundedText,
}).strict();
const presentationBoundaryV1Schema = z.object({
  source: z.literal("presentation"),
  class: z.enum(["configured-approval", "exception"]),
  headline: boundedText, summary: boundedText, question: boundedText,
  reasons: z.array(humanBoundaryReasonV1Schema).min(1),
}).strict().superRefine((boundary, context) => {
  const expected = boundary.reasons.some((reason) => reason.class === "exception")
    ? "exception"
    : "configured-approval";
  if (boundary.class !== expected) {
    context.addIssue({ code: "custom", path: ["class"], message: `human boundary class must be ${expected}` });
  }
});
const dispatchBoundaryV1Schema = z.object({
  source: z.literal("dispatch-failure"), class: z.literal("exception"),
  headline: boundedText, summary: boundedText, question: boundedText,
  reasons: z.array(humanBoundaryReasonV1Schema).min(1),
  failed_role: z.enum(["counter-reviewer", "adjudicator"]), failure_code: nonBlank.max(128),
}).strict().superRefine((boundary, context) => {
  if (!boundary.reasons.some((reason) => reason.class === "exception")) {
    context.addIssue({ code: "custom", path: ["reasons"], message: "dispatch failure requires an exceptional reason" });
  }
});
/** Exported for schema generation so the document can publish its aggregate-class condition exactly. */
export const automationHumanBoundaryV1Schema = z.discriminatedUnion("source", [
  presentationBoundaryV1Schema, dispatchBoundaryV1Schema,
]);
const positionedBlockedCategories = AUTOMATION_BLOCKED_CATEGORIES.filter(
  (category): category is AutomationPositionedBlockedCategoryV1 =>
    !AUTOMATION_POSITIONLESS_BLOCKED_CATEGORIES.includes(category as AutomationPositionlessBlockedCategoryV1),
);
const positionedBlockedV1Schema = z.object({
  category: z.enum(positionedBlockedCategories), reasons: z.array(boundedText).min(1),
}).strict();
const positionlessBlockedV1Schema = z.object({
  category: z.enum(AUTOMATION_POSITIONLESS_BLOCKED_CATEGORIES), reasons: z.array(boundedText).min(1),
}).strict();

const commonShape = {
  schema_version: z.literal("1"), task_id: taskSlugV1Schema, observation_id: digest,
  state_revision: revision.nullable(), position: workflowPositionV1Schema,
} as const;
const positionlessCommonShape = { ...commonShape, position: z.null() } as const;
const withoutIdCommonShape = {
  schema_version: z.literal("1"), task_id: taskSlugV1Schema,
  state_revision: revision.nullable(), position: workflowPositionV1Schema,
} as const;
const positionlessWithoutIdCommonShape = { ...withoutIdCommonShape, position: z.null() } as const;

export const automationStatusV1Schema = z.xor([
  z.object({ ...commonShape, condition: z.literal("awaiting-client"), next_action: skillActionV1Schema }).strict(),
  z.object({ ...commonShape, condition: z.literal("awaiting-human"), next_action: humanActionV1Schema, human_boundary: automationHumanBoundaryV1Schema }).strict(),
  z.object({ ...commonShape, condition: z.literal("ready"), next_action: launchActionV1Schema }).strict(),
  z.object({ ...commonShape, condition: z.literal("blocked"), next_action: repairActionV1Schema, blocked: positionedBlockedV1Schema }).strict(),
  z.object({ ...positionlessCommonShape, condition: z.literal("blocked"), next_action: repairActionV1Schema, blocked: positionlessBlockedV1Schema }).strict(),
  z.object({ ...commonShape, condition: z.literal("complete"), next_action: noneActionV1Schema }).strict(),
]) as unknown as z.ZodType<AutomationStatusV1>;

export const automationStatusWithoutIdV1Schema = z.xor([
  z.object({ ...withoutIdCommonShape, condition: z.literal("awaiting-client"), next_action: skillActionV1Schema }).strict(),
  z.object({ ...withoutIdCommonShape, condition: z.literal("awaiting-human"), next_action: humanActionV1Schema, human_boundary: automationHumanBoundaryV1Schema }).strict(),
  z.object({ ...withoutIdCommonShape, condition: z.literal("ready"), next_action: launchActionV1Schema }).strict(),
  z.object({ ...withoutIdCommonShape, condition: z.literal("blocked"), next_action: repairActionV1Schema, blocked: positionedBlockedV1Schema }).strict(),
  z.object({ ...positionlessWithoutIdCommonShape, condition: z.literal("blocked"), next_action: repairActionV1Schema, blocked: positionlessBlockedV1Schema }).strict(),
  z.object({ ...withoutIdCommonShape, condition: z.literal("complete"), next_action: noneActionV1Schema }).strict(),
]) as unknown as z.ZodType<AutomationStatusWithoutIdV1>;

const authorityV1Schema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("readable"), repository_identity_digest: digest, state_document_digest: digest, live_config_digest: digest.nullable(), semantic_snapshot_digest: digest }).strict(),
  z.object({ kind: z.literal("absent"), repository_identity_digest: digest, live_config_digest: digest.nullable() }).strict(),
  z.object({ kind: z.literal("staged"), repository_identity_digest: digest, classification: z.enum(["current", "restart-required"]), identity_digest: digest, live_config_digest: digest.nullable() }).strict(),
  z.object({ kind: z.literal("unreadable"), repository_identity_digest: digest, classification: z.enum(["invalid", "noncanonical"]), identity_digest: digest, live_config_digest: digest.nullable() }).strict(),
]) as unknown as z.ZodType<AutomationObservationAuthorityV1>;

/** Creates a validated cache identity. The digest is observational and grants no mutation authority. */
export function createAutomationStatus(
  document: AutomationStatusWithoutIdV1,
  authority: AutomationObservationAuthorityV1,
): AutomationStatusV1 {
  assertPlainJson(document, "automation status without observation id");
  assertPlainJson(authority, "automation observation authority");
  const observed = automationStatusWithoutIdV1Schema.parse(structuredClone(document));
  const identity = authorityV1Schema.parse(structuredClone(authority));
  const observation_id = canonicalJsonDigest({
    schema_version: "1",
    purpose: "archflow-automation-observation-v1",
    observation: observed,
    authority: identity,
  } as unknown as PlainJsonValue);
  return Object.freeze(automationStatusV1Schema.parse({ ...observed, observation_id }));
}

export function parseAutomationStatus(value: unknown): AutomationStatusV1 {
  assertPlainJson(value, "automation status");
  return automationStatusV1Schema.parse(structuredClone(value));
}

import { z } from "zod";

import { assertPlainJson } from "./plain-json.js";
import type { RuleVersionRef } from "./review.js";

export const COMPLIANCE_RESULTS = ["pass", "fail", "uncertain"] as const;
export const TRIGGER_RESULTS = ["not-matched", "matched", "uncertain"] as const;

export type ComplianceResult = (typeof COMPLIANCE_RESULTS)[number];
export type TriggerResult = (typeof TRIGGER_RESULTS)[number];

export type AdjudicationJudgmentV2 = {
  readonly compliance: ComplianceResult;
  readonly rationale: string;
  readonly trigger: TriggerResult;
  readonly trigger_evidence: string;
};

/** The complete fresh child output. It deliberately carries no server or rule identity. */
export type RawAdjudicationV2 = {
  readonly schema_version: "2";
  readonly judgments: Readonly<Record<string, AdjudicationJudgmentV2>>;
};

export type AdjudicationRuleSlotV1 = RuleVersionRef & {
  readonly slot: string;
};

const nonBlank = z.string().min(1).regex(/\S/, "must contain a non-whitespace character");
const id = z.string().regex(/^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/u);
const opaqueSlot = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u);
const ruleVersionSchema = z.object({ rule_id: id, rule_version: z.number().int().positive().safe() }).strict();
export const adjudicationJudgmentV2Schema = z.object({
  compliance: z.enum(COMPLIANCE_RESULTS),
  rationale: nonBlank,
  trigger: z.enum(TRIGGER_RESULTS),
  trigger_evidence: nonBlank,
}).strict();

export const adjudicationRuleSlotV1Schema = ruleVersionSchema.extend({ slot: opaqueSlot }).strict();

function materializeRuleSlots(value: readonly AdjudicationRuleSlotV1[]): readonly AdjudicationRuleSlotV1[] {
  assertPlainJson(value, "adjudication rule slots");
  const parsed = z.array(adjudicationRuleSlotV1Schema).min(1).parse(structuredClone(value));
  const slots = parsed.map((entry) => entry.slot);
  if (new Set(slots).size !== slots.length) throw new TypeError("adjudication rule slots must be unique");
  const ruleKeys = parsed.map((entry) => `${entry.rule_id}:${entry.rule_version}`);
  if (new Set(ruleKeys).size !== ruleKeys.length || ruleKeys.some((value, index) => index > 0 && ruleKeys[index - 1]!.localeCompare(value) >= 0)) {
    throw new TypeError("adjudication rule slots must follow canonical unique rule order");
  }
  return parsed;
}

function rawAdjudicationV2SchemaFromMaterializedSlots(slots: readonly AdjudicationRuleSlotV1[]) {
  return createAdjudicationOutputSchema(slots.map(entry => entry.slot));
}

/** Child-visible contract shared by prompt generation and authenticated rule-plan validation. */
export function createAdjudicationOutputSchema(slotNames: readonly string[]): z.ZodType<RawAdjudicationV2> {
  const slots = z.array(opaqueSlot).min(1).parse(slotNames);
  if (new Set(slots).size !== slots.length) throw new TypeError("adjudication rule slots must be unique");
  const judgments = Object.fromEntries(slots.map(slot => [slot, adjudicationJudgmentV2Schema]));
  return z.object({ schema_version: z.literal("2"), judgments: z.object(judgments).strict() }).strict() as z.ZodType<RawAdjudicationV2>;
}

/** Builds the child-visible strict dynamic-slot root for one immutable server plan. */
export function createRawAdjudicationV2Schema(slots: readonly AdjudicationRuleSlotV1[]): z.ZodType<RawAdjudicationV2> {
  return rawAdjudicationV2SchemaFromMaterializedSlots(materializeRuleSlots(slots));
}

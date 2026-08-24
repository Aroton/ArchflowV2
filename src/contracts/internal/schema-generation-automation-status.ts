import { automationHumanBoundaryV1Schema, automationStatusV1Schema } from "../automation-status.js";
import { SCHEMA_IDS } from "../versions.js";
import type { SchemaGenerationGroup } from "./schema-generation.js";

const TEXT = { type: "string", minLength: 1, maxLength: 4096, pattern: "\\S" } as const;

const reason = (reasonClass: Readonly<Record<string, unknown>>) => ({
  type: "object",
  properties: { class: reasonClass, text: TEXT },
  required: ["class", "text"],
  additionalProperties: false,
});

const configuredReason = reason({ const: "configured-approval" });
const anyReason = reason({ enum: ["configured-approval", "exception"] });
const exceptionalReasonMatch = {
  type: "object",
  properties: { class: { const: "exception" } },
  required: ["class"],
} as const;
const reasonsContainingException = {
  type: "array",
  minItems: 1,
  items: anyReason,
  contains: exceptionalReasonMatch,
  minContains: 1,
} as const;

const presentation = (
  aggregateClass: "configured-approval" | "exception",
  reasons: Readonly<Record<string, unknown>>,
) => ({
  type: "object",
  properties: {
    source: { const: "presentation" },
    class: { const: aggregateClass },
    headline: TEXT,
    summary: TEXT,
    question: TEXT,
    reasons,
  },
  required: ["source", "class", "headline", "summary", "question", "reasons"],
  additionalProperties: false,
});

/**
 * Zod cannot emit `superRefine` as JSON Schema. This document-owned fragment is the exact
 * structural equivalent: configured boundaries contain only configured reasons, while exception
 * and dispatch boundaries contain at least one exceptional reason in any array position.
 */
const AUTOMATION_HUMAN_BOUNDARY_FRAGMENT = {
  oneOf: [
    presentation("configured-approval", { type: "array", minItems: 1, items: configuredReason }),
    presentation("exception", reasonsContainingException),
    {
      type: "object",
      properties: {
        source: { const: "dispatch-failure" },
        class: { const: "exception" },
        headline: TEXT,
        summary: TEXT,
        question: TEXT,
        reasons: reasonsContainingException,
        failed_role: { enum: ["counter-reviewer", "adjudicator"] },
        failure_code: { type: "string", minLength: 1, maxLength: 128, pattern: "\\S" },
      },
      required: ["source", "class", "headline", "summary", "question", "reasons", "failed_role", "failure_code"],
      additionalProperties: false,
    },
  ],
} as const;

export const automationStatusSchemaGroup: SchemaGenerationGroup = {
  group: "automation-status",
  documents: [{
    file: "automation-status",
    id: SCHEMA_IDS.automationStatus,
    root: automationStatusV1Schema,
    defs: { humanBoundary: automationHumanBoundaryV1Schema },
    overrides: { humanBoundary: AUTOMATION_HUMAN_BOUNDARY_FRAGMENT },
    migrated: true,
  }],
};

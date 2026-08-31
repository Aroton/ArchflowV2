import {
  applySubmissionV1Schema,
  archFlowApplyInputV1Schema,
  archFlowStatusInputV1Schema,
  configChangeEntryV1Schema,
  configChangeValueV1Schema,
  implementationRecommendationV1Schema,
  publicFindingV1Schema,
  repositoryStatusV1Schema,
  semanticNextActionV1Schema,
  semanticErrorSummaryV1Schema,
  semanticFailureV1Schema,
  semanticResultV1Schema,
  semanticSuccessV1Schema,
  workflowInvocationV1Schema,
  workflowPositionV1Schema,
  workflowReviewModelRouteV1Schema,
  workflowReviewRoutesV1Schema,
  workflowResourceV1Schema,
  workflowRepositoryNameV1Schema,
  workflowViewV1Schema,
} from "../semantic-workflow.js";
import { DISPATCH_FAILURE_CODES, publicDispatchFailureV1Schema } from "../dispatch-failure.js";
import { SCHEMA_IDS } from "../versions.js";
import { PLAIN_JSON_FRAGMENT } from "./schema-generation-durable.js";
import type { SchemaGenerationGroup } from "./schema-generation.js";

/**
 * Zod emits the shared optional route set inline in every discriminated-union arm. The runtime
 * parser remains the authority; this equivalent nested fragment keeps MCP advertisements below
 * their context budget while retaining a plain object at each advertised tool root.
 */
const WORKFLOW_INVOCATION_FRAGMENT = {
  type: "object",
  properties: {
    skill: {
      enum: ["archflow-prd", "archflow-design", "archflow-phase-design", "archflow-phase-impl"],
    },
    phase: { $ref: `${SCHEMA_IDS.primitives}#/$defs/positiveSafePhaseNumber` },
    intent: { enum: ["resume", "reopen"] },
    review_routes: { $ref: "#/$defs/reviewRouteSet" },
  },
  required: ["skill", "intent"],
  additionalProperties: false,
  allOf: [
    {
      if: { properties: { skill: { enum: ["archflow-phase-design", "archflow-phase-impl"] } } },
      then: { properties: { phase: {} }, required: ["phase"] },
      else: { not: { properties: { phase: {} }, required: ["phase"] } },
    },
    {
      if: { properties: { skill: { const: "archflow-phase-impl" } } },
      then: { properties: { intent: { const: "resume" } } },
    },
  ],
} as const;

const REVIEW_ROUTE_SET_FRAGMENT = {
  type: "object",
  minProperties: 1,
  properties: {
    "counter-reviewer": { $ref: "#/$defs/reviewModelRoute" },
    adjudicator: { $ref: "#/$defs/reviewModelRoute" },
  },
  additionalProperties: false,
} as const;

const REVIEW_MODEL_ROUTE_FRAGMENT = {
  type: "object",
  properties: {
    model: { type: "string", pattern: "\\S" },
    effort: { enum: ["low", "medium", "high", "xhigh", "max", "ultra"] },
    provider: { type: "string", pattern: "\\S" },
  },
  required: ["model", "effort"],
  additionalProperties: false,
} as const;

const PUBLIC_DISPATCH_FAILURE_FRAGMENT = {
  type: "object",
  properties: {
    role: { enum: ["counter-reviewer", "adjudicator"] },
    code: { enum: DISPATCH_FAILURE_CODES },
    message: { type: "string", minLength: 1, maxLength: 256 },
    repository_name: {
      anyOf: [
        { type: "string", const: "primary" },
        { type: "string", pattern: "^(?!primary$)(?!(?:[Cc][Oo][Nn]|[Pp][Rr][Nn]|[Aa][Uu][Xx]|[Nn][Uu][Ll]|[Cc][Oo][Mm][1-9]|[Ll][Pp][Tt][1-9])(?:\\.[^/]*)?$)(?!.*[. ]$)[a-z0-9][a-z0-9._-]{0,63}$" },
      ],
    },
    route: {
      type: "object",
      properties: {
        model: { type: "string", pattern: "\\S" },
        effort: { enum: ["low", "medium", "high", "xhigh", "max", "ultra"] },
        provider: { type: "string", pattern: "\\S" },
        source: { enum: ["configured", "invocation-declared", "route-override"] },
      },
      required: ["model", "effort", "source"],
      additionalProperties: false,
    },
  },
  required: ["role", "code", "message"],
  additionalProperties: false,
  // The `repository_name`-iff-`REPOSITORY_VIEW_UNAVAILABLE` rule is published on the leaf
  // `dispatch-failure` document (`REPOSITORY_NAME_PRESENCE_RULE`); it is left off this advertised
  // fragment to stay inside the MCP advertisement byte budget. Zod remains the runtime authority.
} as const;

/** Compact public semantic workflow contract; neither tool is advertised until Phase 2. */
export const semanticWorkflowSchemaGroup: SchemaGenerationGroup = {
  group: "semantic-workflow",
  documents: [{
    file: "semantic-workflow",
    id: SCHEMA_IDS.semanticWorkflow,
    root: workflowViewV1Schema,
    defs: {
      workflowResource: workflowResourceV1Schema,
      publicFinding: publicFindingV1Schema,
      repositoryStatus: repositoryStatusV1Schema,
      workflowPosition: workflowPositionV1Schema,
      reviewModelRoute: workflowReviewModelRouteV1Schema,
      reviewRouteSet: workflowReviewRoutesV1Schema,
      workflowInvocation: workflowInvocationV1Schema,
      semanticNextAction: semanticNextActionV1Schema,
      workflowView: workflowViewV1Schema,
      implementationRecommendation: implementationRecommendationV1Schema,
      publicDispatchFailure: publicDispatchFailureV1Schema,
      configChangeEntry: configChangeEntryV1Schema,
      plainJson: configChangeValueV1Schema,
      repositoryName: workflowRepositoryNameV1Schema,
      applySubmission: applySubmissionV1Schema,
      statusInput: archFlowStatusInputV1Schema,
      applyInput: archFlowApplyInputV1Schema,
      semanticErrorSummary: semanticErrorSummaryV1Schema,
      semanticSuccess: semanticSuccessV1Schema,
      semanticFailure: semanticFailureV1Schema,
      semanticResult: semanticResultV1Schema,
    },
    // Same verbatim fragment as `task-state`'s and `intent-receipt`'s `plainJson` defs: `z.json()`'s
    // own emission cannot live in a `$def` (see schema-generation-durable.ts).
    overrides: {
      publicDispatchFailure: PUBLIC_DISPATCH_FAILURE_FRAGMENT,
      reviewModelRoute: REVIEW_MODEL_ROUTE_FRAGMENT,
      reviewRouteSet: REVIEW_ROUTE_SET_FRAGMENT,
      workflowInvocation: WORKFLOW_INVOCATION_FRAGMENT,
      plainJson: PLAIN_JSON_FRAGMENT,
    },
    migrated: true,
  }],
};

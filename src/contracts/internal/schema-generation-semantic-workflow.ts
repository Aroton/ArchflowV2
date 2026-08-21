import {
  applySubmissionV1Schema,
  archFlowApplyInputV1Schema,
  archFlowStatusInputV1Schema,
  configChangeEntryV1Schema,
  configChangeValueV1Schema,
  publicFindingV1Schema,
  semanticNextActionV1Schema,
  semanticErrorSummaryV1Schema,
  semanticFailureV1Schema,
  semanticResultV1Schema,
  semanticSuccessV1Schema,
  workflowInvocationV1Schema,
  workflowPositionV1Schema,
  workflowResourceV1Schema,
  workflowViewV1Schema,
} from "../semantic-workflow.js";
import { SCHEMA_IDS } from "../versions.js";
import { PLAIN_JSON_FRAGMENT } from "./schema-generation-durable.js";
import type { SchemaGenerationGroup } from "./schema-generation.js";

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
      workflowPosition: workflowPositionV1Schema,
      workflowInvocation: workflowInvocationV1Schema,
      semanticNextAction: semanticNextActionV1Schema,
      workflowView: workflowViewV1Schema,
      configChangeEntry: configChangeEntryV1Schema,
      plainJson: configChangeValueV1Schema,
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
    overrides: { plainJson: PLAIN_JSON_FRAGMENT },
    migrated: true,
  }],
};

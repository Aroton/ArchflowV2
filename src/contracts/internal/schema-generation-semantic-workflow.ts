import {
  applySubmissionV1Schema,
  archFlowApplyInputV1Schema,
  archFlowStatusInputV1Schema,
  publicFindingV1Schema,
  semanticNextActionV1Schema,
  workflowInvocationV1Schema,
  workflowPositionV1Schema,
  workflowResourceV1Schema,
  workflowViewV1Schema,
} from "../semantic-workflow.js";
import { SCHEMA_IDS } from "../versions.js";
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
      applySubmission: applySubmissionV1Schema,
      statusInput: archFlowStatusInputV1Schema,
      applyInput: archFlowApplyInputV1Schema,
    },
    migrated: true,
  }],
};

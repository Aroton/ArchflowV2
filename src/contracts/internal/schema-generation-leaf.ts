import { z } from "zod";

import { adjudicationDocumentDefs, adjudicationEvidenceSchema, rawAdjudicationSchema } from "../adjudication.js";
import { gitOidV1Schema } from "../canonical.js";
import { configOverridesSchema, configRolesSchema, configRouteSchema, configV1Schema } from "../config.js";
import { constitutionRuleV1Schema } from "../constitution.js";
import { dispatchFailureObservationV1Schema } from "../dispatch-failure.js";
import {
  pathSafeIdV1Schema,
  safeCodeV1Schema,
  safeIdV1Schema,
  safeIntegerV1Schema,
  safeVersionV1Schema,
  sha256DigestV1Schema,
  taskSlugV1Schema,
} from "../evidence.js";
import { resultExpectationDataSchema } from "../mcp-tools.js";
import { pathClaimLexicalV1Schema, repositoryPathClaimV1Schema, taskPathClaimV1Schema } from "../path-claims.js";
import { phaseInstanceIdV1Schema, phaseInstanceV1Schema, positiveSafePhaseNumberV1Schema } from "../phase-instance.js";
import { rawReviewSchema, reviewDocumentDefs, reviewEvidenceSchema } from "../review.js";
import { rubricV1Schema } from "../rubric.js";
import { secretFindingV1Schema, secretScanResultV1Schema } from "../secret-scan.js";
import { triageCandidateSchema } from "../triage.js";
import {
  counterOnlySlotsSchema,
  counterSlotSchema,
  requiredReviewSlotsSchema,
} from "../trust.js";
import { SCHEMA_IDS } from "../versions.js";
import { workflowPhasesV1Schema, workflowV1Schema } from "../workflow.js";
import type { SchemaGenerationGroup } from "./schema-generation.js";

/** `primitives.schema.json` is a pure `$defs` inventory; its root carries no keywords at all. */
const primitivesRoot = z.any();

/** Emitted verbatim: both branded claim frames are the whole `path-claim` document by reference. */
const pathClaimReference = { $ref: SCHEMA_IDS.pathClaim } as const;

/**
 * Emitted verbatim in place of the structural `workflowPhasesV1Schema` def: Zod cannot express
 * object consts, and emitting the unpinned phase shape would weaken the published document. The
 * Zod authority pins the identical graph through `workflowV1Schema`'s `superRefine` against
 * `WORKFLOW_V1`, so drift between the two is caught by the workflow agreement test.
 */
const pinnedWorkflowPhases = {
  type: "array",
  minItems: 5,
  maxItems: 5,
  prefixItems: [
    { const: { id: "explore", skill: "archflow-explore", pipeline: ["produce"], gate: "never", optional: true } },
    { const: { id: "prd", skill: "archflow-prd", pipeline: ["produce", "counter_review", "triage"], gate: "always" } },
    { const: { id: "design", skill: "archflow-design", requires: ["prd"], pipeline: ["produce", "counter_review", "triage"], gate: "always" } },
    { const: { id: "phase-design", skill: "archflow-phase-design", requires: ["design"], iterates: "per_phase", pipeline: ["produce", "counter_review", "triage"], gate: "on_trigger" } },
    { const: { id: "phase-impl", skill: "archflow-phase-impl", requires: ["phase-design"], iterates: "per_phase", pipeline: ["produce", "counter_review", "triage"], gate: "on_trigger" } },
  ],
} as const;

/**
 * Emitted verbatim because Zod tuple emission drops the exact-length bounds
 * (`minItems`/`maxItems`), and the gate documents that reference this schema still validate
 * through Ajv, so the bounds must stay in the published document.
 */
const counterOnlySlots = {
  type: "array",
  prefixItems: [{ $ref: "#/$defs/counter" }],
  minItems: 1,
  maxItems: 1,
} as const;
/**
 * Leaf shapes — the schemas with no durable-state, gate, error, or MCP-envelope role: primitives,
 * path-claim, evidence-slots, rubric, triage, config, workflow, constitution-rule, phase-instance,
 * review, review-evidence, adjudication, adjudication-evidence, secret-scan-result, and
 * result-expectation. Documents join this
 * list as their runtime authority flips from Ajv to their Zod source.
 */
export const leafSchemaGroup: SchemaGenerationGroup = {
  group: "leaf",
  documents: [
    {
      file: "primitives",
      id: SCHEMA_IDS.primitives,
      root: primitivesRoot,
      defs: {
        positiveSafePhaseNumber: positiveSafePhaseNumberV1Schema,
        phaseInstanceId: phaseInstanceIdV1Schema,
        safeInteger: safeIntegerV1Schema,
        sha256Digest: sha256DigestV1Schema,
        gitOid: gitOidV1Schema,
        safeId: safeIdV1Schema,
        pathSafeId: pathSafeIdV1Schema,
        taskSlug: taskSlugV1Schema,
        repositoryPathClaim: repositoryPathClaimV1Schema,
        taskPathClaim: taskPathClaimV1Schema,
        safeCode: safeCodeV1Schema,
        safeVersion: safeVersionV1Schema,
      },
      overrides: {
        repositoryPathClaim: pathClaimReference,
        taskPathClaim: pathClaimReference,
      },
      migrated: true,
    },
    {
      file: "path-claim",
      id: SCHEMA_IDS.pathClaim,
      root: pathClaimLexicalV1Schema,
      migrated: true,
    },
    {
      file: "phase-instance",
      id: SCHEMA_IDS.phaseInstance,
      root: phaseInstanceV1Schema,
      migrated: true,
    },
    {
      file: "workflow",
      id: SCHEMA_IDS.workflow,
      root: workflowV1Schema,
      defs: { phases: workflowPhasesV1Schema },
      overrides: { phases: pinnedWorkflowPhases },
      migrated: true,
    },
    {
      file: "config",
      id: SCHEMA_IDS.config,
      root: configV1Schema,
      defs: {
        route: configRouteSchema,
        roles: configRolesSchema,
        overrides: configOverridesSchema,
      },
      migrated: true,
    },
    {
      file: "rubric",
      id: SCHEMA_IDS.rubric,
      root: rubricV1Schema,
      migrated: true,
    },
    {
      file: "constitution-rule",
      id: SCHEMA_IDS.constitutionRule,
      root: constitutionRuleV1Schema,
      migrated: true,
    },
    {
      file: "review",
      id: SCHEMA_IDS.review,
      root: rawReviewSchema,
      defs: reviewDocumentDefs,
      migrated: true,
    },
    {
      file: "review-evidence",
      id: SCHEMA_IDS.reviewEvidence,
      root: reviewEvidenceSchema,
      migrated: true,
    },
    {
      file: "adjudication",
      id: SCHEMA_IDS.adjudication,
      root: rawAdjudicationSchema,
      defs: adjudicationDocumentDefs,
      migrated: true,
    },
    {
      file: "adjudication-evidence",
      id: SCHEMA_IDS.adjudicationEvidence,
      root: adjudicationEvidenceSchema,
      migrated: true,
    },
    {
      file: "evidence-slots",
      id: SCHEMA_IDS.evidenceSlots,
      root: requiredReviewSlotsSchema,
      defs: {
        counter: counterSlotSchema,
        counterOnly: counterOnlySlotsSchema,
      },
      overrides: {
        counterOnly: counterOnlySlots,
      },
      migrated: true,
    },
    {
      file: "triage",
      id: SCHEMA_IDS.triage,
      root: triageCandidateSchema,
      migrated: true,
    },
    {
      file: "secret-scan-result",
      id: SCHEMA_IDS.secretScanResult,
      root: secretScanResultV1Schema,
      defs: { finding: secretFindingV1Schema },
      migrated: true,
    },
    {
      file: "result-expectation",
      id: SCHEMA_IDS.resultExpectation,
      root: resultExpectationDataSchema,
      migrated: true,
    },
    {
      file: "dispatch-failure",
      id: SCHEMA_IDS.dispatchFailure,
      root: dispatchFailureObservationV1Schema,
      migrated: true,
    },
  ],
};

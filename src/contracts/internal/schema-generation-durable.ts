import { z } from "zod";

import { documentArtifactV1Schema } from "../durable-document.js";
import { implementationOutputV1Schema, parentDocumentRefV1Schema, undeclaredChangeReportV1Schema } from "../durable-implementation-output.js";
import { intentReceiptV1Schema, plainJsonV1Schema } from "../durable-intent.js";
import { legacyImportInitializationV1Schema, legacyMappingEntryV1Schema, stagedPayloadRefV1Schema } from "../durable-legacy-import.js";
import { maintenanceDeletionV1Schema, maintenanceRecordV1Schema } from "../durable-maintenance.js";
import {
  blobIdentityV1Schema,
  blobTreeModeV1Schema,
  canonicalTaskPathsV1Schema,
  claimableOutputPathClassV1Schema,
  declaredInputRefV1Schema,
  outputEntryV1Schema,
  projectionDigestRefV1Schema,
  regularBlobIdentityV1Schema,
  snapshotAccountingEntryV1Schema,
  snapshotAccountingV1Schema,
  symlinkBlobIdentityV1Schema,
} from "../durable-primitives.js";
import {
  adjudicationEvidenceArtifactV1Schema,
  resultManifestV1Schema,
  reviewEvidenceArtifactV1Schema,
  triageArtifactV1Schema,
} from "../durable-result-manifest.js";
import {
  adoptedCheckpointRefV1Schema,
  approvalRefV1Schema,
  authoritativeResultRefV1Schema,
  committedIntentRefV1Schema,
  gateKindV1Schema,
  openGateRefV1Schema,
  stepStatusV1Schema,
  taskStateV1Schema,
  waiverRefV1Schema,
} from "../durable-state.js";
import { taskInitializationV1Schema } from "../durable-task-initialization.js";
import { SCHEMA_IDS } from "../versions.js";
import type { SchemaGenerationGroup } from "./schema-generation.js";

/**
 * `z.json()`'s own emission self-references the document root (`"$ref": "#"`), which is wrong once
 * the value lives in a `$def`, so the committed recursive fragment is emitted verbatim. Its
 * `null`-first arm order is pinned by the null-usage sweep in `durable-agreement.test.ts`.
 */
const PLAIN_JSON_FRAGMENT = {
  anyOf: [
    { type: "null" },
    { type: "boolean" },
    { type: "number" },
    { type: "string" },
    { type: "array", items: { $ref: "#/$defs/plainJson" } },
    { type: "object", additionalProperties: { $ref: "#/$defs/plainJson" } },
  ],
} as const;

/**
 * Durable-state shapes. `durable-primitives` declares no root document of its own — every shape is
 * reached by `$ref` — so its root is an unconstrained placeholder that emits an empty body.
 */
export const durableSchemaGroup: SchemaGenerationGroup = {
  group: "durable",
  documents: [
    {
      file: "durable-primitives",
      id: SCHEMA_IDS.durablePrimitives,
      root: z.any(),
      defs: {
        blobTreeMode: blobTreeModeV1Schema,
        regularBlobIdentity: regularBlobIdentityV1Schema,
        symlinkBlobIdentity: symlinkBlobIdentityV1Schema,
        blobIdentity: blobIdentityV1Schema,
        claimableOutputPathClass: claimableOutputPathClassV1Schema,
        declaredInputRef: declaredInputRefV1Schema,
        canonicalTaskPaths: canonicalTaskPathsV1Schema,
        snapshotAccountingEntry: snapshotAccountingEntryV1Schema,
        snapshotAccounting: snapshotAccountingV1Schema,
        outputEntry: outputEntryV1Schema,
      },
      migrated: true,
    },
    {
      file: "task-state",
      id: SCHEMA_IDS.taskState,
      root: taskStateV1Schema,
      defs: {
        stepStatus: stepStatusV1Schema,
        gateKind: gateKindV1Schema,
        authoritativeResultRef: authoritativeResultRefV1Schema,
        approvalRef: approvalRefV1Schema,
        waiverRef: waiverRefV1Schema,
        openGateRef: openGateRefV1Schema,
        committedIntentRef: committedIntentRefV1Schema,
        adoptedCheckpointRef: adoptedCheckpointRefV1Schema,
      },
      migrated: true,
    },
    {
      file: "intent-receipt",
      id: SCHEMA_IDS.intentReceipt,
      root: intentReceiptV1Schema,
      defs: { plainJson: plainJsonV1Schema },
      overrides: { plainJson: PLAIN_JSON_FRAGMENT },
      migrated: true,
    },
    {
      file: "maintenance-record",
      id: SCHEMA_IDS.maintenanceRecord,
      root: maintenanceRecordV1Schema,
      defs: { maintenanceDeletion: maintenanceDeletionV1Schema },
      migrated: true,
    },
    {
      file: "task-initialization",
      id: SCHEMA_IDS.taskInitialization,
      root: taskInitializationV1Schema,
      migrated: true,
    },
    {
      file: "legacy-import-initialization",
      id: SCHEMA_IDS.legacyImportInitialization,
      root: legacyImportInitializationV1Schema,
      defs: {
        legacyMappingEntry: legacyMappingEntryV1Schema,
        stagedPayloadRef: stagedPayloadRefV1Schema,
      },
      migrated: true,
    },
    {
      file: "document-artifact",
      id: SCHEMA_IDS.documentArtifact,
      root: documentArtifactV1Schema,
      migrated: true,
    },
    {
      file: "implementation-output",
      id: SCHEMA_IDS.implementationOutput,
      root: implementationOutputV1Schema,
      defs: {
        parentDocumentRef: parentDocumentRefV1Schema,
        undeclaredChangeReport: undeclaredChangeReportV1Schema,
      },
      migrated: true,
    },
    {
      file: "result-manifest",
      id: SCHEMA_IDS.resultManifest,
      root: resultManifestV1Schema,
      defs: {
        reviewEvidenceArtifact: reviewEvidenceArtifactV1Schema,
        triageArtifact: triageArtifactV1Schema,
        adjudicationEvidenceArtifact: adjudicationEvidenceArtifactV1Schema,
        projectionDigestRef: projectionDigestRefV1Schema,
      },
      migrated: true,
    },
  ],
};

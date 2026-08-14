import {
  activeGateSchemaDefOverrides,
  activeGateSchemaDefs,
  activeGateV1Schema,
  gateDecisionRecordSchemaDefs,
  gateDecisionRecordV1Schema,
  gateRequestSchemaDefOverrides,
  gateRequestSchemaDefs,
  gateRequestV1Schema,
} from "../durable-gate.js";
import {
  gateContractSchemaDefs,
  gateContractV1Schema,
  gateDecisionEnvelopeV1Schema,
  gateDecisionSchemaDefs,
} from "../gates.js";
import { SCHEMA_IDS } from "../versions.js";
import type { SchemaGenerationGroup } from "./schema-generation.js";

/**
 * Gate shapes. `gate-contract` and `gate-decision` come first so the request, record, and active
 * documents can `$ref` the shared context, decision, and provenance defs they publish —
 * `mcp-tools.schema.json` also reaches `gate-contract#/$defs/<arm>/properties/context` and
 * `gate-decision#/$defs/connected|local`, so those def names are pinned.
 */
export const gateSchemaGroup: SchemaGenerationGroup = {
  group: "gate",
  documents: [
    {
      file: "gate-contract",
      id: SCHEMA_IDS.gateContract,
      root: gateContractV1Schema,
      defs: gateContractSchemaDefs,
      migrated: true,
    },
    {
      file: "gate-decision",
      id: SCHEMA_IDS.gateDecision,
      root: gateDecisionEnvelopeV1Schema,
      defs: gateDecisionSchemaDefs,
      migrated: true,
    },
    {
      file: "gate-request",
      id: SCHEMA_IDS.gateRequest,
      root: gateRequestV1Schema,
      defs: gateRequestSchemaDefs,
      overrides: gateRequestSchemaDefOverrides,
      migrated: true,
    },
    {
      file: "gate-decision-record",
      id: SCHEMA_IDS.gateDecisionRecord,
      root: gateDecisionRecordV1Schema,
      defs: gateDecisionRecordSchemaDefs,
      migrated: true,
    },
    {
      file: "active-gate",
      id: SCHEMA_IDS.activeGate,
      root: activeGateV1Schema,
      defs: activeGateSchemaDefs,
      overrides: activeGateSchemaDefOverrides,
      migrated: true,
    },
  ],
};

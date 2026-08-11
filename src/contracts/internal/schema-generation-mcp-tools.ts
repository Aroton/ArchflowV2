import { z, type ZodType } from "zod";

import {
  counterReviewInputSchema,
  gateInputSchema,
  mcpToolsSchemaDefs,
  stateInputSchema,
  toolSuccessSchemas,
  waiverInputSchema,
} from "../mcp-tools.js";
import { requiredReviewSlotsSchema } from "../trust.js";
import { SCHEMA_IDS } from "../versions.js";
import { serializedProjectErrorV1Schema } from "./schema-generation-errors.js";
import type { GeneratedDefOverride, SchemaGenerationGroup } from "./schema-generation.js";

const digest = mcpToolsSchemaDefs.digest as ZodType;
const stagedReference = mcpToolsSchemaDefs.stagedReference as ZodType;

/**
 * Structural mirror of `currentEvidenceSetRefSchema` in `trust.js`, built from this document's
 * own `digest` def so the emission references `#/$defs/digest` and the shared evidence-slots
 * document. `parseCurrentEvidenceSetRef` stays the runtime authority (it adds the set-digest and
 * slot semantics no structural schema can carry); agreement between the two is held by the
 * mcp-tools fixture corpus, which exercises the committed bytes against the runtime parsers.
 */
const currentEvidence = z.object({ set_digest: digest, slots: requiredReviewSlotsSchema }).strict();

/** The failure envelope every tool result union shares; the error body is the project-error document root. */
const failure = z.object({ schema_version: z.literal("1"), ok: z.literal(false), error: serializedProjectErrorV1Schema }).strict();

/**
 * Per-tool input contract: the full payload first, then the staged-request reference arm —
 * `src/mcp/tools.ts` pins that order when it merges the branches into the advertised flat root.
 */
const inputContract = (fullPayload: ZodType): ZodType => z.union([fullPayload, stagedReference]);
const resultContract = (success: ZodType): ZodType =>
  z.union([failure, z.object({ schema_version: z.literal("1"), ok: z.literal(true), value: success }).strict()]);

const inputContracts = {
  archflow_state: inputContract(stateInputSchema),
  archflow_counter_review: inputContract(counterReviewInputSchema),
  archflow_gate: inputContract(gateInputSchema),
  archflow_waiver: inputContract(waiverInputSchema),
} as const;

/**
 * The document root: any tool input. The `x-archflow-mcp-semantics` keyword rides on `.meta` so
 * the committed document keeps declaring the cross-field input semantics (current-evidence
 * exactness, gate context/kind agreement, waiver origin-task agreement) that a strict Ajv
 * consumer can still enforce by registering the keyword (the test compiler in
 * `test/helpers/json-schema.ts` does); the Zod parsers remain the runtime authority for the
 * same rules.
 */
const mcpToolsDocumentRoot = z.union([
  inputContracts.archflow_state,
  inputContracts.archflow_counter_review,
  inputContracts.archflow_gate,
  inputContracts.archflow_waiver,
]).meta({
  // Every tool input is an object; the explicit root type keeps the object-typed Ajv keyword
  // below satisfiable under strict mode, exactly as the hand-written document declared it.
  type: "object",
  "x-archflow-mcp-semantics": true,
});

const gateContractContext = (arm: string): GeneratedDefOverride =>
  ({ $ref: `urn:archflow:schema:v1:gate-contract#/$defs/${arm}/properties/context` });

/**
 * Emitted verbatim for the gate full-payload arm: its shape is a strict property table refined by
 * an `allOf`/`oneOf` kind→context pairing that keeps every common field flat while still pinning
 * the per-kind context schema — a composition `gateInputSchema` (one strict object whose
 * kind/context agreement lives in a `superRefine` on `parseGateContext`) has no emission for.
 * The nine `gate-contract#/$defs/<arm>/properties/context` pointer paths are the published
 * spellings the advertised catalogue resolves, so they are preserved byte-for-byte from the
 * hand-written document.
 */
const gateInputEmission: GeneratedDefOverride = {
  oneOf: [
    {
      type: "object",
      additionalProperties: false,
      required: [
        "schema_version",
        "task_id",
        "intent_id",
        "expected_revision",
        "input_fingerprint",
        "phase_instance",
        "summary",
        "subject_digest",
        "current_evidence",
        "kind",
        "context",
      ],
      properties: {
        schema_version: { const: "1" },
        task_id: { $ref: "urn:archflow:schema:v1:primitives#/$defs/taskSlug" },
        intent_id: { $ref: "urn:archflow:schema:v1:primitives#/$defs/pathSafeId" },
        expected_revision: { $ref: "#/$defs/integer" },
        input_fingerprint: { $ref: "#/$defs/digest" },
        phase_instance: { $ref: "#/$defs/phase" },
        summary: { $ref: "#/$defs/text" },
        subject_digest: { $ref: "#/$defs/digest" },
        current_evidence: { $ref: "#/$defs/currentEvidence" },
        supersedes: {
          type: "object",
          additionalProperties: false,
          required: ["superseded_gate_id", "accepted_triage_digest", "old_subject_digest"],
          properties: {
            superseded_gate_id: { $ref: "urn:archflow:schema:v1:primitives#/$defs/pathSafeId" },
            accepted_triage_digest: { $ref: "#/$defs/digest" },
            old_subject_digest: { $ref: "#/$defs/digest" },
          },
        },
        supplemental_outcome: { $ref: "urn:archflow:schema:v1:supplemental-review" },
        kind: {
          enum: [
            "artifact-approval",
            "review-trigger",
            "material-drift",
            "adjudication-failure",
            "attempts-exhausted",
            "constitution-edit",
            "commit-authorization",
            "restore-collision",
            "migration-audit",
          ],
        },
        context: { type: "object" },
      },
      allOf: [
        {
          oneOf: [
            { properties: { kind: { const: "artifact-approval" }, context: gateContractContext("artifactApproval") } },
            { properties: { kind: { const: "review-trigger" }, context: gateContractContext("reviewTrigger") } },
            { properties: { kind: { const: "material-drift" }, context: gateContractContext("materialDrift") } },
            { properties: { kind: { const: "adjudication-failure" }, context: gateContractContext("adjudicationFailure") } },
            { properties: { kind: { const: "attempts-exhausted" }, context: gateContractContext("attemptsExhausted") } },
            { properties: { kind: { const: "constitution-edit" }, context: gateContractContext("constitutionEdit") } },
            { properties: { kind: { const: "commit-authorization" }, context: gateContractContext("commitAuthorization") } },
            { properties: { kind: { const: "restore-collision" }, context: gateContractContext("restoreCollision") } },
            { properties: { kind: { const: "migration-audit" }, context: gateContractContext("migrationAudit") } },
          ],
        },
      ],
    },
    { $ref: "#/$defs/stagedReference" },
  ],
};

/**
 * The MCP tool-envelope document. Leaf defs come from the shared `mcpToolsSchemaDefs` instances
 * so every use site inside the tool shapes emits a local `#/$defs/<name>` reference; the
 * per-tool `input`/`success`/`result` members are published as nested defs to keep the
 * `#/$defs/<tool>/<member>` pointer paths `TOOL_DEFINITIONS`, `src/mcp/tools.ts`, and the smoke
 * checks pin.
 */
export const mcpToolsSchemaGroup: SchemaGenerationGroup = {
  group: "mcp-tools",
  documents: [
    {
      file: "mcp-tools",
      id: SCHEMA_IDS.mcpTools,
      root: mcpToolsDocumentRoot,
      defs: {
        ...mcpToolsSchemaDefs,
        currentEvidence,
        failure,
        "archflow_state/input": inputContracts.archflow_state,
        "archflow_state/success": toolSuccessSchemas.archflow_state,
        "archflow_state/result": resultContract(toolSuccessSchemas.archflow_state),
        "archflow_counter_review/input": inputContracts.archflow_counter_review,
        "archflow_counter_review/success": toolSuccessSchemas.archflow_counter_review,
        "archflow_counter_review/result": resultContract(toolSuccessSchemas.archflow_counter_review),
        "archflow_gate/input": inputContracts.archflow_gate,
        "archflow_gate/success": toolSuccessSchemas.archflow_gate,
        "archflow_gate/result": resultContract(toolSuccessSchemas.archflow_gate),
        "archflow_waiver/input": inputContracts.archflow_waiver,
        "archflow_waiver/success": toolSuccessSchemas.archflow_waiver,
        "archflow_waiver/result": resultContract(toolSuccessSchemas.archflow_waiver),
      },
      overrides: { "archflow_gate/input": gateInputEmission },
      migrated: true,
    },
  ],
};

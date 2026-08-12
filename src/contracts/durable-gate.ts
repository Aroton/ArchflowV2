import { z } from "zod";

import type { CanonicalDocument } from "./canonical.js";
import { pathSafeIdV1Schema, taskSlugV1Schema, type PathSafeId, type SafeInteger, type Sha256Digest, type TaskSlug } from "./evidence.js";
import {
  GATE_CONTRACTS,
  GATE_KINDS,
  gateDecisionEnvelopeV1Schema,
  gateRuleVersionRefSchema,
  gateWaiverScopeSchema,
  humanDecisionProvenanceV1Schema,
  type GateContext,
  type GateDecisionEnvelope,
  type GateDecisionPayload,
  type GateKind,
  type HumanDecisionProvenance,
  type WaiverOriginRef,
  type WaiverScope,
} from "./gates.js";
import { currentEvidenceSetRefSchema, type CurrentEvidenceSetRef } from "./trust.js";
import type { PhaseInstanceId } from "./phase-instance.js";
import { assertPlainJson } from "./plain-json.js";
import {
  supplementalReviewOutcomeSchema,
  type GateSupersessionRef,
  type SupplementalReviewOutcome,
} from "./supplemental.js";

export type SupplementalLedgerEntry = Exclude<SupplementalReviewOutcome, { readonly action: "supersede" }>;
export type SupplementalLedger = readonly SupplementalLedgerEntry[];
export type WaiverGateContext = { readonly origin: WaiverOriginRef; readonly rationale: string };

type GateRequestCommon = {
  readonly schema_version: "1";
  readonly gate_id: PathSafeId;
  readonly intent_id: PathSafeId;
  readonly request_digest: Sha256Digest;
  readonly task_id: TaskSlug;
  readonly phase_instance: PhaseInstanceId;
  readonly summary: string;
  readonly subject_digest: Sha256Digest;
  readonly context_digest: Sha256Digest;
  readonly current_evidence: CurrentEvidenceSetRef;
  readonly supersedes?: GateSupersessionRef;
  readonly opened_at_revision: SafeInteger;
};

export type GateRequestV1 = {
  readonly [K in GateKind]: GateRequestCommon & {
    readonly kind: K;
    readonly context: GateContext<K> | (K extends "constitution-review" ? WaiverGateContext : never);
    readonly allowed_decisions: readonly (GateDecisionPayload<K>["decision"] | "grant" | "deny" | "cancel")[];
  };
}[GateKind];

type GateDecisionRecordCommon = {
  readonly schema_version: "1";
  readonly gate_id: PathSafeId;
  readonly task_id: TaskSlug;
  readonly phase_instance: PhaseInstanceId;
  readonly kind: GateKind;
  readonly subject_digest: Sha256Digest;
  readonly context_digest: Sha256Digest;
  readonly supplemental: SupplementalLedger;
};

export type GateDecisionRecordV1 = GateDecisionRecordCommon & (
  | { readonly outcome: "decided"; readonly envelope: GateDecisionEnvelope }
  | { readonly outcome: "waiver-decided"; readonly granted: boolean; readonly scope: WaiverScope; readonly origin: WaiverOriginRef; readonly notes: string; readonly human_provenance: HumanDecisionProvenance }
  | { readonly outcome: "cancelled"; readonly reason: string; readonly human_provenance: HumanDecisionProvenance }
  | { readonly outcome: "superseded"; readonly supersession: GateSupersessionRef }
);

export type GateDecisionTemplateV1 = {
  readonly schema_version: "1";
  readonly gate_id: PathSafeId;
  readonly task_id: TaskSlug;
  readonly phase_instance: PhaseInstanceId;
  readonly kind: GateKind;
  readonly subject_digest: Sha256Digest;
  readonly context_digest: Sha256Digest;
  readonly required_fields:
    | readonly ["payload", "human_provenance"]
    | readonly ["granted", "scope", "origin", "notes", "human_provenance"];
  readonly cancellation_fields: readonly ["cancelled", "reason", "human_provenance"];
};

export type ActiveGateV1 = GateRequestV1 & {
  readonly status: "awaiting-human";
  readonly decision_template: GateDecisionTemplateV1;
  readonly supplemental: SupplementalLedger;
};

const digest = z.string().regex(/^[0-9a-f]{64}$/u);
const pathSafeId = pathSafeIdV1Schema;
const taskSlug = taskSlugV1Schema;
const phase = z.string().regex(/^(?:prd|design|phase-(?:design|impl)-[1-9][0-9]*)$/u);
const text = z.string().min(1).max(4096).regex(/\S/u);
const rule = gateRuleVersionRefSchema;
const scope = gateWaiverScopeSchema;
const origin = z.object({ origin_gate_id: pathSafeId, origin_decision_digest: digest, origin_context_digest: digest, task_id: taskSlug, phase_instance: phase, subject_digest: digest, current_evidence_set_digest: digest, rule, scope }).strict();
const supersession = z.object({ superseded_gate_id: pathSafeId, accepted_triage_digest: digest, old_subject_digest: digest }).strict();
const supplemental = z.array(supplementalReviewOutcomeSchema).superRefine((entries, context) => {
  if (entries.some((entry) => entry.action === "supersede")) context.addIssue({ code: "custom", message: "supplemental ledger cannot contain supersession" });
});
const base = { schema_version: z.literal("1"), gate_id: pathSafeId, task_id: taskSlug, phase_instance: phase, kind: z.enum(GATE_KINDS), subject_digest: digest, context_digest: digest, supplemental } as const;

const decisionRecordArms = {
  decided: z.object({ ...base, outcome: z.literal("decided"), envelope: gateDecisionEnvelopeV1Schema }).strict(),
  waiverDecided: z.object({ ...base, outcome: z.literal("waiver-decided"), granted: z.boolean(), scope, origin, notes: text, human_provenance: humanDecisionProvenanceV1Schema }).strict(),
  cancelled: z.object({ ...base, outcome: z.literal("cancelled"), reason: text, human_provenance: humanDecisionProvenanceV1Schema }).strict(),
  superseded: z.object({ ...base, outcome: z.literal("superseded"), supersession }).strict(),
} as const;

export const gateDecisionRecordV1Schema = z.discriminatedUnion("outcome", [
  decisionRecordArms.decided,
  decisionRecordArms.waiverDecided,
  decisionRecordArms.cancelled,
  decisionRecordArms.superseded,
]) as unknown as z.ZodType<GateDecisionRecordV1>;

/**
 * The per-kind decision vocabularies pinned as `const` arrays by `gate-request.schema.json`; order
 * is part of the contract, so the mirror models each as a tuple of literals.
 */
const GATE_REQUEST_DECISIONS = {
  "artifact-approval": ["approve", "revise", "reject", "cancel"],
  "constitution-review": ["approve", "revise", "reject", "waiver-requested", "cancel"],
  "material-drift": ["amend-upstream", "revise-current", "reject", "cancel"],
  "attempts-exhausted": ["retry-once", "revise", "abort", "cancel"],
  "constitution-edit": ["revert-edit", "start-base-amendment", "abort", "cancel"],
  "commit-authorization": ["authorize-commit", "revise", "abort", "cancel"],
  "restore-collision": ["discard-and-restore", "adopt-as-new-generation", "abort", "cancel"],
  "migration-audit": ["accept-import-audit", "revise", "abort", "cancel"],
} as const satisfies Readonly<Record<GateKind, readonly [string, ...string[]]>>;

const WAIVER_DECISIONS = ["grant", "deny", "cancel"] as const;

const literalTuple = (values: readonly [string, ...string[]]) =>
  z.tuple(values.map((value) => z.literal(value)) as [z.ZodLiteral<string>, ...z.ZodLiteral<string>[]]);

/**
 * One shared tuple object per decision vocabulary, so the request and active-gate arms `$ref` a
 * single `$def` per list. Each def's emission is overridden with the pinned `const` array: Zod's
 * tuple emission carries `prefixItems` without length bounds, which Ajv strict mode rejects, and
 * the `const` form is the exact-sequence semantics the runtime tuples enforce.
 */
const allowedDecisionTuples = Object.fromEntries(
  GATE_KINDS.map((kind) => [kind, literalTuple(GATE_REQUEST_DECISIONS[kind])])
) as unknown as Readonly<Record<GateKind, z.ZodType>>;
const waiverDecisionsTuple = literalTuple(WAIVER_DECISIONS);

const waiverGateContextSchema = z.object({ origin, rationale: text }).strict();

const gateRequestCommon = {
  schema_version: z.literal("1"),
  gate_id: pathSafeId,
  intent_id: pathSafeId,
  request_digest: digest,
  task_id: taskSlug,
  phase_instance: phase,
  summary: text,
  subject_digest: digest,
  context_digest: digest,
  current_evidence: currentEvidenceSetRefSchema,
  supersedes: supersession.optional(),
  opened_at_revision: z.number().int().min(1).max(Number.MAX_SAFE_INTEGER),
} as const;

const gateArm = (kind: GateKind, context: z.ZodType, decisions: z.ZodType, extra: Record<string, z.ZodType>) =>
  z.object({ ...gateRequestCommon, ...extra, kind: z.literal(kind), context, allowed_decisions: decisions }).strict();

/**
 * One arm per `gate-request.schema.json` `$defs` branch: the eight gate kinds plus the waiver arm,
 * keyed by their committed def names. Non-waiver arms embed `GATE_CONTRACTS[kind].context` —
 * the same Zod context schemas `parseGateContext` runs — so the gate-semantics checks
 * (sorted-unique rule sets, eligible-waiver axis match, attempts >= maximum) ride along instead of
 * being restated. The arms are disjoint: the pinned `allowed_decisions` tuples separate the waiver
 * arm from the constitution-review arm it shares a kind with.
 */
const gateArms = (extra: Record<string, z.ZodType>) => ({
  artifactApproval: gateArm("artifact-approval", GATE_CONTRACTS["artifact-approval"].context, allowedDecisionTuples["artifact-approval"], extra),
  constitutionReview: gateArm("constitution-review", GATE_CONTRACTS["constitution-review"].context, allowedDecisionTuples["constitution-review"], extra),
  materialDrift: gateArm("material-drift", GATE_CONTRACTS["material-drift"].context, allowedDecisionTuples["material-drift"], extra),
  attemptsExhausted: gateArm("attempts-exhausted", GATE_CONTRACTS["attempts-exhausted"].context, allowedDecisionTuples["attempts-exhausted"], extra),
  constitutionEdit: gateArm("constitution-edit", GATE_CONTRACTS["constitution-edit"].context, allowedDecisionTuples["constitution-edit"], extra),
  commitAuthorization: gateArm("commit-authorization", GATE_CONTRACTS["commit-authorization"].context, allowedDecisionTuples["commit-authorization"], extra),
  restoreCollision: gateArm("restore-collision", GATE_CONTRACTS["restore-collision"].context, allowedDecisionTuples["restore-collision"], extra),
  migrationAudit: gateArm("migration-audit", GATE_CONTRACTS["migration-audit"].context, allowedDecisionTuples["migration-audit"], extra),
  constitutionWaiver: gateArm("constitution-review", waiverGateContextSchema, waiverDecisionsTuple, extra),
});

const armUnion = (arms: Record<string, z.ZodType>) =>
  z.union(Object.values(arms) as unknown as [z.ZodType, z.ZodType, ...z.ZodType[]]);

const gateRequestArms = gateArms({});

export const gateRequestV1Schema = armUnion(gateRequestArms) as unknown as z.ZodType<GateRequestV1>;

const PAYLOAD_REQUIRED_FIELDS = ["payload", "human_provenance"] as const;
const WAIVER_REQUIRED_FIELDS = ["granted", "scope", "origin", "notes", "human_provenance"] as const;
const CANCELLATION_FIELDS = ["cancelled", "reason", "human_provenance"] as const;

const payloadRequiredFieldsTuple = literalTuple(PAYLOAD_REQUIRED_FIELDS);
const waiverRequiredFieldsTuple = literalTuple(WAIVER_REQUIRED_FIELDS);
const cancellationFieldsTuple = literalTuple(CANCELLATION_FIELDS);

const gateDecisionTemplateV1Schema = z.object({
  schema_version: z.literal("1"),
  gate_id: pathSafeId,
  task_id: taskSlug,
  phase_instance: phase,
  kind: z.enum(GATE_KINDS),
  subject_digest: digest,
  context_digest: digest,
  required_fields: z.union([payloadRequiredFieldsTuple, waiverRequiredFieldsTuple]),
  cancellation_fields: cancellationFieldsTuple,
}).strict();

export const activeGateV1Schema = armUnion(gateArms({
  status: z.literal("awaiting-human"),
  decision_template: gateDecisionTemplateV1Schema,
  supplemental,
})) as unknown as z.ZodType<ActiveGateV1>;

/**
 * The generated `$defs` layouts, keyed by committed def name. The arms are the union options above,
 * registered so each document root emits `$ref`s instead of nine inline copies; `supplemental`
 * lives with the decision record and the active gate reaches it cross-file, exactly as the
 * committed schemas always did.
 */
export const gateRequestSchemaDefs: Readonly<Record<string, z.ZodType>> = Object.freeze({
  currentEvidence: currentEvidenceSetRefSchema,
  supersession,
  origin,
  waiverContext: waiverGateContextSchema,
  artifactApprovalDecisions: allowedDecisionTuples["artifact-approval"],
  constitutionReviewDecisions: allowedDecisionTuples["constitution-review"],
  materialDriftDecisions: allowedDecisionTuples["material-drift"],
  attemptsExhaustedDecisions: allowedDecisionTuples["attempts-exhausted"],
  constitutionEditDecisions: allowedDecisionTuples["constitution-edit"],
  commitAuthorizationDecisions: allowedDecisionTuples["commit-authorization"],
  restoreCollisionDecisions: allowedDecisionTuples["restore-collision"],
  migrationAuditDecisions: allowedDecisionTuples["migration-audit"],
  waiverDecisions: waiverDecisionsTuple,
  ...gateRequestArms,
});

/**
 * Verbatim emissions for the decision-vocabulary defs: the runtime tuples enforce the exact
 * sequence, and `const` is that same semantics in schema form, with the length bounds Zod's
 * `prefixItems` emission drops.
 */
export const gateRequestSchemaDefOverrides: Readonly<Record<string, Readonly<Record<string, unknown>>>> = Object.freeze({
  artifactApprovalDecisions: { const: GATE_REQUEST_DECISIONS["artifact-approval"] },
  constitutionReviewDecisions: { const: GATE_REQUEST_DECISIONS["constitution-review"] },
  materialDriftDecisions: { const: GATE_REQUEST_DECISIONS["material-drift"] },
  attemptsExhaustedDecisions: { const: GATE_REQUEST_DECISIONS["attempts-exhausted"] },
  constitutionEditDecisions: { const: GATE_REQUEST_DECISIONS["constitution-edit"] },
  commitAuthorizationDecisions: { const: GATE_REQUEST_DECISIONS["commit-authorization"] },
  restoreCollisionDecisions: { const: GATE_REQUEST_DECISIONS["restore-collision"] },
  migrationAuditDecisions: { const: GATE_REQUEST_DECISIONS["migration-audit"] },
  waiverDecisions: { const: WAIVER_DECISIONS },
});

export const gateDecisionRecordSchemaDefs: Readonly<Record<string, z.ZodType>> = Object.freeze({
  supplemental,
  provenance: humanDecisionProvenanceV1Schema,
  ...decisionRecordArms,
});

export const activeGateSchemaDefs: Readonly<Record<string, z.ZodType>> = Object.freeze({
  payloadRequiredFields: payloadRequiredFieldsTuple,
  waiverRequiredFields: waiverRequiredFieldsTuple,
  cancellationFields: cancellationFieldsTuple,
  decisionTemplate: gateDecisionTemplateV1Schema,
});

export const activeGateSchemaDefOverrides: Readonly<Record<string, Readonly<Record<string, unknown>>>> = Object.freeze({
  payloadRequiredFields: { const: PAYLOAD_REQUIRED_FIELDS },
  waiverRequiredFields: { const: WAIVER_REQUIRED_FIELDS },
  cancellationFields: { const: CANCELLATION_FIELDS },
});

export function parseGateRequest(value: unknown): GateRequestV1 {
  assertPlainJson(value, "gate request");
  return gateRequestV1Schema.parse(value);
}

export function parseGateDecisionRecord(value: unknown): GateDecisionRecordV1 {
  assertPlainJson(value, "gate decision record");
  return gateDecisionRecordV1Schema.parse(value);
}

export function parseActiveGate(value: unknown): ActiveGateV1 {
  assertPlainJson(value, "active gate");
  return activeGateV1Schema.parse(value);
}

export type GateRequestDocument = CanonicalDocument<GateRequestV1>;
export type GateDecisionRecordDocument = CanonicalDocument<GateDecisionRecordV1>;
export type ActiveGateDocument = CanonicalDocument<ActiveGateV1>;

import { z } from "zod";

import type { CanonicalDocument } from "./canonical.js";
import type { PathSafeId, SafeInteger, Sha256Digest, TaskSlug } from "./evidence.js";
import {
  GATE_KINDS,
  gateDecisionEnvelopeV1Schema,
  humanDecisionProvenanceV1Schema,
  parseGateContext,
  type GateContext,
  type GateDecisionEnvelope,
  type GateDecisionPayload,
  type GateKind,
  type HumanDecisionProvenance,
  type WaiverOriginRef,
  type WaiverScope,
} from "./gates.js";
import type { CurrentEvidenceSetRef } from "./trust.js";
import type { PhaseInstanceId } from "./phase-instance.js";
import { assertPlainJson } from "./plain-json.js";
import {
  supplementalReviewOutcomeSchema,
  type GateSupersessionRef,
  type SupplementalReviewOutcome,
} from "./supplemental.js";
import {
  assertZodAgreement,
  activeGateV1Validator,
  gateDecisionRecordV1Validator,
  gateRequestV1Validator,
} from "./validators.js";

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
    readonly context: GateContext<K> | (K extends "review-trigger" | "adjudication-failure" ? WaiverGateContext : never);
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
const safeId = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u);
const pathSafeId = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u);
const taskSlug = z.string().regex(/^[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?$/u);
const phase = z.string().regex(/^(?:prd|design|phase-(?:design|impl)-[1-9][0-9]*)$/u);
const text = z.string().min(1).max(4096).regex(/\S/u);
const rule = z.object({ rule_id: safeId, rule_version: z.number().int().positive().max(Number.MAX_SAFE_INTEGER) }).strict();
const scope = z.object({ operation: z.enum(["review-trigger", "adjudication-failure"]), boundary: z.enum(["subject", "phase", "task"]) }).strict();
const origin = z.object({ origin_gate_id: pathSafeId, origin_decision_digest: digest, origin_context_digest: digest, task_id: taskSlug, phase_instance: phase, subject_digest: digest, current_evidence_set_digest: digest, rule, scope }).strict();
const supersession = z.object({ superseded_gate_id: pathSafeId, accepted_triage_digest: digest, old_subject_digest: digest }).strict();
const supplemental = z.array(supplementalReviewOutcomeSchema).superRefine((entries, context) => {
  if (entries.some((entry) => entry.action === "supersede")) context.addIssue({ code: "custom", message: "supplemental ledger cannot contain supersession" });
});
const base = { schema_version: z.literal("1"), gate_id: pathSafeId, task_id: taskSlug, phase_instance: phase, kind: z.enum(GATE_KINDS), subject_digest: digest, context_digest: digest, supplemental } as const;

export const gateDecisionRecordV1Schema = z.discriminatedUnion("outcome", [
  z.object({ ...base, outcome: z.literal("decided"), envelope: gateDecisionEnvelopeV1Schema }).strict(),
  z.object({ ...base, outcome: z.literal("waiver-decided"), granted: z.boolean(), scope, origin, notes: text, human_provenance: humanDecisionProvenanceV1Schema }).strict(),
  z.object({ ...base, outcome: z.literal("cancelled"), reason: text, human_provenance: humanDecisionProvenanceV1Schema }).strict(),
  z.object({ ...base, outcome: z.literal("superseded"), supersession }).strict(),
]) as unknown as z.ZodType<GateDecisionRecordV1>;

export function parseGateRequest(value: unknown): GateRequestV1 {
  assertPlainJson(value, "gate request");
  const parsed = gateRequestV1Validator.assert(value, "gate request");
  const context = parsed.context as GateContext<GateKind> | WaiverGateContext;
  if (!("origin" in context)) parseGateContext(parsed.kind, context as GateContext<typeof parsed.kind>);
  return parsed;
}

export function parseGateDecisionRecord(value: unknown): GateDecisionRecordV1 {
  assertPlainJson(value, "gate decision record");
  return assertZodAgreement(value, gateDecisionRecordV1Validator, gateDecisionRecordV1Schema, "gate decision record");
}

export function parseActiveGate(value: unknown): ActiveGateV1 {
  assertPlainJson(value, "active gate");
  return activeGateV1Validator.assert(value, "active gate");
}

export type GateRequestDocument = CanonicalDocument<GateRequestV1>;
export type GateDecisionRecordDocument = CanonicalDocument<GateDecisionRecordV1>;
export type ActiveGateDocument = CanonicalDocument<ActiveGateV1>;

import { z } from "zod";

import type { CanonicalDocument } from "./canonical.js";
import { pathSafeIdV1Schema, taskSlugV1Schema, type PathSafeId, type SafeInteger, type Sha256Digest, type TaskSlug } from "./evidence.js";
import {
  GATE_CONTRACTS,
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
import { currentEvidenceSetRefSchema, type CurrentEvidenceSetRef } from "./trust.js";
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
const pathSafeId = pathSafeIdV1Schema;
const taskSlug = taskSlugV1Schema;
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

/**
 * The per-kind decision vocabularies pinned as `const` arrays by `gate-request.schema.json`; order
 * is part of the contract, so the mirror models each as a tuple of literals.
 */
const GATE_REQUEST_DECISIONS = {
  "artifact-approval": ["approve", "revise", "reject", "cancel"],
  "review-trigger": ["approve", "revise", "reject", "waiver-requested", "cancel"],
  "material-drift": ["amend-upstream", "revise-current", "reject", "cancel"],
  "adjudication-failure": ["approve", "revise", "reject", "waiver-requested", "cancel"],
  "attempts-exhausted": ["retry-once", "revise", "abort", "cancel"],
  "constitution-edit": ["revert-edit", "start-base-amendment", "abort", "cancel"],
  "commit-authorization": ["authorize-commit", "revise", "abort", "cancel"],
  "restore-collision": ["discard-and-restore", "adopt-as-new-generation", "abort", "cancel"],
  "migration-audit": ["accept-import-audit", "revise", "abort", "cancel"],
} as const satisfies Readonly<Record<GateKind, readonly [string, ...string[]]>>;

const WAIVER_DECISIONS = ["grant", "deny", "cancel"] as const;

const literalTuple = (values: readonly [string, ...string[]]) =>
  z.tuple(values.map((value) => z.literal(value)) as [z.ZodLiteral<string>, ...z.ZodLiteral<string>[]]);

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

const gateArm = (kind: GateKind, context: z.ZodType, decisions: readonly [string, ...string[]], extra: Record<string, z.ZodType>) =>
  z.object({ ...gateRequestCommon, ...extra, kind: z.literal(kind), context, allowed_decisions: literalTuple(decisions) }).strict();

/**
 * One arm per `gate-request.schema.json` `oneOf` branch: the nine gate kinds plus the two waiver
 * arms. Non-waiver arms embed `GATE_CONTRACTS[kind].context` — the same Zod context schemas
 * `parseGateContext` runs — so the `x-archflow-gate-semantics` checks (sorted-unique rule sets,
 * eligible-waiver subset, waiver-scope operation match, attempts >= maximum) ride along instead of
 * being restated. The arms are disjoint: the pinned `allowed_decisions` tuples separate a waiver
 * arm from its same-kind review arm.
 */
const gateArms = (extra: Record<string, z.ZodType>) => [
  ...GATE_KINDS.map((kind) => gateArm(kind, GATE_CONTRACTS[kind].context, GATE_REQUEST_DECISIONS[kind], extra)),
  gateArm("review-trigger", waiverGateContextSchema, WAIVER_DECISIONS, extra),
  gateArm("adjudication-failure", waiverGateContextSchema, WAIVER_DECISIONS, extra),
] as unknown as [z.ZodType, z.ZodType, ...z.ZodType[]];

export const gateRequestV1Schema = z.union(gateArms({})) as unknown as z.ZodType<GateRequestV1>;

const gateDecisionTemplateV1Schema = z.object({
  schema_version: z.literal("1"),
  gate_id: pathSafeId,
  task_id: taskSlug,
  phase_instance: phase,
  kind: z.enum(GATE_KINDS),
  subject_digest: digest,
  context_digest: digest,
  required_fields: z.union([
    literalTuple(["payload", "human_provenance"]),
    literalTuple(["granted", "scope", "origin", "notes", "human_provenance"]),
  ]),
  cancellation_fields: literalTuple(["cancelled", "reason", "human_provenance"]),
}).strict();

export const activeGateV1Schema = z.union(gateArms({
  status: z.literal("awaiting-human"),
  decision_template: gateDecisionTemplateV1Schema,
  supplemental,
})) as unknown as z.ZodType<ActiveGateV1>;

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

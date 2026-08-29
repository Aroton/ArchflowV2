import { z } from "zod";

import type { CanonicalDocument } from "./canonical.js";
import { pathSafeIdV1Schema, taskSlugV1Schema, type PathSafeId, type SafeInteger, type Sha256Digest, type TaskSlug } from "./evidence.js";
import {
  GATE_CONTRACTS,
  GATE_KINDS,
  archivedPreExactCommitAuthorizationContextSchema,
  baselineObservationRefV1Schema,
  gateDecisionEnvelopeV1Schema,
  gateRuleVersionRefSchema,
  gateWaiverScopeSchema,
  humanDecisionProvenanceV1Schema,
  legacyArtifactApprovalContextSchema,
  legacyDesignApprovalContextSchema,
  legacyExactCommitAuthorizationContextSchema,
  type ArchivedPreExactCommitAuthorizationContextV1,
  type BaselineObservationRef,
  type GateContext,
  type GateDecisionEnvelope,
  type GateDecisionPayload,
  type GateKind,
  type HumanDecisionProvenance,
  type LegacyArtifactApprovalContextV1,
  type LegacyDesignApprovalContextV1,
  type LegacyExactCommitAuthorizationContextV1,
  type WaiverOriginRef,
  type WaiverScope,
} from "./gates.js";
import { currentEvidenceSetRefSchema, type CurrentEvidenceSetRef } from "./trust.js";
import { MODEL_FAMILIES, type ModelFamily } from "./review.js";
import type { PhaseInstanceId } from "./phase-instance.js";
import { assertPlainJson } from "./plain-json.js";
export type WaiverGateContext = { readonly origin: WaiverOriginRef; readonly rationale: string };

/**
 * Retired V1 fields remain readable because gate archives are immutable human authority. They
 * are deliberately absent from the current writer types below: compatibility is a read concern,
 * not permission for new calls to revive the former supplemental-review workflow.
 */
export type LegacyGateSupersessionRefV1 = {
  readonly superseded_gate_id: PathSafeId;
  readonly accepted_triage_digest: Sha256Digest;
  readonly old_subject_digest: Sha256Digest;
};
export type LegacySupplementalGateRefV1 = {
  readonly prior_gate_id: PathSafeId;
  readonly task_id: TaskSlug;
  readonly phase_instance: PhaseInstanceId;
  readonly subject_digest: Sha256Digest;
  readonly input_fingerprint: Sha256Digest;
};
export type LegacySupplementalReviewRefV1 = LegacySupplementalGateRefV1 & {
  readonly evidence_slot: Readonly<{
    readonly role: "gate-counter-review";
    readonly evidence_digest: Sha256Digest;
    readonly assurance: "server-attested" | "degraded";
    readonly producer_family: ModelFamily;
    readonly reviewer_family: ModelFamily;
    readonly independence: "opposite-family";
    readonly gate_id: PathSafeId;
  }>;
};
export type LegacySupplementalLedgerEntryV1 =
  | Readonly<{ readonly action: "decline"; readonly gate: LegacySupplementalGateRefV1; readonly reason: string }>
  | Readonly<{ readonly action: "ingest"; readonly review: LegacySupplementalReviewRefV1; readonly reason: string }>
  | Readonly<{ readonly action: "triage-no-change"; readonly review: LegacySupplementalReviewRefV1; readonly triage_digest: Sha256Digest; readonly reason: string }>;
export type LegacySupplementalLedgerV1 = readonly LegacySupplementalLedgerEntryV1[];

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
  readonly opened_at_revision: SafeInteger;
};

/**
 * `current_evidence` per kind: every gate kind that opens after review cites the current evidence
 * set; `baseline-adoption` opens pre-review, so it cites the drift observation itself
 * (`BaselineObservationRef`) — the only evidence a human deciding on drifted projections has.
 */
export type GateEvidenceByKind<K extends GateKind> = K extends "baseline-adoption" ? BaselineObservationRef : CurrentEvidenceSetRef;

export type GateRequestV1 = {
  readonly [K in GateKind]: Omit<GateRequestCommon, "current_evidence"> & {
    readonly current_evidence: GateEvidenceByKind<K>;
    readonly kind: K;
    readonly context: GateContext<K> | (K extends "constitution-review" ? WaiverGateContext : never);
    readonly allowed_decisions: readonly (GateDecisionPayload<K>["decision"] | "grant" | "deny" | "cancel")[];
  };
}[GateKind];

/**
 * A commit-authorization request archived before `baseline_commit`, `commit_message` and `paths`
 * became required. Read-only, like every shape in this family: the current writer type above is
 * what a new request must satisfy.
 */
export type ArchivedPreExactCommitAuthorizationRequestV1 = GateRequestCommon & {
  readonly kind: "commit-authorization";
  readonly context: ArchivedPreExactCommitAuthorizationContextV1;
  readonly allowed_decisions: readonly ["authorize-commit", "revise", "abort", "cancel"];
};

export type ArchivedArtifactApprovalRequestV1 = GateRequestCommon & {
  readonly kind: "artifact-approval";
  readonly context: LegacyArtifactApprovalContextV1;
  readonly allowed_decisions: readonly ["approve", "revise", "reject", "cancel"];
};
export type ArchivedDesignApprovalRequestV1 = GateRequestCommon & {
  readonly kind: "design-approval";
  readonly context: LegacyDesignApprovalContextV1;
  readonly allowed_decisions: readonly ["approve", "revise", "reject", "waiver-requested", "cancel"];
};
export type ArchivedExactCommitAuthorizationRequestV1 = GateRequestCommon & {
  readonly kind: "commit-authorization";
  readonly context: LegacyExactCommitAuthorizationContextV1;
  readonly allowed_decisions: readonly ["authorize-commit", "revise", "abort", "cancel"];
};

/** Historical name retained for callers that specifically mean the pre-exact context. */
export type ArchivedCommitAuthorizationRequestV1 = ArchivedPreExactCommitAuthorizationRequestV1;

type ArchivedOrdinaryGateRequestV1 =
  | ArchivedArtifactApprovalRequestV1
  | ArchivedDesignApprovalRequestV1
  | ArchivedExactCommitAuthorizationRequestV1
  | ArchivedPreExactCommitAuthorizationRequestV1;

type ArchivedGateRequestShapeV1 = GateRequestV1 | ArchivedOrdinaryGateRequestV1;

export type ExactCommitAuthorizationContextV1 = GateContext<"commit-authorization"> | LegacyExactCommitAuthorizationContextV1;

/**
 * Narrows an archived commit-authorization context to the current shape, or `undefined` when it
 * predates the exact-commit fields. A request archived without them never bound a baseline, a
 * message or a path set, so nothing may claim it attests an exact commit — callers must skip it
 * rather than compare against absent values.
 */
export function exactCommitAuthorizationContext(
  context: ExactCommitAuthorizationContextV1 | ArchivedPreExactCommitAuthorizationContextV1,
): GateContext<"commit-authorization"> | undefined {
  return "baseline_commit" in context && "commit_message" in context && "paths" in context
    ? context as GateContext<"commit-authorization">
    : undefined;
}

export type ArchivedGateRequestV1 = ArchivedGateRequestShapeV1 | (ArchivedGateRequestShapeV1 & {
  readonly supersedes: LegacyGateSupersessionRefV1;
});

type GateDecisionRecordCommon = {
  readonly schema_version: "1";
  readonly gate_id: PathSafeId;
  readonly task_id: TaskSlug;
  readonly phase_instance: PhaseInstanceId;
  readonly kind: GateKind;
  readonly subject_digest: Sha256Digest;
  readonly context_digest: Sha256Digest;
};

export type GateDecisionRecordV1 = GateDecisionRecordCommon & (
  | { readonly outcome: "decided"; readonly envelope: GateDecisionEnvelope }
  | { readonly outcome: "waiver-decided"; readonly granted: boolean; readonly scope: WaiverScope; readonly origin: WaiverOriginRef; readonly notes: string; readonly human_provenance: HumanDecisionProvenance }
  | { readonly outcome: "cancelled"; readonly reason: string; readonly human_provenance: HumanDecisionProvenance }
);

/**
 * Server-authored audit record for disposal of a stale baseline interface. It records no human
 * decision and grants no adoption, restoration, review, approval, or commit authority.
 */
export type StaleBaselineGateSupersessionV1 = GateDecisionRecordCommon & {
  readonly kind: "baseline-adoption";
  readonly outcome: "superseded-stale-baseline";
  readonly live_subject_digest: Sha256Digest;
  readonly live_context_digest: Sha256Digest;
  readonly superseded_at_revision: SafeInteger;
};

type LegacyGateDecisionRecordCommonV1 = GateDecisionRecordCommon & {
  readonly supplemental: LegacySupplementalLedgerV1;
};
export type ArchivedGateDecisionRecordV1 = GateDecisionRecordV1 | StaleBaselineGateSupersessionV1 | (LegacyGateDecisionRecordCommonV1 & (
  | { readonly outcome: "decided"; readonly envelope: GateDecisionEnvelope }
  | { readonly outcome: "waiver-decided"; readonly granted: boolean; readonly scope: WaiverScope; readonly origin: WaiverOriginRef; readonly notes: string; readonly human_provenance: HumanDecisionProvenance }
  | { readonly outcome: "cancelled"; readonly reason: string; readonly human_provenance: HumanDecisionProvenance }
  | { readonly outcome: "superseded"; readonly supersession: LegacyGateSupersessionRefV1 }
));

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
};

const digest = z.string().regex(/^[0-9a-f]{64}$/u);
const pathSafeId = pathSafeIdV1Schema;
const taskSlug = taskSlugV1Schema;
const phase = z.string().regex(/^(?:prd|design|phase-(?:design|impl)-[1-9][0-9]*)$/u);
const text = z.string().min(1).max(4096).regex(/\S/u);
const rule = gateRuleVersionRefSchema;
const scope = gateWaiverScopeSchema;
const origin = z.object({ origin_gate_id: pathSafeId, origin_decision_digest: digest, origin_context_digest: digest, task_id: taskSlug, phase_instance: phase, subject_digest: digest, current_evidence_set_digest: digest, rule, scope }).strict();
const legacySupersession = z.object({ superseded_gate_id: pathSafeId, accepted_triage_digest: digest, old_subject_digest: digest }).strict();
const legacySupplementalGate = z.object({ prior_gate_id: pathSafeId, task_id: taskSlug, phase_instance: phase, subject_digest: digest, input_fingerprint: digest }).strict();
const legacySupplementalSlot = z.object({
  role: z.literal("gate-counter-review"), evidence_digest: digest,
  assurance: z.enum(["server-attested", "degraded"]),
  producer_family: z.enum(MODEL_FAMILIES), reviewer_family: z.enum(MODEL_FAMILIES),
  independence: z.literal("opposite-family"), gate_id: pathSafeId,
}).strict().superRefine((slot, context) => {
  if (slot.producer_family === slot.reviewer_family) {
    context.addIssue({ code: "custom", message: "gate counter-review must be opposite-family" });
  }
});
const legacySupplementalReview = z.object({
  prior_gate_id: pathSafeId, task_id: taskSlug, phase_instance: phase,
  subject_digest: digest, input_fingerprint: digest, evidence_slot: legacySupplementalSlot,
}).strict().superRefine((review, context) => {
  if (review.evidence_slot.gate_id !== review.prior_gate_id) {
    context.addIssue({ code: "custom", path: ["evidence_slot", "gate_id"], message: "gate-counter slot must bind prior_gate_id" });
  }
});
const legacySupplementalReason = z.string().min(1).regex(/\S/u);
const legacySupplemental = z.array(z.discriminatedUnion("action", [
  z.object({ action: z.literal("decline"), gate: legacySupplementalGate, reason: legacySupplementalReason }).strict(),
  z.object({ action: z.literal("ingest"), review: legacySupplementalReview, reason: legacySupplementalReason }).strict(),
  z.object({ action: z.literal("triage-no-change"), review: legacySupplementalReview, triage_digest: digest, reason: legacySupplementalReason }).strict(),
]));
const base = { schema_version: z.literal("1"), gate_id: pathSafeId, task_id: taskSlug, phase_instance: phase, kind: z.enum(GATE_KINDS), subject_digest: digest, context_digest: digest } as const;

const decisionRecordArms = {
  decided: z.object({ ...base, outcome: z.literal("decided"), envelope: gateDecisionEnvelopeV1Schema }).strict(),
  waiverDecided: z.object({ ...base, outcome: z.literal("waiver-decided"), granted: z.boolean(), scope, origin, notes: text, human_provenance: humanDecisionProvenanceV1Schema }).strict(),
  cancelled: z.object({ ...base, outcome: z.literal("cancelled"), reason: text, human_provenance: humanDecisionProvenanceV1Schema }).strict(),
} as const;

export const staleBaselineGateSupersessionV1Schema = z.object({
  ...base,
  kind: z.literal("baseline-adoption"),
  outcome: z.literal("superseded-stale-baseline"),
  live_subject_digest: digest,
  live_context_digest: digest,
  superseded_at_revision: z.number().int().min(1).max(Number.MAX_SAFE_INTEGER),
}).strict() as unknown as z.ZodType<StaleBaselineGateSupersessionV1>;

export const gateDecisionRecordV1Schema = z.discriminatedUnion("outcome", [
  decisionRecordArms.decided,
  decisionRecordArms.waiverDecided,
  decisionRecordArms.cancelled,
]) as unknown as z.ZodType<GateDecisionRecordV1>;

const legacyDecisionBase = { ...base, supplemental: legacySupplemental } as const;
const legacyDecisionRecordV1Schema = z.discriminatedUnion("outcome", [
  z.object({ ...legacyDecisionBase, outcome: z.literal("decided"), envelope: gateDecisionEnvelopeV1Schema }).strict(),
  z.object({ ...legacyDecisionBase, outcome: z.literal("waiver-decided"), granted: z.boolean(), scope, origin, notes: text, human_provenance: humanDecisionProvenanceV1Schema }).strict(),
  z.object({ ...legacyDecisionBase, outcome: z.literal("cancelled"), reason: text, human_provenance: humanDecisionProvenanceV1Schema }).strict(),
  z.object({ ...legacyDecisionBase, outcome: z.literal("superseded"), supersession: legacySupersession }).strict(),
]);

/**
 * The per-kind decision vocabularies pinned as `const` arrays by `gate-request.schema.json`; order
 * is part of the contract, so the mirror models each as a tuple of literals.
 */
const GATE_REQUEST_DECISIONS = {
  "artifact-approval": ["approve", "revise", "reject", "waiver-requested", "cancel"],
  "design-approval": ["approve", "revise", "reject", "waiver-requested", "cancel"],
  "constitution-review": ["approve", "revise", "reject", "waiver-requested", "cancel"],
  "material-drift": ["amend-upstream", "revise-current", "reject", "cancel"],
  "attempts-exhausted": ["retry-once", "revise", "abort", "cancel"],
  "constitution-edit": ["revert-edit", "start-base-amendment", "abort", "cancel"],
  "commit-authorization": ["authorize-commit", "revise", "abort", "waiver-requested", "cancel"],
  "restore-collision": ["discard-and-restore", "adopt-as-new-generation", "abort", "cancel"],
  "baseline-adoption": ["adopt-current-bytes", "restore-recorded-bytes", "adopt-committed-deletions", "abort", "cancel"],
  "migration-audit": ["accept-import-audit", "revise", "abort", "cancel"],
} as const satisfies Readonly<Record<GateKind, readonly [string, ...string[]]>>;

const WAIVER_DECISIONS = ["grant", "deny", "cancel"] as const;
const LEGACY_ARTIFACT_APPROVAL_DECISIONS = ["approve", "revise", "reject", "cancel"] as const;
const LEGACY_DESIGN_APPROVAL_DECISIONS = ["approve", "revise", "reject", "waiver-requested", "cancel"] as const;
const LEGACY_COMMIT_AUTHORIZATION_DECISIONS = ["authorize-commit", "revise", "abort", "cancel"] as const;

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
  opened_at_revision: z.number().int().min(1).max(Number.MAX_SAFE_INTEGER),
} as const;

const gateArm = (kind: GateKind, context: z.ZodType, decisions: z.ZodType, extra: Record<string, z.ZodType>) =>
  z.object({ ...gateRequestCommon, ...extra, kind: z.literal(kind), context, allowed_decisions: decisions }).strict();

/**
 * One arm per current `gate-request.schema.json` `$defs` branch. The policy-context
 * `constitution-review` arm is intentionally absent: new policy findings are folded into the
 * ordinary artifact/design/commit gate, while a fresh constitution-review is only the separate
 * waiver grant/deny decision.
 * keyed by their committed def names. Non-waiver arms embed `GATE_CONTRACTS[kind].context` —
 * the same Zod context schemas `parseGateContext` runs — so the gate-semantics checks
 * (sorted-unique rule sets, eligible-waiver axis match, attempts >= maximum) ride along instead of
 * being restated. The arms are disjoint: the pinned `allowed_decisions` tuples separate the waiver
 * arm from the constitution-review arm it shares a kind with.
 */
const gateArms = (extra: Record<string, z.ZodType>) => ({
  artifactApproval: gateArm("artifact-approval", GATE_CONTRACTS["artifact-approval"].context, allowedDecisionTuples["artifact-approval"], extra),
  designApproval: gateArm("design-approval", GATE_CONTRACTS["design-approval"].context, allowedDecisionTuples["design-approval"], extra),
  materialDrift: gateArm("material-drift", GATE_CONTRACTS["material-drift"].context, allowedDecisionTuples["material-drift"], extra),
  attemptsExhausted: gateArm("attempts-exhausted", GATE_CONTRACTS["attempts-exhausted"].context, allowedDecisionTuples["attempts-exhausted"], extra),
  constitutionEdit: gateArm("constitution-edit", GATE_CONTRACTS["constitution-edit"].context, allowedDecisionTuples["constitution-edit"], extra),
  commitAuthorization: gateArm("commit-authorization", GATE_CONTRACTS["commit-authorization"].context, allowedDecisionTuples["commit-authorization"], extra),
  restoreCollision: gateArm("restore-collision", GATE_CONTRACTS["restore-collision"].context, allowedDecisionTuples["restore-collision"], extra),
  baselineAdoption: gateArm("baseline-adoption", GATE_CONTRACTS["baseline-adoption"].context, allowedDecisionTuples["baseline-adoption"], { ...extra, current_evidence: baselineObservationRefV1Schema }),
  migrationAudit: gateArm("migration-audit", GATE_CONTRACTS["migration-audit"].context, allowedDecisionTuples["migration-audit"], extra),
  constitutionWaiver: gateArm("constitution-review", waiverGateContextSchema, waiverDecisionsTuple, extra),
});

/** Read-only policy gate retained so old open and decided constitution reviews remain usable. */
const archivedPolicyGateArm = (extra: Record<string, z.ZodType>) => ({
  constitutionReview: gateArm("constitution-review", GATE_CONTRACTS["constitution-review"].context, allowedDecisionTuples["constitution-review"], extra),
});

const archivedGateArms = (extra: Record<string, z.ZodType>) => ({
  ...gateArms(extra),
  ...archivedPolicyGateArm(extra),
});

const armUnion = (arms: Record<string, z.ZodType>) =>
  z.union(Object.values(arms) as unknown as [z.ZodType, z.ZodType, ...z.ZodType[]]);

const gateRequestArms = gateArms({});

export const gateRequestV1Schema = armUnion(gateRequestArms) as unknown as z.ZodType<GateRequestV1>;
const archivedPolicyGateRequestV1Schema = armUnion(archivedPolicyGateArm({}));
const legacyGateRequestV1Schema = armUnion(archivedGateArms({ supersedes: legacySupersession }));

/**
 * Explicit compatibility arms for ordinary requests written before approval triggers became
 * required. Their exact historical contexts and decision tuples remain read-only: none is
 * registered in the fresh request or active-gate schemas.
 */
const archivedOrdinaryGateArms = (extra: Record<string, z.ZodType>) => ({
  artifactApproval: gateArm("artifact-approval", legacyArtifactApprovalContextSchema, literalTuple(LEGACY_ARTIFACT_APPROVAL_DECISIONS), extra),
  designApproval: gateArm("design-approval", legacyDesignApprovalContextSchema, literalTuple(LEGACY_DESIGN_APPROVAL_DECISIONS), extra),
  exactCommitAuthorization: gateArm("commit-authorization", legacyExactCommitAuthorizationContextSchema, literalTuple(LEGACY_COMMIT_AUTHORIZATION_DECISIONS), extra),
  preExactCommitAuthorization: gateArm("commit-authorization", archivedPreExactCommitAuthorizationContextSchema, literalTuple(LEGACY_COMMIT_AUTHORIZATION_DECISIONS), extra),
});
const archivedOrdinaryGateRequestV1Schema = armUnion(archivedOrdinaryGateArms({}));
const archivedSupersededOrdinaryGateRequestV1Schema = armUnion(archivedOrdinaryGateArms({ supersedes: legacySupersession }));

/**
 * A baseline-adoption request written before deletion adoption existed pinned only the four
 * bytes decisions in `allowed_decisions`. The current writer pins the five-element tuple with
 * `adopt-committed-deletions`, and a pinned tuple admits no subset — without this twin every
 * pre-change baseline adoption would fail `parseArchivedGateRequest`, so `composeGate`'s
 * approval reload would refuse to open any later gate. Like the commit-authorization twin, it
 * is deliberately absent from `gateRequestArms`, `activeGateV1Schema` and
 * `gateRequestSchemaDefs`: the published schema keeps advertising only the writer shape.
 */
const archivedBaselineAdoptionRequestV1Schema = gateArm(
  "baseline-adoption",
  GATE_CONTRACTS["baseline-adoption"].context,
  literalTuple(["adopt-current-bytes", "restore-recorded-bytes", "abort", "cancel"]),
  { current_evidence: baselineObservationRefV1Schema },
);
const archivedSupersededBaselineAdoptionRequestV1Schema = gateArm(
  "baseline-adoption",
  GATE_CONTRACTS["baseline-adoption"].context,
  literalTuple(["adopt-current-bytes", "restore-recorded-bytes", "abort", "cancel"]),
  { current_evidence: baselineObservationRefV1Schema, supersedes: legacySupersession },
);

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
})) as unknown as z.ZodType<ActiveGateV1>;

const archivedActiveGateExtra = {
  status: z.literal("awaiting-human"),
  decision_template: gateDecisionTemplateV1Schema,
};
const archivedOrdinaryActiveGateV1Schema = armUnion(archivedOrdinaryGateArms(archivedActiveGateExtra));
const archivedPolicyActiveGateV1Schema = armUnion(archivedPolicyGateArm(archivedActiveGateExtra));
const archivedSupersededActiveGateV1Schema = armUnion(archivedGateArms({ ...archivedActiveGateExtra, supersedes: legacySupersession }));
const archivedSupersededOrdinaryActiveGateV1Schema = armUnion(archivedOrdinaryGateArms({ ...archivedActiveGateExtra, supersedes: legacySupersession }));
const archivedBaselineActiveGateV1Schema = gateArm(
  "baseline-adoption",
  GATE_CONTRACTS["baseline-adoption"].context,
  literalTuple(["adopt-current-bytes", "restore-recorded-bytes", "abort", "cancel"]),
  { ...archivedActiveGateExtra, current_evidence: baselineObservationRefV1Schema },
);
const archivedSupersededBaselineActiveGateV1Schema = gateArm(
  "baseline-adoption",
  GATE_CONTRACTS["baseline-adoption"].context,
  literalTuple(["adopt-current-bytes", "restore-recorded-bytes", "abort", "cancel"]),
  { ...archivedActiveGateExtra, current_evidence: baselineObservationRefV1Schema, supersedes: legacySupersession },
);

/**
 * The generated `$defs` layouts, keyed by committed def name. The arms are the union options above,
 * registered so each document root emits `$ref`s instead of nine inline copies.
 */
export const gateRequestSchemaDefs: Readonly<Record<string, z.ZodType>> = Object.freeze({
  currentEvidence: currentEvidenceSetRefSchema,
  baselineObservation: baselineObservationRefV1Schema,
  origin,
  waiverContext: waiverGateContextSchema,
  artifactApprovalDecisions: allowedDecisionTuples["artifact-approval"],
  designApprovalDecisions: allowedDecisionTuples["design-approval"],
  materialDriftDecisions: allowedDecisionTuples["material-drift"],
  attemptsExhaustedDecisions: allowedDecisionTuples["attempts-exhausted"],
  constitutionEditDecisions: allowedDecisionTuples["constitution-edit"],
  commitAuthorizationDecisions: allowedDecisionTuples["commit-authorization"],
  restoreCollisionDecisions: allowedDecisionTuples["restore-collision"],
  baselineAdoptionDecisions: allowedDecisionTuples["baseline-adoption"],
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
  designApprovalDecisions: { const: GATE_REQUEST_DECISIONS["design-approval"] },
  materialDriftDecisions: { const: GATE_REQUEST_DECISIONS["material-drift"] },
  attemptsExhaustedDecisions: { const: GATE_REQUEST_DECISIONS["attempts-exhausted"] },
  constitutionEditDecisions: { const: GATE_REQUEST_DECISIONS["constitution-edit"] },
  commitAuthorizationDecisions: { const: GATE_REQUEST_DECISIONS["commit-authorization"] },
  restoreCollisionDecisions: { const: GATE_REQUEST_DECISIONS["restore-collision"] },
  baselineAdoptionDecisions: { const: GATE_REQUEST_DECISIONS["baseline-adoption"] },
  migrationAuditDecisions: { const: GATE_REQUEST_DECISIONS["migration-audit"] },
  waiverDecisions: { const: WAIVER_DECISIONS },
});

export const gateDecisionRecordSchemaDefs: Readonly<Record<string, z.ZodType>> = Object.freeze({
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

/**
 * Strictly reads current V1 bytes or either retired, still-authoritative V1 archive shape: a
 * request carrying the retired `supersedes` reference, and a commit-authorization request whose
 * context predates the required `baseline_commit`, `commit_message` and `paths` fields. Each
 * candidate is a `.strict()` union, so a match is exact — nothing is stripped, defaulted or
 * reordered and the value re-digests to its stored digest. The current shape is tried first, so a
 * request written today still parses as a current one.
 */
export function parseArchivedGateRequest(value: unknown): ArchivedGateRequestV1 {
  assertPlainJson(value, "archived gate request");
  for (const candidate of [
    gateRequestV1Schema,
    archivedPolicyGateRequestV1Schema,
    archivedOrdinaryGateRequestV1Schema,
    archivedBaselineAdoptionRequestV1Schema,
    legacyGateRequestV1Schema,
    archivedSupersededOrdinaryGateRequestV1Schema,
    archivedSupersededBaselineAdoptionRequestV1Schema,
  ]) {
    const parsed = candidate.safeParse(value);
    if (parsed.success) return parsed.data as ArchivedGateRequestV1;
  }
  return archivedSupersededOrdinaryGateRequestV1Schema.parse(value) as ArchivedGateRequestV1;
}

/**
 * The one parser every read of a *persisted* gate request uses — an open gate's request.json in
 * status projection, discovery, and gate resolution, exactly like `parseArchivedGateRequest` for
 * decided archives. A gate opened by an older bundle (for example a baseline adoption pinned
 * before `adopt-committed-deletions` existed) must keep projecting and resolving after bundle
 * switchover; only `parseGateRequest` — composing or validating a NEW request — enforces the
 * strict writer shape. The compatibility arms differ from the writer shape only in fields the
 * consumers already treat as data (the `allowed_decisions` list the decision interface iterates,
 * the optional `deleted_projections`, the retired `supersedes` extra), so the runtime type is
 * the honest projection of every accepted form.
 */
export function parsePersistedGateRequest(value: unknown): GateRequestV1 {
  return parseArchivedGateRequest(value) as GateRequestV1;
}

/** Strictly reads retired supplemental ledgers without filtering or changing their digest. */
export function parseArchivedGateDecisionRecord(value: unknown): ArchivedGateDecisionRecordV1 {
  assertPlainJson(value, "archived gate decision record");
  const current = gateDecisionRecordV1Schema.safeParse(value);
  if (current.success) return current.data;
  const supersession = staleBaselineGateSupersessionV1Schema.safeParse(value);
  return (supersession.success ? supersession.data : legacyDecisionRecordV1Schema.parse(value)) as ArchivedGateDecisionRecordV1;
}

export function parseActiveGate(value: unknown): ActiveGateV1 {
  assertPlainJson(value, "active gate");
  for (const candidate of [
    activeGateV1Schema,
    archivedPolicyActiveGateV1Schema,
    archivedOrdinaryActiveGateV1Schema,
    archivedBaselineActiveGateV1Schema,
    archivedSupersededBaselineActiveGateV1Schema,
    archivedSupersededActiveGateV1Schema,
    archivedSupersededOrdinaryActiveGateV1Schema,
  ]) {
    const parsed = candidate.safeParse(value);
    if (parsed.success) return parsed.data as ActiveGateV1;
  }
  return archivedOrdinaryActiveGateV1Schema.parse(value) as ActiveGateV1;
}

export type GateRequestDocument = CanonicalDocument<GateRequestV1>;
export type GateDecisionRecordDocument = CanonicalDocument<GateDecisionRecordV1>;
export type ActiveGateDocument = CanonicalDocument<ActiveGateV1>;

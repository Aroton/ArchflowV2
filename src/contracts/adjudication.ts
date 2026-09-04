import { z } from "zod";

import type { ReferencedEvidence, Sha256Digest, TaskSlug } from "./evidence.js";
import { createTaskSlugV1Schema } from "./evidence.js";
import { assertPlainJson } from "./plain-json.js";
import { ADAPTER_IDS, EFFORT_VALUES, MODEL_FAMILIES, reviewedRepositoriesV1Schema, routeOverrideRecordSchema, routeSourceRecordSchema, type AdapterId, type ModelFamily, type ReviewedRepositoryV1, type RouteOverrideRecord, type RouteSourceRecord, type RuleVersionRef } from "./review.js";

export const CONSTITUTION_RESULTS = ["pass", "fail", "uncertain"] as const;
export const DRIFT_RESULTS = ["aligned", "incidental", "material"] as const;
export const COMPLIANCE_RESULTS = ["pass", "fail", "uncertain"] as const;
export const TRIGGER_RESULTS = ["not-matched", "matched", "uncertain"] as const;

export type ConstitutionResult = (typeof CONSTITUTION_RESULTS)[number];
export type DriftResult = (typeof DRIFT_RESULTS)[number];
export type ComplianceResult = (typeof COMPLIANCE_RESULTS)[number];
export type TriggerResult = (typeof TRIGGER_RESULTS)[number];

export type ConstitutionRuleFinding = RuleVersionRef & {
  readonly compliance: ComplianceResult;
  readonly rationale: string;
  readonly trigger: TriggerResult;
  readonly trigger_evidence: string;
};
export type DriftFinding = {
  readonly upstream_digest: Sha256Digest;
  readonly drift: DriftResult;
  readonly affected_claim_ids: readonly string[];
  readonly rationale: string;
};
export type RawAdjudicationV1 = {
  readonly schema_version: "1";
  readonly task_id: TaskSlug;
  readonly phase_instance: string;
  readonly step: "adjudicate";
  readonly subject_digest: Sha256Digest;
  readonly input_fingerprint: Sha256Digest;
  readonly pinned_constitution_digest: Sha256Digest;
  readonly approved_upstream_digests: readonly Sha256Digest[];
  readonly source_review_envelope_digest: Sha256Digest;
  readonly rule_findings: readonly ConstitutionRuleFinding[];
  readonly drift_findings: readonly DriftFinding[];
};
/** Archived model-output contract retained under its original export name. */
export type RawAdjudication = RawAdjudicationV1;
export type DerivedAdjudicationV1 = RawAdjudicationV1 & {
  readonly constitution: ConstitutionResult;
  readonly drift: DriftResult;
  readonly matched_rule_versions: readonly RuleVersionRef[];
  readonly uncertain_rule_versions: readonly RuleVersionRef[];
};
/** Archived derived contract retained under its original export name. */
export type DerivedAdjudication = DerivedAdjudicationV1;

export type AdjudicationJudgmentV2 = {
  readonly compliance: ComplianceResult;
  readonly rationale: string;
  readonly trigger: TriggerResult;
  readonly trigger_evidence: string;
};

/** The complete fresh child output. It deliberately carries no server or rule identity. */
export type RawAdjudicationV2 = {
  readonly schema_version: "2";
  readonly judgments: Readonly<Record<string, AdjudicationJudgmentV2>>;
};

export type AdjudicationRuleSlotV1 = RuleVersionRef & {
  readonly slot: string;
};

export type DerivedAdjudicationV2 = {
  readonly schema_version: "2";
  readonly rule_findings: readonly ConstitutionRuleFinding[];
  readonly constitution: ConstitutionResult;
  readonly matched_rule_versions: readonly RuleVersionRef[];
  readonly uncertain_rule_versions: readonly RuleVersionRef[];
};

const nonBlank = z.string().min(1).regex(/\S/, "must contain a non-whitespace character");
const id = z.string().regex(/^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/u);
const digest = z.string().regex(/^[0-9a-f]{64}$/u) as unknown as z.ZodType<Sha256Digest>;
const taskSlug = createTaskSlugV1Schema();
const opaqueSlot = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u);
/** Module-local twin of review's rule-version shape so this document emits self-contained. */
const ruleVersionSchema = z.object({ rule_id: id, rule_version: z.number().int().positive().safe() }).strict();
const constitutionRuleFindingSchema = ruleVersionSchema.extend({
  compliance: z.enum(COMPLIANCE_RESULTS),
  rationale: nonBlank,
  trigger: z.enum(TRIGGER_RESULTS),
  trigger_evidence: nonBlank,
}).strict();
export const adjudicationJudgmentV2Schema = z.object({
  compliance: z.enum(COMPLIANCE_RESULTS),
  rationale: nonBlank,
  trigger: z.enum(TRIGGER_RESULTS),
  trigger_evidence: nonBlank,
}).strict();

/** Generic publication shape; dispatch uses createRawAdjudicationV2Schema for exact plan slots. */
export const rawAdjudicationV2Schema = z.object({
  schema_version: z.literal("2"),
  judgments: z.record(opaqueSlot, adjudicationJudgmentV2Schema),
}).strict() as z.ZodType<RawAdjudicationV2>;

export const adjudicationRuleSlotV1Schema = ruleVersionSchema.extend({ slot: opaqueSlot }).strict();

function materializeRuleSlots(value: readonly AdjudicationRuleSlotV1[]): readonly AdjudicationRuleSlotV1[] {
  assertPlainJson(value, "adjudication rule slots");
  const parsed = z.array(adjudicationRuleSlotV1Schema).min(1).parse(structuredClone(value));
  const slots = parsed.map((entry) => entry.slot);
  if (new Set(slots).size !== slots.length) throw new TypeError("adjudication rule slots must be unique");
  const ruleKeys = parsed.map((entry) => `${entry.rule_id}:${entry.rule_version}`);
  if (new Set(ruleKeys).size !== ruleKeys.length || ruleKeys.some((value, index) => index > 0 && ruleKeys[index - 1]!.localeCompare(value) >= 0)) {
    throw new TypeError("adjudication rule slots must follow canonical unique rule order");
  }
  return parsed;
}

function rawAdjudicationV2SchemaFromMaterializedSlots(slots: readonly AdjudicationRuleSlotV1[]) {
  const judgments = Object.fromEntries(slots.map((entry) => [entry.slot, adjudicationJudgmentV2Schema]));
  return z.object({ schema_version: z.literal("2"), judgments: z.object(judgments).strict() }).strict() as z.ZodType<RawAdjudicationV2>;
}

/** Builds the child-visible strict dynamic-slot root for one immutable server plan. */
export function createRawAdjudicationV2Schema(slots: readonly AdjudicationRuleSlotV1[]): z.ZodType<RawAdjudicationV2> {
  return rawAdjudicationV2SchemaFromMaterializedSlots(materializeRuleSlots(slots));
}

export function parseRawAdjudicationV2(value: unknown, slots: readonly AdjudicationRuleSlotV1[]): RawAdjudicationV2 {
  const materializedSlots = materializeRuleSlots(slots);
  assertPlainJson(value, "adjudication V2 output");
  return rawAdjudicationV2SchemaFromMaterializedSlots(materializedSlots).parse(structuredClone(value));
}

export function parseAndDeriveAdjudicationV2(value: unknown, slots: readonly AdjudicationRuleSlotV1[]): DerivedAdjudicationV2 {
  const materializedSlots = materializeRuleSlots(slots);
  assertPlainJson(value, "adjudication V2 output");
  const parsed = rawAdjudicationV2SchemaFromMaterializedSlots(materializedSlots).parse(structuredClone(value));
  const rule_findings = materializedSlots.map(({ slot, rule_id, rule_version }) => ({
    rule_id,
    rule_version,
    ...parsed.judgments[slot]!,
  }));
  const constitution: ConstitutionResult = rule_findings.some((finding) => finding.compliance === "fail")
    ? "fail"
    : rule_findings.some((finding) => finding.compliance === "uncertain") ? "uncertain" : "pass";
  const matched_rule_versions = rule_findings
    .filter((finding) => finding.trigger === "matched")
    .map(({ rule_id, rule_version }) => ({ rule_id, rule_version }));
  const uncertain_rule_versions = rule_findings
    .filter((finding) => finding.trigger === "uncertain")
    .map(({ rule_id, rule_version }) => ({ rule_id, rule_version }));
  return {
    schema_version: "2",
    rule_findings,
    constitution,
    matched_rule_versions,
    uncertain_rule_versions,
  };
}
const driftFindingSchema = z.object({
  upstream_digest: digest,
  drift: z.enum(DRIFT_RESULTS),
  affected_claim_ids: z.array(id),
  rationale: nonBlank,
}).strict().superRefine((finding, context) => {
  if ((finding.drift === "aligned") !== (finding.affected_claim_ids.length === 0)) context.addIssue({ code: "custom", path: ["affected_claim_ids"], message: "aligned drift has no affected claims; other drift must identify claims" });
  if (new Set(finding.affected_claim_ids).size !== finding.affected_claim_ids.length) context.addIssue({ code: "custom", path: ["affected_claim_ids"], message: "duplicate affected claim" });
});

const rawAdjudicationTransportSchema = z.object({
  schema_version: z.literal("1"), task_id: taskSlug,
  phase_instance: z.string().regex(/^(?:prd|design|phase-(?:design|impl)-[1-9][0-9]*)$/u),
  step: z.literal("adjudicate"), subject_digest: digest, input_fingerprint: digest,
  pinned_constitution_digest: digest, approved_upstream_digests: z.array(digest), source_review_envelope_digest: digest,
  rule_findings: z.array(constitutionRuleFindingSchema), drift_findings: z.array(driftFindingSchema),
}).strict();

export const rawAdjudicationSchema = rawAdjudicationTransportSchema.superRefine((adjudication, context) => {
  try { validateAdjudicationFindings(adjudication); }
  catch (error) { context.addIssue({ code: "custom", message: error instanceof Error ? error.message : "invalid adjudication semantics" }); }
});

const ruleKey = (rule: RuleVersionRef) => `${rule.rule_id}:${rule.rule_version}`;
function assertSortedUnique(values: readonly string[], label: string): void {
  if (new Set(values).size !== values.length || values.some((value, index) => index > 0 && values[index - 1]! >= value)) throw new TypeError(`${label} must be sorted and unique`);
}
function sameRuleSet(actual: readonly RuleVersionRef[], expected: readonly RuleVersionRef[]): boolean {
  return actual.length === expected.length && actual.every((rule, index) => ruleKey(rule) === ruleKey(expected[index]!));
}

function validateAdjudicationFindings(parsed: RawAdjudication): void {
  assertSortedUnique(parsed.approved_upstream_digests, "approved_upstream_digests");
  assertSortedUnique(parsed.rule_findings.map(ruleKey), "rule_findings");
  assertSortedUnique(parsed.drift_findings.map((finding) => finding.upstream_digest), "drift_findings");
  if (parsed.drift_findings.length !== parsed.approved_upstream_digests.length || parsed.drift_findings.some((finding, index) => finding.upstream_digest !== parsed.approved_upstream_digests[index])) throw new TypeError("drift_findings must exactly cover approved_upstream_digests");
}

/** Model output uses arrays for sets; canonical evidence owns their order. */
function canonicalizeAdjudicationFindings(parsed: RawAdjudication): RawAdjudication {
  return {
    ...parsed,
    approved_upstream_digests: [...parsed.approved_upstream_digests].sort(),
    rule_findings: [...parsed.rule_findings].sort((left, right) => ruleKey(left).localeCompare(ruleKey(right))),
    drift_findings: [...parsed.drift_findings].sort((left, right) => left.upstream_digest.localeCompare(right.upstream_digest)),
  };
}

function deriveAdjudicationSummaries(parsed: RawAdjudication): Pick<DerivedAdjudication, "constitution" | "drift" | "matched_rule_versions" | "uncertain_rule_versions"> {
  const expectedConstitution: ConstitutionResult = parsed.rule_findings.some((finding) => finding.compliance === "fail") ? "fail" : parsed.rule_findings.some((finding) => finding.compliance === "uncertain") ? "uncertain" : "pass";
  const expectedDrift: DriftResult = parsed.drift_findings.some((finding) => finding.drift === "material") ? "material" : parsed.drift_findings.some((finding) => finding.drift === "incidental") ? "incidental" : "aligned";
  const matched = parsed.rule_findings.filter((finding) => finding.trigger === "matched").map(({ rule_id, rule_version }) => ({ rule_id, rule_version }));
  const uncertain = parsed.rule_findings.filter((finding) => finding.trigger === "uncertain").map(({ rule_id, rule_version }) => ({ rule_id, rule_version }));
  return {
    constitution: expectedConstitution,
    drift: expectedDrift,
    matched_rule_versions: matched,
    uncertain_rule_versions: uncertain,
  };
}

const derivedAdjudicationSchema = rawAdjudicationSchema.safeExtend({
  constitution: z.enum(CONSTITUTION_RESULTS), drift: z.enum(DRIFT_RESULTS),
  matched_rule_versions: z.array(ruleVersionSchema), uncertain_rule_versions: z.array(ruleVersionSchema),
}).strict().superRefine((adjudication, context) => {
  const expected = deriveAdjudicationSummaries(adjudication);
  if (adjudication.constitution !== expected.constitution) context.addIssue({ code: "custom", path: ["constitution"], message: `constitution must be ${expected.constitution}` });
  if (adjudication.drift !== expected.drift) context.addIssue({ code: "custom", path: ["drift"], message: `drift must be ${expected.drift}` });
  if (!sameRuleSet(adjudication.matched_rule_versions, expected.matched_rule_versions)) context.addIssue({ code: "custom", path: ["matched_rule_versions"], message: "matched_rule_versions contradict rule findings" });
  if (!sameRuleSet(adjudication.uncertain_rule_versions, expected.uncertain_rule_versions)) context.addIssue({ code: "custom", path: ["uncertain_rule_versions"], message: "uncertain_rule_versions contradict rule findings" });
});

const derivedAdjudicationV2Schema = z.object({
  schema_version: z.literal("2"),
  rule_findings: z.array(constitutionRuleFindingSchema),
  constitution: z.enum(CONSTITUTION_RESULTS),
  matched_rule_versions: z.array(ruleVersionSchema),
  uncertain_rule_versions: z.array(ruleVersionSchema),
}).strict().superRefine((adjudication, context) => {
  const keys = adjudication.rule_findings.map(ruleKey);
  if (new Set(keys).size !== keys.length || keys.some((value, index) => index > 0 && keys[index - 1]!.localeCompare(value) >= 0)) {
    context.addIssue({ code: "custom", path: ["rule_findings"], message: "rule findings must use canonical unique order" });
  }
  const constitution: ConstitutionResult = adjudication.rule_findings.some((finding) => finding.compliance === "fail")
    ? "fail"
    : adjudication.rule_findings.some((finding) => finding.compliance === "uncertain") ? "uncertain" : "pass";
  const matched = adjudication.rule_findings.filter((finding) => finding.trigger === "matched").map(({ rule_id, rule_version }) => ({ rule_id, rule_version }));
  const uncertain = adjudication.rule_findings.filter((finding) => finding.trigger === "uncertain").map(({ rule_id, rule_version }) => ({ rule_id, rule_version }));
  if (adjudication.constitution !== constitution) context.addIssue({ code: "custom", path: ["constitution"], message: `constitution must be ${constitution}` });
  if (!sameRuleSet(adjudication.matched_rule_versions, matched)) context.addIssue({ code: "custom", path: ["matched_rule_versions"], message: "matched_rule_versions contradict rule findings" });
  if (!sameRuleSet(adjudication.uncertain_rule_versions, uncertain)) context.addIssue({ code: "custom", path: ["uncertain_rule_versions"], message: "uncertain_rule_versions contradict rule findings" });
});

/**
 * The generated `adjudication.schema.json` `$defs` layout. The def name is load-bearing:
 * `projectCliOutputSchema` rewrites `taskSlug` (lookahead simplification) by name before handing
 * the document to a child host, and the document must stay self-contained because hosts cannot
 * resolve cross-document references.
 */
export const adjudicationDocumentDefs = {
  taskSlug,
} as const;

export function parseAndDeriveAdjudication(value: unknown): DerivedAdjudication {
  assertPlainJson(value, "adjudication");
  const parsed = canonicalizeAdjudicationFindings(rawAdjudicationTransportSchema.parse(structuredClone(value)));
  validateAdjudicationFindings(parsed);
  return { ...parsed, ...deriveAdjudicationSummaries(parsed) };
}

type AdjudicationProvenanceBase = DerivedAdjudicationV1 & { readonly model_family: ModelFamily | "unknown"; readonly model: string; readonly effort: (typeof EFFORT_VALUES)[number] | "unknown" };
export type AgentDeclaredAdjudication = AdjudicationProvenanceBase & { readonly assurance: "agent-declared" };
export type ServerAttestedAdjudicationV1 = Omit<AdjudicationProvenanceBase, "model_family" | "effort"> & { readonly assurance: "server-attested"; readonly adapter: AdapterId; readonly cli_version: string; readonly model_family: ModelFamily; readonly effort: (typeof EFFORT_VALUES)[number]; readonly invocation_id: string; readonly envelope_input_digest: Sha256Digest; readonly observed_output_digest: Sha256Digest; readonly result_id: string; readonly provider?: string; readonly route_source?: RouteSourceRecord; readonly route_override?: RouteOverrideRecord; /** Optional on read for archived evidence; every fresh server mint supplies it. */ readonly repositories?: readonly ReviewedRepositoryV1[] };
export type ServerAttestedAdjudicationV2 = DerivedAdjudicationV2 & {
  readonly task_id: TaskSlug;
  readonly phase_instance: string;
  readonly step: "adjudicate";
  readonly subject_digest: Sha256Digest;
  readonly input_fingerprint: Sha256Digest;
  readonly pinned_constitution_digest: Sha256Digest;
  readonly source_review_envelope_digest: Sha256Digest;
  readonly assurance: "server-attested";
  readonly adapter: AdapterId;
  readonly cli_version: string;
  readonly model_family: ModelFamily;
  readonly model: string;
  readonly effort: (typeof EFFORT_VALUES)[number];
  readonly invocation_id: string;
  readonly envelope_input_digest: Sha256Digest;
  readonly observed_output_digest: Sha256Digest;
  readonly result_id: string;
  readonly provider?: string;
  readonly route_source: RouteSourceRecord;
  readonly route_override?: RouteOverrideRecord;
  readonly repositories: readonly ReviewedRepositoryV1[];
};
export type ServerAttestedAdjudication = ServerAttestedAdjudicationV1 | ServerAttestedAdjudicationV2;
export type DegradedAdjudication = AdjudicationProvenanceBase & { readonly assurance: "degraded"; readonly reason: string };
export type AdjudicationEvidence = AgentDeclaredAdjudication | ServerAttestedAdjudication | DegradedAdjudication;

const provenanceBase = derivedAdjudicationSchema.safeExtend({ model_family: z.union([z.enum(MODEL_FAMILIES), z.literal("unknown")]), model: nonBlank, effort: z.union([z.enum(EFFORT_VALUES), z.literal("unknown")]) });
const agentSchema = provenanceBase.safeExtend({ assurance: z.literal("agent-declared") }).strict();
const serverSchema = provenanceBase.safeExtend({ assurance: z.literal("server-attested"), adapter: z.enum(ADAPTER_IDS), cli_version: nonBlank, model_family: z.enum(MODEL_FAMILIES), effort: z.enum(EFFORT_VALUES), invocation_id: id, envelope_input_digest: digest, observed_output_digest: digest, result_id: id, provider: nonBlank.optional(), route_source: routeSourceRecordSchema.optional(), route_override: routeOverrideRecordSchema.optional(), repositories: reviewedRepositoriesV1Schema.optional() }).strict();
const degradedSchema = provenanceBase.safeExtend({ assurance: z.literal("degraded"), reason: nonBlank }).strict();
const adjudicationEvidenceV1Schema = z.discriminatedUnion("assurance", [agentSchema, serverSchema, degradedSchema]);
export const serverAttestedAdjudicationV2Schema = derivedAdjudicationV2Schema.safeExtend({
  task_id: taskSlug,
  phase_instance: z.string().regex(/^(?:prd|design|phase-(?:design|impl)-[1-9][0-9]*)$/u),
  step: z.literal("adjudicate"),
  subject_digest: digest,
  input_fingerprint: digest,
  pinned_constitution_digest: digest,
  source_review_envelope_digest: digest,
  assurance: z.literal("server-attested"),
  adapter: z.enum(ADAPTER_IDS),
  cli_version: nonBlank,
  model_family: z.enum(MODEL_FAMILIES),
  model: nonBlank,
  effort: z.enum(EFFORT_VALUES),
  invocation_id: id,
  envelope_input_digest: digest,
  observed_output_digest: digest,
  result_id: id,
  provider: nonBlank.optional(),
  route_source: routeSourceRecordSchema,
  route_override: routeOverrideRecordSchema.optional(),
  repositories: reviewedRepositoriesV1Schema,
}).strict();
export const adjudicationEvidenceSchema = z.discriminatedUnion("schema_version", [adjudicationEvidenceV1Schema, serverAttestedAdjudicationV2Schema]);
// See parseReviewEvidence: the assertion narrows zod's `| undefined` inference on the optional
// route_override back to the exact persisted shape; no parsed value ever carries the key as undefined.
export function parseAdjudicationEvidence(value: unknown): AdjudicationEvidence { assertPlainJson(value, "adjudication evidence"); return adjudicationEvidenceSchema.parse(structuredClone(value)) as AdjudicationEvidence; }
const referencedAdjudicationWrapperSchema = z.object({ evidence_digest: digest, evidence: z.unknown() }).strict();
export function parseReferencedAdjudicationEvidence(value: unknown): ReferencedEvidence<AdjudicationEvidence> {
  assertPlainJson(value, "referenced adjudication evidence");
  const wrapper = referencedAdjudicationWrapperSchema.parse(structuredClone(value));
  return { evidence_digest: wrapper.evidence_digest, evidence: adjudicationEvidenceSchema.parse(wrapper.evidence) as AdjudicationEvidence };
}

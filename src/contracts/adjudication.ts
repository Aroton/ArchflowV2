import { z } from "zod";

import type { ReferencedEvidence, Sha256Digest, TaskSlug } from "./evidence.js";
import { createTaskSlugV1Schema } from "./evidence.js";
import { assertPlainJson } from "./plain-json.js";
import { ADAPTER_IDS, EFFORT_VALUES, MODEL_FAMILIES, type AdapterId, type ModelFamily, type RuleVersionRef } from "./review.js";

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
export type RawAdjudication = {
  readonly schema_version: "1";
  readonly task_id: TaskSlug;
  readonly phase_instance: string;
  readonly step: "adjudicate";
  readonly subject_digest: Sha256Digest;
  readonly input_fingerprint: Sha256Digest;
  readonly pinned_constitution_digest: Sha256Digest;
  readonly approved_upstream_digests: readonly Sha256Digest[];
  readonly source_evidence_set_digest: Sha256Digest;
  readonly rule_findings: readonly ConstitutionRuleFinding[];
  readonly drift_findings: readonly DriftFinding[];
  readonly constitution: ConstitutionResult;
  readonly drift: DriftResult;
  readonly matched_rule_versions: readonly RuleVersionRef[];
  readonly uncertain_rule_versions: readonly RuleVersionRef[];
};
/** Semantically checked adjudication data. This type intentionally carries no authority brand. */
export type DerivedAdjudication = RawAdjudication;

const nonBlank = z.string().min(1).regex(/\S/, "must contain a non-whitespace character");
const id = z.string().regex(/^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/u);
const digest = z.string().regex(/^[0-9a-f]{64}$/u) as unknown as z.ZodType<Sha256Digest>;
const taskSlug = createTaskSlugV1Schema();
/** Module-local twin of review's rule-version shape so this document emits self-contained. */
const ruleVersionSchema = z.object({ rule_id: id, rule_version: z.number().int().positive().safe() }).strict();
const constitutionRuleFindingSchema = ruleVersionSchema.extend({
  compliance: z.enum(COMPLIANCE_RESULTS),
  rationale: nonBlank,
  trigger: z.enum(TRIGGER_RESULTS),
  trigger_evidence: nonBlank,
}).strict();
const driftFindingSchema = z.object({
  upstream_digest: digest,
  drift: z.enum(DRIFT_RESULTS),
  affected_claim_ids: z.array(id),
  rationale: nonBlank,
}).strict().superRefine((finding, context) => {
  if ((finding.drift === "aligned") !== (finding.affected_claim_ids.length === 0)) context.addIssue({ code: "custom", path: ["affected_claim_ids"], message: "aligned drift has no affected claims; other drift must identify claims" });
  if (new Set(finding.affected_claim_ids).size !== finding.affected_claim_ids.length) context.addIssue({ code: "custom", path: ["affected_claim_ids"], message: "duplicate affected claim" });
});

export const rawAdjudicationSchema = z.object({
  schema_version: z.literal("1"), task_id: taskSlug,
  phase_instance: z.string().regex(/^(?:prd|design|phase-(?:design|impl)-[1-9][0-9]*)$/u),
  step: z.literal("adjudicate"), subject_digest: digest, input_fingerprint: digest,
  pinned_constitution_digest: digest, approved_upstream_digests: z.array(digest), source_evidence_set_digest: digest,
  rule_findings: z.array(constitutionRuleFindingSchema), drift_findings: z.array(driftFindingSchema),
  constitution: z.enum(CONSTITUTION_RESULTS), drift: z.enum(DRIFT_RESULTS),
  matched_rule_versions: z.array(ruleVersionSchema), uncertain_rule_versions: z.array(ruleVersionSchema),
}).strict().superRefine((adjudication, context) => {
  try { validateAdjudicationClaims(adjudication); }
  catch (error) { context.addIssue({ code: "custom", message: error instanceof Error ? error.message : "invalid adjudication semantics" }); }
});

const ruleKey = (rule: RuleVersionRef) => `${rule.rule_id}:${rule.rule_version}`;
function assertSortedUnique(values: readonly string[], label: string): void {
  if (new Set(values).size !== values.length || values.some((value, index) => index > 0 && values[index - 1]! >= value)) throw new TypeError(`${label} must be sorted and unique`);
}
function sameRuleSet(actual: readonly RuleVersionRef[], expected: readonly RuleVersionRef[]): boolean {
  return actual.length === expected.length && actual.every((rule, index) => ruleKey(rule) === ruleKey(expected[index]!));
}

function validateAdjudicationClaims(parsed: RawAdjudication): void {
  assertSortedUnique(parsed.approved_upstream_digests, "approved_upstream_digests");
  assertSortedUnique(parsed.rule_findings.map(ruleKey), "rule_findings");
  assertSortedUnique(parsed.drift_findings.map((finding) => finding.upstream_digest), "drift_findings");
  if (parsed.drift_findings.length !== parsed.approved_upstream_digests.length || parsed.drift_findings.some((finding, index) => finding.upstream_digest !== parsed.approved_upstream_digests[index])) throw new TypeError("drift_findings must exactly cover approved_upstream_digests");
  const expectedConstitution: ConstitutionResult = parsed.rule_findings.some((finding) => finding.compliance === "fail") ? "fail" : parsed.rule_findings.some((finding) => finding.compliance === "uncertain") ? "uncertain" : "pass";
  if (parsed.constitution !== expectedConstitution) throw new TypeError(`constitution must be ${expectedConstitution}`);
  const expectedDrift: DriftResult = parsed.drift_findings.some((finding) => finding.drift === "material") ? "material" : parsed.drift_findings.some((finding) => finding.drift === "incidental") ? "incidental" : "aligned";
  if (parsed.drift !== expectedDrift) throw new TypeError(`drift must be ${expectedDrift}`);
  const matched = parsed.rule_findings.filter((finding) => finding.trigger === "matched").map(({ rule_id, rule_version }) => ({ rule_id, rule_version }));
  const uncertain = parsed.rule_findings.filter((finding) => finding.trigger === "uncertain").map(({ rule_id, rule_version }) => ({ rule_id, rule_version }));
  if (!sameRuleSet(parsed.matched_rule_versions, matched)) throw new TypeError("matched_rule_versions contradict rule findings");
  if (!sameRuleSet(parsed.uncertain_rule_versions, uncertain)) throw new TypeError("uncertain_rule_versions contradict rule findings");
}

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
  const parsed = rawAdjudicationSchema.parse(value);
  validateAdjudicationClaims(parsed);
  return parsed;
}

type AdjudicationProvenanceBase = DerivedAdjudication & { readonly model_family: ModelFamily | "unknown"; readonly model: string; readonly effort: (typeof EFFORT_VALUES)[number] | "unknown" };
export type AgentDeclaredAdjudication = AdjudicationProvenanceBase & { readonly assurance: "agent-declared" };
export type ServerAttestedAdjudication = Omit<AdjudicationProvenanceBase, "model_family" | "effort"> & { readonly assurance: "server-attested"; readonly adapter: AdapterId; readonly cli_version: string; readonly model_family: ModelFamily; readonly effort: (typeof EFFORT_VALUES)[number]; readonly invocation_id: string; readonly envelope_input_digest: Sha256Digest; readonly observed_output_digest: Sha256Digest; readonly result_id: string };
export type DegradedAdjudication = AdjudicationProvenanceBase & { readonly assurance: "degraded"; readonly reason: string };
export type AdjudicationEvidence = AgentDeclaredAdjudication | ServerAttestedAdjudication | DegradedAdjudication;

const provenanceBase = rawAdjudicationSchema.safeExtend({ model_family: z.union([z.enum(MODEL_FAMILIES), z.literal("unknown")]), model: nonBlank, effort: z.union([z.enum(EFFORT_VALUES), z.literal("unknown")]) });
const agentSchema = provenanceBase.safeExtend({ assurance: z.literal("agent-declared") }).strict();
const serverSchema = provenanceBase.safeExtend({ assurance: z.literal("server-attested"), adapter: z.enum(ADAPTER_IDS), cli_version: nonBlank, model_family: z.enum(MODEL_FAMILIES), effort: z.enum(EFFORT_VALUES), invocation_id: id, envelope_input_digest: digest, observed_output_digest: digest, result_id: id }).strict();
const degradedSchema = provenanceBase.safeExtend({ assurance: z.literal("degraded"), reason: nonBlank }).strict();
export const adjudicationEvidenceSchema = z.discriminatedUnion("assurance", [agentSchema, serverSchema, degradedSchema]);
export function parseAdjudicationEvidence(value: unknown): AdjudicationEvidence { assertPlainJson(value, "adjudication evidence"); const parsed = adjudicationEvidenceSchema.parse(value); validateAdjudicationClaims(parsed); return parsed; }
export function parseReferencedAdjudicationEvidence(value: unknown): ReferencedEvidence<AdjudicationEvidence> {
  assertPlainJson(value, "referenced adjudication evidence");
  const wrapper = z.object({ evidence_digest: digest, evidence: z.unknown() }).strict().parse(value);
  return { evidence_digest: wrapper.evidence_digest, evidence: parseAdjudicationEvidence(wrapper.evidence) };
}

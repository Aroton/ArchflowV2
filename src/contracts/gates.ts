import { isDeepStrictEqual } from "node:util";

import { z } from "zod";

import type { Sha256Digest } from "./evidence.js";
import { pathSafeIdV1Schema, taskSlugV1Schema, type PathSafeId, type TaskSlug } from "./evidence.js";
import { safeIdV1Schema } from "./evidence.js";
import { assertPlainJson } from "./plain-json.js";
import { decodePhaseInstance, type PhaseInstanceId } from "./phase-instance.js";
import { taskPathClaimV1Schema, type PathClass, type TaskPathClaim } from "./path-claims.js";
import { PIPELINE_STEPS, type PipelineStep } from "./vocabulary.js";

export type RuleVersionRef = { readonly rule_id: string; readonly rule_version: number };
export type EvidenceIdentityKind = "prd" | "architecture" | "phase-design" | "implementation-result" | "review" | "adjudication" | "constitution" | "workflow" | "import";
export type EvidenceIdentityRef = { readonly kind: EvidenceIdentityKind; readonly digest: Sha256Digest };
export type WaivableOperation = "review-trigger" | "adjudication-failure";
export type WaiverScope = { readonly operation: WaivableOperation; readonly boundary: "subject" | "phase" | "task" };
export type HumanRuleResolution = { readonly rule: RuleVersionRef; readonly resolution: string };

export type HumanDecisionProvenance =
  | Readonly<{ schema_version: "1"; actor_class: "human" | "archforge"; assurance: "declared-local-trace"; channel: "connected-host"; decision_event_id: string; connection_id: string; request_id_digest: Sha256Digest; recorded_at: string }>
  | Readonly<{ schema_version: "1"; actor_class: "human" | "archforge"; assurance: "declared-local-trace"; channel: "archflow-local"; decision_event_id: string; helper_invocation_id: string; recorded_at: string }>;

export type AuthorityLinkRef = {
  readonly link_digest: Sha256Digest;
  readonly purpose: "restore-adoption";
  readonly proposed_generation_digest: Sha256Digest;
  readonly changed_input_fingerprint: Sha256Digest;
}

export interface GateContractByKind {
  readonly "artifact-approval": { readonly context: { readonly artifact_kind: "prd" | "design" | "phase-design" | "phase-implementation" }; readonly decision: { readonly decision: "approve" | "revise" | "reject"; readonly reason: string } };
  readonly "review-trigger": { readonly context: { readonly matched_rules: readonly RuleVersionRef[]; readonly uncertain_rules: readonly RuleVersionRef[]; readonly eligible_waiver_rules: readonly RuleVersionRef[]; readonly waiver_scope: WaiverScope }; readonly decision: { readonly decision: "approve" | "revise" | "reject"; readonly reason: string } | { readonly decision: "waiver-requested"; readonly reason: string; readonly rule: RuleVersionRef; readonly rationale: string } };
  readonly "material-drift": { readonly context: { readonly affected_upstream: EvidenceIdentityRef; readonly drift: "material"; readonly affected_claim_ids: readonly string[] }; readonly decision: { readonly decision: "amend-upstream" | "revise-current" | "reject"; readonly reason: string } };
  readonly "adjudication-failure": { readonly context: { readonly constitution: "fail" | "uncertain"; readonly failed_rules: readonly RuleVersionRef[]; readonly uncertain_rules: readonly RuleVersionRef[]; readonly eligible_waiver_rules: readonly RuleVersionRef[]; readonly waiver_scope: WaiverScope }; readonly decision: { readonly decision: "approve"; readonly reason: string; readonly resolutions: readonly HumanRuleResolution[] } | { readonly decision: "revise" | "reject"; readonly reason: string } | { readonly decision: "waiver-requested"; readonly reason: string; readonly rule: RuleVersionRef; readonly rationale: string } };
  readonly "attempts-exhausted": { readonly context: { readonly step: PipelineStep; readonly attempts: number; readonly maximum_attempts: number }; readonly decision: { readonly decision: "retry-once" | "revise" | "abort"; readonly reason: string } };
  readonly "constitution-edit": { readonly context: { readonly pinned_constitution_digest: Sha256Digest; readonly current_constitution_digest: Sha256Digest; readonly changed_path_class: "task-branch-constitution" }; readonly decision: { readonly decision: "revert-edit" | "start-base-amendment" | "abort"; readonly reason: string } };
  readonly "commit-authorization": { readonly context: { readonly target_ref: string; readonly diff_digest: Sha256Digest; readonly current_artifact_digests: readonly Sha256Digest[]; readonly parent_document_digests: readonly Sha256Digest[] }; readonly decision: { readonly decision: "authorize-commit" | "revise" | "abort"; readonly reason: string } };
  readonly "restore-collision": { readonly context: { readonly path: TaskPathClaim; readonly recorded_generation_digest: Sha256Digest; readonly current_generation_digest: Sha256Digest; readonly adoption_candidate?: AuthorityLinkRef }; readonly decision: { readonly decision: "discard-and-restore" | "abort"; readonly reason: string } | { readonly decision: "adopt-as-new-generation"; readonly reason: string; readonly adoption_authority: AuthorityLinkRef; readonly rationale: string } };
  readonly "migration-audit": { readonly context: { readonly source_identity_digest: Sha256Digest; readonly destination_identity_digest: Sha256Digest; readonly import_digest: Sha256Digest; readonly code_baseline_digest: Sha256Digest; readonly policy_baseline_digest: Sha256Digest }; readonly decision: { readonly decision: "accept-import-audit" | "revise" | "abort"; readonly reason: string } };
}

export const GATE_KINDS = ["artifact-approval", "review-trigger", "material-drift", "adjudication-failure", "attempts-exhausted", "constitution-edit", "commit-authorization", "restore-collision", "migration-audit"] as const;
export type GateKind = keyof GateContractByKind;
export type GateContext<K extends GateKind> = GateContractByKind[K]["context"];
export type GateDecisionPayload<K extends GateKind> = GateContractByKind[K]["decision"];
export type GateEffect = "advance" | "retry" | "redirect-waiver" | "redirect-upstream" | "non-advancing";

export type GateDecisionEnvelopeBase = { readonly schema_version: "1"; readonly gate_id: PathSafeId; readonly task_id: TaskSlug; readonly phase_instance: PhaseInstanceId; readonly subject_digest: Sha256Digest; readonly context_digest: Sha256Digest; readonly human_provenance: HumanDecisionProvenance };
export type GateDecisionEnvelope<K extends GateKind = GateKind> = { readonly [P in K]: GateDecisionEnvelopeBase & { readonly kind: P; readonly payload: GateDecisionPayload<P> } }[K];

/** Exact archived origin binding consumed by the later waiver owner. */
export type WaiverOriginRef = {
  readonly origin_gate_id: PathSafeId;
  readonly origin_decision_digest: Sha256Digest;
  readonly origin_context_digest: Sha256Digest;
  readonly task_id: TaskSlug;
  readonly phase_instance: PhaseInstanceId;
  readonly subject_digest: Sha256Digest;
  readonly current_evidence_set_digest: Sha256Digest;
  readonly rule: RuleVersionRef;
  readonly scope: WaiverScope;
}

const safeId = safeIdV1Schema;
const boundedText = z.string().min(1).max(4096).regex(/\S/u);
const digest = z.string().regex(/^[0-9a-f]{64}$/u);
const safeInteger = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
const rule = z.object({ rule_id: safeId, rule_version: z.number().int().positive().max(Number.MAX_SAFE_INTEGER) }).strict();
const ruleResolution = z.object({ rule, resolution: boundedText }).strict();
const waiverScope = z.object({ operation: z.enum(["review-trigger", "adjudication-failure"]), boundary: z.enum(["subject", "phase", "task"]) }).strict();
const authorityLink = z.object({ link_digest: digest, purpose: z.literal("restore-adoption"), proposed_generation_digest: digest, changed_input_fingerprint: digest }).strict();
const reason = boundedText;
const decision = <T extends readonly [string, ...string[]]>(values: T) => z.object({ decision: z.enum(values), reason }).strict();
const sortedUnique = <T>(items: readonly T[], compare: (left: T, right: T) => number): boolean => items.every((item, index) => index === 0 || compare(items[index - 1]!, item) < 0);
const compareRules = (left: RuleVersionRef, right: RuleVersionRef): number => left.rule_id.localeCompare(right.rule_id) || left.rule_version - right.rule_version;
const canonicalRules = z.array(rule).superRefine((items, context) => { if (!sortedUnique(items, compareRules)) context.addIssue({ code: "custom", message: "rules must be sorted and unique" }); });
const canonicalStrings = z.array(safeId).superRefine((items, context) => { if (!sortedUnique(items, (a, b) => a.localeCompare(b))) context.addIssue({ code: "custom", message: "values must be sorted and unique" }); });
const canonicalDigests = z.array(digest).superRefine((items, context) => { if (!sortedUnique(items, (a, b) => a.localeCompare(b))) context.addIssue({ code: "custom", message: "digests must be sorted and unique" }); });

const contexts = {
  "artifact-approval": z.object({ artifact_kind: z.enum(["prd", "design", "phase-design", "phase-implementation"]) }).strict(),
  "review-trigger": z.object({ matched_rules: canonicalRules, uncertain_rules: canonicalRules, eligible_waiver_rules: canonicalRules, waiver_scope: waiverScope }).strict().superRefine((value, context) => {
    if (value.waiver_scope.operation !== "review-trigger") context.addIssue({ code: "custom", message: "waiver operation must match gate kind" });
    const available = new Set([...value.matched_rules, ...value.uncertain_rules].map(ruleKey));
    for (const item of value.eligible_waiver_rules) if (!available.has(ruleKey(item))) context.addIssue({ code: "custom", message: "eligible waiver rule must be matched or uncertain" });
  }),
  "material-drift": z.object({ affected_upstream: z.object({ kind: z.enum(["prd", "architecture", "phase-design", "implementation-result", "review", "adjudication", "constitution", "workflow", "import"]), digest }).strict(), drift: z.literal("material"), affected_claim_ids: canonicalStrings.min(1) }).strict(),
  "adjudication-failure": z.object({ constitution: z.enum(["fail", "uncertain"]), failed_rules: canonicalRules, uncertain_rules: canonicalRules, eligible_waiver_rules: canonicalRules, waiver_scope: waiverScope }).strict().superRefine((value, context) => {
    if (value.waiver_scope.operation !== "adjudication-failure") context.addIssue({ code: "custom", message: "waiver operation must match gate kind" });
    const available = new Set([...value.failed_rules, ...value.uncertain_rules].map(ruleKey));
    for (const item of value.eligible_waiver_rules) if (!available.has(ruleKey(item))) context.addIssue({ code: "custom", message: "eligible waiver rule must be failed or uncertain" });
    if (available.size === 0) context.addIssue({ code: "custom", message: "adjudication failure must identify a rule" });
  }),
  "attempts-exhausted": z.object({ step: z.enum(PIPELINE_STEPS), attempts: safeInteger, maximum_attempts: safeInteger }).strict().refine((value) => value.attempts >= value.maximum_attempts, "attempts must be at least maximum_attempts"),
  "constitution-edit": z.object({ pinned_constitution_digest: digest, current_constitution_digest: digest, changed_path_class: z.literal("task-branch-constitution" satisfies PathClass) }).strict(),
  "commit-authorization": z.object({ target_ref: boundedText, diff_digest: digest, current_artifact_digests: canonicalDigests.min(1), parent_document_digests: canonicalDigests.min(1) }).strict(),
  "restore-collision": z.object({ path: taskPathClaimV1Schema, recorded_generation_digest: digest, current_generation_digest: digest, adoption_candidate: authorityLink.optional() }).strict(),
  "migration-audit": z.object({ source_identity_digest: digest, destination_identity_digest: digest, import_digest: digest, code_baseline_digest: digest, policy_baseline_digest: digest }).strict(),
} as const;

const decisions = {
  "artifact-approval": decision(["approve", "revise", "reject"]),
  "review-trigger": z.union([decision(["approve", "revise", "reject"]), z.object({ decision: z.literal("waiver-requested"), reason, rule, rationale: boundedText }).strict()]),
  "material-drift": decision(["amend-upstream", "revise-current", "reject"]),
  "adjudication-failure": z.union([z.object({ decision: z.literal("approve"), reason, resolutions: z.array(ruleResolution) }).strict(), decision(["revise", "reject"]), z.object({ decision: z.literal("waiver-requested"), reason, rule, rationale: boundedText }).strict()]),
  "attempts-exhausted": decision(["retry-once", "revise", "abort"]),
  "constitution-edit": decision(["revert-edit", "start-base-amendment", "abort"]),
  "commit-authorization": decision(["authorize-commit", "revise", "abort"]),
  "restore-collision": z.union([decision(["discard-and-restore", "abort"]), z.object({ decision: z.literal("adopt-as-new-generation"), reason, adoption_authority: authorityLink, rationale: boundedText }).strict()]),
  "migration-audit": decision(["accept-import-audit", "revise", "abort"]),
} as const;

const effects = Object.freeze({
  approve: "advance", revise: "retry", reject: "non-advancing", "waiver-requested": "redirect-waiver", "amend-upstream": "redirect-upstream", "revise-current": "retry", "retry-once": "retry", abort: "non-advancing", "revert-edit": "retry", "start-base-amendment": "redirect-upstream", "authorize-commit": "advance", "discard-and-restore": "advance", "adopt-as-new-generation": "advance", "accept-import-audit": "advance",
} as const satisfies Readonly<Record<GateDecisionPayload<GateKind>["decision"], GateEffect>>);

export const GATE_CONTRACTS = Object.freeze(Object.fromEntries(GATE_KINDS.map((kind) => [kind, Object.freeze({ context: contexts[kind], decision: decisions[kind] })]))) as Readonly<{ [K in GateKind]: { readonly context: (typeof contexts)[K]; readonly decision: (typeof decisions)[K] } }>;

const connectedProvenance = z.object({ schema_version: z.literal("1"), actor_class: z.enum(["human", "archforge"]), assurance: z.literal("declared-local-trace"), channel: z.literal("connected-host"), decision_event_id: safeId, connection_id: safeId, request_id_digest: digest, recorded_at: z.string().datetime({ offset: false, local: false, precision: 3 }) }).strict();
const localProvenance = z.object({ schema_version: z.literal("1"), actor_class: z.enum(["human", "archforge"]), assurance: z.literal("declared-local-trace"), channel: z.literal("archflow-local"), decision_event_id: safeId, helper_invocation_id: safeId, recorded_at: z.string().datetime({ offset: false, local: false, precision: 3 }) }).strict();
export const humanDecisionProvenanceV1Schema = z.union([connectedProvenance, localProvenance]);

/**
 * The `gate-decision.schema.json` `$defs` the generator emits, keyed by committed def name.
 * `mcp-tools.schema.json` reaches `connected` and `local` by `$ref`, so both names are pinned.
 */
export const gateDecisionSchemaDefs: Readonly<Record<string, z.ZodType>> = Object.freeze({
  connected: connectedProvenance,
  local: localProvenance,
});
const envelopeBase = { schema_version: z.literal("1"), gate_id: pathSafeIdV1Schema, task_id: taskSlugV1Schema, phase_instance: z.string().regex(/^(?:prd|design|phase-(?:design|impl)-[1-9][0-9]*)$/u).refine((value) => { try { decodePhaseInstance(value); return true; } catch { return false; } }), subject_digest: digest, context_digest: digest, human_provenance: z.union([connectedProvenance, localProvenance]) } as const;

const contractArms = Object.fromEntries(GATE_KINDS.map((kind) => [
  kind,
  z.object({ kind: z.literal(kind), context: contexts[kind], payload: decisions[kind] }).strict(),
])) as unknown as Readonly<Record<GateKind, z.ZodType>>;

export const gateContractV1Schema = z.discriminatedUnion("kind", GATE_KINDS.map((kind) => contractArms[kind]) as unknown as [z.ZodObject, ...z.ZodObject[]]);

/**
 * The `gate-contract.schema.json` `$defs` the generator emits, keyed by committed def name. The
 * per-kind arms keep the pinned `<arm>/properties/context` pointer paths `mcp-tools.schema.json`
 * reaches into; the context and decision entries name the shared objects other gate documents
 * embed, so their emissions become `$ref`s instead of inline copies.
 */
export const gateContractSchemaDefs: Readonly<Record<string, z.ZodType>> = Object.freeze({
  // `canonicalDigests` stays unregistered: both uses derive `.min(1)` from it, and a derivation of
  // a registered def emits as a bare `$ref` plus `minItems`, which Ajv strict mode rejects.
  digest, text: boundedText, safeInteger, rule, rules: canonicalRules,
  waiverScope, authorityLink,
  artifactApprovalContext: contexts["artifact-approval"],
  reviewTriggerContext: contexts["review-trigger"],
  materialDriftContext: contexts["material-drift"],
  adjudicationFailureContext: contexts["adjudication-failure"],
  attemptsExhaustedContext: contexts["attempts-exhausted"],
  constitutionEditContext: contexts["constitution-edit"],
  commitAuthorizationContext: contexts["commit-authorization"],
  restoreCollisionContext: contexts["restore-collision"],
  migrationAuditContext: contexts["migration-audit"],
  artifactApprovalDecision: decisions["artifact-approval"],
  reviewTriggerDecision: decisions["review-trigger"],
  materialDriftDecision: decisions["material-drift"],
  adjudicationFailureDecision: decisions["adjudication-failure"],
  attemptsExhaustedDecision: decisions["attempts-exhausted"],
  constitutionEditDecision: decisions["constitution-edit"],
  commitAuthorizationDecision: decisions["commit-authorization"],
  restoreCollisionDecision: decisions["restore-collision"],
  migrationAuditDecision: decisions["migration-audit"],
  artifactApproval: contractArms["artifact-approval"],
  reviewTrigger: contractArms["review-trigger"],
  materialDrift: contractArms["material-drift"],
  adjudicationFailure: contractArms["adjudication-failure"],
  attemptsExhausted: contractArms["attempts-exhausted"],
  constitutionEdit: contractArms["constitution-edit"],
  commitAuthorization: contractArms["commit-authorization"],
  restoreCollision: contractArms["restore-collision"],
  migrationAudit: contractArms["migration-audit"],
});

/** The shared rule and waiver-scope objects the archived gate documents embed by reference. */
export const gateRuleVersionRefSchema = rule;
export const gateWaiverScopeSchema = waiverScope;

export const gateDecisionEnvelopeV1Schema = z.discriminatedUnion("kind", [
  z.object({ ...envelopeBase, kind: z.literal("artifact-approval"), payload: decisions["artifact-approval"] }).strict(),
  z.object({ ...envelopeBase, kind: z.literal("review-trigger"), payload: decisions["review-trigger"] }).strict(),
  z.object({ ...envelopeBase, kind: z.literal("material-drift"), payload: decisions["material-drift"] }).strict(),
  z.object({ ...envelopeBase, kind: z.literal("adjudication-failure"), payload: decisions["adjudication-failure"] }).strict(),
  z.object({ ...envelopeBase, kind: z.literal("attempts-exhausted"), payload: decisions["attempts-exhausted"] }).strict(),
  z.object({ ...envelopeBase, kind: z.literal("constitution-edit"), payload: decisions["constitution-edit"] }).strict(),
  z.object({ ...envelopeBase, kind: z.literal("commit-authorization"), payload: decisions["commit-authorization"] }).strict(),
  z.object({ ...envelopeBase, kind: z.literal("restore-collision"), payload: decisions["restore-collision"] }).strict(),
  z.object({ ...envelopeBase, kind: z.literal("migration-audit"), payload: decisions["migration-audit"] }).strict(),
]);

function ruleKey(value: RuleVersionRef): string { return `${value.rule_id}:${value.rule_version}`; }

export function parseGateContext<K extends GateKind>(kind: K, value: unknown): GateContext<K> {
  assertPlainJson(value, `${kind} gate context`);
  return contexts[kind].parse(value) as GateContext<K>;
}

export function parseGateDecisionEnvelope(value: unknown): GateDecisionEnvelope {
  assertPlainJson(value, "gate decision envelope");
  const parsed = gateDecisionEnvelopeV1Schema.parse(value) as GateDecisionEnvelope;
  if (parsed.kind === "restore-collision" && parsed.payload.decision === "adopt-as-new-generation") return parsed;
  return parsed;
}

export function parseGateContract(value: unknown): Readonly<{ [K in GateKind]: { readonly kind: K; readonly context: GateContext<K>; readonly payload: GateDecisionPayload<K> } }[GateKind]> {
  assertPlainJson(value, "gate contract");
  const parsed = gateContractV1Schema.parse(value) as Readonly<{ [K in GateKind]: { readonly kind: K; readonly context: GateContext<K>; readonly payload: GateDecisionPayload<K> } }[GateKind]>;
  validateGateDecision(parsed.kind, parsed.context, parsed.payload);
  return parsed;
}

export function validateGateDecision<K extends GateKind>(kind: K, context: GateContext<K>, payload: GateDecisionPayload<K>): GateDecisionPayload<K> {
  parseGateContext(kind, context);
  assertPlainJson(payload, `${kind} gate decision`);
  const parsed = decisions[kind].parse(payload) as GateDecisionPayload<K>;
  if (kind === "review-trigger" && parsed.decision === "waiver-requested") {
    const eligible = (context as GateContext<"review-trigger">).eligible_waiver_rules;
    if (!eligible.some((item) => ruleKey(item) === ruleKey(parsed.rule))) throw new TypeError("waiver-requested rule must be eligible");
  }
  if (kind === "adjudication-failure") {
    const adjudicationContext = context as GateContext<"adjudication-failure">;
    const adjudicationPayload = parsed as GateDecisionPayload<"adjudication-failure">;
    const eligible = new Set(adjudicationContext.eligible_waiver_rules.map(ruleKey));
    if (adjudicationPayload.decision === "waiver-requested" && !eligible.has(ruleKey(adjudicationPayload.rule))) throw new TypeError("waiver-requested rule must be eligible");
    if (adjudicationPayload.decision === "approve") {
      const required = new Set([...adjudicationContext.failed_rules, ...adjudicationContext.uncertain_rules].map(ruleKey).filter((key) => !eligible.has(key)));
      const actual = adjudicationPayload.resolutions.map((item) => ruleKey(item.rule));
      if (!sortedUnique(adjudicationPayload.resolutions, (a, b) => compareRules(a.rule, b.rule)) || actual.length !== required.size || actual.some((key) => !required.has(key))) throw new TypeError("resolutions must be a sorted exact set of non-waived failed and uncertain rules");
    }
  }
  if (kind === "restore-collision" && parsed.decision === "adopt-as-new-generation") {
    const candidate = (context as GateContext<"restore-collision">).adoption_candidate;
    const adoptionPayload = parsed as Extract<GateDecisionPayload<"restore-collision">, { decision: "adopt-as-new-generation" }>;
    if (candidate === undefined || !isDeepStrictEqual(candidate, adoptionPayload.adoption_authority)) throw new TypeError("restore adoption authority must exactly match the context candidate");
  }
  return parsed;
}

export function gateDecisionEffect(payload: GateDecisionPayload<GateKind>): GateEffect { return effects[payload.decision]; }

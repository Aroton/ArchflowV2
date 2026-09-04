import type {
  AdjudicationEvidence,
  DerivedAdjudication,
  DerivedAdjudicationV2,
} from "../contracts/adjudication.js";
import type { AdjudicationRuleSlotV1, DriftResult } from "../contracts/adjudication.js";
import type {
  ConstitutionRegistry,
  ConstitutionRuleV1,
} from "../contracts/constitution.js";
import {
  createProjectError,
  type ProjectError,
} from "../contracts/errors.js";
import type { Sha256Digest } from "../contracts/evidence.js";
import type { AdapterId, ReviewEvidence, UpstreamAlignmentV1 } from "../contracts/review.js";
import type { AdjudicationEnvelopeInput } from "./envelopes.js";
import type { DesignPolicyFinding, EligibleWaiver, GateContext, GateKind, RuleVersionRef, WaivableOperation } from "../contracts/gates.js";

export class AdjudicationServiceError extends Error {
  public constructor(public readonly project_error: ProjectError) {
    super(project_error.code);
    this.name = "AdjudicationServiceError";
  }
}

const invalidOutput = (issueCode: string, adapter: AdapterId | undefined): never => {
  if (adapter === undefined) {
    throw new TypeError("the dispatch adapter is required to classify invalid model output");
  }
  throw new AdjudicationServiceError(createProjectError("MODEL_OUTPUT_INVALID", {
    adapter,
    attempt: 1,
    issue_code: issueCode,
  }));
};

/**
 * Applies only registry-dependent checks. Structural folds, drift coverage, and observation
 * bindings remain owned by the contract and observation layers.
 *
 * A rule's `enforced_by` labels are deliberately not cross-checked here. They name where the rule
 * is mechanically enforced in the repository and travel to the child as context; the server has no
 * channel through which mechanism evidence could arrive, so judging a finding against them could
 * only ever manufacture uncertainty.
 */
export function crossCheckRuleFindings<T extends DerivedAdjudication | DerivedAdjudicationV2>(
  registry: ConstitutionRegistry,
  adjudication: T,
  adapter?: AdapterId,
): T {
  const active = [...registry.values()]
    .filter((rule) => rule.status === "active")
    .sort((left, right) => left.id.localeCompare(right.id));
  if (adjudication.rule_findings.length !== active.length) {
    return invalidOutput("constitution-rule-coverage", adapter);
  }
  for (let index = 0; index < active.length; index += 1) {
    const rule = active[index]!;
    const finding = adjudication.rule_findings[index]!;
    if (finding.rule_id !== rule.id || finding.rule_version !== rule.version) {
      return invalidOutput("constitution-rule-version", adapter);
    }
  }
  return adjudication;
}

export type AdjudicationDispatchResult = Readonly<{
  cli_version: string;
  extracted_output_bytes: Uint8Array;
}>;

export type AdjudicationGateRequest<K extends GateKind = GateKind> = Readonly<{
  kind: K;
  subject_digest: Sha256Digest;
  context: GateContext<K>;
}>;

/** The active constitution rules in the closed shape the adjudication envelope carries. */
export function rulesForEnvelope(registry: ConstitutionRegistry):
  AdjudicationEnvelopeInput["rules"] {
  return Object.freeze([...registry.values()]
    .filter((rule) => rule.status === "active")
    .sort((left, right) =>
      left.id.localeCompare(right.id) || left.version - right.version)
    .map((rule, index) => Object.freeze({
      slot: `slot-${String(index + 1)}`,
      text: rule.text,
      ...(rule.review_trigger === undefined
        ? {}
        : { review_trigger: rule.review_trigger }),
      enforced_by: Object.freeze([...(rule.enforced_by ?? [])]),
    })));
}

/** Server-only rule identity map paired positionally with {@link rulesForEnvelope}. */
export function ruleSlotsForEnvelope(registry: ConstitutionRegistry): readonly AdjudicationRuleSlotV1[] {
  return Object.freeze([...registry.values()]
    .filter((rule) => rule.status === "active")
    .sort((left, right) => left.id.localeCompare(right.id) || left.version - right.version)
    .map((rule, index) => Object.freeze({
      slot: `slot-${String(index + 1)}`,
      rule_id: rule.id,
      rule_version: rule.version,
    })));
}

export type PolicyReviewFacts = Readonly<{
  subject_digest: AdjudicationEvidence["subject_digest"];
  input_fingerprint: AdjudicationEvidence["input_fingerprint"];
  source_review_envelope_digest: Sha256Digest | undefined;
  constitution: Readonly<{
    status: "not-run" | "evaluated";
    result: "pass" | "fail" | "uncertain";
    rule_findings: AdjudicationEvidence["rule_findings"];
    matched_rule_versions: AdjudicationEvidence["matched_rule_versions"];
    uncertain_rule_versions: AdjudicationEvidence["uncertain_rule_versions"];
  }>;
  alignment: Readonly<{
    source: "review-v3" | "adjudication-v1" | "not-reviewed";
    result: DriftResult;
    findings: readonly UpstreamAlignmentV1[];
  }>;
}>;

const alignmentResult = (findings: readonly UpstreamAlignmentV1[]): DriftResult =>
  findings.some((finding) => finding.drift === "material")
    ? "material"
    : findings.some((finding) => finding.drift === "incidental") ? "incidental" : "aligned";

/**
 * The sole compatibility adapter for policy consumers. Fresh drift comes only from Review V3;
 * archived drift comes only from Adjudication V1. Mixed fresh/archive cohorts are rejected.
 */
export function policyReviewFacts(
  review: ReviewEvidence,
  adjudication: AdjudicationEvidence | undefined,
  activeRules: boolean,
): PolicyReviewFacts {
  // Subject/predecessor currency is established by the fixed-point caller before this adapter.
  // The immutable round link is the review envelope digest and remains exact across the one-hop
  // predecessor compatibility path.
  if (adjudication !== undefined && review.assurance === "server-attested" &&
      adjudication.source_review_envelope_digest !== review.envelope_input_digest) {
    throw new TypeError("policy review evidence round bindings disagree");
  }
  if (review.schema_version === "3") {
    if (review.assurance !== "server-attested") {
      throw new TypeError("Review V3 policy facts require server-attested evidence");
    }
    if ((adjudication !== undefined) !== activeRules ||
        (adjudication !== undefined && adjudication.schema_version !== "2")) {
      throw new TypeError("fresh policy evidence cohort is incomplete or mixed");
    }
    const alignment = review.upstream_alignment ?? [];
    return Object.freeze({
      subject_digest: review.subject_digest,
      input_fingerprint: review.input_fingerprint,
      source_review_envelope_digest: review.envelope_input_digest,
      constitution: adjudication === undefined
        ? Object.freeze({ status: "not-run", result: "pass", rule_findings: Object.freeze([]), matched_rule_versions: Object.freeze([]), uncertain_rule_versions: Object.freeze([]) })
        : Object.freeze({
          status: "evaluated", result: adjudication.constitution,
          rule_findings: adjudication.rule_findings,
          matched_rule_versions: adjudication.matched_rule_versions,
          uncertain_rule_versions: adjudication.uncertain_rule_versions,
        }),
      alignment: Object.freeze({
        source: review.upstream_alignment === undefined ? "not-reviewed" : "review-v3",
        result: alignmentResult(alignment),
        findings: alignment,
      }),
    });
  }
  if ((adjudication !== undefined) !== activeRules ||
      (adjudication !== undefined && adjudication.schema_version !== "1")) {
    throw new TypeError("archived policy evidence cohort is incomplete or mixed");
  }
  const alignment = adjudication?.drift_findings ?? [];
  return Object.freeze({
    subject_digest: review.subject_digest,
    input_fingerprint: review.input_fingerprint,
    source_review_envelope_digest: review.assurance === "server-attested"
      ? review.envelope_input_digest
      : undefined,
    constitution: adjudication === undefined
      ? Object.freeze({ status: "not-run", result: "pass", rule_findings: Object.freeze([]), matched_rule_versions: Object.freeze([]), uncertain_rule_versions: Object.freeze([]) })
      : Object.freeze({
        status: "evaluated", result: adjudication.constitution,
        rule_findings: adjudication.rule_findings,
        matched_rule_versions: adjudication.matched_rule_versions,
        uncertain_rule_versions: adjudication.uncertain_rule_versions,
      }),
    alignment: Object.freeze({
      source: adjudication === undefined ? "not-reviewed" : "adjudication-v1",
      result: adjudication?.drift ?? "aligned",
      findings: alignment,
    }),
  });
}

function refs(rules: readonly ConstitutionRuleV1[]): readonly Readonly<{
  rule_id: string;
  rule_version: number;
}>[] {
  return canonicalRuleRefs(rules.map((rule) =>
    Object.freeze({ rule_id: rule.id, rule_version: rule.version })));
}

export function canonicalRuleRefs(rules: readonly Readonly<{
  rule_id: string;
  rule_version: number;
}>[]): readonly Readonly<{ rule_id: string; rule_version: number }>[] {
  return Object.freeze([...rules].sort((left, right) =>
    left.rule_id.localeCompare(right.rule_id) ||
    left.rule_version - right.rule_version));
}

/**
 * The waivable (rule, axis) pairs in the canonical sorted, unique order the gate context requires.
 * One rule can appear on both axes — that is the whole point of the merged gate — but only once
 * per axis, so pairs are deduplicated by rule and operation together.
 */
function eligibleWaivers(
  entries: readonly Readonly<{ rule: RuleVersionRef; operation: WaivableOperation }>[],
): readonly EligibleWaiver[] {
  const unique = new Map<string, Readonly<{ rule: RuleVersionRef; operation: WaivableOperation }>>();
  for (const entry of entries) {
    unique.set(`${entry.rule.rule_id}:${entry.rule.rule_version}:${entry.operation}`, entry);
  }
  return Object.freeze([...unique.values()]
    .map((entry) => Object.freeze({
      rule: entry.rule,
      scope: Object.freeze({ operation: entry.operation, boundary: "subject" as const }),
    }))
    .sort((left, right) =>
      left.rule.rule_id.localeCompare(right.rule.rule_id) ||
      left.rule.rule_version - right.rule.rule_version ||
      left.scope.operation.localeCompare(right.scope.operation)));
}

/** Policy portion of the one final design approval, retaining the reviewer's English evidence. */
export function designApprovalPolicyContext(evidence: AdjudicationEvidence): Readonly<{
  constitution: AdjudicationEvidence["constitution"];
  policy_findings: readonly DesignPolicyFinding[];
  eligible_waivers: readonly EligibleWaiver[];
}> {
  const failedOrUncertain = evidence.rule_findings.filter((item) => item.compliance !== "pass");
  const triggered = evidence.rule_findings.filter((item) => item.trigger !== "not-matched");
  return Object.freeze({
    constitution: evidence.constitution,
    policy_findings: Object.freeze(evidence.rule_findings.map((item) => Object.freeze({
      rule_id: item.rule_id,
      rule_version: item.rule_version,
      compliance: item.compliance,
      rationale: item.rationale,
      trigger: item.trigger,
      trigger_evidence: item.trigger_evidence,
    }))),
    eligible_waivers: eligibleWaivers([
      ...failedOrUncertain.map((item) => ({
        rule: Object.freeze({ rule_id: item.rule_id, rule_version: item.rule_version }),
        operation: "adjudication-failure" as const,
      })),
      ...triggered.map((item) => ({
        rule: Object.freeze({ rule_id: item.rule_id, rule_version: item.rule_version }),
        operation: "review-trigger" as const,
      })),
    ]),
  });
}

/**
 * The deterministic gates a constitution-review verdict demands. The constitution review runs
 * inside archflow_counter_review; these gates open at the post-triage fixed point through the
 * ordinary archflow_gate flow — status and build-request compose them mechanically from this
 * same selector over retained evidence.
 *
 * When they open is the fixed point's call, not this selector's: a rule the artifact fails or
 * material drift re-enters production while attempts remain, and the gate opens only once the
 * attempt budget is spent. A rule whose own `review_trigger` matched is the repository asking
 * for a human, so that gate opens at once (see `gateDeclaredByReviewTrigger`).
 */
export function selectAdjudicationGates(
  registry: ConstitutionRegistry,
  evidence: AdjudicationEvidence,
): readonly AdjudicationGateRequest[] {
  const facts: PolicyReviewFacts = evidence.schema_version === "1"
    ? Object.freeze({
      subject_digest: evidence.subject_digest,
      input_fingerprint: evidence.input_fingerprint,
      source_review_envelope_digest: evidence.source_review_envelope_digest,
      constitution: Object.freeze({
        status: "evaluated", result: evidence.constitution,
        rule_findings: evidence.rule_findings,
        matched_rule_versions: evidence.matched_rule_versions,
        uncertain_rule_versions: evidence.uncertain_rule_versions,
      }),
      alignment: Object.freeze({
        source: "adjudication-v1", result: evidence.drift, findings: evidence.drift_findings,
      }),
    })
    : Object.freeze({
      subject_digest: evidence.subject_digest,
      input_fingerprint: evidence.input_fingerprint,
      source_review_envelope_digest: evidence.source_review_envelope_digest,
      constitution: Object.freeze({
        status: "evaluated", result: evidence.constitution,
        rule_findings: evidence.rule_findings,
        matched_rule_versions: evidence.matched_rule_versions,
        uncertain_rule_versions: evidence.uncertain_rule_versions,
      }),
      alignment: Object.freeze({ source: "not-reviewed", result: "aligned", findings: Object.freeze([]) }),
    });
  return selectPolicyReviewGates(registry, facts);
}

/** Selects constitution first, then material alignment, from the compatibility projection only. */
export function selectPolicyReviewGates(
  registry: ConstitutionRegistry,
  evidence: PolicyReviewFacts,
): readonly AdjudicationGateRequest[] {
  const gates: AdjudicationGateRequest[] = [];
  const failed = evidence.constitution.rule_findings.filter((item) => item.compliance === "fail");
  const uncertain = evidence.constitution.rule_findings.filter((item) => item.compliance === "uncertain");
  const failedRules = refs(failed.map((item) => registry.get(item.rule_id)!));
  const uncertainRules = refs(uncertain.map((item) => registry.get(item.rule_id)!));
  const matchedTriggers = evidence.constitution.matched_rule_versions;
  const uncertainTriggers = evidence.constitution.uncertain_rule_versions;
  // Compliance and trigger are separate judgments about the same rules and routinely share one
  // root cause, so they are disclosed together and decided once rather than asked twice.
  if (
    failedRules.length > 0 || uncertainRules.length > 0 ||
    matchedTriggers.length > 0 || uncertainTriggers.length > 0
  ) {
    gates.push(Object.freeze({
      kind: "constitution-review",
      subject_digest: evidence.subject_digest,
      context: Object.freeze({
        constitution: evidence.constitution.result,
        failed_rules: failedRules,
        uncertain_rules: uncertainRules,
        matched_trigger_rules: matchedTriggers,
        uncertain_trigger_rules: uncertainTriggers,
        eligible_waivers: eligibleWaivers([
          ...[...failedRules, ...uncertainRules].map((rule) =>
            ({ rule, operation: "adjudication-failure" as const })),
          ...[...matchedTriggers, ...uncertainTriggers].map((rule) =>
            ({ rule, operation: "review-trigger" as const })),
        ]),
      }),
    }));
  }
  // Material drift is deliberately serialized. Resolving this gate re-enters production
  // and requires fresh review evidence before another upstream can become authoritative.
  const material = evidence.alignment.findings.find((item) => item.drift === "material");
  if (material !== undefined) {
    gates.push(Object.freeze({
      kind: "material-drift",
      subject_digest: evidence.subject_digest,
      context: Object.freeze({
        affected_upstream: Object.freeze({
          kind: "implementation-result",
          digest: material.upstream_digest,
        }),
        drift: "material",
        affected_claim_ids: Object.freeze([...material.affected_claim_ids].sort()),
      }),
    }));
  }
  return Object.freeze(gates);
}

/**
 * True when the repository's constitution asked for this gate itself: a rule's `review_trigger`
 * matched (or could not be ruled out). Compliance failures and drift are producer work first.
 */
export function gateDeclaredByReviewTrigger(gate: AdjudicationGateRequest): boolean {
  if (gate.kind !== "constitution-review" || !("matched_trigger_rules" in gate.context)) return false;
  return gate.context.matched_trigger_rules.length > 0 || gate.context.uncertain_trigger_rules.length > 0;
}

/** Compatibility selector for callers that can publish only the next gate. */
export function selectAdjudicationGate(
  registry: ConstitutionRegistry,
  evidence: AdjudicationEvidence,
): AdjudicationGateRequest | undefined {
  return selectAdjudicationGates(registry, evidence)[0];
}

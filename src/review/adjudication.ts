import type {
  AdjudicationEvidence,
  DerivedAdjudication,
} from "../contracts/adjudication.js";
import type {
  ConstitutionRegistry,
  ConstitutionRuleV1,
} from "../contracts/constitution.js";
import {
  createProjectError,
  type ProjectError,
} from "../contracts/errors.js";
import type { Sha256Digest } from "../contracts/evidence.js";
import type { AdapterId } from "../contracts/review.js";
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
export function crossCheckRuleFindings<T extends DerivedAdjudication>(
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
    .map((rule) => Object.freeze({
      id: rule.id,
      version: rule.version,
      text: rule.text,
      ...(rule.review_trigger === undefined
        ? {}
        : { review_trigger: rule.review_trigger }),
      enforced_by: Object.freeze([...(rule.enforced_by ?? [])]),
    })));
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
 */
export function selectAdjudicationGates(
  registry: ConstitutionRegistry,
  evidence: AdjudicationEvidence,
): readonly AdjudicationGateRequest[] {
  const gates: AdjudicationGateRequest[] = [];
  const failed = evidence.rule_findings.filter((item) => item.compliance === "fail");
  const uncertain = evidence.rule_findings.filter((item) => item.compliance === "uncertain");
  const failedRules = refs(failed.map((item) => registry.get(item.rule_id)!));
  const uncertainRules = refs(uncertain.map((item) => registry.get(item.rule_id)!));
  const matchedTriggers = evidence.matched_rule_versions;
  const uncertainTriggers = evidence.uncertain_rule_versions;
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
        constitution: evidence.constitution,
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
  const material = evidence.drift_findings.find((item) => item.drift === "material");
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

/** Compatibility selector for callers that can publish only the next gate. */
export function selectAdjudicationGate(
  registry: ConstitutionRegistry,
  evidence: AdjudicationEvidence,
): AdjudicationGateRequest | undefined {
  return selectAdjudicationGates(registry, evidence)[0];
}

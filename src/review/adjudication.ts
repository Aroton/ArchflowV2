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
import type { GateContext, GateKind } from "../contracts/gates.js";

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
    const declared = rule.enforced_by ?? [];
    const labels = finding.enforced_by.map((entry) => entry.mechanism);
    if (
      new Set(labels).size !== labels.length ||
      labels.length !== declared.length ||
      declared.some((label) => !labels.includes(label))
    ) return invalidOutput("constitution-enforcement-labels", adapter);
    if (declared.length > 0 && finding.compliance === "pass") {
      return invalidOutput("constitution-mechanism-pass", adapter);
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
  if (evidence.constitution === "fail" || evidence.constitution === "uncertain") {
    const failed = evidence.rule_findings.filter((item) => item.compliance === "fail");
    const uncertain = evidence.rule_findings.filter((item) => item.compliance === "uncertain");
    gates.push(Object.freeze({
      kind: "adjudication-failure",
      subject_digest: evidence.subject_digest,
      context: Object.freeze({
        constitution: evidence.constitution,
        failed_rules: refs(failed.map((item) => registry.get(item.rule_id)!)),
        uncertain_rules: refs(uncertain.map((item) => registry.get(item.rule_id)!)),
        eligible_waiver_rules: refs([...failed, ...uncertain].map((item) =>
          registry.get(item.rule_id)!)),
        waiver_scope: Object.freeze({
          operation: "adjudication-failure",
          boundary: "subject",
        }),
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
  if (
    evidence.matched_rule_versions.length > 0 ||
    evidence.uncertain_rule_versions.length > 0
  ) {
    gates.push(Object.freeze({
      kind: "review-trigger",
      subject_digest: evidence.subject_digest,
      context: Object.freeze({
        matched_rules: evidence.matched_rule_versions,
        uncertain_rules: evidence.uncertain_rule_versions,
        eligible_waiver_rules: canonicalRuleRefs([
          ...evidence.matched_rule_versions,
          ...evidence.uncertain_rule_versions,
        ]),
        waiver_scope: Object.freeze({
          operation: "review-trigger",
          boundary: "subject",
        }),
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

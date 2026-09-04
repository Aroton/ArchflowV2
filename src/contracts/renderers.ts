import type { AdjudicationEvidence } from "./adjudication.js";
import {
  reviewFindingDisplayDetail,
  type LegacyReviewFinding,
  type ReviewEvidence,
  type ReviewFindingV2,
  type ReviewFindingV3,
  type RouteOverrideRecord,
  type RouteSourceRecord,
  type RuleVersionRef,
} from "./review.js";
import type { QualifiedAdjudicationEvidence, QualifiedReviewEvidence, VerifiedReferencedEvidence } from "./trust.js";
import type { TriageDisposition, ValidatedTriage } from "./triage.js";
import { authenticQualifiedEvidence, authenticValidatedTriage, authenticVerifiedEvidence } from "./internal/trust-brands.js";

const encoder = new TextEncoder();
const ESCAPE = /[\u0000-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069`<>&]/gu;
const visibleJsonString = (value: string): string => JSON.stringify(value)
  .replace(/\\n/gu, "\\u000a").replace(/\\r/gu, "\\u000d").replace(/\\t/gu, "\\u0009")
  .replace(/\\b/gu, "\\u0008").replace(/\\f/gu, "\\u000c")
  .replace(ESCAPE, (character) => `\\u${character.codePointAt(0)!.toString(16).padStart(4, "0")}`);
const canonical = (value: unknown): string => typeof value === "string" ? visibleJsonString(value) : JSON.stringify(value);
const optional = (value: unknown): string => value === undefined ? "none" : canonical(value);
const ruleVersions = (values: readonly RuleVersionRef[]): string => canonical(values.map((value) => `${value.rule_id}@${value.rule_version}`));
const linesToBytes = (lines: readonly string[]): Uint8Array => encoder.encode(`${lines.join("\n")}\n`);
const metadata = (entries: readonly (readonly [string, unknown])[]): string[] => entries.map(([key, value]) => `${key}: ${optional(value)}`);
const prose = (label: string, value: string, indent = "  "): string => `${indent}${label}: ${visibleJsonString(value)}`;

function provenanceMetadata(evidence: ReviewEvidence | AdjudicationEvidence): readonly (readonly [string, unknown])[] {
  return [
    ["assurance", evidence.assurance],
    ["adapter", evidence.assurance === "server-attested" ? evidence.adapter : undefined],
    ["cli_version", evidence.assurance === "server-attested" ? evidence.cli_version : undefined],
    ["model_family", evidence.model_family], ["model", evidence.model], ["effort", evidence.effort],
    ["provider", evidence.assurance === "server-attested" ? evidence.provider : undefined],
    ["invocation_id", evidence.assurance === "server-attested" ? evidence.invocation_id : undefined],
    ["result_id", evidence.assurance === "server-attested" ? evidence.result_id : undefined],
  ];
}
function renderReviewFinding(finding: ReviewFindingV2 | ReviewFindingV3 | LegacyReviewFinding): string[] {
  const display = reviewFindingDisplayDetail(finding);
  if ("claim_type" in finding) {
    return [
      `### Finding ${visibleJsonString(finding.finding_id)} [${finding.claim_type}: ${finding.confidence}]`,
      prose("falsifier", finding.falsifier),
      ...("reviewer_id" in finding
        ? [
          `reviewer_id: ${canonical(finding.reviewer_id)}`,
          `reviewer_focus: ${canonical(finding.reviewer_focus)}`,
          `routing_role: ${canonical(finding.routing_role)}`,
          `criterion_id: ${canonical(finding.criterion_id)}`,
        ]
        : []),
      prose("summary", display.summary),
      prose("evidence", display.evidence),
      prose("suggested_resolution", display.suggested_resolution),
    ];
  }
  return [`### Finding ${visibleJsonString(finding.finding_id)}`, `severity: ${canonical(finding.severity)}`, `blocking: ${canonical(finding.blocking)}`, prose("summary", display.summary), prose("evidence", display.evidence), prose("suggested_resolution", display.suggested_resolution)];
}

/**
 * States that this dispatch ran on a human-authorized substitute for the pinned route. The metadata
 * block above already prints the model that actually reviewed; this says what it displaced and why,
 * so the human at the gate can see the deviation without reading the pinned config.
 */
function renderRouteOverride(override: RouteOverrideRecord): string[] {
  const displaced = override.pinned_model === undefined
    ? ["pinned_route: none configured for this role"]
    : [`pinned_model: ${canonical(override.pinned_model)}`, `pinned_effort: ${canonical(override.pinned_effort)}`, `pinned_provider: ${optional(override.pinned_provider)}`];
  return ["", "## Route Override", ...displaced, prose("reason", override.reason)];
}

function renderRouteSource(source: RouteSourceRecord): string[] {
  const lines = ["", "## Route Source", `provenance: ${canonical(source.provenance)}`];
  if (source.displaced === undefined) return lines;
  return [
    ...lines,
    `displaced_source: ${canonical(source.displaced.source)}`,
    `displaced_model: ${canonical(source.displaced.model)}`,
    `displaced_effort: ${canonical(source.displaced.effort)}`,
    `displaced_provider: ${optional(source.displaced.provider)}`,
  ];
}

export function renderReviewEvidence(
  value: QualifiedReviewEvidence | VerifiedReferencedEvidence<"review">,
): Uint8Array {
  const evidence = value.evidence;
  const authenticated =
    authenticQualifiedEvidence(value, "review", evidence.assurance) ||
    authenticVerifiedEvidence(value, { kind: "review", assurance: evidence.assurance });
  if (!authenticated) throw new TypeError("authenticated review evidence is required");
  const summaryMetadata = evidence.schema_version === "2" || evidence.schema_version === "3"
    ? [["total_findings", evidence.total_findings], ["partition_counts", evidence.partition_counts]] as const
    : [["blocking_count", evidence.blocking_count]] as const;
  const lines = ["# ArchFlow Review Evidence", ...metadata([
    ["schema_version", evidence.schema_version], ["task_id", evidence.task_id], ["phase_instance", evidence.phase_instance], ["step", evidence.step], ["role", evidence.role], ["subject_digest", evidence.subject_digest], ["input_fingerprint", evidence.input_fingerprint], ["evidence_digest", value.evidence_digest], ["verdict", evidence.verdict], ...summaryMetadata,
    ...(evidence.schema_version === "3"
      ? []
      : [["matched_rule_versions", evidence.matched_rule_versions.map((rule) => `${rule.rule_id}@${rule.rule_version}`)]] as const),
    ...provenanceMetadata(evidence),
  ]), "", "## Findings"];
  for (const finding of evidence.findings) lines.push("", ...renderReviewFinding(finding));
  if (evidence.assurance === "degraded") lines.push("", "## Degraded Assurance", prose("reason", evidence.reason));
  if (evidence.assurance === "server-attested" && evidence.route_source !== undefined) lines.push(...renderRouteSource(evidence.route_source));
  if (evidence.assurance === "server-attested" && evidence.route_override !== undefined) lines.push(...renderRouteOverride(evidence.route_override));
  return linesToBytes(lines);
}

function renderDisposition(disposition: TriageDisposition): string[] {
  const lines = [`### ${canonical(disposition.disposition)} ${visibleJsonString(disposition.review_evidence_digest)} ${visibleJsonString(disposition.finding_id)}`, prose("rationale", disposition.rationale)];
  if (disposition.disposition === "rejected") {
    lines.push(prose("evidence", disposition.evidence));
  } else if (disposition.disposition === "accepted" || disposition.disposition === "accepted-editorial") {
    lines.push(prose("revision_intent", disposition.revision_intent));
  } else if (disposition.disposition === "deferred" && disposition.evidence !== undefined) {
    lines.push(prose("evidence", disposition.evidence));
  }
  return lines;
}
export function renderTriage(value: ValidatedTriage): Uint8Array {
  if (!authenticValidatedTriage(value)) throw new TypeError("validated triage is required");
  const lines = ["# ArchFlow Review Triage", ...metadata([
    ["schema_version", value.schema_version], ["task_id", value.task_id], ["phase_instance", value.phase_instance], ["step", value.step], ["subject_digest", value.subject_digest], ["input_fingerprint", value.input_fingerprint], ["current_evidence_set_digest", value.current_evidence_set_digest], ["source_evidence_digests", value.source_evidence_digests], ["accepted_count", value.accepted_count], ["accepted_editorial_count", value.accepted_editorial_count], ["rejected_count", value.rejected_count], ["escalated_human_count", value.escalated_human_count], ["deferred_count", value.deferred_count],
  ]), "", "## Dispositions"];
  for (const disposition of value.dispositions) lines.push("", ...renderDisposition(disposition));
  if (value.disposition_ledger !== undefined && value.disposition_ledger.length > 0) {
    lines.push(
      "",
      "## Disposition Ledger",
      "Carried reviewer memory: earlier rounds' dispositions of this phase instance, each embedded with its round's finding details at install time.",
    );
    for (const entry of value.disposition_ledger) {
      lines.push("", `### ${canonical(entry.disposition)} ${visibleJsonString(entry.finding_id)} (attempt ${entry.attempt})`);
      lines.push(`review_evidence_digest: ${canonical(entry.review_evidence_digest)}`);
      if (entry.rationale !== undefined) lines.push(prose("rationale", entry.rationale));
      if (entry.revision_intent !== undefined) lines.push(prose("revision_intent", entry.revision_intent));
      if (entry.evidence !== undefined) lines.push(prose("evidence", entry.evidence));
      if ("reviewer_focus" in entry) {
        lines.push(
          `reviewer_id: ${canonical(entry.reviewer_id)}`,
          `reviewer_focus: ${canonical(entry.reviewer_focus)}`,
          `routing_role: ${canonical(entry.routing_role)}`,
          `criterion_id: ${canonical(entry.criterion_id)}`,
        );
        if (entry.disposition_evidence !== undefined) {
          lines.push(prose("disposition_evidence", entry.disposition_evidence));
        }
        if (entry.reviewer_focus === "tests") {
          lines.push(
            prose("required_behavior_or_risk_boundary", entry.required_behavior_or_risk_boundary),
            prose("coverage_or_oracle_problem", entry.coverage_or_oracle_problem),
            prose("consequence", entry.consequence),
            prose("proposed_verification_change", entry.proposed_verification_change),
          );
        }
      }
      if ("claim_type" in entry) {
        lines.push(`[${entry.claim_type}: ${entry.confidence}]`, prose("falsifier", entry.falsifier));
      } else if ("severity" in entry) {
        lines.push(`severity: ${canonical(entry.severity)}`, `blocking: ${canonical(entry.blocking)}`);
      }
      if (entry.summary !== undefined) lines.push(prose("summary", entry.summary));
      if (entry.suggested_resolution !== undefined) lines.push(prose("suggested_resolution", entry.suggested_resolution));
    }
  }
  return linesToBytes(lines);
}

export function renderAdjudicationEvidence(
  value: QualifiedAdjudicationEvidence | VerifiedReferencedEvidence<"adjudication">,
): Uint8Array {
  const evidence = value.evidence;
  const authenticated =
    authenticQualifiedEvidence(value, "adjudication", evidence.assurance) ||
    authenticVerifiedEvidence(value, { kind: "adjudication", assurance: evidence.assurance });
  if (!authenticated) throw new TypeError("authenticated adjudication evidence is required");
  const lines = ["# ArchFlow Adjudication Evidence", ...metadata([
    ["schema_version", evidence.schema_version], ["task_id", evidence.task_id], ["phase_instance", evidence.phase_instance], ["step", evidence.step], ["subject_digest", evidence.subject_digest], ["input_fingerprint", evidence.input_fingerprint], ["evidence_digest", value.evidence_digest], ["pinned_constitution_digest", evidence.pinned_constitution_digest], ...(evidence.schema_version === "1" ? [["approved_upstream_digests", evidence.approved_upstream_digests], ["drift", evidence.drift]] as const : []), ["source_review_envelope_digest", evidence.source_review_envelope_digest], ["constitution", evidence.constitution], ["matched_rule_versions", evidence.matched_rule_versions.map((rule) => `${rule.rule_id}@${rule.rule_version}`)], ["uncertain_rule_versions", evidence.uncertain_rule_versions.map((rule) => `${rule.rule_id}@${rule.rule_version}`)], ...provenanceMetadata(evidence),
  ]), "", "## Constitution Findings"];
  for (const finding of evidence.rule_findings) {
    lines.push("", `### Rule ${visibleJsonString(`${finding.rule_id}@${finding.rule_version}`)}`, `compliance: ${canonical(finding.compliance)}`, `trigger: ${canonical(finding.trigger)}`, prose("rationale", finding.rationale), prose("trigger_evidence", finding.trigger_evidence));
  }
  if (evidence.schema_version === "1") {
    lines.push("", "## Drift Findings");
    for (const finding of evidence.drift_findings) lines.push("", `### Upstream ${visibleJsonString(finding.upstream_digest)}`, `drift: ${canonical(finding.drift)}`, `affected_claim_ids: ${canonical(finding.affected_claim_ids)}`, prose("rationale", finding.rationale));
  }
  if (evidence.assurance === "degraded") lines.push("", "## Degraded Assurance", prose("reason", evidence.reason));
  if (evidence.assurance === "server-attested" && evidence.route_source !== undefined) lines.push(...renderRouteSource(evidence.route_source));
  if (evidence.assurance === "server-attested" && evidence.route_override !== undefined) lines.push(...renderRouteOverride(evidence.route_override));
  return linesToBytes(lines);
}

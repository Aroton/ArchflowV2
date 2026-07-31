import type { AdjudicationEvidence, MechanicalEvidence } from "./adjudication.js";
import type { ReviewEvidence, ReviewFinding, RuleVersionRef } from "./review.js";
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
    ["invocation_id", evidence.assurance === "server-attested" ? evidence.invocation_id : undefined],
    ["result_id", evidence.assurance === "server-attested" ? evidence.result_id : undefined],
  ];
}
function renderReviewFinding(finding: ReviewFinding): string[] {
  return [`### Finding ${visibleJsonString(finding.finding_id)}`, `severity: ${canonical(finding.severity)}`, `blocking: ${canonical(finding.blocking)}`, prose("summary", finding.summary), prose("evidence", finding.evidence), prose("suggested_resolution", finding.suggested_resolution)];
}

export function renderReviewEvidence(
  value: QualifiedReviewEvidence | VerifiedReferencedEvidence<"review">,
): Uint8Array {
  const evidence = value.evidence;
  const authenticated =
    authenticQualifiedEvidence(value, "review", evidence.assurance) ||
    authenticVerifiedEvidence(value, { kind: "review", assurance: evidence.assurance });
  if (!authenticated) throw new TypeError("authenticated review evidence is required");
  const lines = ["# ArchFlow Review Evidence", ...metadata([
    ["schema_version", evidence.schema_version], ["task_id", evidence.task_id], ["phase_instance", evidence.phase_instance], ["step", evidence.step], ["role", evidence.role], ["subject_digest", evidence.subject_digest], ["input_fingerprint", evidence.input_fingerprint], ["evidence_digest", value.evidence_digest], ["verdict", evidence.verdict], ["blocking_count", evidence.blocking_count], ["matched_rule_versions", evidence.matched_rule_versions.map((rule) => `${rule.rule_id}@${rule.rule_version}`)], ...provenanceMetadata(evidence),
  ]), "", "## Findings"];
  for (const finding of evidence.findings) lines.push("", ...renderReviewFinding(finding));
  if (evidence.assurance === "degraded") lines.push("", "## Degraded Assurance", prose("reason", evidence.reason));
  return linesToBytes(lines);
}

function renderDisposition(disposition: TriageDisposition): string[] {
  const lines = [`### ${canonical(disposition.disposition)} ${visibleJsonString(disposition.review_evidence_digest)} ${visibleJsonString(disposition.finding_id)}`, prose("rationale", disposition.rationale)];
  if (disposition.disposition === "accepted") lines.push(prose("revision_intent", disposition.revision_intent));
  else lines.push(prose("evidence", disposition.evidence));
  return lines;
}
export function renderTriage(value: ValidatedTriage): Uint8Array {
  if (!authenticValidatedTriage(value)) throw new TypeError("validated triage is required");
  const lines = ["# ArchFlow Review Triage", ...metadata([
    ["schema_version", value.schema_version], ["task_id", value.task_id], ["phase_instance", value.phase_instance], ["step", value.step], ["subject_digest", value.subject_digest], ["input_fingerprint", value.input_fingerprint], ["current_evidence_set_digest", value.current_evidence_set_digest], ["source_evidence_digests", value.source_evidence_digests], ["accepted_count", value.accepted_count], ["rejected_count", value.rejected_count],
  ]), "", "## Dispositions"];
  for (const disposition of value.dispositions) lines.push("", ...renderDisposition(disposition));
  return linesToBytes(lines);
}

function renderMechanicalEvidence(value: MechanicalEvidence): string[] {
  return [`    mechanism: ${visibleJsonString(value.mechanism)}`, `    state: ${canonical(value.state)}`, `    subject_digest: ${optional(value.subject_digest)}`, `    evidence_digest: ${optional(value.evidence_digest)}`, prose("details", value.details, "    ")];
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
    ["schema_version", evidence.schema_version], ["task_id", evidence.task_id], ["phase_instance", evidence.phase_instance], ["step", evidence.step], ["subject_digest", evidence.subject_digest], ["input_fingerprint", evidence.input_fingerprint], ["evidence_digest", value.evidence_digest], ["pinned_constitution_digest", evidence.pinned_constitution_digest], ["approved_upstream_digests", evidence.approved_upstream_digests], ["source_evidence_set_digest", evidence.source_evidence_set_digest], ["constitution", evidence.constitution], ["drift", evidence.drift], ["matched_rule_versions", evidence.matched_rule_versions.map((rule) => `${rule.rule_id}@${rule.rule_version}`)], ["uncertain_rule_versions", evidence.uncertain_rule_versions.map((rule) => `${rule.rule_id}@${rule.rule_version}`)], ...provenanceMetadata(evidence),
  ]), "", "## Constitution Findings"];
  for (const finding of evidence.rule_findings) {
    lines.push("", `### Rule ${visibleJsonString(`${finding.rule_id}@${finding.rule_version}`)}`, `compliance: ${canonical(finding.compliance)}`, `trigger: ${canonical(finding.trigger)}`, prose("rationale", finding.rationale), prose("trigger_evidence", finding.trigger_evidence), "  enforced_by:");
    for (const mechanism of finding.enforced_by) lines.push(...renderMechanicalEvidence(mechanism));
  }
  lines.push("", "## Drift Findings");
  for (const finding of evidence.drift_findings) lines.push("", `### Upstream ${visibleJsonString(finding.upstream_digest)}`, `drift: ${canonical(finding.drift)}`, `affected_claim_ids: ${canonical(finding.affected_claim_ids)}`, prose("rationale", finding.rationale));
  if (evidence.assurance === "degraded") lines.push("", "## Degraded Assurance", prose("reason", evidence.reason));
  return linesToBytes(lines);
}

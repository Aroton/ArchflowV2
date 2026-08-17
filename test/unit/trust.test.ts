import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";

import { parseSha256Digest, parseTaskSlug } from "../../src/contracts/evidence.js";
import {
  createTestAuthorityLink,
  createTestCurrentReviewSetAuthority,
  createTestObservationCapability,
  createTestVerifiedReferencedEvidence,
} from "../../src/contracts/internal/test-capabilities.js";
import { encodePhaseInstance } from "../../src/contracts/phase-instance.js";
import type { DegradedReview, ServerAttestedReview } from "../../src/contracts/review.js";
import {
  authorityQualifier,
  observationSource,
  parseAuthorityLinkData,
  parseRequiredReviewSlots,
  type AuthorityLinkData,
  type ObservationBindingByKind,
  type QualifiedReviewEvidence,
} from "../../src/contracts/trust.js";

const digest = (character: string) => parseSha256Digest(character.repeat(64));
const phase = encodePhaseInstance({ kind: "phase-impl", phase: 2 as never });
const TASK = parseTaskSlug("mcp-integration");

async function rawReview(): Promise<Record<string, unknown>> {
  return JSON.parse(await readFile(new URL("../fixtures/contracts/review/valid.json", import.meta.url), "utf8")) as Record<string, unknown>;
}

const degradedReview = (): DegradedReview => ({
  schema_version: "1", task_id: TASK, phase_instance: phase, step: "counter_review", role: "counter-review",
  subject_digest: digest("a"), input_fingerprint: digest("b"), rubric_digest: digest("c"), producer_family: "claude",
  findings: [{ finding_id: "unsafe-path", severity: "blocker", blocking: true, summary: "Path is unsafe.", evidence: "The path escapes its task.", suggested_resolution: "Reject traversal." }],
  matched_rule_versions: [{ rule_id: "safe-paths", rule_version: 2 }], verdict: "fail", blocking_count: 1,
  assurance: "degraded", model_family: "codex", model: "unknown", effort: "unknown", reason: "Manual fallback.",
});

function degradedLink(evidence: DegradedReview, evidenceDigest = digest("9")): AuthorityLinkData<"review", "degraded"> {
  return {
    schema_version: "1", evidence_kind: "review", assurance: "degraded", role: evidence.role,
    task_id: evidence.task_id, phase_instance: phase, subject_digest: evidence.subject_digest,
    input_fingerprint: evidence.input_fingerprint, evidence_digest: evidenceDigest,
    authority: { kind: "degraded", checkpoint_digest: digest("8"), checkpoint_revision: 1 },
  };
}

function qualifyDegraded(evidenceDigest = digest("9")): QualifiedReviewEvidence {
  const evidence = degradedReview();
  const verified = createTestVerifiedReferencedEvidence<"review", "degraded">("review", { evidence_digest: evidenceDigest, evidence });
  return authorityQualifier.qualifyReview(createTestAuthorityLink(degradedLink(evidence, evidenceDigest)), verified);
}

describe("invocation-scoped observation trust", () => {
  it("hashes exact private output bytes, deep-freezes evidence, and binds attestation", async () => {
    const raw = await rawReview();
    const bytes = new TextEncoder().encode(JSON.stringify(raw));
    const binding: ObservationBindingByKind["review"] = { kind: "review", task_id: TASK, phase_instance: phase, role: "counter-review", subject_digest: parseSha256Digest(raw.subject_digest), input_fingerprint: parseSha256Digest(raw.input_fingerprint), invocation_id: "invocation-1", envelope_input_digest: digest("d"), result_id: "result-1", adapter: "codex-cli", cli_version: "1.0.0", family: "codex", model: "gpt-5", effort: "high", rubric_digest: parseSha256Digest(raw.rubric_digest), producer_family: "claude" };
    const capability = createTestObservationCapability<"review">(binding);
    (binding as { model: string }).model = "changed-after-mint";
    const result = observationSource.observeReview(capability, bytes);
    bytes.fill(0);
    const exposed = result.observation.raw_output_bytes;
    exposed.fill(0);
    expect(result.observation.raw_output_bytes).not.toEqual(exposed);
    expect(result.evidence.model).toBe("gpt-5");
    expect(result.evidence.observed_output_digest).toBe(result.observation.raw_output_digest);
    expect(Object.isFrozen(result.evidence.findings)).toBe(true);
    expect(Object.isFrozen(result.evidence.findings[0])).toBe(true);
    expect(() => observationSource.observeReview({ ...capability } as never, result.observation.raw_output_bytes)).toThrow(/capability/);
    const altered = { ...raw, subject_digest: "f".repeat(64) };
    expect(() => observationSource.observeReview(capability, new TextEncoder().encode(JSON.stringify(altered)))).toThrow(/subject_digest/);
  });

  it("enforces the fixed adapter-family relation", async () => {
    const raw = await rawReview();
    const capability = createTestObservationCapability<"review">({ kind: "review", task_id: TASK, phase_instance: phase, role: "counter-review", subject_digest: parseSha256Digest(raw.subject_digest), input_fingerprint: parseSha256Digest(raw.input_fingerprint), invocation_id: "invocation-1", envelope_input_digest: digest("d"), result_id: "result-1", adapter: "claude-cli", cli_version: "1.0.0", family: "codex", model: "gpt-5", effort: "high", rubric_digest: parseSha256Digest(raw.rubric_digest), producer_family: "claude" });
    expect(() => observationSource.observeReview(capability, new TextEncoder().encode(JSON.stringify(raw)))).toThrow(/adapter and model family/);
  });
});

describe("identity-backed authority", () => {
  it("rejects plain, cast, spread-cloned, cross-kind, and cross-assurance values", () => {
    const evidence = degradedReview();
    const link = createTestAuthorityLink(degradedLink(evidence));
    const verified = createTestVerifiedReferencedEvidence<"review", "degraded">("review", { evidence_digest: digest("9"), evidence });
    (evidence as { reason: string }).reason = "changed-after-mint";
    expect(verified.evidence.reason).toBe("Manual fallback.");
    expect(authorityQualifier.qualifyReview(link, verified).evidence.assurance).toBe("degraded");
    expect(() => authorityQualifier.qualifyReview({ ...link } as never, verified)).toThrow(/untrusted/);
    expect(() => authorityQualifier.qualifyReview(link, { ...verified } as never)).toThrow(/untrusted/);
    expect(() => authorityQualifier.qualifyReview(degradedLink(evidence) as never, { evidence_digest: digest("9"), evidence } as never)).toThrow(/untrusted/);
    const wrongKind = createTestVerifiedReferencedEvidence<"adjudication", "degraded">("adjudication", { evidence_digest: digest("9"), evidence } as never);
    expect(() => authorityQualifier.qualifyReview(link, wrongKind as never)).toThrow(/untrusted/);
    const wrongAssurance = createTestAuthorityLink({ ...degradedLink(evidence), assurance: "agent-declared", authority: { kind: "agent-declared", result_id: "result-1", result_digest: digest("7"), state_revision: 1 } } as AuthorityLinkData<"review", "agent-declared">);
    expect(() => authorityQualifier.qualifyReview(wrongAssurance, verified as never)).toThrow(/untrusted|does not match/);
  });

  it("correlates every duplicated server provenance field", async () => {
    const raw = await rawReview();
    const capability = createTestObservationCapability<"review">({ kind: "review", task_id: TASK, phase_instance: phase, role: "counter-review", subject_digest: parseSha256Digest(raw.subject_digest), input_fingerprint: parseSha256Digest(raw.input_fingerprint), invocation_id: "invocation-1", envelope_input_digest: digest("d"), result_id: "result-1", adapter: "codex-cli", cli_version: "1.0.0", family: "codex", model: "gpt-5", effort: "high", rubric_digest: parseSha256Digest(raw.rubric_digest), producer_family: "claude" });
    const evidence = observationSource.observeReview(capability, new TextEncoder().encode(JSON.stringify(raw))).evidence;
    const verified = createTestVerifiedReferencedEvidence<"review", "server-attested">("review", { evidence_digest: digest("9"), evidence });
    const authority = { kind: "server", invocation_id: evidence.invocation_id, result_id: evidence.result_id, receipt_id: "receipt-1", state_revision: 1, envelope_input_digest: evidence.envelope_input_digest, observed_output_digest: evidence.observed_output_digest, result_digest: digest("7") } as const;
    const base: AuthorityLinkData<"review", "server-attested"> = { schema_version: "1", evidence_kind: "review", assurance: "server-attested", role: "counter-review", task_id: evidence.task_id, phase_instance: phase, subject_digest: evidence.subject_digest, input_fingerprint: evidence.input_fingerprint, evidence_digest: digest("9"), authority };
    expect(authorityQualifier.qualifyReview(createTestAuthorityLink(base), verified).evidence).toBe(verified.evidence);
    for (const [field, value] of [["invocation_id", "invocation-2"], ["result_id", "result-2"], ["envelope_input_digest", digest("e")], ["observed_output_digest", digest("f")]] as const) {
      const substituted = createTestAuthorityLink({ ...base, authority: { ...authority, [field]: value } });
      expect(() => authorityQualifier.qualifyReview(substituted, verified)).toThrow(/provenance/);
    }
  });

  it("requires authentic qualified reviews and the exact current set", () => {
    const counter = qualifyDegraded();
    const slots = [
      { role: "counter-review", evidence_digest: digest("9"), assurance: "degraded", producer_family: "claude", reviewer_family: "codex" },
    ] as const;
    const authority = createTestCurrentReviewSetAuthority({ task_id: TASK, phase_instance: phase, subject_digest: digest("a"), input_fingerprint: digest("b"), slots });
    expect(authorityQualifier.currentReviews(authority, [counter]).reviews).toHaveLength(1);
    expect(() => authorityQualifier.currentReviews({ ...authority } as never, [counter])).toThrow(/authority/);
    expect(() => authorityQualifier.currentReviews(authority, [{ ...counter } as never])).toThrow(/slot 0/);
  });

  it("rejects broad task identifiers on authority links and extra review slots", () => {
    const link = degradedLink(degradedReview(), digest("3"));
    for (const taskId of ["Task_1", "Task:1", "TASK-1"]) expect(() => parseAuthorityLinkData({ ...link, task_id: taskId })).toThrow();
    // invocation_id, result_id, and receipt_id are deliberately unchanged.
    expect(parseAuthorityLinkData({ ...link, authority: { kind: "degraded", checkpoint_digest: digest("8"), checkpoint_revision: 1 } }).task_id).toBe("mcp-integration");
    const slot = { role: "gate-counter-review", evidence_digest: digest("3"), assurance: "degraded", producer_family: "claude", reviewer_family: "codex", gate_id: "Gate:1" };
    expect(() => parseRequiredReviewSlots([
      { role: "counter-review", evidence_digest: digest("2"), assurance: "degraded", producer_family: "claude", reviewer_family: "codex" },
      slot,
    ])).toThrow();
  });
});

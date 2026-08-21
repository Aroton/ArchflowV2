import { describe, expect, it } from "vitest";

import { parseGitOid } from "../../src/contracts/canonical.js";
import { parseActiveGate, type ActiveGateV1 } from "../../src/contracts/durable-gate.js";
import { parseSha256Digest, parseTaskSlug } from "../../src/contracts/evidence.js";
import { computeGateContextDigest } from "../../src/contracts/fingerprints.js";
import { parseGateDecisionEnvelope, type GateContext, type GateKind, type HumanDecisionProvenance, type WaiverOriginRef } from "../../src/contracts/gates.js";
import { parseTaskPathClaim } from "../../src/contracts/path-claims.js";
import type { PlainJsonValue } from "../../src/contracts/plain-json.js";
import { currentEvidenceSetRef } from "../../src/contracts/trust.js";
import {
  buildGateDecisionTemplates,
  buildHumanGatePresentation,
  selectGateDecisionTemplate,
} from "../../src/state/gates.js";

const D = (value: string) => parseSha256Digest(value.repeat(64));
const RULE_A = { rule_id: "rule-a", rule_version: 1 } as const;
const RULE_B = { rule_id: "rule-b", rule_version: 2 } as const;
const AUTHORITY_LINK = {
  link_digest: D("9"), purpose: "restore-adoption", proposed_generation_digest: D("a"), changed_input_fingerprint: D("b"),
} as const;
const counter = { role: "counter-review", evidence_digest: D("8"), assurance: "server-attested", producer_family: "claude", reviewer_family: "codex" } as const;
const evidence = currentEvidenceSetRef([counter]);
const provenance: HumanDecisionProvenance = {
  schema_version: "1", actor_class: "human", assurance: "declared-local-trace", channel: "archflow-local",
  decision_event_id: "decision-test", helper_invocation_id: "helper-test", recorded_at: "2026-08-03T12:00:00.000Z",
};

const CASES = [
  { kind: "artifact-approval", context: { artifact_kind: "phase-implementation" }, allowed: ["approve", "revise", "reject", "cancel"] },
  { kind: "design-approval", context: {
    artifact_kind: "design", constitution: "fail",
    policy_findings: [{ ...RULE_A, compliance: "fail", rationale: "The design crosses the required boundary.", trigger: "matched", trigger_evidence: "The affected interface is in scope." }],
    eligible_waivers: [{ rule: RULE_A, scope: { operation: "adjudication-failure", boundary: "subject" } }],
    target_ref: "refs/heads/task", baseline_commit: parseGitOid("abcdef0123456789abcdef0123456789abcdef01"),
    commit_message: "ArchFlow: Approve task-1 design",
  }, allowed: ["approve", "revise", "reject", "waiver-requested", "cancel"] },
  // One rule failing compliance and another matching a review trigger: the gate must offer a
  // waiver on each rule's own axis, so the human never has to read server source to find one.
  { kind: "constitution-review", context: { constitution: "fail", failed_rules: [RULE_B], uncertain_rules: [], matched_trigger_rules: [RULE_A], uncertain_trigger_rules: [], eligible_waivers: [{ rule: RULE_A, scope: { operation: "review-trigger", boundary: "subject" } }, { rule: RULE_B, scope: { operation: "adjudication-failure", boundary: "subject" } }] }, allowed: ["approve", "revise", "reject", "waiver-requested", "cancel"] },
  { kind: "material-drift", context: { affected_upstream: { kind: "architecture", digest: D("a") }, drift: "material", affected_claim_ids: ["claim-one"] }, allowed: ["amend-upstream", "revise-current", "reject", "cancel"] },
  { kind: "attempts-exhausted", context: { step: "produce", attempts: 2, maximum_attempts: 2 }, allowed: ["retry-once", "revise", "abort", "cancel"] },
  { kind: "constitution-edit", context: { pinned_constitution_digest: D("a"), current_constitution_digest: D("b"), changed_path_class: "task-branch-constitution" }, allowed: ["revert-edit", "start-base-amendment", "abort", "cancel"] },
  { kind: "commit-authorization", context: { target_ref: "refs/heads/task", baseline_commit: "1".repeat(40) as never, commit_message: "ArchFlow: Implement task-1 phase 2", paths: ["tracked.txt" as never], diff_digest: D("a"), current_artifact_digests: [D("b")], parent_document_digests: [D("c")] }, allowed: ["authorize-commit", "revise", "abort", "cancel"] },
  { kind: "restore-collision", context: { path: parseTaskPathClaim("task/file.md"), recorded_generation_digest: D("a"), current_generation_digest: D("b"), adoption_candidate: AUTHORITY_LINK }, allowed: ["discard-and-restore", "adopt-as-new-generation", "abort", "cancel"] },
  { kind: "migration-audit", context: { source_identity_digest: D("a"), destination_identity_digest: D("b"), import_digest: D("c"), code_baseline_digest: D("d"), policy_baseline_digest: D("e") }, allowed: ["accept-import-audit", "revise", "abort", "cancel"] },
] as const satisfies readonly Readonly<{ kind: GateKind; context: GateContext<GateKind>; allowed: readonly string[] }>[];

function activeGate(entry: (typeof CASES)[number], suffix: string): ActiveGateV1 {
  const contextDigest = computeGateContextDigest(entry.kind, entry.context as never);
  return parseActiveGate({
    schema_version: "1", gate_id: `gate-${suffix}`, intent_id: `intent-${suffix}`, request_digest: D("f"), task_id: "task-1",
    phase_instance: entry.kind === "design-approval" ? "design" : "phase-impl-2", summary: "Human decision", subject_digest: D("c"), context_digest: contextDigest,
    current_evidence: evidence, kind: entry.kind, context: entry.context, allowed_decisions: entry.allowed,
    opened_at_revision: 5, status: "awaiting-human", decision_template: {
      schema_version: "1", gate_id: `gate-${suffix}`, task_id: "task-1", phase_instance: entry.kind === "design-approval" ? "design" : "phase-impl-2", kind: entry.kind,
      subject_digest: D("c"), context_digest: contextDigest, required_fields: ["payload", "human_provenance"],
      cancellation_fields: ["cancelled", "reason", "human_provenance"],
    },
  });
}

function withProvenance(template: PlainJsonValue): PlainJsonValue {
  if (template === null || Array.isArray(template) || typeof template !== "object") throw new Error("template is not an object");
  return { ...template, human_provenance: provenance };
}

// The disposable write path (writeGateDecisionChoice/Interface, runConnectedGateDecision) retired
// with its MCP-facing handlers; what stays under test is the presentation every human gate is
// resolved through: the conversational options, their server-issued tokens, and the templates the
// direct semantic decision archive derives its records from.
describe("gate decision presentation", () => {
  it("presents every gate as a conversational choice while keeping bindings internal", () => {
    for (const [index, entry] of CASES.entries()) {
      const active = activeGate(entry, `presentation-${index}`);
      const presentation = buildHumanGatePresentation(active);
      expect(presentation.summary, entry.kind).toBe("Human decision");
      expect(presentation.title, entry.kind).toMatch(/^[A-Z][^_]+$/u);
      expect(presentation.question, entry.kind).toContain("briefly explain why");
      expect(presentation.options, entry.kind).toHaveLength(buildGateDecisionTemplates(active).length);
      expect(presentation.options.every((option) => option.label.length > 0 && option.consequence.length > 0), entry.kind).toBe(true);
      if (entry.kind === "design-approval") {
        expect(presentation.options.find((option) => option.token === "approve")?.label)
          .toBe("Approve, commit, and continue");
        expect(presentation.details).toEqual([
          "rule-a: policy compliance is fail. The design crosses the required boundary.",
          "rule-a: review trigger is matched. The affected interface is in scope.",
        ]);
      }
      for (const option of presentation.options) {
        expect(() => selectGateDecisionTemplate(active, {
          choice: option.token,
          reason: "A human supplied this explanation.",
        }), `${entry.kind}: ${option.token}`).not.toThrow();
      }

      const serialized = JSON.stringify(presentation);
      expect(serialized, entry.kind).not.toContain(active.gate_id);
      expect(serialized, entry.kind).not.toContain(active.subject_digest);
      expect(serialized, entry.kind).not.toContain(active.context_digest);
      expect(serialized, entry.kind).not.toContain("decision_template");
    }
  });

  it("resolves server-issued presentation tokens without copied selectors or rationale", () => {
    const constitutionReview = activeGate(CASES[2], "presented-waiver");
    const presentation = buildHumanGatePresentation(constitutionReview);
    const requested = presentation.options.find((option) => option.token === "request-exception-2");
    expect(requested).toMatchObject({ label: "Request an exception for rule-b" });
    expect(selectGateDecisionTemplate(constitutionReview, {
      choice: requested!.token,
      reason: "This work is intentionally outside that rule for this one review.",
    })).toMatchObject({
      payload: {
        decision: "waiver-requested",
        rule: RULE_B,
        operation: "adjudication-failure",
        rationale: "This work is intentionally outside that rule for this one review.",
      },
    });

    const collision = activeGate(CASES[7], "presented-collision");
    expect(selectGateDecisionTemplate(collision, {
      choice: "keep-current-version",
      reason: "The workspace version contains the intended recovery edits.",
    })).toMatchObject({
      payload: {
        decision: "adopt-as-new-generation",
        rationale: "The workspace version contains the intended recovery edits.",
        adoption_authority: AUTHORITY_LINK,
      },
    });
  });

  it("presents internally derived content-trigger details only for commit authorization", () => {
    const commit = activeGate(CASES[6], "content-trigger-details");
    const details = [
      "db/schema.sql: modified; 120 → 148 bytes (+28 bytes).",
      "db/archive.sql: deleted; 42 → 0 bytes (-42 bytes).",
    ];
    const presentation = buildHumanGatePresentation(commit, details);

    expect(presentation.details).toEqual(details);
    expect(presentation.title).toBe("Authorize the commit");
    expect(presentation.options.map((option) => option.token)).toEqual([
      "authorize-commit", "request-changes", "stop-work", "cancel",
    ]);

    expect(() => buildHumanGatePresentation(
      activeGate(CASES[4], "misplaced-content-trigger-details"),
      details,
    )).toThrow("internal invariant: content-trigger details require a commit-authorization gate");
  });

  it("binds judgment-only choices to server-owned gate state", () => {
    const active = activeGate(CASES[0], "choice");
    expect(selectGateDecisionTemplate(active, { choice: "reject", reason: "The acceptance evidence is incomplete." })).toEqual({
      schema_version: "1",
      gate_id: active.gate_id,
      task_id: active.task_id,
      phase_instance: active.phase_instance,
      subject_digest: active.subject_digest,
      context_digest: active.context_digest,
      kind: active.kind,
      payload: { decision: "reject", reason: "The acceptance evidence is incomplete." },
    });

    const constitutionReview = activeGate(CASES[2], "waiver-choice");
    expect(selectGateDecisionTemplate(constitutionReview, {
      choice: "waiver-requested",
      reason: "A narrow exception is needed.",
      rationale: "The operation is bounded to this subject.",
      rule: RULE_B,
      operation: "adjudication-failure",
    })).toMatchObject({
      gate_id: constitutionReview.gate_id,
      context_digest: constitutionReview.context_digest,
      payload: {
        decision: "waiver-requested",
        reason: "A narrow exception is needed.",
        rationale: "The operation is bounded to this subject.",
        rule: RULE_B,
        operation: "adjudication-failure",
      },
    });
    expect(() => selectGateDecisionTemplate(constitutionReview, {
      choice: "waiver-requested",
      reason: "Wrong selector.",
      rationale: "Does not match an eligible waiver.",
      rule: RULE_A,
      operation: "adjudication-failure",
    })).toThrow("choice is not allowed");
  });

  it("enumerates every gate kind and all context-bound decision variants", () => {
    for (const [index, entry] of CASES.entries()) {
      const active = activeGate(entry, String(index));
      const templates = buildGateDecisionTemplates(active);
      expect(templates.filter((template) => "cancelled" in (template as object)), entry.kind).toHaveLength(1);
      for (const template of templates) {
        expect(template).not.toHaveProperty("human_provenance");
        if ("payload" in (template as object)) expect(() => parseGateDecisionEnvelope(withProvenance(template)), entry.kind).not.toThrow();
      }
      if (entry.kind === "constitution-review") {
        // One template per waivable (rule, axis) pair, each naming its operation explicitly.
        const waivers = templates.filter((template) => (template as { payload?: { decision?: string } }).payload?.decision === "waiver-requested");
        expect(waivers.map((template) => (template as { payload: { rule: { rule_id: string }; operation: string } }).payload)).toEqual([
          { decision: "waiver-requested", reason: expect.any(String), rule: RULE_A, operation: "review-trigger", rationale: expect.any(String) },
          { decision: "waiver-requested", reason: expect.any(String), rule: RULE_B, operation: "adjudication-failure", rationale: expect.any(String) },
        ]);
        const noEligible = parseActiveGate({
          ...active,
          context: { ...active.context as GateContext<"constitution-review">, eligible_waivers: [] },
        });
        expect(buildGateDecisionTemplates(noEligible).some((template) => (template as { payload?: { decision?: string } }).payload?.decision === "waiver-requested")).toBe(false);
      }
      if (entry.kind === "restore-collision") {
        const withoutCandidate = parseActiveGate({ ...active, context: { path: parseTaskPathClaim("task/file.md"), recorded_generation_digest: D("a"), current_generation_digest: D("b") } });
        expect(buildGateDecisionTemplates(withoutCandidate).some((template) => (template as { payload?: { decision?: string } }).payload?.decision === "adopt-as-new-generation")).toBe(false);
      }
    }
  });

  it("emits fully bound grant, deny, and cancellation shapes with the waiver context digest", () => {
    const origin: WaiverOriginRef = {
      origin_gate_id: "origin-gate" as never, origin_decision_digest: D("1"), origin_context_digest: D("2"), task_id: parseTaskSlug("task-1"),
      phase_instance: "phase-impl-2" as never, subject_digest: D("c"), current_evidence_set_digest: evidence.set_digest,
      rule: RULE_A, scope: { operation: "review-trigger", boundary: "subject" },
    };
    const context = { origin, rationale: "Narrow exception" } as const;
    const contextDigest = computeGateContextDigest("waiver", context);
    const ordinary = activeGate(CASES[2], "waiver");
    const active = parseActiveGate({
      ...ordinary, context, context_digest: contextDigest, allowed_decisions: ["grant", "deny", "cancel"],
      decision_template: { ...ordinary.decision_template, context_digest: contextDigest, required_fields: ["granted", "scope", "origin", "notes", "human_provenance"] },
    });
    const templates = buildGateDecisionTemplates(active);
    expect(templates).toHaveLength(3);
    expect(templates[0]).toMatchObject({ context_digest: contextDigest, granted: true, origin, scope: origin.scope });
    expect(templates[1]).toMatchObject({ context_digest: contextDigest, granted: false, origin, scope: origin.scope });
    expect(templates[2]).toMatchObject({ context_digest: contextDigest, cancelled: true });
    expect(templates.some((template) => "payload" in (template as object))).toBe(false);
  });
});

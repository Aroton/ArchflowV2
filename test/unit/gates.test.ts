import { describe, expect, it } from "vitest";

import { GATE_KINDS, gateDecisionEffect, parseGateContext, parseGateContract, parseGateDecisionEnvelope, validateGateDecision } from "../../src/contracts/gates.js";

const D = "a".repeat(64);
const RULE = { rule_id: "trust-boundary", rule_version: 1 };
const TRIGGER = {
  kind: "rule-settlement",
  settlement: { subject_digest: D, config_digest: "b".repeat(64), settled_at_revision: 4 },
  conclusion: { wait: true, match: { kind: "subject", subject: "phase-impl" } },
  rule_authority: "authenticated",
} as const;
const PASSING_POLICY = { constitution: "pass", policy_findings: [], eligible_waivers: [], approval_trigger: TRIGGER } as const;

describe("gate catalogue", () => {
  it("contains exactly the ten independent kinds", () => {
    expect(GATE_KINDS).toEqual(["artifact-approval", "design-approval", "constitution-review", "material-drift", "attempts-exhausted", "constitution-edit", "commit-authorization", "restore-collision", "baseline-adoption", "migration-audit"]);
  });

  it("binds a baseline adoption to its exact drift set", () => {
    const drifted = [{ path: "src/one.ts", recorded_digest: D, observed_digest: "b".repeat(64) }];
    const context = parseGateContext("baseline-adoption", { drifted_projections: drifted });
    expect(validateGateDecision("baseline-adoption", context, { decision: "adopt-current-bytes", reason: "Merge from main" })).toBeTruthy();
    expect(validateGateDecision("baseline-adoption", context, { decision: "restore-recorded-bytes", reason: "Discard the drift" })).toBeTruthy();
    // The gate exists to decide real drift: no entries, duplicate paths, or digests that agree all fail.
    expect(() => parseGateContext("baseline-adoption", { drifted_projections: [] })).toThrow();
    expect(() => parseGateContext("baseline-adoption", { drifted_projections: [...drifted, ...drifted] })).toThrow(/sorted/);
    expect(() => parseGateContext("baseline-adoption", { drifted_projections: [{ path: "src/one.ts", recorded_digest: D, observed_digest: D }] })).toThrow();
  });

  it("requires localeCompare order for mixed-case uncommitted paths", () => {
    // The schema is the authority for uncommitted_paths, and its localeCompare ordering diverges
    // from default code-unit .sort() on mixed-case sets — a code-unit producer fails composition
    // with "uncommitted paths must be sorted with no duplicates". Both orderings are pinned here.
    const paths = [
      "scripts/fixtures/transport-acceptance/ssh/v2/README.md",
      "scripts/fixtures/transport-acceptance/ssh/v2/archforge-acceptance-fixture-forced-command",
      "docs/transport-acceptance.md",
    ];
    const localeOrder = [...paths].sort((left, right) => left.localeCompare(right));
    expect(localeOrder).not.toEqual([...paths].sort());
    const drifted = localeOrder.map((path, index) => ({
      path,
      recorded_digest: index % 2 === 0 ? D : "c".repeat(64),
      observed_digest: index % 2 === 0 ? "b".repeat(64) : D,
    }));
    const base = { drifted_projections: drifted, target_ref: "refs/heads/main", target_head: "1".repeat(40) };
    expect(parseGateContext("baseline-adoption", { ...base, uncommitted_paths: localeOrder }).uncommitted_paths).toEqual(localeOrder);
    expect(() => parseGateContext("baseline-adoption", { ...base, uncommitted_paths: [...localeOrder].sort() })).toThrow(/uncommitted paths must be sorted with no duplicates/);
    const secondary = {
      drifted_projections: drifted, deleted_projections: [],
      repository: "apis", repository_identity_digest: "2".repeat(64),
      target_ref: "refs/heads/main", target_head: "3".repeat(40), uncommitted_paths: localeOrder,
    };
    expect(parseGateContext("baseline-adoption", { drifted_projections: [], secondary_targets: [secondary] }).secondary_targets?.[0]?.uncommitted_paths).toEqual(localeOrder);
    expect(() => parseGateContext("baseline-adoption", { drifted_projections: [], secondary_targets: [{ ...secondary, uncommitted_paths: [...localeOrder].sort() }] })).toThrow(/uncommitted paths/);
  });

  it("accepts either ascending order for commit paths at mixed-case boundaries", () => {
    // Composers emit code-unit order (the rule every other sorted-path contract applies), but
    // archives written by the previous bundle store localeCompare order; both parse so legacy
    // approvals stay authenticable. Sets sorted in neither order, and duplicates, still throw.
    const base = { ...PASSING_POLICY, target_ref: "refs/heads/main", baseline_commit: "1".repeat(40), commit_message: "Implement the phase", diff_digest: D, current_artifact_digests: [D], parent_document_digests: [D] };
    const codeUnit = parseGateContext("commit-authorization", { ...base, paths: ["docs/COMPLEXITY.md", "docs/cli/COMMANDS.md", "src/state/status.ts"] });
    expect(codeUnit.paths).toEqual(["docs/COMPLEXITY.md", "docs/cli/COMMANDS.md", "src/state/status.ts"]);
    const locale = parseGateContext("commit-authorization", { ...base, paths: ["docs/cli/COMMANDS.md", "docs/COMPLEXITY.md", "src/state/status.ts"] });
    expect(locale.paths).toEqual(["docs/cli/COMMANDS.md", "docs/COMPLEXITY.md", "src/state/status.ts"]);
    expect(() => parseGateContext("commit-authorization", { ...base, paths: ["src/state/status.ts", "docs/COMPLEXITY.md", "docs/cli/COMMANDS.md"] })).toThrow();
    expect(() => parseGateContext("commit-authorization", { ...base, paths: ["docs/COMPLEXITY.md", "docs/COMPLEXITY.md"] })).toThrow();
  });

  it("keeps cancellation outside decisions", () => {
    const artifact = parseGateContext("artifact-approval", { ...PASSING_POLICY, artifact_kind: "prd" });
    expect(() => validateGateDecision("artifact-approval", artifact, { decision: "approve", reason: "Ready" })).not.toThrow();
    expect(() => validateGateDecision("artifact-approval", artifact, { decision: "cancelled", reason: "No" } as never)).toThrow();
    expect(() => validateGateDecision("artifact-approval", artifact, { action: "decline", reason: "No" } as never)).toThrow();
  });

  it("requires provenance on every fresh ordinary gate and authenticates every waiver choice", () => {
    const finding = {
      ...RULE,
      compliance: "pass" as const,
      rationale: "The rule passed.",
      trigger: "matched" as const,
      trigger_evidence: "The protected boundary matched.",
    };
    const policy = {
      constitution: "pass" as const,
      policy_findings: [finding],
      eligible_waivers: [{ rule: RULE, scope: { operation: "review-trigger" as const, boundary: "subject" as const } }],
      approval_trigger: TRIGGER,
    };
    const waiver = { decision: "waiver-requested" as const, reason: "Request an exception", rule: RULE, operation: "review-trigger" as const, rationale: "One-time need" };
    const artifact = parseGateContext("artifact-approval", { ...policy, artifact_kind: "prd" });
    const commit = parseGateContext("commit-authorization", {
      ...policy,
      target_ref: "refs/heads/main",
      baseline_commit: "1".repeat(40),
      commit_message: "Implement the phase",
      paths: ["src/a.ts"],
      diff_digest: D,
      current_artifact_digests: [D],
      parent_document_digests: [D],
    });
    expect(validateGateDecision("artifact-approval", artifact, waiver)).toEqual(waiver);
    expect(validateGateDecision("commit-authorization", commit, waiver)).toEqual(waiver);
    expect(() => parseGateContext("artifact-approval", { artifact_kind: "prd" })).toThrow();
    expect(() => parseGateContext("commit-authorization", {
      target_ref: "refs/heads/main", baseline_commit: "1".repeat(40), commit_message: "Implement",
      paths: ["src/a.ts"], diff_digest: D, current_artifact_digests: [D], parent_document_digests: [D],
    })).toThrow();
    expect(() => validateGateDecision("artifact-approval", artifact, { ...waiver, rule: { rule_id: "other", rule_version: 1 } })).toThrow(/eligible/);
    expect(() => validateGateDecision("commit-authorization", commit, { ...waiver, operation: "adjudication-failure" })).toThrow(/eligible/);
  });

  it("accepts only the closed simple-revision reapproval trigger", () => {
    const trigger = {
      kind: "human-revision-reapproval",
      prior_gate: { gate_id: "gate-prior-1", decision_digest: D, class: "configured-approval" },
      revision_checkpoint: {
        classification: "simple",
        predecessor_subject_digest: "b".repeat(64),
        subject_digest: "c".repeat(64),
      },
    } as const;
    expect(parseGateContext("artifact-approval", {
      artifact_kind: "prd", constitution: "pass", policy_findings: [], eligible_waivers: [], approval_trigger: trigger,
    }).approval_trigger).toEqual(trigger);
    expect(() => parseGateContext("artifact-approval", {
      artifact_kind: "prd", constitution: "pass", policy_findings: [], eligible_waivers: [],
      approval_trigger: { ...trigger, revision_checkpoint: { ...trigger.revision_checkpoint, classification: "significant" } },
    })).toThrow();
    expect(() => parseGateContext("artifact-approval", {
      artifact_kind: "prd", constitution: "pass", policy_findings: [], eligible_waivers: [],
      approval_trigger: { ...trigger, inherited_summary: "caller-authored" },
    })).toThrow();
  });

  it("enforces waiver, attempt, adjudication, and restore sequencing", () => {
    // Both axes at one gate: a waiver must name the rule AND the axis the gate offered it on.
    const review = parseGateContext("constitution-review", { constitution: "fail", failed_rules: [RULE], uncertain_rules: [], matched_trigger_rules: [RULE], uncertain_trigger_rules: [], eligible_waivers: [{ rule: RULE, scope: { operation: "adjudication-failure", boundary: "subject" } }, { rule: RULE, scope: { operation: "review-trigger", boundary: "subject" } }] });
    expect(validateGateDecision("constitution-review", review, { decision: "waiver-requested", reason: "Exception", rule: RULE, operation: "review-trigger", rationale: "Temporary" })).toBeTruthy();
    expect(validateGateDecision("constitution-review", review, { decision: "waiver-requested", reason: "Exception", rule: RULE, operation: "adjudication-failure", rationale: "Temporary" })).toBeTruthy();
    expect(() => parseGateContext("attempts-exhausted", { step: "produce", attempts: 1, maximum_attempts: 2 })).toThrow();

    // A rule offered on only one axis cannot be waived on the other.
    const complianceOnly = parseGateContext("constitution-review", { constitution: "fail", failed_rules: [RULE], uncertain_rules: [], matched_trigger_rules: [], uncertain_trigger_rules: [], eligible_waivers: [{ rule: RULE, scope: { operation: "adjudication-failure", boundary: "subject" } }] });
    expect(() => validateGateDecision("constitution-review", complianceOnly, { decision: "waiver-requested", reason: "Exception", rule: RULE, operation: "review-trigger", rationale: "Temporary" })).toThrow(/eligible/);
    expect(validateGateDecision("constitution-review", complianceOnly, { decision: "approve", reason: "Handled" })).toBeTruthy();
    // An eligible waiver must sit on the axis its operation covers, and a gate must carry a question.
    expect(() => parseGateContext("constitution-review", { constitution: "fail", failed_rules: [RULE], uncertain_rules: [], matched_trigger_rules: [], uncertain_trigger_rules: [], eligible_waivers: [{ rule: RULE, scope: { operation: "review-trigger", boundary: "subject" } }] })).toThrow();
    expect(() => parseGateContext("constitution-review", { constitution: "pass", failed_rules: [], uncertain_rules: [], matched_trigger_rules: [], uncertain_trigger_rules: [], eligible_waivers: [] })).toThrow();
    expect(() => parseGateContext("constitution-review", { constitution: "pass", failed_rules: [RULE], uncertain_rules: [], matched_trigger_rules: [], uncertain_trigger_rules: [], eligible_waivers: [] })).toThrow();

    const authority = { link_digest: D, purpose: "restore-adoption" as const, proposed_generation_digest: D, changed_input_fingerprint: D };
    const restore = parseGateContext("restore-collision", { path: "task/file.md", recorded_generation_digest: D, current_generation_digest: D, adoption_candidate: authority });
    expect(validateGateDecision("restore-collision", restore, { decision: "adopt-as-new-generation", reason: "Keep edits", adoption_authority: restore.adoption_candidate!, rationale: "Reviewed" })).toBeTruthy();
    expect(() => validateGateDecision("restore-collision", restore, { decision: "adopt-as-new-generation", reason: "Keep edits", adoption_authority: { ...authority, link_digest: "b".repeat(64) }, rationale: "Reviewed" } as never)).toThrow();
  });

  it("makes semantic decision correlation mandatory in the public gate parser", () => {
    const context = { constitution: "pass", failed_rules: [], uncertain_rules: [], matched_trigger_rules: [RULE], uncertain_trigger_rules: [], eligible_waivers: [] } as const;
    expect(() => parseGateContract({ kind: "constitution-review", context, payload: { decision: "waiver-requested", reason: "Exception", rule: RULE, operation: "review-trigger", rationale: "Temporary" } })).toThrow(/eligible/);
    expect(() => parseGateContract({ kind: "attempts-exhausted", context: { step: "produce", attempts: 1, maximum_attempts: 2 }, payload: { decision: "abort", reason: "Stop" } })).toThrow(/attempts/);
  });

  it("parses kind-correlated envelopes and exposes effects", () => {
    const envelope = parseGateDecisionEnvelope({ schema_version: "1", gate_id: "gate-1", task_id: "task-1", phase_instance: "phase-impl-2", subject_digest: D, context_digest: D, human_provenance: { schema_version: "1", actor_class: "human", assurance: "declared-local-trace", channel: "archflow-local", decision_event_id: "decision-1", helper_invocation_id: "helper-1", recorded_at: "2026-07-27T12:00:00.000Z" }, kind: "commit-authorization", payload: { decision: "authorize-commit", reason: "Approved" } });
    expect(envelope.kind).toBe("commit-authorization");
    expect(gateDecisionEffect(envelope.payload)).toBe("advance");
    expect(gateDecisionEffect({ decision: "waiver-requested", reason: "x", rule: RULE, operation: "review-trigger", rationale: "x" })).toBe("redirect-waiver");
    expect(() => parseGateDecisionEnvelope({ ...envelope, human_provenance: { ...envelope.human_provenance, recorded_at: "2026-07-27T12:00:00Z" } })).toThrow();
    expect(() => parseGateDecisionEnvelope({ ...envelope, human_provenance: { ...envelope.human_provenance, recorded_at: "2026-07-27T07:00:00.000-05:00" } })).toThrow();
  });

  it("rejects the previously legal broad gate and task identifiers on the decision envelope", () => {
    const envelope = { schema_version: "1", gate_id: "gate-1", task_id: "task-1", phase_instance: "phase-impl-2", subject_digest: D, context_digest: D, human_provenance: { schema_version: "1", actor_class: "human", assurance: "declared-local-trace", channel: "archflow-local", decision_event_id: "decision-1", helper_invocation_id: "helper-1", recorded_at: "2026-07-27T12:00:00.000Z" }, kind: "artifact-approval", payload: { decision: "approve", reason: "Approved" } };
    expect(parseGateDecisionEnvelope(envelope).gate_id).toBe("gate-1");
    for (const gateId of ["Gate:1", "gate:1"]) expect(() => parseGateDecisionEnvelope({ ...envelope, gate_id: gateId })).toThrow();
    for (const taskId of ["Task_1", "Task:1", "TASK-1"]) expect(() => parseGateDecisionEnvelope({ ...envelope, task_id: taskId })).toThrow();
    // decision_event_id and helper_invocation_id are deliberately unchanged.
    expect(parseGateDecisionEnvelope({ ...envelope, human_provenance: { ...envelope.human_provenance, decision_event_id: "Decision:1", helper_invocation_id: "Helper:1" } }).human_provenance.decision_event_id).toBe("Decision:1");
  });
});

import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { canonicalDocument, canonicalJsonDigest, sha256Bytes } from "../../src/contracts/canonical.js";
import { computeGateContextDigest, computeGateId, type InputFingerprintSubject } from "../../src/contracts/fingerprints.js";
import { parseGateDecisionRecord, parseGateRequest } from "../../src/contracts/durable-gate.js";
import type { TaskStateV1 } from "../../src/contracts/durable-state.js";
import { parseSafeCode, parseSafeInteger, parseSha256Digest, parseTaskSlug } from "../../src/contracts/evidence.js";
import { gateDecisionEffect, type GateEffect, type GateKind } from "../../src/contracts/gates.js";
import { currentEvidenceSetRef } from "../../src/contracts/trust.js";
import type { RepositoryOperationContext } from "../../src/repository/git.js";
import { createGitRunner, preflightGit } from "../../src/repository/git.js";
import { discoverWorktree } from "../../src/repository/identity.js";
import { createAtomicWriter } from "../../src/state/atomic.js";
import { createInternalTransactionAuthority } from "../../src/state/authority.js";
import { assessCurrentEvidence } from "../../src/review/fixed-point.js";
import { deriveCurrentEvidenceSet, type RetainedEvidenceSet } from "../../src/state/evidence-results.js";
import { importGateDecisions, loadAuthenticatedGateApproval, runDurableGate } from "../../src/state/gates.js";
import { createTaskLock } from "../../src/state/lock.js";
import { readIntentReceipt, readTaskConfig, readTaskState } from "../../src/state/read.js";
import { resolvedConstitutionFixture } from "../helpers/resolved-constitution.js";

const D = (value: string) => parseSha256Digest(value.repeat(64));
const constitution = await resolvedConstitutionFixture({
  "00-trust-boundary.md": `---
id: trust-boundary
version: 1
status: active
---
rule
`,
});
const provenance = { schema_version: "1", actor_class: "human", assurance: "declared-local-trace", channel: "archflow-local", decision_event_id: "decision-1", helper_invocation_id: "helper-1", recorded_at: "2026-07-30T12:00:00.000Z" } as const;
const RULE = { rule_id: "trust-boundary", rule_version: 1 } as const;
const context = { artifact_kind: "phase-implementation" } as const;
const self = { role: "self-review", evidence_digest: D("7"), assurance: "agent-declared", producer_family: "claude", reviewer_family: "claude", independence: "same-family-self" } as const;
const counter = { role: "counter-review", evidence_digest: D("8"), assurance: "server-attested", producer_family: "claude", reviewer_family: "codex", independence: "opposite-family" } as const;
const gateId = computeGateId({ task_identity_digest: D("a"), intent_id: "intent-1" as never, request_digest: D("b") });
const contextDigest = computeGateContextDigest("artifact-approval", context);
const request = () => parseGateRequest({ schema_version: "1", gate_id: gateId, intent_id: "intent-1", request_digest: D("b"), task_id: "task-1", phase_instance: "phase-impl-2", summary: "Approve", subject_digest: D("c"), context_digest: contextDigest, current_evidence: { set_digest: D("3"), slots: [self, counter] }, kind: "artifact-approval", context, allowed_decisions: ["approve", "revise", "reject", "cancel"], opened_at_revision: 4 });
const decision = (choice: "approve" | "revise") => parseGateDecisionRecord({ schema_version: "1", gate_id: gateId, task_id: "task-1", phase_instance: "phase-impl-2", kind: "artifact-approval", subject_digest: D("c"), context_digest: contextDigest, supplemental: [], outcome: "decided", envelope: { schema_version: "1", gate_id: gateId, task_id: "task-1", phase_instance: "phase-impl-2", kind: "artifact-approval", subject_digest: D("c"), context_digest: contextDigest, human_provenance: provenance, payload: { decision: choice, reason: "Reviewed" } } });
const state = (): TaskStateV1 => ({ schema_version: "1", task_id: parseTaskSlug("task-1"), repository_identity_digest: D("1"), revision: parseSafeInteger(4), phase_instance: "phase-impl-2" as TaskStateV1["phase_instance"], step: "produce", status: "running", attempt: parseSafeInteger(1), input_fingerprint: D("2"), initialization_digest: D("3"), config_digest: D("4"), workflow_digest: D("5"), constitution_digest: constitution.digest, policy_base_commit: "abcdef0123456789abcdef0123456789abcdef01" as TaskStateV1["policy_base_commit"], authoritative_results: [], approvals: [], waivers: [] });

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

const AUTHORITY = { link_digest: D("9"), purpose: "restore-adoption", proposed_generation_digest: D("a"), changed_input_fingerprint: D("b") } as const;
const EFFECT_CASES = [
  { kind: "artifact-approval", context: { artifact_kind: "phase-implementation" }, allowed: ["approve", "revise", "reject", "cancel"], payload: { decision: "approve", reason: "Reviewed" }, effect: "advance" },
  { kind: "artifact-approval", context: { artifact_kind: "phase-implementation" }, allowed: ["approve", "revise", "reject", "cancel"], payload: { decision: "revise", reason: "Reviewed" }, effect: "retry" },
  { kind: "artifact-approval", context: { artifact_kind: "phase-implementation" }, allowed: ["approve", "revise", "reject", "cancel"], payload: { decision: "reject", reason: "Reviewed" }, effect: "non-advancing" },
  { kind: "review-trigger", context: { matched_rules: [RULE], uncertain_rules: [], eligible_waiver_rules: [RULE], waiver_scope: { operation: "review-trigger", boundary: "subject" } }, allowed: ["approve", "revise", "reject", "waiver-requested", "cancel"], payload: { decision: "waiver-requested", reason: "Exception", rule: RULE, rationale: "Reviewed exception" }, effect: "redirect-waiver" },
  { kind: "material-drift", context: { affected_upstream: { kind: "architecture", digest: D("a") }, drift: "material", affected_claim_ids: ["claim-one"] }, allowed: ["amend-upstream", "revise-current", "reject", "cancel"], payload: { decision: "amend-upstream", reason: "Reviewed" }, effect: "redirect-upstream" },
  { kind: "material-drift", context: { affected_upstream: { kind: "architecture", digest: D("a") }, drift: "material", affected_claim_ids: ["claim-one"] }, allowed: ["amend-upstream", "revise-current", "reject", "cancel"], payload: { decision: "revise-current", reason: "Reviewed" }, effect: "retry" },
  { kind: "attempts-exhausted", context: { step: "produce", attempts: 2, maximum_attempts: 2 }, allowed: ["retry-once", "revise", "abort", "cancel"], payload: { decision: "retry-once", reason: "Reviewed" }, effect: "retry" },
  { kind: "attempts-exhausted", context: { step: "produce", attempts: 2, maximum_attempts: 2 }, allowed: ["retry-once", "revise", "abort", "cancel"], payload: { decision: "abort", reason: "Reviewed" }, effect: "non-advancing" },
  { kind: "constitution-edit", context: { pinned_constitution_digest: D("a"), current_constitution_digest: D("b"), changed_path_class: "task-branch-constitution" }, allowed: ["revert-edit", "start-base-amendment", "abort", "cancel"], payload: { decision: "revert-edit", reason: "Reviewed" }, effect: "retry" },
  { kind: "constitution-edit", context: { pinned_constitution_digest: D("a"), current_constitution_digest: D("b"), changed_path_class: "task-branch-constitution" }, allowed: ["revert-edit", "start-base-amendment", "abort", "cancel"], payload: { decision: "start-base-amendment", reason: "Reviewed" }, effect: "redirect-upstream" },
  { kind: "commit-authorization", context: { target_ref: "refs/heads/task", diff_digest: D("a"), current_artifact_digests: [D("b")], parent_document_digests: [D("c")] }, allowed: ["authorize-commit", "revise", "abort", "cancel"], payload: { decision: "authorize-commit", reason: "Reviewed" }, effect: "advance" },
  { kind: "restore-collision", context: { path: "task/file.md", recorded_generation_digest: D("a"), current_generation_digest: D("b"), adoption_candidate: AUTHORITY }, allowed: ["discard-and-restore", "adopt-as-new-generation", "abort", "cancel"], payload: { decision: "discard-and-restore", reason: "Reviewed" }, effect: "advance" },
  { kind: "restore-collision", context: { path: "task/file.md", recorded_generation_digest: D("a"), current_generation_digest: D("b"), adoption_candidate: AUTHORITY }, allowed: ["discard-and-restore", "adopt-as-new-generation", "abort", "cancel"], payload: { decision: "adopt-as-new-generation", reason: "Adopt", adoption_authority: AUTHORITY, rationale: "Reviewed local changes" }, effect: "advance" },
  { kind: "migration-audit", context: { source_identity_digest: D("a"), destination_identity_digest: D("b"), import_digest: D("c"), code_baseline_digest: D("d"), policy_baseline_digest: D("e") }, allowed: ["accept-import-audit", "revise", "abort", "cancel"], payload: { decision: "accept-import-audit", reason: "Reviewed" }, effect: "advance" },
] as const satisfies readonly Readonly<{ kind: GateKind; context: object; allowed: readonly string[]; payload: Readonly<{ decision: string } & Record<string, unknown>>; effect: GateEffect }>[];

function authorityPair(entry: (typeof EFFECT_CASES)[number], index: number) {
  const matrixGateId = `gate-matrix-${index}`;
  const matrixContextDigest = computeGateContextDigest(entry.kind, entry.context as never);
  const common = { gate_id: matrixGateId, task_id: "task-1", phase_instance: "phase-impl-2", kind: entry.kind, subject_digest: D("c"), context_digest: matrixContextDigest };
  return {
    request: parseGateRequest({ schema_version: "1", ...common, intent_id: `intent-matrix-${index}`, request_digest: D("f"), summary: "Effect matrix", current_evidence: { set_digest: D("3"), slots: [self, counter] }, context: entry.context, allowed_decisions: entry.allowed, opened_at_revision: 4 }),
    decision: parseGateDecisionRecord({ schema_version: "1", ...common, supplemental: [], outcome: "decided", envelope: { schema_version: "1", ...common, human_provenance: { ...provenance, decision_event_id: `decision-matrix-${index}` }, payload: entry.payload } }),
  };
}

describe("gate manual authority import", () => {
  it("imports only advancing decisions and is idempotent by gate id", () => {
    const imported = importGateDecisions(state(), [{ request: request(), decision: decision("approve") }]);
    expect(imported.approvals).toHaveLength(1);
    const repeated = importGateDecisions({ ...state(), approvals: imported.approvals }, [{ request: request(), decision: decision("approve") }]);
    expect(repeated.approvals).toEqual(imported.approvals);
    expect(importGateDecisions(state(), [{ request: request(), decision: decision("revise") }]).approvals).toEqual([]);
  });

  it("derives authority from every decision-effect arm without granting on non-advance", () => {
    expect(new Set(EFFECT_CASES.map(({ payload }) => payload.decision)).size).toBe(14);
    for (const [index, entry] of EFFECT_CASES.entries()) {
      expect(gateDecisionEffect(entry.payload as never), entry.payload.decision).toBe(entry.effect);
      const imported = importGateDecisions(state(), [authorityPair(entry, index)]);
      expect(imported.approvals, entry.payload.decision).toHaveLength(entry.effect === "advance" ? 1 : 0);
      expect(imported.waivers, entry.payload.decision).toEqual([]);
    }
  });

  it("rejects import while a gate is live and rejects a foreign task pair", () => {
    const open = { ...state(), open_gate: { gate_id: gateId, gate_kind: "artifact-approval" as const, subject_digest: D("c"), context_digest: contextDigest, frozen_state_digest: D("f"), opened_at_revision: parseSafeInteger(4) } };
    expect(() => importGateDecisions(open, [])).toThrow(/no live gate/u);
    expect(() => importGateDecisions({ ...state(), task_id: parseTaskSlug("other") }, [{ request: request(), decision: decision("approve") }])).toThrow(/foreign/u);
  });

  it("rejects a request/closure binding mismatch", () => {
    const mismatched = { ...decision("approve"), subject_digest: D("d") };
    expect(() => importGateDecisions(state(), [{ request: request(), decision: mismatched }])).toThrow(/does not bind/u);
  });

  it("leaves an aborted wait pending and resumes through archive, receipt, state, and cleanup", async () => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), "archflow-gate-service-"))); roots.push(root);
    const env = { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_SYSTEM: "/dev/null", GIT_AUTHOR_NAME: "ArchFlow Test", GIT_AUTHOR_EMAIL: "test@example.invalid", GIT_COMMITTER_NAME: "ArchFlow Test", GIT_COMMITTER_EMAIL: "test@example.invalid" };
    execFileSync("git", ["-c", "init.defaultBranch=main", "init", "-q"], { cwd: root, env });
    writeFileSync(join(root, "tracked.txt"), "root\n"); execFileSync("git", ["add", "tracked.txt"], { cwd: root, env }); execFileSync("git", ["commit", "-q", "-m", "root"], { cwd: root, env });
    const taskRoot = join(root, ".archflow", "tasks", "task-1"); mkdirSync(taskRoot, { recursive: true });
    const configBytes = Buffer.from('schema_version: "1"\nroles:\n  counter-reviewer: {model: gpt-example, effort: high}\n  adjudicator: {model: claude-example, effort: high}\n');
    writeFileSync(join(taskRoot, "config.yaml"), configBytes);
    const operation: RepositoryOperationContext = { task_id: parseTaskSlug("task-1"), phase_instance: "phase-impl-2" as never, operation: parseSafeCode("gate-test"), attempt: parseSafeInteger(1) };
    const runnerResult = await discoverWorktree(createGitRunner({ cwd: root }), operation); if (!runnerResult.ok) throw new Error("discovery failed");
    const git = await preflightGit(runnerResult.value, operation); if (!git.ok) throw new Error("preflight failed");
    const authorityResult = await createInternalTransactionAuthority({ runner: runnerResult.value, environment: git.value, task_id: parseTaskSlug("task-1"), context: operation }); if (!authorityResult.ok) throw new Error("authority failed");
    const authority = authorityResult.value;
    const inputFingerprint = D("2");
    const initial: TaskStateV1 = { ...state(), repository_identity_digest: authority.repository_identity_digest, config_digest: sha256Bytes(configBytes), input_fingerprint: inputFingerprint };
    writeFileSync(join(taskRoot, "state.json"), canonicalDocument(initial).bytes);
    const dependencies = { runner: runnerResult.value, environment: git.value, atomic: createAtomicWriter(), lock: createTaskLock(), read_state: readTaskState, read_config: readTaskConfig, read_receipt: readIntentReceipt, resolve_input_fingerprint: async () => ({ schema_version: "1" as const, ok: true as const, value: {} as InputFingerprintSubject }) };
    const reviewContext = { matched_rules: [RULE], uncertain_rules: [], eligible_waiver_rules: [RULE], waiver_scope: { operation: "review-trigger", boundary: "subject" } } as const;
    const base = {
      schema_version: "1", task_id: "task-1", phase_instance: initial.phase_instance,
      subject_digest: D("c"), input_fingerprint: inputFingerprint,
    } as const;
    const review = (role: "self-review" | "counter-review") => ({
      ...base, step: role === "self-review" ? "self_review" : "counter_review", role,
      rubric_digest: D("d"), producer_family: "claude", findings: [],
      matched_rule_versions: [], verdict: "pass", blocking_count: 0,
      assurance: role === "self-review" ? "agent-declared" : "server-attested",
      model_family: role === "self-review" ? "claude" : "codex",
      model: "fixture", effort: "high",
      ...(role === "self-review" ? {} : {
        adapter: "codex-cli",
        cli_version: "fixture-1",
        invocation_id: "fixture-invocation",
        envelope_input_digest: D("e"),
        observed_output_digest: D("f"),
        result_id: "fixture-result",
      }),
    });
    const selfEvidence = review("self-review");
    const counterEvidence = review("counter-review");
    const selfSlot = {
      ...self,
      evidence_digest: canonicalJsonDigest(selfEvidence),
    };
    const counterSlot = {
      ...counter,
      evidence_digest: canonicalJsonDigest(counterEvidence),
    };
    const reviewEntry = (artifact_digest: ReturnType<typeof D>, evidence: object) => ({
      reference: {},
      manifest: {
        artifact_digest,
        source_artifact: {
          schema_version: "1",
          artifact_kind: "review-evidence",
          evidence,
        },
      },
    }) as never;
    const currentEvidence = deriveCurrentEvidenceSet(new Map([
      ["self_review", reviewEntry(selfSlot.evidence_digest, selfEvidence)],
      ["counter_review", reviewEntry(counterSlot.evidence_digest, counterEvidence)],
    ])).current_evidence_set;
    const lifecycle = { authority, expected_revision: initial.revision, intent_id: "intent-1" as never, request_digest: D("b"), input_fingerprint: inputFingerprint, phase_instance: initial.phase_instance, summary: "Approve", subject_digest: D("c"), current_evidence: currentEvidence, kind: "review-trigger" as const, context: reviewContext };
    const lifecycleGate = computeGateId({ task_identity_digest: authority.task_identity_digest, intent_id: lifecycle.intent_id, request_digest: lifecycle.request_digest });
    const aborted = new AbortController(); aborted.abort();
    const first = await runDurableGate(dependencies, { ...lifecycle, signal: aborted.signal });
    expect(first).toMatchObject({ ok: false, error: { code: "CANCELLED" } });
    const pending = await readTaskState(authority.state); expect(pending).toMatchObject({ kind: "canonical", document: { value: { revision: 5, open_gate: { gate_id: lifecycleGate } } } });
    const lifecycleContextDigest = computeGateContextDigest("review-trigger", reviewContext);
    writeFileSync(join(taskRoot, "gate.decision"), canonicalDocument({
      schema_version: "1", gate_id: lifecycleGate, task_id: "task-1",
      phase_instance: initial.phase_instance, kind: "review-trigger",
      subject_digest: D("c"), context_digest: lifecycleContextDigest,
      human_provenance: provenance,
      payload: { decision: "approve", reason: "Reviewed" },
    }).bytes);
    const resumed = await runDurableGate(dependencies, { ...lifecycle, signal: new AbortController().signal });
    expect(resumed).toMatchObject({ ok: true, value: { replayed: false, effect: "advance", state: { value: { revision: 6, approvals: [{ gate_id: lifecycleGate }] } } } });
    expect(existsSync(join(taskRoot, "decisions", lifecycleGate, "decision.json"))).toBe(true);
    expect(existsSync(join(taskRoot, "intents", "intent-1.json"))).toBe(true);
    expect(existsSync(join(taskRoot, "gate.json"))).toBe(false);
    expect(existsSync(join(taskRoot, "gate.decision"))).toBe(false);
    expect(readFileSync(join(taskRoot, "state.json"), "utf8")).toContain('"committed_intent"');

    const resolvedState = (await readTaskState(authority.state));
    if (resolvedState.kind !== "canonical") throw new Error("resolved state missing");
    const approval = resolvedState.document.value.approvals[0]!;
    const loaded = await loadAuthenticatedGateApproval(dependencies, authority, approval);
    expect(loaded.ok).toBe(true);
    if (!loaded.ok) throw new Error("approval authentication failed");
    expect(await loadAuthenticatedGateApproval(dependencies, authority, {
      ...approval, decision_digest: D("0"),
    })).toMatchObject({
      ok: false,
      error: { code: "STATE_INVALID" },
    });

    const triage = {
      ...base, step: "triage", current_evidence_set_digest: currentEvidence.set_digest,
      source_evidence_digests: [selfSlot.evidence_digest, counterSlot.evidence_digest],
      dispositions: [], accepted_count: 0, rejected_count: 0,
    };
    const adjudication = {
      ...base, step: "adjudicate", pinned_constitution_digest: constitution.digest,
      approved_upstream_digests: [], source_evidence_set_digest: currentEvidence.set_digest,
      rule_findings: [], drift_findings: [], constitution: "pass", drift: "aligned",
      matched_rule_versions: [RULE], uncertain_rule_versions: [],
      assurance: "agent-declared", model_family: "codex", model: "fixture", effort: "high",
    };
    const entry = (artifact_digest: ReturnType<typeof D>, source_artifact: object) =>
      ({ reference: {}, manifest: { artifact_digest, source_artifact } }) as never;
    const retained = new Map([
      ["self_review", entry(selfSlot.evidence_digest, { schema_version: "1", artifact_kind: "review-evidence", evidence: selfEvidence })],
      ["counter_review", entry(counterSlot.evidence_digest, { schema_version: "1", artifact_kind: "review-evidence", evidence: counterEvidence })],
      ["triage", entry(D("a"), { schema_version: "1", artifact_kind: "triage", evidence: triage })],
      ["adjudicate", entry(D("b"), { schema_version: "1", artifact_kind: "adjudication-evidence", evidence: adjudication })],
    ]) as RetainedEvidenceSet;
    expect(deriveCurrentEvidenceSet(retained).current_evidence_set)
      .toEqual(currentEvidence);
    const assessmentState = { ...resolvedState.document.value, step: "adjudicate" as const, status: "succeeded" as const };
    expect(assessCurrentEvidence(assessmentState, retained, {
      subject_digest: D("c"), input_fingerprint: inputFingerprint, constitution,
      authenticated_gate_approvals: [loaded.value],
    }).next).toBe("advance");
    const changedContext = new Map(retained);
    changedContext.set("adjudicate", entry(D("b"), {
      schema_version: "1", artifact_kind: "adjudication-evidence",
      evidence: { ...adjudication, matched_rule_versions: [], uncertain_rule_versions: [RULE] },
    }));
    expect(assessCurrentEvidence(assessmentState, changedContext, {
      subject_digest: D("c"), input_fingerprint: inputFingerprint, constitution,
      authenticated_gate_approvals: [loaded.value],
    }).next).toBe("adjudication-gate");
    const simultaneousObligations = new Map(retained);
    simultaneousObligations.set("adjudicate", entry(D("b"), {
      schema_version: "1", artifact_kind: "adjudication-evidence",
      evidence: {
        ...adjudication,
        rule_findings: [{
          rule_id: RULE.rule_id,
          rule_version: RULE.rule_version,
          compliance: "uncertain",
          rationale: "Needs human resolution",
          trigger: "matched",
          trigger_evidence: "Review rule matched",
          enforced_by: [],
        }],
        drift_findings: [{
          upstream_digest: D("8"),
          drift: "material",
          affected_claim_ids: ["claim-one"],
          rationale: "Upstream changed",
        }],
        constitution: "uncertain",
        drift: "material",
        matched_rule_versions: [RULE],
        uncertain_rule_versions: [RULE],
      },
    }));
    // The authenticated review-trigger approval is exact to that gate and cannot
    // discharge the simultaneous constitution-failure or material obligations.
    expect(assessCurrentEvidence(assessmentState, simultaneousObligations, {
      subject_digest: D("c"), input_fingerprint: inputFingerprint, constitution,
      authenticated_gate_approvals: [loaded.value],
    })).toMatchObject({
      next: "adjudication-gate",
      adjudication_gate_pending: false,
    });
  }, 5_000);
});

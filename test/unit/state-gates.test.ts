import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { canonicalDocument, canonicalJsonDigest, sha256Bytes } from "../../src/contracts/canonical.js";
import { computeGateContextDigest, computeGateId, type InputFingerprintSubject } from "../../src/contracts/fingerprints.js";
import type { TaskStateV1 } from "../../src/contracts/durable-state.js";
import { parsePathSafeId, parseSafeCode, parseSafeInteger, parseSha256Digest, parseTaskSlug } from "../../src/contracts/evidence.js";
import { gateDecisionEffect, type GateContext, type GateEffect, type GateKind } from "../../src/contracts/gates.js";
import { parseRepositoryPathClaim, parseTaskPathClaim } from "../../src/contracts/path-claims.js";
import { currentEvidenceSetRef } from "../../src/contracts/trust.js";
import type { RepositoryOperationContext } from "../../src/repository/git.js";
import { createGitRunner, preflightGit } from "../../src/repository/git.js";
import { discoverWorktree } from "../../src/repository/identity.js";
import { createAtomicWriter } from "../../src/state/atomic.js";
import { createInternalTransactionAuthority } from "../../src/state/authority.js";
import { assessCurrentEvidence } from "../../src/review/fixed-point.js";
import { deriveCurrentEvidenceSet, type RetainedEvidenceSet } from "../../src/state/evidence-results.js";
import { loadAuthenticatedGateApproval, runDurableGate, uniqueMaterialDriftUpstream } from "../../src/state/gates.js";
import { createTaskLock } from "../../src/state/lock.js";
import { readIntentReceipt, readTaskConfig, readTaskState } from "../../src/state/read.js";
import { planStateTransition } from "../../src/state/transitions.js";
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
const counter = { role: "counter-review", evidence_digest: D("8"), assurance: "server-attested", producer_family: "claude", reviewer_family: "codex" } as const;
const state = (): TaskStateV1 => ({ schema_version: "1", task_id: parseTaskSlug("task-1"), repository_identity_digest: D("1"), revision: parseSafeInteger(4), phase_instance: "phase-impl-2" as TaskStateV1["phase_instance"], step: "produce", status: "running", attempt: parseSafeInteger(1), input_fingerprint: D("2"), initialization_digest: D("3"), config_digest: D("4"), workflow_digest: D("5"), constitution_digest: constitution.digest, policy_base_commit: "abcdef0123456789abcdef0123456789abcdef01" as TaskStateV1["policy_base_commit"], authoritative_results: [], approvals: [], waivers: [] });

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
const withoutLastTransition = (value: TaskStateV1): Omit<TaskStateV1, "last_transition"> => {
  const { last_transition: _transition, ...rest } = value;
  return rest;
};

const AUTHORITY = { link_digest: D("9"), purpose: "restore-adoption", proposed_generation_digest: D("a"), changed_input_fingerprint: D("b") } as const;
const EFFECT_CASES = [
  { kind: "artifact-approval", context: { artifact_kind: "phase-implementation" }, allowed: ["approve", "revise", "reject", "cancel"], payload: { decision: "approve", reason: "Reviewed" }, effect: "advance" },
  { kind: "artifact-approval", context: { artifact_kind: "phase-implementation" }, allowed: ["approve", "revise", "reject", "cancel"], payload: { decision: "revise", reason: "Reviewed" }, effect: "retry" },
  { kind: "artifact-approval", context: { artifact_kind: "phase-implementation" }, allowed: ["approve", "revise", "reject", "cancel"], payload: { decision: "reject", reason: "Reviewed" }, effect: "non-advancing" },
  { kind: "constitution-review", context: { constitution: "pass", failed_rules: [], uncertain_rules: [], matched_trigger_rules: [RULE], uncertain_trigger_rules: [], eligible_waivers: [{ rule: RULE, scope: { operation: "review-trigger", boundary: "subject" } }] }, allowed: ["approve", "revise", "reject", "waiver-requested", "cancel"], payload: { decision: "waiver-requested", reason: "Exception", rule: RULE, operation: "review-trigger", rationale: "Reviewed exception" }, effect: "redirect-waiver" },
  { kind: "material-drift", context: { affected_upstream: { kind: "architecture", digest: D("a") }, drift: "material", affected_claim_ids: ["claim-one"] }, allowed: ["amend-upstream", "revise-current", "reject", "cancel"], payload: { decision: "amend-upstream", reason: "Reviewed" }, effect: "redirect-upstream" },
  { kind: "material-drift", context: { affected_upstream: { kind: "architecture", digest: D("a") }, drift: "material", affected_claim_ids: ["claim-one"] }, allowed: ["amend-upstream", "revise-current", "reject", "cancel"], payload: { decision: "revise-current", reason: "Reviewed" }, effect: "retry" },
  { kind: "attempts-exhausted", context: { step: "produce", attempts: 2, maximum_attempts: 2 }, allowed: ["retry-once", "revise", "abort", "cancel"], payload: { decision: "retry-once", reason: "Reviewed" }, effect: "retry" },
  { kind: "attempts-exhausted", context: { step: "produce", attempts: 2, maximum_attempts: 2 }, allowed: ["retry-once", "revise", "abort", "cancel"], payload: { decision: "abort", reason: "Reviewed" }, effect: "non-advancing" },
  { kind: "constitution-edit", context: { pinned_constitution_digest: D("a"), current_constitution_digest: D("b"), changed_path_class: "task-branch-constitution" }, allowed: ["revert-edit", "start-base-amendment", "abort", "cancel"], payload: { decision: "revert-edit", reason: "Reviewed" }, effect: "retry" },
  { kind: "constitution-edit", context: { pinned_constitution_digest: D("a"), current_constitution_digest: D("b"), changed_path_class: "task-branch-constitution" }, allowed: ["revert-edit", "start-base-amendment", "abort", "cancel"], payload: { decision: "start-base-amendment", reason: "Reviewed" }, effect: "redirect-upstream" },
  { kind: "commit-authorization", context: { target_ref: "refs/heads/task", baseline_commit: "1".repeat(40) as never, commit_message: "ArchFlow: Implement task-1 phase 2", paths: ["tracked.txt" as never], diff_digest: D("a"), current_artifact_digests: [D("b")], parent_document_digests: [D("c")] }, allowed: ["authorize-commit", "revise", "abort", "cancel"], payload: { decision: "authorize-commit", reason: "Reviewed" }, effect: "advance" },
  { kind: "restore-collision", context: { path: "task/file.md", recorded_generation_digest: D("a"), current_generation_digest: D("b"), adoption_candidate: AUTHORITY }, allowed: ["discard-and-restore", "adopt-as-new-generation", "abort", "cancel"], payload: { decision: "discard-and-restore", reason: "Reviewed" }, effect: "advance" },
  { kind: "restore-collision", context: { path: "task/file.md", recorded_generation_digest: D("a"), current_generation_digest: D("b"), adoption_candidate: AUTHORITY }, allowed: ["discard-and-restore", "adopt-as-new-generation", "abort", "cancel"], payload: { decision: "adopt-as-new-generation", reason: "Adopt", adoption_authority: AUTHORITY, rationale: "Reviewed local changes" }, effect: "advance" },
  { kind: "migration-audit", context: { source_identity_digest: D("a"), destination_identity_digest: D("b"), import_digest: D("c"), code_baseline_digest: D("d"), policy_baseline_digest: D("e") }, allowed: ["accept-import-audit", "revise", "abort", "cancel"], payload: { decision: "accept-import-audit", reason: "Reviewed" }, effect: "advance" },
] as const satisfies readonly Readonly<{ kind: GateKind; context: object; allowed: readonly string[]; payload: Readonly<{ decision: string } & Record<string, unknown>>; effect: GateEffect }>[];

describe("durable gate decisions", () => {
  it("rejects one affected digest claimed by conflicting producer phases", () => {
    const digest = D("a");
    const subject = (phase: string) => ({
      artifact_digest: digest,
      artifact: { phase_instance: phase },
    }) as never;
    expect(uniqueMaterialDriftUpstream([subject("design"), subject("phase-design-1")], digest)).toBeUndefined();
    expect(uniqueMaterialDriftUpstream([subject("design"), subject("design")], digest)).toBeDefined();
  });

  it("maps every decision-effect arm to its movement outcome", () => {
    expect(new Set(EFFECT_CASES.map(({ payload }) => payload.decision)).size).toBe(14);
    for (const entry of EFFECT_CASES) {
      expect(gateDecisionEffect(entry.payload as never), entry.payload.decision).toBe(entry.effect);
    }
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
    const reviewContext = { constitution: "pass", failed_rules: [], uncertain_rules: [], matched_trigger_rules: [RULE], uncertain_trigger_rules: [], eligible_waivers: [{ rule: RULE, scope: { operation: "review-trigger", boundary: "subject" } }] } as const;
    const base = {
      schema_version: "1", task_id: "task-1", phase_instance: initial.phase_instance,
      subject_digest: D("c"), input_fingerprint: inputFingerprint,
    } as const;
    const review = () => ({
      ...base, step: "counter_review", role: "counter-review",
      rubric_digest: D("d"), producer_family: "claude", findings: [],
      matched_rule_versions: [], verdict: "pass", blocking_count: 0,
      assurance: "server-attested",
      model_family: "codex",
      model: "fixture", effort: "high",
      adapter: "codex-cli",
      cli_version: "fixture-1",
      invocation_id: "fixture-invocation",
      envelope_input_digest: D("e"),
      observed_output_digest: D("f"),
      result_id: "fixture-result",
    });
    const counterEvidence = review();
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
      ["counter_review", reviewEntry(counterSlot.evidence_digest, counterEvidence)],
    ])).current_evidence_set;
    const lifecycle = { authority, expected_revision: initial.revision, intent_id: "intent-1" as never, request_digest: D("b"), input_fingerprint: inputFingerprint, phase_instance: initial.phase_instance, summary: "Approve", subject_digest: D("c"), current_evidence: currentEvidence, kind: "constitution-review" as const, context: reviewContext };
    const lifecycleGate = computeGateId({ task_identity_digest: authority.task_identity_digest, intent_id: lifecycle.intent_id, request_digest: lifecycle.request_digest });
    const aborted = new AbortController(); aborted.abort();
    const first = await runDurableGate(dependencies, { ...lifecycle, signal: aborted.signal });
    expect(first).toMatchObject({ ok: false, error: { code: "CANCELLED" } });
    const pending = await readTaskState(authority.state); expect(pending).toMatchObject({ kind: "canonical", document: { value: { revision: 5, open_gate: { gate_id: lifecycleGate } } } });
    const lifecycleContextDigest = computeGateContextDigest("constitution-review", reviewContext);
    const gateWorkspace = join(authority.workspace_root, "cache", "gates");
    writeFileSync(join(gateWorkspace, "gate.decision"), canonicalDocument({
      schema_version: "1", gate_id: lifecycleGate, task_id: "task-1",
      phase_instance: initial.phase_instance, kind: "constitution-review",
      subject_digest: D("c"), context_digest: lifecycleContextDigest,
      human_provenance: provenance,
      payload: { decision: "approve", reason: "Reviewed" },
    }).bytes);
    const resumed = await runDurableGate(dependencies, { ...lifecycle, signal: new AbortController().signal });
    expect(resumed).toMatchObject({ ok: true, value: { replayed: false, effect: "advance", state: { value: { revision: 6, approvals: [{ gate_id: lifecycleGate }] } } } });
    expect(existsSync(join(taskRoot, "authority", "decisions", lifecycleGate, "decision.json"))).toBe(true);
    expect(existsSync(join(authority.workspace_root, "transient", "intents", "intent-1.json"))).toBe(false);
    expect(existsSync(join(gateWorkspace, "gate.json"))).toBe(false);
    expect(existsSync(join(gateWorkspace, "gate.decision"))).toBe(false);
    expect(readFileSync(join(taskRoot, "state.json"), "utf8")).toContain('"last_transition"');

    const resolvedState = (await readTaskState(authority.state));
    if (resolvedState.kind !== "canonical") throw new Error("resolved state missing");
    const approval = resolvedState.document.value.approvals[0]!;
    const loaded = await loadAuthenticatedGateApproval(dependencies, authority, approval);
    expect(loaded.ok).toBe(true);
    if (!loaded.ok) throw new Error("approval authentication failed");

    // A prior V1 writer included a strictly validated supplemental ledger in every immutable
    // decision. Preserve those exact archive bytes and their digest rather than requiring state
    // surgery after an ArchFlow upgrade.
    const archivedDecisionPath = join(taskRoot, "authority", "decisions", lifecycleGate, "decision.json");
    const archivedDecision = JSON.parse(readFileSync(archivedDecisionPath, "utf8")) as Record<string, unknown>;
    const legacyDecision = canonicalDocument({ ...archivedDecision, supplemental: [] } as never);
    writeFileSync(archivedDecisionPath, legacyDecision.bytes);
    const legacyApproval = { ...approval, decision_digest: legacyDecision.digest };
    writeFileSync(join(taskRoot, "state.json"), canonicalDocument({
      ...resolvedState.document.value,
      approvals: resolvedState.document.value.approvals.map((entry) =>
        entry.gate_id === lifecycleGate ? legacyApproval : entry),
    }).bytes);
    const legacyLoaded = await loadAuthenticatedGateApproval(dependencies, authority, legacyApproval);
    expect(legacyLoaded).toMatchObject({
      ok: true,
      value: { decision: { supplemental: [], outcome: "decided" } },
    });
    expect(await loadAuthenticatedGateApproval(dependencies, authority, {
      ...legacyApproval, decision_digest: D("0"),
    })).toMatchObject({
      ok: false,
      error: { code: "STATE_INVALID" },
    });

    const triage = {
      ...base, step: "triage", current_evidence_set_digest: currentEvidence.set_digest,
      source_evidence_digests: [counterSlot.evidence_digest],
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
      ["counter_review", entry(counterSlot.evidence_digest, { schema_version: "1", artifact_kind: "review-evidence", evidence: counterEvidence })],
      ["triage", entry(D("a"), { schema_version: "1", artifact_kind: "triage", evidence: triage })],
      ["adjudicate", entry(D("b"), { schema_version: "1", artifact_kind: "adjudication-evidence", evidence: adjudication })],
    ]) as RetainedEvidenceSet;
    expect(deriveCurrentEvidenceSet(retained).current_evidence_set)
      .toEqual(currentEvidence);
    const assessmentState = { ...resolvedState.document.value, step: "triage" as const, status: "succeeded" as const };
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

  it("authenticates a migration-audit acceptance as the combined design-phase approval", async () => {
    // The migration-audit gate replaces the separate PRD and design-approval gates for an
    // imported design phase, so its acceptance must satisfy a matched-trigger constitution-review
    // gate too — otherwise status derivation offers a redundant design approval forever and
    // never reaches the import milestone commit.
    const root = realpathSync(mkdtempSync(join(tmpdir(), "archflow-migration-approval-"))); roots.push(root);
    const env = { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_SYSTEM: "/dev/null", GIT_AUTHOR_NAME: "ArchFlow Test", GIT_AUTHOR_EMAIL: "test@example.invalid", GIT_COMMITTER_NAME: "ArchFlow Test", GIT_COMMITTER_EMAIL: "test@example.invalid" };
    execFileSync("git", ["-c", "init.defaultBranch=main", "init", "-q"], { cwd: root, env });
    writeFileSync(join(root, "tracked.txt"), "root\n"); execFileSync("git", ["add", "tracked.txt"], { cwd: root, env }); execFileSync("git", ["commit", "-q", "-m", "root"], { cwd: root, env });
    const taskRoot = join(root, ".archflow", "tasks", "task-1"); mkdirSync(taskRoot, { recursive: true });
    const configBytes = Buffer.from('schema_version: "1"\nroles:\n  counter-reviewer: {model: gpt-example, effort: high}\n  adjudicator: {model: claude-example, effort: high}\n');
    writeFileSync(join(taskRoot, "config.yaml"), configBytes);
    const operation: RepositoryOperationContext = { task_id: parseTaskSlug("task-1"), phase_instance: "design" as never, operation: parseSafeCode("migration-approval"), attempt: parseSafeInteger(1) };
    const runnerResult = await discoverWorktree(createGitRunner({ cwd: root }), operation); if (!runnerResult.ok) throw new Error("discovery failed");
    const git = await preflightGit(runnerResult.value, operation); if (!git.ok) throw new Error("preflight failed");
    const authorityResult = await createInternalTransactionAuthority({ runner: runnerResult.value, environment: git.value, task_id: parseTaskSlug("task-1"), context: operation }); if (!authorityResult.ok) throw new Error("authority failed");
    const authority = authorityResult.value;
    const dependencies = { runner: runnerResult.value, environment: git.value, atomic: createAtomicWriter(), lock: createTaskLock(), read_state: readTaskState, read_config: readTaskConfig, read_receipt: readIntentReceipt, resolve_input_fingerprint: async () => ({ schema_version: "1" as const, ok: true as const, value: {} as InputFingerprintSubject }) };
    const inputFingerprint = D("2");
    const migrationSubject = D("7");
    const evidenceBase = { schema_version: "1" as const, task_id: "task-1", phase_instance: "design", subject_digest: migrationSubject, input_fingerprint: inputFingerprint };
    const designCounter = {
      ...evidenceBase, step: "counter_review", role: "counter-review",
      rubric_digest: D("3"), producer_family: "claude", findings: [],
      matched_rule_versions: [], verdict: "pass", blocking_count: 0,
      assurance: "server-attested", model_family: "codex", model: "fixture", effort: "high",
      adapter: "codex-cli", cli_version: "fixture-1", invocation_id: "fixture-invocation",
      envelope_input_digest: D("4"), observed_output_digest: D("5"), result_id: "fixture-result",
    };
    const designSlot = { ...counter, evidence_digest: canonicalJsonDigest(designCounter) };
    const entry = (artifact_digest: ReturnType<typeof D>, source_artifact: object) =>
      ({ reference: {}, manifest: { artifact_digest, source_artifact } }) as never;
    const designEvidence = deriveCurrentEvidenceSet(new Map([
      ["counter_review", entry(designSlot.evidence_digest, { schema_version: "1", artifact_kind: "review-evidence", evidence: designCounter })],
    ])).current_evidence_set;
    const designTriage = {
      ...evidenceBase, step: "triage", current_evidence_set_digest: designEvidence.set_digest,
      source_evidence_digests: [designSlot.evidence_digest], dispositions: [], accepted_count: 0, rejected_count: 0,
    };
    const designAdjudication = {
      ...evidenceBase, step: "adjudicate", pinned_constitution_digest: constitution.digest,
      approved_upstream_digests: [], source_evidence_set_digest: designEvidence.set_digest,
      rule_findings: [], drift_findings: [], constitution: "pass", drift: "aligned",
      matched_rule_versions: [RULE], uncertain_rule_versions: [],
      assurance: "agent-declared", model_family: "codex", model: "fixture", effort: "high",
    };
    const designRetained = new Map([
      ["counter_review", entry(designSlot.evidence_digest, { schema_version: "1", artifact_kind: "review-evidence", evidence: designCounter })],
      ["triage", entry(D("a"), { schema_version: "1", artifact_kind: "triage", evidence: designTriage })],
      ["adjudicate", entry(D("b"), { schema_version: "1", artifact_kind: "adjudication-evidence", evidence: designAdjudication })],
    ]) as RetainedEvidenceSet;
    const migrationIntent = parsePathSafeId("migration-audit-combined-approval");
    const migrationContext = {
      source_identity_digest: D("1"), destination_identity_digest: D("2"), import_digest: D("3"),
      code_baseline_digest: D("4"), policy_baseline_digest: D("5"),
    } as const;
    const migrationGate = computeGateId({ task_identity_digest: authority.task_identity_digest, intent_id: migrationIntent, request_digest: D("6") });
    const migrationContextDigest = computeGateContextDigest("migration-audit", migrationContext);
    const migrationDecision = canonicalDocument({
      schema_version: "1", gate_id: migrationGate, task_id: "task-1", phase_instance: "design",
      kind: "migration-audit", subject_digest: migrationSubject, context_digest: migrationContextDigest,
      outcome: "decided" as const,
      envelope: {
        schema_version: "1" as const, gate_id: migrationGate, task_id: "task-1", phase_instance: "design",
        kind: "migration-audit" as const, subject_digest: migrationSubject, context_digest: migrationContextDigest,
        human_provenance: provenance,
        payload: { decision: "accept-import-audit" as const, reason: "Reviewed the import" },
      },
    });
    const migrationApprovalRef = {
      gate_id: migrationGate, gate_kind: "migration-audit" as const, subject_digest: migrationSubject,
      decision_digest: migrationDecision.digest, resolved_at_revision: parseSafeInteger(4),
    };
    const migrationArchive = join(taskRoot, "authority", "decisions", migrationGate);
    mkdirSync(migrationArchive, { recursive: true });
    writeFileSync(join(migrationArchive, "request.json"), canonicalDocument({
      schema_version: "1", gate_id: migrationGate, intent_id: migrationIntent, request_digest: D("6"),
      task_id: "task-1", phase_instance: "design", summary: "Audit the imported design",
      subject_digest: migrationSubject, context_digest: migrationContextDigest,
      current_evidence: designEvidence, opened_at_revision: parseSafeInteger(4),
      kind: "migration-audit", context: migrationContext,
      allowed_decisions: ["accept-import-audit", "revise", "abort", "cancel"],
    }).bytes);
    writeFileSync(join(migrationArchive, "decision.json"), migrationDecision.bytes);
    const designState = {
      ...state(), repository_identity_digest: authority.repository_identity_digest,
      config_digest: sha256Bytes(configBytes), input_fingerprint: inputFingerprint,
      phase_instance: "design" as TaskStateV1["phase_instance"], step: "triage" as const, status: "succeeded" as const,
      approvals: [migrationApprovalRef],
    };
    writeFileSync(join(taskRoot, "state.json"), canonicalDocument(designState).bytes);
    const migrationLoaded = await loadAuthenticatedGateApproval(dependencies, authority, migrationApprovalRef);
    expect(migrationLoaded, JSON.stringify(migrationLoaded)).toMatchObject({ ok: true });
    if (!migrationLoaded.ok) throw new Error("migration approval authentication failed");

    expect(assessCurrentEvidence(designState, designRetained, {
      subject_digest: migrationSubject, input_fingerprint: inputFingerprint, constitution,
    }).next).toBe("adjudication-gate");
    expect(assessCurrentEvidence(designState, designRetained, {
      subject_digest: migrationSubject, input_fingerprint: inputFingerprint, constitution,
      authenticated_gate_approvals: [migrationLoaded.value],
    }).next).toBe("advance");
  }, 5_000);

  it("records the retained approved design plan and authenticates final completion", async () => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), "archflow-final-phase-"))); roots.push(root);
    const env = { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_SYSTEM: "/dev/null", GIT_AUTHOR_NAME: "ArchFlow Test", GIT_AUTHOR_EMAIL: "test@example.invalid", GIT_COMMITTER_NAME: "ArchFlow Test", GIT_COMMITTER_EMAIL: "test@example.invalid" };
    execFileSync("git", ["-c", "init.defaultBranch=main", "init", "-q"], { cwd: root, env });
    writeFileSync(join(root, "tracked.txt"), "root\n"); execFileSync("git", ["add", "tracked.txt"], { cwd: root, env }); execFileSync("git", ["commit", "-q", "-m", "root"], { cwd: root, env });
    const taskRoot = join(root, ".archflow", "tasks", "task-1"); mkdirSync(taskRoot, { recursive: true });
    const configBytes = Buffer.from('schema_version: "1"\nroles:\n  counter-reviewer: {model: gpt-example, effort: high}\n  adjudicator: {model: claude-example, effort: high}\n');
    writeFileSync(join(taskRoot, "config.yaml"), configBytes);
    const operation: RepositoryOperationContext = { task_id: parseTaskSlug("task-1"), phase_instance: "design" as never, operation: parseSafeCode("final-phase-test"), attempt: parseSafeInteger(1) };
    const runnerResult = await discoverWorktree(createGitRunner({ cwd: root }), operation); if (!runnerResult.ok) throw new Error("discovery failed");
    const git = await preflightGit(runnerResult.value, operation); if (!git.ok) throw new Error("preflight failed");
    const authorityResult = await createInternalTransactionAuthority({ runner: runnerResult.value, environment: git.value, task_id: parseTaskSlug("task-1"), context: operation }); if (!authorityResult.ok) throw new Error("authority failed");
    const authority = authorityResult.value;
    const inputFingerprint = D("2");
    const evidence = currentEvidenceSetRef([counter]);
    let retained: unknown;
    const dependencies = {
      runner: runnerResult.value, environment: git.value, atomic: createAtomicWriter(), lock: createTaskLock(),
      read_state: readTaskState, read_config: readTaskConfig, read_receipt: readIntentReceipt,
      resolve_input_fingerprint: async () => ({ schema_version: "1" as const, ok: true as const, value: {} as InputFingerprintSubject }),
      resolve_gate_reentry_fingerprint: async () => ({ schema_version: "1" as const, ok: true as const, value: inputFingerprint }),
      load_retained_result: async () => ({ schema_version: "1" as const, ok: true as const, value: retained as never }),
    };
    const resultReference = (resultId: string, phaseInstance: TaskStateV1["phase_instance"], artifactDigest: ReturnType<typeof D>) => ({
      phase_instance: phaseInstance, step: "produce" as const, result_digest: artifactDigest,
      result_id: resultId as never, input_fingerprint: inputFingerprint,
    });
    const installDesign = (markdown: string, resultId: string) => {
      const bytes = new TextEncoder().encode(markdown);
      const contentDigest = sha256Bytes(bytes);
      const artifact = {
        schema_version: "1", artifact_kind: "document", task_id: "task-1", phase_instance: "design", step: "produce",
        document_path: parseTaskPathClaim("design.md"), path_class: "document", byte_count: bytes.byteLength,
        content_digest: contentDigest, declared_inputs: [], input_fingerprint: inputFingerprint,
        snapshot_digest: D("8"), projection_target: parseRepositoryPathClaim(".archflow/tasks/task-1/design.md"),
      } as const;
      const artifactDigest = canonicalJsonDigest(artifact);
      retained = {
        prepared: {
          manifest: canonicalDocument({ artifact_digest: artifactDigest, source_artifact: artifact } as never),
          payloads: [{ path: artifact.projection_target, bytes, target: {} }],
        },
      };
      return resultReference(resultId, "design" as TaskStateV1["phase_instance"], artifactDigest);
    };
    let current: TaskStateV1 = {
      ...state(), repository_identity_digest: authority.repository_identity_digest,
      config_digest: sha256Bytes(configBytes), input_fingerprint: inputFingerprint,
      phase_instance: "design" as TaskStateV1["phase_instance"], step: "triage", status: "succeeded",
      authoritative_results: [installDesign("### Phase 1: One\n### Phase 2: Two\n", "design-1")],
    };
    writeFileSync(join(taskRoot, "state.json"), canonicalDocument(current).bytes);

    let sequence = 0;
    const approve = async <K extends "artifact-approval" | "commit-authorization">(
      kind: K,
      subjectDigest: ReturnType<typeof D>,
      gateContext: GateContext<K>,
      expectedIssue?: string,
    ) => {
      sequence += 1;
      const intentId = `approval-${sequence}` as never;
      const requestDigest = D(sequence.toString(16));
      const base = {
        authority, expected_revision: current.revision, intent_id: intentId, request_digest: requestDigest,
        input_fingerprint: inputFingerprint, phase_instance: current.phase_instance, summary: "Approve retained authority",
        subject_digest: subjectDigest, current_evidence: evidence, kind, context: gateContext,
      } as const;
      const gate = computeGateId({ task_identity_digest: authority.task_identity_digest, intent_id: intentId, request_digest: requestDigest });
      const aborted = new AbortController(); aborted.abort();
      expect(await runDurableGate(dependencies, { ...base, signal: aborted.signal })).toMatchObject({ ok: false, error: { code: "CANCELLED" } });
      const contextDigest = computeGateContextDigest(kind, gateContext as never);
      const gateWorkspace = join(authority.workspace_root, "cache", "gates");
      writeFileSync(join(gateWorkspace, "gate.decision"), canonicalDocument({
        schema_version: "1", gate_id: gate, task_id: "task-1", phase_instance: current.phase_instance,
        kind, subject_digest: subjectDigest, context_digest: contextDigest, human_provenance: {
          ...provenance, decision_event_id: `decision-${sequence}`, helper_invocation_id: `helper-${sequence}`,
        }, payload: kind === "artifact-approval"
          ? { decision: "approve", reason: "Reviewed" }
          : { decision: "authorize-commit", reason: "Reviewed" },
      }).bytes);
      const result = await runDurableGate(dependencies, { ...base, signal: new AbortController().signal });
      if (expectedIssue !== undefined) {
        expect(result).toMatchObject({
          ok: false,
          error: { code: "STATE_INVALID", diagnostic: { parameters: { issue_code: expectedIssue } } },
        });
        await expect(readTaskState(authority.state)).resolves.toMatchObject({
          kind: "canonical",
          document: { value: { planned_final_phase: current.planned_final_phase, open_gate: { gate_id: gate } } },
        });
        const archive = join(taskRoot, "authority", "decisions", gate, "decision.json");
        expect(existsSync(archive)).toBe(false);
        // The rejected approval remains a correctable human interface, not a server-owned archive
        // that requires manual deletion. Exercise the ordinary reject escape path on the same gate.
        writeFileSync(join(gateWorkspace, "gate.decision"), canonicalDocument({
          schema_version: "1", gate_id: gate, task_id: "task-1", phase_instance: current.phase_instance,
          kind, subject_digest: subjectDigest, context_digest: contextDigest, human_provenance: {
            ...provenance, decision_event_id: `decision-${sequence}-revised`, helper_invocation_id: `helper-${sequence}-revised`,
          }, payload: { decision: "reject", reason: "Reject the malformed phase plan" },
        }).bytes);
        const recovered = await runDurableGate(dependencies, { ...base, signal: new AbortController().signal });
        expect(recovered, JSON.stringify(recovered)).toMatchObject({ ok: true, value: { effect: "non-advancing", replayed: false } });
        if (!recovered.ok || !("state" in recovered.value)) throw new Error("corrected gate did not resolve");
        current = recovered.value.state.value;
        expect(existsSync(archive)).toBe(true);
        return;
      }
      expect(result.ok).toBe(true);
      if (!result.ok || !("state" in result.value)) throw new Error("gate did not resolve");
      current = result.value.state.value;
    };

    await approve("artifact-approval", current.authoritative_results[0]!.result_digest, { artifact_kind: "design" });
    expect(current.planned_final_phase).toBe(2);

    const amended = installDesign("### Phase 1: One\n### Phase 2: Two\n### Phase 3: Three\n", "design-2");
    current = { ...withoutLastTransition(current), revision: parseSafeInteger(current.revision + 1), phase_instance: "design" as TaskStateV1["phase_instance"], step: "triage", status: "succeeded", authoritative_results: [amended] };
    writeFileSync(join(taskRoot, "state.json"), canonicalDocument(current).bytes);
    await approve("artifact-approval", amended.result_digest, { artifact_kind: "design" });
    expect(current.planned_final_phase).toBe(3);

    const invalidPlans = [
      ["malformed heading", "## Phase Plan\n### Phase 1:\n"],
      ["alternate dash", "## Phase Plan\n### Phase 1 — One\n"],
      ["table plan", "## Phase Plan\n| Phase | Name |\n|---|---|\n| 1 | One |\n"],
      ["missing plan", "# Design without an implementation phase list\n"],
      ["nonconsecutive headings", "## Phase Plan\n### Phase 1: One\n### Phase 3: Three\n"],
      ["mixed exact and alternate headings", "## Phase Plan\n### Phase 1: One\n### Phase 2 — Two\n"],
      ["mixed exact and fourth-level headings", "## Phase Plan\n### Phase 1: One\n#### Phase 2: Two\n"],
      ["leading whitespace heading", "## Phase Plan\n ### Phase 1: One\n"],
      ["marker plus malformed heading", "<!-- archflow:phase-plan:open-ended -->\n### Phase 1 — One\n"],
      ["marker plus exact heading", "<!-- archflow:phase-plan:open-ended -->\n### Phase 1: One\n"],
    ] as const;
    for (const [name, markdown] of invalidPlans) {
      const invalid = installDesign(markdown, `design-invalid-${name.replaceAll(" ", "-")}`);
      current = { ...withoutLastTransition(current), revision: parseSafeInteger(current.revision + 1), phase_instance: "design" as TaskStateV1["phase_instance"], step: "triage", status: "succeeded", authoritative_results: [invalid] };
      writeFileSync(join(taskRoot, "state.json"), canonicalDocument(current).bytes);
      await approve("artifact-approval", invalid.result_digest, { artifact_kind: "design" }, "approved-design-phase-count-invalid");
      expect(current.planned_final_phase).toBe(3);
    }

    const openEnded = installDesign("# Intentionally open-ended design\n\n<!-- archflow:phase-plan:open-ended -->\n", "design-3");
    current = { ...withoutLastTransition(current), revision: parseSafeInteger(current.revision + 1), phase_instance: "design" as TaskStateV1["phase_instance"], step: "triage", status: "succeeded", authoritative_results: [openEnded] };
    writeFileSync(join(taskRoot, "state.json"), canonicalDocument(current).bytes);
    await approve("artifact-approval", openEnded.result_digest, { artifact_kind: "design" });
    expect(current.planned_final_phase).toBeUndefined();

    const implementationArtifactDigest = D("d");
    const implementationReference = resultReference("implementation-3", "phase-impl-3" as TaskStateV1["phase_instance"], implementationArtifactDigest);
    retained = { prepared: { manifest: canonicalDocument({
      artifact_digest: implementationArtifactDigest,
      source_artifact: { artifact_kind: "implementation-output", diff_digest: D("e"), parent_documents: [{ content_digest: D("f") }] },
    } as never), payloads: [] } };
    current = {
      ...withoutLastTransition(current), revision: parseSafeInteger(current.revision + 1), phase_instance: "phase-impl-3" as TaskStateV1["phase_instance"],
      step: "triage", status: "succeeded", planned_final_phase: parseSafeInteger(3), authoritative_results: [implementationReference],
    };
    writeFileSync(join(taskRoot, "state.json"), canonicalDocument(current).bytes);
    await approve("commit-authorization", implementationArtifactDigest, {
      target_ref: "refs/heads/task", baseline_commit: "1".repeat(40) as never, commit_message: "ArchFlow: Implement task-1 phase 1", paths: ["tracked.txt" as never], diff_digest: D("e"), current_artifact_digests: [implementationArtifactDigest], parent_document_digests: [D("f")],
    });
    const approval = current.approvals.find((entry) => entry.gate_kind === "commit-authorization")!;
    const authenticated = await loadAuthenticatedGateApproval(dependencies, authority, approval);
    expect(authenticated.ok).toBe(true);
    if (!authenticated.ok) return;

    // Commit authorization gained required `baseline_commit`, `commit_message` and `paths` fields
    // after these approvals were archived. The human authority they carry is still real, so the
    // four-key context must keep authenticating rather than wedging the task behind
    // `gate-approval-request-invalid`. Unlike the decision archive, an approval's digests do not
    // cover the request, so rewriting request.json needs no matching state.json surgery.
    const archivedRequestPath = join(taskRoot, "authority", "decisions", approval.gate_id, "request.json");
    const archivedRequest = JSON.parse(readFileSync(archivedRequestPath, "utf8")) as Record<string, unknown>;
    const { baseline_commit: _baseline, commit_message: _message, paths: _paths, ...archivedContext } =
      archivedRequest.context as Record<string, unknown>;
    writeFileSync(archivedRequestPath, canonicalDocument({ ...archivedRequest, context: archivedContext } as never).bytes);
    const archivedLoaded = await loadAuthenticatedGateApproval(dependencies, authority, approval);
    expect(archivedLoaded).toMatchObject({
      ok: true,
      value: { request: { kind: "commit-authorization", context: { target_ref: "refs/heads/task" } } },
    });
    if (!archivedLoaded.ok) throw new Error("archived approval authentication failed");
    expect("paths" in archivedLoaded.value.request.context).toBe(false);

    // Still fail-closed: a request malformed in any other way is rejected, not tolerated.
    const { diff_digest: _diff, ...withoutDiffDigest } = archivedContext;
    writeFileSync(archivedRequestPath, canonicalDocument({
      ...archivedRequest,
      context: withoutDiffDigest,
    } as never).bytes);
    expect(await loadAuthenticatedGateApproval(dependencies, authority, approval)).toMatchObject({
      ok: false,
      error: { code: "STATE_INVALID", diagnostic: { parameters: { issue_code: "gate-approval-request-invalid" } } },
    });
    writeFileSync(archivedRequestPath, canonicalDocument(archivedRequest as never).bytes);
    const completed = planStateTransition({
      current,
      target: { phase_instance: current.phase_instance, step: current.step, status: current.status, attempt: current.attempt, input_fingerprint: current.input_fingerprint },
      recomputed_input_fingerprint: current.input_fingerprint,
      completion_subject_digest: implementationArtifactDigest,
      authenticated_gate_approvals: [authenticated.value],
      commit_observed: true,
    });
    expect(completed).toMatchObject({ ok: true, value: { terminal: "complete" } });
    const nonFinalCurrent = { ...current, planned_final_phase: parseSafeInteger(4) };
    const nonFinalTarget = {
      phase_instance: "phase-design-4" as TaskStateV1["phase_instance"], step: "produce" as const,
      status: "running" as const, attempt: parseSafeInteger(1), input_fingerprint: current.input_fingerprint,
    };
    expect(planStateTransition({
      current: nonFinalCurrent,
      target: nonFinalTarget,
      recomputed_input_fingerprint: current.input_fingerprint,
      completion_subject_digest: implementationArtifactDigest,
      authenticated_gate_approvals: [authenticated.value],
    })).toMatchObject({ ok: false, error: { code: "TRANSITION_INVALID" } });
    expect(planStateTransition({
      current: nonFinalCurrent,
      target: nonFinalTarget,
      recomputed_input_fingerprint: current.input_fingerprint,
      completion_subject_digest: implementationArtifactDigest,
      authenticated_gate_approvals: [authenticated.value],
      commit_observed: true,
    })).toMatchObject({ ok: true, value: { phase_instance: "phase-design-4" } });
    const { planned_final_phase: _plannedFinalPhase, ...openEndedState } = current;
    const openEndedCompletion = planStateTransition({
      current: openEndedState,
      target: { phase_instance: current.phase_instance, step: current.step, status: current.status, attempt: current.attempt, input_fingerprint: current.input_fingerprint },
      recomputed_input_fingerprint: current.input_fingerprint,
      completion_subject_digest: implementationArtifactDigest,
      authenticated_gate_approvals: [authenticated.value],
      commit_observed: true,
    });
    expect(openEndedCompletion).toMatchObject({ ok: false, error: { code: "TRANSITION_INVALID" } });
    expect(() => planStateTransition({
      current,
      target: { phase_instance: current.phase_instance, step: current.step, status: current.status, attempt: current.attempt, input_fingerprint: current.input_fingerprint },
      recomputed_input_fingerprint: current.input_fingerprint,
      completion_subject_digest: implementationArtifactDigest,
      authenticated_gate_approvals: [{ approval: authenticated.value.approval, request: authenticated.value.request, decision: authenticated.value.decision } as never],
      commit_observed: true,
    })).toThrow(/authenticated gate approval/u);
  }, 10_000);
});

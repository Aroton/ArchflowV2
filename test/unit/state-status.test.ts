import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { canonicalDocument, canonicalJsonDigest, parseGitOid, sha256Bytes } from "../../src/contracts/canonical.js";
import { parseConfigYaml, type TaskConfigSnapshot } from "../../src/contracts/config.js";
import { parseActiveGate, parseArchivedGateRequest } from "../../src/contracts/durable-gate.js";
import type { DocumentArtifactV1 } from "../../src/contracts/durable-document.js";
import type { ImplementationOutputV1 } from "../../src/contracts/durable-implementation-output.js";
import type { RuleSettlementV1, TaskStateV1 } from "../../src/contracts/durable-state.js";
import { parsePathSafeId, parseSafeCode, parseSafeInteger, parseSha256Digest, parseTaskSlug } from "../../src/contracts/evidence.js";
import { computeGateContextDigest } from "../../src/contracts/fingerprints.js";
import { parseRepositoryPathClaim, parseTaskPathClaim } from "../../src/contracts/path-claims.js";
import { encodePhaseInstance } from "../../src/contracts/phase-instance.js";
import { resolvePinnedConstitution } from "../../src/state/constitution.js";
import { createProductionServices } from "../../src/state/production.js";
import {
  buildAutonomousDesignCommitInput,
  buildAutonomousImplementationCommitInput,
  buildCommitAuthorizationInput,
  buildDesignApprovalInput,
  baselinePresentedTargetsOnCurrentFirstParent,
  computeTaskStatus,
  contentTriggerDetails,
  currentApprovedUpstreams,
  partitionExpectedReentryEdits,
  resolveStatusEvidenceAssessment,
} from "../../src/state/status.js";
import type { ReconciliationFinding } from "../../src/state/reconciliation.js";
import type { CurrentProduceSubject } from "../../src/state/produce-subject.js";
import type { RetainedEvidenceSet } from "../../src/state/evidence-results.js";

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
const TASK = parseTaskSlug("status-task");
const PHASE = "phase-impl-17" as TaskStateV1["phase_instance"];
const D = (value: string) => parseSha256Digest(value.repeat(64));
const gitEnv = {
  ...process.env,
  GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_SYSTEM: "/dev/null",
  GIT_AUTHOR_NAME: "ArchFlow Test", GIT_AUTHOR_EMAIL: "test@example.invalid",
  GIT_COMMITTER_NAME: "ArchFlow Test", GIT_COMMITTER_EMAIL: "test@example.invalid",
};
const configText = `schema_version: "1"
roles:
  counter-reviewer: { model: claude-opus-4-6, effort: high }
  adjudicator: { model: claude-opus-4-6, effort: high }
overrides:
  phase-impl:
    counter-reviewer: { model: gpt-5.4, effort: high }
`;

async function harness() {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "archflow-status-")));
  roots.push(root);
  execFileSync("git", ["-c", "init.defaultBranch=main", "init", "-q"], { cwd: root, env: gitEnv });
  mkdirSync(join(root, ".archflow", "constitution"), { recursive: true });
  writeFileSync(join(root, ".archflow", "constitution", "01-trust.md"),
    "---\nid: trust\nversion: 1\nstatus: active\n---\nPinned rule text.\n");
  writeFileSync(join(root, "tracked.txt"), "root\n");
  execFileSync("git", ["add", "--", ".archflow/constitution/01-trust.md", "tracked.txt"], { cwd: root, env: gitEnv });
  execFileSync("git", ["commit", "-q", "-m", "root"], { cwd: root, env: gitEnv });
  mkdirSync(join(root, ".archflow", "tasks", TASK, "intents"), { recursive: true });
  writeFileSync(join(root, ".archflow", "tasks", TASK, "config.yaml"), configText);
  const created = await createProductionServices({
    working_directory: root, task_id: TASK, operation: parseSafeCode("status-test"), phase_instance: PHASE,
  });
  if (!created.ok) throw new Error(created.error.code);
  const head = execFileSync("git", ["rev-parse", "HEAD"], { cwd: root, env: gitEnv, encoding: "utf8" }).trim() as TaskStateV1["policy_base_commit"];
  const constitution = await resolvePinnedConstitution(created.value.runner, head, created.value.authority.context);
  if (!constitution.ok) throw new Error(constitution.error.code);
  const state = (extra: Partial<TaskStateV1> = {}): TaskStateV1 => ({
    schema_version: "1", task_id: TASK,
    repository_identity_digest: created.value.authority.repository_identity_digest,
    revision: parseSafeInteger(4), phase_instance: PHASE, step: "produce", status: "running",
    attempt: parseSafeInteger(1), input_fingerprint: D("2"), initialization_digest: D("3"),
    config_digest: sha256Bytes(Buffer.from(configText)), workflow_digest: D("5"),
    constitution_digest: constitution.value.digest, policy_base_commit: head,
    authoritative_results: [], approvals: [], waivers: [], ...extra,
  });
  return { root, services: created.value, state };
}

const blob = (size: number) => ({
  oid: parseGitOid("1".repeat(40)), mode: "100644" as const, size_bytes: parseSafeInteger(size),
});

const implementationWith = (
  outputs: ImplementationOutputV1["outputs"],
): ImplementationOutputV1 => ({ outputs } as unknown as ImplementationOutputV1);

const settlementWith = (
  conclusion: RuleSettlementV1["conclusion"],
): RuleSettlementV1 => ({ conclusion } as unknown as RuleSettlementV1);

describe("baseline adoption repository continuity", () => {
  it("keeps a secondary-only current gate resolvable without a primary target head", async () => {
    const secondaryHead = parseGitOid("a".repeat(40));
    const context = {
      drifted_projections: [],
      secondary_targets: [{
        repository: "apis", repository_identity_digest: D("b"),
        target_ref: "refs/heads/main", target_head: secondaryHead,
        drifted_projections: [{ path: parseRepositoryPathClaim("src/a.ts"), recorded_digest: D("c"), observed_digest: D("d") }],
        deleted_projections: [], uncommitted_paths: [],
      }],
    } as never;
    const live = {
      target_ref: "refs/heads/main", target_head: parseGitOid("e".repeat(40)), uncommitted_paths: [],
      secondary_targets: [{
        repository: "apis", repository_identity_digest: D("b"),
        target_ref: "refs/heads/main", target_head: secondaryHead, uncommitted_paths: [],
      }],
    } as never;
    const repositorySet = { members: [
      { name: "primary", mode: "writable", binding: { runner: {} } },
      { name: "apis", mode: "writable", binding: { runner: {} } },
    ] } as never;
    await expect(baselinePresentedTargetsOnCurrentFirstParent(
      { runner: {} as never }, context, live, repositorySet,
    )).resolves.toBe(true);
  });
});

describe("contentTriggerDetails", () => {
  it("formats every operation with exact endpoint sizes and an explicit signed delta", () => {
    const output = implementationWith([
      { operation: "add", path: parseRepositoryPathClaim("a-added.sql"), path_class: "repository-source", storage: "git-object", file_type: "regular", after: blob(12) },
      { operation: "delete", path: parseRepositoryPathClaim("b-deleted.sql"), path_class: "repository-source", storage: "git-object", file_type: "regular", before: blob(9) },
      { operation: "modify", path: parseRepositoryPathClaim("c-modified.sql"), path_class: "repository-source", storage: "git-object", file_type: "regular", before: blob(7), after: blob(7) },
      { operation: "rename", path: parseRepositoryPathClaim("e-new.sql"), previous_path: parseRepositoryPathClaim("d-old.sql"), path_class: "repository-source", storage: "git-object", file_type: "regular", before: blob(4), after: blob(10) },
    ]);
    const settlement = settlementWith({
      wait: true,
      match: { kind: "content", paths: ["a-added.sql", "b-deleted.sql", "c-modified.sql", "d-old.sql", "e-new.sql"] },
    });

    expect(contentTriggerDetails(settlement, output)).toEqual([
      "a-added.sql: added (0 → 12 bytes (+12 bytes))",
      "b-deleted.sql: deleted (9 → 0 bytes (-9 bytes))",
      "c-modified.sql: modified (7 → 7 bytes (+0 bytes))",
      "d-old.sql: renamed to e-new.sql (4 → 10 bytes (+6 bytes))",
      "e-new.sql: renamed from d-old.sql (4 → 10 bytes (+6 bytes))",
    ]);
  });

  it("keeps settlement order and emits rename sources before every current-path endpoint", () => {
    const output = implementationWith([
      { operation: "rename", path: parseRepositoryPathClaim("z-new.sql"), previous_path: parseRepositoryPathClaim("old.sql"), path_class: "repository-source", storage: "git-object", file_type: "regular", before: blob(2), after: blob(3) },
      { operation: "add", path: parseRepositoryPathClaim("old.sql"), path_class: "repository-source", storage: "git-object", file_type: "regular", after: blob(8) },
      { operation: "rename", path: parseRepositoryPathClaim("a-new.sql"), previous_path: parseRepositoryPathClaim("old.sql"), path_class: "repository-source", storage: "git-object", file_type: "regular", before: blob(5), after: blob(4) },
    ]);
    const settlement = settlementWith({
      wait: true,
      match: { kind: "content", paths: ["old.sql", "z-new.sql"] },
    });

    expect(contentTriggerDetails(settlement, output)).toEqual([
      "old.sql: renamed to a-new.sql (5 → 4 bytes (-1 bytes))",
      "old.sql: renamed to z-new.sql (2 → 3 bytes (+1 bytes))",
      "old.sql: added (0 → 8 bytes (+8 bytes))",
      "z-new.sql: renamed from old.sql (2 → 3 bytes (+1 bytes))",
    ]);
  });

  it.each([
    ["a secondary-only content gate", {
      outputs: [],
      paths: [],
      secondary: {
        repository: "api",
        outputs: [
          { operation: "add", path: parseRepositoryPathClaim("db/a.sql"), path_class: "repository-source", storage: "git-object", file_type: "regular", after: blob(13) },
          { operation: "rename", path: parseRepositoryPathClaim("db/new.sql"), previous_path: parseRepositoryPathClaim("db/old.sql"), path_class: "repository-source", storage: "git-object", file_type: "regular", before: blob(5), after: blob(8) },
        ],
        paths: ["db/a.sql", "db/old.sql"],
      },
      expected: [
        "api/db/a.sql: added (0 → 13 bytes (+13 bytes))",
        "api/db/old.sql: renamed to api/db/new.sql (5 → 8 bytes (+3 bytes))",
      ],
    }],
    ["a mixed primary and secondary content gate", {
      outputs: [
        { operation: "modify", path: parseRepositoryPathClaim("db/main.sql"), path_class: "repository-source", storage: "git-object", file_type: "regular", before: blob(4), after: blob(9) },
      ],
      paths: ["db/main.sql"],
      secondary: {
        repository: "worker",
        outputs: [
          { operation: "delete", path: parseRepositoryPathClaim("db/job.sql"), path_class: "repository-source", storage: "git-object", file_type: "regular", before: blob(7) },
        ],
        paths: ["db/job.sql"],
      },
      expected: [
        "db/main.sql: modified (4 → 9 bytes (+5 bytes))",
        "worker/db/job.sql: deleted (7 → 0 bytes (-7 bytes))",
      ],
    }],
  ])("renders primary then repository-qualified retained operations for %s", (_label, scenario) => {
    const output = {
      outputs: scenario.outputs,
      secondary_repositories: [{ repository: scenario.secondary.repository, outputs: scenario.secondary.outputs }],
    } as unknown as ImplementationOutputV1;
    const settlement = settlementWith({
      wait: true,
      match: {
        kind: "content",
        paths: scenario.paths,
        secondary_paths: [{ repository: scenario.secondary.repository, paths: scenario.secondary.paths }],
      },
    });

    expect(contentTriggerDetails(settlement, output)).toEqual(scenario.expected);
  });

  it("returns no details without an eligible content match", () => {
    const output = implementationWith([
      { operation: "add", path: parseRepositoryPathClaim("change.ts"), path_class: "repository-source", storage: "git-object", file_type: "regular", after: blob(1) },
    ]);
    expect(contentTriggerDetails(undefined, output)).toBeUndefined();
    expect(contentTriggerDetails(settlementWith({ wait: false, match: null }), output)).toBeUndefined();
    expect(contentTriggerDetails(settlementWith({ wait: true, match: { kind: "subject", subject: "phase-impl" } }), output)).toBeUndefined();
  });

  it("fails the complete join when any persisted match has no retained endpoint", () => {
    const output = implementationWith([
      { operation: "add", path: parseRepositoryPathClaim("matched.sql"), path_class: "repository-source", storage: "git-object", file_type: "regular", after: blob(1) },
    ]);
    const settlement = settlementWith({
      wait: true,
      match: { kind: "content", paths: ["matched.sql", "missing.sql"] },
    });

    expect(() => contentTriggerDetails(settlement, output))
      .toThrow("content-trigger path has no retained implementation endpoint: missing.sql");
  });
});

describe("partitionExpectedReentryEdits", () => {
  it("treats produce-projection drift as expected while a produce re-entry is recorded", () => {
    const path = `.archflow/tasks/${TASK}/prd.md`;
    const finding = {
      kind: "projection-mismatch", path, recorded_digest: D("a"),
      next_action: "restore-or-record-new-transition",
    } as unknown as ReconciliationFinding;
    const subject = {
      retained: { manifest: { value: { projections: [{ path }] } } },
    } as unknown as CurrentProduceSubject;
    // No fixed-point authorization: the durable produce running entry alone is the declared
    // intent that authorizes rewriting the produce projection (the new-information door).
    const during = partitionExpectedReentryEdits([finding], undefined, subject, { step: "produce", status: "running" });
    expect(during.remaining).toEqual([]);
    expect(during.expected_reentry_edits).toEqual([path]);
    // The same drift outside any produce re-entry keeps blocking exactly as before.
    const outside = partitionExpectedReentryEdits([finding], undefined, subject, { step: "counter_review", status: "succeeded" });
    expect(outside.remaining).toEqual([finding]);
    expect(outside.expected_reentry_edits).toEqual([]);
  });

  it("treats historical projection drift as active initial-production work", () => {
    const historical = {
      kind: "projection-mismatch", path: "src/shared.ts", recorded_digest: D("a"),
      next_action: "restore-or-record-new-transition",
    } as unknown as ReconciliationFinding;
    const receipt = {
      kind: "receipt-only", request_digest: D("b"), receipt_digest: D("c"),
      next_action: "resume-exact-intent",
    } as unknown as ReconciliationFinding;

    const during = partitionExpectedReentryEdits(
      [historical, receipt], undefined, undefined, { step: "produce", status: "running" },
    );

    expect(during.remaining).toEqual([receipt]);
    expect(during.expected_reentry_edits).toEqual(["src/shared.ts"]);
  });

  it("keeps historical projection drift blocking before and after produce", () => {
    const finding = {
      kind: "projection-mismatch", path: "src/shared.ts", recorded_digest: D("a"),
      next_action: "restore-or-record-new-transition",
    } as unknown as ReconciliationFinding;

    for (const state of [
      { step: "triage", status: "succeeded" },
      { step: "produce", status: "succeeded" },
      { step: "counter_review", status: "running" },
    ] as const) {
      const result = partitionExpectedReentryEdits([finding], undefined, undefined, state);
      expect(result.remaining, `${state.step}:${state.status}`).toEqual([finding]);
      expect(result.expected_reentry_edits, `${state.step}:${state.status}`).toEqual([]);
    }
  });
});

describe("computeTaskStatus", () => {
  it("distinguishes unavailable upstream approval authority from fixed-point disagreement", async () => {
    const upstreamFailure = await resolveStatusEvidenceAssessment(
      async () => { throw new TypeError("upstream approval is unavailable"); },
      () => { throw new Error("must not assess without upstream authority"); },
    );
    expect(upstreamFailure).toEqual({ blocking_reason: "approved-upstream-authority-unavailable" });

    const fixedPointFailure = await resolveStatusEvidenceAssessment(
      async () => [D("a")],
      () => { throw new TypeError("evidence bindings disagree"); },
    );
    expect(fixedPointFailure).toEqual({ blocking_reason: "fixed-point-disagreement" });
  });

  it("does not accept a rule settlement as upstream authority when no approval authenticates", async () => {
    const h = await harness();
    const prdPhase = encodePhaseInstance({ kind: "prd" });
    const prdArtifact: DocumentArtifactV1 = {
      schema_version: "1", artifact_kind: "document", task_id: TASK,
      phase_instance: prdPhase, step: "produce",
      document_path: parseTaskPathClaim("prd.md"), path_class: "document",
      byte_count: parseSafeInteger(2), content_digest: D("6"),
      declared_inputs: [], input_fingerprint: D("2"),
      snapshot_digest: D("6"), projection_target: parseRepositoryPathClaim(`.archflow/tasks/${TASK}/prd.md`),
    };
    const upstreamDigest = canonicalJsonDigest(prdArtifact);
    const retained = {
      manifest: { value: {
        artifact_digest: upstreamDigest, source_artifact: prdArtifact,
        accounting: { measured_at_revision: parseSafeInteger(2) },
      } },
    };
    const dependencies = {
      load_retained_manifest: async () => Object.freeze({ schema_version: "1" as const, ok: true, value: retained }),
    } as unknown as Parameters<typeof currentApprovedUpstreams>[0];
    // The state names a candidate approval, but no archived decision authenticates it.
    const approvalEntry = {
      gate_id: parsePathSafeId("gate-1"), gate_kind: "artifact-approval" as const,
      subject_digest: upstreamDigest, decision_digest: D("d"), resolved_at_revision: parseSafeInteger(3),
    };
    const reference = {
      phase_instance: prdPhase, step: "produce" as const, result_digest: D("9"),
      result_id: "prd-result" as never, input_fingerprint: D("2"),
    };
    const receipt = {
      task_id: TASK, phase_instance: prdPhase, step: "adjudicate" as const,
      subject_digest: upstreamDigest, conclusion: { wait: false, match: null } as const,
      config_digest: D("7"), settled_at_revision: parseSafeInteger(3),
    };
    const withUpstream = (ruleAdvances: readonly [typeof receipt]): TaskStateV1 => h.state({
      phase_instance: encodePhaseInstance({ kind: "design" }),
      authoritative_results: [reference],
      approvals: [approvalEntry],
      rule_settlements: ruleAdvances,
    });

    // The exact digest-bound settlement remains evidence only.
    await expect(currentApprovedUpstreams(dependencies, h.services.authority, withUpstream([receipt]), [], undefined))
      .rejects.toThrow("current upstream produced authority lacks approval");
    // A settlement for different bytes fails closed as well.
    await expect(currentApprovedUpstreams(
      dependencies, h.services.authority, withUpstream([{ ...receipt, subject_digest: D("e") }]), [], undefined,
    )).rejects.toThrow("current upstream produced authority lacks approval");
  });

  it("materializes sorted retained commit-authorization resume facts without a rubric digest", () => {
    const evidence = {
      set_digest: D("8"),
      slots: [
        { role: "counter-review", evidence_digest: D("a"), assurance: "server-attested", producer_family: "claude", reviewer_family: "codex" },
      ],
    } as const;
    const subject = {
      artifact_digest: D("b"),
      artifact: {
        artifact_kind: "implementation-output",
        task_id: TASK,
        phase_instance: PHASE,
        diff_digest: D("c"),
        outputs: [
          { operation: "delete", path: "removed.txt" },
          { operation: "rename", path: "renamed.txt", previous_path: "old-name.txt" },
        ],
        parent_documents: [
          { content_digest: D("f") },
          { content_digest: D("d") },
        ],
      },
      retained: { manifest: { value: { artifact_digest: D("b") } } },
    } as unknown as CurrentProduceSubject;
    const input = buildCommitAuthorizationInput(subject, evidence, {
      value: "refs/heads/feature", guidance: "Current symbolic branch ref observed from repository authority.",
    }, "1".repeat(40));
    expect(input).toEqual({
      kind: "commit-authorization", subject_digest: D("b"), current_evidence: evidence,
      context: {
        target_ref: "refs/heads/feature", baseline_commit: "1".repeat(40),
        commit_message: "ArchFlow: Implement status-task phase 17",
        paths: ["old-name.txt", "removed.txt", "renamed.txt"], diff_digest: D("c"),
        current_artifact_digests: [D("b")], parent_document_digests: [D("d"), D("f")],
      },
      target_ref_guidance: "Current symbolic branch ref observed from repository authority.",
    });
    expect(input).not.toHaveProperty("rubric_digest");
  });

  it("derives autonomous implementation commit facts only from retained output authority", () => {
    const output = {
      task_id: TASK,
      phase_instance: PHASE,
      base_commit: parseGitOid("a".repeat(40)),
      outputs: [
        { operation: "delete", path: parseRepositoryPathClaim("z.ts") },
        { operation: "rename", path: parseRepositoryPathClaim("b.ts"), previous_path: parseRepositoryPathClaim("a.ts") },
      ],
    } as unknown as ImplementationOutputV1;
    expect(buildAutonomousImplementationCommitInput(output, "refs/heads/feature")).toEqual({
      paths: ["a.ts", "b.ts", "z.ts"],
      message: "ArchFlow: Implement status-task phase 17",
      target_ref: "refs/heads/feature",
      baseline_commit: "a".repeat(40),
    });
  });

  it("binds autonomous design commit facts to the settlement producer phase and baseline", async () => {
    const h = await harness();
    const phase = encodePhaseInstance({ kind: "phase-design", phase: 5 as never });
    const current = h.state({ phase_instance: phase });
    const settlement = {
      task_id: TASK,
      phase_instance: phase,
      step: "triage",
      subject_digest: D("8"),
      conclusion: { wait: false, match: null },
      config_digest: D("9"),
      settled_at_revision: parseSafeInteger(4),
      milestone_baseline_commit: parseGitOid("b".repeat(40)),
    } as RuleSettlementV1;
    expect(buildAutonomousDesignCommitInput(current, settlement, "refs/heads/feature")).toEqual({
      path: `.archflow/tasks/${TASK}`,
      message: "ArchFlow: Approve status-task phase 5 design",
      target_ref: "refs/heads/feature",
      baseline_commit: "b".repeat(40),
    });
    expect(() => buildAutonomousDesignCommitInput(
      h.state({ phase_instance: encodePhaseInstance({ kind: "design" }) }),
      settlement,
      "refs/heads/feature",
    )).toThrow(/phase-bound milestone baseline/u);
  });

  it("unwraps retained adjudication evidence when presenting design approval", async () => {
    const evidence = {
      schema_version: "1", task_id: TASK, phase_instance: "phase-design-2", step: "adjudicate",
      subject_digest: D("1"), input_fingerprint: D("2"), pinned_constitution_digest: D("3"),
      approved_upstream_digests: [], source_review_envelope_digest: D("4"),
      rule_findings: [], drift_findings: [], constitution: "pass", drift: "aligned",
      matched_rule_versions: [], uncertain_rule_versions: [], assurance: "agent-declared",
      model_family: "unknown", model: "fixture", effort: "unknown",
    } as const;
    const retained = new Map([["adjudicate", {
      manifest: { source_artifact: {
        schema_version: "1", artifact_kind: "adjudication-evidence", evidence,
      } },
    }]]) as unknown as RetainedEvidenceSet;
    const dependencies = {
      runner: { runText: async () => "a".repeat(40) },
    } as unknown as Parameters<typeof buildDesignApprovalInput>[0];
    const state = {
      task_id: TASK, phase_instance: "phase-design-2",
    } as unknown as TaskStateV1;

    const input = await buildDesignApprovalInput(dependencies, state, retained, {
      value: "refs/heads/feature", guidance: "Current target.",
    });

    expect(input.context).toMatchObject({ constitution: "pass", policy_findings: [] });
  });

  it("reports missing state through the normal result contract", async () => {
    const h = await harness();
    const status = await computeTaskStatus(h.services.dependencies, h.services.authority);
    expect(status).toMatchObject({ ok: true, value: { state: "missing", next_action: { code: "create-task" } } });
  });

  it("uses override-aware dispatched routes and commit-pinned rules", async () => {
    const h = await harness();
    writeFileSync(h.services.authority.state.absolute, canonicalDocument(h.state()).bytes);
    writeFileSync(join(h.root, ".archflow", "constitution", "01-trust.md"),
      "---\nid: trust\nversion: 2\nstatus: active\n---\nUncommitted replacement.\n");
    const status = await computeTaskStatus(h.services.dependencies, h.services.authority);
    expect(status).toMatchObject({
      ok: true,
      value: {
        config: { verified: true },
        routes: {
          counter_reviewer: { family: "codex", model: "gpt-5.4" },
          adjudicator: { family: "claude", model: "claude-opus-4-6" },
        },
        constitution: { active_rules: [{ id: "trust", version: 1, text: "Pinned rule text." }] },
        resources: [
          { role: "current-artifact", path: `.archflow/tasks/${TASK}/phases/17/impl-notes.md`, access: "write" },
          { role: "prd", path: `.archflow/tasks/${TASK}/prd.md`, access: "read-write" },
          { role: "task-design", path: `.archflow/tasks/${TASK}/design.md`, access: "read-write" },
          { role: "phase-design", path: `.archflow/tasks/${TASK}/phases/17/design.md`, access: "read-write" },
          { role: "prior-implementation-notes", path: `.archflow/tasks/${TASK}/phases/16/impl-notes.md`, access: "read" },
          { role: "verification-transcript", path: `.archflow/runtime/tasks/${TASK}/cache/phases/17/verification.txt`, access: "write" },
        ],
      },
    });
    if (status.ok) expect(status.value).not.toHaveProperty("rubric_digest");
    if (!status.ok) return;
    expect(status.value.review_policy).toMatchObject({
      rubric_id: "implementation-v1",
      rubric: { schema_version: "1", kind: "implementation", mode: "adversarial" },
    });
    expect(status.value.review_policy?.rubric_digest)
      .toBe(canonicalJsonDigest(status.value.review_policy!.rubric as never));
    // The harness state is produce-running with no authoritative produce result: the derived
    // action must name the terminal record — never the repeat running entry the server rejects.
    // Mid-produce there is no subject yet, so subject_digest is correctly absent rather than
    // stale.
    expect(status.value.next_action).toMatchObject({
      code: "run-step", step: "produce",
      detail: "Record the terminal produce result.",
    });
    expect(status.value).not.toHaveProperty("subject_digest");
    expect(status.value.workspace).toMatchObject({ cleanup_pending: false });
  });

  it("reports cleanup debt as non-blocking derived workspace state", async () => {
    const h = await harness();
    writeFileSync(h.services.authority.state.absolute, canonicalDocument(h.state()).bytes);
    const stale = join(h.root, ".archflow", "runtime", "tasks", TASK, "cache", "reviews", "old.md");
    mkdirSync(join(stale, ".."), { recursive: true });
    writeFileSync(stale, "reconstructible review\n");
    const status = await computeTaskStatus(h.services.dependencies, h.services.authority);
    expect(status).toMatchObject({
      ok: true,
      value: { workspace: { cleanup_pending: true, removed_files: 0, removed_bytes: 0 } },
    });
    if (status.ok) expect(status.value.blocking_reasons).not.toContain("workspace.cleanup_pending");
  });

  it("reports exact approval load errors in full status with an aggregate blocker", async () => {
    const h = await harness();
    const gateId = parsePathSafeId("missing-approval-archive");
    writeFileSync(h.services.authority.state.absolute, canonicalDocument(h.state({
      approvals: [{
        gate_id: gateId,
        gate_kind: "artifact-approval",
        subject_digest: D("6"),
        decision_digest: D("7"),
        resolved_at_revision: parseSafeInteger(3),
      }],
    })).bytes);

    const status = await computeTaskStatus(h.services.dependencies, h.services.authority);
    expect(status).toMatchObject({
      ok: true,
      value: {
        blocking_reasons: expect.arrayContaining(["approval-authority-unavailable"]),
        approval_issues: [{
          gate_id: gateId,
          gate_kind: "artifact-approval",
          error: {
            code: "STATE_INVALID",
            diagnostic: { parameters: { issue_code: "gate-approval-request-unavailable" } },
            next_action: "inspect-current-state",
          },
        }],
      },
    });
    if (!status.ok) return;
    expect(status.value.blocking_reasons).not.toContain(`approval-${gateId}-unavailable`);
  });

  it("degrades a missing gate archive disagreement without throwing, even over an edited config", async () => {
    const h = await harness();
    const context = { artifact_kind: "phase-implementation" } as const;
    const active = parseActiveGate({
      schema_version: "1", gate_id: "gate-status", intent_id: "gate-intent", request_digest: D("7"),
      task_id: TASK, phase_instance: PHASE, summary: "Approve", subject_digest: D("8"),
      context_digest: computeGateContextDigest("artifact-approval", context as never),
      current_evidence: { set_digest: D("9"), slots: [
        { role: "counter-review", evidence_digest: D("b"), assurance: "server-attested", producer_family: "claude", reviewer_family: "codex" },
      ] },
      kind: "artifact-approval", context, allowed_decisions: ["approve", "revise", "reject", "cancel"],
      opened_at_revision: 4, status: "awaiting-human",
      decision_template: {
        schema_version: "1", gate_id: "gate-status", task_id: TASK, phase_instance: PHASE,
        kind: "artifact-approval", subject_digest: D("8"), context_digest: computeGateContextDigest("artifact-approval", context as never),
        required_fields: ["payload", "human_provenance"], cancellation_fields: ["cancelled", "reason", "human_provenance"],
      },
    });
    writeFileSync(h.services.authority.state.absolute, canonicalDocument(h.state({
      open_gate: {
        gate_id: active.gate_id, gate_kind: active.kind, subject_digest: active.subject_digest,
        context_digest: active.context_digest, frozen_state_digest: D("c"), opened_at_revision: parseSafeInteger(4),
      },
    })).bytes);
    const activePath = join(h.root, ".archflow", "runtime", "tasks", TASK, "cache", "gates", "gate.json");
    mkdirSync(join(activePath, ".."), { recursive: true });
    writeFileSync(activePath, canonicalDocument(active).bytes);
    writeFileSync(h.services.authority.config.absolute, `${configText}max_attempts: 4\n`);
    const status = await computeTaskStatus(h.services.dependencies, h.services.authority);
    expect(status).toMatchObject({
      ok: true,
      value: {
        config: { verified: true },
        next_action: { code: "resolve-current-authority" },
      },
    });
    if (status.ok) {
      expect(status.value.blocking_reasons).toContain("active-gate-request-missing");
      expect(status.value).not.toHaveProperty("open_gate");
      // This task predates the change notice: with no recorded last_seen_config, an edit is
      // verified and unnoted — the next transaction silently establishes the baseline.
      expect(status.value).not.toHaveProperty("config_change");
    }
    const gateBlocked = await computeTaskStatus(h.services.dependencies, h.services.authority);
    expect(gateBlocked).toMatchObject({
      ok: true,
      value: { next_action: { code: "resolve-current-authority" } },
    });
    if (gateBlocked.ok) expect(gateBlocked.value).not.toHaveProperty("open_gate");
  });

  it("reports a field-level config change as informational without moving the action", async () => {
    const h = await harness();
    const baseline = parseConfigYaml(configText, "baseline") as TaskConfigSnapshot;
    writeFileSync(h.services.authority.state.absolute, canonicalDocument(h.state({
      last_seen_config: baseline,
    })).bytes);
    writeFileSync(h.services.authority.config.absolute, `${configText}max_attempts: 4\n`);
    const status = await computeTaskStatus(h.services.dependencies, h.services.authority);
    expect(status).toMatchObject({
      ok: true,
      value: {
        config: { verified: true },
        next_action: { code: "run-step", step: "produce" },
      },
    });
    if (!status.ok) return;
    expect(status.value.config_change).toEqual([{ path: "max_attempts", after: 4 }]);
    expect(status.value.blocking_reasons).not.toContain("config-invalid");
  });

  it("blocks on an unparseable config with repair advice rather than a restore demand", async () => {
    const h = await harness();
    // Bytes the current schema rejects: editing or restoring the file cannot recover them, so
    // the blocker names the config file and the next action says to fix the YAML.
    const invalidBytes = Buffer.from('schema_version: "1"\nroles:\n  reviewer: { model: claude-opus-4-6, effort: high }\n');
    writeFileSync(h.services.authority.config.absolute, invalidBytes);
    writeFileSync(h.services.authority.state.absolute, canonicalDocument(h.state({
      config_digest: sha256Bytes(invalidBytes),
    })).bytes);
    const status = await computeTaskStatus(h.services.dependencies, h.services.authority);
    expect(status).toMatchObject({
      ok: true,
      value: {
        config: { verified: false, issue: "config-invalid" },
        blocking_reasons: expect.arrayContaining(["config-invalid"]),
        next_action: { code: "inspect-state", human_required: true },
      },
    });
    if (status.ok) {
      expect(status.value.next_action.detail).toContain("fix the YAML");
      expect(status.value.next_action.detail).not.toContain("new task or the explicit upgrade flow");
    }
  });

  it("reports an open gate with its conversational human-resolution interface", async () => {
    const h = await harness();
    const context = { artifact_kind: "phase-implementation" } as const;
    const active = parseActiveGate({
      schema_version: "1", gate_id: "gate-superseding", intent_id: "gate-superseding-intent", request_digest: D("7"),
      task_id: TASK, phase_instance: PHASE, summary: "Approve revised implementation", subject_digest: D("8"),
      context_digest: computeGateContextDigest("artifact-approval", context as never),
      current_evidence: { set_digest: D("9"), slots: [
        { role: "counter-review", evidence_digest: D("b"), assurance: "server-attested", producer_family: "claude", reviewer_family: "codex" },
      ] },
      kind: "artifact-approval", context, allowed_decisions: ["approve", "revise", "reject", "cancel"],
      opened_at_revision: 4, status: "awaiting-human",
      decision_template: {
        schema_version: "1", gate_id: "gate-superseding", task_id: TASK, phase_instance: PHASE,
        kind: "artifact-approval", subject_digest: D("8"), context_digest: computeGateContextDigest("artifact-approval", context as never),
        required_fields: ["payload", "human_provenance"], cancellation_fields: ["cancelled", "reason", "human_provenance"],
      },
    });
    const { status: _status, decision_template: _template, ...requestFields } = active;
    const request = parseArchivedGateRequest(requestFields);
    writeFileSync(h.services.authority.state.absolute, canonicalDocument(h.state({
      open_gate: {
        gate_id: active.gate_id, gate_kind: active.kind, subject_digest: active.subject_digest,
        context_digest: active.context_digest, frozen_state_digest: D("c"), opened_at_revision: parseSafeInteger(4),
      },
    })).bytes);
    const activePath = join(h.root, ".archflow", "runtime", "tasks", TASK, "cache", "gates", "gate.json");
    mkdirSync(join(activePath, ".."), { recursive: true });
    writeFileSync(activePath, canonicalDocument(active).bytes);
    mkdirSync(join(h.services.authority.task_root, "authority", "decisions", active.gate_id), { recursive: true });
    writeFileSync(
      join(h.services.authority.task_root, "authority", "decisions", active.gate_id, "request.json"),
      canonicalDocument(request).bytes,
    );

    const status = await computeTaskStatus(h.services.dependencies, h.services.authority);
    expect(status).toMatchObject({
      ok: true,
      value: {
        open_gate: {
          gate_id: active.gate_id,
          decision_path: `.archflow/runtime/tasks/${TASK}/cache/gates/gate.decision`,
          archive_decision_path: `.archflow/tasks/${TASK}/authority/decisions/${active.gate_id}/decision.json`,
          request_path: `.archflow/tasks/${TASK}/authority/decisions/${active.gate_id}/request.json`,
        },
        next_action: { code: "resolve-open-gate", gate_id: active.gate_id, human_required: true },
      },
    });
    if (!status.ok || status.value.open_gate === undefined) throw new Error("gate status unavailable");
    expect(status.value.blocking_reasons).not.toContain("active-gate-mismatch");
    expect(status.value.open_gate.decision_templates.length).toBeGreaterThan(1);
    expect(status.value.open_gate.presentation).toMatchObject({
      summary: "Approve revised implementation",
      question: expect.any(String),
      options: expect.arrayContaining([expect.objectContaining({ label: "Approve and continue to design" })]),
    });

    rmSync(activePath);
    const reconstructed = await computeTaskStatus(h.services.dependencies, h.services.authority);
    expect(reconstructed).toMatchObject({
      ok: true,
      value: {
        open_gate: {
          gate_id: active.gate_id,
          decision_path: `.archflow/runtime/tasks/${TASK}/cache/gates/gate.decision`,
        },
      },
    });
  });
});

import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { parseSafeCode, parseSafeInteger, parseSha256Digest, parseTaskSlug } from "../../src/contracts/evidence.js";
import { canonicalJsonDigest } from "../../src/contracts/canonical.js";
import { computeRequestDigest, type RequestDigestSubject } from "../../src/contracts/fingerprints.js";
import { parseToolCall, type ParsedToolCall } from "../../src/contracts/mcp-tools.js";
import { encodePhaseInstance, parsePositiveSafePhaseNumber } from "../../src/contracts/phase-instance.js";
import { createGitRunner, preflightGit, type RepositoryOperationContext } from "../../src/repository/git.js";
import { discoverWorktree } from "../../src/repository/identity.js";
import { createInternalTransactionAuthority, type TransactionAuthority } from "../../src/state/authority.js";
import { identifyTransactionRequest } from "../../src/state/request.js";
import { ordinaryApprovalFacts } from "../helpers/ordinary-approval.js";

const roots: string[] = [];
afterAll(() => { for (const root of roots) rmSync(root, { recursive: true, force: true }); });

const taskId = parseTaskSlug("task-1");
const phase = encodePhaseInstance({ kind: "phase-impl", phase: parsePositiveSafePhaseNumber(9) });
const context: RepositoryOperationContext = {
  task_id: taskId,
  phase_instance: phase,
  operation: parseSafeCode("state-request-test"),
  attempt: parseSafeInteger(1),
};
const fingerprint = parseSha256Digest("b".repeat(64));

const gitEnvironment: NodeJS.ProcessEnv = {
  ...process.env,
  GIT_CONFIG_GLOBAL: "/dev/null",
  GIT_CONFIG_SYSTEM: "/dev/null",
  GIT_AUTHOR_NAME: "ArchFlow Test",
  GIT_AUTHOR_EMAIL: "test@example.invalid",
  GIT_COMMITTER_NAME: "ArchFlow Test",
  GIT_COMMITTER_EMAIL: "test@example.invalid",
};

const common = {
  schema_version: "1",
  task_id: taskId,
  intent_id: "intent-1",
  expected_revision: 4,
  input_fingerprint: "a".repeat(64),
} as const;
const counterEvidence = { role: "counter-review", evidence_digest: "6".repeat(64), assurance: "server-attested", producer_family: "claude", reviewer_family: "codex" } as const;
const currentEvidence = { set_digest: "8".repeat(64), slots: [counterEvidence] } as const;
const previewDigest = "5".repeat(64);
const gateDecision = { choice: "approve", reason: "Reviewed." } as const;
const waiverDecision = { choice: "grant", reason: "Reviewed." } as const;
const waiverOrigin = {
  origin_gate_id: "gate-1",
  origin_decision_digest: "1".repeat(64),
  origin_context_digest: "2".repeat(64),
  task_id: taskId,
  phase_instance: phase,
  subject_digest: "3".repeat(64),
  current_evidence_set_digest: "4".repeat(64),
  rule: { rule_id: "Rule:1", rule_version: 1 },
  scope: { operation: "review-trigger", boundary: "subject" },
} as const;
const artifactApprovalContext = {
  artifact_kind: "phase-implementation" as const,
  ...ordinaryApprovalFacts("phase-impl", parseSha256Digest("7".repeat(64))),
};

const rawInputs = () => ({
  archflow_state: { ...common, phase_instance: phase, step: "produce", status: "succeeded" },
  archflow_approval_trigger_recovery: {
    ...common,
    phase_instance: phase,
    step: "triage",
    status: "succeeded",
    operation: "recover_approval_trigger_authority",
  },
  archflow_milestone_refresh: { ...common, phase_instance: phase, step: "triage", status: "succeeded", operation: "refresh_milestone_baseline" },
  archflow_milestone_recovery: { ...common, phase_instance: phase, step: "produce", status: "running", operation: "recover_milestone_authority" },
  archflow_stale_refresh: { ...common, phase_instance: phase, step: "triage", status: "succeeded", operation: "refresh_stale_baseline" },
  archflow_set_commit_authority: { ...common, phase_instance: phase, step: "produce", status: "running", operation: "set_commit_authority", target_commit: "HEAD", reason: "Rebase onto updated main branch", scope: ["milestone"] as const },
  archflow_validation_override: {
    ...common,
    phase_instance: phase,
    step: "produce",
    status: "failed",
    operation: "request_validation_override",
    reason: "hardware runner unavailable",
    validation_override_request: { displaced_validations: ["hardware integration suite"] },
  },
  archflow_counter_review: { ...common, artifact_path: "phases/9/result.md" },
  archflow_gate: { ...common, phase_instance: phase, summary: "Approve implementation", subject_digest: "7".repeat(64), current_evidence: currentEvidence, kind: "artifact-approval", context: artifactApprovalContext, preview_digest: previewDigest, decision: gateDecision },
  archflow_waiver: { ...common, origin: waiverOrigin, rationale: "A bounded exception is required", preview_digest: previewDigest, decision: waiverDecision },
} as const);

const durableFixture = (name: string): unknown => JSON.parse(readFileSync(
  new URL(`../fixtures/contracts/durable/${name}.valid.json`, import.meta.url),
  "utf8",
));

type SelectorFixture = Readonly<{
  call: ParsedToolCall;
  operation: RequestDigestSubject["operation"];
  operation_fields: RequestDigestSubject["operation_fields"];
}>;

function selectorFixtures(): readonly SelectorFixture[] {
  const raw = rawInputs();
  return [
    { call: parseToolCall("archflow_state", raw.archflow_state), operation: "record-state-boundary", operation_fields: { phase_instance: phase, step: "produce", status: "succeeded" } },
    { call: parseToolCall("archflow_state", raw.archflow_approval_trigger_recovery), operation: "recover-approval-trigger-authority", operation_fields: { phase_instance: phase, step: "triage", status: "succeeded", intent_id: raw.archflow_approval_trigger_recovery.intent_id } },
    { call: parseToolCall("archflow_state", raw.archflow_milestone_refresh), operation: "refresh-milestone-baseline", operation_fields: { phase_instance: phase, step: "triage", status: "succeeded", intent_id: raw.archflow_milestone_refresh.intent_id } },
    { call: parseToolCall("archflow_state", raw.archflow_milestone_recovery), operation: "recover-milestone-authority", operation_fields: { phase_instance: phase, step: "produce", status: "running", intent_id: raw.archflow_milestone_recovery.intent_id } },
    { call: parseToolCall("archflow_state", raw.archflow_stale_refresh), operation: "refresh-stale-baseline", operation_fields: { phase_instance: phase, step: "triage", status: "succeeded", intent_id: raw.archflow_stale_refresh.intent_id } },
    { call: parseToolCall("archflow_state", raw.archflow_set_commit_authority), operation: "set-commit-authority", operation_fields: { phase_instance: phase, step: "produce", status: "running", target_commit: "HEAD", reason: "Rebase onto updated main branch", scope: ["milestone"] } },
    { call: parseToolCall("archflow_state", raw.archflow_validation_override), operation: "request-validation-override", operation_fields: { phase_instance: phase, step: "produce", status: "failed", reason: "hardware runner unavailable", validation_override_request: { displaced_validations: ["hardware integration suite"] } } },
    { call: parseToolCall("archflow_counter_review", raw.archflow_counter_review), operation: "counter-review", operation_fields: { artifact_path: "phases/9/result.md" } },
    { call: parseToolCall("archflow_gate", raw.archflow_gate), operation: "gate", operation_fields: { phase_instance: phase, summary: "Approve implementation", subject_digest: "7".repeat(64), current_evidence: currentEvidence, kind: "artifact-approval", context: artifactApprovalContext, preview_digest: previewDigest, decision: gateDecision } },
    { call: parseToolCall("archflow_waiver", raw.archflow_waiver), operation: "waiver", operation_fields: { origin: waiverOrigin, rationale: "A bounded exception is required", preview_digest: previewDigest, decision: waiverDecision } },
  ] as readonly SelectorFixture[];
}

describe("internal transaction request identity", () => {
  let authority: TransactionAuthority;

  beforeAll(async () => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), "archflow-state-request-")));
    roots.push(root);
    execFileSync("git", ["-c", "init.defaultBranch=main", "init", "-q"], { cwd: root, env: gitEnvironment });
    writeFileSync(join(root, "tracked.txt"), "root\n");
    execFileSync("git", ["add", "--", "tracked.txt"], { cwd: root, env: gitEnvironment });
    execFileSync("git", ["commit", "-q", "-m", "root"], { cwd: root, env: gitEnvironment });

    const runner = createGitRunner({ cwd: root });
    const environment = await preflightGit(runner, context);
    const discovered = await discoverWorktree(runner, context);
    if (!environment.ok || !discovered.ok) throw new Error("repository setup failed");
    const result = await createInternalTransactionAuthority({ runner: discovered.value, environment: environment.value, task_id: taskId, context });
    if (!result.ok) throw new Error("authority setup failed");
    authority = result.value;
    expect(authority.task_root).toBe(join(root, ".archflow", "tasks", taskId));
    expect(authority.state.path_class).toBe("task-state");
    expect(authority.config.path_class).toBe("task-config");
  });

  it("selects every tool's exact operation literal and fields", () => {
    for (const fixture of selectorFixtures()) {
      const identified = identifyTransactionRequest(fixture.call, authority, fingerprint);
      const subject = {
        schema_version: "1",
        tool: fixture.call.name,
        repository_identity_digest: authority.repository_identity_digest,
        task_identity_digest: authority.task_identity_digest,
        operation: fixture.operation,
        operation_fields: fixture.operation_fields,
        input_fingerprint: fingerprint,
      } as RequestDigestSubject;
      expect(identified.call).toBe(fixture.call);
      expect(identified.input_fingerprint).toBe(fingerprint);
      expect(identified.request_digest, fixture.call.name).toBe(computeRequestDigest(subject));
    }
  });

  // The selector's key list is checked against the tool input at compile time, but nothing checks
  // that `subjectFor` actually projects each field. An omitted optional field is silently absent
  // from the digest, which would let a staged request be edited after it was composed and still
  // authenticate. This drives the real builder, not a hand-written subject.
  it("carries invocation routes and a counter-review route override into the request digest", () => {
    const raw = rawInputs();
    const digestFor = (invocation_routes?: unknown, route_override?: unknown) => identifyTransactionRequest(
      parseToolCall("archflow_counter_review", {
        ...raw.archflow_counter_review,
        ...(invocation_routes === undefined ? {} : { invocation_routes }),
        ...(route_override === undefined ? {} : { route_override }),
      }),
      authority,
      fingerprint,
    ).request_digest;

    const digests = [
      digestFor(),
      digestFor({ "counter-reviewer": { model: "claude-fable-5", effort: "high" } }),
      digestFor({ adjudicator: { model: "gpt-5.6", effort: "max" } }),
      digestFor(undefined, { reason: "pinned reviewer is rate-limited", "counter-reviewer": { model: "claude-opus-4-6", effort: "max" } }),
      digestFor({ "counter-reviewer": { model: "claude-fable-5", effort: "high" } }, { reason: "pinned reviewer is rate-limited", "counter-reviewer": { model: "claude-opus-4-6", effort: "max" } }),
    ];
    expect(new Set(digests).size, "each distinct routing request must identify a distinct request").toBe(digests.length);
  });

  it("binds each explicit payload-free state operation to a distinct request identity", () => {
    const raw = rawInputs();
    const calls = [raw.archflow_approval_trigger_recovery, raw.archflow_milestone_refresh, raw.archflow_stale_refresh];
    const digests = calls.map((value) => identifyTransactionRequest(
      parseToolCall("archflow_state", value), authority, fingerprint,
    ).request_digest);
    expect(new Set(digests).size).toBe(digests.length);
  });

  it("gives request-bearing failure a distinct identity bound to its reason and exact validations", () => {
    const raw = rawInputs();
    const digestFor = (reason: string, displaced_validations: readonly string[]) =>
      identifyTransactionRequest(parseToolCall("archflow_state", {
        ...raw.archflow_validation_override,
        reason,
        validation_override_request: { displaced_validations },
      }), authority, fingerprint).request_digest;
    const baseline = digestFor("hardware runner unavailable", ["hardware integration suite"]);
    expect(digestFor("device lab unavailable", ["hardware integration suite"])).not.toBe(baseline);
    expect(digestFor("hardware runner unavailable", ["hardware integration suite", "physical-device smoke test"]))
      .not.toBe(baseline);
    const plainFailure = identifyTransactionRequest(parseToolCall("archflow_state", {
      ...common, phase_instance: phase, step: "produce", status: "failed",
    }), authority, fingerprint).request_digest;
    expect(plainFailure).not.toBe(baseline);
  });

  it("selects every artifact operation and binds the exact canonical artifact digest", () => {
    const triageArtifact = {
      schema_version: "1",
      artifact_kind: "triage",
      evidence: {
        schema_version: "1",
        task_id: taskId,
        phase_instance: phase,
        step: "triage",
        subject_digest: "1".repeat(64),
        input_fingerprint: "2".repeat(64),
        current_evidence_set_digest: "3".repeat(64),
        source_evidence_digests: [],
        dispositions: [],
        accepted_count: 0,
        rejected_count: 0,
      },
    } as const;
    const cases = [
      ["task-initialization", durableFixture("task-initialization"), "adopt-task-initialization"],
      ["legacy-import-initialization", durableFixture("legacy-import-initialization"), "adopt-legacy-import-initialization"],
      ["document-artifact", durableFixture("document-artifact"), "record-document-artifact"],
      ["implementation-output", durableFixture("implementation-output"), "record-implementation-output"],
      ["triage", triageArtifact, "record-triage"],
    ] as const;
    for (const [label, artifact, operation] of cases) {
      const call = parseToolCall("archflow_state", {
        ...rawInputs().archflow_state,
        step: label === "triage" ? "triage" : "produce",
        artifact,
      });
      const identified = identifyTransactionRequest(call, authority, fingerprint);
      const expected = computeRequestDigest({
        schema_version: "1",
        tool: "archflow_state",
        repository_identity_digest: authority.repository_identity_digest,
        task_identity_digest: authority.task_identity_digest,
        operation,
        operation_fields: {
          phase_instance: phase,
          step: call.input.step,
          status: "succeeded",
          artifact_kind: call.input.artifact!.artifact_kind,
          artifact_digest: canonicalJsonDigest(call.input.artifact!),
        },
        input_fingerprint: fingerprint,
      });
      expect(identified.request_digest, label).toBe(expected);
    }
  });

  it("excludes CAS, intent, caller fingerprint, and transport metadata for non-control selectors", () => {
    for (const fixture of selectorFixtures()) {
      const isControlOp = fixture.call.name === "archflow_state" &&
        fixture.call.input.operation !== undefined &&
        fixture.call.input.operation !== "planning_restart" &&
        fixture.call.input.operation !== "set_commit_authority";
      const baseline = identifyTransactionRequest(fixture.call, authority, fingerprint).request_digest;
      const envelopeA = { request_id: "transport-1", timestamp: "2026-07-28T00:00:00.000Z", call: fixture.call };
      const raw = {
        ...fixture.call.input,
        ...(isControlOp ? {} : { intent_id: "retry-intent" }),
        expected_revision: 99,
        input_fingerprint: "c".repeat(64),
      };
      const retry = parseToolCall(fixture.call.name, raw) as ParsedToolCall;
      const envelopeB = { request_id: "transport-2", timestamp: "2026-07-28T01:00:00.000Z", call: retry };
      expect(identifyTransactionRequest(envelopeB.call, authority, fingerprint).request_digest, fixture.call.name).toBe(baseline);
      expect(identifyTransactionRequest(envelopeB.call, authority, parseSha256Digest("d".repeat(64))).request_digest, fixture.call.name).not.toBe(baseline);
      expect(envelopeA.request_id).not.toBe(envelopeB.request_id);
    }
  });

  it("retains intent_id as discriminator for control operations", () => {
    const raw = rawInputs();
    for (const opInput of [
      raw.archflow_approval_trigger_recovery,
      raw.archflow_milestone_refresh,
      raw.archflow_milestone_recovery,
      raw.archflow_stale_refresh,
    ]) {
      const call1 = parseToolCall("archflow_state", { ...opInput, intent_id: "intent-1" });
      const call2 = parseToolCall("archflow_state", { ...opInput, intent_id: "intent-2" });
      const digest1 = identifyTransactionRequest(call1, authority, fingerprint).request_digest;
      const digest2 = identifyTransactionRequest(call2, authority, fingerprint).request_digest;
      expect(digest1).not.toBe(digest2);
    }
  });

  it("rejects unauthentic calls before selecting fields", () => {
    const call = selectorFixtures()[0]!.call;
    expect(() => identifyTransactionRequest({ ...call } as never, authority, fingerprint)).toThrow(/authentic parsed tool call/u);
  });
});

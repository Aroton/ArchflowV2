import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { canonicalDocument, parseGitOid, sha256Bytes } from "../../src/contracts/canonical.js";
import { connectionContextFactory, createInvocationContext } from "../../src/contracts/contexts.js";
import { parseActiveGate, parseGateRequest, type ActiveGateV1 } from "../../src/contracts/durable-gate.js";
import type { TaskStateV1 } from "../../src/contracts/durable-state.js";
import { parsePathSafeId, parseSafeCode, parseSafeInteger, parseSha256Digest, parseTaskSlug } from "../../src/contracts/evidence.js";
import { computeGateContextDigest, type InputFingerprintSubject } from "../../src/contracts/fingerprints.js";
import { parseGateDecisionEnvelope, type GateContext, type GateKind, type HumanDecisionProvenance, type WaiverOriginRef } from "../../src/contracts/gates.js";
import { parseTaskPathClaim } from "../../src/contracts/path-claims.js";
import type { PlainJsonValue } from "../../src/contracts/plain-json.js";
import { currentEvidenceSetRef } from "../../src/contracts/trust.js";
import type { RepositoryOperationContext } from "../../src/repository/git.js";
import { createGitRunner, preflightGit } from "../../src/repository/git.js";
import { discoverWorktree } from "../../src/repository/identity.js";
import { createAtomicWriter } from "../../src/state/atomic.js";
import { createInternalTransactionAuthority } from "../../src/state/authority.js";
import { runConnectedGateDecision } from "../../src/state/gate-direct.js";
import {
  buildGateDecisionTemplates,
  buildHumanGatePresentation,
  openDurableGate,
  resolveDurableGate,
  runDurableGate,
  selectGateDecisionTemplate,
  writeGateDecisionChoice,
  writeGateDecisionInterface,
  type GateLifecycleDependencies,
} from "../../src/state/gates.js";
import { createTaskLock } from "../../src/state/lock.js";
import { readIntentReceipt, readTaskConfig, readTaskState } from "../../src/state/read.js";
import { resolvedConstitutionFixture } from "../helpers/resolved-constitution.js";

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

const constitution = await resolvedConstitutionFixture({
  "00-rule.md": "---\nid: rule\nversion: 1\nstatus: active\n---\nrule\n",
});
const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

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

type Harness = Awaited<ReturnType<typeof harness>>;
async function harness() {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "archflow-gate-interface-"))); roots.push(root);
  const env = { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_SYSTEM: "/dev/null", GIT_AUTHOR_NAME: "ArchFlow Test", GIT_AUTHOR_EMAIL: "test@example.invalid", GIT_COMMITTER_NAME: "ArchFlow Test", GIT_COMMITTER_EMAIL: "test@example.invalid" };
  execFileSync("git", ["-c", "init.defaultBranch=main", "init", "-q"], { cwd: root, env });
  writeFileSync(join(root, "tracked.txt"), "root\n");
  execFileSync("git", ["add", "tracked.txt"], { cwd: root, env });
  execFileSync("git", ["commit", "-q", "-m", "root"], { cwd: root, env });
  const taskRoot = join(root, ".archflow", "tasks", "task-1"); mkdirSync(taskRoot, { recursive: true });
  const configBytes = Buffer.from('schema_version: "1"\nroles:\n  counter-reviewer: {model: gpt-example, effort: high}\n  adjudicator: {model: claude-example, effort: high}\n');
  writeFileSync(join(taskRoot, "config.yaml"), configBytes);
  const operation: RepositoryOperationContext = { task_id: parseTaskSlug("task-1"), phase_instance: "phase-impl-2" as never, operation: parseSafeCode("gate-interface-test"), attempt: parseSafeInteger(1) };
  const discovered = await discoverWorktree(createGitRunner({ cwd: root }), operation); if (!discovered.ok) throw new Error("discovery failed");
  const git = await preflightGit(discovered.value, operation); if (!git.ok) throw new Error("preflight failed");
  const authorityResult = await createInternalTransactionAuthority({ runner: discovered.value, environment: git.value, task_id: parseTaskSlug("task-1"), context: operation });
  if (!authorityResult.ok) throw new Error("authority failed");
  const authority = authorityResult.value;
  const initial: TaskStateV1 = {
    schema_version: "1", task_id: parseTaskSlug("task-1"), repository_identity_digest: authority.repository_identity_digest,
    revision: parseSafeInteger(4), phase_instance: "phase-impl-2" as never, step: "adjudicate", status: "succeeded",
    attempt: parseSafeInteger(1), input_fingerprint: D("2"), initialization_digest: D("3"), config_digest: sha256Bytes(configBytes),
    workflow_digest: D("5"), constitution_digest: constitution.digest, policy_base_commit: "abcdef0123456789abcdef0123456789abcdef01" as never,
    authoritative_results: [], approvals: [], waivers: [],
  };
  writeFileSync(join(taskRoot, "state.json"), canonicalDocument(initial).bytes);
  const dependencies: GateLifecycleDependencies = {
    runner: discovered.value, environment: git.value, atomic: createAtomicWriter(), lock: createTaskLock(),
    read_state: readTaskState, read_config: readTaskConfig, read_receipt: readIntentReceipt,
    resolve_input_fingerprint: async () => ({ schema_version: "1", ok: true, value: {} as InputFingerprintSubject }),
  };
  const entry = CASES[0];
  const gateInput = {
    authority, expected_revision: initial.revision, intent_id: parsePathSafeId("intent-interface"), request_digest: D("6"),
    input_fingerprint: initial.input_fingerprint, phase_instance: initial.phase_instance, summary: "Approve implementation",
    subject_digest: D("c"), current_evidence: evidence, kind: entry.kind, context: entry.context,
  } as const;
  const opened = await openDurableGate(dependencies, gateInput);
  if (!opened.ok) throw new Error(`gate open failed: ${opened.error.code}`);
  const gateCache = join(authority.workspace_root, "cache", "gates");
  const active = parseActiveGate(JSON.parse(readFileSync(join(gateCache, "gate.json"), "utf8")));
  return { root, taskRoot, gateCache, authority, dependencies, opened, active, gateInput };
}

function convertToWaiverGate(h: Harness): Readonly<{ active: ActiveGateV1; origin: WaiverOriginRef }> {
  const origin: WaiverOriginRef = {
    origin_gate_id: "origin-gate" as never,
    origin_decision_digest: D("1"),
    origin_context_digest: D("2"),
    task_id: parseTaskSlug("task-1"),
    phase_instance: "phase-impl-2" as never,
    subject_digest: D("c"),
    current_evidence_set_digest: evidence.set_digest,
    rule: RULE_A,
    scope: { operation: "review-trigger", boundary: "subject" },
  };
  const context = { origin, rationale: "Narrow exception" } as const;
  const contextDigest = computeGateContextDigest("waiver", context);
  const active = parseActiveGate({
    ...h.active,
    kind: "constitution-review",
    context,
    context_digest: contextDigest,
    allowed_decisions: ["grant", "deny", "cancel"],
    decision_template: {
      ...h.active.decision_template,
      kind: "constitution-review",
      context_digest: contextDigest,
      required_fields: ["granted", "scope", "origin", "notes", "human_provenance"],
    },
  });
  const { status: _status, decision_template: _template, ...request } = active;
  writeFileSync(
    join(h.taskRoot, "authority", "decisions", h.active.gate_id, "request.json"),
    canonicalDocument(parseGateRequest(request)).bytes,
  );
  writeFileSync(join(h.gateCache, "gate.json"), canonicalDocument(active).bytes);
  const state = JSON.parse(readFileSync(join(h.taskRoot, "state.json"), "utf8")) as TaskStateV1;
  writeFileSync(join(h.taskRoot, "state.json"), canonicalDocument({
    ...state,
    open_gate: { ...state.open_gate!, gate_kind: "constitution-review", context_digest: contextDigest },
  } as TaskStateV1).bytes);
  return { active, origin };
}

function withProvenance(template: PlainJsonValue): PlainJsonValue {
  if (template === null || Array.isArray(template) || typeof template !== "object") throw new Error("template is not an object");
  return { ...template, human_provenance: provenance };
}

describe("gate decision interface", () => {
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

  it("writes a choice without requiring the caller to copy gate bindings", async () => {
    const h = await harness();
    expect(await writeGateDecisionChoice(h.dependencies, h.authority, {
      choice: "reject",
      reason: "The artifact needs revision.",
    })).toMatchObject({ ok: true, value: { gate_id: h.active.gate_id } });
    expect(JSON.parse(readFileSync(join(h.gateCache, "gate.decision"), "utf8"))).toMatchObject({
      gate_id: h.active.gate_id,
      context_digest: h.active.context_digest,
      payload: { decision: "reject", reason: "The artifact needs revision." },
      human_provenance: { channel: "archflow-local" },
    });
  });

  it("resolves a connected-host choice in one bounded call with host provenance", async () => {
    const h = await harness();
    const connection = connectionContextFactory.captureStartup({
      connection_id: "connection-direct-gate",
      startup_repository_candidate: { working_directory: h.root },
    }).initialize({
      client: { name: "test-client", version: "1" },
      host: "codex",
      protocol_version: "2025-11-25",
    });
    const invocation = createInvocationContext(connection, {
      invocation_id: "invocation-direct-gate",
      transport_metadata: { request_id: "request-direct-gate", operation: "tools/call" },
    }, new AbortController().signal);

    const resolved = await runConnectedGateDecision(
      h.dependencies,
      h.gateInput,
      { choice: "approve", reason: "The reviewed implementation meets the phase contract." },
      invocation,
    );

    expect(resolved).toMatchObject({
      ok: true,
      value: {
        replayed: false,
        record: {
          value: {
            outcome: "decided",
            envelope: {
              payload: { decision: "approve", reason: "The reviewed implementation meets the phase contract." },
              human_provenance: {
                channel: "connected-host",
                connection_id: "connection-direct-gate",
              },
            },
          },
        },
      },
    });
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

  it("writes and resolves every waiver decision shape through the bound interface", async () => {
    for (const choice of ["grant", "deny", "cancel"] as const) {
      const h = await harness();
      const { active, origin } = convertToWaiverGate(h);
      const template = buildGateDecisionTemplates(active).find((candidate) => choice === "cancel"
        ? "cancelled" in (candidate as object)
        : (candidate as { granted?: boolean }).granted === (choice === "grant"))!;

      expect(await writeGateDecisionInterface(h.dependencies, h.authority, template)).toMatchObject({
        ok: true,
        value: { gate_id: active.gate_id, decision_path: ".archflow/runtime/tasks/task-1/cache/gates/gate.decision" },
      });
      const firstResolution = await resolveDurableGate(h.dependencies, h.authority, active.gate_id, D("2"));
      const resolved = choice === "grant"
        ? await runDurableGate(h.dependencies, { ...h.gateInput, signal: new AbortController().signal })
        : firstResolution;

      if (choice === "cancel") {
        expect(resolved).toMatchObject({ ok: false, error: { code: "GATE_CANCELLED" } });
      } else {
        expect(resolved).toMatchObject({
          ok: true,
          value: {
            record: {
              value: {
                outcome: "waiver-decided",
                granted: choice === "grant",
                origin,
                scope: origin.scope,
                context_digest: active.context_digest,
              },
            },
          },
        });
      }
    }
  });

  it("replaces invalid and unbound interfaces but refuses a currently bound decision", async () => {
    const h = await harness();
    const templates = buildGateDecisionTemplates(h.active);
    const chosen = templates.find((template) => (template as { payload?: { decision?: string } }).payload?.decision === "reject")!;
    writeFileSync(join(h.gateCache, "gate.decision"), canonicalDocument({ invalid: true }).bytes);
    expect(await writeGateDecisionInterface(h.dependencies, h.authority, chosen)).toMatchObject({ ok: true, value: { gate_id: h.active.gate_id, decision_path: ".archflow/runtime/tasks/task-1/cache/gates/gate.decision" } });
    const written = JSON.parse(readFileSync(join(h.gateCache, "gate.decision"), "utf8"));
    expect(written).toMatchObject({ payload: { decision: "reject" }, human_provenance: { channel: "archflow-local", recorded_at: expect.stringMatching(/\.\d{3}Z$/u) } });
    const refusal = await writeGateDecisionInterface(h.dependencies, h.authority, templates[0]!);
    expect(refusal).toMatchObject({ ok: false, error: { code: "GATE_ACTIVE" } });

    writeFileSync(join(h.gateCache, "gate.decision"), canonicalDocument({ ...written, gate_id: "stale-gate" }).bytes);
    expect(await writeGateDecisionInterface(h.dependencies, h.authority, templates[0]!)).toMatchObject({ ok: true });
    expect(JSON.parse(readFileSync(join(h.gateCache, "gate.decision"), "utf8"))).toMatchObject({ gate_id: h.active.gate_id, payload: { decision: "approve" } });
  });

  it("reconstructs disposable gate UI from the durable request before installing a decision", async () => {
    const h = await harness();
    const chosen = buildGateDecisionTemplates(h.active).find(
      (template) => (template as { payload?: { decision?: string } }).payload?.decision === "reject",
    )!;
    rmSync(h.gateCache, { recursive: true, force: true });

    const written = await writeGateDecisionInterface(h.dependencies, h.authority, chosen);

    expect(written).toMatchObject({ ok: true, value: { gate_id: h.active.gate_id } });
    expect(JSON.parse(readFileSync(join(h.gateCache, "gate.json"), "utf8"))).toMatchObject({
      gate_id: h.active.gate_id,
      status: "awaiting-human",
    });
    expect(JSON.parse(readFileSync(join(h.gateCache, "gate.decision"), "utf8"))).toMatchObject({
      gate_id: h.active.gate_id,
      payload: { decision: "reject" },
    });
  });

  it("writes the structurally distinct cancellation and the resolver cancels the gate", async () => {
    const h = await harness();
    const cancellation = buildGateDecisionTemplates(h.active).find((template) => "cancelled" in (template as object))!;
    expect(await writeGateDecisionInterface(h.dependencies, h.authority, cancellation)).toMatchObject({ ok: true });
    const resolved = await resolveDurableGate(h.dependencies, h.authority, h.active.gate_id, D("2"));
    expect(resolved).toMatchObject({ ok: false, error: { code: "GATE_CANCELLED" } });
    expect(existsSync(join(h.gateCache, "gate.decision"))).toBe(false);
  });

  it("serializes a writer with the resolver so the freshly valid decision is not overwritten", async () => {
    const h = await harness();
    const chosen = buildGateDecisionTemplates(h.active).find((template) => (template as { payload?: { decision?: string } }).payload?.decision === "reject")!;
    const atomic = createAtomicWriter();
    let release!: () => void;
    const paused = new Promise<void>((resolve) => { release = resolve; });
    let entered!: () => void;
    const replacementEntered = new Promise<void>((resolve) => { entered = resolve; });
    const dependencies: GateLifecycleDependencies = {
      ...h.dependencies,
      atomic: {
        ...atomic,
        replace: async (path, bytes) => {
          if (path.absolute.endsWith("/gate.decision")) {
            entered();
            await paused;
          }
          await atomic.replace(path, bytes);
        },
      },
    };
    const writing = writeGateDecisionInterface(dependencies, h.authority, chosen);
    await replacementEntered;
    const resolving = resolveDurableGate(dependencies, h.authority, h.active.gate_id, D("2"));
    release();
    expect(await writing).toMatchObject({ ok: true });
    expect(await resolving).toMatchObject({ ok: true, value: { record: { value: { outcome: "decided", envelope: { payload: { decision: "reject" } } } } } });
    expect(existsSync(join(h.gateCache, "gate.decision"))).toBe(false);
  });
});

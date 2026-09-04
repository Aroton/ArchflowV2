/**
 * The migration-audit semantic journey: a staged legacy import is adopted locally through the
 * atomic adoption adapter, then the imported design travels the ordinary semantic surface —
 * unchanged produce submission, stubbed independent review (finding-free and findings variants),
 * triage, the migration-audit gate through `gate-summary` and archive/settle decisions, both
 * decision outcomes, the import milestone commit facts with a client-side commit, and the
 * server-derived resume skill for both resume shapes. Crash cuts at the adoption transaction and
 * the gate decision archive converge without duplicate effects; tampered or replaced staged bytes
 * fail closed; a stale stage classifies as restart-required and adoption refuses.
 */

import { execFileSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { connectionContextFactory, createInvocationContext } from "../../src/contracts/contexts.js";
import { parseSafeCode, parseTaskSlug, type TaskSlug } from "../../src/contracts/evidence.js";
import type { WorkflowViewV1 } from "../../src/contracts/semantic-workflow.js";
import { scaffoldRepositoryAssets } from "../../src/init/assets.js";
import { adoptLegacyUpgrade, stageLegacyUpgrade } from "../../src/init/legacy-upgrade.js";
import { classifyWorkflowStatus } from "../../src/local/status-classification.js";
import { archiveDirectSemanticGateDecision } from "../../src/state/gates.js";
import { createProductionServices, type ProductionServices } from "../../src/state/production.js";
import { composeRequest } from "../../src/state/request-composition.js";
import { executeSemanticActionSubstep, planSemanticAction } from "../../src/state/semantic-actions.js";
import { computeAuthoritativeSemanticStatus } from "../../src/state/semantic-status.js";
import { computeTaskStatusDetailed } from "../../src/state/status.js";
import {
  installSemanticReviewStub,
  semanticJourneyHarness,
  type SemanticJourneyHarness,
} from "../helpers/semantic-journeys.js";
import type { TaskWorkspace } from "../helpers/task-workspace.js";

const TIMEOUT = 60_000;
const repositoryRoot = resolve(import.meta.dirname, "../..");

const gitEnvironment: NodeJS.ProcessEnv = {
  ...process.env,
  GIT_CONFIG_GLOBAL: "/dev/null",
  GIT_CONFIG_SYSTEM: "/dev/null",
  GIT_AUTHOR_NAME: "ArchFlow Test",
  GIT_AUTHOR_EMAIL: "test@example.invalid",
  GIT_COMMITTER_NAME: "ArchFlow Test",
  GIT_COMMITTER_EMAIL: "test@example.invalid",
};

const roots: string[] = [];
const stubs: Array<() => void> = [];
afterEach(() => {
  for (const restore of stubs.splice(0)) restore();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function git(root: string, ...argv: string[]): string {
  return execFileSync("git", argv, { cwd: root, env: gitEnvironment, encoding: "utf8" }).trim();
}

/**
 * Variant "implementation" resumes at `phase-impl-3` (phases 1-2 implemented, phase 3 has a
 * mapped design without an implementation log); variant "design" resumes at `phase-design-2`
 * (phase 1 implemented, phase 2 has no mapped design).
 */
async function legacyRepository(taskId: TaskSlug, variant: "implementation" | "design"): Promise<{
  root: string;
  source: string;
  head: string;
}> {
  void taskId;
  const root = mkdtempSync(join(tmpdir(), "archflow-upgrade-journey-"));
  roots.push(root);
  git(root, "-c", "init.defaultBranch=main", "init", "-q");
  writeFileSync(join(root, "README.md"), "repository\n");
  git(root, "add", "--", "README.md");
  git(root, "commit", "-q", "-m", "root");
  const scaffolded = await scaffoldRepositoryAssets({ working_directory: root });
  if (!scaffolded.ok) throw new Error(scaffolded.error.code);
  const source = join(root, ".archflow", "tasks", "legacy-fixture");
  if (variant === "implementation") {
    cpSync(join(repositoryRoot, "test", "fixtures", "legacy"), source, { recursive: true });
  } else {
    mkdirSync(join(source, "phases"), { recursive: true });
    writeFileSync(join(source, "prd.md"), "# Legacy product\n\nThe legacy task shipped phase 1.\n");
    writeFileSync(join(source, "architecture.md"), "# Legacy architecture\n\nPhase 1 landed; phase 2 designs the mapping layer.\n");
    writeFileSync(join(source, "phases", "phase-1-foundation.md"), "# Phase 1 design\n\nFoundation work.\n");
    writeFileSync(join(source, "phases", "phase-1-foundation-log.md"), "# Phase 1 log\n\nFoundation shipped.\n");
  }
  git(root, "add", "-A");
  git(root, "commit", "-q", "-m", "policy and legacy source");
  return { root, source, head: git(root, "rev-parse", "HEAD") };
}

async function stageImport(root: string, source: string, head: string, taskId: TaskSlug) {
  const descriptor = {
    working_directory: root, source_root: source, task_id: taskId,
    policy_base_commit: head, import_baseline_commit: head, code_baseline_commit: head,
  };
  const preview = await stageLegacyUpgrade({ ...descriptor, operation: "preview" });
  if (!preview.ok) throw new Error(preview.error.code);
  const staged = await stageLegacyUpgrade({
    ...descriptor, operation: "stage", approved_preview_digest: preview.value.preview_digest,
  });
  if (!staged.ok) throw new Error(staged.error.code);
  return staged.value;
}

async function adopt(root: string, taskId: TaskSlug) {
  const adopted = await adoptLegacyUpgrade({ working_directory: root, task_id: taskId });
  expect(adopted.ok, adopted.ok ? undefined : JSON.stringify(adopted.error)).toBe(true);
  if (!adopted.ok) throw new Error("adoption failed");
  return adopted.value;
}

async function servicesFor(root: string, taskId: TaskSlug, label: string): Promise<ProductionServices> {
  const created = await createProductionServices({
    working_directory: root, task_id: taskId, operation: parseSafeCode(label),
  });
  if (!created.ok || created.value.state === undefined) {
    throw new Error(`journey services unavailable: ${created.ok ? "no state" : created.error.code}`);
  }
  return created.value;
}

function harness(root: string, taskId: TaskSlug): SemanticJourneyHarness {
  return semanticJourneyHarness({ root, taskId } as unknown as TaskWorkspace);
}

async function applyOk(
  h: SemanticJourneyHarness,
  invocation: Parameters<SemanticJourneyHarness["apply"]>[0],
  view: WorkflowViewV1,
  submission?: Parameters<SemanticJourneyHarness["apply"]>[2],
): Promise<WorkflowViewV1> {
  const result = await h.apply(invocation, view, submission);
  if (!result.ok) throw new Error(JSON.stringify(result.error));
  return result.value;
}

const design = { skill: "archflow-design", intent: "resume" } as const;

type MigrationAuditFixture = Readonly<{
  h: SemanticJourneyHarness;
  root: string;
  taskId: TaskSlug;
  presentation: WorkflowViewV1;
  commitMessage: string;
}>;

/** One review dispatch's findings list, in order; the last list repeats. */
type ReviewScript = readonly (readonly Record<string, unknown>[])[];

/**
 * Stages, adopts, and drives the imported design unchanged through produce and the stubbed
 * review (consuming the scripted findings dispatches), stopping at the open migration-audit
 * presentation with its decision offer.
 */
async function reachMigrationAuditPresentation(options: {
  taskId: TaskSlug;
  variant: "implementation" | "design";
  reviews: ReviewScript;
}): Promise<MigrationAuditFixture> {
  const { root, source, head } = await legacyRepository(options.taskId, options.variant);
  const staged = await stageImport(root, source, head, options.taskId);
  await adopt(root, options.taskId);
  stubs.push(installSemanticReviewStub(root, [...options.reviews]));

  const h = harness(root, options.taskId);
  let view = await h.status(design);
  expect(view.next_action.kind).toBe("submit-work");
  // The imported design is submitted unchanged: the adopted destination already carries its bytes.
  const designPath = join(root, ".archflow", "tasks", options.taskId, "design.md");
  const importedBytes = readFileSync(designPath);
  view = await applyOk(h, design, view, { kind: "work-result", outcome: "succeeded" });
  expect(readFileSync(designPath)).toEqual(importedBytes);

  const firstFindings = options.reviews[0] ?? [];
  if (firstFindings.length === 0) {
    // The review action settles its own deterministic empty triage and lands at the audit gate.
    view = await applyOk(h, design, view);
  } else {
    view = await applyOk(h, design, view);
    expect(view.next_action.kind).toBe("triage");
    view = await applyOk(h, design, view, {
      kind: "triage",
      dispositions: firstFindings.map((finding) => ({
        finding_id: `general-${String(finding.finding_id)}`,
        disposition: "rejected",
        rationale: "The finding does not apply to the imported bytes.",
        evidence: "The staged legacy document is the reviewed source of truth.",
      })),
    });
  }
  expect(view.next_action.kind).toBe("decide");
  expect(view.next_action.expected_submission).toBe("gate-summary");
  const commitMessage = staged.audit_context.commit_message;
  if (commitMessage === undefined) throw new Error("staged audit context carries no commit message");
  return { h, root, taskId: options.taskId, presentation: view, commitMessage };
}

async function acceptAndCommit(
  fixture: MigrationAuditFixture,
  choice: "accept-import",
): Promise<Readonly<{ opened: WorkflowViewV1; decided: WorkflowViewV1 }>> {
  const opened = await applyOk(fixture.h, design, fixture.presentation, {
    kind: "gate-summary", summary: "The imported requirements, design, history, and resume point are ready for audit.",
  });
  expect(opened.condition).toBe("awaiting-human");
  expect(opened.next_action.kind).toBe("decide");
  expect(opened.next_action.expected_submission).toBe("decision");
  const decided = await applyOk(fixture.h, design, opened, {
    kind: "decision", choice, reason: "The import matches the reviewed legacy history.",
  });
  const commit = decided.next_action.commit;
  if (commit === undefined) throw new Error(`import commit facts unavailable: ${JSON.stringify(decided.next_action)}`);
  expect(commit).toMatchObject({
    paths: [`.archflow/tasks/${fixture.taskId}`],
    message: fixture.commitMessage,
  });
  expect(commit).not.toHaveProperty("requires_human_confirmation");
  git(fixture.root, "add", "-A", "--", ...commit.paths);
  git(fixture.root, "-c", "user.name=ArchFlow Test", "-c", "user.email=test@example.invalid",
    "commit", "-q", "-m", commit.message, "--", ...commit.paths);
  return { opened, decided };
}

describe("migration-audit semantic upgrade journeys", () => {
  it("adopts locally, audits semantically, and resumes at the implemented phase's next skill", async () => {
    const taskId = parseTaskSlug("semantic-upgrade-impl");
    const fixture = await reachMigrationAuditPresentation({ taskId, variant: "implementation", reviews: [[]] });

    // The composed migration-audit request matches the durable authority exactly: revision,
    // fingerprint, and phase come from current state, and the context derives from the staged
    // legacy import the composer loads — nothing is hand-authored beyond the summary.
    const services = await servicesFor(fixture.root, taskId, "audit-composition-parity");
    const detailed = await computeTaskStatusDetailed(services.dependencies, services.authority);
    if (!detailed.ok) throw new Error(detailed.error.code);
    const state = detailed.value.state;
    if (state === undefined) throw new Error("detailed status carries no durable state");
    const composed = await composeRequest(services, {
      kind: "gate", intent_id: "audit-compose-parity", summary: "Audit the imported task.",
    });
    expect(composed.ok, composed.ok ? undefined : JSON.stringify(composed.error)).toBe(true);
    if (composed.ok) {
      const input = composed.value.envelope.request.input as Record<string, unknown>;
      expect(input).toMatchObject({
        task_id: taskId,
        phase_instance: "design",
        expected_revision: state.revision,
        input_fingerprint: state.input_fingerprint,
        kind: "migration-audit",
      });
      const context = input.context as Record<string, unknown>;
      expect(context.resume_phase).toBe("phase-impl-3");
      expect(Array.isArray(context.imported_documents)).toBe(true);
      expect((context.imported_documents as unknown[]).length).toBeGreaterThan(0);
      expect(typeof context.target_ref).toBe("string");
    }

    const { opened } = await acceptAndCommit(fixture, "accept-import");
    expect(opened.presentation).toMatchObject({
      class: "exception",
      reasons: [{
        class: "exception",
        text: "The imported legacy task requires a human audit before its bytes become the reviewed workflow baseline.",
      }],
    });
    const optionTokens = opened.presentation?.options.map((option) => option.token) ?? [];
    expect(optionTokens).toEqual(expect.arrayContaining(["accept-import", "request-changes", "stop-work"]));

    const resumeInvocation = { skill: "archflow-phase-impl" as const, phase: 3, intent: "resume" as const };
    const resumed = await fixture.h.status(resumeInvocation);
    expect(resumed.next_action.kind).toBe("start-next-skill");
    expect(resumed.next_action.skill).toBe("archflow-phase-impl");
    expect(resumed.next_action.skill_args).toEqual(["3"]);
    expect(resumed.next_action.offer).toBeDefined();

    const jumped = await applyOk(fixture.h, resumeInvocation, resumed);
    expect(jumped.position).toEqual({ kind: "phase-impl", phase: 3 });
    expect(jumped.next_action.kind).toBe("submit-work");
  }, TIMEOUT);

  it("resumes at phase design when the next phase has no mapped design", async () => {
    const taskId = parseTaskSlug("semantic-upgrade-design");
    const fixture = await reachMigrationAuditPresentation({ taskId, variant: "design", reviews: [[]] });
    await acceptAndCommit(fixture, "accept-import");

    const resumeInvocation = { skill: "archflow-phase-design" as const, phase: 2, intent: "resume" as const };
    const resumed = await fixture.h.status(resumeInvocation);
    expect(resumed.next_action.kind).toBe("start-next-skill");
    expect(resumed.next_action.skill).toBe("archflow-phase-design");
    expect(resumed.next_action.skill_args).toEqual(["2"]);

    const jumped = await applyOk(fixture.h, resumeInvocation, resumed);
    expect(jumped.position).toEqual({ kind: "phase-design", phase: 2 });
  }, TIMEOUT);

  it("routes review findings through triage and the revise choice through a fresh review", async () => {
    const taskId = parseTaskSlug("semantic-upgrade-revise");
    const finding = {
      finding_id: "import-gap", severity: "minor", blocking: false,
      summary: "The architecture note is thin.", evidence: "One paragraph describes phase 2.",
      suggested_resolution: "Note the mapping layer intent.",
    };
    const fixture = await reachMigrationAuditPresentation({
      taskId, variant: "implementation", reviews: [[finding], []],
    });

    const opened = await applyOk(fixture.h, design, fixture.presentation, {
      kind: "gate-summary", summary: "The import is ready for audit.",
    });
    const revised = await applyOk(fixture.h, design, opened, {
      kind: "decision", choice: "request-changes", reason: "Extend the imported design before accepting.",
    });
    // The revise choice closes the gate into a close-only checkpoint; re-entry is a separate action.
    expect(revised.next_action.kind).toBe("revise");
    await applyOk(fixture.h, design, revised);

    // Apply the requested revision, then submit the produce result with the human revision record.
    const designPath = join(fixture.root, ".archflow", "tasks", taskId, "design.md");
    writeFileSync(designPath, `${readFileSync(designPath, "utf8")}\n## Mapping layer intent\n\nPhase 2 designs the mapping layer.\n`);
    let view = await fixture.h.status(design);
    expect(view.next_action.kind).toBe("submit-work");
    view = await applyOk(fixture.h, design, view, {
      kind: "work-result", outcome: "succeeded",
      human_revision: { classification: "significant", rationale: "The human-requested revision extends the imported design." },
    });

    // Fresh review of the revised bytes is finding-free, so the audit gate opens again.
    expect(view.next_action.kind).toBe("review");
    view = await applyOk(fixture.h, design, view);
    expect(view.next_action.kind).toBe("decide");
    expect(view.next_action.expected_submission).toBe("gate-summary");

    const reopened = await applyOk(fixture.h, design, view, { kind: "gate-summary", summary: "The revised import is ready for audit." });
    const accepted = await applyOk(fixture.h, design, reopened, {
      kind: "decision", choice: "accept-import", reason: "The revised import matches the reviewed legacy history.",
    });
    expect(accepted.next_action.commit).toMatchObject({ message: fixture.commitMessage });
    expect(accepted.next_action.commit).not.toHaveProperty("requires_human_confirmation");
  }, TIMEOUT);

  it("converges without duplicate effects across adoption and decision-archive crash cuts", async () => {
    const taskId = parseTaskSlug("semantic-upgrade-crash");
    const { root, source, head } = await legacyRepository(taskId, "implementation");
    const staged = await stageImport(root, source, head, taskId);

    // Crash before the state replacement is visible: the intent receipt exists but the
    // destination does not; re-running the deterministic adoption recreates it exactly once.
    const first = await adopt(root, taskId);
    expect(first).toMatchObject({ replayed: false, resume_phase: "phase-impl-3" });
    const adoptedDesign = readFileSync(join(root, ".archflow", "tasks", taskId, "design.md"));
    rmSync(join(root, ".archflow", "tasks", taskId), { recursive: true, force: true });
    const retry = await adopt(root, taskId);
    expect(retry).toMatchObject({ replayed: false, resume_phase: "phase-impl-3" });
    expect(readFileSync(join(root, ".archflow", "tasks", taskId, "design.md"))).toEqual(adoptedDesign);

    // A completed adoption replays without duplicating effects.
    const replay = await adopt(root, taskId);
    expect(replay).toMatchObject({ replayed: true });
    const postReplay = await servicesFor(root, taskId, "crash-replay-state");
    expect(postReplay.state!.value).toMatchObject({ revision: 1, phase_instance: "design" });

    stubs.push(installSemanticReviewStub(root, [[]]));
    const h = harness(root, taskId);
    let view = await h.status(design);
    view = await applyOk(h, design, view, { kind: "work-result", outcome: "succeeded" });
    view = await applyOk(h, design, view);
    const opened = await applyOk(h, design, view, { kind: "gate-summary", summary: "The import is ready for audit." });

    // Crash after the decision archive but before settlement: the archived decision is offered as
    // an exact settle continuation, and re-submitting the original decision converges once.
    const services = await servicesFor(root, taskId, "crash-archive-services");
    const snapshot = await computeAuthoritativeSemanticStatus(services.dependencies, services.authority);
    if (!snapshot.ok) throw new Error(snapshot.error.code);
    const decision = {
      kind: "decision" as const, choice: "accept-import",
      reason: "The import matches the reviewed legacy history.",
    };
    const plan = planSemanticAction(snapshot.value, {
      schema_version: "1", task_id: taskId, invocation: design,
      action: { offer: opened.next_action.offer!, submission: decision },
    });
    expect(plan.next_substep).toBe("decision-archive");
    const connection = connectionContextFactory.captureStartup({
      connection_id: `upgrade-crash-${taskId}`,
      startup_repository_candidate: { working_directory: root },
    }).initialize({ client: { name: "claude-code", version: "2.1.220" }, host: "claude", protocol_version: "2025-11-25" });
    const invocationContext = createInvocationContext(connection, {
      invocation_id: `upgrade-crash-archive-${taskId}`,
      transport_metadata: { request_id: `upgrade-crash-request-${taskId}`, operation: "tools/call" },
    }, new AbortController().signal);
    const archived = await executeSemanticActionSubstep(services, plan, {
      archive_decision: (archivePlan) => archiveDirectSemanticGateDecision(services.dependencies, {
        authority: services.authority,
        operation_digest: archivePlan.operation_digest,
        intent_id: archivePlan.intent_id,
        choice: archivePlan.decision_submission!.choice,
        reason: archivePlan.decision_submission!.reason,
        invocation_context: invocationContext,
      }),
    });
    expect(archived.outcome).toMatchObject({ ok: true });

    const settledView = await h.status(design);
    expect(settledView.next_action.kind).toBe("decide");
    expect(settledView.headline).toContain("recorded decision is ready to settle");

    // The original decision submission replays the archive and settles exactly once.
    const settled = await applyOk(h, design, opened, decision);
    expect(settled.next_action.commit).toMatchObject({ message: staged.audit_context.commit_message });
    const settledState = (await servicesFor(root, taskId, "crash-settled-state")).state!.value;
    expect(settledState.approvals.filter((approval) => approval.gate_kind === "migration-audit")).toHaveLength(1);
    expect(settledState.open_gate).toBeUndefined();
  }, TIMEOUT);

  it("fails closed on tampered payloads and replaced manifests", async () => {
    const taskId = parseTaskSlug("semantic-upgrade-tamper");
    const { root, source, head } = await legacyRepository(taskId, "implementation");
    const staged = await stageImport(root, source, head, taskId);
    const importsRoot = join(root, ".archflow", "runtime", "tasks", taskId, "cache", "imports", staged.initialization.import_digest);

    const reference = staged.initialization.staged_payload_refs.find((item) =>
      staged.initialization.mapping.some((mapping) => mapping.legacy_path === item.legacy_path));
    if (reference === undefined) throw new Error("mapped payload missing");
    const payloadPath = join(importsRoot, "payload", reference.legacy_path);
    writeFileSync(payloadPath, "tampered\n");
    const payloadRejected = await adoptLegacyUpgrade({ working_directory: root, task_id: taskId });
    expect(payloadRejected.ok).toBe(false);
    expect(existsSync(join(root, ".archflow", "tasks", taskId, "state.json"))).toBe(false);

    // Restore the payload, then replace the manifest bytes: both must fail closed.
    writeFileSync(payloadPath, readFileSync(join(source, reference.legacy_path)));
    writeFileSync(join(importsRoot, "manifest.json"), JSON.stringify({ ...staged.initialization, commit_message: "replaced" }));
    const manifestRejected = await adoptLegacyUpgrade({ working_directory: root, task_id: taskId });
    expect(manifestRejected.ok).toBe(false);
    expect(existsSync(join(root, ".archflow", "tasks", taskId, "state.json"))).toBe(false);
  }, TIMEOUT);

  it("classifies a stale stage as restart-required and refuses to adopt it", async () => {
    const taskId = parseTaskSlug("semantic-upgrade-stale");
    const { root, source, head } = await legacyRepository(taskId, "implementation");
    const staged = await stageImport(root, source, head, taskId);
    rmSync(join(root, ".archflow", "runtime", "tasks", taskId, "cache", "imports", staged.initialization.import_digest, "stage.json"));

    const classification = await classifyWorkflowStatus({ working_directory: root, task_id: taskId });
    expect(classification.ok).toBe(true);
    if (classification.ok) {
      expect(classification.value.mode).toBe("upgrade-restart-required");
      expect(classification.value.next_action.code).toBe("discard-incompatible-upgrade-stage");
    }
    const refused = await adoptLegacyUpgrade({ working_directory: root, task_id: taskId });
    expect(refused.ok).toBe(false);
    expect(existsSync(join(root, ".archflow", "tasks", taskId, "state.json"))).toBe(false);
  }, TIMEOUT);
});

/**
 * The reviewer route substitution reached through the public semantic apply path: a
 * `review-dispatch` submission on the `review` action must dispatch the counter-review under the
 * substituted route, retain the override with its human reason, and surface it in status
 * provenance — plus the crash-window semantics when the submission value does not survive
 * recovery between the review substeps.
 */

import { chmodSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import type { TaskStateV1 } from "../../src/contracts/durable-state.js";
import { parseSha256Digest } from "../../src/contracts/evidence.js";
import type { PlainJsonValue } from "../../src/contracts/plain-json.js";
import type { ServerAttestedReview } from "../../src/contracts/review.js";
import type { SemanticStatusSnapshotV1, WorkflowInvocationV1 } from "../../src/contracts/semantic-workflow.js";
import { unavailableImplementationRecommendation } from "../../src/contracts/semantic-workflow.js";
import { loadRetainedEvidence } from "../../src/state/evidence-results.js";
import { readTaskState } from "../../src/state/read.js";
import { parseSemanticSubstepIntentId, planSemanticAction } from "../../src/state/semantic-actions.js";
import { projectSemanticStatus } from "../../src/state/semantic-view.js";
import { computeTaxonomyDenialRates } from "../../src/state/semantic-status.js";
import { computeTaskStatusDetailed } from "../../src/state/status.js";
import {
  installSemanticReviewStub,
  semanticJourneyHarness,
  type SemanticJourneyHarness,
} from "../helpers/semantic-journeys.js";
import { createTaskWorkspace, type TaskWorkspace } from "../helpers/task-workspace.js";

const TIMEOUT = 180_000;
const CONFIGURED_MODEL = "gpt-5.6-sol";
const CONFIGURED_EFFORT = "xhigh";
const SUBSTITUTION = {
  reason: "codex CLI auth outage; review this dispatch on the fallback reviewer",
  "counter-reviewer": { model: "gpt-5.6-outage-fallback", effort: "high" },
} as const;
const SUBMISSION = { kind: "review-dispatch", route_override: SUBSTITUTION } as const;

const workspaces: TaskWorkspace[] = [];
const restorers: (() => void)[] = [];

afterEach(() => {
  for (const restore of restorers.splice(0)) restore();
  for (const workspace of workspaces.splice(0)) workspace.dispose();
});

async function freshState(workspace: TaskWorkspace): Promise<TaskStateV1> {
  const read = await readTaskState(workspace.services.authority.state);
  if (read.kind !== "canonical") throw new Error("task state unavailable");
  return read.document.value;
}

async function retainedReviewEvidence(workspace: TaskWorkspace, state: TaskStateV1): Promise<ServerAttestedReview> {
  const loaded = await loadRetainedEvidence(
    { load_retained_manifest: workspace.services.dependencies.load_retained_manifest! },
    structuredClone(state),
    state.phase_instance,
  );
  if (!loaded.ok) throw new Error(loaded.error.code);
  const source = loaded.value.get("counter_review")?.manifest.source_artifact;
  if (source?.artifact_kind !== "review-evidence") throw new Error("retained counter-review evidence unavailable");
  if (source.evidence.assurance !== "server-attested") throw new Error("retained counter-review evidence is not server-attested");
  return source.evidence;
}

/**
 * The provenance block status projects for the retained counter-review. `route_override` is
 * spread in at runtime whenever the review ran on a substitute; the declared status type predates
 * that field, so this local view names the full shape the block actually carries.
 */
type ReviewProvenance = Readonly<{
  assurance: string;
  producer_family: string;
  model_family: string;
  model: string;
  effort: string;
  adapter?: string;
  provider?: string;
  route_source?: Readonly<{
    provenance: string;
    displaced?: Readonly<{ source: string; model: string; effort: string; provider?: string }>;
  }>;
  route_override?: Readonly<{ reason: string; pinned_model?: string; pinned_effort?: string; pinned_provider?: string }>;
}>;

async function statusProvenance(workspace: TaskWorkspace): Promise<ReviewProvenance> {
  const detailed = await computeTaskStatusDetailed(
    workspace.services.dependencies, workspace.services.authority,
  );
  if (!detailed.ok) throw new Error(detailed.error.code);
  const evidence = detailed.value.status.evidence;
  if (evidence?.available !== true) throw new Error("status evidence unavailable");
  return evidence.counter_review_provenance as ReviewProvenance;
}

function markdownFilesUnder(root: string): readonly string[] {
  const collected: string[] = [];
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    const path = join(root, entry.name);
    if (entry.isDirectory()) collected.push(...markdownFilesUnder(path));
    else if (entry.isFile() && entry.name.endsWith(".md")) collected.push(path);
  }
  return collected;
}

/** Writes the PRD-tier client documents and applies the produce result, landing at the review offer. */
async function reachReviewOffer(
  workspace: TaskWorkspace,
  h: SemanticJourneyHarness,
  invocation: WorkflowInvocationV1 = { skill: "archflow-prd", intent: "resume" },
): Promise<ReturnType<SemanticJourneyHarness["status"]>> {
  writeFileSync(join(workspace.services.authority.task_root, "ask.md"), "Describe a small review-dispatch journey.\n");
  writeFileSync(join(workspace.services.authority.task_root, "prd.md"), "# Review dispatch\n\nThe client authors this document.\n");
  const offered = await h.status(invocation);
  expect(offered.next_action).toMatchObject({ kind: "submit-work", expected_submission: "work-result" });
  const produced = await h.apply(invocation, offered, { kind: "work-result", outcome: "succeeded" });
  expect(produced.ok, JSON.stringify(produced)).toBe(true);
  if (!produced.ok) throw new Error("produce could not be submitted");
  expect(produced.value.next_action).toMatchObject({ kind: "review", expected_submission: "review-dispatch" });
  return produced.value;
}

/**
 * Installs a scripted `codex` child whose first `failingDispatches` counter-review launches fail
 * with an unclassified process error, leaving the durable review boundary committed but the
 * dispatch unrun — the exact aftermath of a crash between the review substeps. Every
 * counter-review launch appends the model it was launched with so a test can observe the route
 * the server actually resolved.
 */
function installCrashingReviewStub(
  root: string,
  failingDispatches: number,
  options: Readonly<{ failing_role?: "counter-review" | "adjudication"; log_all_roles?: boolean }> = {},
): () => void {
  const failingRole = options.failing_role ?? "counter-review";
  const logAllRoles = options.log_all_roles ?? false;
  const bin = join(root, "crash-stub-bin");
  const stubHome = join(root, "crash-stub-home");
  const countPath = join(root, "crash-review-count");
  const modelsPath = join(root, "crash-review-models");
  mkdirSync(join(stubHome, ".codex"), { recursive: true });
  mkdirSync(bin, { recursive: true });
  writeFileSync(join(stubHome, ".codex", "auth.json"), "{}\n");
  writeFileSync(join(bin, "codex"), `#!/usr/bin/env node
import { appendFileSync, readFileSync, writeFileSync } from "node:fs";
const argv = process.argv.slice(2);
if (argv.length === 1 && argv[0] === "--version") process.stdout.write("codex-cli 0.146.0\\n");
else if (argv[0] === "login" && argv[1] === "status") process.stdout.write("Logged in using ChatGPT\\n");
else {
  const chunks = []; for await (const chunk of process.stdin) chunks.push(chunk);
  const envelope = JSON.parse(Buffer.concat(chunks).toString("utf8")); const subject = envelope.subject;
  const role = subject.role === "counter-review" ? "counter-review" : "adjudication";
  const model = argv[argv.indexOf("-m") + 1];
  if (${JSON.stringify(logAllRoles)}) appendFileSync(${JSON.stringify(modelsPath)}, role + ":" + model + "\\n");
  else if (role === "counter-review") appendFileSync(${JSON.stringify(modelsPath)}, model + "\\n");
  if (role === ${JSON.stringify(failingRole)}) {
    let count = 0; try { count = Number(readFileSync(${JSON.stringify(countPath)}, "utf8")); } catch {}
    writeFileSync(${JSON.stringify(countPath)}, String(count + 1));
    if (count < ${JSON.stringify(failingDispatches)}) {
      process.stderr.write("simulated reviewer CLI outage during dispatch\\n");
      process.exit(70);
    }
  }
  let output;
  if (role === "counter-review") {
    const assignment = envelope.assignment;
    output = { schema_version: "3", task_id: subject.task_id, phase_instance: subject.phase_instance,
      step: "counter_review", role: "counter-review", subject_digest: subject.subject_digest,
      input_fingerprint: subject.input_fingerprint, rubric_digest: subject.rubric_digest,
      producer_family: subject.producer_family, findings: [],
      ...(assignment?.legacy_confirmations === undefined ? {} : { legacy_confirmations: assignment.legacy_confirmations.map((confirmation) => ({
        finding_id: confirmation.finding_id, status: "resolved", evidence: "The revision intent is satisfied."
      })) }),
      ...(assignment !== undefined && Object.prototype.hasOwnProperty.call(assignment, "expected_upstream_digests")
        ? { upstream_alignment: assignment.expected_upstream_digests.map((digest) => ({ upstream_digest: digest,
            drift: "aligned", affected_claim_ids: [], rationale: "The artifact remains aligned with this approved upstream." })) }
        : {}) };
  } else {
    output = { schema_version: "2", judgments: Object.fromEntries(envelope.rules.map((rule) => [rule.slot, {
      compliance: "pass", rationale: "The document respects this rule.", trigger: "not-matched",
      trigger_evidence: "No review trigger matched."
    }])) };
  }
  writeFileSync(argv[argv.indexOf("-o") + 1], JSON.stringify(output) + "\\n");
  process.stdout.write('{"type":"turn.completed"}\\n');
}`);
  chmodSync(join(bin, "codex"), 0o755);
  const saved = { path: process.env.PATH, home: process.env.HOME };
  process.env.PATH = `${bin}:${saved.path ?? ""}`;
  process.env.HOME = stubHome;
  return () => {
    if (saved.path === undefined) delete process.env.PATH; else process.env.PATH = saved.path;
    if (saved.home === undefined) delete process.env.HOME; else process.env.HOME = saved.home;
  };
}

const launchedModels = (workspace: TaskWorkspace): readonly string[] =>
  readFileSync(join(workspace.root, "crash-review-models"), "utf8").split("\n").filter(Boolean);

/** Two codex counter-reviewers plus a codex constitution reviewer, all served by the one stub. */
function multiReviewerConfig(): Uint8Array {
  return new TextEncoder().encode(`schema_version: "1"
roles:
  counter-reviewer: { model: ${CONFIGURED_MODEL}, effort: ${CONFIGURED_EFFORT} }
  adjudicator: { model: ${CONFIGURED_MODEL}, effort: ${CONFIGURED_EFFORT} }
producers:
  claude:
    counter-reviewers:
      - { model: gpt-5.6-sol, effort: ${CONFIGURED_EFFORT} }
      - { model: gpt-5.6-fable, effort: ${CONFIGURED_EFFORT} }
    adjudicator: { model: gpt-5.6-adjudicator, effort: ${CONFIGURED_EFFORT} }
approval_rules:
  subjects: [prd]
  content: []
`);
}

/**
 * Config bytes that keep the PRD approval gate demanded by an approval rule: document-gate opening
 * is rule-driven, so a journey expecting the gate lists the prd subject explicitly. The roles stay
 * the template defaults this suite's configured-route assertions read.
 */
function prdApprovalConfig(): Uint8Array {
  return new TextEncoder().encode(`schema_version: "1"
roles:
  counter-reviewer: { model: ${CONFIGURED_MODEL}, effort: ${CONFIGURED_EFFORT} }
  adjudicator: { model: ${CONFIGURED_MODEL}, effort: ${CONFIGURED_EFFORT} }
approval_rules:
  subjects: [prd]
  content: []
`);
}

describe("reviewer route substitution through the public apply path", { timeout: TIMEOUT }, () => {
  it("rejects effort-selector substitution even for a historical effort failure", () => {
    const digest = parseSha256Digest("a".repeat(64));
    const state = {
      schema_version: "1", task_id: "effort-override", repository_identity_digest: digest,
      revision: 1, phase_instance: "phase-design-1", step: "counter_review", status: "running", attempt: 1,
      input_fingerprint: digest, initialization_digest: digest, config_digest: digest,
      workflow_digest: digest, constitution_digest: digest, policy_base_commit: "a".repeat(40),
      authoritative_results: [], approvals: [], waivers: [],
    } as unknown as TaskStateV1;
    const status = {
      task_id: state.task_id, state: "active", revision: state.revision,
      phase_instance: state.phase_instance, step: state.step, status: state.status, attempt: state.attempt,
      input_fingerprint: state.input_fingerprint, config: { verified: true }, blocking_reasons: [],
      next_action: { code: "run-step", detail: "Run review.", human_required: false, phase_instance: state.phase_instance, step: "counter_review" },
    };
    const base: SemanticStatusSnapshotV1 = {
      schema_version: "1", repository_identity_digest: digest, state,
      status: status as unknown as PlainJsonValue, full_findings: [],
      taxonomy_denial_rates: computeTaxonomyDenialRates([]),
      implementation_recommendation: unavailableImplementationRecommendation("not-applicable", "Fixture has no effort evidence."),
      reopen_impacts: [],
    };
    const invocation = { skill: "archflow-phase-design", phase: 1, intent: "resume" } as const;
    const submission = { kind: "review-dispatch", route_override: {
      reason: "the required Luna route is temporarily unavailable",
      "effort-reviewer": { model: "gpt-5.6-sol", effort: "high" },
    } } as const;
    const offer = projectSemanticStatus(base, invocation).view.next_action.offer!;
    const apply = (snapshot: SemanticStatusSnapshotV1) => planSemanticAction(snapshot, {
      schema_version: "1", task_id: state.task_id, invocation, action: { offer, submission },
    });
    expect(() => apply(base)).toThrow();

    const failed = structuredClone(base);
    (failed.status as Record<string, unknown>).dispatch_failure = {
      role: "effort-reviewer", code: "AUTH_UNAVAILABLE", message: "The required reviewer authentication is unavailable.",
      route: { model: "gpt-5.6-luna", effort: "xhigh", source: "configured" },
    };
    const failedOffer = projectSemanticStatus(failed, invocation).view.next_action.offer!;
    expect(() => planSemanticAction(failed, {
      schema_version: "1", task_id: state.task_id, invocation, action: { offer: failedOffer, submission },
    })).toThrow();
  });

  it("dispatches and attests an invocation-declared route without minting human override trust", async () => {
    const workspace = await createTaskWorkspace({
      taskId: "review-invocation-route", label: "review-invocation-route", configBytes: prdApprovalConfig(),
    });
    workspaces.push(workspace);
    restorers.push(installSemanticReviewStub(workspace.root, [[]]));
    const h = semanticJourneyHarness(workspace);
    const invocation = {
      skill: "archflow-prd",
      intent: "resume",
      review_routes: { "counter-reviewer": { model: "gpt-5.6-invocation", effort: "high" } },
    } as const;
    const atReview = await reachReviewOffer(workspace, h, invocation);

    const reviewed = await h.apply(invocation, atReview);
    expect(reviewed.ok, JSON.stringify(reviewed)).toBe(true);
    if (!reviewed.ok) return;
    const evidence = await retainedReviewEvidence(workspace, await freshState(workspace));
    expect(evidence).toMatchObject({
      model: "gpt-5.6-invocation",
      effort: "high",
      route_source: {
        provenance: "invocation-declared",
        displaced: { source: "configured", model: CONFIGURED_MODEL, effort: CONFIGURED_EFFORT },
      },
    });
    expect(evidence.route_override).toBeUndefined();
    expect(await statusProvenance(workspace)).toMatchObject({
      adapter: "codex-cli",
      model: "gpt-5.6-invocation",
      route_source: { provenance: "invocation-declared" },
    });
  });

  it("dispatches the substituted route from a review-dispatch submission and records the override with its human reason", async () => {
    const workspace = await createTaskWorkspace({
      taskId: "review-dispatch-clean", label: "review-dispatch-clean", configBytes: prdApprovalConfig(),
    });
    workspaces.push(workspace);
    restorers.push(installSemanticReviewStub(workspace.root, [[]]));
    const h = semanticJourneyHarness(workspace);
    const invocation = { skill: "archflow-prd", intent: "resume" } as const;
    const atReview = await reachReviewOffer(workspace, h);

    const reviewed = await h.apply(invocation, atReview, SUBMISSION);
    expect(reviewed.ok, JSON.stringify(reviewed)).toBe(true);
    if (!reviewed.ok) return;
    expect(reviewed.value.findings ?? []).toEqual([]);
    expect(reviewed.value.next_action, JSON.stringify(reviewed.value)).toMatchObject({ kind: "decide", expected_submission: "gate-summary" });

    // The retained evidence records the substitute that actually reviewed and the pin it
    // displaced, with the human's reason for the substitution.
    const state = await freshState(workspace);
    const evidence = await retainedReviewEvidence(workspace, state);
    expect(evidence.model).toBe(SUBSTITUTION["counter-reviewer"].model);
    expect(evidence.effort).toBe(SUBSTITUTION["counter-reviewer"].effort);
    expect(evidence.route_override).toEqual({
      reason: SUBSTITUTION.reason,
      pinned_model: CONFIGURED_MODEL,
      pinned_effort: CONFIGURED_EFFORT,
    });
    expect(evidence.route_source).toEqual({
      provenance: "route-override",
      displaced: {
        source: "configured",
        model: CONFIGURED_MODEL,
        effort: CONFIGURED_EFFORT,
      },
    });
    // The rendered retained evidence keeps the deviation legible for the human at the gate.
    const rendered = markdownFilesUnder(join(workspace.root, ".archflow", "runtime"))
      .map((path) => readFileSync(path, "utf8"))
      .find((bytes) => bytes.includes("## Route Override"));
    expect(rendered).toContain(SUBSTITUTION.reason);
    expect(rendered).toContain(CONFIGURED_MODEL);

    // Status provenance carries the same record wherever the evidence is presented.
    expect(await statusProvenance(workspace)).toMatchObject({
      model: SUBSTITUTION["counter-reviewer"].model,
      adapter: "codex-cli",
      route_source: {
        provenance: "route-override",
        displaced: { source: "configured", model: CONFIGURED_MODEL },
      },
      route_override: { reason: SUBSTITUTION.reason, pinned_model: CONFIGURED_MODEL },
    });
  });

  it("recovers a crash between the review substeps on the configured route when the submission value is lost", async () => {
    const workspace = await createTaskWorkspace({
      taskId: "review-dispatch-crash", label: "review-dispatch-crash", configBytes: prdApprovalConfig(),
    });
    workspaces.push(workspace);
    restorers.push(installCrashingReviewStub(workspace.root, 1));
    const h = semanticJourneyHarness(workspace);
    const invocation = { skill: "archflow-prd", intent: "resume" } as const;
    const atReview = await reachReviewOffer(workspace, h);

    // The substituted apply commits its review-enter boundary, then the dispatch dies — the
    // durable aftermath of a crash between the two substeps.
    const crashed = await h.apply(invocation, atReview, SUBMISSION);
    expect(crashed.ok).toBe(false);
    if (crashed.ok) return;
    expect(crashed.error).toMatchObject({ retryable: false });
    const boundary = await freshState(workspace);
    expect(boundary).toMatchObject({ step: "counter_review", status: "running" });
    const boundaryIdentity = parseSemanticSubstepIntentId(boundary.last_transition!.intent_id);
    expect(boundaryIdentity.substep).toBe("review-enter");

    // The review action is re-offered; recovery carries no submission, so the operation digest
    // recovered from the boundary binds the original request while its value is gone: the
    // dispatch runs under the configured route.
    const reoffered = await h.status(invocation);
    expect(reoffered.next_action).toMatchObject({ kind: "review", expected_submission: "review-dispatch" });
    const recovered = await h.apply(invocation, reoffered);
    expect(recovered.ok, JSON.stringify(recovered)).toBe(true);
    if (!recovered.ok) return;
    expect(recovered.value.findings ?? []).toEqual([]);

    expect(launchedModels(workspace)).toEqual([
      SUBSTITUTION["counter-reviewer"].model,
      CONFIGURED_MODEL,
    ]);
    const state = await freshState(workspace);
    const evidence = await retainedReviewEvidence(workspace, state);
    expect(evidence.model).toBe(CONFIGURED_MODEL);
    // No override applied, so none is reported — the record never claims a substitution that did not run.
    expect(evidence.route_override).toBeUndefined();
    const plainProvenance = await statusProvenance(workspace);
    expect(plainProvenance).toMatchObject({ model: CONFIGURED_MODEL });
    expect(plainProvenance.route_override).toBeUndefined();
    // The recovery stayed on the operation the crashed apply authenticated.
    expect(parseSemanticSubstepIntentId(state.last_transition!.intent_id)).toMatchObject({
      operation_digest: boundaryIdentity.operation_digest,
      substep: "review-empty-triage",
    });
  });

  it("re-requesting the substitution on the re-offered review action proceeds as a fresh request under the recovered operation", async () => {
    const workspace = await createTaskWorkspace({
      taskId: "review-dispatch-resend", label: "review-dispatch-resend", configBytes: prdApprovalConfig(),
    });
    workspaces.push(workspace);
    restorers.push(installCrashingReviewStub(workspace.root, 1));
    const h = semanticJourneyHarness(workspace);
    const invocation = { skill: "archflow-prd", intent: "resume" } as const;
    const atReview = await reachReviewOffer(workspace, h);

    const crashed = await h.apply(invocation, atReview, SUBMISSION);
    expect(crashed.ok).toBe(false);
    if (crashed.ok) return;
    const boundary = await freshState(workspace);
    const boundaryIdentity = parseSemanticSubstepIntentId(boundary.last_transition!.intent_id);

    // The resent declaration authenticates at request level: the operation identity stays the
    // recovered one, and the composed request — carrying the override — passes the pre-dispatch
    // replay probe as a genuinely new intent instead of a replay of the crashed attempt.
    const reoffered = await h.status(invocation);
    const resent = await h.apply(invocation, reoffered, SUBMISSION);
    expect(resent.ok, JSON.stringify(resent)).toBe(true);
    if (!resent.ok) return;
    expect(resent.value.findings ?? []).toEqual([]);
    expect(resent.value.next_action, JSON.stringify(resent.value)).toMatchObject({ kind: "decide", expected_submission: "gate-summary" });

    expect(launchedModels(workspace)).toEqual([
      SUBSTITUTION["counter-reviewer"].model,
      SUBSTITUTION["counter-reviewer"].model,
    ]);
    const state = await freshState(workspace);
    const evidence = await retainedReviewEvidence(workspace, state);
    expect(evidence.model).toBe(SUBSTITUTION["counter-reviewer"].model);
    expect(evidence.route_override).toEqual({
      reason: SUBSTITUTION.reason,
      pinned_model: CONFIGURED_MODEL,
      pinned_effort: CONFIGURED_EFFORT,
    });
    expect(await statusProvenance(workspace)).toMatchObject({
      model: SUBSTITUTION["counter-reviewer"].model,
      route_override: { reason: SUBSTITUTION.reason },
    });
    // The whole recovered review action — resent request included — ran under the operation
    // identity the crashed apply had already authenticated.
    expect(parseSemanticSubstepIntentId(state.last_transition!.intent_id)).toMatchObject({
      operation_digest: boundaryIdentity.operation_digest,
      substep: "review-empty-triage",
    });
  });
  it("retries only the child that failed when its siblings' outputs were valid", async () => {
    const workspace = await createTaskWorkspace({
      taskId: "review-partial-retry", label: "review-partial-retry", configBytes: multiReviewerConfig(),
    });
    workspaces.push(workspace);
    restorers.push(installCrashingReviewStub(workspace.root, 1, { failing_role: "adjudication", log_all_roles: true }));
    const h = semanticJourneyHarness(workspace);
    const invocation = { skill: "archflow-prd", intent: "resume" } as const;
    const atReview = await reachReviewOffer(workspace, h);

    // Both rubric reviewers answer; the constitution child dies. The round fails, but the two
    // valid outputs are retained for the identical envelope the retry will re-seal.
    const crashed = await h.apply(invocation, atReview);
    expect(crashed.ok).toBe(false);
    expect(await freshState(workspace)).toMatchObject({ step: "counter_review", status: "running" });
    const firstRound = launchedModels(workspace);
    expect([...firstRound].sort()).toEqual([
      "adjudication:gpt-5.6-adjudicator",
      "counter-review:gpt-5.6-fable",
      "counter-review:gpt-5.6-sol",
    ]);
    const attempts = join(workspace.services.authority.workspace_root, "diagnostics", "attempts", "prd");
    expect(readdirSync(attempts).filter((name) => name.startsWith("round-"))).toHaveLength(2);

    const reoffered = await h.status(invocation);
    expect(reoffered.next_action).toMatchObject({ kind: "review" });
    const recovered = await h.apply(invocation, reoffered);
    expect(recovered.ok, JSON.stringify(recovered)).toBe(true);

    // Only the constitution child ran again; the reviewers' retained outputs were reused.
    expect(launchedModels(workspace).slice(firstRound.length)).toEqual(["adjudication:gpt-5.6-adjudicator"]);
    const state = await freshState(workspace);
    const evidence = await retainedReviewEvidence(workspace, state);
    expect(evidence.model).toBe("gpt-5.6-sol");
    expect(readdirSync(attempts).filter((name) => name.startsWith("round-"))).toHaveLength(0);
  });
});

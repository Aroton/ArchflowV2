import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import type { TaskStateV1 } from "../../src/contracts/durable-state.js";
import type { ServerAttestedReview } from "../../src/contracts/review.js";
import type { WorkflowInvocationV1 } from "../../src/contracts/semantic-workflow.js";
import { loadRetainedEvidence } from "../../src/state/evidence-results.js";
import { readTaskState } from "../../src/state/read.js";
import {
  semanticJourneyHarness,
  type SemanticJourneyHarness,
} from "../helpers/semantic-journeys.js";
import { createTaskWorkspace, type TaskWorkspace } from "../helpers/task-workspace.js";

const TIMEOUT = 180_000;
const CONFIGURED_MODEL = "gpt-5.6-configured";
const INVOCATION_MODEL = "gpt-5.6-invocation";
const CLAUDE_INVOCATION_MODEL = "claude-fable-5";
const workspaces: TaskWorkspace[] = [];
const restorers: (() => void)[] = [];

afterEach(() => {
  for (const restore of restorers.splice(0)) restore();
  for (const workspace of workspaces.splice(0)) workspace.dispose();
});

const configBytes = () => new TextEncoder().encode(`schema_version: "1"
roles:
  counter-reviewer: { model: ${CONFIGURED_MODEL}, effort: xhigh }
  adjudicator: { model: gpt-5.6-adjudicator, effort: high }
approval_rules:
  subjects: [prd]
  content: []
`);

async function currentState(workspace: TaskWorkspace): Promise<TaskStateV1> {
  const read = await readTaskState(workspace.services.authority.state);
  if (read.kind !== "canonical") throw new Error("task state unavailable");
  return read.document.value;
}

async function retainedReview(workspace: TaskWorkspace): Promise<ServerAttestedReview> {
  const state = await currentState(workspace);
  const loaded = await loadRetainedEvidence(
    { load_retained_manifest: workspace.services.dependencies.load_retained_manifest! },
    structuredClone(state),
    state.phase_instance,
  );
  if (!loaded.ok) throw new Error(loaded.error.code);
  const source = loaded.value.get("counter_review")?.manifest.source_artifact;
  if (source?.artifact_kind !== "review-evidence" || source.evidence.assurance !== "server-attested") {
    throw new Error("server-attested review unavailable");
  }
  return source.evidence;
}

async function reachReview(
  workspace: TaskWorkspace,
  harness: SemanticJourneyHarness,
  invocation: WorkflowInvocationV1,
) {
  writeFileSync(join(workspace.services.authority.task_root, "ask.md"), "Describe invocation routing.\n");
  writeFileSync(join(workspace.services.authority.task_root, "prd.md"), "# Invocation routing\n\nReview this document.\n");
  const offered = await harness.status(invocation);
  expect(offered.next_action).toMatchObject({ kind: "submit-work", expected_submission: "work-result" });
  const produced = await harness.apply(invocation, offered, { kind: "work-result", outcome: "succeeded" });
  expect(produced.ok, JSON.stringify(produced)).toBe(true);
  if (!produced.ok) throw new Error("produce failed");
  expect(produced.value.next_action).toMatchObject({ kind: "review", expected_submission: "review-dispatch" });
  return produced.value;
}

/** A real process boundary that records every selected model and can fail initial review launches. */
function installRecordingReviewer(workspace: TaskWorkspace, failFirst = 0): void {
  const bin = join(workspace.root, "invocation-route-bin");
  const stubHome = join(workspace.root, "invocation-route-home");
  const countPath = join(workspace.root, "invocation-route-count");
  const modelPath = join(workspace.root, "invocation-route-models");
  const routePath = join(workspace.root, "invocation-routes");
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
  let output;
  if (subject.role === "counter-review") {
    let count = 0; try { count = Number(readFileSync(${JSON.stringify(countPath)}, "utf8")); } catch {}
    writeFileSync(${JSON.stringify(countPath)}, String(count + 1));
    appendFileSync(${JSON.stringify(modelPath)}, argv[argv.indexOf("-m") + 1] + "\\n");
    if (count < ${JSON.stringify(failFirst)}) process.exit(70);
    const assignment = envelope.assignment;
    output = { schema_version: "3", task_id: subject.task_id, phase_instance: subject.phase_instance,
      step: "counter_review", role: "counter-review", subject_digest: subject.subject_digest,
      input_fingerprint: subject.input_fingerprint, rubric_digest: subject.rubric_digest,
      producer_family: subject.producer_family, findings: [],
      ...(assignment?.legacy_confirmations === undefined ? {} : { legacy_confirmations: assignment.legacy_confirmations.map((confirmation) => ({ finding_id: confirmation.finding_id, status: "resolved", evidence: "The revision intent is satisfied." })) }),
      ...(assignment !== undefined && Object.prototype.hasOwnProperty.call(assignment, "expected_upstream_digests")
        ? { upstream_alignment: assignment.expected_upstream_digests.map((digest) => ({ upstream_digest: digest, drift: "aligned", affected_claim_ids: [], rationale: "The artifact remains aligned with this approved upstream." })) }
        : {}) };
  } else {
    output = { schema_version: "2", judgments: Object.fromEntries(envelope.rules.map((rule) => [rule.slot, {
      compliance: "pass", rationale: "The rule is satisfied.", trigger: "not-matched",
      trigger_evidence: "No review trigger matched."
    }])) };
  }
  writeFileSync(argv[argv.indexOf("-o") + 1], JSON.stringify(output) + "\\n");
  process.stdout.write('{"type":"turn.completed"}\\n');
}`);
  chmodSync(join(bin, "codex"), 0o755);
  writeFileSync(join(bin, "claude"), `#!/usr/bin/env node
import { appendFileSync } from "node:fs";
const argv = process.argv.slice(2);
if (argv.length === 1 && argv[0] === "--version") process.stdout.write("2.1.220 (Claude Code)\\n");
else if (argv[0] === "auth" && argv[1] === "status") process.stdout.write('{"loggedIn":true}\\n');
else {
  const chunks = []; for await (const chunk of process.stdin) chunks.push(chunk);
  const envelope = JSON.parse(Buffer.concat(chunks).toString("utf8")); const subject = envelope.subject;
  let output;
  if (subject.role === "counter-review") {
    appendFileSync(${JSON.stringify(routePath)}, argv[argv.indexOf("--model") + 1] + "\\t" + argv[argv.indexOf("--effort") + 1] + "\\n");
    const assignment = envelope.assignment;
    output = { schema_version: "3", task_id: subject.task_id, phase_instance: subject.phase_instance,
      step: "counter_review", role: "counter-review", subject_digest: subject.subject_digest,
      input_fingerprint: subject.input_fingerprint, rubric_digest: subject.rubric_digest,
      producer_family: subject.producer_family, findings: [],
      ...(assignment?.legacy_confirmations === undefined ? {} : { legacy_confirmations: assignment.legacy_confirmations.map((confirmation) => ({ finding_id: confirmation.finding_id, status: "resolved", evidence: "The revision intent is satisfied." })) }),
      ...(assignment !== undefined && Object.prototype.hasOwnProperty.call(assignment, "expected_upstream_digests")
        ? { upstream_alignment: assignment.expected_upstream_digests.map((digest) => ({ upstream_digest: digest, drift: "aligned", affected_claim_ids: [], rationale: "The artifact remains aligned with this approved upstream." })) }
        : {}) };
  } else {
    output = { schema_version: "2", judgments: Object.fromEntries(envelope.rules.map((rule) => [rule.slot, {
      compliance: "pass", rationale: "The rule is satisfied.", trigger: "not-matched",
      trigger_evidence: "No review trigger matched."
    }])) };
  }
  process.stdout.write(JSON.stringify({ structured_output: output }));
}`);
  chmodSync(join(bin, "claude"), 0o755);
  const saved = { path: process.env.PATH, home: process.env.HOME };
  process.env.PATH = `${bin}:${saved.path ?? ""}`;
  process.env.HOME = stubHome;
  restorers.push(() => {
    if (saved.path === undefined) delete process.env.PATH; else process.env.PATH = saved.path;
    if (saved.home === undefined) delete process.env.HOME; else process.env.HOME = saved.home;
  });
}

const launchedModels = (workspace: TaskWorkspace): readonly string[] => {
  const path = join(workspace.root, "invocation-route-models");
  return existsSync(path) ? readFileSync(path, "utf8").split("\n").filter(Boolean) : [];
};

const launchedRoutes = (workspace: TaskWorkspace): readonly string[] => {
  const path = join(workspace.root, "invocation-routes");
  return existsSync(path) ? readFileSync(path, "utf8").split("\n").filter(Boolean) : [];
};

async function setup(taskId: string, failFirst = 0) {
  const workspace = await createTaskWorkspace({ taskId, label: taskId, configBytes: configBytes() });
  workspaces.push(workspace);
  installRecordingReviewer(workspace, failFirst);
  return { workspace, harness: semanticJourneyHarness(workspace) };
}

describe("invocation review routes", { timeout: TIMEOUT }, () => {
  it("uses a role's invocation route and attests actual adapter/model/effort and displaced configuration", async () => {
    const { workspace, harness } = await setup("invocation-route-selected");
    const invocation = {
      skill: "archflow-prd", intent: "resume",
      review_routes: { "counter-reviewer": { model: INVOCATION_MODEL, effort: "high" } },
    } as const;
    const atReview = await reachReview(workspace, harness, invocation);
    const reviewed = await harness.apply(invocation, atReview);
    expect(reviewed.ok, JSON.stringify(reviewed)).toBe(true);
    if (!reviewed.ok) return;
    expect(launchedModels(workspace)).toEqual([INVOCATION_MODEL]);
    expect(await retainedReview(workspace)).toMatchObject({
      adapter: "codex-cli", model_family: "codex", model: INVOCATION_MODEL, effort: "high",
      route_source: {
        provenance: "invocation-declared",
        displaced: { source: "configured", model: CONFIGURED_MODEL, effort: "xhigh" },
      },
    });
    expect((await retainedReview(workspace)).route_override).toBeUndefined();
  });

  it("falls back independently to configuration for an invocation-omitted role", async () => {
    const { workspace, harness } = await setup("invocation-route-fallback");
    const invocation = {
      skill: "archflow-prd", intent: "resume",
      review_routes: { adjudicator: { model: "gpt-5.6-invocation-adjudicator", effort: "high" } },
    } as const;
    const atReview = await reachReview(workspace, harness, invocation);
    const reviewed = await harness.apply(invocation, atReview);
    expect(reviewed.ok, JSON.stringify(reviewed)).toBe(true);
    if (!reviewed.ok) return;
    expect(launchedModels(workspace)).toEqual([CONFIGURED_MODEL]);
    expect(await retainedReview(workspace)).toMatchObject({
      model: CONFIGURED_MODEL,
      route_source: { provenance: "configured" },
    });
  });

  it("reuses the identical invocation route after a failed dispatch continuation", async () => {
    const { workspace, harness } = await setup("invocation-route-reuse", 1);
    const invocation = {
      skill: "archflow-prd", intent: "resume",
      review_routes: { "counter-reviewer": { model: INVOCATION_MODEL, effort: "high" } },
    } as const;
    const atReview = await reachReview(workspace, harness, invocation);
    const failed = await harness.apply(invocation, atReview);
    expect(failed.ok).toBe(false);
    const reoffered = await harness.status(invocation);
    expect(reoffered.next_action).toMatchObject({ kind: "review" });
    const retried = await harness.apply(invocation, reoffered);
    expect(retried.ok, JSON.stringify(retried)).toBe(true);
    expect(launchedModels(workspace)).toEqual([INVOCATION_MODEL, INVOCATION_MODEL]);
    expect(await retainedReview(workspace)).toMatchObject({
      model: INVOCATION_MODEL,
      route_source: { provenance: "invocation-declared" },
    });
  });

  it("reuses an exact claude invocation route after a significant human revision", async () => {
    const { workspace, harness } = await setup("invocation-route-significant-revision");
    const invocation = {
      skill: "archflow-prd", intent: "resume",
      review_routes: { "counter-reviewer": { model: CLAUDE_INVOCATION_MODEL, effort: "high" } },
    } as const;
    const atReview = await reachReview(workspace, harness, invocation);
    const reviewed = await harness.apply(invocation, atReview);
    expect(reviewed.ok, JSON.stringify(reviewed)).toBe(true);
    if (!reviewed.ok) return;
    expect(reviewed.value.next_action).toMatchObject({ kind: "decide", expected_submission: "gate-summary" });
    const opened = await harness.apply(invocation, reviewed.value, {
      kind: "gate-summary", summary: "The first route review is ready for a human decision.",
    });
    expect(opened.ok, JSON.stringify(opened)).toBe(true);
    if (!opened.ok) return;
    const revised = await harness.apply(invocation, opened.value, {
      kind: "decision", choice: "request-changes", reason: "Exercise significant revision route continuity.",
    });
    expect(revised.ok, JSON.stringify(revised)).toBe(true);
    if (!revised.ok) return;
    expect(revised.value.next_action).toMatchObject({ kind: "revise" });
    const entered = await harness.apply(invocation, revised.value);
    expect(entered.ok, JSON.stringify(entered)).toBe(true);
    if (!entered.ok) return;
    expect(entered.value.next_action).toMatchObject({ kind: "submit-work", expected_submission: "work-result" });

    const prdPath = join(workspace.services.authority.task_root, "prd.md");
    writeFileSync(prdPath, `${readFileSync(prdPath, "utf8")}\nThe revised PRD preserves its invocation route.\n`);
    const reproduced = await harness.apply(invocation, entered.value, {
      kind: "work-result", outcome: "succeeded",
      human_revision: {
        classification: "significant",
        rationale: "The requested change materially revises the reviewed PRD.",
      },
    });
    expect(reproduced.ok, JSON.stringify(reproduced)).toBe(true);
    if (!reproduced.ok) return;
    expect(reproduced.value.next_action).toMatchObject({ kind: "review" });
    const rereviewed = await harness.apply(invocation, reproduced.value);
    expect(rereviewed.ok, JSON.stringify(rereviewed)).toBe(true);
    expect(launchedRoutes(workspace)).toEqual([
      `${CLAUDE_INVOCATION_MODEL}\thigh`,
      `${CLAUDE_INVOCATION_MODEL}\thigh`,
    ]);
    expect(await retainedReview(workspace)).toMatchObject({
      adapter: "claude-cli", model_family: "claude", model: CLAUDE_INVOCATION_MODEL, effort: "high",
      route_source: {
        provenance: "invocation-declared",
        displaced: { source: "configured", model: CONFIGURED_MODEL, effort: "xhigh" },
      },
    });
  });

  it("fails an invalid selected invocation route without launching or falling back", async () => {
    const { workspace, harness } = await setup("invocation-route-invalid");
    const invocation = {
      skill: "archflow-prd", intent: "resume",
      review_routes: { "counter-reviewer": { model: "unsupported-model", effort: "high" } },
    } as const;
    const atReview = await reachReview(workspace, harness, invocation);
    const failed = await harness.apply(invocation, atReview);
    expect(failed.ok).toBe(false);
    if (failed.ok) return;
    expect(failed.error).toMatchObject({ code: "CONFIG_MODEL_UNSUPPORTED" });
    expect(launchedModels(workspace)).toEqual([]);
    expect(failed.view).toBeDefined();
    expect(failed.view!.dispatch_failure).toMatchObject({
      role: "counter-reviewer",
      code: "CONFIG_MODEL_UNSUPPORTED",
      route: { model: "unsupported-model", effort: "high", source: "invocation-declared" },
    });
    expect(failed.view!.next_action).toMatchObject({ kind: "review", expected_submission: "review-dispatch" });
  });
});

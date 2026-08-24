import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";

import type {
  ApplySubmissionV1,
  WorkflowInvocationV1,
  WorkflowViewV1,
} from "../../src/contracts/semantic-workflow.js";
import {
  buildAutomationLocalBundle,
  invocationFromAutomation,
  runAutomationStatus,
  snapshotDirectory,
  type AutomationObservation,
} from "../helpers/automation-status.js";
import {
  installSemanticReviewStub,
  reachImplementationHandoff,
  semanticJourneyHarness,
  type SemanticJourneyHarness,
} from "../helpers/semantic-journeys.js";
import { createTaskWorkspace, type TaskWorkspace } from "../helpers/task-workspace.js";

const TIMEOUT = 180_000;
const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const workspaces: TaskWorkspace[] = [];
const restorers: (() => void)[] = [];
let bundleRoot = "";
let localBundle = "";

const noApprovalRules = new TextEncoder().encode(`schema_version: "1"
roles:
  counter-reviewer: { model: gpt-5.6-sol, effort: xhigh }
  adjudicator: { model: gpt-5.6-sol, effort: xhigh }
approval_rules:
  subjects: []
  content: []
`);

function approvalSubjects(...subjects: readonly string[]): Uint8Array {
  return new TextEncoder().encode(`schema_version: "1"
roles:
  counter-reviewer: { model: gpt-5.6-sol, effort: xhigh }
  adjudicator: { model: gpt-5.6-sol, effort: xhigh }
approval_rules:
  subjects: [${subjects.join(", ")}]
  content: []
`);
}

beforeAll(async () => {
  bundleRoot = await mkdtemp(join(tmpdir(), "archflow-controller-loop-bundle-"));
  localBundle = join(bundleRoot, "archflow-local.mjs");
  buildAutomationLocalBundle(repositoryRoot, localBundle);
}, TIMEOUT);

afterEach(() => {
  for (const restore of restorers.splice(0)) restore();
  for (const workspace of workspaces.splice(0)) workspace.dispose();
});

afterAll(async () => {
  if (bundleRoot !== "") await rm(bundleRoot, { recursive: true, force: true });
});

function gitAt(workspace: TaskWorkspace, ...arguments_: readonly string[]): string {
  return execFileSync("git", [...arguments_], { cwd: workspace.root, encoding: "utf8" }).trim();
}

function commitReturnedFacts(workspace: TaskWorkspace, view: WorkflowViewV1): void {
  const commit = view.next_action.commit;
  if (commit === undefined) throw new Error("producer did not return authenticated commit facts");
  execFileSync("git", ["add", "-A", "--", ...commit.paths], { cwd: workspace.root });
  execFileSync("git", [
    "-c", "user.name=ArchFlow Test", "-c", "user.email=test@example.invalid",
    "commit", "-q", "-m", commit.message, "--", ...commit.paths,
  ], { cwd: workspace.root });
}

async function applyOk(
  harness: SemanticJourneyHarness,
  invocation: WorkflowInvocationV1,
  view: WorkflowViewV1,
  submission?: ApplySubmissionV1,
): Promise<WorkflowViewV1> {
  const result = await harness.apply(invocation, view, submission);
  if (!result.ok) throw new Error(JSON.stringify(result.error));
  return result.value;
}

function observe(workspace: TaskWorkspace): AutomationObservation {
  const result = runAutomationStatus(localBundle, workspace.root, workspace.taskId);
  expect(result.status, result.stderr).toBe(0);
  if (result.observation === undefined) throw new Error("automation observation unavailable");
  return result.observation;
}

function currentArtifact(workspace: TaskWorkspace, view: WorkflowViewV1): string {
  const resource = view.resources.find((candidate) => candidate.role === "current-artifact");
  if (resource === undefined) throw new Error("current artifact resource unavailable");
  return join(workspace.root, resource.path);
}

function excludeReviewFixtures(workspace: TaskWorkspace): void {
  const exclude = join(workspace.root, ".git", "info", "exclude");
  mkdirSync(dirname(exclude), { recursive: true });
  writeFileSync(exclude, "semantic-stub-bin/\nsemantic-stub-home/\nsemantic-review-count\n");
}

describe("automation status controller loop", { timeout: TIMEOUT }, () => {
  it("reaches complete by launching and resuming only returned descriptors", async () => {
    const workspace = await createTaskWorkspace({
      taskId: "automation-clean-loop",
      label: "automation-clean-loop",
      configBytes: noApprovalRules,
    });
    workspaces.push(workspace);
    excludeReviewFixtures(workspace);
    restorers.push(installSemanticReviewStub(workspace.root, [[], [], [], []]));
    const harness = semanticJourneyHarness(workspace);
    writeFileSync(join(workspace.services.authority.task_root, "ask.md"), "Build the descriptor-driven controller fixture.\n");
    writeFileSync(join(workspace.services.authority.task_root, "prd.md"), "# Controller fixture\n\nComplete one automatic phase.\n");

    const launched: string[] = [];
    const observations: AutomationObservation[] = [];
    let status = observe(workspace);

    while (status.condition !== "complete") {
      expect(status.condition).toMatch(/^(awaiting-client|ready)$/u);
      expect(status.next_action.actor).toMatch(/^(skill|orchestrator)$/u);
      expect(status).not.toHaveProperty("human_boundary");
      expect(status).not.toHaveProperty("blocked");
      observations.push(status);
      const action = status.next_action;
      if (action.actor !== "skill" && action.actor !== "orchestrator") {
        throw new Error(`controller cannot launch automation actor ${action.actor}`);
      }
      const invocation = invocationFromAutomation(status);
      launched.push(`${action.skill}:${(action.skill_args ?? []).join(",")}`);

      let view = await harness.status(invocation);
      switch (action.skill) {
        case "archflow-prd": {
          view = await applyOk(harness, invocation, view, { kind: "work-result", outcome: "succeeded" });
          expect(observe(workspace).next_action).toMatchObject({
            actor: "skill", kind: "continue-skill", skill: action.skill, skill_args: action.skill_args,
          });
          view = await applyOk(harness, invocation, view);
          expect(view.next_action).toMatchObject({ kind: "start-next-skill", skill: "archflow-design" });
          break;
        }
        case "archflow-design": {
          view = await applyOk(harness, invocation, view);
          writeFileSync(currentArtifact(workspace, view), "# Design\n\n### Phase 1: Descriptor-driven behavior\n\nImplement and verify one phase.\n");
          view = await applyOk(harness, invocation, view, { kind: "work-result", outcome: "succeeded" });
          view = await applyOk(harness, invocation, view);
          expect(view.next_action.kind).toBe("commit");
          commitReturnedFacts(workspace, view);
          break;
        }
        case "archflow-phase-design": {
          view = await applyOk(harness, invocation, view);
          const phase = action.skill_args?.[0];
          const phaseArtifact = currentArtifact(workspace, view);
          mkdirSync(dirname(phaseArtifact), { recursive: true });
          writeFileSync(phaseArtifact, `# Phase ${phase}: Descriptor-driven behavior

## Goal

Implement one controller-loop fixture.

## Requirements

- Preserve returned workflow ownership.

## Files

- \`src/controller-loop-fixture.ts\`: representative output.

## Work Chunks

### Controller behavior

Implement and verify the fixture.

## Pinned Cross-Chunk Interfaces

The automation descriptor is the only source of the phase argument.

## Success Criteria

The final task reaches complete.

## Executable Verification

- \`npm run typecheck\`
`);
          view = await applyOk(harness, invocation, view, { kind: "work-result", outcome: "succeeded" });
          view = await applyOk(harness, invocation, view);
          expect(view.next_action.kind).toBe("commit");
          commitReturnedFacts(workspace, view);
          break;
        }
        case "archflow-phase-impl": {
          view = await applyOk(harness, invocation, view);
          const artifact = view.resources.find((candidate) => candidate.role === "current-artifact");
          const transcript = view.resources.find((candidate) => candidate.role === "verification-transcript");
          if (artifact === undefined || transcript === undefined) throw new Error("implementation resources unavailable");
          const sourcePath = "src/controller-loop-fixture.ts";
          mkdirSync(join(workspace.root, "src"), { recursive: true });
          writeFileSync(join(workspace.root, sourcePath), "export const descriptorDriven = true;\n");
          mkdirSync(dirname(join(workspace.root, artifact.path)), { recursive: true });
          writeFileSync(join(workspace.root, artifact.path), `# Implementation Log: Phase ${action.skill_args?.[0]} - Descriptor-driven behavior

## Verification

- The representative fixture passed.
`);
          mkdirSync(dirname(join(workspace.root, transcript.path)), { recursive: true });
          writeFileSync(join(workspace.root, transcript.path), "$ npm run typecheck\n\nTest fixture: passed\n");
          view = await applyOk(harness, invocation, view, {
            kind: "work-result",
            outcome: "succeeded",
            implementation: {
              base_commit: gitAt(workspace, "rev-parse", "HEAD"),
              outputs: [artifact.path, sourcePath].sort(),
              restore_targets: [artifact.path, sourcePath].sort(),
              declared_inputs: [],
            },
          });
          view = await applyOk(harness, invocation, view);
          expect(view.next_action.kind).toBe("commit");

          const beforeCommit = observe(workspace);
          const inertBytes = snapshotDirectory(join(workspace.root, ".archflow"));
          const repeated = observe(workspace);
          expect(repeated).toEqual(beforeCommit);
          expect(snapshotDirectory(join(workspace.root, ".archflow"))).toEqual(inertBytes);

          commitReturnedFacts(workspace, view);
          const afterCommit = observe(workspace);
          expect(afterCommit.observation_id).not.toBe(beforeCommit.observation_id);
          expect(afterCommit.next_action).toMatchObject({
            actor: "skill", kind: "continue-skill", skill: "archflow-phase-impl", skill_args: action.skill_args,
          });
          view = await harness.status(invocation);
          expect(view.next_action.kind).toBe("finish-task");
          await applyOk(harness, invocation, view);
          break;
        }
        default:
          throw new Error(`controller received unsupported producer ${String(action.skill)}`);
      }

      status = observe(workspace);
    }

    expect(status).toMatchObject({
      condition: "complete",
      next_action: { actor: "none", kind: "none" },
    });
    expect(launched).toEqual([
      "archflow-prd:",
      "archflow-design:",
      "archflow-phase-design:1",
      "archflow-phase-impl:1",
    ]);
    expect(observations.every((entry) => entry.condition !== "awaiting-human")).toBe(true);
    expect(readFileSync(join(workspace.root, "semantic-review-count"), "utf8")).toBe("4");
  });

  it("keeps a configured SQL implementation human-owned until the interactive producer resolves it", async () => {
    const workspace = await createTaskWorkspace({
      taskId: "automation-sql-boundary",
      label: "automation-sql-boundary",
    });
    workspaces.push(workspace);
    excludeReviewFixtures(workspace);
    restorers.push(installSemanticReviewStub(workspace.root, [[], [], [], []]));
    const harness = semanticJourneyHarness(workspace);
    await reachImplementationHandoff(workspace, harness, { phaseCount: 1 });

    const launch = observe(workspace);
    expect(launch).toMatchObject({
      condition: "ready",
      next_action: { actor: "orchestrator", kind: "launch-skill", skill: "archflow-phase-impl", skill_args: ["1"] },
    });
    const invocation = invocationFromAutomation(launch);
    let view = await harness.status(invocation);
    view = await applyOk(harness, invocation, view);
    writeFileSync(workspace.services.authority.config.absolute, `schema_version: "1"
roles:
  counter-reviewer: { model: gpt-5.6-sol, effort: xhigh }
  adjudicator: { model: gpt-5.6-sol, effort: xhigh }
approval_rules:
  subjects: []
  content:
    - paths: ["**/*.sql"]
`);
    const artifact = view.resources.find((candidate) => candidate.role === "current-artifact");
    const transcript = view.resources.find((candidate) => candidate.role === "verification-transcript");
    if (artifact === undefined || transcript === undefined) throw new Error("SQL implementation resources unavailable");
    const sqlPath = "db/controller-boundary.sql";
    mkdirSync(join(workspace.root, "db"), { recursive: true });
    mkdirSync(dirname(join(workspace.root, transcript.path)), { recursive: true });
    writeFileSync(join(workspace.root, sqlPath), "CREATE TABLE controller_boundary (id INTEGER PRIMARY KEY);\n");
    writeFileSync(join(workspace.root, artifact.path), "# Implementation Log: Phase 1 - SQL boundary\n\n### Verification Evidence\n\n- SQL fixture verified.\n");
    writeFileSync(join(workspace.root, transcript.path), "$ verify sql fixture\n\nSQL fixture: passed\n");
    const outputs = [artifact.path, sqlPath].sort();
    view = await applyOk(harness, invocation, view, {
      kind: "work-result",
      outcome: "succeeded",
      implementation: {
        base_commit: gitAt(workspace, "rev-parse", "HEAD"),
        outputs,
        restore_targets: outputs,
        declared_inputs: [],
      },
    });
    view = await applyOk(harness, invocation, view);
    expect(view.next_action).toMatchObject({ kind: "decide", expected_submission: "gate-summary" });
    expect(observe(workspace)).toMatchObject({
      condition: "awaiting-client",
      next_action: { actor: "skill", kind: "continue-skill", skill: "archflow-phase-impl", skill_args: ["1"] },
    });

    view = await applyOk(harness, invocation, view, {
      kind: "gate-summary",
      summary: "The reviewed SQL change matches the configured approval rule and needs human judgment.",
    });
    const boundary = observe(workspace);
    expect(boundary).toMatchObject({
      condition: "awaiting-human",
      next_action: { actor: "human", kind: "respond-in-session", skill: "archflow-phase-impl", skill_args: ["1"] },
      human_boundary: { source: "presentation", class: "configured-approval" },
    });
    expect(JSON.stringify(boundary)).not.toContain("authorize-commit");
    if (boundary.condition !== "awaiting-human") throw new Error("configured SQL boundary unavailable");
    expect(boundary.human_boundary.reasons.some((reason) => reason.class === "configured-approval")).toBe(true);

    view = await applyOk(harness, invocation, view, {
      kind: "decision",
      choice: "authorize-commit",
      reason: "The reviewed SQL schema change is approved.",
    });
    expect(view.next_action.kind).toBe("commit");
    const afterDecision = observe(workspace);
    expect(afterDecision).toMatchObject({
      condition: "awaiting-client",
      next_action: { actor: "skill", kind: "continue-skill", skill: "archflow-phase-impl", skill_args: ["1"] },
    });
    expect(afterDecision).not.toHaveProperty("human_boundary");
    commitReturnedFacts(workspace, view);
    view = await harness.status(invocation);
    expect(view.next_action.kind).toBe("finish-task");
    await applyOk(harness, invocation, view);
    expect(observe(workspace)).toMatchObject({ condition: "complete", next_action: { actor: "none", kind: "none" } });
  });

  it("projects configured PRD and design approvals through the same token-free human boundary", async () => {
    const workspace = await createTaskWorkspace({
      taskId: "automation-document-boundaries",
      label: "automation-document-boundaries",
      configBytes: approvalSubjects("prd", "design"),
    });
    workspaces.push(workspace);
    excludeReviewFixtures(workspace);
    restorers.push(installSemanticReviewStub(workspace.root, [[], []]));
    const harness = semanticJourneyHarness(workspace);
    writeFileSync(join(workspace.services.authority.task_root, "ask.md"), "Describe configured document boundaries.\n");
    writeFileSync(join(workspace.services.authority.task_root, "prd.md"), "# Configured documents\n\nReview PRD and design.\n");

    const prdInvocation = invocationFromAutomation(observe(workspace));
    let view = await harness.status(prdInvocation);
    view = await applyOk(harness, prdInvocation, view, { kind: "work-result", outcome: "succeeded" });
    view = await applyOk(harness, prdInvocation, view);
    view = await applyOk(harness, prdInvocation, view, {
      kind: "gate-summary",
      summary: "The configured PRD approval boundary is ready for human review.",
    });
    const prdBoundary = observe(workspace);
    expect(prdBoundary).toMatchObject({
      condition: "awaiting-human",
      position: { kind: "prd" },
      next_action: { actor: "human", kind: "respond-in-session", skill: "archflow-prd", skill_args: [] },
      human_boundary: { source: "presentation", class: "configured-approval" },
    });
    expect(JSON.stringify(prdBoundary)).not.toContain("\"options\"");
    expect(JSON.stringify(prdBoundary)).not.toContain("\"token\"");

    view = await applyOk(harness, prdInvocation, view, {
      kind: "decision",
      choice: "approve",
      reason: "The configured PRD is approved.",
    });
    expect(observe(workspace)).toMatchObject({
      condition: "ready",
      next_action: { actor: "orchestrator", kind: "launch-skill", skill: "archflow-design", skill_args: [] },
    });

    const designInvocation = invocationFromAutomation(observe(workspace));
    view = await harness.status(designInvocation);
    view = await applyOk(harness, designInvocation, view);
    writeFileSync(currentArtifact(workspace, view), "# Design\n\n### Phase 1: Configured document behavior\n\nImplement one phase.\n");
    view = await applyOk(harness, designInvocation, view, { kind: "work-result", outcome: "succeeded" });
    view = await applyOk(harness, designInvocation, view);
    view = await applyOk(harness, designInvocation, view, {
      kind: "gate-summary",
      summary: "The configured design approval boundary is ready for human review.",
    });
    const designBoundary = observe(workspace);
    expect(designBoundary).toMatchObject({
      condition: "awaiting-human",
      position: { kind: "design" },
      next_action: { actor: "human", kind: "respond-in-session", skill: "archflow-design", skill_args: [] },
      human_boundary: { source: "presentation", class: "configured-approval" },
    });
    expect(JSON.stringify(designBoundary)).not.toContain("\"options\"");
    expect(JSON.stringify(designBoundary)).not.toContain("\"token\"");
  });

  it("gives an exact-current invocation-route dispatch failure precedence over review continuation", async () => {
    const workspace = await createTaskWorkspace({
      taskId: "automation-dispatch-failure",
      label: "automation-dispatch-failure",
      configBytes: noApprovalRules,
    });
    workspaces.push(workspace);
    excludeReviewFixtures(workspace);
    restorers.push(installSemanticReviewStub(workspace.root, [[]]));
    const harness = semanticJourneyHarness(workspace);
    writeFileSync(join(workspace.services.authority.task_root, "ask.md"), "Describe dispatch-failure precedence.\n");
    writeFileSync(join(workspace.services.authority.task_root, "prd.md"), "# Dispatch failure\n\nKeep review ownership exact.\n");
    const failingInvocation = {
      skill: "archflow-prd",
      intent: "resume",
      review_routes: { "counter-reviewer": { model: "unsupported-model", effort: "high" } },
    } as const;

    let view = await harness.status(failingInvocation);
    view = await applyOk(harness, failingInvocation, view, { kind: "work-result", outcome: "succeeded" });
    const failed = await harness.apply(failingInvocation, view);
    expect(failed.ok).toBe(false);
    if (failed.ok) throw new Error("invalid invocation route unexpectedly dispatched");
    expect(failed.view).toMatchObject({
      condition: "awaiting-client",
      next_action: { kind: "review" },
      dispatch_failure: { role: "counter-reviewer", code: "CONFIG_MODEL_UNSUPPORTED" },
    });

    const failureBoundary = observe(workspace);
    expect(failureBoundary).toMatchObject({
      condition: "awaiting-human",
      next_action: { actor: "human", kind: "respond-in-session", skill: "archflow-prd" },
      human_boundary: {
        source: "dispatch-failure",
        class: "exception",
        failed_role: "counter-reviewer",
        failure_code: "CONFIG_MODEL_UNSUPPORTED",
      },
    });
    expect(JSON.stringify(failureBoundary)).not.toContain("unsupported-model");

    const retryInvocation = { skill: "archflow-prd", intent: "resume" } as const;
    view = await harness.status(retryInvocation);
    view = await applyOk(harness, retryInvocation, view);
    expect(view.dispatch_failure).toBeUndefined();
    const advanced = observe(workspace);
    expect(advanced).toMatchObject({
      condition: "ready",
      next_action: { actor: "orchestrator", kind: "launch-skill", skill: "archflow-design" },
    });
    expect(advanced).not.toHaveProperty("human_boundary");
  });

  it("projects a constitution-triggered document decision as an exceptional human boundary", async () => {
    const workspace = await createTaskWorkspace({
      taskId: "automation-constitution-boundary",
      label: "automation-constitution-boundary",
      configBytes: noApprovalRules,
    });
    workspaces.push(workspace);
    excludeReviewFixtures(workspace);
    restorers.push(installSemanticReviewStub(workspace.root, [[]], { adjudicationCompliance: "fail" }));
    const harness = semanticJourneyHarness(workspace);
    writeFileSync(join(workspace.services.authority.task_root, "ask.md"), "Describe an exceptional constitution boundary.\n");
    writeFileSync(join(workspace.services.authority.task_root, "prd.md"), "# Exceptional boundary\n\nExercise constitution review.\n");
    const invocation = invocationFromAutomation(observe(workspace));
    let view = await harness.status(invocation);
    view = await applyOk(harness, invocation, view, { kind: "work-result", outcome: "succeeded" });
    view = await applyOk(harness, invocation, view);
    expect(view.next_action).toMatchObject({ kind: "decide", expected_submission: "gate-summary" });
    view = await applyOk(harness, invocation, view, {
      kind: "gate-summary",
      summary: "The constitution findings require explicit human judgment.",
    });

    const exceptional = observe(workspace);
    expect(exceptional).toMatchObject({
      condition: "awaiting-human",
      next_action: { actor: "human", kind: "respond-in-session", skill: "archflow-prd" },
      human_boundary: { source: "presentation", class: "exception" },
    });
    if (exceptional.condition !== "awaiting-human") throw new Error("exceptional boundary unavailable");
    expect(exceptional.human_boundary.reasons.some((reason) => reason.class === "exception")).toBe(true);
    expect(JSON.stringify(exceptional)).not.toContain("request-exception-");
  });
});

import { clientCommit } from "../helpers/semantic-journeys.js";
import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { ApplySubmissionV1, WorkflowInvocationV1, WorkflowViewV1 } from "../../src/contracts/semantic-workflow.js";
import { installSemanticReviewStub, reachImplementationHandoff, reachPhaseDesignReviewOffer, semanticJourneyHarness, withImplementationComponents, type SemanticJourneyHarness } from "../helpers/semantic-journeys.js";
import { createTaskWorkspace, type TaskWorkspace } from "../helpers/task-workspace.js";
import { createProductionServices } from "../../src/state/production.js";
import { parseSafeCode } from "../../src/contracts/evidence.js";
import { derivePendingEditorialPredecessor, validateEditorialPredecessorDeclaration } from "../../src/state/evidence-results.js";
import { loadCurrentProduceSubject } from "../../src/state/produce-subject.js";

const workspaces: TaskWorkspace[] = [];
const restorers: (() => void)[] = [];
afterEach(() => {
  for (const restore of restorers.splice(0)) restore();
  for (const workspace of workspaces.splice(0)) workspace.dispose();
});

async function apply(h: SemanticJourneyHarness, invocation: WorkflowInvocationV1, view: WorkflowViewV1, submission?: ApplySubmissionV1): Promise<WorkflowViewV1> {
  const result = await h.applyAndAssertFreshStatus(invocation, view, submission);
  if (!result.ok) throw new Error(JSON.stringify(result.error));
  return result.value;
}

describe("minor review revisions", { timeout: 180_000 }, () => {
  const suggestion = [{ finding_id: "clarify", summary: "Clarify the wording.", evidence: "The existing paragraph could be clearer.", suggested_resolution: "Add a short explanation.", blocking: false }];

  it("retains phase-design effort evidence and advances on the corrected final document", async () => {
    const workspace = await createTaskWorkspace({ taskId: "minor-phase-design" });
    workspaces.push(workspace);
    restorers.push(installSemanticReviewStub(workspace.root, [[], [], suggestion]));
    const h = semanticJourneyHarness(workspace);
    const bytes = withImplementationComponents("# Phase design\n\nShow the task's current state.\n");
    const reached = await reachPhaseDesignReviewOffer(workspace, h, bytes);
    const { invocation } = reached;
    let view = await apply(h, invocation, reached.view);
    expect(view.next_action.kind).toBe("triage");
    const recommendation = view.implementation_recommendation;
    expect(recommendation.status).toBe("ready");
    const count = readFileSync(join(workspace.root, "semantic-review-count"), "utf8");
    view = await apply(h, invocation, view, { kind: "triage", response: { decision: "revise-minor", rationale: "Explain the existing state terminology without changing the component plan." } });
    view = await apply(h, invocation, view);
    const path = view.resources.find(resource => resource.role === "current-artifact")!.path;
    writeFileSync(join(workspace.root, path), bytes.replace("current state.", "current state (its workflow stage)."));
    view = await apply(h, invocation, view, { kind: "work-result", outcome: "succeeded", review_revision: { classification: "minor", rationale: "Only clarified existing terminology in one sentence." } });
    expect(view.implementation_recommendation).toEqual(recommendation);
    expect(view.next_action.kind).toBe("commit");
    const commit = view.next_action.commit!;
    expect(commit.paths.some(root => path === root || path.startsWith(`${root}/`))).toBe(true);
    execFileSync("git", ["add", "-A", "--", ...commit.paths], { cwd: workspace.root });
    execFileSync("git", ["-c", "user.name=Test", "-c", "user.email=test@example.invalid", "commit", "-qm", commit.message, "--", ...commit.paths], { cwd: workspace.root });
    const handoff = await h.status({ skill: "archflow-phase-impl", phase: 1, intent: "resume" });
    expect(handoff.next_action.kind).toBe("start-next-skill");
    expect(handoff.implementation_recommendation).toEqual(recommendation);
    expect(readFileSync(join(workspace.root, "semantic-review-count"), "utf8")).toBe(count);
  });

  it("keeps implementation checks and final commit authority while reusing review for a comment correction", async () => {
    const workspace = await createTaskWorkspace({ taskId: "minor-implementation" });
    workspaces.push(workspace);
    writeFileSync(join(workspace.root, ".git/info/exclude"), "semantic-stub-bin/\nsemantic-stub-home/\nsemantic-review-count\n");
    restorers.push(installSemanticReviewStub(workspace.root, [[], [], [], suggestion]));
    const h = semanticJourneyHarness(workspace);
    const { invocation, handoff } = await reachImplementationHandoff(workspace, h, { phaseCount: 1 });
    let view = await apply(h, invocation, handoff);
    const artifact = view.resources.find(resource => resource.role === "current-artifact")!.path;
    const transcript = view.resources.find(resource => resource.role === "verification-transcript")!.path;
    const source = "src/feature.js";
    mkdirSync(join(workspace.root, "src"), { recursive: true });
    mkdirSync(dirname(join(workspace.root, transcript)), { recursive: true });
    writeFileSync(join(workspace.root, source), "// The task state.\nexport const state = 'ready';\n");
    writeFileSync(join(workspace.root, artifact), "# Implementation\n\nExpose the ready state. Checked with node --check src/feature.js.\n");
    execFileSync(process.execPath, ["--check", source], { cwd: workspace.root });
    writeFileSync(join(workspace.root, transcript), "$ node --check src/feature.js\nExit code: 0\n");
    const implementation = { base_commit: execFileSync("git", ["rev-parse", "HEAD"], { cwd: workspace.root, encoding: "utf8" }).trim(), outputs: [artifact, source], restore_targets: [artifact, source], declared_inputs: [] };
    view = await apply(h, invocation, view, { kind: "work-result", outcome: "succeeded", implementation });
    view = await apply(h, invocation, view);
    const count = readFileSync(join(workspace.root, "semantic-review-count"), "utf8");
    expect(view.next_action.kind).toBe("triage");
    view = await apply(h, invocation, view, { kind: "triage", response: { decision: "revise-minor", rationale: "Clarify the state comment; executable behavior remains identical." } });
    view = await apply(h, invocation, view);
    writeFileSync(join(workspace.root, source), "// The task state (its workflow stage).\nexport const state = 'ready';\n");
    execFileSync(process.execPath, ["--check", source], { cwd: workspace.root });
    view = await apply(h, invocation, view, { kind: "work-result", outcome: "succeeded", implementation, review_revision: { classification: "minor", rationale: "Expanded one comment; node --check passed again." } });
    expect(view.next_action.kind).toBe("commit");
    expect(view.next_action.commit?.paths).toContain(source);
    expect(view.detail).toContain("has not received another AI review");
    expect(readFileSync(join(workspace.root, "semantic-review-count"), "utf8")).toBe(count);
  });

  it.each([
    { classification: "minor", policyFails: false },
    { classification: "significant", policyFails: false },
    { classification: "minor", policyFails: true },
  ] as const)("records a $classification revision with policy failure=$policyFails and selects the corresponding path", async ({ classification, policyFails }) => {
    const workspace = await createTaskWorkspace({ taskId: `revision-${classification}`, configBytes: new TextEncoder().encode(`schema_version: "1"
roles:
  counter-reviewer: { model: gpt-5.6-sol, effort: xhigh }
  adjudicator: { model: gpt-5.6-sol, effort: xhigh }
approval_rules:
  subjects: [prd]
  content: []
`) });
    workspaces.push(workspace);
    restorers.push(installSemanticReviewStub(workspace.root, [[]], { adjudicationCompliance: policyFails ? "fail" : "pass" }));
    const h = semanticJourneyHarness(workspace, false);
    const invocation = { skill: "archflow-prd", intent: "resume" } as const;
    const path = join(workspace.services.authority.task_root, "prd.md");
    writeFileSync(join(workspace.services.authority.task_root, "ask.md"), "Describe task status.\n");
    writeFileSync(path, "# Status\n\nShow the task's current state.\n");
    let view = await h.status(invocation);
    const initialBypass = await h.apply(invocation, view, { kind: "work-result", outcome: "succeeded", review_revision: { classification: "minor", rationale: "Attempt to skip the initial review." } });
    expect(initialBypass.ok).toBe(false);
    if (!initialBypass.ok) expect(initialBypass.error.code).toBe("SEMANTIC_SUBMISSION_MISMATCH");
    view = await apply(h, invocation, view, { kind: "work-result", outcome: "succeeded" });
    view = await apply(h, invocation, view);
    expect(view.next_action.kind).toBe("triage");
    const reviewedSubject = view.review_reports![0]!.subject_digest;
    const reviewCount = readFileSync(join(workspace.root, "semantic-review-count"), "utf8");
    view = await apply(h, invocation, view, { kind: "triage", response: { decision: "revise-minor", rationale: "Clarify that state means workflow stage in the existing paragraph." } });
    expect(view.next_action.kind).toBe("revise");
    view = await apply(h, invocation, view);
    expect(view.next_action.kind).toBe("submit-work");
    expect(view.next_action.instruction).toContain("review_revision");
    writeFileSync(path, classification === "minor"
      ? "# Status\n\nShow the task's current state (its workflow stage).\n"
      : "# Status\n\nShow the task's current state and send email whenever it changes.\n");
    const missingDeclaration = await h.apply(invocation, view, { kind: "work-result", outcome: "succeeded" });
    expect(missingDeclaration.ok).toBe(false);
    if (!missingDeclaration.ok) expect(JSON.stringify(missingDeclaration.error)).toContain("review_revision");
    view = await h.status(invocation);
    const revisionView = view;
    const revisionSubmission = { kind: "work-result", outcome: "succeeded", review_revision: {
      classification, rationale: classification === "minor" ? "Added a short explanation of established terminology." : "The change grew to include new notification behavior.",
    } } as const;
    view = await apply(h, invocation, view, revisionSubmission);
    // A client that lost the response receives the fresh view when retrying its stale offer.
    // It resumes at that boundary without installing the correction or dispatching review twice.
    const staleRetry = await h.apply(invocation, revisionView, revisionSubmission);
    expect(staleRetry.ok).toBe(false);
    if (!staleRetry.ok) expect(staleRetry.view).toEqual(view);
    expect(view.review_revision?.classification).toBe(classification);
    expect(readFileSync(join(workspace.root, "semantic-review-count"), "utf8")).toBe(reviewCount);
    if (policyFails) {
      expect(view.next_action.kind).toBe("decide");
      expect(view.next_action.commit).toBeUndefined();
      view = await apply(h, invocation, view, { kind: "gate-summary", summary: "The minor wording correction is complete; the failed constitution checks remain unresolved." });
      expect(view.presentation?.class).toBe("exception");
      expect(view.next_action.expected_submission).toBe("decision");
      return;
    }
    if (classification === "significant") {
      expect(view.next_action.kind).toBe("review");
      view = await apply(h, invocation, view);
      expect(Number(readFileSync(join(workspace.root, "semantic-review-count"), "utf8"))).toBe(Number(reviewCount) + 1);
      return;
    }
    expect(view.review_reports![0]!.subject_digest).toBe(reviewedSubject);
    expect(view.progress?.review_rounds_completed).toBe(1);
    expect(view.detail).toContain("has not received another AI review");
    const services = await createProductionServices({ working_directory: workspace.root, task_id: workspace.taskId, operation: parseSafeCode("check-minor-predecessor") });
    if (!services.ok || services.value.state === undefined) throw new Error("current production state unavailable");
    expect(await derivePendingEditorialPredecessor(services.value.dependencies, services.value.state.value)).toBeUndefined();
    const produced = await loadCurrentProduceSubject(services.value.dependencies, services.value.state.value);
    if (!produced.ok) throw new Error("current produce unavailable");
    const chained = await validateEditorialPredecessorDeclaration(services.value.dependencies, services.value.state.value, produced.value.artifact);
    expect(chained.ok).toBe(false);
    expect(view.next_action).toMatchObject({ kind: "decide", expected_submission: "gate-summary" });
    view = await apply(h, invocation, view, { kind: "gate-summary", summary: "The reviewed PRD includes one localized clarification made without another AI review." });
    expect(view.next_action.expected_submission).toBe("decision");
    view = await apply(h, invocation, view, { kind: "decision", choice: "approve", reason: "The final wording accurately describes task status." });
    expect(view.next_action.kind).toBe("commit");
    await clientCommit(workspace, view);
    // The same option is available at overall task design, including its parent-document binding.
    const designInvocation = { skill: "archflow-design", intent: "resume" } as const;
    view = await h.status(designInvocation);
    view = await apply(h, designInvocation, view);
    const designPath = join(workspace.services.authority.task_root, "design.md");
    const design = "# Design\n\nShow the task state.\n\n### Phase 1: Status display\n\nRender the current workflow stage.\n";
    writeFileSync(designPath, design);
    view = await apply(h, designInvocation, view, { kind: "work-result", outcome: "succeeded" });
    view = await apply(h, designInvocation, view);
    const designCount = readFileSync(join(workspace.root, "semantic-review-count"), "utf8");
    view = await apply(h, designInvocation, view, { kind: "triage", response: { decision: "revise-minor", rationale: "Clarify the same terminology in the design." } });
    view = await apply(h, designInvocation, view);
    writeFileSync(designPath, design.replace("task state.", "task state (its workflow stage)."));
    view = await apply(h, designInvocation, view, { kind: "work-result", outcome: "succeeded", review_revision: { classification: "minor", rationale: "Clarified one sentence without changing the PRD or phase plan." } });
    expect(["commit", "decide"]).toContain(view.next_action.kind);
    expect(readFileSync(join(workspace.root, "semantic-review-count"), "utf8")).toBe(designCount);
  });
});

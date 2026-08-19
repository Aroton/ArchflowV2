import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { handleSemanticApply } from "../../src/mcp/handlers/semantic.js";
import {
  installSemanticReviewStub,
  semanticJourneyHarness,
} from "../helpers/semantic-journeys.js";
import { createTaskWorkspace, type TaskWorkspace } from "../helpers/task-workspace.js";

const TIMEOUT = 60_000;
const workspaces: TaskWorkspace[] = [];
const restorers: (() => void)[] = [];

afterEach(() => {
  for (const restore of restorers.splice(0)) restore();
  for (const workspace of workspaces.splice(0)) workspace.dispose();
});

describe("semantic document journeys", { timeout: TIMEOUT }, () => {
  it("takes a finding-free PRD through client production, one review, a client summary, and a later human decision", async () => {
    const workspace = await createTaskWorkspace({ taskId: "semantic-prd-clean", label: "semantic-prd-clean" });
    workspaces.push(workspace);
    restorers.push(installSemanticReviewStub(workspace.root, [[]]));
    const h = semanticJourneyHarness(workspace);
    const invocation = { skill: "archflow-prd", intent: "resume" } as const;
    const prdPath = join(workspace.services.authority.task_root, "prd.md");
    writeFileSync(join(workspace.services.authority.task_root, "ask.md"), "Describe a small semantic journey.\n");
    writeFileSync(prdPath, "# Semantic journey\n\nThe client authors this document.\n");
    const initialHead = execFileSync("git", ["rev-parse", "HEAD"], { cwd: workspace.root, encoding: "utf8" });

    let view = await h.status(invocation);
    expect(view.next_action).toMatchObject({ kind: "submit-work", expected_submission: "work-result" });
    const produced = await h.apply(invocation, view, { kind: "work-result", outcome: "succeeded" });
    expect(produced.ok).toBe(true);
    if (!produced.ok) return;
    view = produced.value;
    expect(view.next_action.kind).toBe("review");

    const reviewed = await h.apply(invocation, view);
    expect(reviewed.ok, JSON.stringify(reviewed)).toBe(true);
    if (!reviewed.ok) return;
    view = reviewed.value;
    expect(view.findings).toEqual([]);
    expect(view.next_action).toMatchObject({ kind: "decide", expected_submission: "gate-summary" });

    const opened = await h.apply(invocation, view, { kind: "gate-summary", summary: "The PRD is ready for approval." });
    expect(opened.ok).toBe(true);
    if (!opened.ok) return;
    view = opened.value;
    expect(view.presentation?.options.map((option) => option.token)).toContain("approve");
    expect(view.next_action).toMatchObject({ kind: "decide", expected_submission: "decision" });

    const decided = await h.apply(invocation, view, { kind: "decision", choice: "approve", reason: "The requirements are correct." });
    expect(decided.ok).toBe(true);
    if (!decided.ok) return;
    expect(readFileSync(prdPath, "utf8")).toBe("# Semantic journey\n\nThe client authors this document.\n");
    expect(execFileSync("git", ["rev-parse", "HEAD"], { cwd: workspace.root, encoding: "utf8" })).toBe(initialHead);
    expect(readFileSync(join(workspace.root, "semantic-review-count"), "utf8")).toBe("1");

    // The predecessor can name the successor but cannot consume its write window.
    expect(decided.value.next_action).toMatchObject({ kind: "start-next-skill", skill: "archflow-design" });
    expect(decided.value.next_action.offer).toBeUndefined();
    const designInvocation = { skill: "archflow-design", intent: "resume" } as const;
    view = await h.status(designInvocation);
    expect(view.next_action).toMatchObject({ kind: "start-next-skill", expected_submission: "none" });
    const startedDesign = await h.apply(designInvocation, view);
    expect(startedDesign.ok, JSON.stringify(startedDesign)).toBe(true);
    if (!startedDesign.ok) return;
    expect(startedDesign.value.position).toEqual({ kind: "design" });
    expect(startedDesign.value.next_action.kind).toBe("submit-work");

    const designResource = startedDesign.value.resources.find((resource) => resource.role === "current-artifact");
    if (designResource === undefined) throw new Error("design resource unavailable");
    const designPath = join(workspace.root, designResource.path);
    writeFileSync(designPath, "# Design\n\n### Phase 1: Implement the verified behavior\n");
    let designResult = await h.apply(designInvocation, startedDesign.value, { kind: "work-result", outcome: "succeeded" });
    if (!designResult.ok) throw new Error(JSON.stringify(designResult));
    designResult = await h.apply(designInvocation, designResult.value);
    if (!designResult.ok) throw new Error(JSON.stringify(designResult));
    expect(designResult.value.next_action.expected_submission).toBe("gate-summary");
    designResult = await h.apply(designInvocation, designResult.value, { kind: "gate-summary", summary: "The architecture and one-phase plan are ready." });
    if (!designResult.ok) throw new Error(JSON.stringify(designResult));
    designResult = await h.apply(designInvocation, designResult.value, { kind: "decision", choice: "approve", reason: "The design is implementable." });
    if (!designResult.ok) throw new Error(JSON.stringify(designResult));
    expect(designResult.value.next_action.kind).toBe("commit");
    const commit = designResult.value.next_action.commit;
    if (commit === undefined) throw new Error("design commit instructions unavailable");
    expect(commit.requires_human_confirmation).toBe(false);
    execFileSync("git", ["add", "-A", "--", ...commit.paths], { cwd: workspace.root });
    execFileSync("git", ["-c", "user.name=ArchFlow Test", "-c", "user.email=test@example.invalid", "commit", "-q", "-m", commit.message], { cwd: workspace.root });

    const observedByPredecessor = await h.status(designInvocation);
    expect(observedByPredecessor.next_action).toMatchObject({ kind: "start-next-skill", skill: "archflow-phase-design", skill_args: ["1"] });
    expect(observedByPredecessor.next_action.offer).toBeUndefined();
    const phaseDesignInvocation = { skill: "archflow-phase-design", phase: 1, intent: "resume" } as const;
    const successor = await h.status(phaseDesignInvocation);
    expect(successor.next_action).toMatchObject({ kind: "start-next-skill", expected_submission: "none" });
    const startedPhaseDesign = await h.apply(phaseDesignInvocation, successor);
    expect(startedPhaseDesign.ok, JSON.stringify(startedPhaseDesign)).toBe(true);
    if (!startedPhaseDesign.ok) return;
    expect(startedPhaseDesign.value.position).toEqual({ kind: "phase-design", phase: 1 });
    expect(startedPhaseDesign.value.next_action.kind).toBe("submit-work");

    const phaseDesignResource = startedPhaseDesign.value.resources.find((resource) => resource.role === "current-artifact");
    const phasePrdResource = startedPhaseDesign.value.resources.find((resource) => resource.role === "prd");
    const taskDesignResource = startedPhaseDesign.value.resources.find((resource) => resource.role === "task-design");
    if (phaseDesignResource === undefined || phasePrdResource === undefined || taskDesignResource === undefined) {
      throw new Error("compound phase-design resources unavailable");
    }
    expect([phaseDesignResource.access, phasePrdResource.access, taskDesignResource.access])
      .toEqual(["write", "read-write", "read-write"]);

    const phaseDesignPath = join(workspace.root, phaseDesignResource.path);
    const phasePrdPath = join(workspace.root, phasePrdResource.path);
    const taskDesignPath = join(workspace.root, taskDesignResource.path);
    const phaseDesignBytes = `# Phase 1: Implement the verified behavior

## Goal

Make the semantic document journey observable from client-owned production through the implementation handoff.

## Requirements

- Preserve client ownership of document writes and Git operations.
- Return fresh semantic status after every apply.

## Context

The approved task design delegates the complete document lifecycle to this phase.

## Files

- \`src/state/semantic-view.ts\`: preserve semantic status and handoff projection.
- \`test/integration/semantic-document-journeys.test.ts\`: verify the live lifecycle.

## Work Chunks

### Semantic lifecycle

Exercise compound production, independent review, approval, commit instructions, and successor observation.

## Pinned Cross-Chunk Interfaces

\`archflow_apply\` returns the same workflow view as an immediate fresh \`archflow_status\` call.

## Success Criteria

The predecessor reports \`archflow-phase-impl\` as its successor without offering a semantic mutation.

## Executable Verification

- \`npm test -- --run test/integration/semantic-document-journeys.test.ts\`
- \`npm run typecheck\`
`;
    const phasePrdBytes = "# Semantic journey\n\nThe client authors this document and observes fresh status after every applied action.\n";
    const taskDesignBytes = "# Design\n\nThe semantic facade preserves client-owned documents and Git operations.\n\n### Phase 1: Implement the verified behavior\n";
    const phaseBaseline = execFileSync("git", ["rev-parse", "HEAD"], { cwd: workspace.root, encoding: "utf8" }).trim();
    mkdirSync(dirname(phaseDesignPath), { recursive: true });
    writeFileSync(phaseDesignPath, phaseDesignBytes);
    writeFileSync(phasePrdPath, phasePrdBytes);
    writeFileSync(taskDesignPath, taskDesignBytes);

    let phaseResult = await h.apply(phaseDesignInvocation, startedPhaseDesign.value, { kind: "work-result", outcome: "succeeded" });
    if (!phaseResult.ok) throw new Error(JSON.stringify(phaseResult));
    expect(phaseResult.value.next_action.kind).toBe("review");
    expect(readFileSync(phaseDesignPath, "utf8")).toBe(phaseDesignBytes);
    expect(readFileSync(phasePrdPath, "utf8")).toBe(phasePrdBytes);
    expect(readFileSync(taskDesignPath, "utf8")).toBe(taskDesignBytes);
    expect(execFileSync("git", ["rev-parse", "HEAD"], { cwd: workspace.root, encoding: "utf8" }).trim()).toBe(phaseBaseline);

    phaseResult = await h.apply(phaseDesignInvocation, phaseResult.value);
    if (!phaseResult.ok) throw new Error(JSON.stringify(phaseResult));
    expect(phaseResult.value.findings).toEqual([]);
    expect(phaseResult.value.next_action).toMatchObject({ kind: "decide", expected_submission: "gate-summary" });
    expect(readFileSync(phaseDesignPath, "utf8")).toBe(phaseDesignBytes);
    expect(readFileSync(phasePrdPath, "utf8")).toBe(phasePrdBytes);
    expect(readFileSync(taskDesignPath, "utf8")).toBe(taskDesignBytes);
    expect(execFileSync("git", ["rev-parse", "HEAD"], { cwd: workspace.root, encoding: "utf8" }).trim()).toBe(phaseBaseline);

    phaseResult = await h.apply(phaseDesignInvocation, phaseResult.value, {
      kind: "gate-summary", summary: "Phase 1 and its corrected parent documents are ready for approval.",
    });
    if (!phaseResult.ok) throw new Error(JSON.stringify(phaseResult));
    expect(phaseResult.value.presentation?.options.map((option) => option.token)).toContain("approve");
    expect(phaseResult.value.next_action).toMatchObject({ kind: "decide", expected_submission: "decision" });
    expect(readFileSync(phaseDesignPath, "utf8")).toBe(phaseDesignBytes);
    expect(readFileSync(phasePrdPath, "utf8")).toBe(phasePrdBytes);
    expect(readFileSync(taskDesignPath, "utf8")).toBe(taskDesignBytes);
    expect(execFileSync("git", ["rev-parse", "HEAD"], { cwd: workspace.root, encoding: "utf8" }).trim()).toBe(phaseBaseline);

    phaseResult = await h.apply(phaseDesignInvocation, phaseResult.value, {
      kind: "decision", choice: "approve", reason: "The phase scope and parent corrections are accurate.",
    });
    if (!phaseResult.ok) throw new Error(JSON.stringify(phaseResult));
    expect(phaseResult.value.next_action.kind).toBe("commit");
    const phaseCommit = phaseResult.value.next_action.commit;
    if (phaseCommit === undefined) throw new Error("phase-design commit instructions unavailable");
    expect(phaseCommit).toMatchObject({
      baseline: phaseBaseline,
      target_ref: execFileSync("git", ["symbolic-ref", "-q", "HEAD"], { cwd: workspace.root, encoding: "utf8" }).trim(),
      requires_human_confirmation: false,
    });
    expect(readFileSync(phaseDesignPath, "utf8")).toBe(phaseDesignBytes);
    expect(readFileSync(phasePrdPath, "utf8")).toBe(phasePrdBytes);
    expect(readFileSync(taskDesignPath, "utf8")).toBe(taskDesignBytes);
    expect(execFileSync("git", ["rev-parse", "HEAD"], { cwd: workspace.root, encoding: "utf8" }).trim()).toBe(phaseBaseline);

    execFileSync("git", ["add", "-A", "--", ...phaseCommit.paths], { cwd: workspace.root });
    execFileSync("git", [
      "-c", "user.name=ArchFlow Test", "-c", "user.email=test@example.invalid",
      "commit", "-q", "-m", phaseCommit.message, "--", ...phaseCommit.paths,
    ], { cwd: workspace.root });
    expect(execFileSync("git", ["rev-parse", "HEAD^"], { cwd: workspace.root, encoding: "utf8" }).trim()).toBe(phaseBaseline);
    expect(execFileSync("git", ["log", "-1", "--pretty=%B"], { cwd: workspace.root, encoding: "utf8" }).trim())
      .toBe(phaseCommit.message);

    const observedPhaseDesign = await h.status(phaseDesignInvocation);
    expect(observedPhaseDesign.next_action).toMatchObject({
      kind: "start-next-skill", skill: "archflow-phase-impl", skill_args: ["1"],
    });
    expect(observedPhaseDesign.next_action.offer).toBeUndefined();

    // The implementation invocation participates semantically: it owns and consumes its exact
    // start-next-skill hand-off, landing at its own implementation position.
    const phaseImplInvocation = { skill: "archflow-phase-impl", phase: 1, intent: "resume" } as const;
    const semanticHandoff = await h.status(phaseImplInvocation);
    expect(semanticHandoff.next_action).toMatchObject({
      kind: "start-next-skill", skill: "archflow-phase-impl", skill_args: ["1"], expected_submission: "none",
    });
    expect(semanticHandoff.next_action.offer).toBeDefined();
    const startedImplementation = await h.apply(phaseImplInvocation, semanticHandoff);
    expect(startedImplementation.ok, JSON.stringify(startedImplementation)).toBe(true);
    if (!startedImplementation.ok) return;
    expect(startedImplementation.value.position).toEqual({ kind: "phase-impl", phase: 1 });
    expect(startedImplementation.value.next_action.kind).toBe("submit-work");
    expect(readFileSync(join(workspace.root, "semantic-review-count"), "utf8")).toBe("3");
  });

  it("returns a material finding for client triage and requires an explicit revise action before remediation bytes are accepted", async () => {
    const workspace = await createTaskWorkspace({ taskId: "semantic-prd-remediation", label: "semantic-prd-remediation" });
    workspaces.push(workspace);
    restorers.push(installSemanticReviewStub(workspace.root, [[{
      finding_id: "requirement-observable", severity: "major", blocking: false,
      summary: "The success condition is not observable.", evidence: "prd.md names no observable result.",
      suggested_resolution: "Name the result a verifier can observe.",
    }]]));
    const h = semanticJourneyHarness(workspace);
    const invocation = { skill: "archflow-prd", intent: "resume" } as const;
    const prdPath = join(workspace.services.authority.task_root, "prd.md");
    writeFileSync(join(workspace.services.authority.task_root, "ask.md"), "Define an observable result.\n");
    writeFileSync(prdPath, "# Result\n\nImprove the workflow.\n");
    const initialHead = execFileSync("git", ["rev-parse", "HEAD"], { cwd: workspace.root, encoding: "utf8" });

    let view = await h.status(invocation);
    let result = await h.apply(invocation, view, { kind: "work-result", outcome: "succeeded" });
    if (!result.ok) throw new Error(JSON.stringify(result));
    result = await h.apply(invocation, result.value);
    expect(result.ok, JSON.stringify(result)).toBe(true);
    if (!result.ok) return;
    view = result.value;
    expect(view.next_action).toMatchObject({ kind: "triage", expected_submission: "triage" });
    expect(view.findings?.map((finding) => finding.finding_id)).toEqual(["requirement-observable"]);
    expect(readFileSync(prdPath, "utf8")).toBe("# Result\n\nImprove the workflow.\n");

    result = await h.apply(invocation, view, { kind: "triage", dispositions: [{
      finding_id: "requirement-observable", disposition: "accepted",
      rationale: "The reviewer identified a material verification gap.",
      revision_intent: "Add an observable semantic status outcome.",
    }] });
    expect(result.ok, JSON.stringify(result)).toBe(true);
    if (!result.ok) return;
    expect(result.value.next_action.kind).toBe("revise");
    expect(readFileSync(prdPath, "utf8")).toBe("# Result\n\nImprove the workflow.\n");

    result = await h.apply(invocation, result.value);
    expect(result.ok, JSON.stringify(result)).toBe(true);
    if (!result.ok) return;
    expect(result.value.next_action.kind).toBe("submit-work");
    writeFileSync(prdPath, "# Result\n\nA verifier observes a fresh semantic status view.\n");
    result = await h.apply(invocation, result.value, { kind: "work-result", outcome: "succeeded" });
    expect(result.ok, JSON.stringify(result)).toBe(true);
    if (result.ok) expect(result.value.next_action.kind).toBe("review");
    expect(execFileSync("git", ["rev-parse", "HEAD"], { cwd: workspace.root, encoding: "utf8" })).toBe(initialHead);
  });

  it("returns fresh safe status for stale, forged, cross-repository, and phase-implementation attempts without mutation", async () => {
    const first = await createTaskWorkspace({ taskId: "semantic-negative", label: "semantic-negative-a" });
    const second = await createTaskWorkspace({
      taskId: "semantic-negative", label: "semantic-negative-b",
      // The producer is the connected host, not a config role; only the child routes are configured.
      configBytes: new TextEncoder().encode(`schema_version: "1"
roles:
  counter-reviewer: { model: gpt-5.6-sol, effort: high }
  adjudicator: { model: gpt-5.6-sol, effort: high }
`),
      // Config bytes no longer separate the repositories (config left the input fingerprint), so
      // the cross-repository refusal is pinned on a genuinely distinct repository identity.
      rootBytes: new TextEncoder().encode("repository-b\n"),
    });
    workspaces.push(first, second);
    const invocation = { skill: "archflow-prd", intent: "resume" } as const;
    const firstHarness = semanticJourneyHarness(first);
    const secondHarness = semanticJourneyHarness(second);
    const offered = await firstHarness.status(invocation);
    expect(offered.next_action.offer).toBeDefined();

    const forged = {
      ...structuredClone(offered),
      next_action: { ...offered.next_action, offer: `af1_${"f".repeat(64)}` },
    };
    const forgedResult = await firstHarness.apply(invocation, forged, { kind: "work-result", outcome: "failed", reason: "exercise refusal" });
    expect(forgedResult).toMatchObject({ ok: false, error: { retryable: false } });

    const crossRepository = await secondHarness.apply(invocation, offered, { kind: "work-result", outcome: "failed", reason: "wrong repository" });
    expect(crossRepository).toMatchObject({ ok: false, error: { retryable: false } });

    const wrongPhase = await firstHarness.apply(
      { skill: "archflow-phase-design", phase: 1, intent: "resume" }, offered,
      { kind: "work-result", outcome: "failed", reason: "wrong phase" },
    );
    expect(wrongPhase).toMatchObject({ ok: false, error: { retryable: false } });

    const accepted = await firstHarness.apply(invocation, offered, { kind: "work-result", outcome: "failed", reason: "advance revision" });
    expect(accepted.ok).toBe(true);
    const stale = await firstHarness.apply(invocation, offered, { kind: "work-result", outcome: "failed", reason: "advance revision" });
    expect(stale).toMatchObject({ ok: false, error: { retryable: false } });

    const phaseImpl = { skill: "archflow-phase-impl", phase: 1, intent: "resume" } as const;
    const phaseView = await firstHarness.status(phaseImpl);
    expect(phaseView.next_action.offer).toBeUndefined();
    expect(phaseView.detail).not.toMatch(/legacy/i);
    const phaseMutation = await handleSemanticApply({
      schema_version: "1", task_id: first.taskId, invocation: phaseImpl,
      action: { offer: offered.next_action.offer!, submission: { kind: "work-result", outcome: "failed", reason: "another invocation owns this action" } },
    }, firstHarness.context());
    expect(phaseMutation).toMatchObject({ ok: false, error: { code: "SEMANTIC_OFFER_STALE", retryable: false }, view: phaseView });
  });
});

import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { parseSafeCode } from "../../src/contracts/evidence.js";
import { canonicalJsonBytes, sha256Bytes } from "../../src/contracts/canonical.js";
import { handleSemanticApply } from "../../src/mcp/handlers/semantic.js";
import { createProductionServices } from "../../src/state/production.js";
import { readTaskState } from "../../src/state/read.js";
import { composeRequest } from "../../src/state/request-composition.js";
import { computeTaskStatusDetailed } from "../../src/state/status.js";
import {
  installSemanticReviewStub,
  semanticJourneyHarness,
} from "../helpers/semantic-journeys.js";
import {
  createTaskWorkspace,
  legacyHumanAuthorityConstitutionV1Bytes,
  type TaskWorkspace,
} from "../helpers/task-workspace.js";

const TIMEOUT = 60_000;
const workspaces: TaskWorkspace[] = [];
const restorers: (() => void)[] = [];

afterEach(() => {
  for (const restore of restorers.splice(0)) restore();
  for (const workspace of workspaces.splice(0)) workspace.dispose();
});

/**
 * Config bytes for a journey whose document tiers must gate: the task copies these at creation, so
 * every walked approval gate records a matching rule. Unlisted subjects still record wait:false,
 * but remain explicitly human-approved during the staged rollout.
 */
function documentSubjectsConfig(subjects: readonly string[]): Uint8Array {
  return new TextEncoder().encode(`schema_version: "1"
roles:
  counter-reviewer: { model: gpt-5.6-sol, effort: xhigh }
  adjudicator: { model: gpt-5.6-sol, effort: xhigh }
approval_rules:
  subjects: [${subjects.join(", ")}]
  content: []
`);
}

export function registerSemanticDocumentJourney(selected: string): void {
describe("semantic document journeys", { timeout: TIMEOUT }, () => {
  const register = (name: string, run: () => Promise<void>): void => {
    if (name === selected) it(name, run);
  };

  register("takes a finding-free PRD through client production, one review, a client summary, and a later human decision", async () => {
    // The walk approves the prd, design, and phase-design tiers, so each must still be gated by a
    // rule (phase-design is not a shipped default subject).
    const workspace = await createTaskWorkspace({
      taskId: "semantic-prd-clean",
      label: "semantic-prd-clean",
      configBytes: documentSubjectsConfig(["prd", "design", "phase-design"]),
    });
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
    expect(view.presentation?.summary).toBe(
      'The PRD is ready for approval.\n\n' +
      'Approval rule trigger: this project requires human approval for the "prd" subject.',
    );
    expect(view.presentation).toMatchObject({
      class: "configured-approval",
      reasons: [{
        class: "configured-approval",
        text: "This project requires human approval for the prd subject.",
      }],
    });
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
    expect(designResult.value.presentation?.summary).toBe(
      'The architecture and one-phase plan are ready.\n\n' +
      'Approval rule trigger: this project requires human approval for the "design" subject.',
    );
    expect(designResult.value.presentation).toMatchObject({
      class: "configured-approval",
      reasons: [{
        class: "configured-approval",
        text: "This project requires human approval for the design subject.",
      }],
    });
    designResult = await h.apply(designInvocation, designResult.value, { kind: "decision", choice: "approve", reason: "The design is implementable." });
    if (!designResult.ok) throw new Error(JSON.stringify(designResult));
    expect(designResult.value.next_action.kind).toBe("commit");
    const commit = designResult.value.next_action.commit;
    if (commit === undefined) throw new Error("design commit instructions unavailable");
    expect(commit).not.toHaveProperty("requires_human_confirmation");
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
    });
    expect(phaseCommit).not.toHaveProperty("requires_human_confirmation");
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

  register("returns a material finding for client triage and requires an explicit revise action before remediation bytes are accepted", async () => {
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

  register("returns fresh safe status for stale, forged, cross-repository, and phase-implementation attempts without mutation", async () => {
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

  register("keeps the settled approval gate when its approval rule disappears before gate composition", async () => {
    const workspace = await createTaskWorkspace({
      taskId: "semantic-prd-rule-edit",
      label: "semantic-prd-rule-edit",
      configBytes: documentSubjectsConfig(["prd"]),
    });
    workspaces.push(workspace);
    restorers.push(installSemanticReviewStub(workspace.root, [[]]));
    const h = semanticJourneyHarness(workspace);
    const invocation = { skill: "archflow-prd", intent: "resume" } as const;
    writeFileSync(join(workspace.services.authority.task_root, "ask.md"), "Describe a rule-edit journey.\n");
    writeFileSync(join(workspace.services.authority.task_root, "prd.md"), "# Semantic journey\n\nThe client authors this document.\n");

    let view = await h.status(invocation);
    let result = await h.apply(invocation, view, { kind: "work-result", outcome: "succeeded" });
    expect(result.ok, JSON.stringify(result)).toBe(true);
    if (!result.ok) return;
    result = await h.apply(invocation, result.value);
    expect(result.ok, JSON.stringify(result)).toBe(true);
    if (!result.ok) return;
    view = result.value;
    expect(view.next_action).toMatchObject({ kind: "decide", expected_submission: "gate-summary" });

    // The config edit lands after the clean fixed point recorded `wait:true`. Gate composition must
    // consume that exact settlement rather than re-evaluating mutable config and retroactively
    // changing the completed step's outcome. The new config governs only later settlements.
    writeFileSync(
      join(workspace.services.authority.task_root, "config.yaml"),
      new TextEncoder().encode(`schema_version: "1"
roles:
  counter-reviewer: { model: gpt-5.6-sol, effort: xhigh }
  adjudicator: { model: gpt-5.6-sol, effort: xhigh }
`),
    );
    const services = await createProductionServices({
      working_directory: workspace.root,
      task_id: workspace.taskId,
      operation: parseSafeCode("semantic-prd-rule-edit"),
    });
    if (!services.ok) throw new Error(services.error.code);
    const composed = await composeRequest(services.value, {
      kind: "gate",
      summary: "The PRD is ready for approval.",
      intent_id: "gate-after-rule-removal",
    });
    expect(composed.ok, JSON.stringify(composed)).toBe(true);
    if (composed.ok) {
      expect(composed.value.envelope.tool).toBe("archflow_gate");
      expect((composed.value.envelope.request.input as { summary?: unknown }).summary).toBe(
        'The PRD is ready for approval.\n\n' +
        'Approval rule trigger: this project requires human approval for the "prd" subject.',
      );
    }
  });

  register("records wait:false but keeps the document tier behind human approval", async () => {
    // An explicitly empty ruleset — the template's own defaults now gate prd, so the journey pins
    // the rule-less config itself. No rule waits for any subject, so the completed review must not
    // offer a gate — the status seam evaluated `wait: false` and the next action is the ordinary
    // advance hand-off instead of a decision surface.
    const workspace = await createTaskWorkspace({
      taskId: "semantic-prd-no-wait-rule",
      label: "semantic-prd-no-wait-rule",
      configBytes: documentSubjectsConfig([]),
      constitutionBytes: legacyHumanAuthorityConstitutionV1Bytes(),
    });
    workspaces.push(workspace);
    restorers.push(installSemanticReviewStub(workspace.root, [[]]));
    const h = semanticJourneyHarness(workspace);
    const invocation = { skill: "archflow-prd", intent: "resume" } as const;
    writeFileSync(join(workspace.services.authority.task_root, "ask.md"), "Describe a no-wait rule journey.\n");
    writeFileSync(join(workspace.services.authority.task_root, "prd.md"), "# Semantic journey\n\nThe client authors this document.\n");

    let result = await h.apply(
      invocation,
      await h.status(invocation),
      { kind: "work-result", outcome: "succeeded" },
    );
    expect(result.ok, JSON.stringify(result)).toBe(true);
    if (!result.ok) return;
    expect(result.value.next_action.kind).toBe("review");
    result = await h.apply(invocation, result.value);
    expect(result.ok, JSON.stringify(result)).toBe(true);
    if (!result.ok) return;
    expect(result.value.next_action).toMatchObject({ kind: "decide", expected_submission: "gate-summary" });
    expect(result.value.presentation).toBeUndefined();

    // The settling transaction wrote durable evaluation evidence bound to the produced subject,
    // live config digest, and settled revision. The human decision below remains the authority.
    const detailed = await computeTaskStatusDetailed(workspace.services.dependencies, workspace.services.authority);
    if (!detailed.ok) throw new Error(detailed.error.code);
    const subjectDigest = detailed.value.status.subject_digest;
    if (subjectDigest === undefined) throw new Error("prd subject digest unavailable");
    const settled = await readTaskState(workspace.services.authority.state);
    if (settled.kind !== "canonical") throw new Error("task state unavailable");
    expect(settled.document.value.rule_settlements).toEqual([{
      task_id: workspace.taskId,
      phase_instance: settled.document.value.phase_instance,
      step: "triage",
      subject_digest: subjectDigest,
      conclusion: { wait: false, match: null },
      config_digest: sha256Bytes(readFileSync(workspace.services.authority.config.absolute)),
      settled_at_revision: settled.document.value.revision,
    }]);

    result = await h.apply(invocation, result.value, {
      kind: "gate-summary", summary: "The rule evaluation is recorded; the PRD still needs approval.",
    });
    expect(result.ok, JSON.stringify(result)).toBe(true);
    if (!result.ok) return;
    result = await h.apply(invocation, result.value, {
      kind: "decision", choice: "approve", reason: "The requirements are correct.",
    });
    expect(result.ok, JSON.stringify(result)).toBe(true);
    if (!result.ok) return;
    expect(result.value.next_action).toMatchObject({ kind: "start-next-skill", skill: "archflow-design" });

    // Only the human approval authorizes the successor handoff.
    const designInvocation = { skill: "archflow-design", intent: "resume" } as const;
    const successor = await h.status(designInvocation);
    expect(successor.next_action).toMatchObject({ kind: "start-next-skill", expected_submission: "none" });
    const startedDesign = await h.apply(designInvocation, successor);
    expect(startedDesign.ok, JSON.stringify(startedDesign)).toBe(true);
    if (!startedDesign.ok) return;
    expect(startedDesign.value.position).toEqual({ kind: "design" });
    expect(startedDesign.value.next_action.kind).toBe("submit-work");
  });

  register("advances shipped-v2 no-wait documents through exact autonomous milestone commits", async () => {
    const workspace = await createTaskWorkspace({
      taskId: "semantic-v2-autonomous-documents",
      label: "semantic-v2-autonomous-documents",
      configBytes: documentSubjectsConfig([]),
    });
    workspaces.push(workspace);
    restorers.push(installSemanticReviewStub(workspace.root, [[], [], []]));
    const h = semanticJourneyHarness(workspace);
    const creationConfigBytes = new Uint8Array(readFileSync(workspace.services.authority.config.absolute));
    const settlementConfigBytes = new TextEncoder().encode(
      `${new TextDecoder().decode(creationConfigBytes)}# config active when no-wait settlements are created\n`,
    );
    writeFileSync(workspace.services.authority.config.absolute, settlementConfigBytes);
    const prdInvocation = { skill: "archflow-prd", intent: "resume" } as const;
    writeFileSync(join(workspace.services.authority.task_root, "ask.md"), "Describe autonomous documents.\n");
    writeFileSync(join(workspace.services.authority.task_root, "prd.md"), "# Autonomous documents\n\nAdvance after review.\n");

    let view = await h.status(prdInvocation);
    let result = await h.apply(prdInvocation, view, { kind: "work-result", outcome: "succeeded" });
    if (!result.ok) throw new Error(JSON.stringify(result));
    result = await h.apply(prdInvocation, result.value);
    if (!result.ok) throw new Error(JSON.stringify(result));
    expect(result.value.next_action).toMatchObject({ kind: "start-next-skill", skill: "archflow-design" });
    expect(result.value.presentation).toBeUndefined();

    const designInvocation = { skill: "archflow-design", intent: "resume" } as const;
    view = await h.status(designInvocation);
    result = await h.apply(designInvocation, view);
    if (!result.ok) throw new Error(JSON.stringify(result));
    const designResource = result.value.resources.find((resource) => resource.role === "current-artifact");
    if (designResource === undefined) throw new Error("design resource unavailable");
    writeFileSync(join(workspace.root, designResource.path), "# Design\n\n### Phase 1: Implement autonomy\n");
    result = await h.apply(designInvocation, result.value, { kind: "work-result", outcome: "succeeded" });
    if (!result.ok) throw new Error(JSON.stringify(result));
    result = await h.apply(designInvocation, result.value);
    if (!result.ok) throw new Error(JSON.stringify(result));
    expect(result.value.next_action).toMatchObject({ kind: "commit" });
    expect(result.value.next_action.commit).not.toHaveProperty("requires_human_confirmation");

    const settledState = await readTaskState(workspace.services.authority.state);
    if (settledState.kind !== "canonical") throw new Error("settled design state unavailable");
    const designSettlement = [...(settledState.document.value.rule_settlements ?? [])]
      .filter((entry) => entry.phase_instance === "design")
      .sort((left, right) => right.settled_at_revision - left.settled_at_revision)[0];
    if (designSettlement === undefined) throw new Error("design settlement unavailable");
    expect(designSettlement.config_digest).toBe(sha256Bytes(settlementConfigBytes));
    expect(designSettlement.config_digest).not.toBe(settledState.document.value.config_digest);

    // Move HEAD without changing any task-local byte. Status must offer the bounded refresh before
    // returning new exact commit facts rooted at the unchanged reviewed subject and evidence.
    writeFileSync(join(workspace.root, "unrelated.txt"), "unrelated repository work\n");
    execFileSync("git", ["add", "--", "unrelated.txt"], { cwd: workspace.root });
    execFileSync("git", [
      "-c", "user.name=ArchFlow Test", "-c", "user.email=test@example.invalid",
      "commit", "-q", "-m", "unrelated repository work",
    ], { cwd: workspace.root });
    const movedHead = execFileSync("git", ["rev-parse", "HEAD"], { cwd: workspace.root, encoding: "utf8" }).trim();
    const postSettlementConfigBytes = new TextEncoder().encode(
      `${new TextDecoder().decode(settlementConfigBytes)}# changed after the frozen settlement\n`,
    );
    writeFileSync(workspace.services.authority.config.absolute, postSettlementConfigBytes);
    view = await h.status(designInvocation);
    expect(view.next_action.kind).not.toBe("refresh-milestone-baseline");
    expect(view.next_action).toMatchObject({ kind: "revise", expected_submission: "none" });

    // Restoring the exact live config under which the settlement was created makes the bounded
    // refresh eligible even though the task's immutable creation digest is intentionally older.
    writeFileSync(workspace.services.authority.config.absolute, settlementConfigBytes);
    view = await h.status(designInvocation);
    expect(view.next_action).toMatchObject({ kind: "refresh-milestone-baseline", expected_submission: "none" });
    result = await h.apply(designInvocation, view);
    if (!result.ok) throw new Error(JSON.stringify(result));
    const designCommit = result.value.next_action.commit;
    if (designCommit === undefined) throw new Error("refreshed design commit unavailable");
    expect(designCommit).toMatchObject({ baseline: movedHead });
    expect(designCommit).not.toHaveProperty("requires_human_confirmation");
    execFileSync("git", ["add", "-A", "--", ...designCommit.paths], { cwd: workspace.root });
    execFileSync("git", [
      "-c", "user.name=ArchFlow Test", "-c", "user.email=test@example.invalid",
      "commit", "-q", "-m", designCommit.message, "--", ...designCommit.paths,
    ], { cwd: workspace.root });

    view = await h.status(designInvocation);
    expect(view.next_action).toMatchObject({
      kind: "start-next-skill", skill: "archflow-phase-design", skill_args: ["1"],
    });
    const phaseInvocation = { skill: "archflow-phase-design", phase: 1, intent: "resume" } as const;
    view = await h.status(phaseInvocation);
    const designPinnedBranch = execFileSync(
      "git", ["symbolic-ref", "--short", "HEAD"], { cwd: workspace.root, encoding: "utf8" },
    ).trim();
    execFileSync("git", ["switch", "-q", "-c", "same-commit-design-race"], { cwd: workspace.root });
    const designSwitched = await h.apply(phaseInvocation, view);
    expect(designSwitched).toMatchObject({ ok: false, error: { retryable: false } });
    execFileSync("git", ["switch", "-q", designPinnedBranch], { cwd: workspace.root });
    view = await h.status(phaseInvocation);
    result = await h.apply(phaseInvocation, view);
    if (!result.ok) throw new Error(JSON.stringify(result));
    const phaseResource = result.value.resources.find((resource) => resource.role === "current-artifact");
    if (phaseResource === undefined) throw new Error("phase-design resource unavailable");
    mkdirSync(dirname(join(workspace.root, phaseResource.path)), { recursive: true });
    writeFileSync(join(workspace.root, phaseResource.path), `# Phase 1: Implement autonomy

## Goal

Prove exact autonomous phase-design advancement.

## Requirements

- Preserve exact reviewed bytes.

## Context

The task design contains one phase.

## Files

- \`src/state/next-action.ts\`: preserve autonomous routing.

## Work Chunks

### Autonomous routing

Verify the exact reviewed milestone commit.

## Pinned Cross-Chunk Interfaces

The reviewed settlement is phase-bound.

## Success Criteria

The implementation handoff is offered after exact commit proof.

## Executable Verification

- \`npm run typecheck\`
`);
    result = await h.apply(phaseInvocation, result.value, { kind: "work-result", outcome: "succeeded" });
    if (!result.ok) throw new Error(JSON.stringify(result));
    result = await h.apply(phaseInvocation, result.value);
    if (!result.ok) throw new Error(JSON.stringify(result));
    const phaseCommit = result.value.next_action.commit;
    if (phaseCommit === undefined) throw new Error("autonomous phase-design commit unavailable");
    expect(phaseCommit).not.toHaveProperty("requires_human_confirmation");
    const legacyState = JSON.parse(readFileSync(workspace.services.authority.state.absolute, "utf8"));
    for (const legacySettlement of legacyState.rule_settlements.filter(
      (entry: { phase_instance?: string }) => entry.phase_instance === "phase-design-1",
    )) {
      delete legacySettlement.milestone_target_ref;
      delete legacySettlement.milestone_target_head;
    }
    writeFileSync(workspace.services.authority.state.absolute, canonicalJsonBytes(legacyState));
    execFileSync("git", ["add", "-A", "--", ...phaseCommit.paths], { cwd: workspace.root });
    execFileSync("git", [
      "-c", "user.name=ArchFlow Test", "-c", "user.email=test@example.invalid",
      "commit", "-q", "-m", phaseCommit.message, "--", ...phaseCommit.paths,
    ], { cwd: workspace.root });
    view = await h.status(phaseInvocation);
    expect(view.next_action).toMatchObject({
      kind: "start-next-skill", skill: "archflow-phase-impl", skill_args: ["1"],
    });

    const implementationInvocation = { skill: "archflow-phase-impl", phase: 1, intent: "resume" } as const;
    // A pre-target-facts settlement remains readable, but only at the exact milestone tip. An
    // unrelated descendant after the offer cannot acquire invented target identity at apply.
    const legacyOffer = await h.status(implementationInvocation);
    expect(legacyOffer.next_action).toMatchObject({ kind: "start-next-skill", expected_submission: "none" });
    writeFileSync(join(workspace.root, "post-phase-design.txt"), "ordinary descendant\n");
    execFileSync("git", ["add", "--", "post-phase-design.txt"], { cwd: workspace.root });
    execFileSync("git", [
      "-c", "user.name=ArchFlow Test", "-c", "user.email=test@example.invalid",
      "commit", "-q", "-m", "ordinary descendant after phase design",
    ], { cwd: workspace.root });
    const descendantRefusal = await h.apply(implementationInvocation, legacyOffer);
    expect(descendantRefusal).toMatchObject({ ok: false, error: { retryable: false } });
    expect(readFileSync(join(workspace.root, "semantic-review-count"), "utf8")).toBe("3");
  });

  register("records a wait:false design settlement but requires human milestone approval", async () => {
    // The PRD records a matching rule and the design records wait:false. Both still require human
    // approval; the settlement never supplies milestone or recovery authority.
    const workspace = await createTaskWorkspace({
      taskId: "semantic-design-no-wait-rule",
      label: "semantic-design-no-wait-rule",
      configBytes: documentSubjectsConfig(["prd"]),
      constitutionBytes: legacyHumanAuthorityConstitutionV1Bytes(),
    });
    workspaces.push(workspace);
    restorers.push(installSemanticReviewStub(workspace.root, [[]]));
    const h = semanticJourneyHarness(workspace);
    const invocation = { skill: "archflow-prd", intent: "resume" } as const;
    writeFileSync(join(workspace.services.authority.task_root, "ask.md"), "Describe a no-wait design-rule journey.\n");
    writeFileSync(join(workspace.services.authority.task_root, "prd.md"), "# Semantic journey\n\nThe client authors this document.\n");

    let result = await h.apply(
      invocation,
      await h.status(invocation),
      { kind: "work-result", outcome: "succeeded" },
    );
    expect(result.ok, JSON.stringify(result)).toBe(true);
    if (!result.ok) return;
    result = await h.apply(invocation, result.value);
    expect(result.ok, JSON.stringify(result)).toBe(true);
    if (!result.ok) return;
    expect(result.value.next_action).toMatchObject({ kind: "decide", expected_submission: "gate-summary" });
    result = await h.apply(invocation, result.value, { kind: "gate-summary", summary: "The PRD is ready for approval." });
    expect(result.ok, JSON.stringify(result)).toBe(true);
    if (!result.ok) return;
    result = await h.apply(invocation, result.value, { kind: "decision", choice: "approve", reason: "The requirements are correct." });
    expect(result.ok, JSON.stringify(result)).toBe(true);
    if (!result.ok) return;
    // The prd tier persists the exact rule match that required its human approval.
    const gated = await readTaskState(workspace.services.authority.state);
    if (gated.kind !== "canonical") throw new Error("task state unavailable");
    expect(gated.document.value.rule_settlements).toEqual([expect.objectContaining({
      phase_instance: "prd",
      conclusion: { wait: true, match: { kind: "subject", subject: "prd" } },
    })]);

    const designInvocation = { skill: "archflow-design", intent: "resume" } as const;
    let design = await h.apply(designInvocation, await h.status(designInvocation));
    expect(design.ok, JSON.stringify(design)).toBe(true);
    if (!design.ok) return;
    expect(design.value.next_action.kind).toBe("submit-work");
    const designResource = design.value.resources.find((resource) => resource.role === "current-artifact");
    if (designResource === undefined) throw new Error("design resource unavailable");
    writeFileSync(join(workspace.root, designResource.path), "# Design\n\n### Phase 1: Implement the verified behavior\n");
    design = await h.apply(designInvocation, design.value, { kind: "work-result", outcome: "succeeded" });
    expect(design.ok, JSON.stringify(design)).toBe(true);
    if (!design.ok) return;
    design = await h.apply(designInvocation, design.value);
    expect(design.ok, JSON.stringify(design)).toBe(true);
    if (!design.ok) return;
    // No rule waits for the design subject, so the transaction records wait:false. The ordinary
    // human gate remains required by the current constitution.
    expect(design.value.next_action).toMatchObject({ kind: "decide", expected_submission: "gate-summary" });
    const detailed = await computeTaskStatusDetailed(workspace.services.dependencies, workspace.services.authority);
    if (!detailed.ok) throw new Error(detailed.error.code);
    const subjectDigest = detailed.value.status.subject_digest;
    if (subjectDigest === undefined) throw new Error("design subject digest unavailable");
    const settled = await readTaskState(workspace.services.authority.state);
    if (settled.kind !== "canonical") throw new Error("task state unavailable");
    expect(settled.document.value.rule_settlements).toEqual([{
      task_id: workspace.taskId,
      phase_instance: settled.document.value.phase_instance,
      step: "triage",
      subject_digest: subjectDigest,
      conclusion: { wait: false, match: null },
      config_digest: sha256Bytes(readFileSync(workspace.services.authority.config.absolute)),
      milestone_baseline_commit: execFileSync(
        "git", ["rev-parse", "HEAD"], { cwd: workspace.root, encoding: "utf8" },
      ).trim(),
      milestone_target_ref: execFileSync(
        "git", ["symbolic-ref", "-q", "HEAD"], { cwd: workspace.root, encoding: "utf8" },
      ).trim(),
      milestone_target_head: execFileSync(
        "git", ["rev-parse", "HEAD"], { cwd: workspace.root, encoding: "utf8" },
      ).trim(),
      settled_at_revision: settled.document.value.revision,
    }, expect.objectContaining({
      phase_instance: "prd",
      conclusion: { wait: true, match: { kind: "subject", subject: "prd" } },
    })]);
    expect(settled.document.value.planned_final_phase).toBeUndefined();

    design = await h.apply(designInvocation, design.value, {
      kind: "gate-summary", summary: "The rule evaluation is recorded; the design still needs approval.",
    });
    expect(design.ok, JSON.stringify(design)).toBe(true);
    if (!design.ok) return;
    design = await h.apply(designInvocation, design.value, {
      kind: "decision", choice: "approve", reason: "The design is implementable.",
    });
    expect(design.ok, JSON.stringify(design)).toBe(true);
    if (!design.ok) return;

    // The human decision, not the settlement, authorizes the milestone commit.
    const atCommit = await h.status(designInvocation);
    expect(atCommit.next_action).toMatchObject({ kind: "commit" });
    expect(atCommit.presentation).toBeUndefined();
    const commit = atCommit.next_action.commit;
    if (commit === undefined) throw new Error("design commit instructions unavailable");
    expect(commit).toMatchObject({
      paths: [`.archflow/tasks/${workspace.taskId}`],
      message: `ArchFlow: Approve ${workspace.taskId} design`,
      target_ref: execFileSync("git", ["symbolic-ref", "-q", "HEAD"], { cwd: workspace.root, encoding: "utf8" }).trim(),
      baseline: execFileSync("git", ["rev-parse", "HEAD"], { cwd: workspace.root, encoding: "utf8" }).trim(),
    });
    expect(commit).not.toHaveProperty("requires_human_confirmation");

    // The milestone commit carries the settlement as evaluation evidence, while the archived
    // human approval remains the recovery and advancement authority.
    execFileSync("git", ["add", "-A", "--", ...commit.paths], { cwd: workspace.root });
    execFileSync("git", ["-c", "user.name=ArchFlow Test", "-c", "user.email=test@example.invalid", "commit", "-q", "-m", commit.message], { cwd: workspace.root });
    const observed = await h.status(designInvocation);
    expect(observed.next_action).toMatchObject({ kind: "start-next-skill", skill: "archflow-phase-design", skill_args: ["1"] });
  });

  register("keeps shipped-default PRD and design gates while phase design advances autonomously", async () => {
    // Fresh-project defaults record matching rules for PRD and design, while the unlisted
    // phase-design subject advances directly from its authenticated shipped-v2 settlement.
    const workspace = await createTaskWorkspace({ taskId: "semantic-template-defaults", label: "semantic-template-defaults" });
    workspaces.push(workspace);
    restorers.push(installSemanticReviewStub(workspace.root, [[]]));
    const h = semanticJourneyHarness(workspace);
    const invocation = { skill: "archflow-prd", intent: "resume" } as const;
    writeFileSync(join(workspace.services.authority.task_root, "ask.md"), "Describe a template-defaults journey.\n");
    writeFileSync(join(workspace.services.authority.task_root, "prd.md"), "# Semantic journey\n\nThe client authors this document.\n");

    let result = await h.apply(invocation, await h.status(invocation), { kind: "work-result", outcome: "succeeded" });
    expect(result.ok, JSON.stringify(result)).toBe(true);
    if (!result.ok) return;
    result = await h.apply(invocation, result.value);
    expect(result.ok, JSON.stringify(result)).toBe(true);
    if (!result.ok) return;
    // The shipped defaults alone stop the first PRD for a human decision.
    expect(result.value.next_action).toMatchObject({ kind: "decide", expected_submission: "gate-summary" });
    result = await h.apply(invocation, result.value, { kind: "gate-summary", summary: "The PRD is ready for approval." });
    expect(result.ok, JSON.stringify(result)).toBe(true);
    if (!result.ok) return;
    result = await h.apply(invocation, result.value, { kind: "decision", choice: "approve", reason: "The requirements are correct." });
    expect(result.ok, JSON.stringify(result)).toBe(true);
    if (!result.ok) return;

    const designInvocation = { skill: "archflow-design", intent: "resume" } as const;
    let design = await h.apply(designInvocation, await h.status(designInvocation));
    expect(design.ok, JSON.stringify(design)).toBe(true);
    if (!design.ok) return;
    const designResource = design.value.resources.find((resource) => resource.role === "current-artifact");
    if (designResource === undefined) throw new Error("design resource unavailable");
    writeFileSync(join(workspace.root, designResource.path), "# Design\n\n### Phase 1: Implement the verified behavior\n");
    design = await h.apply(designInvocation, design.value, { kind: "work-result", outcome: "succeeded" });
    expect(design.ok, JSON.stringify(design)).toBe(true);
    if (!design.ok) return;
    design = await h.apply(designInvocation, design.value);
    expect(design.ok, JSON.stringify(design)).toBe(true);
    if (!design.ok) return;
    // The shipped defaults stop the architecture/design too — no project-specific rule was added.
    expect(design.value.next_action).toMatchObject({ kind: "decide", expected_submission: "gate-summary" });
    design = await h.apply(designInvocation, design.value, { kind: "gate-summary", summary: "The architecture and one-phase plan are ready." });
    expect(design.ok, JSON.stringify(design)).toBe(true);
    if (!design.ok) return;
    design = await h.apply(designInvocation, design.value, { kind: "decision", choice: "approve", reason: "The design is implementable." });
    expect(design.ok, JSON.stringify(design)).toBe(true);
    if (!design.ok) return;
    expect(design.value.next_action.kind).toBe("commit");
    const designCommit = design.value.next_action.commit;
    if (designCommit === undefined) throw new Error("design commit instructions unavailable");
    execFileSync("git", ["add", "-A", "--", ...designCommit.paths], { cwd: workspace.root });
    execFileSync("git", ["-c", "user.name=ArchFlow Test", "-c", "user.email=test@example.invalid", "commit", "-q", "-m", designCommit.message], { cwd: workspace.root });

    // No rule waits for phase-design, so its completed review records wait:false and returns exact
    // autonomous milestone commit facts without opening a human presentation.
    const phaseDesignInvocation = { skill: "archflow-phase-design", phase: 1, intent: "resume" } as const;
    let phaseDesign = await h.apply(phaseDesignInvocation, await h.status(phaseDesignInvocation));
    expect(phaseDesign.ok, JSON.stringify(phaseDesign)).toBe(true);
    if (!phaseDesign.ok) return;
    const phaseDesignResource = phaseDesign.value.resources.find((resource) => resource.role === "current-artifact");
    if (phaseDesignResource === undefined) throw new Error("phase-design resource unavailable");
    const phaseDesignPath = join(workspace.root, phaseDesignResource.path);
    mkdirSync(dirname(phaseDesignPath), { recursive: true });
    writeFileSync(phaseDesignPath, `# Phase 1: Implement the verified behavior

## Goal

Record the phase-design rule evaluation and advance from authenticated no-wait authority.

## Requirements

- The settling transaction writes durable rule-evaluation evidence.
- Exact shipped-v2 policy authorizes the clean no-wait milestone.

## Success Criteria

The committed state carries the settlement and the successor hand-off is offered.
`);
    phaseDesign = await h.apply(phaseDesignInvocation, phaseDesign.value, { kind: "work-result", outcome: "succeeded" });
    expect(phaseDesign.ok, JSON.stringify(phaseDesign)).toBe(true);
    if (!phaseDesign.ok) return;
    phaseDesign = await h.apply(phaseDesignInvocation, phaseDesign.value);
    expect(phaseDesign.ok, JSON.stringify(phaseDesign)).toBe(true);
    if (!phaseDesign.ok) return;
    expect(phaseDesign.value.next_action).toMatchObject({ kind: "commit" });
    expect(phaseDesign.value.presentation).toBeUndefined();
    const settled = await readTaskState(workspace.services.authority.state);
    if (settled.kind !== "canonical") throw new Error("task state unavailable");
    expect(settled.document.value.open_gate).toBeUndefined();

    // The entry binds the phase-design subject, template-copy config digest, and settled revision.
    const detailed = await computeTaskStatusDetailed(workspace.services.dependencies, workspace.services.authority);
    if (!detailed.ok) throw new Error(detailed.error.code);
    const subjectDigest = detailed.value.status.subject_digest;
    if (subjectDigest === undefined) throw new Error("phase-design subject digest unavailable");
    const receipt = {
      task_id: workspace.taskId,
      phase_instance: settled.document.value.phase_instance,
      step: "triage",
      subject_digest: subjectDigest,
      conclusion: { wait: false, match: null },
      config_digest: sha256Bytes(readFileSync(workspace.services.authority.config.absolute)),
      milestone_baseline_commit: execFileSync(
        "git", ["rev-parse", "HEAD"], { cwd: workspace.root, encoding: "utf8" },
      ).trim(),
      milestone_target_ref: execFileSync(
        "git", ["symbolic-ref", "-q", "HEAD"], { cwd: workspace.root, encoding: "utf8" },
      ).trim(),
      milestone_target_head: execFileSync(
        "git", ["rev-parse", "HEAD"], { cwd: workspace.root, encoding: "utf8" },
      ).trim(),
      settled_at_revision: settled.document.value.revision,
    };
    expect(settled.document.value.rule_settlements).toEqual(expect.arrayContaining([receipt]));

    // The authenticated no-wait settlement directly derives the milestone commit facts.
    const atCommit = await h.status(phaseDesignInvocation);
    expect(atCommit.next_action).toMatchObject({ kind: "commit" });
    expect(atCommit.presentation).toBeUndefined();
    const commit = atCommit.next_action.commit;
    if (commit === undefined) throw new Error("phase-design commit instructions unavailable");
    expect(commit).toMatchObject({
      paths: [`.archflow/tasks/${workspace.taskId}`],
      message: `ArchFlow: Approve ${workspace.taskId} phase 1 design`,
      target_ref: execFileSync("git", ["symbolic-ref", "-q", "HEAD"], { cwd: workspace.root, encoding: "utf8" }).trim(),
      baseline: execFileSync("git", ["rev-parse", "HEAD"], { cwd: workspace.root, encoding: "utf8" }).trim(),
    });
    expect(commit).not.toHaveProperty("requires_human_confirmation");

    // The milestone commit carries the settlement; fresh status observes its exact proof.
    execFileSync("git", ["add", "-A", "--", ...commit.paths], { cwd: workspace.root });
    execFileSync("git", [
      "-c", "user.name=ArchFlow Test", "-c", "user.email=test@example.invalid",
      "commit", "-q", "-m", commit.message, "--", ...commit.paths,
    ], { cwd: workspace.root });
    const committedState: { rule_settlements?: unknown } = JSON.parse(execFileSync(
      "git", ["show", `HEAD:.archflow/tasks/${workspace.taskId}/state.json`],
      { cwd: workspace.root, encoding: "utf8" },
    ));
    expect(committedState.rule_settlements).toEqual(expect.arrayContaining([receipt]));
    const observed = await h.status(phaseDesignInvocation);
    expect(observed.next_action).toMatchObject({ kind: "start-next-skill", skill: "archflow-phase-impl", skill_args: ["1"] });
    expect(observed.next_action.offer).toBeUndefined();
  });

  register("requires human design approval when a phase design changes the architecture design", async () => {
    // Fresh-project defaults: the phase-design subject is unlisted, but the shipped content rule
    // watches the task's governing documents, so rewriting design.md from a phase is one
    // configured human boundary — and only then.
    const workspace = await createTaskWorkspace({ taskId: "semantic-phase-architecture", label: "semantic-phase-architecture" });
    workspaces.push(workspace);
    restorers.push(installSemanticReviewStub(workspace.root, [[]]));
    const h = semanticJourneyHarness(workspace);
    const invocation = { skill: "archflow-prd", intent: "resume" } as const;
    writeFileSync(join(workspace.services.authority.task_root, "ask.md"), "Describe an architecture-change journey.\n");
    writeFileSync(join(workspace.services.authority.task_root, "prd.md"), "# Semantic journey\n\nThe client authors this document.\n");

    let result = await h.apply(invocation, await h.status(invocation), { kind: "work-result", outcome: "succeeded" });
    expect(result.ok, JSON.stringify(result)).toBe(true);
    if (!result.ok) return;
    result = await h.apply(invocation, result.value);
    expect(result.ok, JSON.stringify(result)).toBe(true);
    if (!result.ok) return;
    result = await h.apply(invocation, result.value, { kind: "gate-summary", summary: "The PRD is ready for approval." });
    expect(result.ok, JSON.stringify(result)).toBe(true);
    if (!result.ok) return;
    result = await h.apply(invocation, result.value, { kind: "decision", choice: "approve", reason: "The requirements are correct." });
    expect(result.ok, JSON.stringify(result)).toBe(true);
    if (!result.ok) return;

    const designInvocation = { skill: "archflow-design", intent: "resume" } as const;
    let design = await h.apply(designInvocation, await h.status(designInvocation));
    expect(design.ok, JSON.stringify(design)).toBe(true);
    if (!design.ok) return;
    const designResource = design.value.resources.find((resource) => resource.role === "current-artifact");
    if (designResource === undefined) throw new Error("design resource unavailable");
    writeFileSync(join(workspace.root, designResource.path), "# Design\n\n### Phase 1: Implement the verified behavior\n\n### Phase 2: Implement the follow-on behavior\n");
    design = await h.apply(designInvocation, design.value, { kind: "work-result", outcome: "succeeded" });
    expect(design.ok, JSON.stringify(design)).toBe(true);
    if (!design.ok) return;
    design = await h.apply(designInvocation, design.value);
    expect(design.ok, JSON.stringify(design)).toBe(true);
    if (!design.ok) return;
    design = await h.apply(designInvocation, design.value, { kind: "gate-summary", summary: "The architecture and two-phase plan are ready." });
    expect(design.ok, JSON.stringify(design)).toBe(true);
    if (!design.ok) return;
    design = await h.apply(designInvocation, design.value, { kind: "decision", choice: "approve", reason: "The design is implementable." });
    expect(design.ok, JSON.stringify(design)).toBe(true);
    if (!design.ok) return;
    const designCommit = design.value.next_action.commit;
    if (designCommit === undefined) throw new Error("design commit instructions unavailable");
    execFileSync("git", ["add", "-A", "--", ...designCommit.paths], { cwd: workspace.root });
    execFileSync("git", ["-c", "user.name=ArchFlow Test", "-c", "user.email=test@example.invalid", "commit", "-q", "-m", designCommit.message], { cwd: workspace.root });

    const phaseDesignInvocation = { skill: "archflow-phase-design", phase: 1, intent: "resume" } as const;
    let phaseDesign = await h.apply(phaseDesignInvocation, await h.status(phaseDesignInvocation));
    expect(phaseDesign.ok, JSON.stringify(phaseDesign)).toBe(true);
    if (!phaseDesign.ok) return;
    const phaseDesignResource = phaseDesign.value.resources.find((resource) => resource.role === "current-artifact");
    const taskDesignResource = phaseDesign.value.resources.find((resource) => resource.role === "task-design");
    if (phaseDesignResource === undefined || taskDesignResource === undefined) throw new Error("phase-design resources unavailable");
    expect(taskDesignResource.access).toBe("read-write");
    const phaseDesignPath = join(workspace.root, phaseDesignResource.path);
    mkdirSync(dirname(phaseDesignPath), { recursive: true });
    writeFileSync(phaseDesignPath, "# Phase 1: Implement the verified behavior\n\n## Goal\n\nPlan the phase and correct the architecture it depends on.\n");
    // Planning found the architecture wrong; the phase design corrects design.md in the same result.
    writeFileSync(join(workspace.root, taskDesignResource.path),
      "# Design\n\nThe boundary moves into the first phase.\n\n### Phase 1: Implement the verified behavior\n\n### Phase 2: Implement the follow-on behavior\n");
    phaseDesign = await h.apply(phaseDesignInvocation, phaseDesign.value, { kind: "work-result", outcome: "succeeded" });
    expect(phaseDesign.ok, JSON.stringify(phaseDesign)).toBe(true);
    if (!phaseDesign.ok) return;
    phaseDesign = await h.apply(phaseDesignInvocation, phaseDesign.value);
    expect(phaseDesign.ok, JSON.stringify(phaseDesign)).toBe(true);
    if (!phaseDesign.ok) return;
    expect(phaseDesign.value.next_action).toMatchObject({ kind: "decide", expected_submission: "gate-summary" });

    phaseDesign = await h.apply(phaseDesignInvocation, phaseDesign.value, { kind: "gate-summary", summary: "Phase 1 planning changed the architecture design." });
    expect(phaseDesign.ok, JSON.stringify(phaseDesign)).toBe(true);
    if (!phaseDesign.ok) return;
    expect(phaseDesign.value.presentation?.class).toBe("configured-approval");
    expect(phaseDesign.value.presentation?.reasons).toEqual([
      expect.objectContaining({ class: "configured-approval", text: expect.stringContaining("this phase changed the architecture design") }),
    ]);
    phaseDesign = await h.apply(phaseDesignInvocation, phaseDesign.value, { kind: "decision", choice: "approve", reason: "The corrected architecture is right." });
    expect(phaseDesign.ok, JSON.stringify(phaseDesign)).toBe(true);
    if (!phaseDesign.ok) return;
    expect(phaseDesign.value.next_action).toMatchObject({ kind: "commit" });
  });

  register("requires approvals even when every configured document rule evaluates wait:false", async () => {
    // With no matching document rules, each tier records wait:false but still creates an ordinary
    // human decision archive. This pins that settlements alone never become recovery authority.
    const workspace = await createTaskWorkspace({
      taskId: "semantic-all-no-wait-rules",
      label: "semantic-all-no-wait-rules",
      configBytes: documentSubjectsConfig([]),
      constitutionBytes: legacyHumanAuthorityConstitutionV1Bytes(),
    });
    workspaces.push(workspace);
    restorers.push(installSemanticReviewStub(workspace.root, [[]]));
    const decisionsPath = join(workspace.services.authority.task_root, "authority", "decisions");
    const h = semanticJourneyHarness(workspace);
    const invocation = { skill: "archflow-prd", intent: "resume" } as const;
    writeFileSync(join(workspace.services.authority.task_root, "ask.md"), "Describe an all-no-wait-rules journey.\n");
    writeFileSync(join(workspace.services.authority.task_root, "prd.md"), "# Semantic journey\n\nThe client authors this document.\n");

    let result = await h.apply(invocation, await h.status(invocation), { kind: "work-result", outcome: "succeeded" });
    expect(result.ok, JSON.stringify(result)).toBe(true);
    if (!result.ok) return;
    result = await h.apply(invocation, result.value);
    expect(result.ok, JSON.stringify(result)).toBe(true);
    if (!result.ok) return;
    expect(result.value.next_action).toMatchObject({ kind: "decide", expected_submission: "gate-summary" });
    expect(existsSync(decisionsPath)).toBe(false);
    const prdSettled = await readTaskState(workspace.services.authority.state);
    if (prdSettled.kind !== "canonical") throw new Error("task state unavailable");
    const prdReceipt = prdSettled.document.value.rule_settlements?.[0];
    if (prdReceipt === undefined) throw new Error("prd receipt unavailable");
    expect(prdReceipt).toMatchObject({
      task_id: workspace.taskId,
      phase_instance: "prd",
      step: "triage",
      conclusion: { wait: false, match: null },
    });
    result = await h.apply(invocation, result.value, {
      kind: "gate-summary", summary: "The rule evaluation is recorded; the PRD still needs approval.",
    });
    expect(result.ok, JSON.stringify(result)).toBe(true);
    if (!result.ok) return;
    result = await h.apply(invocation, result.value, {
      kind: "decision", choice: "approve", reason: "The requirements are correct.",
    });
    expect(result.ok, JSON.stringify(result)).toBe(true);
    if (!result.ok) return;
    expect(result.value.next_action).toMatchObject({ kind: "start-next-skill", skill: "archflow-design" });

    const designInvocation = { skill: "archflow-design", intent: "resume" } as const;
    let design = await h.apply(designInvocation, await h.status(designInvocation));
    expect(design.ok, JSON.stringify(design)).toBe(true);
    if (!design.ok) return;
    const designResource = design.value.resources.find((resource) => resource.role === "current-artifact");
    if (designResource === undefined) throw new Error("design resource unavailable");
    writeFileSync(join(workspace.root, designResource.path), "# Design\n\n### Phase 1: Implement the verified behavior\n");
    design = await h.apply(designInvocation, design.value, { kind: "work-result", outcome: "succeeded" });
    expect(design.ok, JSON.stringify(design)).toBe(true);
    if (!design.ok) return;
    design = await h.apply(designInvocation, design.value);
    expect(design.ok, JSON.stringify(design)).toBe(true);
    if (!design.ok) return;
    expect(design.value.next_action).toMatchObject({ kind: "decide", expected_submission: "gate-summary" });

    // The design settlement has the same writer and binding rules, and the earlier PRD settlement
    // survives beside it (the sorted set orders by phase instance, design before PRD).
    const detailed = await computeTaskStatusDetailed(workspace.services.dependencies, workspace.services.authority);
    if (!detailed.ok) throw new Error(detailed.error.code);
    const subjectDigest = detailed.value.status.subject_digest;
    if (subjectDigest === undefined) throw new Error("design subject digest unavailable");
    const settled = await readTaskState(workspace.services.authority.state);
    if (settled.kind !== "canonical") throw new Error("task state unavailable");
    expect(settled.document.value.rule_settlements).toHaveLength(2);
    expect(settled.document.value.rule_settlements).toContainEqual(prdReceipt);
    expect(settled.document.value.rule_settlements).toContainEqual({
      task_id: workspace.taskId,
      phase_instance: "design",
      step: "triage",
      subject_digest: subjectDigest,
      conclusion: { wait: false, match: null },
      config_digest: sha256Bytes(readFileSync(workspace.services.authority.config.absolute)),
      milestone_baseline_commit: execFileSync(
        "git", ["rev-parse", "HEAD"], { cwd: workspace.root, encoding: "utf8" },
      ).trim(),
      milestone_target_ref: execFileSync(
        "git", ["symbolic-ref", "-q", "HEAD"], { cwd: workspace.root, encoding: "utf8" },
      ).trim(),
      milestone_target_head: execFileSync(
        "git", ["rev-parse", "HEAD"], { cwd: workspace.root, encoding: "utf8" },
      ).trim(),
      settled_at_revision: settled.document.value.revision,
    });

    design = await h.apply(designInvocation, design.value, {
      kind: "gate-summary", summary: "The rule evaluation is recorded; the design still needs approval.",
    });
    expect(design.ok, JSON.stringify(design)).toBe(true);
    if (!design.ok) return;
    design = await h.apply(designInvocation, design.value, {
      kind: "decision", choice: "approve", reason: "The design is implementable.",
    });
    expect(design.ok, JSON.stringify(design)).toBe(true);
    if (!design.ok) return;
    const atCommit = await h.status(designInvocation);
    expect(atCommit.next_action).toMatchObject({ kind: "commit" });
    expect(atCommit.presentation).toBeUndefined();
    const commit = atCommit.next_action.commit;
    if (commit === undefined) throw new Error("design commit instructions unavailable");
    expect(commit).toMatchObject({
      paths: [`.archflow/tasks/${workspace.taskId}`],
      message: `ArchFlow: Approve ${workspace.taskId} design`,
    });
    expect(commit).not.toHaveProperty("requires_human_confirmation");

    // The archived human decisions, not either settlement, authorize the milestone.
    execFileSync("git", ["add", "-A", "--", ...commit.paths], { cwd: workspace.root });
    execFileSync("git", [
      "-c", "user.name=ArchFlow Test", "-c", "user.email=test@example.invalid",
      "commit", "-q", "-m", commit.message, "--", ...commit.paths,
    ], { cwd: workspace.root });
    expect(existsSync(decisionsPath)).toBe(true);
    const observed = await h.status(designInvocation);
    expect(observed.next_action).toMatchObject({ kind: "start-next-skill", skill: "archflow-phase-design", skill_args: ["1"] });
  });

  register("keeps waiver decisions human and advances after their granted wait:false settlement", async () => {
    // No subject rule waits for the design document, but a constitution rule fails its review:
    // the foldable adjudication fixed point records the exact wait:false receipt while the policy
    // finding is carried by design-approval. The phase exit still refuses until the separate
    // waiver decisions discharge every policy axis.
    const workspace = await createTaskWorkspace({
      taskId: "semantic-design-policy-arm",
      label: "semantic-design-policy-arm",
      configBytes: documentSubjectsConfig(["prd"]),
    });
    workspaces.push(workspace);
    const restorePassing = installSemanticReviewStub(workspace.root, [[]]);
    restorers.push(restorePassing);
    const h = semanticJourneyHarness(workspace);
    const invocation = { skill: "archflow-prd", intent: "resume" } as const;
    writeFileSync(join(workspace.services.authority.task_root, "ask.md"), "Describe a policy-arm design journey.\n");
    writeFileSync(join(workspace.services.authority.task_root, "prd.md"), "# Semantic journey\n\nThe client authors this document.\n");

    let result = await h.apply(invocation, await h.status(invocation), { kind: "work-result", outcome: "succeeded" });
    expect(result.ok, JSON.stringify(result)).toBe(true);
    if (!result.ok) return;
    result = await h.apply(invocation, result.value);
    expect(result.ok, JSON.stringify(result)).toBe(true);
    if (!result.ok) return;
    result = await h.apply(invocation, result.value, { kind: "gate-summary", summary: "The PRD is ready for approval." });
    expect(result.ok, JSON.stringify(result)).toBe(true);
    if (!result.ok) return;
    result = await h.apply(invocation, result.value, { kind: "decision", choice: "approve", reason: "The requirements are correct." });
    expect(result.ok, JSON.stringify(result)).toBe(true);
    if (!result.ok) return;

    // From here every adjudicated constitution rule reports a matched, violated trigger.
    restorePassing();
    restorers.push(installSemanticReviewStub(workspace.root, [[]], { adjudicationCompliance: "fail" }));

    const designInvocation = { skill: "archflow-design", intent: "resume" } as const;
    let design = await h.apply(designInvocation, await h.status(designInvocation));
    expect(design.ok, JSON.stringify(design)).toBe(true);
    if (!design.ok) return;
    const designResource = design.value.resources.find((resource) => resource.role === "current-artifact");
    if (designResource === undefined) throw new Error("design resource unavailable");
    writeFileSync(join(workspace.root, designResource.path), "# Design\n\n### Phase 1: Implement the verified behavior\n");
    design = await h.apply(designInvocation, design.value, { kind: "work-result", outcome: "succeeded" });
    expect(design.ok, JSON.stringify(design)).toBe(true);
    if (!design.ok) return;
    design = await h.apply(designInvocation, design.value);
    expect(design.ok, JSON.stringify(design)).toBe(true);
    if (!design.ok) return;

    // The policy arm opens design-approval despite the absent subject rule. Its frozen settlement
    // is evaluation evidence only; the unresolved policy gate has no milestone commit authority.
    expect(design.value.next_action).toMatchObject({ kind: "decide", expected_submission: "gate-summary" });
    expect(design.value.next_action.commit).toBeUndefined();
    const unsettled = await readTaskState(workspace.services.authority.state);
    if (unsettled.kind !== "canonical") throw new Error("task state unavailable");
    const frozenDesignSettlements = unsettled.document.value.rule_settlements?.filter((entry) =>
      entry.phase_instance === "design") ?? [];
    expect(frozenDesignSettlements).toEqual([expect.objectContaining({
      conclusion: { wait: false, match: null },
    })]);

    // The opened gate is still approval-shaped: a human can discharge it by decision.
    design = await h.apply(designInvocation, design.value, { kind: "gate-summary", summary: "The design needs an explicit human decision." });
    expect(design.ok, JSON.stringify(design)).toBe(true);
    if (!design.ok) return;
    expect(design.value.presentation?.options.map((option) => option.token)).toContain("approve");
    const waiverToken = design.value.presentation?.options
      .map((option) => option.token)
      .find((token) => token.startsWith("request-exception-"));
    expect(waiverToken).toBeDefined();

    design = await h.apply(designInvocation, design.value, {
      kind: "decision", choice: waiverToken!, reason: "Request a bounded policy exception.",
      option_rationale: "The rule is not relevant to this reviewed design.",
    });
    expect(design.ok, JSON.stringify(design)).toBe(true);
    if (!design.ok) return;
    expect(design.value.next_action).toMatchObject({ kind: "open-waiver", expected_submission: "none" });
    design = await h.apply(designInvocation, design.value);
    expect(design.ok, JSON.stringify(design)).toBe(true);
    if (!design.ok) return;
    design = await h.apply(designInvocation, design.value, {
      kind: "decision", choice: "grant-exception", reason: "Grant the bounded exception.",
    });
    expect(design.ok, JSON.stringify(design)).toBe(true);
    if (!design.ok) return;

    // One of the merged policy gate's two axes remains pending. The first grant neither replaces
    // nor broadens the frozen settlement; discharge the remaining axis in a separate human gate.
    expect(design.value.next_action).toMatchObject({ kind: "decide", expected_submission: "gate-summary" });
    let pending = await readTaskState(workspace.services.authority.state);
    if (pending.kind !== "canonical") throw new Error("task state unavailable");
    expect(pending.document.value.rule_settlements?.filter((entry) => entry.phase_instance === "design"))
      .toEqual(frozenDesignSettlements);
    design = await h.apply(designInvocation, design.value, {
      kind: "gate-summary", summary: "One policy axis remains for human resolution.",
    });
    expect(design.ok, JSON.stringify(design)).toBe(true);
    if (!design.ok) return;
    const remainingWaiverToken = design.value.presentation?.options
      .map((option) => option.token)
      .find((token) => token.startsWith("request-exception-") && token !== waiverToken);
    expect(remainingWaiverToken).toBeDefined();
    design = await h.apply(designInvocation, design.value, {
      kind: "decision", choice: remainingWaiverToken!, reason: "Request the remaining bounded policy exception.",
      option_rationale: "The remaining policy axis is inapplicable here.",
    });
    expect(design.ok, JSON.stringify(design)).toBe(true);
    if (!design.ok) return;
    design = await h.apply(designInvocation, design.value);
    expect(design.ok, JSON.stringify(design)).toBe(true);
    if (!design.ok) return;
    design = await h.apply(designInvocation, design.value, {
      kind: "decision", choice: "grant-exception", reason: "Grant the remaining bounded exception.",
    });
    expect(design.ok, JSON.stringify(design)).toBe(true);
    if (!design.ok) return;

    // The repository fixture carries several active rules. Continue resolving distinct policy
    // scopes until the final grant discharges the fixed point; every grant leaves the original
    // approval-rule settlement untouched.
    const requestedWaivers = new Set([waiverToken!, remainingWaiverToken!]);
    for (let index = 0; index < 20; index += 1) {
      if (design.value.next_action.kind === "commit") break;
      expect(design.value.next_action).toMatchObject({ kind: "decide", expected_submission: "gate-summary" });
      design = await h.apply(designInvocation, design.value, {
        kind: "gate-summary", summary: "Another policy scope remains for human resolution.",
      });
      expect(design.ok, JSON.stringify(design)).toBe(true);
      if (!design.ok) return;
      const token = design.value.presentation?.options
        .map((option) => option.token)
        .find((candidate) => candidate.startsWith("request-exception-") && !requestedWaivers.has(candidate));
      expect(token).toBeDefined();
      requestedWaivers.add(token!);
      design = await h.apply(designInvocation, design.value, {
        kind: "decision", choice: token!, reason: "Request the next bounded policy exception.",
        option_rationale: "This policy scope is inapplicable to the reviewed design.",
      });
      expect(design.ok, JSON.stringify(design)).toBe(true);
      if (!design.ok) return;
      design = await h.apply(designInvocation, design.value);
      expect(design.ok, JSON.stringify(design)).toBe(true);
      if (!design.ok) return;
      design = await h.apply(designInvocation, design.value, {
        kind: "decision", choice: "grant-exception", reason: "Grant this bounded exception.",
      });
      expect(design.ok, JSON.stringify(design)).toBe(true);
      if (!design.ok) return;
    }

    // Exact discharge evaluates and persists wait:false. Every waiver above required explicit
    // human decisions; once those exception boundaries are resolved, shipped v2 can return the
    // exact autonomous design commit without inventing another approval gate.
    expect(design.value.next_action).toMatchObject({ kind: "commit" });
    expect(design.value.presentation).toBeUndefined();
    const settled = await readTaskState(workspace.services.authority.state);
    if (settled.kind !== "canonical") throw new Error("task state unavailable");
    const settledDesignReceipts = settled.document.value.rule_settlements?.filter((entry) =>
      entry.phase_instance === "design") ?? [];
    expect(settledDesignReceipts.length).toBeGreaterThanOrEqual(1);
    expect(settledDesignReceipts.every((entry) =>
      entry.subject_digest.length > 0 && entry.conclusion.wait === false && entry.conclusion.match === null)).toBe(true);
    expect(settled.document.value.planned_final_phase).toBeUndefined();

    expect(design.value.next_action.commit).not.toHaveProperty("requires_human_confirmation");
  });

  register("persists and presents a granted wait:true waiver settlement behind PRD approval", async () => {
    const workspace = await createTaskWorkspace({
      taskId: "semantic-prd-waiver-wait",
      label: "semantic-prd-waiver-wait",
      configBytes: documentSubjectsConfig(["prd"]),
    });
    workspaces.push(workspace);
    restorers.push(installSemanticReviewStub(workspace.root, [[]], { adjudicationCompliance: "fail" }));
    const h = semanticJourneyHarness(workspace);
    const invocation = { skill: "archflow-prd", intent: "resume" } as const;
    writeFileSync(join(workspace.services.authority.task_root, "ask.md"), "Describe a waiver-gated PRD.\n");
    writeFileSync(join(workspace.services.authority.task_root, "prd.md"), "# Waiver-gated PRD\n\nReviewed requirements.\n");

    let view = await h.apply(invocation, await h.status(invocation), { kind: "work-result", outcome: "succeeded" });
    expect(view.ok, JSON.stringify(view)).toBe(true);
    if (!view.ok) return;
    view = await h.apply(invocation, view.value);
    expect(view.ok, JSON.stringify(view)).toBe(true);
    if (!view.ok) return;
    view = await h.apply(invocation, view.value, { kind: "gate-summary", summary: "The policy finding needs a human decision." });
    expect(view.ok, JSON.stringify(view)).toBe(true);
    if (!view.ok) return;
    const waiverToken = view.value.presentation?.options
      .map((option) => option.token)
      .find((token) => token.startsWith("request-exception-"));
    expect(waiverToken).toBeDefined();
    view = await h.apply(invocation, view.value, {
      kind: "decision", choice: waiverToken!, reason: "Request a bounded policy exception.",
      option_rationale: "The policy trigger is inapplicable here.",
    });
    expect(view.ok, JSON.stringify(view)).toBe(true);
    if (!view.ok) return;
    view = await h.apply(invocation, view.value);
    expect(view.ok, JSON.stringify(view)).toBe(true);
    if (!view.ok) return;
    view = await h.apply(invocation, view.value, {
      kind: "decision", choice: "grant-exception", reason: "Grant the bounded exception.",
    });
    expect(view.ok, JSON.stringify(view)).toBe(true);
    if (!view.ok) return;

    // The merged finding exposes compliance and trigger as distinct waiver scopes. The first
    // grant leaves the gate pending without replacing the exact settlement recorded at triage.
    expect(view.value.next_action).toMatchObject({ kind: "decide", expected_submission: "gate-summary" });
    let pending = await readTaskState(workspace.services.authority.state);
    if (pending.kind !== "canonical") throw new Error("task state unavailable");
    const frozenPrdSettlements = pending.document.value.rule_settlements?.filter((entry) =>
      entry.phase_instance === "prd") ?? [];
    expect(frozenPrdSettlements).toEqual([expect.objectContaining({
      conclusion: { wait: true, match: { kind: "subject", subject: "prd" } },
    })]);
    view = await h.apply(invocation, view.value, {
      kind: "gate-summary", summary: "One policy axis remains for human resolution.",
    });
    expect(view.ok, JSON.stringify(view)).toBe(true);
    if (!view.ok) return;
    const remainingWaiverToken = view.value.presentation?.options
      .map((option) => option.token)
      .find((token) => token.startsWith("request-exception-") && token !== waiverToken);
    expect(remainingWaiverToken).toBeDefined();
    view = await h.apply(invocation, view.value, {
      kind: "decision", choice: remainingWaiverToken!, reason: "Request the remaining bounded policy exception.",
      option_rationale: "The remaining policy axis is inapplicable here.",
    });
    expect(view.ok, JSON.stringify(view)).toBe(true);
    if (!view.ok) return;
    view = await h.apply(invocation, view.value);
    expect(view.ok, JSON.stringify(view)).toBe(true);
    if (!view.ok) return;
    view = await h.apply(invocation, view.value, {
      kind: "decision", choice: "grant-exception", reason: "Grant the remaining bounded exception.",
    });
    expect(view.ok, JSON.stringify(view)).toBe(true);
    if (!view.ok) return;

    const requestedWaivers = new Set([waiverToken!, remainingWaiverToken!]);
    for (let index = 0; index < 20; index += 1) {
      expect(view.value.next_action).toMatchObject({ kind: "decide", expected_submission: "gate-summary" });
      view = await h.apply(invocation, view.value, {
        kind: "gate-summary", summary: "Another policy scope remains for human resolution.",
      });
      expect(view.ok, JSON.stringify(view)).toBe(true);
      if (!view.ok) return;
      const token = view.value.presentation?.options
        .map((option) => option.token)
        .find((candidate) => candidate.startsWith("request-exception-") && !requestedWaivers.has(candidate));
      if (token === undefined) break;
      requestedWaivers.add(token!);
      view = await h.apply(invocation, view.value, {
        kind: "decision", choice: token!, reason: "Request the next bounded policy exception.",
        option_rationale: "This policy scope is inapplicable to the reviewed PRD.",
      });
      expect(view.ok, JSON.stringify(view)).toBe(true);
      if (!view.ok) return;
      view = await h.apply(invocation, view.value);
      expect(view.ok, JSON.stringify(view)).toBe(true);
      if (!view.ok) return;
      view = await h.apply(invocation, view.value, {
        kind: "decision", choice: "grant-exception", reason: "Grant this bounded exception.",
      });
      expect(view.ok, JSON.stringify(view)).toBe(true);
      if (!view.ok) return;
    }

    expect(view.value.next_action).toMatchObject({ kind: "decide", expected_submission: "decision" });
    const settled = await readTaskState(workspace.services.authority.state);
    if (settled.kind !== "canonical") throw new Error("task state unavailable");
    const settledPrdReceipts = settled.document.value.rule_settlements?.filter((entry) =>
      entry.phase_instance === "prd") ?? [];
    expect(settledPrdReceipts.length).toBeGreaterThanOrEqual(1);
    expect(settledPrdReceipts.every((entry) => entry.conclusion.wait === true &&
      entry.conclusion.match?.kind === "subject" && entry.conclusion.match.subject === "prd")).toBe(true);

    expect(view.value.presentation?.summary).toContain(
      "Another policy scope remains for human resolution.",
    );
    expect(view.value.presentation?.options.map((option) => option.token)).toContain("approve");
  });

  register("refuses human design approval when the phase plan is malformed", async () => {
    // No rule waits for the design subject and its review is clean, but design.md carries no valid
    // phase headings. The settlement records evaluation only; the human approval decision is the
    // first writer of planned_final_phase and therefore owns the phase-count validation.
    const workspace = await createTaskWorkspace({
      taskId: "semantic-design-malformed",
      label: "semantic-design-malformed",
      configBytes: documentSubjectsConfig(["prd"]),
      constitutionBytes: legacyHumanAuthorityConstitutionV1Bytes(),
    });
    workspaces.push(workspace);
    restorers.push(installSemanticReviewStub(workspace.root, [[]]));
    const h = semanticJourneyHarness(workspace);
    const invocation = { skill: "archflow-prd", intent: "resume" } as const;
    writeFileSync(join(workspace.services.authority.task_root, "ask.md"), "Describe a malformed design journey.\n");
    writeFileSync(join(workspace.services.authority.task_root, "prd.md"), "# Semantic journey\n\nThe client authors this document.\n");

    let result = await h.apply(invocation, await h.status(invocation), { kind: "work-result", outcome: "succeeded" });
    expect(result.ok, JSON.stringify(result)).toBe(true);
    if (!result.ok) return;
    result = await h.apply(invocation, result.value);
    expect(result.ok, JSON.stringify(result)).toBe(true);
    if (!result.ok) return;
    result = await h.apply(invocation, result.value, { kind: "gate-summary", summary: "The PRD is ready for approval." });
    expect(result.ok, JSON.stringify(result)).toBe(true);
    if (!result.ok) return;
    result = await h.apply(invocation, result.value, { kind: "decision", choice: "approve", reason: "The requirements are correct." });
    expect(result.ok, JSON.stringify(result)).toBe(true);
    if (!result.ok) return;

    const designInvocation = { skill: "archflow-design", intent: "resume" } as const;
    let design = await h.apply(designInvocation, await h.status(designInvocation));
    expect(design.ok, JSON.stringify(design)).toBe(true);
    if (!design.ok) return;
    const designResource = design.value.resources.find((resource) => resource.role === "current-artifact");
    if (designResource === undefined) throw new Error("design resource unavailable");
    writeFileSync(join(workspace.root, designResource.path), "# Design\n\nNo phase headings in this document.\n");
    design = await h.apply(designInvocation, design.value, { kind: "work-result", outcome: "succeeded" });
    expect(design.ok, JSON.stringify(design)).toBe(true);
    if (!design.ok) return;
    const before = await readTaskState(workspace.services.authority.state);
    if (before.kind !== "canonical") throw new Error("task state unavailable");

    design = await h.apply(designInvocation, design.value);
    expect(design.ok, JSON.stringify(design)).toBe(true);
    if (!design.ok) return;
    expect(design.value.next_action).toMatchObject({ kind: "decide", expected_submission: "gate-summary" });
    design = await h.apply(designInvocation, design.value, {
      kind: "gate-summary", summary: "The reviewed design is ready for an explicit decision.",
    });
    expect(design.ok, JSON.stringify(design)).toBe(true);
    if (!design.ok) return;
    const refused = await h.apply(designInvocation, design.value, {
      kind: "decision", choice: "approve", reason: "Approve the proposed architecture.",
    });
    expect(refused.ok).toBe(false);
    if (refused.ok) return;
    expect(refused.error).toMatchObject({ code: "STATE_INVALID" });
    // The semantic layer flattens the diagnostic into the message; the grammar itself is the pin.
    expect(refused.error.message).toContain("approved-design-phase-count-invalid");

    // Nothing approved: review and settlement are legitimate committed state, while the failed
    // decision leaves the human gate open and the final-phase bound absent.
    const after = await readTaskState(workspace.services.authority.state);
    if (after.kind !== "canonical") throw new Error("task state unavailable");
    expect(after.document.value.revision).toBeGreaterThan(before.document.value.revision);
    expect(after.document.value).toMatchObject({ step: "triage", status: "succeeded" });
    expect(after.document.value.open_gate).toMatchObject({ gate_kind: "design-approval" });
    expect(after.document.value.rule_settlements?.filter((entry) =>
      entry.phase_instance === "design")).toEqual([expect.objectContaining({
        conclusion: { wait: false, match: null },
      })]);
    expect(after.document.value.planned_final_phase).toBeUndefined();
  });
});
}

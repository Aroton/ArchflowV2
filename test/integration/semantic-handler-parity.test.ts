import { writeFileSync } from "node:fs";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import type { WorkflowViewV1 } from "../../src/contracts/semantic-workflow.js";
import {
  installSemanticReviewStub,
  semanticJourneyHarness,
  type SemanticJourneyHarness,
} from "../helpers/semantic-journeys.js";
import { createTaskWorkspace, type TaskWorkspace } from "../helpers/task-workspace.js";

const TIMEOUT = 60_000;
const invocation = { skill: "archflow-prd", intent: "resume" } as const;
const workspaces: TaskWorkspace[] = [];
const restorers: (() => void)[] = [];

afterEach(() => {
  for (const restore of restorers.splice(0)) restore();
  for (const workspace of workspaces.splice(0)) workspace.dispose();
});

async function createPrdHarness(
  taskId: string,
  options: Readonly<{ review?: boolean }> = {},
): Promise<Readonly<{ h: SemanticJourneyHarness; view: WorkflowViewV1 }>> {
  const workspace = await createTaskWorkspace({
    taskId,
    label: taskId,
    configBytes: new TextEncoder().encode(`schema_version: "1"
roles:
  counter-reviewer: { model: gpt-5.6-sol, effort: xhigh }
  adjudicator: { model: gpt-5.6-sol, effort: xhigh }
approval_rules:
  subjects: [prd]
  content: []
`),
  });
  workspaces.push(workspace);
  if (options.review === true) restorers.push(installSemanticReviewStub(workspace.root, [[]]));
  writeFileSync(join(workspace.services.authority.task_root, "ask.md"), "Describe a small parity journey.\n");
  writeFileSync(join(workspace.services.authority.task_root, "prd.md"), "# Parity journey\n\nKeep apply views fresh.\n");
  const h = semanticJourneyHarness(workspace);
  return { h, view: await h.status(invocation) };
}

async function expectSuccess(
  result: Awaited<ReturnType<SemanticJourneyHarness["apply"]>>,
): Promise<WorkflowViewV1> {
  expect(result.ok, JSON.stringify(result)).toBe(true);
  if (!result.ok) throw new Error(JSON.stringify(result.error));
  return result.value;
}

describe("semantic apply/status parity", { timeout: TIMEOUT }, () => {
  it("matches fresh status after an ordinary successful mutation", async () => {
    const { h, view } = await createPrdHarness("parity-success");

    const result = await h.applyAndAssertFreshStatus(invocation, view, {
      kind: "work-result",
      outcome: "succeeded",
    });

    expect((await expectSuccess(result)).next_action.kind).toBe("review");
  });

  it("matches fresh status after a compound finding-free review", async () => {
    const { h, view } = await createPrdHarness("parity-review", { review: true });
    const produced = await expectSuccess(await h.apply(invocation, view, {
      kind: "work-result",
      outcome: "succeeded",
    }));

    const result = await h.applyAndAssertFreshStatus(invocation, produced);

    const reviewed = await expectSuccess(result);
    expect(reviewed.findings).toEqual([]);
    expect(reviewed.next_action).toMatchObject({ kind: "decide", expected_submission: "gate-summary" });
  });

  it("matches fresh status after a human decision", async () => {
    const { h, view } = await createPrdHarness("parity-decision", { review: true });
    let current = await expectSuccess(await h.apply(invocation, view, {
      kind: "work-result",
      outcome: "succeeded",
    }));
    current = await expectSuccess(await h.apply(invocation, current));
    current = await expectSuccess(await h.apply(invocation, current, {
      kind: "gate-summary",
      summary: "The PRD is ready for approval.",
    }));

    const result = await h.applyAndAssertFreshStatus(invocation, current, {
      kind: "decision",
      choice: "approve",
      reason: "The requirements are correct.",
    });

    expect((await expectSuccess(result)).next_action).toMatchObject({
      kind: "start-next-skill",
      skill: "archflow-design",
    });
  });

  it("matches a fresh safe view after a failed apply", async () => {
    const { h, view } = await createPrdHarness("parity-failure");
    const staleView = {
      ...view,
      next_action: { ...view.next_action, offer: `af1_${"f".repeat(64)}` },
    };

    const result = await h.applyAndAssertFreshStatus(invocation, staleView, {
      kind: "work-result",
      outcome: "failed",
      reason: "Exercise the safe refusal view.",
    });

    expect(result).toMatchObject({ ok: false, error: { code: "SEMANTIC_OFFER_STALE" } });
    if (result.ok) throw new Error("expected stale offer refusal");
    expect(result.view?.next_action.offer).toBe(view.next_action.offer);
  });
});

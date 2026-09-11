import { appendFileSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createTaskWorkspace, type TaskWorkspace } from "../helpers/task-workspace.js";
import { installSemanticReviewStub, reachPhaseDesignReviewOffer, semanticJourneyHarness, withImplementationComponents } from "../helpers/semantic-journeys.js";
import { governingDocumentComparisons } from "../../src/state/governing-document-comparison.js";
import { loadCurrentProduceSubject } from "../../src/state/produce-subject.js";
import { sha256Bytes } from "../../src/contracts/canonical.js";

const workspaces: TaskWorkspace[] = [];
const restorers: (() => void)[] = [];
afterEach(() => { for (const restore of restorers.splice(0)) restore(); for (const workspace of workspaces.splice(0)) workspace.dispose(); });

describe("governing document comparison", { timeout: 120_000 }, () => {
  it("pins human-approved before-images and lets independently cleared maintenance reach commit", async () => {
    const workspace = await createTaskWorkspace({ taskId: "governing-comparison" });
    workspaces.push(workspace);
    restorers.push(installSemanticReviewStub(workspace.root, [[]]));
    const h = semanticJourneyHarness(workspace);
    const offer = await reachPhaseDesignReviewOffer(workspace, h, withImplementationComponents(
      "# Phase design\n\nImplement the approved behavior.\n\n## Verification\n\nRun `npm run typecheck`.\n", ["src/example.ts"]));
    const parentPath = join(workspace.services.authority.task_root, "design.md");
    const approvedParent = readFileSync(parentPath, "utf8");
    const ownPath = offer.view.resources.find((resource) => resource.role === "current-artifact")!.path;
    appendFileSync(parentPath, "\nImplementation note: retain the existing decisions.\n");
    appendFileSync(join(workspace.root, ownPath), "\nExplain the same implementation more clearly.\n");
    let view = await h.status(offer.invocation);
    expect(view.next_action.kind).toBe("begin-work");
    const entered = await h.apply(offer.invocation, view);
    expect(entered.ok, JSON.stringify(entered)).toBe(true);
    if (!entered.ok) return;
    const produced = await h.apply(offer.invocation, entered.value, { kind: "work-result", outcome: "succeeded" });
    expect(produced.ok, JSON.stringify(produced)).toBe(true);
    if (!produced.ok) return;
    view = produced.value;
    const state = await workspace.services.dependencies.read_state(workspace.services.authority.state);
    if (state.kind !== "canonical") throw new Error("state unavailable");
    const subject = await loadCurrentProduceSubject(workspace.services.dependencies, state.document.value);
    if (!subject.ok) throw new Error("subject unavailable");
    const comparisons = await governingDocumentComparisons(workspace.services.dependencies, workspace.services.authority, state.document.value, subject.value);
    expect(comparisons).toHaveLength(1);
    expect(comparisons[0]).toMatchObject({
      path: `.archflow/tasks/${workspace.taskId}/design.md`,
      baseline: { status: "authenticated", content: approvedParent, content_digest: sha256Bytes(Buffer.from(approvedParent)) },
      proposed_content_digest: sha256Bytes(readFileSync(parentPath)),
    });
    const reviewed = await h.apply(offer.invocation, view);
    expect(reviewed.ok, JSON.stringify(reviewed)).toBe(true);
    if (!reviewed.ok) return;
    expect(reviewed.value.next_action.kind).toBe("commit");
    expect(reviewed.value.presentation).toBeUndefined();
  });
});

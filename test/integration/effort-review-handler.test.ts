import { writeFileSync } from "node:fs";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { createProductionServices } from "../../src/state/production.js";
import { loadRetainedEvidence } from "../../src/state/evidence-results.js";
import { parseSafeCode } from "../../src/contracts/evidence.js";
import {
  installSemanticReviewStub,
  reachPhaseDesignReviewOffer,
  semanticJourneyHarness,
  withImplementationComponents,
} from "../helpers/semantic-journeys.js";
import { createTaskWorkspace, type TaskWorkspace } from "../helpers/task-workspace.js";

const workspaces: TaskWorkspace[] = [];
const restorers: (() => void)[] = [];
afterEach(() => {
  for (const restore of restorers.splice(0)) restore();
  for (const workspace of workspaces.splice(0)) workspace.dispose();
});

const validDesign = withImplementationComponents(
  "# Phase 1: Handler effort review\n\n## Goal\n\nExercise the live phase-design review handler.\n",
  ["src/state/fixed-point.ts"],
);

async function retainedReview(workspace: TaskWorkspace) {
  const services = await createProductionServices({
    working_directory: workspace.root,
    task_id: workspace.taskId,
    operation: parseSafeCode("effort-handler-evidence"),
  });
  if (!services.ok || services.value.state === undefined) throw new Error("production services unavailable");
  const retained = await loadRetainedEvidence(
    { load_retained_manifest: services.value.dependencies.load_retained_manifest! },
    services.value.state.value,
    services.value.state.value.phase_instance,
  );
  if (!retained.ok) throw new Error(retained.error.code);
  const source = retained.value.get("counter_review")?.manifest.source_artifact;
  if (source?.artifact_kind !== "review-evidence" || source.evidence.assurance !== "server-attested") {
    throw new Error("server-attested review unavailable");
  }
  return source.evidence;
}

describe("phase-design effort review handler", { timeout: 180_000 }, () => {
  it("accepts a manifest-less phase design", async () => {
    const workspace = await createTaskWorkspace({ taskId: "effort-no-manifest", label: "effort-no-manifest" });
    workspaces.push(workspace);
    restorers.push(installSemanticReviewStub(workspace.root, [[], []]));
    const h = semanticJourneyHarness(workspace);
    const boundary = await reachPhaseDesignReviewOffer(workspace, h, "# Phase 1: Missing manifest\n");
    const result = await h.apply(boundary.invocation, boundary.view);
    expect(result.ok, JSON.stringify(result)).toBe(true);
    expect((await retainedReview(workspace)).effort_review).toMatchObject({
      schema_version: "2",
      profile: { model: "gemini-3.7-flash", effort: "max" },
    });
  });

  it("captures a live hazards edit in the minted effort assessment", async () => {
    const workspace = await createTaskWorkspace({ taskId: "effort-hazard-capture", label: "effort-hazard-capture" });
    workspaces.push(workspace);
    restorers.push(installSemanticReviewStub(workspace.root, [[], [], []]));
    const h = semanticJourneyHarness(workspace);
    const boundary = await reachPhaseDesignReviewOffer(workspace, h, validDesign);
    const hazardYaml = `schema_version: "1"\nhazards:\n  - repository: primary\n    path: src/state\n    score: 2\n    reason: State transitions require careful review.\n`;
    writeFileSync(join(workspace.root, ".archflow", "hazards.yaml"), hazardYaml);
    const reviewed = await h.apply(boundary.invocation, boundary.view);
    expect(reviewed.ok, JSON.stringify(reviewed)).toBe(true);
    const evidence = await retainedReview(workspace);
    expect(evidence.effort_review).toMatchObject({
      schema_version: "2",
      source: { kind: "reviewer" },
    });
  });

  it("defaults to Sol medium when the effort selector route fails", async () => {
    const workspace = await createTaskWorkspace({ taskId: "effort-route-override", label: "effort-route-override" });
    workspaces.push(workspace);
    restorers.push(installSemanticReviewStub(workspace.root, [[], [], []], { failFixedEffortRoute: true }));
    const h = semanticJourneyHarness(workspace);
    const boundary = await reachPhaseDesignReviewOffer(workspace, h, validDesign);
    const reviewed = await h.apply(boundary.invocation, boundary.view);
    expect(reviewed.ok, JSON.stringify(reviewed)).toBe(true);
    expect((await retainedReview(workspace)).effort_review).toMatchObject({
      schema_version: "2",
      profile: { model: "gpt-5.6-sol", effort: "medium" },
      source: { kind: "default" },
    });
  });
});

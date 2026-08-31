import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { canonicalJsonDigest } from "../../src/contracts/canonical.js";
import { parseHazardRegistryYaml } from "../../src/contracts/hazard-registry.js";
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
  it("rejects a manifest-less phase design before dispatching any review child", async () => {
    const workspace = await createTaskWorkspace({ taskId: "effort-no-manifest", label: "effort-no-manifest" });
    workspaces.push(workspace);
    restorers.push(installSemanticReviewStub(workspace.root, [[], []]));
    const h = semanticJourneyHarness(workspace);
    const boundary = await reachPhaseDesignReviewOffer(workspace, h, "# Phase 1: Missing manifest\n");
    const before = Number(readFileSync(join(workspace.root, "semantic-review-count"), "utf8"));
    const result = await h.apply(boundary.invocation, boundary.view);
    expect(result).toMatchObject({ ok: false, error: { code: "CONTRACT_INVALID" } });
    expect(Number(readFileSync(join(workspace.root, "semantic-review-count"), "utf8"))).toBe(before);
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
    const registry = parseHazardRegistryYaml(hazardYaml, ["primary"]);
    expect(evidence.effort_review?.hazard_registry_digest).toBe(canonicalJsonDigest({
      schema_version: "1", state: "present", registry,
    }));
  });

  it("records the displaced fixed Luna model on an effort-reviewer route override", async () => {
    const workspace = await createTaskWorkspace({ taskId: "effort-route-override", label: "effort-route-override" });
    workspaces.push(workspace);
    restorers.push(installSemanticReviewStub(workspace.root, [[], [], []], { failFixedEffortRoute: true }));
    const h = semanticJourneyHarness(workspace);
    const boundary = await reachPhaseDesignReviewOffer(workspace, h, validDesign);
    const failed = await h.apply(boundary.invocation, boundary.view);
    expect(failed).toMatchObject({ ok: false, view: { dispatch_failure: { role: "effort-reviewer" } } });
    const retry = failed.ok ? failed.value : failed.view;
    if (retry === undefined) throw new Error("effort failure did not return a retry view");
    const reviewed = await h.apply(boundary.invocation, retry, {
      kind: "review-dispatch",
      route_override: {
        reason: "The fixed Luna route is unavailable in this fixture.",
        "effort-reviewer": { model: "gpt-5.6-sol", effort: "high" },
      },
    });
    expect(reviewed.ok, JSON.stringify(reviewed)).toBe(true);
    expect((await retainedReview(workspace)).effort_review?.reviewer.route_override).toMatchObject({
      pinned_model: "gpt-5.6-luna",
    });
  });
});

import { parse, stringify } from "yaml";
import { readFileSync, writeFileSync } from "node:fs";
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
    const rationale = "The specified parser needs bounded decoding; ownership uses the tested predecessor API.";
    restorers.push(installSemanticReviewStub(workspace.root, [[], []], { effortRationale: rationale }));
    const h = semanticJourneyHarness(workspace);
    const boundary = await reachPhaseDesignReviewOffer(workspace, h, "# Phase 1: Missing manifest\n");
    const result = await h.apply(boundary.invocation, boundary.view);
    expect(result.ok, JSON.stringify(result)).toBe(true);
    if (!result.ok) throw new Error(result.error.code);
    expect(result.value.implementation_recommendation).toMatchObject({ status: "ready", model: "glm-5.3", effort: "max", rationale: expect.stringContaining(rationale) });
    expect((await h.status(boundary.invocation)).implementation_recommendation).toEqual(result.value.implementation_recommendation);
    expect((await retainedReview(workspace)).effort_review).toMatchObject({
      schema_version: "3",
      policy_id: "implementation-agent-selector-v5",
      recommendation: { model: "glm-5.3", effort: "max" },
      rationale,
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
      schema_version: "3",
      source: { kind: "reviewer" },
    });
  });

  it("defaults to bounded reasoning when the effort selector route fails", async () => {
    const workspace = await createTaskWorkspace({ taskId: "effort-route-override", label: "effort-route-override" });
    workspaces.push(workspace);
    restorers.push(installSemanticReviewStub(workspace.root, [[], [], []], { failFixedEffortRoute: true }));
    const h = semanticJourneyHarness(workspace);
    const boundary = await reachPhaseDesignReviewOffer(workspace, h, validDesign);
    const reviewed = await h.apply(boundary.invocation, boundary.view);
    expect(reviewed.ok, JSON.stringify(reviewed)).toBe(true);
    expect((await retainedReview(workspace)).effort_review).toMatchObject({
      schema_version: "3",
      difficulty: "bounded-reasoning",
      recommendation: { model: "glm-5.3-flash" },
      source: { kind: "default" },
    });
  });
});


describe("configured implementation advice", { timeout: 180_000 }, () => {
  it.each([
    { name: "gemini", enabled: ["gemini-3-8-flash-high"], expected: { status: "ready", model: "gemini-3.8-flash-high", effort: "high" } },
    { name: "glm-flash", enabled: ["glm-5-3-flash"], expected: { status: "ready", model: "glm-5.3-flash" } },
    { name: "disabled", enabled: [], expected: { status: "unavailable", reason: "selection-unavailable" } },
    { name: "unknown", enabled: ["unknown-profile"], expected: { status: "unavailable", reason: "selection-unavailable" } },
  ])("honors $name settings without changing authority and keeps recorded advice fixed", async ({ name, enabled, expected }) => {
    const workspace = await createTaskWorkspace({ taskId: `effort-config-${name}`, label: `effort-config-${name}` });
    workspaces.push(workspace);
    restorers.push(installSemanticReviewStub(workspace.root, [[], []], { effortDifficulty: "routine" }));
    const h = semanticJourneyHarness(workspace);
    const boundary = await reachPhaseDesignReviewOffer(workspace, h, "# Copy approved designs\nCopy 120 files to specified destinations and validate their supplied schemas.\n");
    const path = join(workspace.root, ".archflow", "tasks", workspace.taskId, "config.yaml");
    const config = parse(readFileSync(path, "utf8"));
    config.implementation = { enabled_profiles: enabled };
    writeFileSync(path, stringify(config));
    const result = await h.apply(boundary.invocation, boundary.view);
    expect(result.ok, JSON.stringify(result)).toBe(true);
    if (!result.ok) throw new Error(result.error.code);
    expect(result.value.implementation_recommendation).toMatchObject(expected);
    if (name === "glm-flash") expect(result.value.implementation_recommendation).not.toHaveProperty("effort");
    expect(result.value.next_action.kind).toBe("commit");
    config.implementation = { enabled_profiles: ["gpt-6-astra-high"] };
    writeFileSync(path, stringify(config));
    const later = await h.status(boundary.invocation);
    expect(later.implementation_recommendation).toEqual(result.value.implementation_recommendation);
    expect(later.next_action).toEqual(result.value.next_action);
  });
});

import { describe, expect, it } from "vitest";

import type { TaskStateV1 } from "../../src/contracts/durable-state.js";
import { parseSha256Digest, parseTaskSlug } from "../../src/contracts/evidence.js";
import type { PlainJsonValue } from "../../src/contracts/plain-json.js";
import {
  SEMANTIC_ACTION_KINDS,
  unavailableImplementationRecommendation,
  type SemanticActionKindV1,
  type SemanticStatusSnapshotV1,
  type WorkflowViewV1,
} from "../../src/contracts/semantic-workflow.js";
import { projectAutomationStatus, projectAutomationStatusV2 } from "../../src/local/automation-status.js";
import type { NextAction, NextActionCode } from "../../src/state/next-action.js";
import type { TaskStatusV1 } from "../../src/state/status.js";
import { computeTaxonomyDenialRates } from "../../src/state/semantic-status.js";

const task = parseTaskSlug("automation-projection");
const digestA = parseSha256Digest("a".repeat(64));
const digestB = parseSha256Digest("b".repeat(64));
const digestC = parseSha256Digest("c".repeat(64));
const recommendation = unavailableImplementationRecommendation(
  "not-produced",
  "No authenticated effort recommendation has been produced.",
  3,
);

function rawAction(code: NextActionCode, extra: Partial<NextAction> = {}): NextAction {
  return { code, detail: `detail for ${code}`, human_required: false, phase_instance: "phase-impl-3", ...extra } as NextAction;
}

function snapshot(action: NextAction, extra: Partial<SemanticStatusSnapshotV1> = {}): SemanticStatusSnapshotV1 {
  const state = { task_id: task, revision: 9 } as unknown as TaskStateV1;
  const status = {
    task_id: task,
    state: "active",
    revision: 9,
    phase_instance: "phase-impl-3",
    step: "produce",
    status: "pending",
    attempt: 1,
    input_fingerprint: digestA,
    config: { verified: true },
    blocking_reasons: [],
    next_action: action,
  } as unknown as TaskStatusV1;
  return {
    schema_version: "1",
    repository_identity_digest: digestC,
    state,
    state_document_digest: digestA,
    live_config_digest: digestB,
    status: structuredClone(status) as unknown as PlainJsonValue,
    full_findings: [],
    taxonomy_denial_rates: computeTaxonomyDenialRates([]),
    reopen_impacts: [],
    implementation_recommendation: recommendation,
    ...extra,
  };
}

function view(
  condition: WorkflowViewV1["condition"],
  kind: SemanticActionKindV1,
  extra: Partial<WorkflowViewV1> = {},
): WorkflowViewV1 {
  return {
    schema_version: "1", task_id: task, condition, headline: "Current workflow status",
    detail: "Authenticated semantic detail.", position: { kind: "phase-impl", phase: 3 }, resources: [],
    implementation_recommendation: recommendation,
    next_action: { kind, instruction: `Continue ${kind}.` },
    ...extra,
  };
}

describe("automation status pure projection", () => {
  it("launches only ready + start-next-skill and copies the authenticated successor", () => {
    const current = projectAutomationStatus(snapshot(rawAction("run-step", { step: "produce" })), view("ready", "begin-work"));
    expect(current).toMatchObject({ condition: "awaiting-client", next_action: { actor: "skill", skill: "archflow-phase-impl", skill_args: ["3"] } });

    const launch = projectAutomationStatus(snapshot(rawAction("advance-phase")), view("ready", "start-next-skill", {
      next_action: { kind: "start-next-skill", instruction: "Launch it.", skill: "archflow-phase-design", skill_args: ["4"] },
    }));
    expect(launch).toMatchObject({ condition: "ready", next_action: { actor: "orchestrator", kind: "launch-skill", skill: "archflow-phase-design", skill_args: ["4"] } });
  });

  it("maps every current public action explicitly and rejects launch/inspect/none as continuations", () => {
    const continuation = SEMANTIC_ACTION_KINDS.filter((kind) => !["start-next-skill", "inspect", "none"].includes(kind));
    for (const kind of continuation) {
      expect(projectAutomationStatus(snapshot(rawAction("run-step", { step: "produce" })), view("awaiting-client", kind)).condition)
        .toBe("awaiting-client");
    }
    for (const kind of ["start-next-skill", "inspect", "none"] as const) {
      expect(() => projectAutomationStatus(snapshot(rawAction("run-step", { step: "produce" })), view("awaiting-client", kind))).toThrow();
    }
  });

  it("removes decision choices while copying the classified human presentation", () => {
    const projected = projectAutomationStatus(snapshot(rawAction("resolve-open-gate")), view("awaiting-human", "decide", {
      presentation: {
        class: "exception", title: "Approval", summary: "Review the current bytes.", question: "Approve?",
        reasons: [{ class: "exception", text: "A material risk needs judgment." }],
        options: [{ token: "approve-secret", label: "Approve", consequence: "Continue." }],
      },
    }));
    expect(projected).toMatchObject({
      condition: "awaiting-human",
      human_boundary: { source: "presentation", class: "exception", headline: "Current workflow status", question: "Approve?" },
    });
    expect(JSON.stringify(projected)).not.toContain("approve-secret");
  });

  it("gives an exact-current dispatch failure precedence without making it authority", () => {
    const projected = projectAutomationStatus(snapshot(rawAction("run-step", { step: "counter_review" })), view("awaiting-client", "review", {
      dispatch_failure: {
        role: "counter-reviewer", code: "AUTH_UNAVAILABLE", message: "Reviewer authentication is unavailable.",
      },
    }));
    expect(projected).toMatchObject({
      condition: "awaiting-human",
      next_action: { actor: "human", kind: "respond-in-session", skill: "archflow-phase-impl" },
      human_boundary: { source: "dispatch-failure", failed_role: "counter-reviewer", failure_code: "AUTH_UNAVAILABLE" },
    });
    expect(projected).not.toHaveProperty("offer");
  });

  it("uses the v1 adjudicator surrogate only structurally for effort failures", () => {
    const projected = projectAutomationStatus(snapshot(rawAction("run-step", { step: "counter_review" })), view("awaiting-client", "review", {
      dispatch_failure: {
        role: "effort-reviewer", code: "AUTH_UNAVAILABLE", message: "Reviewer authentication is unavailable.",
        route: { model: "gpt-5.6-luna", effort: "xhigh", source: "configured" },
      },
    }));
    expect(projected).toMatchObject({
      condition: "awaiting-human",
      human_boundary: {
        source: "dispatch-failure",
        failed_role: "adjudicator",
        headline: "Effort review route needs human attention",
      },
    });
    const boundary = "human_boundary" in projected ? projected.human_boundary : undefined;
    expect(boundary).toMatchObject({
      summary: expect.stringContaining("gpt-5.6-luna at xhigh effort"),
      question: expect.stringContaining("effort reviewer"),
    });
    expect(JSON.stringify(boundary)).not.toContain("adjudicator route");
  });

  it("derives stable blocked categories from typed snapshot facts", () => {
    const cases = [
      ["resume-exact-intent", "resume-exact-intent"],
      ["inspect-retained-receipt", "inspect-retained-receipt"],
      ["create-fresh-intent", "create-fresh-intent"],
      ["resolve-current-authority", "resolve-current-authority"],
      ["commit-phase", "commit-facts-unavailable"],
    ] as const;
    for (const [code, category] of cases) {
      const projected = projectAutomationStatus(snapshot(rawAction(code)), view("blocked", "inspect"));
      expect(projected).toMatchObject({ condition: "blocked", blocked: { category } });
    }
    expect(projectAutomationStatus(snapshot(rawAction("resolve-open-gate"), {
      archived_decision: { status: "invalid" },
    }), view("blocked", "inspect"))).toMatchObject({ blocked: { category: "archived-decision-invalid" } });
  });

  it("retains authenticated migration ownership and terminal completion", () => {
    const migration = projectAutomationStatus(snapshot(rawAction("open-gate"), {
      legacy_import_initialization: true,
    }), view("awaiting-client", "decide", { position: { kind: "design" } }));
    expect(migration).toMatchObject({ next_action: { skill: "archflow-upgrade", skill_args: [] } });

    const complete = projectAutomationStatus(snapshot(rawAction("task-complete")), view("complete", "none"));
    expect(complete).toMatchObject({ condition: "complete", next_action: { actor: "none", kind: "none" } });
  });

  it("projects v2 advice without changing any controller action", () => {
    const semantic = view("ready", "start-next-skill", {
      next_action: { kind: "start-next-skill", instruction: "Launch it.", skill: "archflow-phase-design", skill_args: ["4"] },
    });
    const projected = projectAutomationStatusV2(snapshot(rawAction("advance-phase")), semantic);
    expect(projected).toMatchObject({
      schema_version: "2",
      condition: "ready",
      implementation_recommendation: recommendation,
      next_action: { actor: "orchestrator", skill: "archflow-phase-design", skill_args: ["4"] },
    });

    const changedRecommendation = unavailableImplementationRecommendation(
      "subject-stale",
      "The authenticated recommendation belongs to prior design bytes.",
      3,
    );
    const changed = projectAutomationStatusV2(snapshot(rawAction("advance-phase"), {
      implementation_recommendation: changedRecommendation,
    }), { ...semantic, implementation_recommendation: changedRecommendation });
    expect(changed.next_action).toEqual(projected.next_action);
    expect(changed.observation_id).not.toBe(projected.observation_id);
  });

  it("names effort-reviewer truthfully in v2 while v1 retains its compatibility surrogate", () => {
    const failed = view("awaiting-client", "review", {
      dispatch_failure: {
        role: "effort-reviewer", code: "AUTH_UNAVAILABLE", message: "Reviewer authentication is unavailable.",
        route: { model: "gpt-5.6-luna", effort: "xhigh", source: "configured" },
      },
    });
    const current = snapshot(rawAction("run-step", { step: "counter_review" }));
    const v1 = projectAutomationStatus(current, failed);
    const v2 = projectAutomationStatusV2(current, failed);
    expect(v1).toMatchObject({ human_boundary: { failed_role: "adjudicator" } });
    expect(v2).toMatchObject({ human_boundary: { failed_role: "effort-reviewer" } });
    expect(v2.next_action).toEqual(v1.next_action);
  });
});

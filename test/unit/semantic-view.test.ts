import { describe, expect, it } from "vitest";

import type { TaskStateV1 } from "../../src/contracts/durable-state.js";
import type { EffortAssessmentV1 } from "../../src/contracts/effort-review.js";
import {
  compareHazardRegistryInput,
  createHazardRegistryInput,
} from "../../src/contracts/hazard-registry.js";
import type { PhaseDesignComponentManifestV1 } from "../../src/contracts/component-manifest.js";
import { parseSha256Digest, parseTaskSlug } from "../../src/contracts/evidence.js";
import { encodePhaseInstance, parsePositiveSafePhaseNumber } from "../../src/contracts/phase-instance.js";
import type { PlainJsonValue } from "../../src/contracts/plain-json.js";
import type {
  PublicFindingV1,
  SemanticActionOfferV1,
  SemanticStatusSnapshotV1,
  WorkflowInvocationV1,
  WorkflowReopenImpactV1,
} from "../../src/contracts/semantic-workflow.js";
import {
  implementationRecommendationFromAssessment,
  unavailableImplementationRecommendation,
} from "../../src/contracts/semantic-workflow.js";
import type { NextAction, NextActionCode } from "../../src/state/next-action.js";
import {
  computeSemanticStatusSnapshot,
  computeTaxonomyDenialRates,
  governingRecommendationPhase,
} from "../../src/state/semantic-status.js";
import { projectSemanticStatus, semanticOfferToken } from "../../src/state/semantic-view.js";
import type { TaskStatusV1 } from "../../src/state/status.js";

const taskId = parseTaskSlug("semantic-test");
const digestA = parseSha256Digest("a".repeat(64));
const digestB = parseSha256Digest("b".repeat(64));
const phase = encodePhaseInstance({ kind: "phase-impl", phase: parsePositiveSafePhaseNumber(1) });
const invocation: WorkflowInvocationV1 = { skill: "archflow-phase-impl", phase: 1, intent: "resume" };

function action(code: NextActionCode, extra: Partial<NextAction> = {}): NextAction {
  return Object.freeze({ code, detail: `detail for ${code}`, human_required: false, phase_instance: phase, ...extra });
}

function fullStatus(nextAction: NextAction, extra: Partial<TaskStatusV1> = {}): TaskStatusV1 {
  return {
    task_id: taskId,
    state: "active",
    revision: 7,
    phase_instance: phase,
    step: "produce",
    status: "pending",
    attempt: 2,
    input_fingerprint: digestA,
    blocking_reasons: [],
    resources: [
      { role: "current-artifact", path: ".archflow/tasks/semantic-test/phases/1/impl-notes.md", access: "write", digest: digestB },
      { role: "phase-design", path: ".archflow/tasks/semantic-test/phases/1/design.md", access: "read-write", digest: digestA },
    ],
    review_policy: {
      rubric_id: "implementation-v1",
      rubric_digest: digestB,
      rubric: {
        schema_version: "1", kind: "implementation", mode: "adversarial",
        criteria: [{ id: "correctness", text: "Find material defects.", blocking: true }],
      },
    },
    constitution: {
      digest: digestA,
      active_rules: [{ id: "trust", version: 1, text: "Require explicit approval." }],
    },
    config: { verified: true },
    next_action: nextAction,
    ...extra,
  } as TaskStatusV1;
}

function snapshot(status: TaskStatusV1, extra: Partial<SemanticStatusSnapshotV1> = {}): SemanticStatusSnapshotV1 {
  return {
    schema_version: "1",
    repository_identity_digest: digestA,
    status: structuredClone(status) as unknown as PlainJsonValue,
    full_findings: [],
    taxonomy_denial_rates: computeTaxonomyDenialRates([]),
    implementation_recommendation: unavailableImplementationRecommendation("not-applicable", "Fixture has no effort evidence."),
    reopen_impacts: [],
    ...extra,
  };
}

function effortAssessment(blocked = false): EffortAssessmentV1 {
  const judgment = {
    component_id: "semantic-projection",
    axes: {
      A: { score: 1, rationale: "local derivation" }, B: { score: 1, rationale: "unit tests" },
      C: { score: 1, rationale: "sequential state" },
      D: { score: blocked ? 2 : 0, rationale: blocked ? "ownership missing" : "specified" },
      E: { score: 0, rationale: "stable surface" },
    },
    long_tool_loop: { value: "no", rationale: "bounded" },
    short_component: { value: "yes", rationale: "one focused pass" },
    ...(blocked ? { blocker: { answer_kind: "priority-order", question: "Which subsystem owns retries?" } } : {}),
  } as const;
  const profile = { profile_id: "gemini-3-7-flash-max", model: "gemini-3.7-flash", effort: "max" } as const;
  return {
    schema_version: "1", task_id: taskId, phase_instance: "phase-design-1", attempt: 1,
    subject_digest: digestA, input_fingerprint: digestB,
    component_manifest_digest: digestA, hazard_registry_digest: digestB,
    policy_id: "implementation-effort-v1",
    decomposition: { status: "adequate", rationale: "independent boundary" }, judgments: [judgment],
    reviewer: {
      adapter: "codex-cli", cli_version: "1", model_family: "codex", model: "gpt-5.6-luna",
      effort: "xhigh", invocation_id: "effort-invocation", result_id: "effort-result",
      envelope_input_digest: digestA, observed_output_digest: digestB,
      route_source: { provenance: "configured" },
      repositories: [{ name: "primary", repository_identity_digest: digestA, commit: "a".repeat(40) as never }],
    },
    recommendation: blocked
      ? {
          status: "blocked", component_profiles: [], blockers: [{
            kind: "specification-gap", component_id: judgment.component_id,
            answer_kind: "priority-order", question: "Which subsystem owns retries?",
          }],
        }
      : {
          status: "ready", blockers: [],
          component_profiles: [{ component_id: judgment.component_id, total: 3, profile, caveats: [] }],
          phase_profile: profile, determining_component_ids: [judgment.component_id],
        },
  } as unknown as EffortAssessmentV1;
}

describe("semantic status projection", () => {
  it("exposes the complete authenticated taxonomy denial-rate record unchanged", () => {
    const status = fullStatus(action("run-step", { step: "produce" }));
    const rates = {
      ...computeTaxonomyDenialRates([]),
      "gap:likely": 0.75,
      "preference:suspicion": 1,
    };
    const view = projectSemanticStatus(snapshot(status, { taxonomy_denial_rates: rates }), invocation).view;
    expect(view.taxonomy_denial_rates).toEqual(rates);
    expect(Object.keys(view.taxonomy_denial_rates ?? {})).toHaveLength(12);
  });

  it("copies authenticated effort advice without changing the action or offer", () => {
    const status = fullStatus(action("run-step", { step: "produce" }));
    const ready = implementationRecommendationFromAssessment(effortAssessment(), 1);
    const unavailable = snapshot(status);
    const advised = snapshot(status, { implementation_recommendation: ready });
    expect(projectSemanticStatus(advised, invocation).view.implementation_recommendation).toEqual(ready);
    expect(projectSemanticStatus(advised, invocation).view.next_action)
      .toEqual(projectSemanticStatus(unavailable, invocation).view.next_action);
  });

  it("maps archived blockers to a ready default and keeps unavailable states informational", () => {
    const status = fullStatus(action("run-step", { step: "produce" }));
    const baseline = projectSemanticStatus(snapshot(status), invocation).view.next_action;
    const recommendations = [
      implementationRecommendationFromAssessment(effortAssessment(true), 1),
      unavailableImplementationRecommendation("not-produced", "No effort review exists.", 1),
      unavailableImplementationRecommendation("legacy-evidence", "The exact review predates effort evidence.", 1),
      unavailableImplementationRecommendation("subject-stale", "The review describes earlier design bytes.", 1),
    ];
    expect(recommendations.map((item) => item.status)).toEqual(["ready", "unavailable", "unavailable", "unavailable"]);
    expect(recommendations[0]).toEqual({ status: "ready", model: "gpt-5.6-sol", effort: "medium" });
    for (const recommendation of recommendations) {
      const view = projectSemanticStatus(snapshot(status, { implementation_recommendation: recommendation }), invocation).view;
      expect(view.implementation_recommendation).toEqual(recommendation);
      expect(view.next_action).toEqual(baseline);
    }
  });

  it("fails closed on malformed or wrong-phase effort evidence and selects no unrelated phase", () => {
    const malformed = structuredClone(effortAssessment()) as unknown as { policy_id: string };
    malformed.policy_id = "invented-policy";
    expect(() => implementationRecommendationFromAssessment(malformed as unknown as EffortAssessmentV1, 1)).toThrow();
    expect(() => implementationRecommendationFromAssessment(effortAssessment(), 2))
      .toThrow(/governing phase design/u);
    const prd = { ...({} as TaskStateV1), phase_instance: "prd", terminal: undefined } as unknown as TaskStateV1;
    const design = { ...prd, phase_instance: "design" } as unknown as TaskStateV1;
    expect(governingRecommendationPhase(prd)).toBeUndefined();
    expect(governingRecommendationPhase(design)).toBeUndefined();
  });

  it("classifies every live registry comparison without changing advice or action", () => {
    const manifest = {
      schema_version: "1",
      components: [{
        id: "semantic-projection", name: "Semantic projection", scope: "Project advice.",
        mechanism: "Map authenticated evidence.",
        repositories: [{ name: "primary", paths: ["src/state/semantic-status.ts"] }],
        verification: "Run focused tests.",
      }],
    } as unknown as PhaseDesignComponentManifestV1;
    const absent = createHazardRegistryInput("absent", { schema_version: "1", hazards: [] }, manifest);
    const present = createHazardRegistryInput("present", { schema_version: "1", hazards: [{
      repository: "primary", path: "src/state/semantic-status.ts" as never, score: 2,
      reason: "Dense authority bindings.",
    }] }, manifest);
    const changed = createHazardRegistryInput("present", { schema_version: "1", hazards: [{
      repository: "primary", path: "src/state/semantic-status.ts" as never, score: 3,
      reason: "Changed hazard judgment.",
    }] }, manifest);
    expect(compareHazardRegistryInput(absent.registry_digest, absent, manifest)).toBeUndefined();
    expect(compareHazardRegistryInput(absent.registry_digest, present, manifest)).toBe("registry-created");
    expect(compareHazardRegistryInput(present.registry_digest, changed, manifest)).toBe("registry-changed");
    expect(compareHazardRegistryInput(present.registry_digest, absent, manifest)).toBe("registry-removed");

    const status = fullStatus(action("run-step", { step: "produce" }));
    const baseline = projectSemanticStatus(snapshot(status), invocation).view.next_action;
    const recommendation = implementationRecommendationFromAssessment(effortAssessment(), 1);
    const projected = projectSemanticStatus(snapshot(status, { implementation_recommendation: recommendation }), invocation).view;
    expect(projected.implementation_recommendation).toEqual(recommendation);
    expect(projected.next_action).toEqual(baseline);
  });

  it("suppresses writable resources at a close-only revision checkpoint", () => {
    const status = fullStatus(action("run-step", { step: "produce" }), { step: "triage", status: "succeeded" });
    const projected = projectSemanticStatus(snapshot(status, {
      revision_checkpoint: { status: "valid", choice: "revise-current" },
    }), invocation);
    expect(projected.view.next_action.kind).toBe("revise");
    expect(projected.view.resources).toEqual([]);
  });

  it("carries the constitution findings into a policy re-entry revise offer", () => {
    const detail = "Constitution rule rust-standards (v1) is not met: clippy lints are suppressed. Resolve these in the artifact, then resubmit for a fresh review.";
    const status = fullStatus(action("run-step", { step: "produce", policy_reentry: true, detail }), { step: "triage", status: "succeeded" });
    const projected = projectSemanticStatus(snapshot(status), invocation);
    expect(projected.view.next_action.kind).toBe("revise");
    expect(projected.view.detail).toContain(detail);

    const plain = fullStatus(action("run-step", { step: "produce", detail }), { step: "triage", status: "succeeded" });
    expect(projectSemanticStatus(snapshot(plain), invocation).view.detail).not.toContain(detail);
  });

  it("maps every current NextActionCode without exposing a protocol action", () => {
    const codes = [
      "initialize-repository", "create-task", "resume-exact-intent",
      "inspect-retained-receipt", "create-fresh-intent", "resolve-current-authority",
      "open-gate", "resolve-open-gate", "run-step", "commit-artifacts", "commit-phase", "advance-phase",
      "complete-task", "task-complete", "inspect-state",
    ] as const satisfies readonly NextActionCode[];

    for (const code of codes) {
      const extras: Partial<NextAction> = code === "run-step"
        ? { step: "produce" }
        : code === "commit-artifacts"
          ? { commit_path: ".archflow/tasks/semantic-test/design.md", commit_message: "Approve design", commit_target_ref: "refs/heads/main", commit_baseline: "1".repeat(40) }
          : code === "advance-phase"
            ? { skill: "archflow-phase-design", skill_args: ["2"] }
            : {};
      const statusExtras: Partial<TaskStatusV1> = code === "resolve-open-gate"
        ? ({ open_gate: { presentation: { class: "configured-approval", title: "Choose", summary: "Summary", question: "Continue?", reasons: [{ class: "configured-approval", text: "Configured approval is required." }], options: [{ token: "approve", label: "Approve", consequence: "Continue." }] } } } as unknown as Partial<TaskStatusV1>)
        : {};
      const result = projectSemanticStatus(snapshot(fullStatus(action(code, extras), statusExtras)), invocation);
      expect(result.view.next_action.kind).toBeTruthy();
      expect(JSON.stringify(result.view)).not.toContain("request_digest");
      if (code === "resolve-open-gate") {
        expect(result.view.presentation).toMatchObject({
          class: "configured-approval",
          reasons: [{ class: "configured-approval", text: "Configured approval is required." }],
        });
      }
    }
  });

  it("projects a config change notice without changing the action kind", () => {
    const entries = [
      { path: "roles.counter-reviewer.effort", before: "xhigh", after: "high" },
      { path: "max_attempts", after: 4 },
    ] as const;
    const status = fullStatus(action("run-step", { step: "produce" }), {
      config_change: entries,
    } as Partial<TaskStatusV1>);
    const projected = projectSemanticStatus(snapshot(status), invocation);
    // Informational only: the entries ride along verbatim and the prose gains one line, but
    // the condition and the action are exactly what an unedited config would produce.
    expect(projected.view.next_action.kind).toBe("begin-work");
    expect(projected.view.config_change).toEqual([...entries]);
    expect(projected.view.detail).toContain("2 fields");
  });

  it("projects the live repository set as informational context", () => {
    const repositories = [
      { name: "primary", mode: "writable" as const, location: "/work/primary", head: "1".repeat(40) as never, last_reviewed_commit: "1".repeat(40) as never },
      { name: "apis", mode: "context-only" as const, location: "/work/apis", head: "2".repeat(40) as never, last_reviewed_commit: "3".repeat(40) as never },
    ];
    const status = fullStatus(action("run-step", { step: "produce" }), { repositories });
    const projected = projectSemanticStatus(snapshot(status), invocation).view;
    expect(projected.next_action.kind).toBe("begin-work");
    expect(projected.repositories).toEqual(repositories);
    expect(projected.detail).toContain("live repository set is listed in repositories");
    expect(projected.detail).toContain("grants no review or write authority");
  });

  it("projects work, review, empty triage, triage, and honest implementation commit states", () => {
    const running = fullStatus(action("run-step", { step: "produce" }), { step: "produce", status: "running" });
    expect(projectSemanticStatus(snapshot(running), invocation).view.next_action.kind).toBe("submit-work");

    const review = fullStatus(action("run-step", { step: "counter_review" }), { step: "produce", status: "succeeded" });
    expect(projectSemanticStatus(snapshot(review), invocation).view.next_action.kind).toBe("review");

    const failedDispatch = fullStatus(action("run-step", { step: "counter_review" }), {
      step: "counter_review",
      status: "running",
      dispatch_failure: {
        role: "counter-reviewer",
        code: "AUTH_UNAVAILABLE",
        message: "The required reviewer authentication is unavailable.",
        route: { model: "claude-fable-5", effort: "high", source: "invocation-declared" },
      },
    });
    const failedDispatchView = projectSemanticStatus(snapshot(failedDispatch), invocation).view;
    expect(failedDispatchView.next_action).toMatchObject({ kind: "review", expected_submission: "review-dispatch" });
    expect(failedDispatchView.dispatch_failure).toEqual(failedDispatch.dispatch_failure);
    expect(failedDispatchView.dispatch_failure).not.toHaveProperty("attempt");
    expect(failedDispatchView.dispatch_failure).not.toHaveProperty("observed_at_revision");

    const emptyTriage = fullStatus(action("run-step", { step: "triage" }), { step: "counter_review", status: "succeeded" });
    expect(projectSemanticStatus(snapshot(emptyTriage), invocation).view.next_action.kind).toBe("review");

    const finding: PublicFindingV1 = {
      finding_id: "material-defect", severity: "major", blocking: false, summary: "A real defect",
      evidence: "The retained implementation omits the required branch.", suggested_resolution: "Implement the branch.",
    };
    const triage = projectSemanticStatus(snapshot(emptyTriage, { full_findings: [finding] }), invocation);
    expect(triage.view.next_action.kind).toBe("triage");
    expect(triage.view.findings).toEqual([finding]);

    const authorized = projectSemanticStatus(snapshot(fullStatus(action("commit-phase", {
      commit_paths: ["src/z.ts", "src/a.ts"],
      commit_message: "Implement the approved phase",
      commit_target_ref: "refs/heads/main",
      commit_baseline: "2".repeat(40),
    }))), invocation).view.next_action;
    expect(authorized.kind).toBe("commit");
    expect(authorized.commit).toEqual({
      paths: ["src/a.ts", "src/z.ts"],
      message: "Implement the approved phase",
      target_ref: "refs/heads/main",
      baseline: "2".repeat(40),
    });
    expect(authorized.offer).toBeUndefined();
    expect(authorized.instruction).toContain("baseline and target ref");
    expect(authorized.instruction).toContain("stage and inspect exactly the authorized paths");
    expect(authorized.instruction).toContain("exact returned message");
    expect(authorized.instruction).toContain("preserving unrelated changes");

    const autonomous = projectSemanticStatus(snapshot(fullStatus(action("commit-phase", {
      commit_paths: ["src/a.ts"], commit_message: "Implement the reviewed phase",
      commit_target_ref: "refs/heads/main", commit_baseline: "2".repeat(40),
    }))), invocation).view.next_action;
    expect(autonomous.instruction).toContain("create the commit directly");
    expect(autonomous.instruction).toContain("baseline and target ref");
    expect(autonomous.instruction).toContain("stage and inspect exactly the authorized paths");
    expect(autonomous.instruction).toContain("exact returned message");
    expect(autonomous.instruction).toContain("preserving unrelated changes");
    expect(autonomous.commit).not.toHaveProperty("requires_human_confirmation");

    const missingAuthority = projectSemanticStatus(snapshot(fullStatus(action("commit-phase"))), invocation).view.next_action;
    expect(missingAuthority.kind).toBe("inspect");
    expect(missingAuthority.commit).toBeUndefined();
    expect(missingAuthority.instruction).toContain("implementation commit authority");

    const milestone = projectSemanticStatus(snapshot(fullStatus(action("commit-artifacts", {
      commit_path: ".archflow/tasks/semantic-test/design.md",
      commit_message: "Approve design",
      commit_target_ref: "refs/heads/main",
      commit_baseline: "1".repeat(40),
    }))), invocation).view.next_action;
    expect(milestone.commit).toEqual({
      paths: [".archflow/tasks/semantic-test/design.md"],
      message: "Approve design",
      target_ref: "refs/heads/main",
      baseline: "1".repeat(40),
    });
  });

  it("projects review strength from recorded provenance and per-round counts, never from prose", () => {
    const reviewed = fullStatus(action("run-step", { step: "triage" }), {
      step: "counter_review",
      status: "succeeded",
      evidence: {
        available: true,
        subject_digest: digestA,
        current_evidence: { set_digest: digestB, slots: [] },
        findings: [],
        counter_review_provenance: {
          assurance: "server-attested", producer_family: "claude", model_family: "claude",
          model: "claude-opus-5", effort: "medium", adapter: "claude-cli",
        },
        assessment: "current",
      } as never,
    });
    const rounds = [
      { attempt: 1, findings: 4, blocking: 1, accepted: 3 },
      { attempt: 2, findings: 0, blocking: 0, accepted: 0 },
    ];
    const view = projectSemanticStatus(snapshot(reviewed, { review_rounds: rounds }), invocation).view;
    expect(view.review_strength).toEqual({
      reviewer_model: "claude-opus-5",
      reviewer_effort: "medium",
      reviewer_family: "claude",
      producer_family: "claude",
      same_family: true,
      attempt: 2,
      remediation_round: true,
      rounds,
      reviewers: [{
        reviewer_id: "general", focus: "general", model: "claude-opus-5", effort: "medium",
        reviewer_family: "claude", same_family: true, finding_count: 0,
      }],
    });

    const opposite = fullStatus(action("run-step", { step: "triage" }), {
      step: "counter_review",
      status: "succeeded",
      attempt: 1,
      evidence: {
        available: true,
        subject_digest: digestA,
        current_evidence: { set_digest: digestB, slots: [] },
        findings: [],
        counter_review_provenance: {
          assurance: "server-attested", producer_family: "claude", model_family: "codex",
          model: "gpt-5.6-sol", effort: "xhigh", adapter: "codex-cli",
        },
        assessment: "current",
      } as never,
    });
    expect(projectSemanticStatus(snapshot(opposite), invocation).view.review_strength).toMatchObject({
      same_family: false, remediation_round: false, attempt: 1, rounds: [],
    });

    const unreviewed = fullStatus(action("run-step", { step: "produce" }), { evidence: { available: false } as never });
    expect(projectSemanticStatus(snapshot(unreviewed), invocation).view).not.toHaveProperty("review_strength");
  });

  it("projects the actual multi-general and test assignments and fresh contributor strengths", () => {
    const generalOne = { adapter: "codex-cli", family: "codex", model: "gpt-5.6-sol", effort: "xhigh" } as const;
    const generalTwo = { adapter: "claude-cli", family: "claude", model: "claude-fable-5", effort: "high" } as const;
    const testRoute = { adapter: "codex-cli", family: "codex", model: "gpt-5.6-luna", effort: "max" } as const;
    const adjudicator = { adapter: "antigravity-cli", family: "gemini", model: "gemini-3.7-flash-high", effort: "high" } as const;
    const policy = {
      rubric_id: "implementation-v1" as const,
      rubric_digest: digestB,
      rubric: {
        schema_version: "1" as const, kind: "implementation" as const, mode: "adversarial" as const,
        criteria: [
          { id: "correctness", text: "Find material defects.", blocking: true },
          { id: "verification-evidence", text: "Verify the evidence.", blocking: true },
          { id: "test-quality", text: "Assess regression protection.", blocking: true },
        ],
      },
    };
    const routes = {
      counter_reviewer: generalOne,
      counter_reviewers: [generalOne, generalTwo],
      test_reviewer: testRoute,
      adjudicator,
    };
    const preReview = fullStatus(action("run-step", { step: "counter_review" }), {
      review_policy: policy,
      routes,
    });
    expect(projectSemanticStatus(snapshot(preReview), invocation).view.review_context?.assignments).toBeUndefined();

    const run = (reviewer_id: string, focus: "general" | "tests", route: typeof generalOne | typeof generalTwo | typeof testRoute, criterion_ids: string[], finding_ids: string[]) => ({
      reviewer_id, focus, routing_role: focus === "tests" ? "test-reviewer" : "counter-reviewer",
      criterion_ids, rubric_digest: digestB, model_family: route.family, model: route.model,
      effort: route.effort, adapter: route.adapter, cli_version: "1.0.0", invocation_id: `invocation-${reviewer_id}`,
      envelope_input_digest: digestA, observed_output_digest: digestB, finding_ids,
      route_source: { provenance: "configured" },
    });
    const reviewed = fullStatus(action("run-step", { step: "triage" }), {
      step: "counter_review", status: "succeeded", review_policy: policy, routes,
      evidence: {
        available: true, subject_digest: digestA,
        current_evidence: { set_digest: digestB, slots: [] }, findings: [], assessment: "current",
        counter_review_provenance: {
          assurance: "server-attested", producer_family: "claude", model_family: "codex",
          model: generalOne.model, effort: generalOne.effort, adapter: generalOne.adapter,
          reviewer_runs: [
            run("general-1", "general", generalOne, ["correctness"], ["general-1-defect"]),
            run("general-2", "general", generalTwo, ["correctness"], []),
            run("test", "tests", testRoute, ["verification-evidence", "test-quality"], ["test-gap", "test-duplicate"]),
          ],
        },
      } as never,
    });
    const view = projectSemanticStatus(snapshot(reviewed), invocation).view;
    expect(view.review_context?.assignments).toEqual([
      { reviewer_id: "general-1", focus: "general", criterion_ids: ["correctness"] },
      { reviewer_id: "general-2", focus: "general", criterion_ids: ["correctness"] },
      { reviewer_id: "test", focus: "tests", criterion_ids: ["verification-evidence", "test-quality"] },
    ]);
    expect(view.review_strength?.reviewers).toMatchObject([
      { reviewer_id: "general-1", reviewer_family: "codex", same_family: false, finding_count: 1 },
      { reviewer_id: "general-2", reviewer_family: "claude", same_family: true, finding_count: 0 },
      { reviewer_id: "test", reviewer_family: "codex", same_family: false, finding_count: 2 },
    ]);
  });

  it("projects baseline refresh as one server-owned no-submission action", () => {
    const designInvocation: WorkflowInvocationV1 = { skill: "archflow-phase-design", phase: 1, intent: "resume" };
    const phase = encodePhaseInstance({ kind: "phase-design", phase: parsePositiveSafePhaseNumber(1) });
    const projected = projectSemanticStatus(snapshot(fullStatus(
      action("refresh-milestone-baseline", { phase_instance: phase }),
      { phase_instance: phase, step: "triage", status: "succeeded" },
    )), designInvocation).view.next_action;
    expect(projected).toMatchObject({ kind: "refresh-milestone-baseline", expected_submission: "none" });
    expect(projected.offer).toMatch(/^af1_/u);
  });

  it("maps the migration-audit gate position and import milestone commit through the shared shapes", () => {
    const designInvocation: WorkflowInvocationV1 = { skill: "archflow-design", intent: "resume" };
    const designPhase = encodePhaseInstance({ kind: "design" });
    const auditPosition = projectSemanticStatus(snapshot(fullStatus(
      action("open-gate", { gate_kind: "migration-audit", phase_instance: designPhase }),
      { phase_instance: designPhase, step: "triage", status: "succeeded" },
    )), designInvocation).view.next_action;
    expect(auditPosition.kind).toBe("decide");
    expect(auditPosition.expected_submission).toBe("gate-summary");

    const importCommit = projectSemanticStatus(snapshot(fullStatus(
      action("commit-artifacts", {
        commit_path: ".archflow/tasks/semantic-test",
        commit_message: "Import legacy task semantic-test",
        commit_target_ref: "refs/heads/main",
        commit_baseline: "3".repeat(40),
      }),
      { phase_instance: designPhase, step: "triage", status: "succeeded" },
    )), designInvocation).view.next_action;
    expect(importCommit.kind).toBe("commit");
    expect(importCommit.commit).toEqual({
      paths: [".archflow/tasks/semantic-test"],
      message: "Import legacy task semantic-test",
      target_ref: "refs/heads/main",
      baseline: "3".repeat(40),
    });
  });

  it("binds offers to invocation and repository while generic status cannot mutate", () => {
    const documentPhase = encodePhaseInstance({ kind: "phase-design", phase: parsePositiveSafePhaseNumber(1) });
    const status = fullStatus(action("run-step", { step: "produce", phase_instance: documentPhase }), {
      phase_instance: documentPhase,
    });
    const documentInvocation: WorkflowInvocationV1 = { skill: "archflow-phase-design", phase: 1, intent: "resume" };
    const generic = projectSemanticStatus(snapshot(status));
    expect(generic.view.next_action.kind).toBe("begin-work");
    expect(generic.view.next_action.offer).toBeUndefined();
    expect(generic.internal_offer).toBeUndefined();

    const owned = projectSemanticStatus(snapshot(status), documentInvocation);
    expect(owned.view.next_action.offer).toMatch(/^af1_[0-9a-f]{64}$/u);
    const otherRepo = projectSemanticStatus(snapshot(status, { repository_identity_digest: digestB }), documentInvocation);
    expect(otherRepo.view.next_action.offer).not.toBe(owned.view.next_action.offer);

    const wrongInvocation: WorkflowInvocationV1 = { skill: "archflow-design", intent: "resume" };
    const wrong = projectSemanticStatus(snapshot(status), wrongInvocation);
    expect(wrong.view.next_action.offer).toBeUndefined();
    expect(wrong.view.detail).toContain("does not own");

    const implementation = projectSemanticStatus(snapshot(fullStatus(action("run-step", { step: "produce" }))), invocation);
    expect(implementation.view.next_action.kind).toBe("begin-work");
    expect(implementation.view.next_action.offer).toMatch(/^af1_[0-9a-f]{64}$/u);
  });

  it("lets only the exact successor invocation recover an authenticated handoff", () => {
    const successor = encodePhaseInstance({ kind: "phase-design", phase: parsePositiveSafePhaseNumber(2) });
    const status = fullStatus(action("advance-phase", {
      target_phase_instance: successor,
      skill: "archflow-phase-design",
      skill_args: ["2"],
    }));
    const exact: WorkflowInvocationV1 = { skill: "archflow-phase-design", phase: 2, intent: "resume" };
    const wrong: WorkflowInvocationV1 = { skill: "archflow-phase-design", phase: 3, intent: "resume" };

    expect(projectSemanticStatus(snapshot(status), exact).view.next_action.offer).toMatch(/^af1_[0-9a-f]{64}$/u);
    expect(projectSemanticStatus(snapshot(status), wrong).view.next_action.offer).toBeUndefined();
  });

  it("offers only a server-derived legal earlier reopen and explains its impact", () => {
    const impact: WorkflowReopenImpactV1 = {
      target: { kind: "design" },
      affected_positions: [{ kind: "design" }, { kind: "phase-design", phase: 1 }, { kind: "phase-impl", phase: 1 }],
      authority_effects: ["supersede-results", "clear-active-waivers", "clear-pending-human-revision", "clear-planned-final-phase"],
      planned_final_phase: "clear",
      preserves_existing_git_index_and_worktree_bytes: true,
      appends_prd_ask_history: false,
      requires_fresh_review_and_approval: true,
    };
    const reopenInvocation: WorkflowInvocationV1 = { skill: "archflow-design", intent: "reopen" };
    const result = projectSemanticStatus(snapshot(fullStatus(action("run-step", { step: "produce" })), { reopen_impacts: [impact] }), reopenInvocation);
    expect(result.view.next_action.kind).toBe("reopen");
    expect(result.view.next_action.reopen).toEqual(impact);
    expect(result.view.next_action.expected_submission).toBe("reopening-request");

    const unavailable = projectSemanticStatus(snapshot(fullStatus(action("run-step", { step: "produce" }))), reopenInvocation);
    expect(unavailable.view.next_action.kind).toBe("begin-work");
    expect(unavailable.view.next_action.offer).toBeUndefined();
  });

  it("keeps mechanical authority out of the public view", () => {
    const projected = projectSemanticStatus(snapshot(fullStatus(action("run-step", { step: "produce" }))), invocation);
    const keys = new Set<string>();
    const visit = (value: unknown): void => {
      if (Array.isArray(value)) return value.forEach(visit);
      if (value !== null && typeof value === "object") {
        for (const [key, child] of Object.entries(value)) { keys.add(key); visit(child); }
      }
    };
    visit(projected.view);
    for (const forbidden of ["revision", "input_fingerprint", "request_digest", "intent_id", "gate_id", "subject_digest", "evidence_digest", "rubric_digest", "repository_identity_digest"]) {
      expect(keys.has(forbidden), forbidden).toBe(false);
    }
    expect(projected.view.resources[0]).not.toHaveProperty("digest");
  });

  it("fails closed when a pending waiver archive is invalid", () => {
    const status = fullStatus(action("inspect-state"));
    const result = projectSemanticStatus(snapshot(status, {
      pending_waiver_origin: { status: "invalid" },
    }), invocation);
    expect(result.view.condition).toBe("blocked");
    expect(result.view.next_action.kind).toBe("inspect");
    expect(result.view.next_action.offer).toBeUndefined();
  });

  it("uses canonical offer bytes for stable opaque tokens", () => {
    const offer: SemanticActionOfferV1 = {
      schema_version: "1", repository_identity_digest: digestA, task_id: taskId, revision: 1,
      input_fingerprint: digestB, invocation, action_kind: "review", next_action_code: "run-step",
      expected_submission: "none", phase_instance: phase, attempt: 1,
    };
    expect(semanticOfferToken(offer)).toMatch(/^af1_[0-9a-f]{64}$/u);
    expect(semanticOfferToken(structuredClone(offer))).toBe(semanticOfferToken(offer));
  });

  it("rejects snapshots assembled from different durable revisions", () => {
    const status = fullStatus(action("run-step", { step: "produce" }));
    const state = {
      repository_identity_digest: digestA,
      revision: 8, phase_instance: phase, step: "produce", status: "pending", attempt: 2, input_fingerprint: digestA,
    } as unknown as TaskStateV1;
    expect(() => computeSemanticStatusSnapshot(status, {
      repository_identity_digest: digestA, state, full_findings: [],
      taxonomy_denial_rates: computeTaxonomyDenialRates([]),
      implementation_recommendation: unavailableImplementationRecommendation("not-applicable", "Fixture has no effort evidence."),
    })).toThrow(/same canonical read/u);
  });

  it("rejects caller-supplied repository identity that conflicts with durable authority", () => {
    const status = fullStatus(action("run-step", { step: "produce" }));
    const state = {
      repository_identity_digest: digestB,
      revision: status.revision, phase_instance: phase, step: status.step, status: status.status,
      attempt: status.attempt, input_fingerprint: status.input_fingerprint,
    } as unknown as TaskStateV1;
    expect(() => computeSemanticStatusSnapshot(status, {
      repository_identity_digest: digestA, state, full_findings: [],
      taxonomy_denial_rates: computeTaxonomyDenialRates([]),
      implementation_recommendation: unavailableImplementationRecommendation("not-applicable", "Fixture has no effort evidence."),
    })).toThrow(/repository identity/u);
  });
});

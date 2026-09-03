import { afterEach, describe, expect, it } from "vitest";
import { writeFileSync } from "node:fs";
import { join } from "node:path";

import { computeTaskStatus, computeTaskStatusDetailed } from "../../src/state/status.js";
import { createTaskWorkspace, type TaskWorkspace } from "../helpers/task-workspace.js";
import { installSemanticReviewStub, semanticJourneyHarness } from "../helpers/semantic-journeys.js";

const workspaces: TaskWorkspace[] = [];
const restorers: (() => void)[] = [];

afterEach(() => {
  for (const restore of restorers.splice(0)) restore();
  for (const workspace of workspaces.splice(0)) workspace.dispose();
});

const TIMEOUT = 60_000;

describe("status round digest and approval scoping integration", { timeout: TIMEOUT }, () => {
  it("populates current_evidence_set_digest in status evidence and approval facts", async () => {
    const workspace = await createTaskWorkspace({
      taskId: "status-round-populate",
      label: "status-round-populate",
    });
    workspaces.push(workspace);
    restorers.push(installSemanticReviewStub(workspace.root, [[]]));

    const h = semanticJourneyHarness(workspace);
    const invocation = { skill: "archflow-prd", intent: "resume" } as const;
    const prdPath = join(workspace.services.authority.task_root, "prd.md");
    writeFileSync(join(workspace.services.authority.task_root, "ask.md"), "Document round digest scoping.\n");
    writeFileSync(prdPath, "# Round 1 PRD\n\nInitial version for round 1.\n");

    // Produce round 1
    let view = await h.status(invocation);
    expect(view.next_action).toMatchObject({ kind: "submit-work", expected_submission: "work-result" });
    const produced1 = await h.apply(invocation, view, { kind: "work-result", outcome: "succeeded" });
    expect(produced1.ok).toBe(true);
    if (!produced1.ok) return;
    view = produced1.value;

    // Review round 1
    const reviewed1 = await h.apply(invocation, view);
    expect(reviewed1.ok).toBe(true);
    if (!reviewed1.ok) return;
    view = reviewed1.value;

    // Verify computeTaskStatusDetailed populates current_evidence_set_digest in round 1
    const detailedRound1 = await computeTaskStatusDetailed(
      workspace.services.dependencies,
      workspace.services.authority,
    );
    expect(detailedRound1.ok).toBe(true);
    if (!detailedRound1.ok) return;
    expect(detailedRound1.value.status.evidence?.available).toBe(true);
    const round1EvidenceSetDigest = detailedRound1.value.status.evidence?.available
      ? detailedRound1.value.status.evidence.current_evidence.set_digest
      : undefined;
    expect(round1EvidenceSetDigest).toBeDefined();

    // Open gate and approve round 1
    const opened1 = await h.apply(invocation, view, {
      kind: "gate-summary",
      summary: "Round 1 PRD ready for approval.",
    });
    expect(opened1.ok).toBe(true);
    if (!opened1.ok) return;
    view = opened1.value;

    const decided1 = await h.apply(invocation, view, {
      kind: "decision",
      choice: "approve",
      reason: "Approved round 1 requirements.",
    });
    expect(decided1.ok).toBe(true);
    if (!decided1.ok) return;

    // Status now sees round 1 approval with matching round 1 evidence digest -> code: "advance-phase"
    const detailedAfterApproval1 = await computeTaskStatusDetailed(
      workspace.services.dependencies,
      workspace.services.authority,
    );
    expect(detailedAfterApproval1.ok).toBe(true);
    if (!detailedAfterApproval1.ok) return;
    expect(detailedAfterApproval1.value.status.next_action.code).toBe("advance-phase");

    const statusAfterApproval1 = await computeTaskStatus(
      workspace.services.dependencies,
      workspace.services.authority,
    );
    expect(statusAfterApproval1.ok).toBe(true);
    if (!statusAfterApproval1.ok) return;
    expect(statusAfterApproval1.value.next_action.code).toBe("advance-phase");

    // Verify that the approval in state records round 1 evidence set digest
    expect(detailedAfterApproval1.value.state?.approvals).toHaveLength(1);
    expect(detailedAfterApproval1.value.state?.approvals[0]?.subject_digest).toBe(
      detailedRound1.value.status.subject_digest,
    );
  });

  it("rejects prior-round gate approval in computeTaskStatusDetailed when current evidence set digest does not match", async () => {
    const workspace = await createTaskWorkspace({
      taskId: "status-round-rejection",
      label: "status-round-rejection",
    });
    workspaces.push(workspace);
    restorers.push(installSemanticReviewStub(workspace.root, [
      [
        {
          finding_id: "finding-rewrite",
          claim_type: "defect",
          confidence: "certain",
          falsifier: "Inspect the cited requirements.",
          summary: "defect requiring rewrite",
          evidence: "missing requirement",
          suggested_resolution: "rewrite section",
        },
        {
          finding_id: "finding-escalation",
          claim_type: "preference",
          confidence: "certain",
          falsifier: "Inspect the cited requirements.",
          summary: "human escalation",
          evidence: "preference requirement",
          suggested_resolution: "consult human",
        },
      ],
      [],
    ]));

    const h = semanticJourneyHarness(workspace);
    const invocation = { skill: "archflow-prd", intent: "resume" } as const;
    const prdPath = join(workspace.services.authority.task_root, "prd.md");
    writeFileSync(join(workspace.services.authority.task_root, "ask.md"), "Document round digest rejection.\n");
    writeFileSync(prdPath, "# Round 1 PRD\n\nInitial version for round 1.\n");

    // Produce round 1
    let view = await h.status(invocation);
    const produced1 = await h.apply(invocation, view, { kind: "work-result", outcome: "succeeded" });
    expect(produced1.ok).toBe(true);
    if (!produced1.ok) return;
    view = produced1.value;

    // Review round 1 -> returns 2 findings
    const reviewed1 = await h.apply(invocation, view);
    expect(reviewed1.ok, JSON.stringify(reviewed1)).toBe(true);
    if (!reviewed1.ok) return;
    view = reviewed1.value;
    expect(view.next_action).toMatchObject({ kind: "triage", expected_submission: "triage" });

    // Triage round 1: one accepted (rewrite), one escalated-human
    const triaged1 = await h.apply(invocation, view, {
      kind: "triage",
      dispositions: [
        {
          finding_id: "finding-rewrite",
          disposition: "accepted",
          rationale: "Requires rewrite of PRD requirements.",
          revision_intent: "Rewrite requirements section.",
        },
        {
          finding_id: "finding-escalation",
          disposition: "escalated-human",
          rationale: "Requires explicit human judgment on preference.",
        },
      ],
    });
    expect(triaged1.ok).toBe(true);
    if (!triaged1.ok) return;
    view = triaged1.value;

    // Because of human escalation, gate opens
    expect(view.next_action).toMatchObject({ kind: "decide", expected_submission: "gate-summary" });

    const detailedRound1 = await computeTaskStatusDetailed(
      workspace.services.dependencies,
      workspace.services.authority,
    );
    expect(detailedRound1.ok).toBe(true);
    if (!detailedRound1.ok) return;
    const round1EvidenceSetDigest = detailedRound1.value.status.evidence?.available
      ? detailedRound1.value.status.evidence.current_evidence.set_digest
      : undefined;
    expect(round1EvidenceSetDigest).toBeDefined();

    // Open gate and approve round 1
    const opened1 = await h.apply(invocation, view, {
      kind: "gate-summary",
      summary: "Escalation decision ready for approval.",
    });
    expect(opened1.ok).toBe(true);
    if (!opened1.ok) return;
    view = opened1.value;

    const decided1 = await h.apply(invocation, view, {
      kind: "decision",
      choice: "approve",
      reason: "Approved escalation.",
    });
    expect(decided1.ok).toBe(true);
    if (!decided1.ok) return;
    view = decided1.value;

    // Because accepted finding still requires rewrite, next action is revise
    expect(view.next_action).toMatchObject({ kind: "revise", expected_submission: "none" });

    // Re-enter produce
    const reentered = await h.apply(invocation, view);
    expect(reentered.ok).toBe(true);
    if (!reentered.ok) return;
    view = reentered.value;
    expect(view.next_action).toMatchObject({ kind: "submit-work", expected_submission: "work-result" });

    // Modify PRD for round 2
    writeFileSync(prdPath, "# Round 2 PRD\n\nRewritten requirements for round 2.\n");

    // Produce round 2
    const produced2 = await h.apply(invocation, view, { kind: "work-result", outcome: "succeeded" });
    expect(produced2.ok).toBe(true);
    if (!produced2.ok) return;
    view = produced2.value;

    // Review round 2 (stub returns empty clean findings)
    const reviewed2 = await h.apply(invocation, view);
    expect(reviewed2.ok).toBe(true);
    if (!reviewed2.ok) return;
    view = reviewed2.value;

    // Compute status for round 2
    const detailedRound2 = await computeTaskStatusDetailed(
      workspace.services.dependencies,
      workspace.services.authority,
    );
    expect(detailedRound2.ok).toBe(true);
    if (!detailedRound2.ok) return;

    const round2EvidenceSetDigest = detailedRound2.value.status.evidence?.available
      ? detailedRound2.value.status.evidence.current_evidence.set_digest
      : undefined;
    expect(round2EvidenceSetDigest).toBeDefined();
    // Evidence set digest differs from round 1
    expect(round2EvidenceSetDigest).not.toBe(round1EvidenceSetDigest);

    // CRUCIAL VERIFICATION:
    // The prior approval in state was recorded for round1EvidenceSetDigest.
    // In round 2, current_evidence_set_digest is round2EvidenceSetDigest.
    // deriveNextAction REJECTS the mismatched round 1 approval, so the gate is NOT satisfied!
    expect(detailedRound2.value.status.next_action.code).toBe("open-gate");
    if (detailedRound2.value.status.next_action.code === "open-gate") {
      expect(detailedRound2.value.status.next_action.gate_kind).toBe("artifact-approval");
    }

    const statusRound2 = await computeTaskStatus(
      workspace.services.dependencies,
      workspace.services.authority,
    );
    expect(statusRound2.ok).toBe(true);
    if (!statusRound2.ok) return;
    expect(statusRound2.value.next_action.code).toBe("open-gate");

    // Open gate and approve round 2 with matching round 2 digest
    const opened2 = await h.apply(invocation, view, {
      kind: "gate-summary",
      summary: "Round 2 PRD ready for final approval.",
    });
    expect(opened2.ok).toBe(true);
    if (!opened2.ok) return;
    view = opened2.value;

    const decided2 = await h.apply(invocation, view, {
      kind: "decision",
      choice: "approve",
      reason: "Approved round 2 requirements.",
    });
    expect(decided2.ok).toBe(true);
    if (!decided2.ok) return;

    // Matching round 2 approval satisfies the gate -> advances to design!
    const detailedAfter2 = await computeTaskStatusDetailed(
      workspace.services.dependencies,
      workspace.services.authority,
    );
    expect(detailedAfter2.ok).toBe(true);
    if (!detailedAfter2.ok) return;
    expect(detailedAfter2.value.status.next_action.code).toBe("advance-phase");

    const statusAfter2 = await computeTaskStatus(
      workspace.services.dependencies,
      workspace.services.authority,
    );
    expect(statusAfter2.ok).toBe(true);
    if (!statusAfter2.ok) return;
    expect(statusAfter2.value.next_action.code).toBe("advance-phase");
  });
});

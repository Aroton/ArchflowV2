import { afterEach, describe, expect, it } from "vitest";
import { writeFileSync } from "node:fs";
import { join } from "node:path";

import { canonicalDocument } from "../../src/contracts/canonical.js";
import { parseSafeCode, parseSafeId } from "../../src/contracts/evidence.js";
import type { SecretScanner } from "../../src/contracts/secret-scan.js";
import { createAtomicWriter } from "../../src/state/atomic.js";
import { prepareEvidenceResult } from "../../src/state/evidence-results.js";
import { ensureResultDirectory } from "../../src/state/layout.js";
import { createProductionServices } from "../../src/state/production.js";
import { installSnapshot } from "../../src/state/snapshots.js";
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
const cleanScanner: SecretScanner = {
  scan: async (candidates) => ({
    schema_version: "1", outcome: "clean", detector_set_id: parseSafeId("status-round-scanner"),
    scanned_paths: candidates.map((candidate) => candidate.virtual_path),
  }),
};

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

    // Status now sees round 1 approval with matching round 1 evidence digest -> code: "commit-artifacts"
    const detailedAfterApproval1 = await computeTaskStatusDetailed(
      workspace.services.dependencies,
      workspace.services.authority,
    );
    expect(detailedAfterApproval1.ok).toBe(true);
    if (!detailedAfterApproval1.ok) return;
    expect(detailedAfterApproval1.value.status.next_action.code).toBe("commit-artifacts");

    const statusAfterApproval1 = await computeTaskStatus(
      workspace.services.dependencies,
      workspace.services.authority,
    );
    expect(statusAfterApproval1.ok).toBe(true);
    if (!statusAfterApproval1.ok) return;
    expect(statusAfterApproval1.value.next_action.code).toBe("commit-artifacts");

    // Verify that the approval in state records round 1 evidence set digest
    expect(detailedAfterApproval1.value.state?.approvals).toHaveLength(1);
    expect(detailedAfterApproval1.value.state?.approvals[0]?.subject_digest).toBe(
      detailedRound1.value.status.subject_digest,
    );
  });


  it("keeps status composable when fixed-point rejects a stale policy cohort", async () => {
    const workspace = await createTaskWorkspace({
      taskId: "status-policy-cohort",
      label: "status-policy-cohort",
      constitutionBytes: {
        "00-retired.md": new TextEncoder().encode("---\nid: retired-policy\nversion: 1\nstatus: deprecated\n---\nRetired policy.\n"),
      },
    });
    workspaces.push(workspace);
    restorers.push(installSemanticReviewStub(workspace.root, [[]]));

    const h = semanticJourneyHarness(workspace);
    const invocation = { skill: "archflow-prd", intent: "resume" } as const;
    writeFileSync(join(workspace.services.authority.task_root, "ask.md"), "Exercise stale policy status recovery.\n");
    writeFileSync(join(workspace.services.authority.task_root, "prd.md"), "# PRD\n\nStatus remains readable.\n");

    let view = await h.status(invocation);
    const produced = await h.apply(invocation, view, { kind: "work-result", outcome: "succeeded" });
    expect(produced.ok, JSON.stringify(produced)).toBe(true);
    if (!produced.ok) return;
    view = produced.value;
    const reviewed = await h.apply(invocation, view);
    expect(reviewed.ok, JSON.stringify(reviewed)).toBe(true);
    if (!reviewed.ok) return;

    const current = await createProductionServices({
      working_directory: workspace.root,
      task_id: workspace.taskId,
      operation: parseSafeCode("status-policy-cohort-current"),
    });
    expect(current.ok, JSON.stringify(current)).toBe(true);
    if (!current.ok || current.value.state === undefined) return;
    const state = current.value.state.value;
    const reviewReference = [...state.authoritative_results]
      .reverse().find((reference) => reference.step === "counter_review");
    expect(reviewReference).toBeDefined();
    if (reviewReference === undefined) return;
    const retained = await current.value.dependencies.load_retained_manifest!(reviewReference);
    expect(retained.ok, JSON.stringify(retained)).toBe(true);
    if (!retained.ok) return;
    const artifact = retained.value.manifest.value.source_artifact;
    expect(artifact.artifact_kind).toBe("review-evidence");
    if (artifact.artifact_kind !== "review-evidence" || artifact.evidence.schema_version !== "3" ||
        artifact.evidence.assurance !== "server-attested") return;

    const resultId = parseSafeId("stale-policy-adjudication");
    const staleEvidence = {
      schema_version: "2" as const,
      rule_findings: [],
      constitution: "pass" as const,
      matched_rule_versions: [],
      uncertain_rule_versions: [],
      task_id: artifact.evidence.task_id,
      phase_instance: artifact.evidence.phase_instance,
      step: "adjudicate" as const,
      subject_digest: artifact.evidence.subject_digest,
      input_fingerprint: artifact.evidence.input_fingerprint,
      pinned_constitution_digest: state.constitution_digest,
      source_review_envelope_digest: artifact.evidence.envelope_input_digest,
      assurance: "server-attested" as const,
      adapter: "codex-cli" as const,
      cli_version: "fixture-1",
      model_family: "codex" as const,
      model: "gpt-fixture",
      effort: "high" as const,
      invocation_id: "stale-policy-adjudication",
      envelope_input_digest: "e".repeat(64) as typeof artifact.evidence.envelope_input_digest,
      observed_output_digest: "d".repeat(64) as typeof artifact.evidence.envelope_input_digest,
      result_id: resultId,
      route_source: { provenance: "configured" as const },
      repositories: artifact.evidence.repositories,
    };
    const prepared = await prepareEvidenceResult({
      authority: current.value.authority,
      runner: current.value.runner,
      result_id: resultId,
      retained_task_bytes: await current.value.dependencies.read_retained_task_bytes!(),
      measured_at_revision: state.revision,
      scanner: cleanScanner,
      value: { kind: "adjudication", evidence: staleEvidence },
    });
    expect(prepared.ok, JSON.stringify(prepared)).toBe(true);
    if (!prepared.ok) return;
    await ensureResultDirectory(current.value.authority, prepared.value.reference.result_digest);
    const installed = await installSnapshot(
      createAtomicWriter(), prepared.value.prepared, prepared.value.manifest_target,
      current.value.runner.location.worktreeRoot as never,
    );
    expect(installed.ok, JSON.stringify(installed)).toBe(true);
    if (!installed.ok) return;
    writeFileSync(current.value.authority.state.absolute, canonicalDocument({
      ...state,
      authoritative_results: [...state.authoritative_results, prepared.value.reference].sort((left, right) => {
        const leftKey = `${left.phase_instance}\0${left.step}`;
        const rightKey = `${right.phase_instance}\0${right.step}`;
        return leftKey < rightKey ? -1 : leftKey > rightKey ? 1 : 0;
      }),
    }).bytes);

    const reloaded = await createProductionServices({
      working_directory: workspace.root,
      task_id: workspace.taskId,
      operation: parseSafeCode("status-policy-cohort-reloaded"),
    });
    expect(reloaded.ok, JSON.stringify(reloaded)).toBe(true);
    if (!reloaded.ok) return;
    const status = await computeTaskStatus(reloaded.value.dependencies, reloaded.value.authority);
    expect(status.ok, JSON.stringify(status)).toBe(true);
    if (!status.ok) return;
    expect(status.value.evidence?.assessment, JSON.stringify(status.value.evidence?.assessment)).toMatchObject({
      next: "produce", reentry_required: true, policy_reentry_required: true,
    });
    expect(status.value.next_action).toMatchObject({ code: "run-step", step: "produce" });
  });
});

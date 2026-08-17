import { execFileSync } from "node:child_process";
import { chmodSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { connectionContextFactory, createInvocationContext } from "../../src/contracts/contexts.js";
import type {
  ApplySubmissionV1,
  SemanticResultV1,
  WorkflowInvocationV1,
  WorkflowViewV1,
} from "../../src/contracts/semantic-workflow.js";
import { handleSemanticApply, handleSemanticStatus } from "../../src/mcp/handlers/semantic.js";
import { createTaskWorkspace, type TaskWorkspace } from "../helpers/task-workspace.js";

const TIMEOUT = 60_000;
const workspaces: TaskWorkspace[] = [];
const restorers: (() => void)[] = [];

afterEach(() => {
  for (const restore of restorers.splice(0)) restore();
  for (const workspace of workspaces.splice(0)) workspace.dispose();
});

function harness(workspace: TaskWorkspace) {
  const connection = connectionContextFactory.captureStartup({
    connection_id: `semantic-journey-${workspace.taskId}`,
    startup_repository_candidate: { working_directory: workspace.root },
  }).initialize({
    client: { name: "claude-code", version: "2.1.220" },
    host: "claude",
    protocol_version: "2025-11-25",
  });
  let sequence = 0;
  const context = () => createInvocationContext(connection, {
    invocation_id: `semantic-journey-${++sequence}`,
    transport_metadata: { request_id: `semantic-request-${sequence}`, operation: "tools/call" },
  }, new AbortController().signal);

  async function status(invocation?: WorkflowInvocationV1): Promise<WorkflowViewV1> {
    const result = await handleSemanticStatus({
      schema_version: "1", task_id: workspace.taskId, ...(invocation === undefined ? {} : { invocation }),
    }, context());
    expect(result.ok, result.ok ? undefined : JSON.stringify(result.error)).toBe(true);
    if (!result.ok) throw new Error(result.error.code);
    return result.value;
  }

  async function apply(
    invocation: WorkflowInvocationV1,
    view: WorkflowViewV1,
    submission?: ApplySubmissionV1,
  ): Promise<SemanticResultV1> {
    if (view.next_action.offer === undefined) throw new Error("the current view has no semantic offer");
    const result = await handleSemanticApply({
      schema_version: "1", task_id: workspace.taskId, invocation,
      action: { offer: view.next_action.offer, ...(submission === undefined ? {} : { submission }) },
    }, context());
    const fresh = await status(invocation);
    expect(result.ok ? result.value : result.view).toEqual(fresh);
    return result;
  }

  return { status, apply, context };
}

function installReviewStub(root: string, findingsByReview: readonly (readonly Record<string, unknown>[])[]): void {
  const bin = join(root, "semantic-stub-bin");
  const stubHome = join(root, "semantic-stub-home");
  const countPath = join(root, "semantic-review-count");
  mkdirSync(join(stubHome, ".codex"), { recursive: true });
  mkdirSync(bin, { recursive: true });
  writeFileSync(join(stubHome, ".codex", "auth.json"), "{}\n");
  writeFileSync(join(bin, "codex"), `#!/usr/bin/env node
import { readFileSync, writeFileSync } from "node:fs";
const argv = process.argv.slice(2);
if (argv.length === 1 && argv[0] === "--version") process.stdout.write("codex-cli 0.146.0\\n");
else if (argv[0] === "login" && argv[1] === "status") process.stdout.write("Logged in using ChatGPT\\n");
else {
  const chunks = []; for await (const chunk of process.stdin) chunks.push(chunk);
  const envelope = JSON.parse(Buffer.concat(chunks).toString("utf8")); const subject = envelope.subject;
  let output;
  if (subject.role === "counter-review") {
    let count = 0; try { count = Number(readFileSync(${JSON.stringify(countPath)}, "utf8")); } catch {}
    const all = ${JSON.stringify(findingsByReview)}; const findings = all[Math.min(count, all.length - 1)] ?? [];
    writeFileSync(${JSON.stringify(countPath)}, String(count + 1));
    output = { schema_version: "1", task_id: subject.task_id, phase_instance: subject.phase_instance,
      step: "counter_review", role: "counter-review", subject_digest: subject.subject_digest,
      input_fingerprint: subject.input_fingerprint, rubric_digest: subject.rubric_digest,
      producer_family: subject.producer_family, findings, matched_rule_versions: [],
      verdict: findings.some((finding) => finding.blocking === true) ? "fail" : findings.length === 0 ? "pass" : "advisory",
      blocking_count: findings.filter((finding) => finding.blocking === true).length };
  } else {
    output = { schema_version: "1", task_id: subject.task_id, phase_instance: subject.phase_instance,
      step: "adjudicate", subject_digest: subject.subject_digest, input_fingerprint: subject.input_fingerprint,
      pinned_constitution_digest: subject.pinned_constitution_digest,
      approved_upstream_digests: subject.approved_upstream_digests,
      source_evidence_set_digest: subject.source_evidence_set_digest,
      rule_findings: envelope.rules.map((rule) => ({ rule_id: rule.id, rule_version: rule.version,
        compliance: "pass", rationale: "The document respects this rule.", trigger: "not-matched",
        trigger_evidence: "No review trigger matched." })),
      drift_findings: subject.approved_upstream_digests.map((digest) => ({ upstream_digest: digest,
        drift: "aligned", affected_claim_ids: [], rationale: "No upstream drift." })) };
  }
  writeFileSync(argv[argv.indexOf("-o") + 1], JSON.stringify(output) + "\\n");
  process.stdout.write('{"type":"turn.completed"}\\n');
}`);
  chmodSync(join(bin, "codex"), 0o755);
  const saved = { path: process.env.PATH, home: process.env.HOME };
  process.env.PATH = `${bin}:${saved.path ?? ""}`;
  process.env.HOME = stubHome;
  restorers.push(() => {
    if (saved.path === undefined) delete process.env.PATH; else process.env.PATH = saved.path;
    if (saved.home === undefined) delete process.env.HOME; else process.env.HOME = saved.home;
  });
}

describe("semantic document journeys", { timeout: TIMEOUT }, () => {
  it("takes a finding-free PRD through client production, one review, a client summary, and a later human decision", async () => {
    const workspace = await createTaskWorkspace({ taskId: "semantic-prd-clean", label: "semantic-prd-clean" });
    workspaces.push(workspace);
    installReviewStub(workspace.root, [[]]);
    const h = harness(workspace);
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
    designResult = await h.apply(designInvocation, designResult.value, { kind: "decision", choice: "approve", reason: "The design is implementable." });
    if (!designResult.ok) throw new Error(JSON.stringify(designResult));
    expect(designResult.value.next_action.kind).toBe("commit");
    const commit = designResult.value.next_action.commit;
    if (commit === undefined) throw new Error("design commit instructions unavailable");
    expect(commit.requires_human_confirmation).toBe(false);
    execFileSync("git", ["add", "--", commit.path], { cwd: workspace.root });
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
      requires_human_confirmation: false,
    });
    expect(readFileSync(phaseDesignPath, "utf8")).toBe(phaseDesignBytes);
    expect(readFileSync(phasePrdPath, "utf8")).toBe(phasePrdBytes);
    expect(readFileSync(taskDesignPath, "utf8")).toBe(taskDesignBytes);
    expect(execFileSync("git", ["rev-parse", "HEAD"], { cwd: workspace.root, encoding: "utf8" }).trim()).toBe(phaseBaseline);

    execFileSync("git", ["add", "-A", "--", phaseCommit.path], { cwd: workspace.root });
    execFileSync("git", [
      "-c", "user.name=ArchFlow Test", "-c", "user.email=test@example.invalid",
      "commit", "-q", "-m", phaseCommit.message, "--", phaseCommit.path,
    ], { cwd: workspace.root });
    expect(execFileSync("git", ["rev-parse", "HEAD^"], { cwd: workspace.root, encoding: "utf8" }).trim()).toBe(phaseBaseline);
    expect(execFileSync("git", ["log", "-1", "--pretty=%B"], { cwd: workspace.root, encoding: "utf8" }).trim())
      .toBe(phaseCommit.message);

    const observedPhaseDesign = await h.status(phaseDesignInvocation);
    expect(observedPhaseDesign.next_action).toMatchObject({
      kind: "start-next-skill", skill: "archflow-phase-impl", skill_args: ["1"],
    });
    expect(observedPhaseDesign.next_action.offer).toBeUndefined();

    const phaseImplInvocation = { skill: "archflow-phase-impl", phase: 1, intent: "resume" } as const;
    const legacyHandoff = await h.status(phaseImplInvocation);
    expect(legacyHandoff.next_action).toMatchObject({
      kind: "start-next-skill", skill: "archflow-phase-impl", skill_args: ["1"],
    });
    expect(legacyHandoff.next_action.offer).toBeUndefined();
    expect(legacyHandoff.detail).toMatch(/supported legacy skill workflow/i);
    expect(readFileSync(join(workspace.root, "semantic-review-count"), "utf8")).toBe("3");
  });

  it("returns a material finding for client triage and requires an explicit revise action before remediation bytes are accepted", async () => {
    const workspace = await createTaskWorkspace({ taskId: "semantic-prd-remediation", label: "semantic-prd-remediation" });
    workspaces.push(workspace);
    installReviewStub(workspace.root, [[{
      finding_id: "requirement-observable", severity: "major", blocking: false,
      summary: "The success condition is not observable.", evidence: "prd.md names no observable result.",
      suggested_resolution: "Name the result a verifier can observe.",
    }]]);
    const h = harness(workspace);
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

  it("returns fresh safe status for stale, forged, cross-repository, and phase-implementation attempts without mutation", async () => {
    const first = await createTaskWorkspace({ taskId: "semantic-negative", label: "semantic-negative-a" });
    const second = await createTaskWorkspace({
      taskId: "semantic-negative", label: "semantic-negative-b",
      configBytes: new TextEncoder().encode(`schema_version: "1"
roles:
  producer: { model: claude-opus-5, effort: high }
  counter-reviewer: { model: gpt-5.6-sol, effort: high }
  adjudicator: { model: gpt-5.6-sol, effort: high }
`),
    });
    workspaces.push(first, second);
    const invocation = { skill: "archflow-prd", intent: "resume" } as const;
    const firstHarness = harness(first);
    const secondHarness = harness(second);
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
    expect(phaseView.detail).toMatch(/legacy/i);
    const phaseMutation = await handleSemanticApply({
      schema_version: "1", task_id: first.taskId, invocation: phaseImpl,
      action: { offer: offered.next_action.offer!, submission: { kind: "work-result", outcome: "failed", reason: "must remain legacy" } },
    }, firstHarness.context());
    expect(phaseMutation).toMatchObject({ ok: false, error: { code: "SEMANTIC_ACTION_UNSUPPORTED" }, view: phaseView });
  });
});

import { execFileSync } from "node:child_process";
import { chmodSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { canonicalJsonBytes } from "../../src/contracts/canonical.js";
import {
  parseWorkflowInvocationV1,
  type ApplySubmissionV1,
  type WorkflowInvocationV1,
  type WorkflowViewV1,
} from "../../src/contracts/semantic-workflow.js";
import {
  reachImplementationHandoff,
  semanticJourneyHarness,
  type SemanticJourneyHarness,
} from "../helpers/semantic-journeys.js";
import { createTaskWorkspace, type TaskWorkspace } from "../helpers/task-workspace.js";

const TIMEOUT = 180_000;
const workspaces: TaskWorkspace[] = [];
const restorers: (() => void)[] = [];

afterEach(() => {
  for (const restore of restorers.splice(0)) restore();
  for (const workspace of workspaces.splice(0)) workspace.dispose();
});

function gitAt(workspace: TaskWorkspace, ...arguments_: readonly string[]): string {
  return execFileSync("git", [...arguments_], { cwd: workspace.root, encoding: "utf8" }).trim();
}

const headAt = (workspace: TaskWorkspace): string => gitAt(workspace, "rev-parse", "HEAD");

const commitCountAt = (workspace: TaskWorkspace): number =>
  Number(gitAt(workspace, "rev-list", "--count", "HEAD"));

const reviewCountAt = (workspace: TaskWorkspace): number =>
  Number(readFileSync(join(workspace.root, "semantic-review-count"), "utf8"));

/** Keeps the scripted-child fixtures out of the implementation output's changed-path report. */
function excludeStubArtifacts(workspace: TaskWorkspace): void {
  const exclude = join(workspace.root, ".git", "info", "exclude");
  mkdirSync(dirname(exclude), { recursive: true });
  writeFileSync(exclude, "semantic-stub-bin/\nsemantic-stub-home/\nsemantic-review-count\n");
}

async function applied(
  h: SemanticJourneyHarness,
  invocation: WorkflowInvocationV1,
  view: WorkflowViewV1,
  submission?: ApplySubmissionV1,
): Promise<WorkflowViewV1> {
  const result = await h.apply(invocation, view, submission);
  if (!result.ok) throw new Error(JSON.stringify(result.error));
  return result.value;
}

type AdjudicationScript = Readonly<{ materialDrift?: boolean; failingRule?: boolean }>;

/**
 * Local variant of the shared review stub: the same scripted counter-review child (one findings
 * list per dispatch, the last repeating), with an adjudication child that can fail one rule or
 * report one material upstream drift instead of always passing and staying aligned.
 */
function installScriptedReviewChild(
  root: string,
  findingsByReview: readonly (readonly Record<string, unknown>[])[],
  script: AdjudicationScript = {},
): () => void {
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
    const implementation = subject.phase_instance.indexOf("phase-impl-") === 0;
    const pass = (rule) => ({ rule_id: rule.id, rule_version: rule.version, compliance: "pass",
      rationale: "The work respects this rule.", trigger: "not-matched",
      trigger_evidence: "No review trigger matched." });
    const rule_findings = envelope.rules.map((rule, index) => (
      ${JSON.stringify(script.failingRule === true)} && implementation && index === 0
        ? { rule_id: rule.id, rule_version: rule.version, compliance: "fail",
            rationale: "The implementation departs from the approved plan.",
            trigger: "matched",
            trigger_evidence: "The approved phase design requires an update before this work advances." }
        : pass(rule)));
    const drift_findings = ${JSON.stringify(script.materialDrift === true)} && implementation && subject.approved_upstream_digests.length > 0
      ? [{ upstream_digest: subject.approved_upstream_digests[0], drift: "material",
          affected_claim_ids: ["claim-verified-behavior"],
          rationale: "The approved upstream plan no longer matches the implemented reality." }]
      : subject.approved_upstream_digests.map((digest) => ({ upstream_digest: digest, drift: "aligned",
          affected_claim_ids: [], rationale: "No upstream drift." }));
    output = { schema_version: "1", task_id: subject.task_id, phase_instance: subject.phase_instance,
      step: "adjudicate", subject_digest: subject.subject_digest, input_fingerprint: subject.input_fingerprint,
      pinned_constitution_digest: subject.pinned_constitution_digest,
      approved_upstream_digests: subject.approved_upstream_digests,
      source_evidence_set_digest: subject.source_evidence_set_digest,
      rule_findings, drift_findings };
  }
  writeFileSync(argv[argv.indexOf("-o") + 1], JSON.stringify(output) + "\\n");
  process.stdout.write('{"type":"turn.completed"}\\n');
}`);
  chmodSync(join(bin, "codex"), 0o755);
  const saved = { path: process.env.PATH, home: process.env.HOME };
  process.env.PATH = `${bin}:${saved.path ?? ""}`;
  process.env.HOME = stubHome;
  return () => {
    if (saved.path === undefined) delete process.env.PATH; else process.env.PATH = saved.path;
    if (saved.home === undefined) delete process.env.HOME; else process.env.HOME = saved.home;
  };
}

type ClientImplementation = Readonly<{
  outputs: readonly string[];
  sourcePath: string;
  sourceBytes: string;
  notesPath: string;
  notesBytes: string;
  transcriptPath: string;
  transcriptBytes: string;
}>;

/** Writes the client-owned implementation: a tracked source file, the notes, and the raw transcript. */
function writeClientImplementation(
  workspace: TaskWorkspace,
  view: WorkflowViewV1,
  marker: string,
): ClientImplementation {
  const artifact = view.resources.find((resource) => resource.role === "current-artifact");
  const transcript = view.resources.find((resource) => resource.role === "verification-transcript");
  if (artifact === undefined || transcript === undefined) {
    throw new Error("implementation resources unavailable");
  }
  const sourcePath = join(workspace.root, "src", "journey-feature.ts");
  const notesPath = join(workspace.root, artifact.path);
  const transcriptPath = join(workspace.root, transcript.path);
  const sourceBytes = `export const journeyFeature = "${marker}";\n`;
  const notesBytes = `# Phase 1 implementation notes (${marker})

Implemented the verified behavior in \`src/journey-feature.ts\` and ran the phase verification.

## Verification

- \`npx vitest run test/integration/semantic-implementation-completion-journeys.test.ts\`
`;
  const transcriptBytes = `$ npx vitest run --runInBand marker=${marker}

Test Files  1 passed
     Tests  1 passed
`;
  mkdirSync(dirname(sourcePath), { recursive: true });
  mkdirSync(dirname(transcriptPath), { recursive: true });
  writeFileSync(sourcePath, sourceBytes);
  writeFileSync(notesPath, notesBytes);
  writeFileSync(transcriptPath, transcriptBytes);
  return Object.freeze({
    outputs: [artifact.path, "src/journey-feature.ts"],
    sourcePath, sourceBytes, notesPath, notesBytes, transcriptPath, transcriptBytes,
  });
}

function implementationSubmission(
  workspace: TaskWorkspace,
  outputs: readonly string[],
): Extract<ApplySubmissionV1, { readonly kind: "work-result"; readonly outcome: "succeeded" }> {
  return {
    kind: "work-result",
    outcome: "succeeded",
    implementation: {
      base_commit: headAt(workspace),
      outputs: [...outputs],
      restore_targets: [...outputs],
      declared_inputs: [],
    },
  };
}

function clientCommit(workspace: TaskWorkspace, commit: NonNullable<WorkflowViewV1["next_action"]["commit"]>): void {
  execFileSync("git", ["add", "-A", "--", ...commit.paths], { cwd: workspace.root });
  execFileSync("git", [
    "-c", "user.name=ArchFlow Test", "-c", "user.email=test@example.invalid",
    "commit", "-q", "-m", commit.message, "--", ...commit.paths,
  ], { cwd: workspace.root });
}

/** Asserts no server actor touched the client-owned bytes or Git history during an apply. */
function expectClientWorkIntact(
  workspace: TaskWorkspace,
  work: ClientImplementation,
  expectedHead: string,
  expectedReviewCount: number,
): void {
  expect(readFileSync(work.sourcePath, "utf8")).toBe(work.sourceBytes);
  expect(readFileSync(work.notesPath, "utf8")).toBe(work.notesBytes);
  expect(readFileSync(work.transcriptPath, "utf8")).toBe(work.transcriptBytes);
  expect(headAt(workspace)).toBe(expectedHead);
  expect(reviewCountAt(workspace)).toBe(expectedReviewCount);
}

async function reachAuthorizedImplementationCommit(
  workspace: TaskWorkspace,
  h: SemanticJourneyHarness,
  invocation: WorkflowInvocationV1,
  marker: string,
): Promise<Readonly<{ work: ClientImplementation; commit: NonNullable<WorkflowViewV1["next_action"]["commit"]>; reviews: number }>> {
  let view = await h.status(invocation);
  const work = writeClientImplementation(workspace, view, marker);
  view = await applied(h, invocation, view, implementationSubmission(workspace, work.outputs));
  expect(view.next_action.kind).toBe("review");
  view = await applied(h, invocation, view);
  expect(view.findings).toEqual([]);
  view = await applied(h, invocation, view, {
    kind: "gate-summary",
    summary: "The implementation, its notes, and the verification transcript are ready for commit authorization.",
  });
  expect(view.next_action).toMatchObject({ kind: "decide", expected_submission: "decision" });
  view = await applied(h, invocation, view, {
    kind: "decision", choice: "authorize-commit", reason: "The reviewed outputs may be committed exactly as authorized.",
  });
  const commit = view.next_action.commit;
  if (commit === undefined) throw new Error("authorized implementation commit facts unavailable");
  return Object.freeze({ work, commit, reviews: reviewCountAt(workspace) });
}

describe("semantic implementation completion journeys", { timeout: TIMEOUT }, () => {
  it("authorizes the implementation commit, observes the client-created proof, and reports the successor without an offer", async () => {
    const workspace = await createTaskWorkspace({ taskId: "semantic-impl-succession", label: "semantic-impl-succession" });
    workspaces.push(workspace);
    excludeStubArtifacts(workspace);
    restorers.push(installScriptedReviewChild(workspace.root, [[], [], [], []]));
    const h = semanticJourneyHarness(workspace);
    const { invocation, handoff } = await reachImplementationHandoff(workspace, h, { phaseCount: 2 });
    const commitsBeforeWork = commitCountAt(workspace);

    let view = await applied(h, invocation, handoff);
    expect(view.position).toEqual({ kind: "phase-impl", phase: 1 });
    expect(view.next_action).toMatchObject({ kind: "submit-work", expected_submission: "work-result" });
    const reviewsBeforeImplReview = reviewCountAt(workspace);

    const authorized = await reachAuthorizedImplementationCommit(workspace, h, invocation, "succession-round-1");
    const { work, commit } = authorized;
    const reviewsAfterImplReview = authorized.reviews;
    expect(reviewsAfterImplReview).toBe(reviewsBeforeImplReview + 1);

    // Honest commit facts: the exact sorted authorized scope, never invented values.
    expect(commit).toMatchObject({
      message: `ArchFlow: Implement ${workspace.taskId} phase 1`,
      target_ref: gitAt(workspace, "symbolic-ref", "-q", "HEAD"),
      baseline: headAt(workspace),
      requires_human_confirmation: true,
    });
    expect(commit.paths).toEqual([...work.outputs]);

    // No server actor committed, edited, or re-dispatched anything for the authorization.
    expectClientWorkIntact(workspace, work, commit.baseline, reviewsAfterImplReview);
    expect(commitCountAt(workspace)).toBe(commitsBeforeWork);

    // Idempotent observation: repeated read-only status re-derives identical commit facts.
    const rereadOne = await h.status(invocation);
    const rereadTwo = await h.status(invocation);
    expect(rereadOne.next_action.kind).toBe("commit");
    expect(rereadOne.next_action.commit).toEqual(commit);
    expect(rereadTwo.next_action.commit).toEqual(commit);
    expectClientWorkIntact(workspace, work, commit.baseline, reviewsAfterImplReview);

    // The client creates the commit itself, staging exactly the authorized paths.
    clientCommit(workspace, commit);
    expect(gitAt(workspace, "rev-parse", "HEAD^")).toBe(commit.baseline);
    expect(gitAt(workspace, "log", "-1", "--pretty=%B")).toBe(commit.message);

    // One read-only status observes the proof; the finishing invocation gets no offer to apply.
    const observed = await h.status(invocation);
    expect(observed.next_action).toMatchObject({
      kind: "start-next-skill", skill: "archflow-phase-design", skill_args: ["2"],
    });
    expect(observed.next_action.offer).toBeUndefined();
    expect(reviewCountAt(workspace)).toBe(reviewsAfterImplReview);
    expect(readFileSync(work.sourcePath, "utf8")).toBe(work.sourceBytes);
    expect(readFileSync(work.transcriptPath, "utf8")).toBe(work.transcriptBytes);

    // Re-derivation stays idempotent after the commit is observed.
    const observedAgain = await h.status(invocation);
    expect(observedAgain.next_action).toEqual(observed.next_action);
    expect(reviewCountAt(workspace)).toBe(reviewsAfterImplReview);

    // Only the newly invoked successor owns and consumes the hand-off offer.
    const successor = { skill: "archflow-phase-design", phase: 2, intent: "resume" } as const;
    const successorView = await h.status(successor);
    expect(successorView.next_action).toMatchObject({ kind: "start-next-skill", expected_submission: "none" });
    expect(successorView.next_action.offer).toBeDefined();
    const startedSuccessor = await applied(h, successor, successorView);
    expect(startedSuccessor.position).toEqual({ kind: "phase-design", phase: 2 });
    expect(startedSuccessor.next_action.kind).toBe("submit-work");
  });

  it("finishes the task terminally at the planned final phase after the observed client commit", async () => {
    const workspace = await createTaskWorkspace({ taskId: "semantic-impl-terminal", label: "semantic-impl-terminal" });
    workspaces.push(workspace);
    excludeStubArtifacts(workspace);
    restorers.push(installScriptedReviewChild(workspace.root, [[], [], [], []]));
    const h = semanticJourneyHarness(workspace);
    const { invocation, handoff } = await reachImplementationHandoff(workspace, h, { phaseCount: 1 });

    let view = await applied(h, invocation, handoff);
    expect(view.next_action).toMatchObject({ kind: "submit-work", expected_submission: "work-result" });
    const { work, commit, reviews } = await reachAuthorizedImplementationCommit(workspace, h, invocation, "terminal-round-1");
    expect(commit.paths).toEqual([...work.outputs]);
    clientCommit(workspace, commit);

    // The final implementation invocation owns and applies its finish-task offer.
    const observed = await h.status(invocation);
    expect(observed.next_action).toMatchObject({ kind: "finish-task", expected_submission: "none" });
    expect(observed.next_action.offer).toBeDefined();
    const finished = await applied(h, invocation, observed);
    expect(finished.condition).toBe("complete");
    expect(finished.next_action).toMatchObject({ kind: "none" });
    expect(finished.next_action.offer).toBeUndefined();
    expect(reviewCountAt(workspace)).toBe(reviews);
    expect(gitAt(workspace, "rev-parse", "HEAD^")).toBe(commit.baseline);

    // Terminal state is stable under re-reads and offers no further mutation.
    const reread = await h.status(invocation);
    expect(reread.condition).toBe("complete");
    expect(reread.next_action).toMatchObject({ kind: "none" });
    expect(reread.next_action.offer).toBeUndefined();
    const stale = await h.apply(invocation, observed, undefined);
    expect(stale).toMatchObject({ ok: false, error: { retryable: false } });
  });

  it("returns request-changes to a close-only checkpoint that requires the separate revise action before re-editing", async () => {
    const workspace = await createTaskWorkspace({ taskId: "semantic-impl-request-changes", label: "semantic-impl-request-changes" });
    workspaces.push(workspace);
    excludeStubArtifacts(workspace);
    restorers.push(installScriptedReviewChild(workspace.root, [[], [], [], [], []]));
    const h = semanticJourneyHarness(workspace);
    const { invocation, handoff } = await reachImplementationHandoff(workspace, h, { phaseCount: 1 });

    let view = await applied(h, invocation, handoff);
    let work = writeClientImplementation(workspace, view, "request-changes-round-1");
    view = await applied(h, invocation, view, implementationSubmission(workspace, work.outputs));
    view = await applied(h, invocation, view);
    expect(view.findings).toEqual([]);
    view = await applied(h, invocation, view, { kind: "gate-summary", summary: "The first implementation round is ready for commit authorization." });
    const tokens = view.presentation?.options.map((option) => option.token) ?? [];
    expect(tokens).toContain("authorize-commit");
    expect(tokens).toContain("request-changes");
    const reviewsAfterReview = reviewCountAt(workspace);

    view = await applied(h, invocation, view, {
      kind: "decision", choice: "request-changes", reason: "The verification depth is insufficient for this phase.",
    });

    // The revision checkpoint is close-only: no writable resources, a separate revise required.
    expect(view.next_action).toMatchObject({ kind: "revise", expected_submission: "none" });
    expect(view.resources).toEqual([]);
    expectClientWorkIntact(workspace, work, headAt(workspace), reviewsAfterReview);

    // The separate revise application alone re-opens the production write window.
    view = await applied(h, invocation, view);
    expect(view.next_action).toMatchObject({ kind: "submit-work", expected_submission: "work-result" });
    expect(view.resources.length).toBeGreaterThan(0);

    // The client fixes the work, captures a fresh transcript, and resubmits.
    work = writeClientImplementation(workspace, view, "request-changes-round-2");
    const revisionSubmission = implementationSubmission(workspace, work.outputs);
    view = await applied(h, invocation, view, {
      ...revisionSubmission,
      human_revision: { classification: "significant", rationale: "Deepened the verification to answer the requested change." },
    });
    expect(view.next_action.kind).toBe("review");
    view = await applied(h, invocation, view);
    expect(view.findings).toEqual([]);
    view = await applied(h, invocation, view, { kind: "gate-summary", summary: "The revised implementation is ready for commit authorization." });
    expect(view.next_action).toMatchObject({ kind: "decide", expected_submission: "decision" });
    expect(view.presentation?.options.map((option) => option.token)).toContain("authorize-commit");

    view = await applied(h, invocation, view, {
      kind: "decision", choice: "authorize-commit", reason: "The revised outputs may be committed exactly as authorized.",
    });
    const commit = view.next_action.commit;
    if (commit === undefined) throw new Error("authorized implementation commit facts unavailable");
    expect(commit.paths).toEqual([...work.outputs]);
    expect(commit.baseline).toBe(headAt(workspace));
    clientCommit(workspace, commit);
    const observed = await h.status(invocation);
    expect(observed.next_action).toMatchObject({ kind: "finish-task" });
  });

  it("classifies a forged archive cross-binding at the current checkpoint as invalid, not superseded", async () => {
    const workspace = await createTaskWorkspace({ taskId: "semantic-impl-forged-archive", label: "semantic-impl-forged-archive" });
    workspaces.push(workspace);
    excludeStubArtifacts(workspace);
    restorers.push(installScriptedReviewChild(workspace.root, [[], [], [], [], []]));
    const h = semanticJourneyHarness(workspace);
    const { invocation, handoff } = await reachImplementationHandoff(workspace, h, { phaseCount: 1 });

    let view = await applied(h, invocation, handoff);
    const work = writeClientImplementation(workspace, view, "forged-archive-round-1");
    view = await applied(h, invocation, view, implementationSubmission(workspace, work.outputs));
    view = await applied(h, invocation, view);
    view = await applied(h, invocation, view, { kind: "gate-summary", summary: "The implementation round is ready for commit authorization." });
    view = await applied(h, invocation, view, {
      kind: "decision", choice: "request-changes", reason: "The verification depth is insufficient for this phase.",
    });
    expect(view.next_action).toMatchObject({ kind: "revise", expected_submission: "none" });

    // Tamper the archived decision into a parseable pair that no longer cross-authenticates with
    // its request: canonical bytes, self-consistent digest, different subject digest. A superseded
    // archive stays silent (the material-drift journey pins that); a forged one must surface as an
    // invalid revision checkpoint rather than vanishing down the supersession path.
    const state = JSON.parse(readFileSync(workspace.services.authority.state.absolute, "utf8"));
    const gateId = state.last_transition.result_id;
    const decisionPath = join(workspace.services.authority.task_root, "authority", "decisions", gateId, "decision.json");
    const decision = JSON.parse(readFileSync(decisionPath, "utf8"));
    decision.subject_digest = "f".repeat(64);
    writeFileSync(decisionPath, canonicalJsonBytes(decision));

    const blocked = await h.status(invocation);
    expect(blocked.condition).toBe("blocked");
    expect(blocked.next_action.kind).toBe("inspect");
    expect(blocked.next_action.offer).toBeUndefined();
  });

  it("opens the attempts-exhausted gate after the fixed-point budget of blocking-finding remediation rounds", async () => {
    const blocker = [{
      finding_id: "impl-blocking-gap", severity: "blocker", blocking: true,
      summary: "The verified behavior is not observable.", evidence: "The source defines no observable export.",
      suggested_resolution: "Export an observable constant the verifier can assert on.",
    }];
    const workspace = await createTaskWorkspace({ taskId: "semantic-impl-exhausted", label: "semantic-impl-exhausted" });
    workspaces.push(workspace);
    excludeStubArtifacts(workspace);
    restorers.push(installScriptedReviewChild(workspace.root, [[], [], [], blocker, blocker, blocker]));
    const h = semanticJourneyHarness(workspace);
    const { invocation, handoff } = await reachImplementationHandoff(workspace, h, { phaseCount: 1 });

    let view = await applied(h, invocation, handoff);
    // Each accepted blocking finding forces a produce re-entry. Drive the honest loop and pin the
    // empirically observed budget: the gate must open exactly when the attempt ceiling is reached.
    // (Rejecting the finding instead advances straight to the commit-authorization gate — verified
    // separately — so acceptance is the only loop that can exhaust the budget.)
    let rounds = 0;
    let exhaustedBoundary: WorkflowViewV1 | undefined;
    for (rounds = 1; rounds <= 6 && exhaustedBoundary === undefined; rounds += 1) {
      const work = writeClientImplementation(workspace, view, `exhausted-round-${rounds}`);
      view = await applied(h, invocation, view, implementationSubmission(workspace, work.outputs));
      expect(view.next_action.kind).toBe("review");
      view = await applied(h, invocation, view);
      expect(view.next_action).toMatchObject({ kind: "triage", expected_submission: "triage" });
      expect(view.findings?.map((finding) => finding.finding_id)).toEqual(["impl-blocking-gap"]);
      view = await applied(h, invocation, view, { kind: "triage", dispositions: [{
        finding_id: "impl-blocking-gap", disposition: "accepted",
        rationale: "The reviewer identified a material verification gap.",
        revision_intent: "Export an observable constant.",
      }] });
      if (view.next_action.kind === "revise") {
        view = await applied(h, invocation, view);
        expect(view.next_action).toMatchObject({ kind: "submit-work", expected_submission: "work-result" });
      } else {
        expect(view.next_action).toMatchObject({ kind: "decide", expected_submission: "gate-summary" });
        expect(view.detail).toMatch(/attempts-exhausted/u);
        exhaustedBoundary = view;
      }
    }
    rounds -= 1;
    expect(exhaustedBoundary).toBeDefined();
    // The empirically verified attempt budget: the first produce plus two accepted-finding
    // re-entries converge the loop, and the third remediation round reaches the ceiling.
    expect(rounds).toBe(3);
    expect(reviewCountAt(workspace)).toBe(6);
    view = exhaustedBoundary!;
    expect(view.next_action).toMatchObject({ kind: "decide", expected_submission: "gate-summary" });

    // The attempts-exhausted boundary is a human gate with its full option set.
    view = await applied(h, invocation, view, {
      kind: "gate-summary", summary: "The blocking finding survived every remediation round; the loop reached its attempt ceiling.",
    });
    const tokens = view.presentation?.options.map((option) => option.token) ?? [];
    expect(tokens).toContain("try-review-again");
    expect(tokens).toContain("request-changes");
    expect(view.next_action).toMatchObject({ kind: "decide", expected_submission: "decision" });
    const reviewsAtGate = reviewCountAt(workspace);

    // request-changes settles to the same close-only checkpoint as commit-authorization
    // revisions: no writable resources, a separate revise action required before edits.
    view = await applied(h, invocation, view, {
      kind: "decision", choice: "request-changes", reason: "The finding needs a human-directed revision, not another automated round.",
    });
    expect(view.next_action).toMatchObject({ kind: "revise", expected_submission: "none" });
    expect(view.resources).toEqual([]);
    expect(reviewCountAt(workspace)).toBe(reviewsAtGate);

    // The separate revise application alone re-opens the production write window.
    view = await applied(h, invocation, view);
    expect(view.next_action).toMatchObject({ kind: "submit-work", expected_submission: "work-result" });
    expect(view.resources.length).toBeGreaterThan(0);
    expect(reviewCountAt(workspace)).toBe(reviewsAtGate);

    // One-hop simple-classified revision: the client fixes the work, captures a fresh transcript,
    // and resubmits declaring the simple human revision. The retained review is reused for the
    // one hop — no child is re-dispatched — and the boundary returns to the retained triage.
    const revisionWork = writeClientImplementation(workspace, view, "exhausted-simple-revision");
    const reviewsBeforeRevision = reviewCountAt(workspace);
    const simpleSubmission = implementationSubmission(workspace, revisionWork.outputs);
    view = await applied(h, invocation, view, {
      ...simpleSubmission,
      human_revision: { classification: "simple", rationale: "The requested change is a scoped fix to the observable export." },
    });
    expect(view.next_action).toMatchObject({ kind: "triage", expected_submission: "triage" });
    expect(view.findings?.map((finding) => finding.finding_id)).toEqual(["impl-blocking-gap"]);
    expect(reviewCountAt(workspace)).toBe(reviewsBeforeRevision);

    // SOURCE DEFECT (reported, not pinned): the retained accepted finding makes the fixed point
    // demand a re-triage while durable state sits at produce-succeeded, but the fixed pipeline
    // [produce, counter_review, triage] has no produce-succeeded -> triage edge, and the fixed
    // workflow's status projection offers exactly that unreachable `triage` action. Applying it
    // fails with TRANSITION_INVALID {"phase_instance":"phase-impl-1","from":"produce-succeeded",
    // "to":"triage-succeeded"} (the semantic triage executor's running-entry plan only fires from
    // counter_review-succeeded, and a running/triage composition from produce-succeeded is
    // equally illegal). The journey therefore cannot reach the next gate-summary to prove the
    // composer still opens attempts-exhausted after the one-hop simple revision; it stops here.
  });

  it("resolves material upstream drift by moving the task to the earlier planning boundary", async () => {
    const workspace = await createTaskWorkspace({ taskId: "semantic-impl-drift-upstream", label: "semantic-impl-drift-upstream" });
    workspaces.push(workspace);
    excludeStubArtifacts(workspace);
    restorers.push(installScriptedReviewChild(workspace.root, [[], [], [], []], { materialDrift: true }));
    const h = semanticJourneyHarness(workspace);
    const { invocation, handoff } = await reachImplementationHandoff(workspace, h, { phaseCount: 2 });

    let view = await applied(h, invocation, handoff);
    const work = writeClientImplementation(workspace, view, "drift-upstream-round-1");
    view = await applied(h, invocation, view, implementationSubmission(workspace, work.outputs));
    view = await applied(h, invocation, view);
    expect(view.findings).toEqual([]);

    // The drift assessment opens the material-drift gate with both resolution choices.
    view = await applied(h, invocation, view, {
      kind: "gate-summary", summary: "The implementation review reports material drift against an approved upstream plan.",
    });
    const tokens = view.presentation?.options.map((option) => option.token) ?? [];
    expect(tokens).toContain("update-earlier-work");
    expect(tokens).toContain("change-current-work");

    const implementationHead = headAt(workspace);
    view = await applied(h, invocation, view, {
      kind: "decision", choice: "update-earlier-work", reason: "The approved plan, not the implementation, is out of date.",
    });

    // The task restarts at the affected upstream planning boundary; the implementation
    // position and its downstream produce results are superseded, and Git is untouched.
    expect(view.position).toBeDefined();
    expect(["design", "phase-design"]).toContain(view.position!.kind);
    expect(view.position).not.toEqual({ kind: "phase-impl", phase: 1 });
    expect(headAt(workspace)).toBe(implementationHead);

    // The superseded implementation invocation no longer owns any semantic mutation.
    const implView = await h.status(invocation);
    expect(implView.next_action.offer).toBeUndefined();

    // The reopened upstream planning boundary is usable: the owning invocation holds its
    // position at the production write window, not a blocked or inspect projection.
    const upstreamPosition = view.position!;
    const upstreamInvocation = upstreamPosition.kind === "phase-design"
      ? { skill: "archflow-phase-design", phase: upstreamPosition.phase, intent: "resume" } as const
      : { skill: "archflow-design", intent: "resume" } as const;
    const upstreamView = await h.status(upstreamInvocation);
    expect(upstreamView.condition).not.toBe("blocked");
    expect(upstreamView.next_action).toMatchObject({ kind: "submit-work", expected_submission: "work-result" });
    expect(upstreamView.next_action.offer).toBeDefined();

    // One produce apply on the reopened tier: the client rewrites the planning document and
    // submits it as ordinary document work.
    const upstreamArtifact = upstreamView.resources.find((resource) => resource.role === "current-artifact");
    if (upstreamArtifact === undefined) throw new Error("reopened planning resource unavailable");
    writeFileSync(join(workspace.root, upstreamArtifact.path),
      upstreamPosition.kind === "phase-design"
        ? "# Phase 1: Implement the verified behavior\n\n## Goal\n\nBring the approved plan back in line with the implemented reality.\n"
        : "# Design\n\nThe architecture now records the boundary the implementation discovered.\n\n### Phase 1: Implement the verified behavior 1\n\nProduce, review, approve, and commit tier 1.\n\n### Phase 2: Implement the verified behavior 2\n\nProduce, review, approve, and commit tier 2.\n");
    const produced = await applied(h, upstreamInvocation, upstreamView, { kind: "work-result", outcome: "succeeded" });
    expect(produced.next_action.kind).toBe("review");
  });

  it("keeps the earlier plan when material drift chooses to change the current work through the close-only checkpoint", async () => {
    const workspace = await createTaskWorkspace({ taskId: "semantic-impl-drift-current", label: "semantic-impl-drift-current" });
    workspaces.push(workspace);
    excludeStubArtifacts(workspace);
    restorers.push(installScriptedReviewChild(workspace.root, [[], [], [], []], { materialDrift: true }));
    const h = semanticJourneyHarness(workspace);
    const { invocation, handoff } = await reachImplementationHandoff(workspace, h, { phaseCount: 1 });

    let view = await applied(h, invocation, handoff);
    const work = writeClientImplementation(workspace, view, "drift-current-round-1");
    view = await applied(h, invocation, view, implementationSubmission(workspace, work.outputs));
    view = await applied(h, invocation, view);
    expect(view.findings).toEqual([]);
    view = await applied(h, invocation, view, {
      kind: "gate-summary", summary: "The implementation review reports material drift against an approved upstream plan.",
    });
    const reviewsAfterReview = reviewCountAt(workspace);

    view = await applied(h, invocation, view, {
      kind: "decision", choice: "change-current-work", reason: "The current implementation must match the approved plan.",
    });

    // Like request-changes: the checkpoint is close-only and requires the separate revise.
    expect(view.position).toEqual({ kind: "phase-impl", phase: 1 });
    expect(view.next_action).toMatchObject({ kind: "revise", expected_submission: "none" });
    expect(view.resources).toEqual([]);
    expectClientWorkIntact(workspace, work, headAt(workspace), reviewsAfterReview);

    view = await applied(h, invocation, view);
    expect(view.next_action).toMatchObject({ kind: "submit-work", expected_submission: "work-result" });
    expect(view.resources.length).toBeGreaterThan(0);
  });

  it("derives a separate waiver decision from a waiver-requested constitution choice, and a denial grants nothing", async () => {
    const workspace = await createTaskWorkspace({ taskId: "semantic-impl-constitution", label: "semantic-impl-constitution" });
    workspaces.push(workspace);
    excludeStubArtifacts(workspace);
    restorers.push(installScriptedReviewChild(workspace.root, [[], [], [], []], { failingRule: true }));
    const h = semanticJourneyHarness(workspace);
    const { invocation, handoff } = await reachImplementationHandoff(workspace, h, { phaseCount: 1 });

    let view = await applied(h, invocation, handoff);
    const work = writeClientImplementation(workspace, view, "constitution-round-1");
    const headBeforeGate = headAt(workspace);
    view = await applied(h, invocation, view, implementationSubmission(workspace, work.outputs));
    view = await applied(h, invocation, view);
    expect(view.findings).toEqual([]);

    // The failed constitution rule surfaces as the constitution-review human gate.
    view = await applied(h, invocation, view, {
      kind: "gate-summary", summary: "The constitution review failed one rule for this implementation subject.",
    });
    const tokens = view.presentation?.options.map((option) => option.token) ?? [];
    expect(tokens).toContain("approve");
    expect(tokens).toContain("request-changes");
    const waiverToken = tokens.find((token) => token.startsWith("request-exception-"));
    expect(waiverToken).toBeDefined();

    // waiver-requested is a redirect, not an approval: it returns the separate no-submission open-waiver.
    view = await applied(h, invocation, view, {
      kind: "decision", choice: waiverToken!, reason: "Request a narrowly scoped exception for the failed rule.",
      option_rationale: "The rule's trigger does not apply to this phase's verified behavior.",
    });
    expect(view.next_action).toMatchObject({ kind: "open-waiver", expected_submission: "none" });
    expect(view.next_action.offer).toBeDefined();

    view = await applied(h, invocation, view);
    expect(view.next_action).toMatchObject({ kind: "decide", expected_submission: "decision" });
    const waiverTokens = view.presentation?.options.map((option) => option.token) ?? [];
    expect(waiverTokens).toContain("grant-exception");
    expect(waiverTokens).toContain("deny-exception");

    // A denied waiver grants nothing: the task stays at the constitution gate boundary.
    view = await applied(h, invocation, view, {
      kind: "decision", choice: "deny-exception", reason: "The policy requirement stays in force.",
    });
    expect(view.next_action).toMatchObject({ kind: "decide", expected_submission: "gate-summary" });
    expect(view.presentation).toBeUndefined();
    const afterDenial = await h.status(invocation);
    expect(afterDenial.next_action.offer).toBeDefined();
    expect(headAt(workspace)).toBe(headBeforeGate);
    expect(readFileSync(work.sourcePath, "utf8")).toBe(work.sourceBytes);
  });

  it("reopens earlier planning work from an active implementation position and restores a fresh hand-off", async () => {
    const workspace = await createTaskWorkspace({ taskId: "semantic-impl-reopen", label: "semantic-impl-reopen" });
    workspaces.push(workspace);
    excludeStubArtifacts(workspace);
    restorers.push(installScriptedReviewChild(workspace.root, [[], [], [], [], [], []]));
    const h = semanticJourneyHarness(workspace);
    const { invocation, handoff } = await reachImplementationHandoff(workspace, h, { phaseCount: 2 });

    let view = await applied(h, invocation, handoff);
    expect(view.position).toEqual({ kind: "phase-impl", phase: 1 });
    const work = writeClientImplementation(workspace, view, "reopen-round-1");
    const reopenHead = headAt(workspace);

    // Each earlier planning boundary offers a legal reopen while the position is an implementation.
    const reopenInvocations = [
      { skill: "archflow-prd", intent: "reopen" } as const,
      { skill: "archflow-design", intent: "reopen" } as const,
      { skill: "archflow-phase-design", phase: 1, intent: "reopen" } as const,
    ];
    for (const reopenInvocation of reopenInvocations) {
      const offered = await h.status(reopenInvocation);
      expect(offered.next_action).toMatchObject({ kind: "reopen", expected_submission: "reopening-request" });
      expect(offered.next_action.offer).toBeDefined();
      expect(offered.next_action.reopen?.target).toBeDefined();
      expect(offered.next_action.reopen?.requires_fresh_review_and_approval).toBe(true);
    }

    // A phase implementation is never a reopen target: the intent does not even parse.
    expect(() => parseWorkflowInvocationV1({ skill: "archflow-phase-impl", phase: 1, intent: "reopen" })).toThrow();

    // A reopen-shaped submission is not accepted at the implementation tier's own action.
    const reopenShaped = await h.apply(invocation, view, { kind: "reopening-request", request: "not at this tier" });
    expect(reopenShaped).toMatchObject({ ok: false, error: { retryable: false } });

    // Apply the design reopen: the task moves to that planning boundary, worktree bytes preserved.
    const designReopen = { skill: "archflow-design", intent: "reopen" } as const;
    const offered = await h.status(designReopen);
    view = await applied(h, designReopen, offered, {
      kind: "reopening-request", request: "The architecture must record the second planned phase's boundary.",
    });
    expect(view.position).toEqual({ kind: "design" });
    expect(headAt(workspace)).toBe(reopenHead);
    expect(readFileSync(work.sourcePath, "utf8")).toBe(work.sourceBytes);

    // The superseded implementation invocation owns nothing until the reopened tiers approve again.
    const superseded = await h.status(invocation);
    expect(superseded.next_action.offer).toBeUndefined();

    // Walk the reopened design tier back through approval and its client commit.
    const design = { skill: "archflow-design", intent: "resume" } as const;
    view = await h.status(design);
    expect(view.position).toEqual({ kind: "design" });
    expect(view.next_action).toMatchObject({ kind: "submit-work", expected_submission: "work-result" });
    writeFileSync(join(workspace.services.authority.task_root, "design.md"),
      "# Design\n\nThe semantic journey preserves client-owned documents, code, and Git operations.\n\n### Phase 1: Implement the verified behavior 1\n\nProduce, review, approve, and commit tier 1.\n\n### Phase 2: Implement the verified behavior 2\n\nProduce, review, approve, and commit tier 2.\n");
    view = await applied(h, design, view, { kind: "work-result", outcome: "succeeded" });
    view = await applied(h, design, view);
    view = await applied(h, design, view, { kind: "gate-summary", summary: "The reopened architecture is ready for approval." });
    view = await applied(h, design, view, { kind: "decision", choice: "approve", reason: "The reopened design is implementable." });
    expect(view.next_action.kind).toBe("commit");
    clientCommit(workspace, view.next_action.commit!);

    // Then the phase-design tier, again through review and its client commit.
    const phaseDesign = { skill: "archflow-phase-design", phase: 1, intent: "resume" } as const;
    view = await h.status(phaseDesign);
    expect(view.next_action.offer).toBeDefined();
    view = await applied(h, phaseDesign, view);
    expect(view.next_action).toMatchObject({ kind: "submit-work", expected_submission: "work-result" });
    const phaseDesignResource = view.resources.find((resource) => resource.role === "current-artifact");
    if (phaseDesignResource === undefined) throw new Error("phase-design resource unavailable");
    writeFileSync(join(workspace.root, phaseDesignResource.path),
      "# Phase 1: Implement the verified behavior\n\n## Goal\n\nReach the implementation hand-off again after the reopened design.\n");
    view = await applied(h, phaseDesign, view, { kind: "work-result", outcome: "succeeded" });
    view = await applied(h, phaseDesign, view);
    view = await applied(h, phaseDesign, view, { kind: "gate-summary", summary: "The phase design is ready for approval again." });
    view = await applied(h, phaseDesign, view, { kind: "decision", choice: "approve", reason: "The phase scope is accurate." });
    expect(view.next_action.kind).toBe("commit");
    clientCommit(workspace, view.next_action.commit!);

    // A fresh implementation resume again receives its hand-off through the normal loop.
    const freshHandoff = await h.status(invocation);
    expect(freshHandoff.next_action).toMatchObject({
      kind: "start-next-skill", skill: "archflow-phase-impl", skill_args: ["1"], expected_submission: "none",
    });
    expect(freshHandoff.next_action.offer).toBeDefined();
    const restarted = await applied(h, invocation, freshHandoff);
    expect(restarted.position).toEqual({ kind: "phase-impl", phase: 1 });
    expect(restarted.next_action).toMatchObject({ kind: "submit-work", expected_submission: "work-result" });
  });
});

import { execFileSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import type { WorkflowViewV1 } from "../../src/contracts/semantic-workflow.js";
import {
  installSemanticReviewStub,
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

const gitHead = (workspace: TaskWorkspace): string =>
  execFileSync("git", ["rev-parse", "HEAD"], { cwd: workspace.root, encoding: "utf8" }).trim();

const reviewCount = (workspace: TaskWorkspace): string =>
  readFileSync(join(workspace.root, "semantic-review-count"), "utf8");

const readTaskState = (workspace: TaskWorkspace): Record<string, unknown> =>
  JSON.parse(readFileSync(join(workspace.services.authority.task_root, "state.json"), "utf8")) as Record<string, unknown>;

/** Makes the stubbed reviewer fail its dispatch while keeping its preflight answers intact. */
function breakSemanticReviewDispatch(root: string): () => void {
  const stub = join(root, "semantic-stub-bin", "codex");
  const original = readFileSync(stub, "utf8");
  writeFileSync(stub, `#!/usr/bin/env node
const argv = process.argv.slice(2);
if (argv.length === 1 && argv[0] === "--version") process.stdout.write("codex-cli 0.146.0\\n");
else if (argv[0] === "login" && argv[1] === "status") process.stdout.write("Logged in using ChatGPT\\n");
else { process.stderr.write("the reviewer could not complete this dispatch\\n"); process.exit(1); }
`);
  chmodSync(stub, 0o755);
  return () => { writeFileSync(stub, original); chmodSync(stub, 0o755); };
}

const SOURCE_PATH = "src/example-behavior.ts";
const SOURCE_BYTES = `export function exampleBehavior(value: number): number {
  return value + 1;
}
`;
const SOURCE_BYTES_REVISED = `export function exampleBehavior(value: number): number {
  if (!Number.isFinite(value)) throw new TypeError("value must be finite");
  return value + 1;
}
`;
const IMPLEMENTATION_NOTES = `# Implementation notes

## What was implemented

- \`src/example-behavior.ts\`: the verified example behavior.

## Verification

- \`npx vitest run test/integration/semantic-implementation-journeys.test.ts\`
`;
const TRANSCRIPT_BYTES = `$ npx vitest run test/integration/semantic-implementation-journeys.test.ts

Test Files  1 passed (1)
     Tests  1 passed (1)
`;
const TRANSCRIPT_BYTES_FRESH = `$ npx vitest run test/integration/semantic-implementation-journeys.test.ts

Test Files  1 passed (1)
     Tests  2 passed (2)
`;
const FINDING = {
  finding_id: "example-behavior-gap",
  severity: "major",
  blocking: false,
  summary: "The implemented behavior accepts input its design does not define.",
  evidence: "src/example-behavior.ts returns a result for non-finite input without any documented rule.",
  suggested_resolution: "Reject non-finite input explicitly and record a fresh verification transcript.",
} as const;

/** Performs the client work the migrated implementation skill directs between semantic calls. */
function writeClientImplementationWork(
  workspace: TaskWorkspace,
  view: WorkflowViewV1,
  bytes: Readonly<{ source: string; notes: string; transcript: string }>,
): Readonly<{
  sourceAbsolute: string;
  notesAbsolute: string;
  transcriptAbsolute: string;
  outputs: readonly string[];
}> {
  const artifact = view.resources.find((resource) => resource.role === "current-artifact");
  const transcript = view.resources.find((resource) => resource.role === "verification-transcript");
  if (artifact === undefined || transcript === undefined) throw new Error("implementation resources unavailable");
  const sourceAbsolute = join(workspace.root, SOURCE_PATH);
  mkdirSync(dirname(sourceAbsolute), { recursive: true });
  writeFileSync(sourceAbsolute, bytes.source);
  const notesAbsolute = join(workspace.root, artifact.path);
  mkdirSync(dirname(notesAbsolute), { recursive: true });
  writeFileSync(notesAbsolute, bytes.notes);
  const transcriptAbsolute = join(workspace.root, transcript.path);
  mkdirSync(dirname(transcriptAbsolute), { recursive: true });
  writeFileSync(transcriptAbsolute, bytes.transcript);
  return { sourceAbsolute, notesAbsolute, transcriptAbsolute, outputs: [artifact.path, SOURCE_PATH].sort() };
}

function implementationSubmission(workspace: TaskWorkspace, outputs: readonly string[]) {
  return {
    kind: "work-result",
    outcome: "succeeded",
    implementation: {
      base_commit: gitHead(workspace),
      outputs: [...outputs],
      restore_targets: [...outputs],
      declared_inputs: [],
    },
  } as const;
}

async function consumeImplementationHandoff(
  workspace: TaskWorkspace,
  h: SemanticJourneyHarness,
): Promise<Readonly<{ invocation: { skill: "archflow-phase-impl"; phase: number; intent: "resume" }; view: WorkflowViewV1 }>> {
  const { invocation, handoff } = await reachImplementationHandoff(workspace, h, { phaseCount: 1 });
  const started = await h.apply(invocation, handoff);
  expect(started.ok, JSON.stringify(started)).toBe(true);
  if (!started.ok) throw new Error("implementation hand-off could not be consumed");
  expect(started.value.position).toEqual({ kind: "phase-impl", phase: 1 });
  expect(started.value.next_action).toMatchObject({ kind: "submit-work", expected_submission: "work-result" });
  return { invocation, view: started.value };
}

describe("semantic implementation journeys", { timeout: TIMEOUT }, () => {
  it("takes an implementation from its consumed hand-off through client work, one declared submission, review, and the gate boundary", async () => {
    const workspace = await createTaskWorkspace({ taskId: "semantic-impl-clean", label: "semantic-impl-clean" });
    workspaces.push(workspace);
    restorers.push(installSemanticReviewStub(workspace.root, [[]]));
    const h = semanticJourneyHarness(workspace);
    const { invocation, view } = await consumeImplementationHandoff(workspace, h);

    const work = writeClientImplementationWork(workspace, view, {
      source: SOURCE_BYTES, notes: IMPLEMENTATION_NOTES, transcript: TRANSCRIPT_BYTES,
    });
    const baseline = gitHead(workspace);

    const submitted = await h.apply(invocation, view, implementationSubmission(workspace, work.outputs));
    expect(submitted.ok, JSON.stringify(submitted)).toBe(true);
    if (!submitted.ok) return;
    expect(submitted.value.next_action.kind).toBe("review");
    expect(readFileSync(work.sourceAbsolute, "utf8")).toBe(SOURCE_BYTES);
    expect(readFileSync(work.notesAbsolute, "utf8")).toBe(IMPLEMENTATION_NOTES);
    expect(readFileSync(work.transcriptAbsolute, "utf8")).toBe(TRANSCRIPT_BYTES);
    expect(gitHead(workspace)).toBe(baseline);

    const reviewed = await h.apply(invocation, submitted.value);
    expect(reviewed.ok, JSON.stringify(reviewed)).toBe(true);
    if (!reviewed.ok) return;
    expect(reviewed.value.findings).toEqual([]);
    expect(reviewed.value.next_action).toMatchObject({ kind: "decide", expected_submission: "gate-summary" });
    expect(readFileSync(work.sourceAbsolute, "utf8")).toBe(SOURCE_BYTES);
    expect(readFileSync(work.notesAbsolute, "utf8")).toBe(IMPLEMENTATION_NOTES);
    expect(readFileSync(work.transcriptAbsolute, "utf8")).toBe(TRANSCRIPT_BYTES);
    expect(gitHead(workspace)).toBe(baseline);
    expect(reviewCount(workspace)).toBe("4");
  });

  it("refuses a facts-free implementation submission and implementation facts at a document position without mutation", async () => {
    const workspace = await createTaskWorkspace({ taskId: "semantic-impl-shape", label: "semantic-impl-shape" });
    workspaces.push(workspace);
    restorers.push(installSemanticReviewStub(workspace.root, [[]]));
    const h = semanticJourneyHarness(workspace);
    const { invocation, view } = await consumeImplementationHandoff(workspace, h);
    const head = gitHead(workspace);

    const factsFree = await h.apply(invocation, view, { kind: "work-result", outcome: "succeeded" });
    expect(factsFree).toMatchObject({ ok: false, error: { code: "SEMANTIC_SUBMISSION_MISMATCH", retryable: false } });
    if (factsFree.ok) return;
    expect(factsFree.view?.next_action).toMatchObject({ kind: "submit-work", expected_submission: "work-result" });
    expect(gitHead(workspace)).toBe(head);
    expect(reviewCount(workspace)).toBe("3");

    const document = await createTaskWorkspace({ taskId: "semantic-impl-shape-doc", label: "semantic-impl-shape-doc" });
    workspaces.push(document);
    restorers.push(installSemanticReviewStub(document.root, [[]]));
    const documentHarness = semanticJourneyHarness(document);
    const prd = { skill: "archflow-prd", intent: "resume" } as const;
    const prdPath = join(document.services.authority.task_root, "prd.md");
    writeFileSync(join(document.services.authority.task_root, "ask.md"), "Describe a small implementation journey.\n");
    writeFileSync(prdPath, "# Implementation journey\n\nThe client authors the requirements.\n");
    const documentHead = gitHead(document);
    const offered = await documentHarness.status(prd);
    expect(offered.next_action).toMatchObject({ kind: "submit-work", expected_submission: "work-result" });

    const carryingFacts = await documentHarness.apply(prd, offered, {
      kind: "work-result", outcome: "succeeded",
      implementation: {
        base_commit: documentHead, outputs: [SOURCE_PATH], restore_targets: [SOURCE_PATH], declared_inputs: [],
      },
    });
    expect(carryingFacts).toMatchObject({ ok: false, error: { code: "SEMANTIC_SUBMISSION_MISMATCH", retryable: false } });
    if (carryingFacts.ok) return;
    expect(carryingFacts.view?.next_action).toMatchObject({ kind: "submit-work", expected_submission: "work-result" });
    expect(readFileSync(prdPath, "utf8")).toBe("# Implementation journey\n\nThe client authors the requirements.\n");
    expect(gitHead(document)).toBe(documentHead);
    expect(existsSync(join(document.root, "semantic-review-count"))).toBe(false);
  });

  it("records a failed implementation submission and offers a fresh bounded begin boundary", async () => {
    const workspace = await createTaskWorkspace({ taskId: "semantic-impl-failed", label: "semantic-impl-failed" });
    workspaces.push(workspace);
    restorers.push(installSemanticReviewStub(workspace.root, [[]]));
    const h = semanticJourneyHarness(workspace);
    const { invocation, view } = await consumeImplementationHandoff(workspace, h);
    const head = gitHead(workspace);

    const failed = await h.apply(invocation, view, {
      kind: "work-result", outcome: "failed", reason: "the verification run could not complete",
    });
    expect(failed.ok, JSON.stringify(failed)).toBe(true);
    if (!failed.ok) return;
    expect(failed.value.position).toEqual({ kind: "phase-impl", phase: 1 });
    expect(failed.value.condition).toBe("ready");
    expect(failed.value.next_action).toMatchObject({ kind: "begin-work", expected_submission: "none" });
    expect(gitHead(workspace)).toBe(head);
    expect(reviewCount(workspace)).toBe("3");

    const resumed = await h.apply(invocation, failed.value);
    expect(resumed.ok, JSON.stringify(resumed)).toBe(true);
    if (!resumed.ok) return;
    expect(resumed.value.next_action).toMatchObject({ kind: "submit-work", expected_submission: "work-result" });
    expect(gitHead(workspace)).toBe(head);
    expect(reviewCount(workspace)).toBe("3");
  });

  it("returns an implementation finding for triage and requires the separate revise action before remediation bytes are accepted", async () => {
    const workspace = await createTaskWorkspace({ taskId: "semantic-impl-remediation", label: "semantic-impl-remediation" });
    workspaces.push(workspace);
    restorers.push(installSemanticReviewStub(workspace.root, [[], [], [], [FINDING], []]));
    const h = semanticJourneyHarness(workspace);
    const { invocation, view } = await consumeImplementationHandoff(workspace, h);
    const work = writeClientImplementationWork(workspace, view, {
      source: SOURCE_BYTES, notes: IMPLEMENTATION_NOTES, transcript: TRANSCRIPT_BYTES,
    });
    const baseline = gitHead(workspace);

    const submitted = await h.apply(invocation, view, implementationSubmission(workspace, work.outputs));
    expect(submitted.ok, JSON.stringify(submitted)).toBe(true);
    if (!submitted.ok) return;
    expect(submitted.value.next_action.kind).toBe("review");

    const reviewed = await h.apply(invocation, submitted.value);
    expect(reviewed.ok, JSON.stringify(reviewed)).toBe(true);
    if (!reviewed.ok) return;
    expect(reviewed.value.next_action).toMatchObject({ kind: "triage", expected_submission: "triage" });
    expect(reviewed.value.findings?.map((finding) => finding.finding_id)).toEqual([FINDING.finding_id]);
    expect(readFileSync(work.sourceAbsolute, "utf8")).toBe(SOURCE_BYTES);
    expect(gitHead(workspace)).toBe(baseline);

    const triaged = await h.apply(invocation, reviewed.value, { kind: "triage", dispositions: [{
      finding_id: FINDING.finding_id,
      disposition: "accepted",
      rationale: "The reviewer identified a real behavioral gap in the implemented function.",
      revision_intent: "Reject non-finite input explicitly and re-verify with a fresh transcript.",
    }] });
    expect(triaged.ok, JSON.stringify(triaged)).toBe(true);
    if (!triaged.ok) return;
    expect(triaged.value.next_action).toMatchObject({ kind: "revise", expected_submission: "none" });
    expect(readFileSync(work.sourceAbsolute, "utf8")).toBe(SOURCE_BYTES);
    expect(readFileSync(work.transcriptAbsolute, "utf8")).toBe(TRANSCRIPT_BYTES);
    expect(gitHead(workspace)).toBe(baseline);

    const revised = await h.apply(invocation, triaged.value);
    expect(revised.ok, JSON.stringify(revised)).toBe(true);
    if (!revised.ok) return;
    expect(revised.value.next_action).toMatchObject({ kind: "submit-work", expected_submission: "work-result" });

    // The write window is open only now: the client fixes the code and records a fresh transcript.
    writeFileSync(work.sourceAbsolute, SOURCE_BYTES_REVISED);
    writeFileSync(work.transcriptAbsolute, TRANSCRIPT_BYTES_FRESH);
    const resubmitted = await h.apply(invocation, revised.value, implementationSubmission(workspace, work.outputs));
    expect(resubmitted.ok, JSON.stringify(resubmitted)).toBe(true);
    if (!resubmitted.ok) return;
    expect(resubmitted.value.next_action.kind).toBe("review");

    const reReviewed = await h.apply(invocation, resubmitted.value);
    expect(reReviewed.ok, JSON.stringify(reReviewed)).toBe(true);
    if (!reReviewed.ok) return;
    expect(reReviewed.value.findings).toEqual([]);
    expect(reReviewed.value.next_action).toMatchObject({ kind: "decide", expected_submission: "gate-summary" });
    expect(readFileSync(work.sourceAbsolute, "utf8")).toBe(SOURCE_BYTES_REVISED);
    expect(readFileSync(work.notesAbsolute, "utf8")).toBe(IMPLEMENTATION_NOTES);
    expect(readFileSync(work.transcriptAbsolute, "utf8")).toBe(TRANSCRIPT_BYTES_FRESH);
    expect(gitHead(workspace)).toBe(baseline);
    expect(reviewCount(workspace)).toBe("5");
  });

  it("fails forged, cross-repository, wrong-phase, and consumed offers at the implementation tier without mutation", async () => {
    const first = await createTaskWorkspace({ taskId: "semantic-impl-offers", label: "semantic-impl-offers-a" });
    const second = await createTaskWorkspace({ taskId: "semantic-impl-offers", label: "semantic-impl-offers-b" });
    workspaces.push(first, second);
    restorers.push(installSemanticReviewStub(first.root, [[]]));
    const firstHarness = semanticJourneyHarness(first);
    const secondHarness = semanticJourneyHarness(second);
    const { invocation, view } = await consumeImplementationHandoff(first, firstHarness);
    const head = gitHead(first);

    const forged = {
      ...structuredClone(view),
      next_action: { ...view.next_action, offer: `af1_${"f".repeat(64)}` },
    };
    const forgedResult = await firstHarness.apply(invocation, forged, {
      kind: "work-result", outcome: "failed", reason: "exercise refusal",
    });
    expect(forgedResult).toMatchObject({ ok: false, error: { retryable: false } });

    const crossRepository = await secondHarness.apply(invocation, view, {
      kind: "work-result", outcome: "failed", reason: "wrong repository",
    });
    expect(crossRepository).toMatchObject({ ok: false, error: { retryable: false } });

    const wrongPhase = await firstHarness.apply(
      { skill: "archflow-phase-impl", phase: 2, intent: "resume" }, view,
      { kind: "work-result", outcome: "failed", reason: "wrong phase" },
    );
    expect(wrongPhase).toMatchObject({ ok: false, error: { retryable: false } });

    expect(gitHead(first)).toBe(head);
    expect(reviewCount(first)).toBe("3");

    const consumed = await firstHarness.apply(invocation, view, {
      kind: "work-result", outcome: "failed", reason: "consume the offered submission boundary",
    });
    expect(consumed.ok, JSON.stringify(consumed)).toBe(true);
    // Reusing the consumed offer fails closed. (With a submission attached, the submission-shape
    // check fires first, so the clean stale probe carries no submission.)
    const stale = await firstHarness.apply(invocation, view);
    expect(stale).toMatchObject({ ok: false, error: { code: "SEMANTIC_OFFER_STALE", retryable: false } });
    expect(gitHead(first)).toBe(head);
    expect(reviewCount(first)).toBe("3");
  });

  it("re-derives identical boundary views from read-only status when the run is interrupted between actions", async () => {
    const workspace = await createTaskWorkspace({ taskId: "semantic-impl-resume", label: "semantic-impl-resume" });
    workspaces.push(workspace);
    restorers.push(installSemanticReviewStub(workspace.root, [[], [], [], [FINDING], []]));
    const h = semanticJourneyHarness(workspace);
    const { invocation, view } = await consumeImplementationHandoff(workspace, h);
    const work = writeClientImplementationWork(workspace, view, {
      source: SOURCE_BYTES, notes: IMPLEMENTATION_NOTES, transcript: TRANSCRIPT_BYTES,
    });

    const submitBoundaryA = await h.status(invocation);
    const submitBoundaryB = await h.status(invocation);
    expect(submitBoundaryB).toEqual(submitBoundaryA);
    expect(submitBoundaryA.next_action.offer).toBeDefined();

    const submitted = await h.apply(invocation, view, implementationSubmission(workspace, work.outputs));
    expect(submitted.ok, JSON.stringify(submitted)).toBe(true);
    if (!submitted.ok) return;
    expect(submitted.value.next_action.kind).toBe("review");
    // Interrupted between submitting the work and running the review: the same offer re-derives.
    const reviewBoundary = await h.status(invocation);
    expect(reviewBoundary).toEqual(submitted.value);
    expect(reviewBoundary.next_action.offer).toBe(submitted.value.next_action.offer);

    const reviewed = await h.apply(invocation, submitted.value);
    expect(reviewed.ok, JSON.stringify(reviewed)).toBe(true);
    if (!reviewed.ok) return;
    expect(reviewed.value.next_action).toMatchObject({ kind: "triage", expected_submission: "triage" });
    const triageBoundaryA = await h.status(invocation);
    const triageBoundaryB = await h.status(invocation);
    expect(triageBoundaryB).toEqual(triageBoundaryA);
    expect(triageBoundaryB).toEqual(reviewed.value);
  });

  it("resumes a mid-review position after a human gate decision overwrote the review entry transition", async () => {
    const workspace = await createTaskWorkspace({ taskId: "semantic-impl-gate-interloper", label: "semantic-impl-gate-interloper" });
    workspaces.push(workspace);
    restorers.push(installSemanticReviewStub(workspace.root, [[]]));
    const h = semanticJourneyHarness(workspace);
    const { invocation, view } = await consumeImplementationHandoff(workspace, h);
    const work = writeClientImplementationWork(workspace, view, {
      source: SOURCE_BYTES, notes: IMPLEMENTATION_NOTES, transcript: TRANSCRIPT_BYTES,
    });

    const submitted = await h.apply(invocation, view, implementationSubmission(workspace, work.outputs));
    expect(submitted.ok, JSON.stringify(submitted)).toBe(true);
    if (!submitted.ok) return;
    expect(submitted.value.next_action.kind).toBe("review");

    // The review entry boundary commits, then the dispatch fails: the durable position stays at
    // counter_review/running with review-enter as its last transition.
    const failingReviewer = breakSemanticReviewDispatch(workspace.root);
    const failed = await h.apply(invocation, submitted.value);
    expect(failed.ok).toBe(false);
    failingReviewer();
    expect(readTaskState(workspace)).toMatchObject({ step: "counter_review", status: "running" });

    // A human decision may legally land at that position — here the baseline adoption opened by
    // post-produce drift — and it overwrites the single last_transition slot with its own gate
    // transition. That must not strand the review.
    writeFileSync(work.sourceAbsolute, SOURCE_BYTES_REVISED);
    const drifted = await h.status(invocation);
    expect(drifted.next_action).toMatchObject({ kind: "decide", expected_submission: "gate-summary" });
    const opened = await h.apply(invocation, drifted, { kind: "gate-summary", summary: "The drifted source should stay as the new baseline." });
    expect(opened.ok, JSON.stringify(opened)).toBe(true);
    if (!opened.ok) return;
    const adopted = await h.apply(invocation, opened.value, {
      kind: "decision", choice: "keep-current-versions", reason: "The current bytes are the reviewed ones.",
    });
    expect(adopted.ok, JSON.stringify(adopted)).toBe(true);
    if (!adopted.ok) return;
    expect(readTaskState(workspace)).toMatchObject({
      step: "counter_review", status: "running", last_transition: { tool: "archflow_gate", operation: "gate" },
    });

    // The review resumes and dispatches a real counter-review rather than failing forever.
    const resumed = await h.status(invocation);
    expect(resumed.next_action.kind).toBe("review");
    const dispatchesBefore = Number(reviewCount(workspace));
    const reviewed = await h.apply(invocation, resumed);
    expect(reviewed.ok, JSON.stringify(reviewed)).toBe(true);
    if (!reviewed.ok) return;
    expect(reviewed.value.findings).toEqual([]);
    expect(reviewed.value.next_action).toMatchObject({ kind: "decide", expected_submission: "gate-summary" });
    expect(Number(reviewCount(workspace))).toBe(dispatchesBefore + 1);
  });

  it("recovers an unrestorable missing projection by re-declaring the deletion in a fresh produce", async () => {
    const workspace = await createTaskWorkspace({ taskId: "semantic-impl-unrestorable", label: "semantic-impl-unrestorable" });
    workspaces.push(workspace);
    restorers.push(installSemanticReviewStub(workspace.root, [[]]));
    const h = semanticJourneyHarness(workspace);
    const { invocation, view } = await consumeImplementationHandoff(workspace, h);
    const work = writeClientImplementationWork(workspace, view, {
      source: SOURCE_BYTES, notes: IMPLEMENTATION_NOTES, transcript: TRANSCRIPT_BYTES,
    });
    // A declared deletion needs the file present in the produce base commit, so the client
    // commits the source before the first terminal produce — as an earlier phase would have.
    execFileSync("git", ["add", "--", SOURCE_PATH], { cwd: workspace.root });
    execFileSync("git", ["-c", "user.name=ArchFlow Test", "-c", "user.email=test@example.invalid",
      "commit", "-q", "-m", "Commit the reviewed source for the journey", `--`, SOURCE_PATH], { cwd: workspace.root });

    const submitted = await h.apply(invocation, view, implementationSubmission(workspace, work.outputs));
    expect(submitted.ok, JSON.stringify(submitted)).toBe(true);
    if (!submitted.ok) return;

    // Post-produce drift opens the baseline adoption decision; the human keeps current bytes,
    // which records digests only — the exact shape that later leaves a deletion unrestorable.
    writeFileSync(work.sourceAbsolute, SOURCE_BYTES_REVISED);
    const drifted = await h.status(invocation);
    expect(drifted.next_action).toMatchObject({ kind: "decide", expected_submission: "gate-summary" });
    const opened = await h.apply(invocation, drifted, { kind: "gate-summary", summary: "The drifted source should stay as the new baseline." });
    expect(opened.ok, JSON.stringify(opened)).toBe(true);
    if (!opened.ok) return;
    const adopted = await h.apply(invocation, opened.value, {
      kind: "decision", choice: "keep-current-versions", reason: "The current bytes are the reviewed ones.",
    });
    expect(adopted.ok, JSON.stringify(adopted)).toBe(true);

    // The adopted file is then deleted: restore is impossible and adoption needs current bytes.
    // The workflow must offer the produce re-entry that re-declares the deletion, not block.
    rmSync(work.sourceAbsolute);
    const wedged = await h.status(invocation);
    expect(wedged.condition).not.toBe("blocked");
    expect(wedged.next_action).toMatchObject({ kind: "begin-work" });

    const reopened = await h.apply(invocation, wedged);
    expect(reopened.ok, JSON.stringify(reopened)).toBe(true);
    if (!reopened.ok) return;
    expect(reopened.value.next_action).toMatchObject({ kind: "submit-work", expected_submission: "work-result" });

    const redeclared = await h.apply(invocation, reopened.value, implementationSubmission(workspace, work.outputs));
    expect(redeclared.ok, JSON.stringify(redeclared)).toBe(true);
    if (!redeclared.ok) return;
    expect(redeclared.value.condition).not.toBe("blocked");
    expect(redeclared.value.next_action.kind).toBe("review");
    expect(existsSync(work.sourceAbsolute)).toBe(false);
  });
});

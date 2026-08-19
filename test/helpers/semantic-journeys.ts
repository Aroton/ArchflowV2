/**
 * The shared live semantic-journey harness: connection/context plumbing, apply/status parity
 * checking, the scripted counter-review child stub, and a driver that walks a fresh task through
 * its document tiers up to the phase-implementation hand-off.
 */

import { execFileSync } from "node:child_process";
import { chmodSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

import { expect } from "vitest";

import { connectionContextFactory, createInvocationContext } from "../../src/contracts/contexts.js";
import type {
  ApplySubmissionV1,
  SemanticResultV1,
  WorkflowInvocationV1,
  WorkflowViewV1,
} from "../../src/contracts/semantic-workflow.js";
import { handleSemanticApply, handleSemanticStatus } from "../../src/mcp/handlers/semantic.js";
import type { TaskWorkspace } from "./task-workspace.js";

export type SemanticJourneyHarness = Readonly<{
  status: (invocation?: WorkflowInvocationV1) => Promise<WorkflowViewV1>;
  apply: (
    invocation: WorkflowInvocationV1,
    view: WorkflowViewV1,
    submission?: ApplySubmissionV1,
  ) => Promise<SemanticResultV1>;
  context: () => ReturnType<typeof createInvocationContext>;
}>;

export function semanticJourneyHarness(workspace: TaskWorkspace): SemanticJourneyHarness {
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
    expectOk(result);
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
    if ((result.ok ? result.value : result.view) !== fresh) {
      expect(result.ok ? result.value : result.view).toEqual(fresh);
    }
    return result;
  }

  return { status, apply, context };
}

function expectOk(result: SemanticResultV1): void {
  if (!result.ok) throw new Error(JSON.stringify(result.error));
}

/**
 * Installs a scripted `codex` child that returns one findings list per review dispatch (the last
 * list repeats) and passes every constitution rule. Returns a restorer for the caller's cleanup.
 */
export function installSemanticReviewStub(
  root: string,
  findingsByReview: readonly (readonly Record<string, unknown>[])[],
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
  return () => {
    if (saved.path === undefined) delete process.env.PATH; else process.env.PATH = saved.path;
    if (saved.home === undefined) delete process.env.HOME; else process.env.HOME = saved.home;
  };
}

function journeyApply(
  h: SemanticJourneyHarness,
  invocation: WorkflowInvocationV1,
  view: WorkflowViewV1,
  submission?: ApplySubmissionV1,
): Promise<WorkflowViewV1> {
  return h.apply(invocation, view, submission).then((result) => {
    if (!result.ok) throw new Error(JSON.stringify(result.error));
    return result.value;
  });
}

async function clientCommit(workspace: TaskWorkspace, view: WorkflowViewV1): Promise<void> {
  const commit = view.next_action.commit;
  if (commit === undefined) throw new Error("authorized commit facts unavailable");
  execFileSync("git", ["add", "-A", "--", ...commit.paths], { cwd: workspace.root });
  execFileSync("git", [
    "-c", "user.name=ArchFlow Test", "-c", "user.email=test@example.invalid",
    "commit", "-q", "-m", commit.message, "--", ...commit.paths,
  ], { cwd: workspace.root });
}

function designBytes(phaseCount: number): string {
  const phases = Array.from({ length: phaseCount }, (_, index) =>
    `### Phase ${index + 1}: Implement the verified behavior ${index + 1}\n\nProduce, review, approve, and commit tier ${index + 1}.\n`);
  return `# Design\n\nThe semantic journey preserves client-owned documents, code, and Git operations.\n\n${phases.join("")}`;
}

const PHASE_DESIGN_BYTES = `# Phase 1: Implement the verified behavior

## Goal

Reach the phase-implementation hand-off with reviewed and committed planning authority.

## Requirements

- Preserve client ownership of document writes and Git operations.
- Return fresh semantic status after every apply.

## Files

- \`src/state/semantic-view.ts\`: semantic status and hand-off projection.
- \`test/integration/semantic-implementation-journeys.test.ts\`: the live implementation lifecycle.

## Work Chunks

### Semantic lifecycle

Exercise compound production, independent review, approval, commit instructions, and the successor hand-off.

## Pinned Cross-Chunk Interfaces

\`archflow_apply\` returns the same workflow view as an immediate fresh \`archflow_status\` call.

## Success Criteria

\`archflow-phase-impl\` receives and owns its hand-off offer.

## Executable Verification

- \`npm test -- --run test/integration/semantic-implementation-journeys.test.ts\`
- \`npm run typecheck\`
`;

export type ImplementationHandoff = Readonly<{
  invocation: Readonly<{ skill: "archflow-phase-impl"; phase: number; intent: "resume" }>;
  handoff: WorkflowViewV1;
}>;

/**
 * Drives a fresh task through PRD, design (with \`phaseCount\` planned phases), and phase-design 1 —
 * each tier produced, reviewed without findings, approved, and client-committed — and returns the
 * phase-impl-1 invocation together with its owned \`start-next-skill\` hand-off view. The caller
 * must have installed the review stub (three finding-free dispatches are consumed).
 */
export async function reachImplementationHandoff(
  workspace: TaskWorkspace,
  h: SemanticJourneyHarness,
  options: Readonly<{ phaseCount: number; phase?: number }>,
): Promise<ImplementationHandoff> {
  const phase = options.phase ?? 1;
  writeFileSync(join(workspace.services.authority.task_root, "ask.md"), "Describe a small semantic journey.\n");
  writeFileSync(join(workspace.services.authority.task_root, "prd.md"), "# Semantic journey\n\nThe client authors this document.\n");

  const prd = { skill: "archflow-prd", intent: "resume" } as const;
  let view = await h.status(prd);
  view = await journeyApply(h, prd, view, { kind: "work-result", outcome: "succeeded" });
  view = await journeyApply(h, prd, view);
  view = await journeyApply(h, prd, view, { kind: "gate-summary", summary: "The PRD is ready for approval." });
  view = await journeyApply(h, prd, view, { kind: "decision", choice: "approve", reason: "The requirements are correct." });

  const design = { skill: "archflow-design", intent: "resume" } as const;
  view = await h.status(design);
  view = await journeyApply(h, design, view);
  writeFileSync(join(workspace.services.authority.task_root, "design.md"), designBytes(options.phaseCount));
  view = await journeyApply(h, design, view, { kind: "work-result", outcome: "succeeded" });
  view = await journeyApply(h, design, view);
  view = await journeyApply(h, design, view, { kind: "gate-summary", summary: "The architecture and phase plan are ready." });
  view = await journeyApply(h, design, view, { kind: "decision", choice: "approve", reason: "The design is implementable." });
  await clientCommit(workspace, view);

  const phaseDesign = { skill: "archflow-phase-design", phase, intent: "resume" } as const;
  view = await h.status(phaseDesign);
  view = await journeyApply(h, phaseDesign, view);
  const designResourcePath = view.resources.find((resource) => resource.role === "current-artifact")?.path;
  if (designResourcePath === undefined) throw new Error("phase-design resource unavailable");
  mkdirSync(dirname(join(workspace.root, designResourcePath)), { recursive: true });
  writeFileSync(join(workspace.root, designResourcePath), PHASE_DESIGN_BYTES);
  view = await journeyApply(h, phaseDesign, view, { kind: "work-result", outcome: "succeeded" });
  view = await journeyApply(h, phaseDesign, view);
  view = await journeyApply(h, phaseDesign, view, { kind: "gate-summary", summary: "The phase design is ready for approval." });
  view = await journeyApply(h, phaseDesign, view, { kind: "decision", choice: "approve", reason: "The phase scope is accurate." });
  await clientCommit(workspace, view);

  const invocation = { skill: "archflow-phase-impl" as const, phase, intent: "resume" as const };
  const handoff = await h.status(invocation);
  if (handoff.next_action.kind !== "start-next-skill" || handoff.next_action.offer === undefined) {
    throw new Error(`implementation hand-off unavailable: ${JSON.stringify(handoff.next_action)}`);
  }
  return { invocation, handoff };
}

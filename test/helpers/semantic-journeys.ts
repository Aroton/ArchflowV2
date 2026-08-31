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

/** Shared child-process source so specialized semantic stubs answer phase-design effort dispatches identically. */
export const SEMANTIC_EFFORT_STUB_SOURCE = `
function generateEffortOutput(envelope) {
  if (envelope.policy_id !== "implementation-effort-v1") return undefined;
  return { schema_version: "1", task_id: envelope.task_id, phase_instance: envelope.phase_instance,
    step: "effort_review", role: "effort-reviewer", subject_digest: envelope.subject_digest,
    input_fingerprint: envelope.input_fingerprint,
    component_manifest_digest: envelope.component_manifest_digest,
    hazard_registry_digest: envelope.hazard_registry.registry_digest,
    policy_id: envelope.policy_id,
    decomposition: { status: "adequate", rationale: "The declared components have distinct boundaries." },
    components: envelope.component_manifest.components.map((component) => ({
      component_id: component.id,
      axes: Object.fromEntries(["A", "B", "C", "D", "E"].map((axis) => [axis, {
        score: axis === "E" && typeof envelope.hazard_registry.components
          .find((entry) => entry.component_id === component.id)?.e_floor === "number"
          ? envelope.hazard_registry.components.find((entry) => entry.component_id === component.id).e_floor : 0,
        rationale: axis === "E" ? "Honors the captured hazard floor." : "The fixture is bounded.",
      }])),
      long_tool_loop: { value: "no", rationale: "The fixture has a bounded feedback loop." },
      short_component: { value: "yes", rationale: "The fixture is intentionally small." },
    })) };
}
`;

export type SemanticJourneyHarness = Readonly<{
  status: (invocation?: WorkflowInvocationV1) => Promise<WorkflowViewV1>;
  apply: (
    invocation: WorkflowInvocationV1,
    view: WorkflowViewV1,
    submission?: ApplySubmissionV1,
  ) => Promise<SemanticResultV1>;
  applyAndAssertFreshStatus: (
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
    return handleSemanticApply({
      schema_version: "1", task_id: workspace.taskId, invocation,
      action: { offer: view.next_action.offer, ...(submission === undefined ? {} : { submission }) },
    }, context());
  }

  async function applyAndAssertFreshStatus(
    invocation: WorkflowInvocationV1,
    view: WorkflowViewV1,
    submission?: ApplySubmissionV1,
  ): Promise<SemanticResultV1> {
    const result = await apply(invocation, view, submission);
    const fresh = await status(invocation);
    if ((result.ok ? result.value : result.view) !== fresh) {
      expect(result.ok ? result.value : result.view).toEqual(fresh);
    }
    return result;
  }

  return { status, apply, applyAndAssertFreshStatus, context };
}

function expectOk(result: SemanticResultV1): void {
  if (!result.ok) throw new Error(JSON.stringify(result.error));
}

/**
 * Installs a scripted `codex` child that returns one findings list per review dispatch (the last
 * list repeats) and answers every constitution rule with the given compliance (passing stubs keep
 * every rule not-matched, so no adjudication gate appears). Returns a restorer for the caller's
 * cleanup.
 */
export function installSemanticReviewStub(
  root: string,
  findingsByReview: readonly (readonly Record<string, unknown>[])[],
  options: Readonly<{
    adjudicationCompliance?: "pass" | "fail";
    /**
     * Matches only the first rule's review trigger (compliance still passes), and only for
     * implementation subjects: one waivable exception that, once granted, leaves a clean review.
     */
    implementationFailingRule?: boolean;
    /** Fail only the fixed Luna effort route; a human-authorized substitute can then succeed. */
    failFixedEffortRoute?: boolean;
  }> = {},
): () => void {
  const adjudicationCompliance = options.adjudicationCompliance ?? "pass";
  const implementationFailingRule = options.implementationFailingRule === true;
  const failFixedEffortRoute = options.failFixedEffortRoute === true;
  const bin = join(root, "semantic-stub-bin");
  const stubHome = join(root, "semantic-stub-home");
  const countPath = join(root, "semantic-review-count");
  mkdirSync(join(stubHome, ".codex"), { recursive: true });
  mkdirSync(bin, { recursive: true });
  writeFileSync(join(stubHome, ".codex", "auth.json"), "{}\n");

  const generatorScript = `
${SEMANTIC_EFFORT_STUB_SOURCE}
function generateOutput(envelope, countPath, findingsByReview, adjudicationCompliance, implementationFailingRule) {
  const effort = generateEffortOutput(envelope); if (effort !== undefined) return effort;
  const subject = envelope.subject;
  if (subject.role === "counter-review") {
    let count = 0; try { count = Number(readFileSync(countPath, "utf8")); } catch {}
    const all = findingsByReview; const findings = all[Math.min(count, all.length - 1)] ?? [];
    writeFileSync(countPath, String(count + 1));
    return { schema_version: "1", task_id: subject.task_id, phase_instance: subject.phase_instance,
      step: "counter_review", role: "counter-review", subject_digest: subject.subject_digest,
      input_fingerprint: subject.input_fingerprint, rubric_digest: subject.rubric_digest,
      producer_family: subject.producer_family, findings, matched_rule_versions: [],
      verdict: findings.some((finding) => finding.blocking === true) ? "fail" : findings.length === 0 ? "pass" : "advisory",
      blocking_count: findings.filter((finding) => finding.blocking === true).length };
  } else {
    return { schema_version: "1", task_id: subject.task_id, phase_instance: subject.phase_instance,
      step: "adjudicate", subject_digest: subject.subject_digest, input_fingerprint: subject.input_fingerprint,
      pinned_constitution_digest: subject.pinned_constitution_digest,
      approved_upstream_digests: subject.approved_upstream_digests,
      source_review_envelope_digest: subject.source_review_envelope_digest,
      rule_findings: envelope.rules.map((rule, index) => implementationFailingRule && index === 0 &&
        subject.phase_instance.indexOf("phase-impl-") === 0
        ? { rule_id: rule.id, rule_version: rule.version, compliance: "pass",
            rationale: "The implementation respects this rule.", trigger: "matched",
            trigger_evidence: "The approved phase design requires an update before this work advances." }
        : { rule_id: rule.id, rule_version: rule.version,
        compliance: adjudicationCompliance,
        rationale: adjudicationCompliance === "pass" ? "The document respects this rule." : "The document violates this rule.",
        trigger: adjudicationCompliance === "pass" ? "not-matched" : "matched",
        trigger_evidence: adjudicationCompliance === "pass" ? "No review trigger matched." : "The review trigger matched this document." }),
      drift_findings: subject.approved_upstream_digests.map((digest) => ({ upstream_digest: digest,
        drift: "aligned", affected_claim_ids: [], rationale: "No upstream drift." })) };
  }
}
`;

  writeFileSync(join(bin, "codex"), `#!/usr/bin/env node
import { readFileSync, writeFileSync } from "node:fs";
${generatorScript}
const argv = process.argv.slice(2);
if (argv.length === 1 && argv[0] === "--version") process.stdout.write("codex-cli 0.146.0\\n");
else if (argv[0] === "login" && argv[1] === "status") process.stdout.write("Logged in using ChatGPT\\n");
else {
  const chunks = []; for await (const chunk of process.stdin) chunks.push(chunk);
  const envelope = JSON.parse(Buffer.concat(chunks).toString("utf8"));
  if (${JSON.stringify(failFixedEffortRoute)} && envelope.policy_id === "implementation-effort-v1" && argv[argv.indexOf("-m") + 1] === "gpt-5.6-luna") process.exit(70);
  const output = generateOutput(envelope, ${JSON.stringify(countPath)}, ${JSON.stringify(findingsByReview)}, ${JSON.stringify(adjudicationCompliance)}, ${JSON.stringify(implementationFailingRule)});
  writeFileSync(argv[argv.indexOf("-o") + 1], JSON.stringify(output) + "\\n");
  process.stdout.write('{"type":"turn.completed"}\\n');
}`);
  chmodSync(join(bin, "codex"), 0o755);

  writeFileSync(join(bin, "claude"), `#!/usr/bin/env node
import { readFileSync, writeFileSync } from "node:fs";
${generatorScript}
const argv = process.argv.slice(2);
if (argv.length === 1 && argv[0] === "--version") process.stdout.write("2.1.220 (Claude Code)\\n");
else if (argv[0] === "auth" && argv[1] === "status") process.stdout.write(JSON.stringify({ loggedIn: true }) + "\\n");
else {
  const chunks = []; for await (const chunk of process.stdin) chunks.push(chunk);
  const envelope = JSON.parse(Buffer.concat(chunks).toString("utf8"));
  const output = generateOutput(envelope, ${JSON.stringify(countPath)}, ${JSON.stringify(findingsByReview)}, ${JSON.stringify(adjudicationCompliance)}, ${JSON.stringify(implementationFailingRule)});
  process.stdout.write(JSON.stringify({ structured_output: output }) + "\\n");
}`);
  chmodSync(join(bin, "claude"), 0o755);

  writeFileSync(join(bin, "agy"), `#!/usr/bin/env node
import { readFileSync, writeFileSync } from "node:fs";
${generatorScript}
const argv = process.argv.slice(2);
if (argv.length === 1 && argv[0] === "--version") process.stdout.write("agy 1.1.22\\n");
else if (argv[0] === "models") process.stdout.write("gemini-3.7-flash-high\\n");
else {
  // The envelope arrives as one stream-json user message on stdin, never on argv.
  const chunks = []; for await (const chunk of process.stdin) chunks.push(chunk);
  const firstLine = Buffer.concat(chunks).toString("utf8").split("\\n").find((line) => line.trim() !== "");
  const message = JSON.parse(firstLine);
  const envelope = message.event === "user" ? JSON.parse(message.message.content) : message;
  const output = generateOutput(envelope, ${JSON.stringify(countPath)}, ${JSON.stringify(findingsByReview)}, ${JSON.stringify(adjudicationCompliance)}, ${JSON.stringify(implementationFailingRule)});
  process.stdout.write(JSON.stringify({ event: "result", result: { status: "SUCCESS", structured_output: output } }) + "\\n");
}`);
  chmodSync(join(bin, "agy"), 0o755);
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

## Implementation Components

\`\`\`archflow-components-v1
schema_version: "1"
components:
  - id: semantic-lifecycle
    name: Semantic lifecycle
    scope: Exercise the phase-design to implementation handoff.
    mechanism: Use the semantic journey harness and returned workflow actions.
    repositories:
      - name: primary
        paths:
          - src/state/semantic-view.ts
          - test/integration/semantic-implementation-journeys.test.ts
    verification: Run the focused semantic implementation journey and typecheck.
\`\`\`
`;

export function withImplementationComponents(markdown: string, paths: readonly string[] = ["src/state/semantic-view.ts"]): string {
  return `${markdown.trimEnd()}\n\n## Implementation Components\n\n\`\`\`archflow-components-v1\nschema_version: "1"\ncomponents:\n  - id: journey-fixture\n    name: Journey fixture\n    scope: Exercise the phase-design lifecycle under test.\n    mechanism: Use the live semantic handler and scripted review children.\n    repositories:\n      - name: primary\n        paths:\n${paths.map((path) => `          - ${path}`).join("\n")}\n    verification: Run the focused integration journey.\n\`\`\`\n`;
}

export type ImplementationHandoff = Readonly<{
  invocation: Readonly<{ skill: "archflow-phase-impl"; phase: number; intent: "resume" }>;
  handoff: WorkflowViewV1;
}>;

export type PhaseDesignReviewOffer = Readonly<{
  invocation: Readonly<{ skill: "archflow-phase-design"; phase: number; intent: "resume" }>;
  view: WorkflowViewV1;
}>;

/** Drives the real semantic handlers to the phase-design review boundary with caller-selected bytes. */
export async function reachPhaseDesignReviewOffer(
  workspace: TaskWorkspace,
  h: SemanticJourneyHarness,
  phaseDesignBytes: string,
): Promise<PhaseDesignReviewOffer> {
  writeFileSync(join(workspace.services.authority.task_root, "config.yaml"), `schema_version: "1"
roles:
  counter-reviewer: { model: gpt-5.6-sol, effort: xhigh }
  adjudicator: { model: gpt-5.6-sol, effort: xhigh }
approval_rules:
  subjects: [prd, design]
  content: []
`);
  writeFileSync(join(workspace.services.authority.task_root, "ask.md"), "Describe a phase-design review fixture.\n");
  writeFileSync(join(workspace.services.authority.task_root, "prd.md"), "# Fixture PRD\n\nProduce one reviewed phase.\n");
  const prd = { skill: "archflow-prd", intent: "resume" } as const;
  let view = await h.status(prd);
  view = await journeyApply(h, prd, view, { kind: "work-result", outcome: "succeeded" });
  view = await journeyApply(h, prd, view);
  view = await journeyApply(h, prd, view, { kind: "gate-summary", summary: "The fixture PRD is ready." });
  view = await journeyApply(h, prd, view, { kind: "decision", choice: "approve", reason: "The fixture requirements are correct." });

  const design = { skill: "archflow-design", intent: "resume" } as const;
  view = await h.status(design);
  view = await journeyApply(h, design, view);
  writeFileSync(join(workspace.services.authority.task_root, "design.md"), designBytes(1));
  view = await journeyApply(h, design, view, { kind: "work-result", outcome: "succeeded" });
  view = await journeyApply(h, design, view);
  view = await journeyApply(h, design, view, { kind: "gate-summary", summary: "The fixture design is ready." });
  view = await journeyApply(h, design, view, { kind: "decision", choice: "approve", reason: "The fixture architecture is correct." });
  await clientCommit(workspace, view);

  const invocation = { skill: "archflow-phase-design" as const, phase: 1, intent: "resume" as const };
  view = await h.status(invocation);
  view = await journeyApply(h, invocation, view);
  const path = view.resources.find((resource) => resource.role === "current-artifact")?.path;
  if (path === undefined) throw new Error("phase-design resource unavailable");
  mkdirSync(dirname(join(workspace.root, path)), { recursive: true });
  writeFileSync(join(workspace.root, path), phaseDesignBytes);
  view = await journeyApply(h, invocation, view, { kind: "work-result", outcome: "succeeded" });
  return { invocation, view };
}

/**
 * Drives a fresh task through PRD, design (with \`phaseCount\` planned phases), and phase-design 1 —
 * each tier produced, reviewed without findings, approved, and client-committed — and returns the
 * phase-impl-1 invocation together with its owned \`start-next-skill\` hand-off view. The caller
 * must have installed the review stub (three finding-free dispatches are consumed).
 */
export async function reachImplementationHandoff(
  workspace: TaskWorkspace,
  h: SemanticJourneyHarness,
  options: Readonly<{ phaseCount: number; phase?: number; contentRules?: readonly string[] }>,
): Promise<ImplementationHandoff> {
  const phase = options.phase ?? 1;
  // The walked prd/design/phase-design tiers all retain their approval gates during the staged
  // rollout. The explicit subjects list also exercises persisted match presentation at each tier.
  const content = options.contentRules === undefined || options.contentRules.length === 0
    ? "[]"
    : `[{ paths: [${options.contentRules.map((rule) => JSON.stringify(rule)).join(", ")}] }]`;
  writeFileSync(join(workspace.services.authority.task_root, "config.yaml"), `schema_version: "1"
roles:
  counter-reviewer: { model: gpt-5.6-sol, effort: xhigh }
  adjudicator: { model: gpt-5.6-sol, effort: xhigh }
approval_rules:
  subjects: [prd, design, phase-design]
  content: ${content}
`);
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

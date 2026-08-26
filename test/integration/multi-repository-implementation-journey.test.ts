import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

import { afterAll, afterEach, describe, expect, it } from "vitest";

import type {
  ApplySubmissionV1,
  WorkflowInvocationV1,
  WorkflowViewV1,
} from "../../src/contracts/semantic-workflow.js";
import {
  installSemanticReviewStub,
  reachImplementationHandoff,
  semanticJourneyHarness,
  type SemanticJourneyHarness,
} from "../helpers/semantic-journeys.js";
import {
  createTaskWorkspace,
  legacyHumanAuthorityConstitutionV1Bytes,
  type TaskWorkspace,
} from "../helpers/task-workspace.js";
import {
  cleanupTemporaryRepositories,
  createTempRepository,
  type TempRepository,
} from "../helpers/temp-repository.js";

const TIMEOUT = 180_000;
const workspaces: TaskWorkspace[] = [];
const restorers: (() => void)[] = [];

afterEach(() => {
  for (const restore of restorers.splice(0)) restore();
  for (const workspace of workspaces.splice(0)) workspace.dispose();
});
afterAll(cleanupTemporaryRepositories);

function git(root: string, ...args: readonly string[]): string {
  return execFileSync("git", [...args], { cwd: root, encoding: "utf8" }).trim();
}

function commit(root: string, message: string, paths: readonly string[]): void {
  execFileSync("git", ["add", "-A", "--", ...paths], { cwd: root });
  execFileSync("git", [
    "-c", "user.name=ArchFlow Test", "-c", "user.email=test@example.invalid",
    "commit", "-q", "-m", message, "--", ...paths,
  ], { cwd: root });
}

async function applied(
  harness: SemanticJourneyHarness,
  invocation: WorkflowInvocationV1,
  view: WorkflowViewV1,
  submission?: ApplySubmissionV1,
): Promise<WorkflowViewV1> {
  const result = await harness.apply(invocation, view, submission);
  if (!result.ok) throw new Error(JSON.stringify(result.error));
  return result.value;
}

function configBytes(api: TempRepository, context: TempRepository, contentPatterns: readonly string[] = []): Uint8Array {
  const content = contentPatterns.length === 0
    ? "  content: []"
    : `  content:\n${contentPatterns.map((pattern) => `    - paths: [${JSON.stringify(pattern)}]`).join("\n")}`;
  return new TextEncoder().encode(`schema_version: "1"
roles:
  counter-reviewer: { model: gpt-fixture, effort: high }
  adjudicator: { model: gpt-fixture, effort: high }
approval_rules:
  subjects: [prd, design, phase-design]
${content}
repositories:
  api:
    path: ${JSON.stringify(api.path)}
    mode: writable
  context:
    path: ${JSON.stringify(context.path)}
    mode: context-only
`);
}

function excludeReviewerFixture(workspace: TaskWorkspace): void {
  const exclude = join(workspace.root, ".git", "info", "exclude");
  mkdirSync(dirname(exclude), { recursive: true });
  writeFileSync(exclude, "semantic-stub-bin/\nsemantic-stub-home/\nsemantic-review-count\n");
}

type MultiRepositoryWork = Readonly<{
  primaryBase: string;
  secondaryBase: string;
  primaryOutputs: readonly string[];
  secondaryOutputs: readonly string[];
}>;

function writeMultiRepositoryWork(
  workspace: TaskWorkspace,
  api: TempRepository,
  context: TempRepository,
  view: WorkflowViewV1,
  marker: string,
  extraSecondaryFiles: Readonly<Record<string, string>> = {},
): MultiRepositoryWork {
  const artifact = view.resources.find((resource) => resource.role === "current-artifact");
  const transcript = view.resources.find((resource) => resource.role === "verification-transcript");
  if (artifact === undefined || transcript === undefined) throw new Error("implementation resources unavailable");
  const primaryBase = git(workspace.root, "rev-parse", "HEAD");
  const secondaryBase = api.git("rev-parse", "HEAD");
  const primaryPath = "src/shared.ts";
  const secondaryPath = "src/shared.ts";
  const primaryOutputs = [artifact.path, primaryPath].sort();
  const secondaryOutputs = [secondaryPath, ...Object.keys(extraSecondaryFiles)].sort();

  for (const [path, bytes] of [
    [primaryPath, `export const owner = "primary-${marker}";\n`],
    [artifact.path, `# Multi-repository implementation (${marker})\n\nVerified primary-first commit succession.\n`],
    [transcript.path, "$ multi-repository verification\nTests passed\n"],
  ] as const) {
    const absolute = join(workspace.root, path);
    mkdirSync(dirname(absolute), { recursive: true });
    writeFileSync(absolute, bytes);
  }
  api.write(secondaryPath, `export const owner = "api-${marker}";\n`);
  for (const [path, bytes] of Object.entries(extraSecondaryFiles)) api.write(path, bytes);
  // Context-only dirt must remain review context and must not enter implementation capture.
  context.write("unrelated-context.txt", "context-only dirt\n");
  return { primaryBase, secondaryBase, primaryOutputs, secondaryOutputs };
}

function submission(work: MultiRepositoryWork): Extract<
  ApplySubmissionV1,
  { readonly kind: "work-result"; readonly outcome: "succeeded" }
> {
  return {
    kind: "work-result",
    outcome: "succeeded",
    implementation: {
      base_commit: work.primaryBase,
      outputs: [...work.primaryOutputs],
      restore_targets: [...work.primaryOutputs],
      declared_inputs: [],
      repositories: [{
        name: "api",
        base_commit: work.secondaryBase,
        outputs: [...work.secondaryOutputs],
        restore_targets: [...work.secondaryOutputs],
        declared_inputs: [],
      }],
    },
  };
}

type StartOptions = Readonly<{
  contentPatterns?: readonly string[];
  implementationFailingRule?: boolean;
}>;

type ImplementationStart = Readonly<{
  workspace: TaskWorkspace;
  api: TempRepository;
  context: TempRepository;
  harness: SemanticJourneyHarness;
  invocation: WorkflowInvocationV1;
  view: WorkflowViewV1;
}>;

/** Plans a one-phase task with a writable api and a context-only secondary, then begins its implementation. */
async function reachImplementationStart(
  authority: "human" | "no-wait",
  marker: string,
  options: StartOptions = {},
): Promise<ImplementationStart> {
  const { contentPatterns = [], implementationFailingRule = false } = options;
  const api = createTempRepository({ label: `multi-impl-api-${marker}` });
  const context = createTempRepository({ label: `multi-impl-context-${marker}` });
  api.write("README.md", "api repository\n");
  api.commitAll("api root");
  context.write("README.md", "context repository\n");
  context.commitAll("context root");
  const workspace = await createTaskWorkspace({
    taskId: `multi-impl-${marker}`,
    label: `multi-impl-${marker}`,
    configBytes: configBytes(api, context, contentPatterns),
    ...(authority === "human" ? { constitutionBytes: legacyHumanAuthorityConstitutionV1Bytes() } : {}),
  });
  workspaces.push(workspace);
  excludeReviewerFixture(workspace);
  restorers.push(installSemanticReviewStub(workspace.root, [[], [], [], []], { implementationFailingRule }));
  const harness = semanticJourneyHarness(workspace);
  const { invocation, handoff } = await reachImplementationHandoff(workspace, harness, { phaseCount: 1 });
  // The shared hand-off helper deliberately resets the task config to its primary-only semantic
  // fixture. Install the multi-repository task config after planning completes, then consume the
  // freshly re-derived hand-off so implementation composition sees the authenticated live set.
  writeFileSync(workspace.services.authority.config.absolute, configBytes(api, context, contentPatterns));
  const configuredHandoff = await harness.status(invocation);
  expect(configuredHandoff.next_action.offer).toBe(handoff.next_action.offer);
  const view = await applied(harness, invocation, configuredHandoff);
  return { workspace, api, context, harness, invocation, view };
}

type FirstCommitOptions = StartOptions & Readonly<{
  deferHumanDecision?: boolean;
  /** Extra api-only files declared alongside the shared `src/shared.ts` change. */
  extraSecondaryFiles?: Readonly<Record<string, string>>;
}>;

async function reachFirstCommit(
  authority: "human" | "no-wait",
  marker: string,
  options: FirstCommitOptions = {},
): Promise<ImplementationStart & Readonly<{ work: MultiRepositoryWork }>> {
  const { deferHumanDecision = false, extraSecondaryFiles = {}, ...startOptions } = options;
  const start = await reachImplementationStart(authority, marker, startOptions);
  const { workspace, api, context, harness, invocation } = start;
  const work = writeMultiRepositoryWork(workspace, api, context, start.view, marker, extraSecondaryFiles);
  let view = await applied(harness, invocation, start.view, submission(work));
  expect(view.next_action.kind).toBe("review");
  view = await applied(harness, invocation, view);
  if (view.findings !== undefined) expect(view.findings).toEqual([]);
  if (authority === "human" && !deferHumanDecision) {
    expect(view.next_action).toMatchObject({ kind: "decide", expected_submission: "gate-summary" });
    view = await applied(harness, invocation, view, {
      kind: "gate-summary",
      summary: "The exact primary and api proposed trees are ready for one commit authorization.",
    });
    view = await applied(harness, invocation, view, {
      kind: "decision", choice: "authorize-commit", reason: "Authorize both reviewed repository commits.",
    });
  }
  return { ...start, view, work };
}

function expectPrimaryCommit(view: WorkflowViewV1, work: MultiRepositoryWork): NonNullable<WorkflowViewV1["next_action"]["commit"]> {
  const fact = view.next_action.commit;
  if (fact === undefined) throw new Error("primary commit fact unavailable");
  expect(fact).not.toHaveProperty("repository");
  expect(fact).toMatchObject({ baseline: work.primaryBase, paths: work.primaryOutputs });
  return fact;
}

function expectApiCommit(view: WorkflowViewV1, work: MultiRepositoryWork, api: TempRepository): NonNullable<WorkflowViewV1["next_action"]["commit"]> {
  const fact = view.next_action.commit;
  if (fact === undefined) throw new Error(`api commit fact unavailable: ${JSON.stringify(view)}`);
  expect(fact).toMatchObject({
    baseline: work.secondaryBase,
    paths: work.secondaryOutputs,
    repository: { name: "api", location: api.path },
  });
  return fact;
}

describe("multi-repository implementation journeys", { timeout: TIMEOUT }, () => {
  it("completes primary then api under no-wait authority and retains prior proof across a descendant", async () => {
    const h = await reachFirstCommit("no-wait", "no-wait-completion");
    const primary = expectPrimaryCommit(h.view, h.work);
    commit(h.workspace.root, primary.message, primary.paths);
    writeFileSync(join(h.workspace.root, "primary-descendant.txt"), "descendant\n");
    commit(h.workspace.root, "ordinary primary descendant", ["primary-descendant.txt"]);

    const firstApiView = await h.harness.status(h.invocation);
    const apiFact = expectApiCommit(firstApiView, h.work, h.api);
    // A failed client attempt changes no authority: resume repeats only the first unproved member.
    const retriedApiView = await h.harness.status(h.invocation);
    expect(retriedApiView.next_action.commit).toEqual(apiFact);
    commit(h.api.path, apiFact.message, apiFact.paths);

    let completed = await h.harness.status(h.invocation);
    expect(completed.next_action).toMatchObject({ kind: "finish-task", expected_submission: "none" });
    completed = await applied(h.harness, h.invocation, completed);
    expect(completed).toMatchObject({ condition: "complete", next_action: { kind: "none" } });
    expect(readFileSync(join(h.workspace.root, "src/shared.ts"), "utf8")).toContain("primary");
    expect(readFileSync(join(h.api.path, "src/shared.ts"), "utf8")).toContain("api");
    expect(readFileSync(join(h.context.path, "unrelated-context.txt"), "utf8")).toBe("context-only dirt\n");
  });

  it("opens the human commit gate on a content rule matched only in the api repository and then covers both repositories' commit facts", async () => {
    // PRD success criterion 6: a configured content rule watches every writable repository, so a
    // `.sql` change declared only in the api secondary must open the approval gate, name the
    // matched path under its repository, and — once authorized — still yield the primary-first
    // commit facts for both repositories.
    const sqlPath = "db/schema.sql";
    const h = await reachFirstCommit("human", "api-content-rule", {
      deferHumanDecision: true,
      contentPatterns: ["**/*.sql"],
      extraSecondaryFiles: { [sqlPath]: "create table widgets (id integer);\n" },
    });
    expect(h.view.next_action).toMatchObject({ kind: "decide", expected_submission: "gate-summary" });
    let view = await applied(h.harness, h.invocation, h.view, {
      kind: "gate-summary", summary: "The api schema change matched the project's content rules.",
    });
    expect(view.presentation?.summary).toContain(`- api/${sqlPath}`);
    expect(view.presentation?.details).toEqual(expect.arrayContaining([expect.stringContaining(`api/${sqlPath}: added`)]));
    expect(view.presentation?.reasons).toEqual(expect.arrayContaining([expect.objectContaining({
      class: "configured-approval",
      text: `Configured content approval rules matched 1 reviewed path: api/${sqlPath}.`,
    })]));
    const state = JSON.parse(readFileSync(h.workspace.services.authority.state.absolute, "utf8"));
    const settlement = state.rule_settlements?.find((entry: { phase_instance: string }) => entry.phase_instance === "phase-impl-1");
    expect(settlement?.conclusion).toEqual({
      wait: true, match: { kind: "content", paths: [], secondary_paths: [{ repository: "api", paths: [sqlPath] }] },
    });

    view = await applied(h.harness, h.invocation, view, {
      kind: "decision", choice: "authorize-commit", reason: "The api schema change is reviewed.",
    });
    const primary = expectPrimaryCommit(view, h.work);
    commit(h.workspace.root, primary.message, primary.paths);
    const apiFact = expectApiCommit(await h.harness.status(h.invocation), h.work, h.api);
    expect(apiFact.paths).toContain(sqlPath);
    commit(h.api.path, apiFact.message, apiFact.paths);
    expect((await h.harness.status(h.invocation)).next_action).toMatchObject({ kind: "finish-task" });
  });

  it("stops after the primary proof when the uncommitted api target moves", async () => {
    const h = await reachFirstCommit("no-wait", "stale-api-target");
    const primary = expectPrimaryCommit(h.view, h.work);
    commit(h.workspace.root, primary.message, primary.paths);
    h.api.write("unrelated.txt", "target movement\n");
    h.api.commitAll("move uncommitted api target");

    const stopped = await h.harness.status(h.invocation);
    expect(stopped.next_action.kind).toBe("inspect");
    expect(stopped.next_action.commit).toBeUndefined();
    expect(`${stopped.headline}\n${stopped.detail}`).toMatch(/api|secondary/u);
    expect(git(h.workspace.root, "log", "-1", "--pretty=%B")).toBe(primary.message);
  });

  it("returns a named blocked status when the api target moves before its commit gate opens", async () => {
    const h = await reachFirstCommit("human", "pre-gate-api-target", { deferHumanDecision: true });
    expect(h.view.next_action).toMatchObject({ kind: "decide", expected_submission: "gate-summary" });
    h.api.write("unrelated-target-movement.txt", "move target without changing reviewed bytes\n");
    commit(h.api.path, "move api target before gate", ["unrelated-target-movement.txt"]);

    const blocked = await h.harness.status(h.invocation);
    expect(blocked.condition).toBe("blocked");
    expect(blocked.next_action.kind).toBe("inspect");
    expect(`${blocked.headline}\n${blocked.detail}`).toContain("api-target-moved");
  });

  it("settles a granted policy exception under a content-rule wait without observing secondary commits", async () => {
    // A content rule that matches the changed paths makes the settlement `wait: true`. Granting a
    // policy exception at that boundary must record the waiting settlement and return the gate to
    // the human; it must never try to mint secondary commit facts for a settlement that cannot
    // carry them, which used to surface as an internal error.
    const h = await reachFirstCommit("human", "waiver-content-wait", {
      deferHumanDecision: true, contentPatterns: ["src/**"], implementationFailingRule: true,
    });
    let view = await applied(h.harness, h.invocation, h.view, {
      kind: "gate-summary", summary: "The constitution review failed one rule; the content rule also matched.",
    });
    const tokens = view.presentation?.options.map((option) => option.token) ?? [];
    const waiverToken = tokens.find((token) => token.startsWith("request-exception-"));
    expect(waiverToken, tokens.join(",")).toBeDefined();
    view = await applied(h.harness, h.invocation, view, {
      kind: "decision", choice: waiverToken!, reason: "Request a narrowly scoped exception for the failed rule.",
      option_rationale: "The rule's trigger does not apply to this phase's verified behavior.",
    });
    expect(view.next_action).toMatchObject({ kind: "open-waiver", expected_submission: "none" });
    view = await applied(h.harness, h.invocation, view);
    expect(view.presentation?.options.map((option) => option.token)).toContain("grant-exception");
    view = await applied(h.harness, h.invocation, view, {
      kind: "decision", choice: "grant-exception", reason: "The exception is narrowly scoped and reviewed.",
    });
    // The waiting settlement is durable and carries no secondary milestones; the commit gate still
    // needs the explicit human authorization the content rule demanded.
    const state = JSON.parse(readFileSync(h.workspace.services.authority.state.absolute, "utf8"));
    const settlement = state.rule_settlements?.at(-1);
    expect(settlement?.conclusion?.wait).toBe(true);
    expect(settlement).not.toHaveProperty("secondary_milestones");
    expect(view.next_action.kind).toBe("decide");
    const status = await h.harness.status(h.invocation);
    expect(status.condition).not.toBe("blocked");
  });

  it("qualifies api-only adopt, restore, worktree deletion, and committed deletion with a same-path primary", async () => {
    const start = await reachImplementationStart("no-wait", "reconciliation");
    const { workspace, api, context, harness, invocation } = start;
    let view = start.view;
    const work = writeMultiRepositoryWork(workspace, api, context, view, "reconciliation");
    const primaryBytes = readFileSync(join(workspace.root, "src/shared.ts"), "utf8");
    view = await applied(harness, invocation, view, submission(work));
    expect(view.next_action.kind).toBe("review");

    api.write("src/shared.ts", 'export const owner = "api-drift-for-restore";\n');
    view = await harness.status(invocation);
    expect(view.next_action).toMatchObject({ kind: "decide", expected_submission: "gate-summary" });
    view = await applied(harness, invocation, view, {
      kind: "gate-summary", summary: "Only the api repository copy drifted; restore its reviewed bytes.",
    });
    expect(view.presentation?.summary).toContain("api");
    expect(JSON.stringify(view.presentation)).toContain("src/shared.ts");
    view = await applied(harness, invocation, view, {
      kind: "decision", choice: "restore-recorded-versions", reason: "Restore only the reviewed api tuple.",
    });
    expect(readFileSync(join(api.path, "src/shared.ts"), "utf8")).toContain("api-reconciliation");
    expect(readFileSync(join(workspace.root, "src/shared.ts"), "utf8")).toBe(primaryBytes);

    api.write("src/shared.ts", 'export const owner = "api-adopted";\n');
    view = await harness.status(invocation);
    view = await applied(harness, invocation, view, {
      kind: "gate-summary", summary: "Only the api repository copy should become the new baseline.",
    });
    view = await applied(harness, invocation, view, {
      kind: "decision", choice: "keep-current-versions", reason: "Adopt only the current api tuple.",
    });
    const state = JSON.parse(readFileSync(workspace.services.authority.state.absolute, "utf8"));
    expect(state.baseline_adoptions?.at(-1)?.adopted_projections).toEqual([
      expect.objectContaining({ repository: "api", path: "src/shared.ts" }),
    ]);
    expect(readFileSync(join(workspace.root, "src/shared.ts"), "utf8")).toBe(primaryBytes);

    commit(api.path, "commit adopted api baseline", ["src/shared.ts"]);
    rmSync(join(api.path, "src/shared.ts"));
    const missing = await harness.status(invocation);
    expect(missing.condition).not.toBe("blocked");
    expect(missing.next_action.kind, JSON.stringify(missing)).toBe("begin-work");
    expect(existsSync(join(workspace.root, "src/shared.ts"))).toBe(true);

    api.write("src/shared.ts", 'export const owner = "api-adopted";\n');
    rmSync(join(api.path, "src/shared.ts"));
    commit(api.path, "delete adopted api baseline", ["src/shared.ts"]);
    const committedDeletion = await harness.status(invocation);
    expect(committedDeletion.next_action).toMatchObject({ kind: "decide", expected_submission: "gate-summary" });
    const opened = await applied(harness, invocation, committedDeletion, {
      kind: "gate-summary", summary: "The committed deletion affects only api/src/shared.ts.",
    });
    expect(opened.presentation?.summary).toContain("api");
    expect(JSON.stringify(opened.presentation)).toContain("src/shared.ts");
    expect(readFileSync(join(workspace.root, "src/shared.ts"), "utf8")).toBe(primaryBytes);
  });
});

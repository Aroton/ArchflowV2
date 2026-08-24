import { execFileSync } from "node:child_process";
import { chmodSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { cpus, platform, arch, tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { performance } from "node:perf_hooks";
import { fileURLToPath } from "node:url";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import type {
  ApplySubmissionV1,
  WorkflowInvocationV1,
  WorkflowViewV1,
} from "../../src/contracts/semantic-workflow.js";
import {
  buildAutomationLocalBundle,
  runAutomationStatus,
  snapshotDirectory,
} from "../helpers/automation-status.js";
import {
  installSemanticReviewStub,
  reachImplementationHandoff,
  semanticJourneyHarness,
  type SemanticJourneyHarness,
} from "../helpers/semantic-journeys.js";
import { createTaskWorkspace, type TaskWorkspace } from "../helpers/task-workspace.js";

const TIMEOUT = 180_000;
const SAMPLE_COUNT = 5;
const MAX_SAMPLE_MS = 5_000;
const MAX_GIT_SPAWNS = 64;
const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const realGit = realpathSync(execFileSync("which", ["git"], { encoding: "utf8" }).trim());

let temporaryRoot = "";
let localBundle = "";
let workspace: TaskWorkspace | undefined;
let restoreReviewer: (() => void) | undefined;

beforeAll(async () => {
  temporaryRoot = await mkdtemp(join(tmpdir(), "archflow-automation-benchmark-"));
  localBundle = join(temporaryRoot, "archflow-local.mjs");
  buildAutomationLocalBundle(repositoryRoot, localBundle);
}, TIMEOUT);

afterAll(async () => {
  restoreReviewer?.();
  workspace?.dispose();
  if (temporaryRoot !== "") await rm(temporaryRoot, { recursive: true, force: true });
});

function gitAt(fixture: TaskWorkspace, ...arguments_: readonly string[]): string {
  return execFileSync("git", [...arguments_], { cwd: fixture.root, encoding: "utf8" }).trim();
}

async function applyOk(
  harness: SemanticJourneyHarness,
  invocation: WorkflowInvocationV1,
  view: WorkflowViewV1,
  submission?: ApplySubmissionV1,
): Promise<WorkflowViewV1> {
  const result = await harness.apply(invocation, view, submission);
  if (!result.ok) throw new Error(JSON.stringify(result.error));
  return result.value;
}

function excludeReviewFixtures(fixture: TaskWorkspace): void {
  const exclude = join(fixture.root, ".git", "info", "exclude");
  mkdirSync(dirname(exclude), { recursive: true });
  writeFileSync(exclude, "semantic-stub-bin/\nsemantic-stub-home/\nsemantic-review-count\n");
}

async function representativeCompletedTask(): Promise<TaskWorkspace> {
  const fixture = await createTaskWorkspace({
    taskId: "automation-benchmark",
    label: "automation-benchmark",
  });
  excludeReviewFixtures(fixture);
  restoreReviewer = installSemanticReviewStub(fixture.root, [[], [], [], []]);
  const harness = semanticJourneyHarness(fixture);
  const { invocation, handoff } = await reachImplementationHandoff(fixture, harness, { phaseCount: 1 });
  let view = await applyOk(harness, invocation, handoff);

  writeFileSync(fixture.services.authority.config.absolute, `schema_version: "1"
roles:
  counter-reviewer: { model: gpt-5.6-sol, effort: xhigh }
  adjudicator: { model: gpt-5.6-sol, effort: xhigh }
approval_rules:
  subjects: []
  content:
    - paths: ["**/*.sql"]
`);
  const artifact = view.resources.find((candidate) => candidate.role === "current-artifact");
  const transcript = view.resources.find((candidate) => candidate.role === "verification-transcript");
  if (artifact === undefined || transcript === undefined) throw new Error("benchmark implementation resources unavailable");
  const sourcePath = "src/benchmark-fixture.ts";
  mkdirSync(join(fixture.root, "src"), { recursive: true });
  mkdirSync(dirname(join(fixture.root, transcript.path)), { recursive: true });
  writeFileSync(join(fixture.root, sourcePath), "export const benchmarkFixture = true;\n");
  writeFileSync(join(fixture.root, artifact.path), `# Implementation Log: Phase 1 - Benchmark fixture

### Decisions Made

- Added one representative TypeScript output.

### Deviations from Plan

- None.

### Patterns Established

- None.

### Gotchas

- None.

### Key Interfaces

- \`benchmarkFixture: boolean\`.

### Verification Evidence

- The fixture transcript records a passing check.
`);
  writeFileSync(join(fixture.root, transcript.path), "$ npm run typecheck\n\nRepresentative fixture: passed\n");
  const outputs = [artifact.path, sourcePath].sort();
  view = await applyOk(harness, invocation, view, {
    kind: "work-result",
    outcome: "succeeded",
    implementation: {
      base_commit: gitAt(fixture, "rev-parse", "HEAD"),
      outputs,
      restore_targets: outputs,
      declared_inputs: [],
    },
  });
  view = await applyOk(harness, invocation, view);
  const commit = view.next_action.commit;
  if (commit === undefined) throw new Error("benchmark implementation did not advance autonomously");
  execFileSync("git", ["add", "-A", "--", ...commit.paths], { cwd: fixture.root });
  execFileSync("git", [
    "-c", "user.name=ArchFlow Test", "-c", "user.email=test@example.invalid",
    "commit", "-q", "-m", commit.message, "--", ...commit.paths,
  ], { cwd: fixture.root });
  view = await harness.status(invocation);
  expect(view.next_action.kind).toBe("finish-task");
  await applyOk(harness, invocation, view);
  return fixture;
}

function countingGitEnvironment(countPath: string): NodeJS.ProcessEnv {
  const bin = join(temporaryRoot, "git-count-bin");
  const benchmarkHome = join(temporaryRoot, "empty-home");
  mkdirSync(bin, { recursive: true });
  mkdirSync(benchmarkHome, { recursive: true });
  writeFileSync(join(bin, "git"), `#!/usr/bin/env node
import { readFileSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
let count = 0;
try { count = Number(readFileSync(${JSON.stringify(countPath)}, "utf8")); } catch {}
writeFileSync(${JSON.stringify(countPath)}, String(count + 1));
const child = spawnSync(${JSON.stringify(realGit)}, process.argv.slice(2), { stdio: "inherit" });
if (child.error) throw child.error;
if (child.signal) process.kill(process.pid, child.signal);
process.exit(child.status ?? 1);
`);
  chmodSync(join(bin, "git"), 0o755);
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    PATH: `${bin}:${process.env.PATH ?? ""}`,
    HOME: benchmarkHome,
    GIT_CONFIG_GLOBAL: "/dev/null",
    GIT_CONFIG_SYSTEM: "/dev/null",
    ARCHFLOW_REAL_HOST_TESTS: "0",
  };
  delete env.OPENAI_API_KEY;
  delete env.ANTHROPIC_API_KEY;
  delete env.CODEX_API_KEY;
  return env;
}

describe("automation status cold-process benchmark", { timeout: TIMEOUT }, () => {
  it("measures bounded read-only polling through a delegating Git-count shim", async () => {
    workspace = await representativeCompletedTask();
    restoreReviewer?.();
    restoreReviewer = undefined;
    const countPath = join(temporaryRoot, "git-spawn-count");
    const env = countingGitEnvironment(countPath);
    const authorityBefore = snapshotDirectory(join(workspace.root, ".archflow"));
    const reviewCountBefore = readFileSync(join(workspace.root, "semantic-review-count"), "utf8");
    const wallTimes: number[] = [];
    const gitSpawns: number[] = [];

    for (let sample = 0; sample < SAMPLE_COUNT; sample += 1) {
      writeFileSync(countPath, "0");
      const started = performance.now();
      const result = runAutomationStatus(localBundle, workspace.root, workspace.taskId, env);
      wallTimes.push(Number((performance.now() - started).toFixed(3)));
      gitSpawns.push(Number(readFileSync(countPath, "utf8")));
      expect(result.status, result.stderr).toBe(0);
      expect(result.observation).toMatchObject({
        condition: "complete",
        next_action: { actor: "none", kind: "none" },
      });
    }

    expect(snapshotDirectory(join(workspace.root, ".archflow"))).toEqual(authorityBefore);
    expect(readFileSync(join(workspace.root, "semantic-review-count"), "utf8")).toBe(reviewCountBefore);
    expect(Math.max(...wallTimes)).toBeLessThan(MAX_SAMPLE_MS);
    expect(new Set(gitSpawns).size).toBe(1);
    expect(Math.max(...gitSpawns)).toBeLessThanOrEqual(MAX_GIT_SPAWNS);

    const sortedTimes = [...wallTimes].sort((left, right) => left - right);
    const diagnostics = {
      machine: {
        platform: platform(),
        arch: arch(),
        node: process.version,
        cpu: cpus()[0]?.model ?? "unknown",
      },
      sample_count: SAMPLE_COUNT,
      git_spawns_per_sample: gitSpawns,
      wall_time_ms: {
        samples: wallTimes,
        median: sortedTimes[Math.floor(sortedTimes.length / 2)],
        max: Math.max(...wallTimes),
      },
    };
    console.info(`AUTOMATION_BENCHMARK ${JSON.stringify(diagnostics)}`);
  });
});

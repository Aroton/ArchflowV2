import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { chmod, copyFile, mkdtemp, mkdir, readFile, readdir, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { delimiter, dirname, join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { createAdjudicationOutputSchema } from "../../src/contracts/adjudication.js";
const adjudicationSchema = JSON.parse(JSON.stringify(createAdjudicationOutputSchema(["rule-1"]).toJSONSchema({ target: "draft-2020-12" })));
import { reviewReportOutputSchema } from "../../src/contracts/review.js";
const reviewSchema = JSON.parse(JSON.stringify(reviewReportOutputSchema.toJSONSchema({ target: "draft-2020-12" })));
import { parseGitOid } from "../../src/contracts/canonical.js";
import type { PlainJsonValue } from "../../src/contracts/plain-json.js";
import { createReviewDispatcher } from "../../src/dispatch/coordinator.js";
import { resetMemoizedCliPreflight } from "../../src/dispatch/cli.js";
import { capacityError, nativeStream, recoveredCapacityEvents } from "../helpers/antigravity-output.js";
import {
  shareRepositoryViewWorkspace,
  type DispatchRepositoryViewPlan,
} from "../../src/dispatch/workspace.js";
import { DispatchProcessError, scanDispatchOutput } from "../../src/dispatch/process.js";
import type { DispatchRoute } from "../../src/dispatch/routing.js";
import type { DispatchEnvelope } from "../../src/review/envelopes.js";

const roots: string[] = [];

const ROUTE: DispatchRoute = Object.freeze({
  adapter: "codex-cli",
  family: "codex",
  model: "gpt-5.3-codex",
  effort: "high",
});
const CLAUDE_ROUTE: DispatchRoute = Object.freeze({
  adapter: "claude-cli",
  family: "claude",
  model: "claude-opus-4-6",
  effort: "high",
});
const ENVELOPE: DispatchEnvelope = Object.freeze({
  result_kind: "review",
  bytes: Buffer.from('{"schema_version":"1","subject":{"stage":"plan"},"rubric":{"criteria":[{"id":"correctness","text":"Check correctness","blocking":true}]}}\n'),
  digest: "d".repeat(64) as DispatchEnvelope["digest"],
  byte_count: 23,
});

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function harness(
  mode: "success" | "hang-version" | "hang-child" | "fail-child" | "fail-child-once" | "fail-auth-once",
) {
  const root = await realpath(await mkdtemp(join(tmpdir(), "archflow-dispatch-coordinator-")));
  roots.push(root);
  const repository = join(root, "repository");
  const bin = join(root, "bin");
  const sourceHome = join(root, "source-home");
  await Promise.all([mkdir(repository), mkdir(bin), mkdir(sourceHome)]);
  execFileSync("git", ["-c", "init.defaultBranch=main", "init", "-q"], { cwd: repository });
  await writeFile(join(repository, "tracked.txt"), "root\n");
  execFileSync("git", ["add", "--", "tracked.txt"], { cwd: repository });
  execFileSync("git", [
    "-c", "user.name=ArchFlow Test", "-c", "user.email=test@example.invalid",
    "commit", "-q", "-m", "root",
  ], { cwd: repository });

  const executable = join(bin, "codex");
  const childStarted = join(root, "child-started");
  await writeFile(executable, `#!/usr/bin/env node
import { writeFile } from "node:fs/promises";
const argv = process.argv.slice(2);
if (argv.length === 1 && argv[0] === "--version") {
  await writeFile(${JSON.stringify(join(root, "preflight.log"))}, "--version\\n", { flag: "a" });
  ${mode === "hang-version" ? "setInterval(() => undefined, 1000);" : 'process.stdout.write("codex-cli 0.146.0\\n");'}
} else if (argv[0] === "login" && argv[1] === "status") {
  await writeFile(${JSON.stringify(join(root, "preflight.log"))}, "login status\\n", { flag: "a" });
  ${mode === "fail-auth-once" ? `const { existsSync: authDown } = await import("node:fs"); if (authDown(${JSON.stringify(join(root, "auth-down"))})) process.exit(1);` : ""}
  process.stdout.write("Logged in using ChatGPT\\n");
} else {
  ${mode === "hang-child" ? `await writeFile(${JSON.stringify("__CHILD_STARTED__")}, "started\\n"); setInterval(() => undefined, 1000);` : ""}
  ${mode === "fail-child" ? 'process.stderr.write("stream error: exceeded retry limit\\n"); process.exit(3);' : ""}
  ${mode === "fail-child-once" ? `const { existsSync: childDown } = await import("node:fs"); if (childDown(${JSON.stringify(join(root, "child-down"))})) { process.stderr.write("stream error: exceeded retry limit\\n"); process.exit(3); }` : ""}
  const { existsSync, readdirSync } = await import("node:fs");
  const { join } = await import("node:path");
  const target = argv.includes("-C") ? argv[argv.indexOf("-C") + 1] : null;
  await writeFile(${JSON.stringify(join(root, "observed-invocation.json"))}, JSON.stringify({
    argv,
    entries: target === null ? [] : readdirSync(target).sort(),
    view: target === null ? null : {
      tracked: existsSync(join(target, "repositories", "primary", "tracked.txt")),
      git: existsSync(join(target, "repositories", "primary", ".git")),
      tasks: existsSync(join(target, "repositories", "primary", ".archflow", "tasks")),
    },
  }));
  await writeFile(${JSON.stringify(join(root, "observed-invocations.log"))}, JSON.stringify({ argv, tmpdir: process.env.TMPDIR }) + "\\n", { flag: "a" });
  process.stdin.resume();
  process.stdin.on("end", async () => {
    await writeFile(argv[argv.indexOf("-o") + 1], '{"schema_version":"1"}\\n');
    process.stdout.write('{"type":"turn.completed"}\\n');
  });
}
`);
  if (mode === "hang-child") {
    const source = await readFile(executable, "utf8");
    await writeFile(executable, source.replace("__CHILD_STARTED__", childStarted));
  }
  await chmod(executable, 0o755);

  const commit = parseGitOid(execFileSync("git", ["rev-parse", "HEAD"], { cwd: repository, encoding: "utf8" }).trim());
  return { root, repository, bin, sourceHome, childStarted, usageDirectory: join(root, "usage"), commit };
}

type Harness = Awaited<ReturnType<typeof harness>>;

/** The standalone review's dispatcher, logging each dispatch to the harness's own usage directory. */
function dispatcher(h: Harness, input: Partial<Parameters<typeof createReviewDispatcher>[0]> = {}) {
  return createReviewDispatcher({
    host: "claude",
    repository_root: h.repository,
    signal: new AbortController().signal,
    cancellation_source: "client",
    usage_directory: h.usageDirectory,
    ...input,
  });
}

/**
 * Runs `work` with the fixture bin first on PATH and the fixture HOME. Ambient system tools
 * (git, tar) stay reachable behind the fixtures, so workspace materialization works under the
 * restricted environment; the real CLIs are shadowed because the fixtures come first — the
 * workspace captures PATH at creation and children resolve against that capture.
 */
async function withDispatchEnvironment<T>(
  values: Readonly<{ bin: string; sourceHome: string }>,
  work: () => Promise<T>,
): Promise<T> {
  const saved = { PATH: process.env.PATH, HOME: process.env.HOME };
  process.env.PATH = `${values.bin}${delimiter}${saved.PATH ?? dirname(process.execPath)}`;
  process.env.HOME = values.sourceHome;
  try {
    return await work();
  } finally {
    if (saved.PATH === undefined) delete process.env.PATH; else process.env.PATH = saved.PATH;
    if (saved.HOME === undefined) delete process.env.HOME; else process.env.HOME = saved.HOME;
  }
}

/** The single usage record one dispatch wrote. */
async function usageRecord(h: Harness): Promise<Record<string, unknown>> {
  const names = await readdir(h.usageDirectory);
  expect(names).toHaveLength(1);
  return JSON.parse(await readFile(join(h.usageDirectory, names[0]!), "utf8")) as Record<string, unknown>;
}

/** Dispatch never writes telemetry or state into the reviewed repository. */
function expectRepositoryUntouched(h: Harness): void {
  expect(existsSync(join(h.repository, ".archflow"))).toBe(false);
}

/** The view plan the standalone review builds: the work as `primary`, the starting commit as `baseline`. */
function reviewViews(repository: string, commit: ReturnType<typeof parseGitOid>): DispatchRepositoryViewPlan {
  const member = { repository_root: repository, repository_identity_digest: "0".repeat(64) as never, commit };
  return Object.freeze([
    Object.freeze({ name: "primary", member_kind: "primary", ...member }),
    Object.freeze({ name: "baseline", member_kind: "secondary", ...member }),
  ]);
}

/** The repository views directory of a shared workspace. */
const repositoriesOf = async (shared: ReturnType<typeof shareRepositoryViewWorkspace>): Promise<string> =>
  join((await shared.acquire()).review_root!, "repositories");

describe("createReviewDispatcher", () => {
  beforeEach(() => resetMemoizedCliPreflight());

  it.each([false, true])("captures Claude usage even when output validation fails (%s)", async invalid => {
    const h = await harness("success");
    const executable = join(h.bin, "claude");
    const wrapper = { usage: { input_tokens: 10, output_tokens: 30, output_tokens_details: { thinking_tokens: 20 } },
      num_turns: 2, duration_ms: 400, total_cost_usd: 0.001,
      ...(invalid ? {} : { structured_output: { outcome: "no_issues_found", feedback: "Reviewed; no actionable issues." } }) };
    await writeFile(executable, `#!/usr/bin/env node
const args = process.argv.slice(2);
if (args[0] === "--version") console.log("2.1.273 (Claude Code)");
else if (args[0] === "auth") console.log('{"loggedIn":true}');
else { process.stdin.resume(); process.stdin.on("end", () => console.log(${JSON.stringify(JSON.stringify(wrapper))})); }
`);
    await chmod(executable, 0o755);
    const dispatch = withDispatchEnvironment(h, () => dispatcher(h, { host: "codex" })({ adapter: "claude-cli", family: "claude",
      model: "claude-opus-5", effort: "medium" }, ENVELOPE, reviewSchema as PlainJsonValue));
    if (invalid) await expect(dispatch).rejects.toMatchObject({ project_error: { code: "MODEL_OUTPUT_INVALID" } });
    else expect((await dispatch).usage).toMatchObject({ output_tokens: 30, thinking_tokens: 20, num_turns: 2 });
    const central = await usageRecord(h);
    expect(central).toMatchObject({ status: invalid ? "failed" : "succeeded",
      repository: h.repository, envelope_digest: ENVELOPE.digest,
      usage: { input_tokens: 10, output_tokens: 30, thinking_tokens: 20, total_cost_usd: 0.001 } });
    if (invalid) expect(central).toMatchObject({ failure_stage: "output-parse", failure_code: "MODEL_OUTPUT_INVALID" });
    else expect(central).not.toHaveProperty("failure_code");
    expect(central).not.toHaveProperty("stdout_tail");
    expect(central).not.toHaveProperty("stderr_tail");
    expect(JSON.stringify(central)).not.toContain("Reviewed; no actionable issues");
  });

  it("logs standalone dispatches with unknown token usage without inventing task identity", async () => {
    const h = await harness("success");
    await withDispatchEnvironment(h, () => dispatcher(h)(ROUTE, ENVELOPE, reviewSchema as PlainJsonValue));
    const logged = await usageRecord(h);
    expect(logged).toMatchObject({ status: "succeeded", adapter: "codex-cli", repository: h.repository, result_kind: "review" });
    expect(logged).not.toHaveProperty("task_id");
    expect(logged).not.toHaveProperty("usage");
    expect(logged.duration_ms).toBeGreaterThanOrEqual(0);
  });

  it("classifies an unrecovered Antigravity capacity error as a transient transport failure", async () => {
    const h = await harness("success");
    const events = recoveredCapacityEvents();
    events.splice(3, 1); // No completed finish: this capacity error must remain a failure.
    const executable = join(h.bin, "agy");
    await writeFile(executable, `#!/usr/bin/env node
const args = process.argv.slice(2);
if (args[0] === "--version") process.stdout.write("antigravity-cli 1.2.3\\n");
else if (args[0] === "models") process.stdout.write("gemini-3.8-flash-high\\n");
else { process.stdin.resume(); process.stdin.on("end", () => process.stdout.write(${JSON.stringify(nativeStream(events).toString())})); }
`);
    await chmod(executable, 0o755);
    await expect(withDispatchEnvironment(h, () => dispatcher(h)({
      adapter: "antigravity-cli", family: "gemini", model: "gemini-3.8-flash-high", effort: "high",
    }, ENVELOPE, reviewSchema as PlainJsonValue))).rejects.toMatchObject({
      project_error: { code: "PROCESS_FAILED", diagnostic: { parameters: { exit_class: "transient-transport" } } },
    });
    const record = await usageRecord(h);
    expect(record).toMatchObject({
      status: "failed", failure_stage: "child-failure-classification", failure_code: "PROCESS_FAILED",
    });
    expect(JSON.stringify(record)).not.toContain(capacityError);
  });

  it("runs preflight and dispatch and writes nothing into the repository on success", async () => {
    const h = await harness("success");

    const result = await withDispatchEnvironment(h, () =>
      dispatcher(h)(ROUTE, ENVELOPE, reviewSchema as PlainJsonValue));

    expect(result.cli_version).toBe("0.146.0");
    expect(JSON.parse(Buffer.from(result.extracted_output_bytes).toString("utf8"))).toEqual({ schema_version: "1" });
    expect(await usageRecord(h)).toMatchObject({ status: "succeeded", cli_version: "0.146.0" });
    expectRepositoryUntouched(h);
  });

  it("shares one materialized repository view across the dispatches of one review", async () => {
    const h = await harness("success");
    const commit = h.commit;
    const shared = shareRepositoryViewWorkspace(reviewViews(h.repository, commit), h.repository);
    let view: string | undefined;
    const coordinate = () => dispatcher(h, { shared_workspace: shared });
    const siblingEnvelope: DispatchEnvelope = Object.freeze({
      result_kind: "review",
      bytes: Buffer.from('{"schema_version":"1","subject":{"stage":"plan"},"rubric":{"criteria":[{"id":"correctness","text":"Check correctness","blocking":true}]}}\n'),
      digest: "e".repeat(64) as DispatchEnvelope["digest"],
      byte_count: 23,
    });
    const viewOf = (invocation: { argv: string[] }): string =>
      invocation.argv[invocation.argv.indexOf("-C") + 1] as string;
    const outputOf = (invocation: { argv: string[] }): string =>
      invocation.argv[invocation.argv.indexOf("-o") + 1] as string;
    let invocations: { argv: string[]; tmpdir: string }[];
    await withDispatchEnvironment(h, async () => {
      // Acquire inside the dispatch environment: the workspace captures PATH at creation, so
      // creating it under the ambient PATH would leak the real CLIs into child resolution.
      view = await repositoriesOf(shared);
      await Promise.all([
        coordinate()(ROUTE, ENVELOPE, reviewSchema as PlainJsonValue),
        coordinate()(ROUTE, siblingEnvelope, reviewSchema as PlainJsonValue),
      ]);
      invocations = (await readFile(join(h.root, "observed-invocations.log"), "utf8"))
        .trim().split("\n").map((line) => JSON.parse(line) as { argv: string[]; tmpdir: string });
    });
    const [first, second] = invocations!;
    // Reproduces the original collision shape: concurrent Codex children with the same result kind.
    expect(viewOf(second!)).toBe(viewOf(first!));
    expect(viewOf(first!)).toBe((await shared.acquire()).review_root);
    expect(outputOf(second!)).not.toBe(outputOf(first!));
    expect(dirname(outputOf(second!))).not.toBe(dirname(outputOf(first!)));
    expect(first!.tmpdir).toBe(dirname(outputOf(first!)));
    expect(second!.tmpdir).toBe(dirname(outputOf(second!)));
    expect(existsSync(view!)).toBe(true);
    await shared.dispose();
    expect(existsSync(view!)).toBe(false);
  });

  it("keeps a borrowed workspace alive through one child's failure so its sibling can run", async () => {
    const h = await harness("fail-child-once");
    await writeFile(join(h.root, "child-down"), "down");
    const commit = h.commit;
    const shared = shareRepositoryViewWorkspace(reviewViews(h.repository, commit), h.repository);
    const coordinate = () => dispatcher(h, { shared_workspace: shared });
    let view: string | undefined;
    await withDispatchEnvironment(h, async () => {
      view = await repositoriesOf(shared);
      await expect(coordinate()(ROUTE, ENVELOPE, reviewSchema as PlainJsonValue)).rejects.toThrow();
      expect(existsSync(view!)).toBe(true);
      await rm(join(h.root, "child-down"));
      await coordinate()(ROUTE, ENVELOPE, reviewSchema as PlainJsonValue);
    });
    await shared.dispose();
    expect(existsSync(view!)).toBe(false);
  });

  it("memoizes the CLI preflight per adapter for the process", async () => {
    const h = await harness("success");
    await withDispatchEnvironment(h, async () => {
      const first = await dispatcher(h)(ROUTE, ENVELOPE, reviewSchema as PlainJsonValue);
      const second = await dispatcher(h)(ROUTE, ENVELOPE, reviewSchema as PlainJsonValue);
      expect(second.cli_version).toBe(first.cli_version);
    });
    const preflight = await readFile(join(h.root, "preflight.log"), "utf8");
    expect(preflight.split("\n").filter((line) => line === "--version")).toHaveLength(1);
    expect(preflight.split("\n").filter((line) => line === "login status")).toHaveLength(1);
  });

  it("re-runs a failed preflight instead of memoizing it", async () => {
    const h = await harness("fail-auth-once");
    await writeFile(join(h.root, "auth-down"), "down");
    await withDispatchEnvironment(h, async () => {
      await expect(dispatcher(h)(ROUTE, ENVELOPE, reviewSchema as PlainJsonValue)).rejects.toThrow();
      await rm(join(h.root, "auth-down"));
      const second = await dispatcher(h)(ROUTE, ENVELOPE, reviewSchema as PlainJsonValue);
      expect(second.cli_version).toBe("0.146.0");
    });
    const preflight = await readFile(join(h.root, "preflight.log"), "utf8");
    expect(preflight.split("\n").filter((line) => line === "login status")).toHaveLength(2);
  });

  it("dispatches from a Codex host through the assembled Claude CLI dispatcher", async () => {
    const h = await harness("success");
    const claude = join(h.bin, "claude");
    await copyFile(join(process.cwd(), "test", "fixtures", "dispatch", "fake-claude.mjs"), claude);
    await chmod(claude, 0o755);

    const result = await withDispatchEnvironment(h, () =>
      dispatcher(h, { host: "codex" })(CLAUDE_ROUTE, ENVELOPE, reviewSchema as PlainJsonValue));

    expect(result.cli_version).toBe("2.1.220");
    expect(JSON.parse(Buffer.from(result.extracted_output_bytes).toString("utf8"))).toEqual({ schema_version: "1" });
    expectRepositoryUntouched(h);
  });

  it("materializes a read-only repository view for review dispatch and targets the child at it", async () => {
    const h = await harness("success");
    const shared = shareRepositoryViewWorkspace(reviewViews(h.repository, h.commit), h.repository);
    const coordinator = dispatcher(h, { shared_workspace: shared });

    try {
      const result = await withDispatchEnvironment(h, () => coordinator(ROUTE, ENVELOPE, reviewSchema as PlainJsonValue));
      expect(result.cli_version).toBe("0.146.0");
    } finally {
      await shared.dispose();
    }

    const observed = JSON.parse(await readFile(join(h.root, "observed-invocation.json"), "utf8")) as {
      argv: string[];
      view: { tracked: boolean; git: boolean; tasks: boolean };
    };
    expect(observed.view).toEqual({ tracked: true, git: false, tasks: false });
  });

  it("materializes the explicitly configured sealed repository view for adjudication dispatch", async () => {
    const h = await harness("success");
    const shared = shareRepositoryViewWorkspace(reviewViews(h.repository, h.commit), h.repository);
    const coordinator = dispatcher(h, { shared_workspace: shared });

    try {
      await withDispatchEnvironment(h, () => coordinator(
        ROUTE,
        { ...ENVELOPE, result_kind: "adjudication" },
        adjudicationSchema as PlainJsonValue,
      ));
    } finally {
      await shared.dispose();
    }

    const observed = JSON.parse(await readFile(join(h.root, "observed-invocation.json"), "utf8")) as {
      argv: string[];
      view: { tracked: boolean; git: boolean; tasks: boolean };
    };
    expect(observed.view).toEqual({ tracked: true, git: false, tasks: false });
  });

  it("records the stage when repository materialization fails", async () => {
    const h = await harness("success");
    const shared = shareRepositoryViewWorkspace(reviewViews(h.repository, "f".repeat(40) as never), h.repository);
    const coordinator = dispatcher(h, { shared_workspace: shared });

    await expect(coordinator(ROUTE, ENVELOPE, reviewSchema as PlainJsonValue))
      .rejects.toMatchObject({ project_error: { code: "REPOSITORY_VIEW_UNAVAILABLE" } });
    await shared.dispose();
    expect(await usageRecord(h)).toMatchObject({
      status: "failed",
      failure_stage: "repository-view-materialization",
      failure_code: "REPOSITORY_VIEW_UNAVAILABLE",
    });
  });

  it("cancels during version preflight and still records the failed dispatch", async () => {
    const h = await harness("hang-version");
    const controller = new AbortController();
    const coordinator = dispatcher(h, { signal: controller.signal });

    const pending = withDispatchEnvironment(h, () =>
      coordinator(ROUTE, ENVELOPE, reviewSchema as PlainJsonValue));
    setTimeout(() => controller.abort(), 100).unref();
    await expect(pending).rejects.toBeInstanceOf(DispatchProcessError);
    await expect(pending).rejects.toMatchObject({
      project_error: { code: "CANCELLED", diagnostic: { parameters: { source: "client" } } },
    });
    expect(await usageRecord(h)).toMatchObject({
      adapter: "codex-cli",
      status: "failed",
      failure_stage: "cli-preflight",
      failure_code: "CANCELLED",
    });
  });

  it("cancels after the dispatch child starts and records only the failed dispatch", async () => {
    const h = await harness("hang-child");
    const controller = new AbortController();
    const coordinator = dispatcher(h, { signal: controller.signal });

    const pending = withDispatchEnvironment(h, () =>
      coordinator(ROUTE, ENVELOPE, reviewSchema as PlainJsonValue));
    for (let attempts = 0; attempts < 100; attempts += 1) {
      if (await readFile(h.childStarted, "utf8").then(() => true, () => false)) break;
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    await expect(readFile(h.childStarted, "utf8")).resolves.toBe("started\n");
    controller.abort();

    await expect(pending).rejects.toBeInstanceOf(DispatchProcessError);
    await expect(pending).rejects.toMatchObject({
      project_error: { code: "CANCELLED", diagnostic: { parameters: { source: "client" } } },
    });
    expect(await usageRecord(h)).toMatchObject({
      adapter: "codex-cli",
      status: "failed",
      failure_stage: "child-run",
      failure_code: "CANCELLED",
      cli_version: "0.146.0",
    });
    expectRepositoryUntouched(h);
  });

  it("records a failed child's classification without retaining its output channels", async () => {
    const h = await harness("fail-child");

    const pending = withDispatchEnvironment(h, () =>
      dispatcher(h)(ROUTE, ENVELOPE, reviewSchema as PlainJsonValue));
    await expect(pending).rejects.toMatchObject({
      project_error: { code: "PROCESS_FAILED", diagnostic: { parameters: { exit_class: "exit-3" } } },
    });
    const record = await usageRecord(h);
    expect(record).toMatchObject({
      schema_version: "1",
      adapter: "codex-cli",
      status: "failed",
      failure_stage: "child-failure-classification",
      failure_code: "PROCESS_FAILED",
      cli_version: "0.146.0",
      started_at: expect.stringMatching(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/),
      duration_ms: expect.any(Number),
    });
    expect(JSON.stringify(record)).not.toContain("stream error");
    const canaries = ["credential-canary-7429", "routing-sentinel-1836"];
    const persistedDiagnostics = Buffer.from(JSON.stringify(record));
    expect(scanDispatchOutput({ stdout: persistedDiagnostics, stderr: Buffer.alloc(0) }, canaries)).toEqual([]);
  });

  it("refuses an unknown host before any workspace or child launch", async () => {
    const h = await harness("success");
    // Adapter selection refuses an unknown host before any workspace or child launch, so the
    // classification is deterministic with no CLI involved.
    await expect(dispatcher(h, { host: "unknown" })(ROUTE, ENVELOPE, reviewSchema as PlainJsonValue))
      .rejects.toMatchObject({ project_error: { code: "UNSUPPORTED_HOST" } });
    expect(existsSync(join(h.root, "preflight.log"))).toBe(false);
  });
});

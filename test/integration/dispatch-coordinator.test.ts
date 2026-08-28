import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { chmod, copyFile, mkdtemp, mkdir, readFile, readdir, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { delimiter, dirname, join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import adjudicationSchema from "../../src/contracts/schemas/v1/adjudication.schema.json" with { type: "json" };
import reviewSchema from "../../src/contracts/schemas/v1/review.schema.json" with { type: "json" };
import { parseGitOid } from "../../src/contracts/canonical.js";
import { connectionContextFactory, createInvocationContext } from "../../src/contracts/contexts.js";
import { parseSafeCode, parseSafeInteger, parseTaskSlug } from "../../src/contracts/evidence.js";
import { encodePhaseInstance, parsePositiveSafePhaseNumber } from "../../src/contracts/phase-instance.js";
import type { PlainJsonValue } from "../../src/contracts/plain-json.js";
import { createDispatchCoordinator } from "../../src/dispatch/coordinator.js";
import { resetMemoizedCliPreflight } from "../../src/dispatch/cli.js";
import {
  shareRepositoryViewWorkspace,
  type DispatchRepositoryViewPlan,
} from "../../src/dispatch/workspace.js";
import { DispatchProcessError, scanDispatchOutput } from "../../src/dispatch/process.js";
import type { DispatchRoute } from "../../src/dispatch/routing.js";
import { createGitRunner, preflightGit, type RepositoryOperationContext } from "../../src/repository/git.js";
import { discoverWorktree } from "../../src/repository/identity.js";
import type { ResolvedTaskWorkspacePath } from "../../src/repository/paths.js";
import type { DispatchEnvelope } from "../../src/review/envelopes.js";
import { mapHandlerErrors } from "../../src/mcp/handlers/errors.js";
import { createToolBoundary } from "../../src/mcp/server.js";
import { createAtomicWriter, createProjectionWriter } from "../../src/state/atomic.js";
import { createInternalTransactionAuthority } from "../../src/state/authority.js";
import type { TransactionDependencies } from "../../src/state/transaction.js";

const roots: string[] = [];

function semanticView() {
  return {
    schema_version: "1", task_id: TASK, condition: "ready", headline: "Ready", detail: "Continue.",
    resources: [], next_action: { kind: "inspect", instruction: "Inspect status." },
  };
}
const TASK = parseTaskSlug("dispatch-coordinator");
const PHASE = encodePhaseInstance({ kind: "phase-impl", phase: parsePositiveSafePhaseNumber(15) });
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
  bytes: Buffer.from('{"schema_version":"1"}\n'),
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
  await mkdir(join(repository, ".archflow", "tasks", TASK), { recursive: true });

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
      tracked: existsSync(join(target, "tracked.txt")),
      git: existsSync(join(target, ".git")),
      tasks: existsSync(join(target, ".archflow", "tasks")),
    },
  }));
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

  const context: RepositoryOperationContext = {
    task_id: TASK,
    phase_instance: PHASE,
    operation: parseSafeCode("dispatch-coordinator-test"),
    attempt: parseSafeInteger(1),
  };
  const discovered = await discoverWorktree(createGitRunner({ cwd: repository }), context);
  if (!discovered.ok) throw new Error("worktree discovery failed");
  const environment = await preflightGit(discovered.value, context);
  if (!environment.ok) throw new Error("git preflight failed");
  const authority = await createInternalTransactionAuthority({
    runner: discovered.value,
    environment: environment.value,
    task_id: TASK,
    context,
  });
  if (!authority.ok) throw new Error("authority creation failed");

  const dependencies: TransactionDependencies = {
    runner: discovered.value,
    environment: environment.value,
    atomic: createAtomicWriter(),
    projection_writer: createProjectionWriter(),
    lock: { runExclusive: async <T>(_taskRoot: ResolvedTaskWorkspacePath, work: () => Promise<T>) => work() },
    resolve_input_fingerprint: async () => { throw new Error("not used"); },
    read_state: async () => ({ kind: "missing" }),
    read_config: async () => ({ kind: "missing" }),
    read_receipt: async () => ({ kind: "missing" }),
  };
  return { root, repository, bin, sourceHome, childStarted, authority: authority.value, dependencies };
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

async function attemptRecord(repository: string): Promise<Record<string, unknown>> {
  const directory = join(repository, ".archflow", "runtime", "tasks", TASK, "diagnostics", "attempts", PHASE);
  const names = await readdir(directory);
  expect(names).toHaveLength(1);
  return JSON.parse(await readFile(join(directory, names[0]!), "utf8")) as Record<string, unknown>;
}

async function attemptsAbsent(repository: string): Promise<void> {
  await expect(readdir(join(repository, ".archflow", "runtime", "tasks", TASK, "diagnostics", "attempts")))
    .rejects.toMatchObject({ code: "ENOENT" });
}

function primaryViews(repository: string, commit: ReturnType<typeof parseGitOid>): DispatchRepositoryViewPlan {
  return Object.freeze([Object.freeze({
    name: "primary",
    member_kind: "primary",
    repository_root: repository,
    repository_identity_digest: "0".repeat(64) as never,
    commit,
  })]);
}

describe("createDispatchCoordinator", () => {
  beforeEach(() => resetMemoizedCliPreflight());

  it("runs preflight and dispatch, disposes its workspace, and writes no attempt telemetry on success", async () => {
    const h = await harness("success");
    const coordinator = createDispatchCoordinator({
      authority: h.authority,
      dependencies: h.dependencies,
      host: "claude",
      repository_root: h.repository,
      phase_instance: PHASE,
      signal: new AbortController().signal,
      cancellation_source: "client",
    });

    const result = await withDispatchEnvironment(h, () =>
      coordinator(ROUTE, ENVELOPE, reviewSchema as PlainJsonValue));

    expect(result.cli_version).toBe("0.146.0");
    expect(JSON.parse(Buffer.from(result.extracted_output_bytes).toString("utf8"))).toEqual({ schema_version: "1" });
    await attemptsAbsent(h.repository);
  });

  it("shares one materialized repository view across the coordinators of one review", async () => {
    const h = await harness("success");
    const commit = parseGitOid(execFileSync("git", ["rev-parse", "HEAD"], { cwd: h.repository }).toString().trim());
    const shared = shareRepositoryViewWorkspace(primaryViews(h.repository, commit), h.repository);
    let view: string | undefined;
    const coordinate = () => createDispatchCoordinator({
      authority: h.authority,
      dependencies: h.dependencies,
      host: "claude",
      repository_root: h.repository,
      phase_instance: PHASE,
      signal: new AbortController().signal,
      cancellation_source: "client",
      shared_workspace: shared,
    });
    const codexEnvelope: DispatchEnvelope = Object.freeze({
      result_kind: "adjudication",
      bytes: Buffer.from('{"schema_version":"1"}\n'),
      digest: "e".repeat(64) as DispatchEnvelope["digest"],
      byte_count: 23,
    });
    const viewOf = (invocation: { argv: string[] }): string =>
      invocation.argv[invocation.argv.indexOf("-C") + 1] as string;
    const outputOf = (invocation: { argv: string[] }): string =>
      invocation.argv[invocation.argv.indexOf("-o") + 1] as string;
    let first: { argv: string[] };
    let second: { argv: string[] };
    await withDispatchEnvironment(h, async () => {
      // Acquire inside the dispatch environment: the workspace captures PATH at creation, so
      // creating it under the ambient PATH would leak the real CLIs into child resolution.
      view = (await shared.acquire()).repository_view_root!;
      await coordinate()(ROUTE, ENVELOPE, reviewSchema as PlainJsonValue);
      first = JSON.parse(await readFile(join(h.root, "observed-invocation.json"), "utf8")) as { argv: string[] };
      await coordinate()(ROUTE, codexEnvelope, adjudicationSchema as PlainJsonValue);
      second = JSON.parse(await readFile(join(h.root, "observed-invocation.json"), "utf8")) as { argv: string[] };
    });
    // One materialized view for both children of the review, with per-kind output files.
    expect(viewOf(second!)).toBe(viewOf(first!));
    expect(viewOf(first!)).toBe(view);
    expect(outputOf(second!)).not.toBe(outputOf(first!));
    expect(existsSync(view!)).toBe(true);
    await shared.dispose();
    expect(existsSync(view!)).toBe(false);
  });

  it("keeps a borrowed workspace alive through one child's failure so its sibling can run", async () => {
    const h = await harness("fail-child-once");
    await writeFile(join(h.root, "child-down"), "down");
    const commit = parseGitOid(execFileSync("git", ["rev-parse", "HEAD"], { cwd: h.repository }).toString().trim());
    const shared = shareRepositoryViewWorkspace(primaryViews(h.repository, commit), h.repository);
    const coordinate = () => createDispatchCoordinator({
      authority: h.authority,
      dependencies: h.dependencies,
      host: "claude",
      repository_root: h.repository,
      phase_instance: PHASE,
      signal: new AbortController().signal,
      cancellation_source: "client",
      shared_workspace: shared,
    });
    let view: string | undefined;
    await withDispatchEnvironment(h, async () => {
      view = (await shared.acquire()).repository_view_root!;
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
    const coordinate = () => createDispatchCoordinator({
      authority: h.authority,
      dependencies: h.dependencies,
      host: "claude",
      repository_root: h.repository,
      phase_instance: PHASE,
      signal: new AbortController().signal,
      cancellation_source: "client",
    });
    await withDispatchEnvironment(h, async () => {
      const first = await coordinate()(ROUTE, ENVELOPE, reviewSchema as PlainJsonValue);
      const second = await coordinate()(ROUTE, ENVELOPE, reviewSchema as PlainJsonValue);
      expect(second.cli_version).toBe(first.cli_version);
    });
    const preflight = await readFile(join(h.root, "preflight.log"), "utf8");
    expect(preflight.split("\n").filter((line) => line === "--version")).toHaveLength(1);
    expect(preflight.split("\n").filter((line) => line === "login status")).toHaveLength(1);
  });

  it("re-runs a failed preflight instead of memoizing it", async () => {
    const h = await harness("fail-auth-once");
    await writeFile(join(h.root, "auth-down"), "down");
    const coordinate = () => createDispatchCoordinator({
      authority: h.authority,
      dependencies: h.dependencies,
      host: "claude",
      repository_root: h.repository,
      phase_instance: PHASE,
      signal: new AbortController().signal,
      cancellation_source: "client",
    });
    await withDispatchEnvironment(h, async () => {
      await expect(coordinate()(ROUTE, ENVELOPE, reviewSchema as PlainJsonValue)).rejects.toThrow();
      await rm(join(h.root, "auth-down"));
      const second = await coordinate()(ROUTE, ENVELOPE, reviewSchema as PlainJsonValue);
      expect(second.cli_version).toBe("0.146.0");
    });
    const preflight = await readFile(join(h.root, "preflight.log"), "utf8");
    expect(preflight.split("\n").filter((line) => line === "login status")).toHaveLength(2);
  });

  it("dispatches from a Codex host through the assembled Claude CLI coordinator", async () => {
    const h = await harness("success");
    const claude = join(h.bin, "claude");
    await copyFile(join(process.cwd(), "test", "fixtures", "dispatch", "fake-claude.mjs"), claude);
    await chmod(claude, 0o755);
    const coordinator = createDispatchCoordinator({
      authority: h.authority,
      dependencies: h.dependencies,
      host: "codex",
      repository_root: h.repository,
      phase_instance: PHASE,
      signal: new AbortController().signal,
      cancellation_source: "client",
    });

    const result = await withDispatchEnvironment(h, () =>
      coordinator(CLAUDE_ROUTE, ENVELOPE, reviewSchema as PlainJsonValue));

    expect(result.cli_version).toBe("2.1.220");
    expect(JSON.parse(Buffer.from(result.extracted_output_bytes).toString("utf8"))).toEqual({ schema_version: "1" });
    await attemptsAbsent(h.repository);
  });

  it("materializes a read-only repository view for review dispatch and targets the child at it", async () => {
    const h = await harness("success");
    const head = parseGitOid(execFileSync("git", ["rev-parse", "HEAD"], {
      cwd: h.repository, encoding: "utf8",
    }).trim());
    const coordinator = createDispatchCoordinator({
      authority: h.authority,
      dependencies: h.dependencies,
      host: "claude",
      repository_root: h.repository,
      phase_instance: PHASE,
      signal: new AbortController().signal,
      cancellation_source: "client",
      repository_views: primaryViews(h.repository, head),
    });

    const saved = { PATH: process.env.PATH, HOME: process.env.HOME };
    // The materialization pipeline spawns real git and tar, so the full ambient PATH stays behind
    // the fixture bin instead of the minimal node-only PATH the other cases use.
    process.env.PATH = `${h.bin}${delimiter}${saved.PATH ?? dirname(process.execPath)}`;
    process.env.HOME = h.sourceHome;
    try {
      const result = await coordinator(ROUTE, ENVELOPE, reviewSchema as PlainJsonValue);
      expect(result.cli_version).toBe("0.146.0");
    } finally {
      if (saved.PATH === undefined) delete process.env.PATH; else process.env.PATH = saved.PATH;
      if (saved.HOME === undefined) delete process.env.HOME; else process.env.HOME = saved.HOME;
    }

    const observed = JSON.parse(await readFile(join(h.root, "observed-invocation.json"), "utf8")) as {
      argv: string[];
      view: { tracked: boolean; git: boolean; tasks: boolean };
    };
    const target = observed.argv[observed.argv.indexOf("-C") + 1]!;
    const outputPath = observed.argv[observed.argv.indexOf("-o") + 1]!;
    expect(target).toBe(join(dirname(outputPath), "repo"));
    expect(observed.view).toEqual({ tracked: true, git: false, tasks: false });
  });

  it("materializes the explicitly configured sealed repository view for adjudication dispatch", async () => {
    const h = await harness("success");
    const head = parseGitOid(execFileSync("git", ["rev-parse", "HEAD"], {
      cwd: h.repository, encoding: "utf8",
    }).trim());
    const coordinator = createDispatchCoordinator({
      authority: h.authority,
      dependencies: h.dependencies,
      host: "claude",
      repository_root: h.repository,
      phase_instance: PHASE,
      signal: new AbortController().signal,
      cancellation_source: "client",
      repository_views: primaryViews(h.repository, head),
    });

    const saved = { PATH: process.env.PATH, HOME: process.env.HOME };
    process.env.PATH = `${h.bin}${delimiter}${saved.PATH ?? dirname(process.execPath)}`;
    process.env.HOME = h.sourceHome;
    try {
      await coordinator(
        ROUTE,
        { ...ENVELOPE, result_kind: "adjudication" },
        adjudicationSchema as PlainJsonValue,
      );
    } finally {
      if (saved.PATH === undefined) delete process.env.PATH; else process.env.PATH = saved.PATH;
      if (saved.HOME === undefined) delete process.env.HOME; else process.env.HOME = saved.HOME;
    }

    const observed = JSON.parse(await readFile(join(h.root, "observed-invocation.json"), "utf8")) as {
      argv: string[];
      view: { tracked: boolean; git: boolean; tasks: boolean };
    };
    const target = observed.argv[observed.argv.indexOf("-C") + 1]!;
    const outputPath = observed.argv[observed.argv.indexOf("-o") + 1]!;
    expect(target).toBe(join(dirname(outputPath), "repo"));
    expect(observed.view).toEqual({ tracked: true, git: false, tasks: false });
  });

  it("records the stage and safe exception detail when repository materialization fails", async () => {
    const h = await harness("success");
    const coordinator = createDispatchCoordinator({
      authority: h.authority,
      dependencies: h.dependencies,
      host: "claude",
      repository_root: h.repository,
      phase_instance: PHASE,
      signal: new AbortController().signal,
      cancellation_source: "client",
      repository_views: primaryViews(h.repository, "f".repeat(40) as never),
    });

    await expect(coordinator(ROUTE, ENVELOPE, reviewSchema as PlainJsonValue))
      .rejects.toMatchObject({ project_error: { code: "REPOSITORY_VIEW_UNAVAILABLE" } });
    expect(await attemptRecord(h.repository)).toMatchObject({
      status: "failed",
      failure_stage: "repository-view-materialization",
      failure_code: "REPOSITORY_VIEW_UNAVAILABLE",
    });
  });

  it("cancels during version preflight and still finalizes a failed attempt", async () => {
    const h = await harness("hang-version");
    const controller = new AbortController();
    const coordinator = createDispatchCoordinator({
      authority: h.authority,
      dependencies: h.dependencies,
      host: "claude",
      repository_root: h.repository,
      phase_instance: PHASE,
      signal: controller.signal,
      cancellation_source: "transport",
    });

    const pending = withDispatchEnvironment(h, () =>
      coordinator(ROUTE, ENVELOPE, reviewSchema as PlainJsonValue));
    setTimeout(() => controller.abort(), 100).unref();
    await expect(pending).rejects.toBeInstanceOf(DispatchProcessError);
    expect(await attemptRecord(h.repository)).toMatchObject({
      adapter: "codex-cli",
      status: "failed",
      failure_code: "CANCELLED",
      cancellation_source: "transport",
    });
  });

  it("cancels after the dispatch child starts and retains only failed-attempt telemetry", async () => {
    const h = await harness("hang-child");
    const controller = new AbortController();
    const coordinator = createDispatchCoordinator({
      authority: h.authority,
      dependencies: h.dependencies,
      host: "claude",
      repository_root: h.repository,
      phase_instance: PHASE,
      signal: controller.signal,
      cancellation_source: "client",
    });

    const pending = withDispatchEnvironment(h, () =>
      coordinator(ROUTE, ENVELOPE, reviewSchema as PlainJsonValue));
    for (let attempts = 0; attempts < 100; attempts += 1) {
      if (await readFile(h.childStarted, "utf8").then(() => true, () => false)) break;
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    await expect(readFile(h.childStarted, "utf8")).resolves.toBe("started\n");
    controller.abort();

    await expect(pending).rejects.toBeInstanceOf(DispatchProcessError);
    expect(await attemptRecord(h.repository)).toMatchObject({
      adapter: "codex-cli",
      status: "failed",
      failure_code: "CANCELLED",
      cancellation_source: "client",
      cli_version: "0.146.0",
    });
    await expect(readdir(join(h.repository, ".archflow", "tasks", TASK, "results")))
      .rejects.toMatchObject({ code: "ENOENT" });
  });

  it("persists exit class and bounded channel tails when the dispatch child fails", async () => {
    const h = await harness("fail-child");
    const coordinator = createDispatchCoordinator({
      authority: h.authority,
      dependencies: h.dependencies,
      host: "claude",
      repository_root: h.repository,
      phase_instance: PHASE,
      signal: new AbortController().signal,
      cancellation_source: "client",
    });

    const pending = withDispatchEnvironment(h, () =>
      coordinator(ROUTE, ENVELOPE, reviewSchema as PlainJsonValue));
    await expect(pending).rejects.toMatchObject({
      project_error: { code: "PROCESS_FAILED" },
    });
    const persistedAttempt = await attemptRecord(h.repository);
    expect(persistedAttempt).toMatchObject({
      schema_version: "1",
      task_id: TASK,
      phase_instance: PHASE,
      adapter: "codex-cli",
      status: "failed",
      failure_code: "PROCESS_FAILED",
      exit_class: "exit-3",
      stderr_tail: "stream error: exceeded retry limit\n",
      cli_version: "0.146.0",
      managed_policy_present: expect.any(Boolean),
      managed_policy_paths: expect.any(Array),
      started_at: expect.stringMatching(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/),
      duration_ms: expect.any(Number),
    });
    expect(persistedAttempt).not.toHaveProperty("cancellation_source");
    expect(persistedAttempt).not.toHaveProperty("stdout_tail");
    const canaries = ["credential-canary-7429", "routing-sentinel-1836"];
    const persistedDiagnostics = Buffer.from(JSON.stringify(persistedAttempt));
    expect(scanDispatchOutput({ stdout: persistedDiagnostics, stderr: Buffer.alloc(0) }, canaries)).toEqual([]);
  });

  it("preserves a real coordinator classification through the live tool boundary", async () => {
    const h = await harness("success");
    const coordinator = createDispatchCoordinator({
      authority: h.authority,
      dependencies: h.dependencies,
      // Adapter selection refuses an unknown host before any workspace or child
      // launch, so the classification is deterministic with no CLI involved.
      host: "unknown",
      repository_root: h.repository,
      phase_instance: PHASE,
      signal: new AbortController().signal,
      cancellation_source: "client",
    });
    const boundary = createToolBoundary({
      // The semantic envelope is the only surface a coordinator classification crosses now:
      // the handler maps the project failure into the semantic failure summary, as the
      // retained dispatch seam inside the semantic apply handler does.
      archflow_status: async (_input, context) => {
        const classified = await mapHandlerErrors<"archflow_state">(
          context.invocation_id,
          async () => coordinator(ROUTE, ENVELOPE, reviewSchema as PlainJsonValue) as never,
        );
        return classified.ok
          ? { schema_version: "1", ok: true, value: semanticView() }
          : { schema_version: "1", ok: false, error: { code: classified.error.code, message: classified.error.code, retryable: false } };
      },
    });
    const connection = connectionContextFactory.captureStartup({
      connection_id: "coordinator-boundary",
      startup_repository_candidate: { working_directory: h.repository },
    }).initialize({
      client: { name: "codex-mcp-client", version: "0.146.0" },
      host: "codex",
      protocol_version: "2025-11-25",
    });
    const context = createInvocationContext(connection, {
      invocation_id: "coordinator-boundary-call",
      transport_metadata: { request_id: "request-1", operation: "tools/call" },
    }, new AbortController().signal);

    const outcome = await boundary.invoke("archflow_status", {
      schema_version: "1", task_id: TASK,
    }, context);

    expect(outcome.kind).toBe("semantic-result");
    if (outcome.kind === "semantic-result") {
      expect(outcome.result).toMatchObject({ ok: false, error: { code: "UNSUPPORTED_HOST" } });
    }
  });
});

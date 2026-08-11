import { execFileSync } from "node:child_process";
import { chmod, copyFile, mkdtemp, mkdir, readFile, readdir, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { delimiter, dirname, join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import adjudicationSchema from "../../src/contracts/schemas/v1/adjudication.schema.json" with { type: "json" };
import reviewSchema from "../../src/contracts/schemas/v1/review.schema.json" with { type: "json" };
import { parseGitOid } from "../../src/contracts/canonical.js";
import { connectionContextFactory, createInvocationContext } from "../../src/contracts/contexts.js";
import { parseSafeCode, parseSafeInteger, parseTaskSlug } from "../../src/contracts/evidence.js";
import { encodePhaseInstance, parsePositiveSafePhaseNumber } from "../../src/contracts/phase-instance.js";
import type { PlainJsonValue } from "../../src/contracts/plain-json.js";
import { createDispatchCoordinator } from "../../src/dispatch/coordinator.js";
import { DispatchProcessError, scanDispatchOutput } from "../../src/dispatch/process.js";
import type { DispatchRoute } from "../../src/dispatch/routing.js";
import { createGitRunner, preflightGit, type RepositoryOperationContext } from "../../src/repository/git.js";
import { discoverWorktree } from "../../src/repository/identity.js";
import type { ResolvedTaskPath } from "../../src/repository/paths.js";
import type { DispatchEnvelope } from "../../src/review/envelopes.js";
import { mapHandlerErrors } from "../../src/mcp/handlers/errors.js";
import { createToolBoundary } from "../../src/mcp/server.js";
import { createAtomicWriter, createProjectionWriter } from "../../src/state/atomic.js";
import { createInternalTransactionAuthority } from "../../src/state/authority.js";
import type { TransactionDependencies } from "../../src/state/transaction.js";

const roots: string[] = [];
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

async function harness(mode: "success" | "hang-version" | "hang-child" | "fail-child") {
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
  ${mode === "hang-version" ? "setInterval(() => undefined, 1000);" : 'process.stdout.write("codex-cli 0.146.0\\n");'}
} else if (argv[0] === "login" && argv[1] === "status") {
  process.stdout.write("Logged in using ChatGPT\\n");
} else {
  ${mode === "hang-child" ? `await writeFile(${JSON.stringify("__CHILD_STARTED__")}, "started\\n"); setInterval(() => undefined, 1000);` : ""}
  ${mode === "fail-child" ? 'process.stderr.write("stream error: exceeded retry limit\\n"); process.exit(3);' : ""}
  const { existsSync } = await import("node:fs");
  const { join } = await import("node:path");
  const target = argv.includes("-C") ? argv[argv.indexOf("-C") + 1] : null;
  await writeFile(${JSON.stringify(join(root, "observed-invocation.json"))}, JSON.stringify({
    argv,
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
    lock: { runExclusive: async <T>(_taskRoot: ResolvedTaskPath, work: () => Promise<T>) => work() },
    resolve_input_fingerprint: async () => { throw new Error("not used"); },
    read_state: async () => ({ kind: "missing" }),
    read_config: async () => ({ kind: "missing" }),
    read_receipt: async () => ({ kind: "missing" }),
  };
  return { root, repository, bin, sourceHome, childStarted, authority: authority.value, dependencies };
}

async function withDispatchEnvironment<T>(
  values: Readonly<{ bin: string; sourceHome: string }>,
  work: () => Promise<T>,
): Promise<T> {
  const saved = { PATH: process.env.PATH, HOME: process.env.HOME };
  process.env.PATH = `${values.bin}${delimiter}${dirname(process.execPath)}`;
  process.env.HOME = values.sourceHome;
  try {
    return await work();
  } finally {
    if (saved.PATH === undefined) delete process.env.PATH; else process.env.PATH = saved.PATH;
    if (saved.HOME === undefined) delete process.env.HOME; else process.env.HOME = saved.HOME;
  }
}

async function attemptRecord(repository: string): Promise<Record<string, unknown>> {
  const directory = join(repository, ".archflow", "tasks", TASK, "attempts", PHASE);
  const names = await readdir(directory);
  expect(names).toHaveLength(1);
  return JSON.parse(await readFile(join(directory, names[0]!), "utf8")) as Record<string, unknown>;
}

async function attemptsAbsent(repository: string): Promise<void> {
  await expect(readdir(join(repository, ".archflow", "tasks", TASK, "attempts")))
    .rejects.toMatchObject({ code: "ENOENT" });
}

describe("createDispatchCoordinator", () => {
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
      allow_claude_dispatch: false,
    });

    const result = await withDispatchEnvironment(h, () =>
      coordinator(ROUTE, ENVELOPE, reviewSchema as PlainJsonValue));

    expect(result.cli_version).toBe("0.146.0");
    expect(JSON.parse(Buffer.from(result.extracted_output_bytes).toString("utf8"))).toEqual({ schema_version: "1" });
    await attemptsAbsent(h.repository);
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
      allow_claude_dispatch: true,
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
      allow_claude_dispatch: false,
      repository_view_commit: head,
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

  it("never materializes a repository view for adjudication dispatch", async () => {
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
      allow_claude_dispatch: false,
      repository_view_commit: head,
    });

    await withDispatchEnvironment(h, () =>
      coordinator(ROUTE, { ...ENVELOPE, result_kind: "adjudication" }, adjudicationSchema as PlainJsonValue));

    const observed = JSON.parse(await readFile(join(h.root, "observed-invocation.json"), "utf8")) as {
      argv: string[];
      view: { tracked: boolean; git: boolean; tasks: boolean };
    };
    const target = observed.argv[observed.argv.indexOf("-C") + 1]!;
    const outputPath = observed.argv[observed.argv.indexOf("-o") + 1]!;
    expect(target).toBe(dirname(outputPath));
    expect(target.endsWith("repo")).toBe(false);
    expect(observed.view).toEqual({ tracked: false, git: false, tasks: false });
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
      allow_claude_dispatch: false,
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
      allow_claude_dispatch: false,
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
      allow_claude_dispatch: false,
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
      host: "codex",
      repository_root: h.repository,
      phase_instance: PHASE,
      signal: new AbortController().signal,
      cancellation_source: "client",
      allow_claude_dispatch: false,
    });
    const boundary = createToolBoundary({
      archflow_state: (_call, context) => mapHandlerErrors<"archflow_state">(
        context.invocation_id,
        async () => coordinator(ROUTE, ENVELOPE, reviewSchema as PlainJsonValue) as never,
      ),
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

    const outcome = await boundary.invoke("archflow_state", {
      schema_version: "1", task_id: TASK, intent_id: "boundary-intent", expected_revision: 0,
      input_fingerprint: "a".repeat(64), phase_instance: PHASE, step: "produce", status: "running",
    }, context);

    expect(outcome.kind).toBe("project-result");
    if (outcome.kind === "project-result") {
      expect(outcome.result).toMatchObject({ ok: false, error: { code: "CONFIG_FAMILY_UNSUPPORTED" } });
    }
  });
});

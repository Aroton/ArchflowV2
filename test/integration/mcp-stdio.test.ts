import { spawn, spawnSync, type ChildProcessWithoutNullStreams } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, relative, resolve } from "node:path";
import { PassThrough } from "node:stream";
import { fileURLToPath } from "node:url";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { createProjectError, createProtocolError } from "../../src/contracts/errors.js";
import { runDispatchChild } from "../../src/dispatch/process.js";
import { startMcpRuntime, type McpRuntimeHandle } from "../../src/mcp/sdk-adapter.js";
import type { ToolHandlerRegistry } from "../../src/mcp/server.js";
import { ADVERTISED_TOOL_CATALOGUE } from "../../src/mcp/tools.js";
import adversarial from "../fixtures/mcp/runtime/adversarial-bytes.json" with { type: "json" };
import calls from "../fixtures/mcp/runtime/calls.json" with { type: "json" };
import initialize from "../fixtures/mcp/runtime/initialize.json" with { type: "json" };

const TEST_TIMEOUT_MS = 20_000;
const PROCESS_TIMEOUT_MS = 8_000;
const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const jsonLine = (value: unknown): string => `${JSON.stringify(value)}\n`;

function expectExactBytes(actual: Buffer, expected: Buffer): void {
  if (actual.equals(expected)) return;
  const commonLength = Math.min(actual.length, expected.length);
  let offset = 0;
  while (offset < commonLength && actual[offset] === expected[offset]) offset += 1;
  const start = Math.max(0, offset - 80);
  const end = offset + 160;
  throw new Error(
    `byte mismatch at offset ${offset}: received ${actual.length} bytes, expected ${expected.length}\n` +
    `received: ${JSON.stringify(actual.toString("utf8", start, end))}\n` +
    `expected: ${JSON.stringify(expected.toString("utf8", start, end))}`,
  );
}

interface RunningRuntime {
  readonly child: ChildProcessWithoutNullStreams;
  readonly stdout: Buffer[];
  readonly stderr: Buffer[];
  readonly waitForLines: (count: number) => Promise<void>;
  readonly waitForExit: () => Promise<Readonly<{ code: number | null; signal: NodeJS.Signals | null }>>;
  readonly stop: () => void;
}

let outputDirectory = "";
let runtimeBundle = "";
const lifecycleRoots: string[] = [];

function startRuntime(): RunningRuntime {
  const child = spawn(process.execPath, [runtimeBundle], {
    cwd: repositoryRoot,
    stdio: ["pipe", "pipe", "pipe"],
  });
  const stdout: Buffer[] = [];
  const stderr: Buffer[] = [];
  child.stdin.on("error", () => undefined);
  child.stdout.on("data", (chunk: Buffer) => stdout.push(Buffer.from(chunk)));
  child.stderr.on("data", (chunk: Buffer) => stderr.push(Buffer.from(chunk)));

  const exited = new Promise<Readonly<{ code: number | null; signal: NodeJS.Signals | null }>>(
    (resolveExit, rejectExit) => {
      child.once("error", rejectExit);
      child.once("exit", (code, signal) => resolveExit({ code, signal }));
    },
  );

  return {
    child,
    stdout,
    stderr,
    waitForLines: async (count) => {
      const currentCount = (): number => Buffer.concat(stdout).reduce(
        (total, byte) => total + (byte === 0x0a ? 1 : 0),
        0,
      );
      if (currentCount() >= count) return;
      await new Promise<void>((resolveWait, rejectWait) => {
        const timeout = setTimeout(() => finish(new Error(`timed out waiting for ${count} stdout lines`)), PROCESS_TIMEOUT_MS);
        const onData = (): void => {
          if (currentCount() >= count) finish();
        };
        const onExit = (): void => finish(new Error(`runtime exited after ${currentCount()} stdout lines`));
        const finish = (error?: Error): void => {
          clearTimeout(timeout);
          child.stdout.off("data", onData);
          child.off("exit", onExit);
          if (error === undefined) resolveWait();
          else rejectWait(error);
        };
        child.stdout.on("data", onData);
        child.on("exit", onExit);
      });
    },
    waitForExit: async () => {
      let timer: NodeJS.Timeout | undefined;
      try {
        return await Promise.race([
          exited,
          new Promise<never>((_resolve, reject) => {
            timer = setTimeout(() => reject(new Error("runtime did not exit")), PROCESS_TIMEOUT_MS);
          }),
        ]);
      } finally {
        if (timer !== undefined) clearTimeout(timer);
      }
    },
    stop: () => {
      if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
    },
  };
}

async function complete(
  chunks: readonly Uint8Array[],
): Promise<Readonly<{ stdout: Buffer; stderr: Buffer; code: number | null; signal: NodeJS.Signals | null }>> {
  const runtime = startRuntime();
  try {
    for (const chunk of chunks) runtime.child.stdin.write(chunk);
    runtime.child.stdin.end();
    const exit = await runtime.waitForExit();
    return {
      stdout: Buffer.concat(runtime.stdout),
      stderr: Buffer.concat(runtime.stderr),
      ...exit,
    };
  } finally {
    runtime.stop();
  }
}

function projectFailure(issueCode: string): Record<string, unknown> {
  return projectErrorResult({
    schema_version: "1",
    ok: false,
    error: createProjectError("CONTRACT_INVALID", {
      tool: "archflow_state",
      issue_code: issueCode,
    }),
  } as const);
}

function projectErrorResult(result: Readonly<Record<string, unknown>>): Record<string, unknown> {
  return {
    structuredContent: result,
    content: [{ type: "text", text: JSON.stringify(result) }],
    isError: true,
  };
}

beforeAll(async () => {
  outputDirectory = await mkdtemp(resolve(tmpdir(), "archflow-mcp-integration-"));
  const buildProgram = [
    'import { resolve } from "node:path";',
    'import { pathToFileURL } from "node:url";',
    'const root = process.argv[1];',
    'const output = process.argv[2];',
    'const helper = await import(pathToFileURL(resolve(root, "scripts/build-temp-helper.mjs")));',
    'const bundles = await helper.buildTemporaryBundles(output);',
    'process.stdout.write(bundles.runtimeBundle);',
  ].join("");
  const built = spawnSync(process.execPath, ["--input-type=module", "--eval", buildProgram, repositoryRoot, outputDirectory], {
    cwd: repositoryRoot,
    encoding: "utf8",
    timeout: PROCESS_TIMEOUT_MS,
  });
  if (built.error !== undefined || built.status !== 0) {
    throw built.error ?? new Error(`temporary runtime build failed: ${built.stderr}`);
  }
  runtimeBundle = built.stdout;
  expect(relative(repositoryRoot, runtimeBundle).startsWith("..")).toBe(true);

  const trackedBuildOutput = spawnSync("git", ["ls-files", "--", ".tmp"], {
    cwd: repositoryRoot,
    encoding: "utf8",
    timeout: PROCESS_TIMEOUT_MS,
  });
  expect(trackedBuildOutput.status).toBe(0);
  expect(trackedBuildOutput.stdout).toBe("");
}, TEST_TIMEOUT_MS);

afterAll(async () => {
  if (outputDirectory !== "") await rm(outputDirectory, { recursive: true, force: true });
  await Promise.all(lifecycleRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

interface LifecycleRuntime {
  readonly input: PassThrough;
  readonly output: PassThrough;
  readonly handle: McpRuntimeHandle;
  readonly lines: string[];
  readonly send: (message: unknown) => void;
}

async function waitForPath(path: string): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (await stat(path).then(() => true, () => false)) return;
    await new Promise((resolveWait) => setTimeout(resolveWait, 20));
  }
  throw new Error(`timed out waiting for ${path}`);
}

async function waitForPidExit(pid: number): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    try {
      process.kill(pid, 0);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ESRCH") return;
      throw error;
    }
    await new Promise((resolveWait) => setTimeout(resolveWait, 20));
  }
  throw new Error(`process ${pid} survived MCP lifecycle termination`);
}

function pidIsAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ESRCH") return false;
    throw error;
  }
}

async function lifecycleRuntime(root: string): Promise<LifecycleRuntime> {
  const input = new PassThrough();
  const output = new PassThrough();
  const lines: string[] = [];
  let buffered = "";
  output.on("data", (chunk: Buffer) => {
    buffered += chunk.toString("utf8");
    for (;;) {
      const newline = buffered.indexOf("\n");
      if (newline < 0) break;
      lines.push(buffered.slice(0, newline));
      buffered = buffered.slice(newline + 1);
    }
  });
  const fixture = new URL("../fixtures/dispatch/grandchild.mjs", import.meta.url);
  const handlers: ToolHandlerRegistry = {
    archflow_state: async (_call, context) => runDispatchChild({
      adapter: "codex-cli",
      command: process.execPath,
      argv: [fixture.pathname],
      cwd: root,
      env: { PATH: dirname(process.execPath) },
      signal: context.signal,
      cancellation_source: "client",
    }),
  };
  const handle = await startMcpRuntime({ input, output, workingDirectory: root, handlers });
  const send = (message: unknown): void => { input.write(jsonLine(message)); };
  send(initialize.request);
  while (lines.length < 1) await new Promise((resolveWait) => setTimeout(resolveWait, 5));
  send(initialize.initialized);
  return { input, output, handle, lines, send };
}

async function lifecyclePids(root: string): Promise<readonly [number, number]> {
  await waitForPath(resolve(root, "grandchild-pid"));
  return [
    Number((await readFile(resolve(root, "child-pid"), "utf8")).trim()),
    Number((await readFile(resolve(root, "grandchild-pid"), "utf8")).trim()),
  ];
}

describe("bundled MCP stdio runtime", () => {
  it("prints usage for --help instead of waiting on stdin", () => {
    const result = spawnSync(process.execPath, [runtimeBundle, "--help"], {
      cwd: repositoryRoot, encoding: "utf8", timeout: PROCESS_TIMEOUT_MS,
    });
    expect(result.status).toBe(0);
    expect(result.stdout).toContain("usage: archflow-mcp");
    expect(result.stdout).toContain("takes no arguments");
  });

  it("rejects unexpected arguments instead of waiting on stdin", () => {
    const result = spawnSync(process.execPath, [runtimeBundle, "--bogus"], {
      cwd: repositoryRoot, encoding: "utf8", timeout: PROCESS_TIMEOUT_MS,
    });
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("archflow-mcp takes no arguments (got: --bogus)");
  });

  it("emits the byte-exact initialize response and exits cleanly on EOF", async () => {
    const result = await complete([Buffer.from(jsonLine(initialize.request))]);

    expect(result.stdout).toEqual(Buffer.from(jsonLine(initialize.response)));
    expect(result.stderr).toEqual(Buffer.alloc(0));
    expect(result).toMatchObject({ code: 0, signal: null });
  });

  it("retries initialization after a bounded SDK validation error", async () => {
    const retryRequest = { ...initialize.request, id: "initialize-retry" };
    const retryResponse = { ...initialize.response, id: "initialize-retry" };
    const result = await complete([
      Buffer.from(jsonLine(initialize.malformed_request)),
      Buffer.from(jsonLine(retryRequest)),
    ]);

    expect(result.stdout).toEqual(Buffer.from([
      jsonLine(initialize.malformed_response),
      jsonLine(retryResponse),
    ].join("")));
    expect(result.stderr).toEqual(Buffer.alloc(0));
    expect(result).toMatchObject({ code: 0, signal: null });
  });

  it("becomes ready before a same-chunk initialized notification and tool requests", async () => {
    const runtime = startRuntime();
    try {
      runtime.child.stdin.write(jsonLine(initialize.request));
      await runtime.waitForLines(1);
      expect(Buffer.concat(runtime.stdout)).toEqual(Buffer.from(jsonLine(initialize.response)));

      runtime.child.stdin.write([
        jsonLine(initialize.initialized),
        jsonLine(calls.list),
        jsonLine(calls.unknown),
        jsonLine(calls.missing_arguments),
        jsonLine(calls.non_object_arguments),
        jsonLine(calls.valid_disabled),
      ].join(""));
      await runtime.waitForLines(6);
      runtime.child.stdin.end();
      const exit = await runtime.waitForExit();

      const unknownError = createProtocolError("TOOL_NOT_FOUND", {
        tool_name_digest: createHash("sha256").update("unknown_tool").digest("hex"),
      });
      const liveHandlerFailure = projectErrorResult({
        schema_version: "1",
        ok: false,
        error: createProjectError("CONFIG_INVALID", { issue_code: "config-missing" }),
      });
      const expected = [
        initialize.response,
        { jsonrpc: "2.0", id: "list-1", result: { tools: ADVERTISED_TOOL_CATALOGUE } },
        { jsonrpc: "2.0", id: "call-unknown", error: { code: -32001, message: "TOOL_NOT_FOUND", data: unknownError } },
        { jsonrpc: "2.0", id: "call-missing", result: projectFailure("input-not-object") },
        { jsonrpc: "2.0", id: "call-non-object", result: projectFailure("input-not-object") },
        { jsonrpc: "2.0", id: "call-disabled", result: liveHandlerFailure },
      ].map(jsonLine).join("");

      expectExactBytes(Buffer.concat(runtime.stdout), Buffer.from(expected));
      expect(Buffer.concat(runtime.stderr)).toEqual(Buffer.alloc(0));
      expect(exit).toEqual({ code: 0, signal: null });
    } finally {
      runtime.stop();
    }
  });

  it.each([
    ["malformed_json_utf8", 0, ""],
    ["partial_json_utf8", 0, ""],
    ["invalid_utf8", 1, "ARCHFLOW_MCP_TRANSPORT_ERROR\n"],
  ] as const)("contains the %s failure without leaking non-protocol stdout", async (fixture, code, diagnostic) => {
    const result = await complete([Buffer.from(adversarial[fixture], "base64")]);

    expect(result.stdout).toEqual(Buffer.from(adversarial.parse_error_frame_utf8, "base64"));
    expect(result.stderr).toEqual(Buffer.from(diagnostic));
    expect(result).toMatchObject({ code, signal: null });
  });

  it.each([
    ["SIGINT", 130],
    ["SIGTERM", 143],
  ] as const)("maps %s to its conventional exit without diagnostics", async (signal, code) => {
    const runtime = startRuntime();
    try {
      runtime.child.stdin.write(jsonLine(initialize.request));
      await runtime.waitForLines(1);
      expect(runtime.child.kill(signal)).toBe(true);
      const exit = await runtime.waitForExit();

      expect(Buffer.concat(runtime.stdout)).toEqual(Buffer.from(jsonLine(initialize.response)));
      expect(Buffer.concat(runtime.stderr)).toEqual(Buffer.alloc(0));
      expect(exit).toEqual({ code, signal: null });
    } finally {
      runtime.stop();
    }
  });

  it("contains a closed stdout pipe as one transport diagnostic", async () => {
    const runtime = startRuntime();
    try {
      runtime.child.stdin.write(jsonLine(initialize.request));
      await runtime.waitForLines(1);
      runtime.child.stdout.destroy();
      runtime.child.stdin.write(Buffer.from(adversarial.malformed_json_utf8, "base64"));
      const exit = await runtime.waitForExit();

      expect(Buffer.concat(runtime.stdout)).toEqual(Buffer.from(jsonLine(initialize.response)));
      expect(Buffer.concat(runtime.stderr)).toEqual(Buffer.from("ARCHFLOW_MCP_TRANSPORT_ERROR\n"));
      expect(exit).toEqual({ code: 1, signal: null });
    } finally {
      runtime.stop();
    }
  });
}, TEST_TIMEOUT_MS);

describe("MCP stdio dispatch lifecycle", () => {
  it.runIf(process.platform !== "win32")("forwards notifications/cancelled to an in-flight dispatch process group", async () => {
    const root = await mkdtemp(resolve(tmpdir(), "archflow-mcp-cancel-dispatch-"));
    lifecycleRoots.push(root);
    const runtime = await lifecycleRuntime(root);
    try {
      runtime.send({
        jsonrpc: "2.0",
        id: "dispatch-call",
        method: "tools/call",
        params: { name: "archflow_state", arguments: calls.valid_disabled.params.arguments },
      });
      const pids = await lifecyclePids(root);
      runtime.send({
        jsonrpc: "2.0",
        method: "notifications/cancelled",
        params: { requestId: "dispatch-call", reason: "stop" },
      });
      await Promise.all(pids.map(waitForPidExit));
      await new Promise((resolveWait) => setTimeout(resolveWait, 20));
      expect(runtime.lines).toHaveLength(1);
    } finally {
      await runtime.handle.close();
    }
  });

  it.runIf(process.platform !== "win32")("observes shutdown return before its in-flight dispatch process group is reaped", async () => {
    const root = await mkdtemp(resolve(tmpdir(), "archflow-mcp-close-dispatch-"));
    lifecycleRoots.push(root);
    const runtime = await lifecycleRuntime(root);
    runtime.send({
      jsonrpc: "2.0",
      id: "dispatch-call",
      method: "tools/call",
      params: { name: "archflow_state", arguments: calls.valid_disabled.params.arguments },
    });
    const pids = await lifecyclePids(root);

    await runtime.handle.close();
    const aliveWhenCloseResolved = pids.filter(pidIsAlive);
    await Promise.all(pids.map(waitForPidExit));
    expect(aliveWhenCloseResolved).toEqual(pids);
    expect(await runtime.handle.closed).toEqual({ reason: "caller-close", close_failed: false });
    expect(runtime.lines).toHaveLength(1);
  });
});

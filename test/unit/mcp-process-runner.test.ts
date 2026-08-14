import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";

import { describe, expect, it, vi } from "vitest";

import { createProjectError } from "../../src/contracts/errors.js";
import {
  runMcpProcess,
  type ProcessBindings,
  type RuntimeStarter,
} from "../../src/mcp/process-runner.js";
import type {
  McpRuntimeHandle,
  RuntimeTermination,
} from "../../src/mcp/sdk-adapter.js";
import { startMcpRuntime } from "../../src/mcp/sdk-adapter.js";

interface Deferred<T> {
  readonly promise: Promise<T>;
  readonly resolve: (value: T) => void;
  readonly reject: (reason: unknown) => void;
}

function deferred<T>(): Deferred<T> {
  let resolvePromise!: (value: T) => void;
  let rejectPromise!: (reason: unknown) => void;
  const promise = new Promise<T>((resolve, reject) => {
    resolvePromise = resolve;
    rejectPromise = reject;
  });
  return { promise, resolve: resolvePromise, reject: rejectPromise };
}

function harness(): {
  readonly bindings: ProcessBindings;
  readonly signals: EventEmitter;
  readonly diagnostics: string[];
  readonly exits: number[];
} {
  const signals = new EventEmitter();
  const diagnostic = new PassThrough();
  const diagnostics: string[] = [];
  diagnostic.setEncoding("utf8");
  diagnostic.on("data", (chunk: string) => diagnostics.push(chunk));
  const exits: number[] = [];

  return {
    bindings: {
      input: new PassThrough(),
      output: new PassThrough(),
      diagnostic,
      workingDirectory: "/workspace/project",
      signals,
      setExitCode: (code) => exits.push(code),
    },
    signals,
    diagnostics,
    exits,
  };
}

function runtime(
  termination: Promise<RuntimeTermination>,
  close: () => Promise<void> = async () => undefined,
): McpRuntimeHandle {
  return { close, closed: termination };
}

async function flush(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
}

describe("MCP process runner", () => {
  it("passes only runtime options and reports startup failure once", async () => {
    const { bindings, signals, diagnostics, exits } = harness();
    const start = vi.fn<RuntimeStarter>().mockRejectedValue(new Error("secret"));

    await runMcpProcess(bindings, start);

    expect(start).toHaveBeenCalledWith({
      input: bindings.input,
      output: bindings.output,
      workingDirectory: "/workspace/project",
    });
    expect(diagnostics).toEqual(["ARCHFLOW_MCP_START_FAILED\n"]);
    expect(exits).toEqual([1]);
    expect(signals.listenerCount("SIGINT")).toBe(0);
    expect(signals.listenerCount("SIGTERM")).toBe(0);
  });

  it("forwards a non-empty handler registry into the runtime seam", async () => {
    const base = harness();
    const handlers: NonNullable<ProcessBindings["handlers"]> = Object.freeze({
      archflow_state: async () => ({ schema_version: "1", ok: false }),
    }) as NonNullable<ProcessBindings["handlers"]>;
    const bindings: ProcessBindings = { ...base.bindings, handlers };
    const start = vi.fn<RuntimeStarter>().mockResolvedValue(
      runtime(Promise.resolve({ reason: "input-eof", close_failed: false })),
    );

    await runMcpProcess(bindings, start);

    expect(start).toHaveBeenCalledWith({
      input: bindings.input,
      output: bindings.output,
      workingDirectory: "/workspace/project",
      handlers,
    });
  });

  it("drives a registered handler through the real runtime instead of returning TOOL_DISABLED", async () => {
    const signals = new EventEmitter();
    const input = new PassThrough();
    const output = new PassThrough();
    const diagnostic = new PassThrough();
    const outputChunks: Buffer[] = [];
    const diagnosticChunks: Buffer[] = [];
    output.on("data", (chunk: Buffer) => outputChunks.push(Buffer.from(chunk)));
    diagnostic.on("data", (chunk: Buffer) => diagnosticChunks.push(Buffer.from(chunk)));
    const exits: number[] = [];
    const failure = {
      schema_version: "1",
      ok: false,
      error: createProjectError("CONTRACT_INVALID", {
        tool: "archflow_state",
        issue_code: "handler-seam-test",
      }),
    } as const;
    const handlers: NonNullable<ProcessBindings["handlers"]> = Object.freeze({
      archflow_state: async () => failure,
    });
    const call = {
      jsonrpc: "2.0",
      id: "call",
      method: "tools/call",
      params: {
        name: "archflow_state",
        arguments: {
          schema_version: "1",
          task_id: "task-1",
          intent_id: "intent-1",
          expected_revision: 2,
          input_fingerprint: "a".repeat(64),
          phase_instance: "phase-impl-2",
          step: "produce",
          status: "succeeded",
        },
      },
    };
    const initialize = JSON.stringify({
        jsonrpc: "2.0",
        id: "init",
        method: "initialize",
        params: {
          protocolVersion: "2025-11-25",
          capabilities: {},
          clientInfo: { name: "codex-mcp-client", version: "0.146.0" },
        },
      });
    const bindings: ProcessBindings = {
      input,
      output,
      diagnostic,
      workingDirectory: "/workspace/project",
      handlers,
      signals,
      setExitCode: (code) => exits.push(code),
    };
    const task = runMcpProcess(bindings, startMcpRuntime);
    const waitForLines = async (count: number): Promise<void> => {
      const current = (): number => Buffer.concat(outputChunks).toString("utf8").split("\n").length - 1;
      if (current() >= count) return;
      await new Promise<void>((resolve) => {
        const onData = (): void => {
          if (current() >= count) {
            output.off("data", onData);
            resolve();
          }
        };
        output.on("data", onData);
      });
    };
    input.write(`${initialize}\n`);
    await waitForLines(1);
    input.write(
      `${JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" })}\n` +
      `${JSON.stringify(call)}\n`,
    );
    await waitForLines(2);
    input.end();
    await task;

    const responses = Buffer.concat(outputChunks).toString("utf8");
    expect(responses).toContain("handler-seam-test");
    expect(responses).not.toContain("TOOL_DISABLED");
    expect(Buffer.concat(diagnosticChunks)).toEqual(Buffer.alloc(0));
    expect(exits).toEqual([0]);
  });

  it.each([
    ["input-eof", false, 0, []],
    ["input-error", false, 1, ["ARCHFLOW_MCP_TRANSPORT_ERROR\n"]],
    ["output-error", false, 1, ["ARCHFLOW_MCP_TRANSPORT_ERROR\n"]],
    ["protocol-fatal", false, 1, ["ARCHFLOW_MCP_TRANSPORT_ERROR\n"]],
    ["caller-close", false, 1, ["ARCHFLOW_MCP_TRANSPORT_ERROR\n"]],
    ["input-eof", true, 1, ["ARCHFLOW_MCP_CLOSE_FAILED\n"]],
  ] as const)(
    "maps runtime reason %s (close_failed=%s) to exit %s",
    async (reason, closeFailed, expectedExit, expectedDiagnostics) => {
      const { bindings, signals, diagnostics, exits } = harness();
      const close = vi.fn(async () => undefined);
      const start = vi.fn<RuntimeStarter>().mockResolvedValue(
        runtime(Promise.resolve({ reason, close_failed: closeFailed }), close),
      );

      await runMcpProcess(bindings, start);

      expect(close).toHaveBeenCalledTimes(1);
      expect(diagnostics).toEqual(expectedDiagnostics);
      expect(exits).toEqual([expectedExit]);
      expect(signals.listenerCount("SIGINT")).toBe(0);
      expect(signals.listenerCount("SIGTERM")).toBe(0);
    },
  );

  it.each([
    ["SIGINT", 130],
    ["SIGTERM", 143],
  ] as const)("closes once and preserves the %s exit", async (signal, exit) => {
    const { bindings, signals, diagnostics, exits } = harness();
    const closed = deferred<RuntimeTermination>();
    const close = vi.fn(async () => {
      closed.resolve({ reason: "caller-close", close_failed: false });
    });
    const task = runMcpProcess(
      bindings,
      vi.fn<RuntimeStarter>().mockResolvedValue(runtime(closed.promise, close)),
    );
    await flush();

    signals.emit(signal);
    await task;

    expect(close).toHaveBeenCalledTimes(1);
    expect(diagnostics).toEqual([]);
    expect(exits).toEqual([exit]);
    expect(signals.listenerCount("SIGINT")).toBe(0);
    expect(signals.listenerCount("SIGTERM")).toBe(0);
  });

  it("keeps the first signal when later fatal events overlap", async () => {
    const { bindings, signals, diagnostics, exits } = harness();
    const closed = deferred<RuntimeTermination>();
    const close = vi.fn(async () => {
      closed.resolve({ reason: "output-error", close_failed: false });
    });
    const task = runMcpProcess(
      bindings,
      vi.fn<RuntimeStarter>().mockResolvedValue(runtime(closed.promise, close)),
    );
    await flush();

    signals.emit("SIGINT");
    signals.emit("SIGTERM");
    await task;

    expect(exits).toEqual([130]);
    expect(diagnostics).toEqual([]);
    expect(close).toHaveBeenCalledTimes(1);
  });

  it("keeps the first runtime fatal when a later signal overlaps", async () => {
    const { bindings, signals, diagnostics, exits } = harness();
    const closed = deferred<RuntimeTermination>();
    const close = vi.fn(async () => undefined);
    const task = runMcpProcess(
      bindings,
      vi.fn<RuntimeStarter>().mockResolvedValue(runtime(closed.promise, close)),
    );
    await flush();

    closed.resolve({ reason: "input-error", close_failed: false });
    await flush();
    signals.emit("SIGINT");
    await task;

    expect(exits).toEqual([1]);
    expect(diagnostics).toEqual(["ARCHFLOW_MCP_TRANSPORT_ERROR\n"]);
    expect(close).toHaveBeenCalledTimes(1);
  });

  it("preserves a selected signal but diagnoses a close rejection once", async () => {
    const { bindings, signals, diagnostics, exits } = harness();
    const closed = deferred<RuntimeTermination>();
    const close = vi.fn(async () => {
      closed.resolve({ reason: "caller-close", close_failed: true });
      throw new Error("private close detail");
    });
    const task = runMcpProcess(
      bindings,
      vi.fn<RuntimeStarter>().mockResolvedValue(runtime(closed.promise, close)),
    );
    await flush();

    signals.emit("SIGTERM");
    await task;

    expect(close).toHaveBeenCalledTimes(1);
    expect(diagnostics).toEqual(["ARCHFLOW_MCP_CLOSE_FAILED\n"]);
    expect(exits).toEqual([143]);
  });

  it("turns EOF plus close rejection into one close diagnostic and exit 1", async () => {
    const { bindings, diagnostics, exits } = harness();
    const close = vi.fn().mockRejectedValue(new Error("private close detail"));

    await runMcpProcess(
      bindings,
      vi.fn<RuntimeStarter>().mockResolvedValue(
        runtime(Promise.resolve({ reason: "input-eof", close_failed: false }), close),
      ),
    );

    expect(close).toHaveBeenCalledTimes(1);
    expect(diagnostics).toEqual(["ARCHFLOW_MCP_CLOSE_FAILED\n"]);
    expect(exits).toEqual([1]);
  });

  it("keeps a signal selected while startup is pending and cleans listeners", async () => {
    const { bindings, signals, diagnostics, exits } = harness();
    const starting = deferred<McpRuntimeHandle>();
    const closed = deferred<RuntimeTermination>();
    const close = vi.fn(async () => {
      closed.resolve({ reason: "caller-close", close_failed: false });
    });
    const task = runMcpProcess(
      bindings,
      vi.fn<RuntimeStarter>().mockReturnValue(starting.promise),
    );

    signals.emit("SIGINT");
    starting.resolve(runtime(closed.promise, close));
    await task;
    await flush();

    expect(close).toHaveBeenCalledTimes(1);
    expect(diagnostics).toEqual([]);
    expect(exits).toEqual([130]);
    expect(signals.listenerCount("SIGINT")).toBe(0);
    expect(signals.listenerCount("SIGTERM")).toBe(0);
  });

  it("completes promptly on a signal when startup never settles", async () => {
    const { bindings, signals, diagnostics, exits } = harness();
    const start = vi.fn<RuntimeStarter>().mockReturnValue(new Promise(() => undefined));
    const task = runMcpProcess(bindings, start);

    signals.emit("SIGTERM");
    await task;

    expect(start).toHaveBeenCalledTimes(1);
    expect(diagnostics).toEqual([]);
    expect(exits).toEqual([143]);
    expect(signals.listenerCount("SIGINT")).toBe(0);
    expect(signals.listenerCount("SIGTERM")).toBe(0);
  });

  it("closes a runtime once when startup resolves after signal completion", async () => {
    const { bindings, signals, diagnostics, exits } = harness();
    const starting = deferred<McpRuntimeHandle>();
    const closed = deferred<RuntimeTermination>();
    const close = vi.fn(async () => {
      closed.resolve({ reason: "caller-close", close_failed: false });
    });
    const task = runMcpProcess(
      bindings,
      vi.fn<RuntimeStarter>().mockReturnValue(starting.promise),
    );

    signals.emit("SIGINT");
    await task;
    expect(exits).toEqual([130]);
    expect(signals.listenerCount("SIGINT")).toBe(0);
    expect(signals.listenerCount("SIGTERM")).toBe(0);

    starting.resolve(runtime(closed.promise, close));
    await flush();
    await flush();

    expect(close).toHaveBeenCalledTimes(1);
    expect(diagnostics).toEqual([]);
  });

  it("does not destroy caller-owned streams", async () => {
    const { bindings } = harness();

    await runMcpProcess(
      bindings,
      vi.fn<RuntimeStarter>().mockResolvedValue(
        runtime(Promise.resolve({ reason: "input-eof", close_failed: false })),
      ),
    );

    expect(bindings.input.destroyed).toBe(false);
    expect(bindings.output.destroyed).toBe(false);
    expect(bindings.diagnostic.destroyed).toBe(false);
  });
});

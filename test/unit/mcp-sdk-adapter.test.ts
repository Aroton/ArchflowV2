import { PassThrough } from "node:stream";

import { describe, expect, it } from "vitest";

import { ADVERTISED_TOOL_CATALOGUE } from "../../src/mcp/tools.js";
import { startMcpRuntime, type McpRuntimeHandle } from "../../src/mcp/sdk-adapter.js";
import type { ToolHandlerRegistry } from "../../src/mcp/server.js";

const digest = "a".repeat(64);
const stateInput = {
  schema_version: "1",
  task_id: "task-1",
  intent_id: "intent-1",
  expected_revision: 2,
  input_fingerprint: digest,
  phase_instance: "phase-impl-3",
  step: "produce",
  status: "succeeded"
} as const;
const stateSuccess = {
  schema_version: "1",
  ok: true,
  value: { path: "phases/3/result.json", revision: 3, status: "succeeded" }
} as const;

const initialize = (id: string | number, clientInfo: unknown = { name: "Codex", version: "1" }) => ({
  jsonrpc: "2.0",
  id,
  method: "initialize",
  params: {
    protocolVersion: "2025-11-25",
    capabilities: {},
    clientInfo
  }
});

interface Harness {
  readonly input: PassThrough;
  readonly output: PassThrough;
  readonly handle: McpRuntimeHandle;
  readonly lines: string[];
  readonly send: (message: unknown) => void;
  readonly waitForLines: (count: number) => Promise<void>;
}

async function harness(handlers?: ToolHandlerRegistry): Promise<Harness> {
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
  const handle = await startMcpRuntime({
    input,
    output,
    workingDirectory: "/work",
    ...(handlers === undefined ? {} : { handlers })
  });
  return {
    input,
    output,
    handle,
    lines,
    send: (message) => { input.write(`${JSON.stringify(message)}\n`); },
    waitForLines: async (count) => {
      const deadline = Date.now() + 2_000;
      while (lines.length < count) {
        if (Date.now() >= deadline) throw new Error(`timed out waiting for ${count} output lines: ${JSON.stringify(lines)}`);
        await new Promise((resolve) => setTimeout(resolve, 5));
      }
      await Promise.resolve();
      await Promise.resolve();
    }
  };
}

async function ready(runtime: Harness): Promise<void> {
  runtime.send(initialize("init"));
  await runtime.waitForLines(1);
  runtime.send({ jsonrpc: "2.0", method: "notifications/initialized" });
}

describe("MCP SDK adapter", () => {
  it("pins canonical initialize bytes and retries after a prose-free malformed initialize", async () => {
    const runtime = await harness();
    runtime.send(initialize(1, { name: 1, version: "bad" }));
    await runtime.waitForLines(1);
    expect(runtime.lines[0]).toBe('{"jsonrpc":"2.0","id":1,"error":{"code":-32602,"message":"Invalid params"}}');

    runtime.send(initialize(2));
    await runtime.waitForLines(2);
    expect(runtime.lines[1]).toBe('{"jsonrpc":"2.0","id":2,"result":{"protocolVersion":"2025-11-25","capabilities":{"tools":{}},"serverInfo":{"name":"archflow-mcp","version":"0.0.0"}}}');
    await runtime.handle.close();
    await expect(runtime.handle.closed).resolves.toEqual({ reason: "caller-close", close_failed: false });
  });

  it("returns the exact advertised catalogue and one LF per response", async () => {
    const runtime = await harness();
    await ready(runtime);
    runtime.send({ jsonrpc: "2.0", id: "list", method: "tools/list", params: {} });
    await runtime.waitForLines(2);
    expect(JSON.parse(runtime.lines[1]!)).toEqual({ jsonrpc: "2.0", id: "list", result: { tools: ADVERTISED_TOOL_CATALOGUE } });
    expect(runtime.lines.every((line) => !line.includes("\n"))).toBe(true);
    await runtime.handle.close();
  });

  it("enters READY only through the SDK initialized hook and preserves same-chunk order", async () => {
    const malformed = await harness();
    malformed.send(initialize("init"));
    await malformed.waitForLines(1);
    malformed.input.write(
      `${JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized", params: null })}\n` +
      `${JSON.stringify({ jsonrpc: "2.0", id: "blocked", method: "tools/list", params: {} })}\n`
    );
    await malformed.waitForLines(2);
    expect(malformed.lines[1]).toBe(
      '{"jsonrpc":"2.0","id":"blocked","error":{"code":-32600,"message":"Invalid Request"}}'
    );
    await malformed.handle.close();

    const valid = await harness();
    valid.send(initialize("init"));
    await valid.waitForLines(1);
    valid.input.write(
      `${JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" })}\n` +
      `${JSON.stringify({ jsonrpc: "2.0", id: "list", method: "tools/list", params: {} })}\n`
    );
    await valid.waitForLines(2);
    expect(JSON.parse(valid.lines[1]!)).toEqual({
      jsonrpc: "2.0",
      id: "list",
      result: { tools: ADVERTISED_TOOL_CATALOGUE }
    });
    await valid.handle.close();
  });

  it("recovers missing and non-object arguments at the authentic boundary", async () => {
    const runtime = await harness();
    await ready(runtime);
    runtime.send({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "archflow_state" } });
    runtime.send({ jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "archflow_state", arguments: "bad" } });
    runtime.send({ jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "unknown", arguments: {} } });
    runtime.send({ jsonrpc: "2.0", id: 4, method: "tools/call", params: { name: "archflow_state", arguments: stateInput } });
    await runtime.waitForLines(5);
    const responses = runtime.lines.slice(1).map((line) => JSON.parse(line) as Record<string, unknown>);
    for (const response of responses.slice(0, 2)) {
      const result = response.result as { structuredContent: { ok: boolean; error: { code: string } }; isError: boolean };
      expect(result.structuredContent.error.code).toBe("CONTRACT_INVALID");
      expect(result.isError).toBe(true);
    }
    expect(responses[2]).toMatchObject({
      jsonrpc: "2.0",
      id: 3,
      error: { code: -32001, message: "TOOL_NOT_FOUND", data: { code: "TOOL_NOT_FOUND" } }
    });
    expect(responses[3]).toMatchObject({
      jsonrpc: "2.0",
      id: 4,
      error: { code: -32002, message: "TOOL_DISABLED", data: { code: "TOOL_DISABLED" } }
    });
    runtime.send({ jsonrpc: "2.0", id: 1, method: "ping" });
    await runtime.waitForLines(6);
    expect(runtime.lines[5]).toBe(
      '{"jsonrpc":"2.0","id":null,"error":{"code":-32600,"message":"Invalid Request"}}'
    );
    await runtime.handle.close();
  });

  it("bounds SDK metadata validator errors without leaking validator prose", async () => {
    const runtime = await harness();
    await ready(runtime);
    runtime.send({ jsonrpc: "2.0", id: 1, method: "tools/list", params: { _meta: null } });
    runtime.send({
      jsonrpc: "2.0",
      id: 2,
      method: "tools/call",
      params: { name: "archflow_state", task: "invalid", arguments: {} }
    });
    await runtime.waitForLines(3);
    expect(runtime.lines.slice(1)).toEqual([
      '{"jsonrpc":"2.0","id":1,"error":{"code":-32602,"message":"Invalid params"}}',
      '{"jsonrpc":"2.0","id":2,"error":{"code":-32602,"message":"Invalid params"}}'
    ]);
    await runtime.handle.close();
  });

  it("ignores malformed cancellation without aborting or suppressing the normal response", async () => {
    let release!: () => void;
    let started!: () => void;
    const didStart = new Promise<void>((resolve) => { started = resolve; });
    const gate = new Promise<void>((resolve) => { release = resolve; });
    let signal: AbortSignal | undefined;
    const runtime = await harness({
      archflow_state: async (_call, context) => {
        signal = context.signal;
        started();
        await gate;
        return stateSuccess;
      }
    });
    await ready(runtime);
    runtime.send({
      jsonrpc: "2.0",
      id: "call",
      method: "tools/call",
      params: { name: "archflow_state", arguments: stateInput }
    });
    await didStart;
    runtime.send({
      jsonrpc: "2.0",
      method: "notifications/cancelled",
      params: { requestId: "call", reason: { invalid: true } }
    });
    await Promise.resolve();
    expect(signal?.aborted).toBe(false);
    release();
    await runtime.waitForLines(2);
    expect(JSON.parse(runtime.lines[1]!)).toMatchObject({
      id: "call",
      result: { structuredContent: { schema_version: "1", ok: true } }
    });
    runtime.send({ jsonrpc: "2.0", id: "call", method: "ping" });
    await runtime.waitForLines(3);
    expect(runtime.lines[2]).toBe(
      '{"jsonrpc":"2.0","id":null,"error":{"code":-32600,"message":"Invalid Request"}}'
    );
    await runtime.handle.close();
  });

  it("accepts valid cancellation through the SDK schema, aborts, and retains the ID tombstone", async () => {
    let started!: () => void;
    const didStart = new Promise<void>((resolve) => { started = resolve; });
    let aborted!: () => void;
    const didAbort = new Promise<void>((resolve) => { aborted = resolve; });
    const runtime = await harness({
      archflow_state: async (_call, context) => {
        started();
        await new Promise<never>((_resolve, reject) => {
          context.signal.addEventListener("abort", () => {
            aborted();
            reject(new Error("cancelled"));
          }, { once: true });
        });
      }
    });
    await ready(runtime);
    runtime.send({
      jsonrpc: "2.0",
      id: 7,
      method: "tools/call",
      params: { name: "archflow_state", arguments: stateInput }
    });
    await didStart;
    runtime.send({
      jsonrpc: "2.0",
      method: "notifications/cancelled",
      params: { requestId: 7, reason: "stop" }
    });
    await didAbort;
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(runtime.lines).toHaveLength(1);
    runtime.send({ jsonrpc: "2.0", id: 7, method: "ping" });
    await runtime.waitForLines(2);
    expect(runtime.lines[1]).toBe(
      '{"jsonrpc":"2.0","id":null,"error":{"code":-32600,"message":"Invalid Request"}}'
    );
    await runtime.handle.close();
  });

  it("quarantines a delayed enabled-handler result after caller close", async () => {
    let release!: () => void;
    let started!: () => void;
    const didStart = new Promise<void>((resolve) => { started = resolve; });
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const runtime = await harness({
      archflow_state: async () => {
        started();
        await gate;
        return stateSuccess;
      }
    });
    await ready(runtime);
    runtime.send({
      jsonrpc: "2.0",
      id: "late",
      method: "tools/call",
      params: { name: "archflow_state", arguments: stateInput }
    });
    await didStart;
    await runtime.handle.close();
    release();
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(runtime.lines).toHaveLength(1);
  });

  it("emits fixed parse errors, preserves ID spending, and terminates without owning streams", async () => {
    const runtime = await harness();
    runtime.input.write("not-json\n");
    runtime.send(initialize(-0));
    await runtime.waitForLines(2);
    runtime.send({ jsonrpc: "2.0", id: 0, method: "ping" });
    await runtime.waitForLines(3);
    expect(runtime.lines[0]).toBe('{"jsonrpc":"2.0","id":null,"error":{"code":-32700,"message":"Parse error"}}');
    expect(runtime.lines[2]).toBe('{"jsonrpc":"2.0","id":null,"error":{"code":-32600,"message":"Invalid Request"}}');
    await runtime.handle.close();
    expect(runtime.input.destroyed).toBe(false);
    expect(runtime.output.destroyed).toBe(false);
  });
});

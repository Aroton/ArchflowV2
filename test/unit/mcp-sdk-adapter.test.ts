import { PassThrough } from "node:stream";

import { describe, expect, it } from "vitest";

import { ADVERTISED_TOOL_CATALOGUE } from "../../src/mcp/tools.js";
import { startMcpRuntime, type McpRuntimeHandle } from "../../src/mcp/sdk-adapter.js";
import type { ToolHandlerRegistry } from "../../src/mcp/server.js";

const statusInput = {
  schema_version: "1",
  task_id: "task-1"
} as const;
const applyInput = {
  schema_version: "1",
  task_id: "task-1",
  invocation: { skill: "archflow-prd", intent: "resume" },
  action: { offer: `af1_${"a".repeat(64)}` }
} as const;
const semanticSuccess = {
  schema_version: "1",
  ok: true,
  value: {
    schema_version: "1", task_id: "task-1", condition: "ready", headline: "Ready", detail: "Continue.", resources: [],
    next_action: { kind: "inspect", instruction: "Inspect status." },
  }
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
  it("pins canonical initialize bytes and retries after an SDK-rejected malformed initialize", async () => {
    const runtime = await harness();
    runtime.send(initialize(1, { name: 1, version: "bad" }));
    await runtime.waitForLines(1);
    const rejection = JSON.parse(runtime.lines[0]!) as { id: number; error: { code: number; message: string } };
    expect(rejection.id).toBe(1);
    expect(rejection.error.code).toBe(-32603);
    expect(rejection.error.message).toContain("clientInfo");

    runtime.send(initialize(2));
    await runtime.waitForLines(2);
    expect(runtime.lines[1]).toBe('{"jsonrpc":"2.0","id":2,"result":{"protocolVersion":"2025-11-25","capabilities":{"tools":{}},"serverInfo":{"name":"archflow-mcp","version":"0.0.0"}}}');
    await runtime.handle.close();
    await expect(runtime.handle.closed).resolves.toEqual({ reason: "caller-close", close_failed: false });
  });

  it("rejects a repeated initialize with the authentic INITIALIZATION_REPEATED projection", async () => {
    const runtime = await harness();
    await ready(runtime);
    runtime.send(initialize("again"));
    await runtime.waitForLines(2);
    expect(JSON.parse(runtime.lines[1]!)).toMatchObject({
      jsonrpc: "2.0",
      id: "again",
      error: {
        code: -32004,
        message: "INITIALIZATION_REPEATED",
        data: { code: "INITIALIZATION_REPEATED", diagnostic: { parameters: { connection_id: "connection-1" } } }
      }
    });
    runtime.send({ jsonrpc: "2.0", id: "list", method: "tools/list" });
    await runtime.waitForLines(3);
    expect(JSON.parse(runtime.lines[2]!)).toEqual({ jsonrpc: "2.0", id: "list", result: { tools: ADVERTISED_TOOL_CATALOGUE } });
    await runtime.handle.close();
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

  it("serves an injected semantic handler through the compact result envelope", async () => {
    const view = {
      schema_version: "1", task_id: "task-1", condition: "ready", headline: "Ready", detail: "Continue.", resources: [],
      next_action: { kind: "inspect", instruction: "Inspect status." },
    } as const;
    const runtime = await harness({
      archflow_status: () => ({ schema_version: "1", ok: true, value: view }),
    });
    await ready(runtime);
    runtime.send({ jsonrpc: "2.0", id: "semantic", method: "tools/call", params: { name: "archflow_status", arguments: { schema_version: "1", task_id: "task-1" } } });
    await runtime.waitForLines(2);
    expect(JSON.parse(runtime.lines[1]!)).toMatchObject({
      id: "semantic",
      result: { structuredContent: { schema_version: "1", ok: true, value: view }, isError: false },
    });
    await runtime.handle.close();
  });

  it("captures the connection only through the SDK initialized hook and answers -32603 before it", async () => {
    const runtime = await harness();
    runtime.send(initialize("init"));
    await runtime.waitForLines(1);
    // No branded outcome can exist before the connection is captured, so the
    // handler-side invariant answers a prose-free internal error.
    runtime.send({ jsonrpc: "2.0", id: "early", method: "tools/call", params: { name: "archflow_status", arguments: {} } });
    await runtime.waitForLines(2);
    expect(runtime.lines[1]).toBe('{"jsonrpc":"2.0","id":"early","error":{"code":-32603,"message":"Internal error"}}');

    // A malformed initialized notification fails the SDK envelope and is dropped,
    // so the connection stays uncaptured; tools/list is served regardless.
    runtime.input.write(
      `${JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized", params: null })}\n` +
      `${JSON.stringify({ jsonrpc: "2.0", id: "list-open", method: "tools/list", params: {} })}\n` +
      `${JSON.stringify({ jsonrpc: "2.0", id: "still-early", method: "tools/call", params: { name: "archflow_status", arguments: {} } })}\n`
    );
    await runtime.waitForLines(4);
    expect(JSON.parse(runtime.lines[2]!)).toEqual({
      jsonrpc: "2.0",
      id: "list-open",
      result: { tools: ADVERTISED_TOOL_CATALOGUE }
    });
    expect(runtime.lines[3]).toBe('{"jsonrpc":"2.0","id":"still-early","error":{"code":-32603,"message":"Internal error"}}');

    // The exact initialized notification mints the connection; same-chunk
    // requests observe it in protocol order.
    runtime.input.write(
      `${JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" })}\n` +
      `${JSON.stringify({ jsonrpc: "2.0", id: "call", method: "tools/call", params: { name: "unknown", arguments: {} } })}\n`
    );
    await runtime.waitForLines(5);
    expect(JSON.parse(runtime.lines[4]!)).toMatchObject({
      jsonrpc: "2.0",
      id: "call",
      error: { code: -32001, message: "TOOL_NOT_FOUND" }
    });
    await runtime.handle.close();
  });

  it("survives real recorded Claude Code clientInfo with extra fields through connection-ready", async () => {
    // Recorded from Claude Code 2.1.221: initialize succeeds via the SDK, but connection-ready
    // re-parses this clientInfo after initialized; a strict client schema killed the server here
    // before tools/list could answer (Phase 21 Amendment 2).
    const runtime = await harness();
    runtime.send(initialize(0, {
      name: "claude-code",
      title: "Claude Code",
      version: "2.1.221",
      description: "Anthropic's agentic coding tool",
      websiteUrl: "https://claude.com/claude-code"
    }));
    await runtime.waitForLines(1);
    runtime.input.write(
      `${JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" })}\n` +
      `${JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" })}\n`
    );
    await runtime.waitForLines(2);
    expect(JSON.parse(runtime.lines[1]!)).toEqual({
      jsonrpc: "2.0",
      id: 1,
      result: { tools: ADVERTISED_TOOL_CATALOGUE }
    });
    await runtime.handle.close();
  });

  it("routes missing arguments to the boundary and lets the SDK reject non-object arguments", async () => {
    const runtime = await harness();
    await ready(runtime);
    runtime.send({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "archflow_status" } });
    await runtime.waitForLines(2);
    runtime.send({ jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "archflow_status", arguments: "bad" } });
    await runtime.waitForLines(3);
    runtime.send({ jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "unknown", arguments: {} } });
    runtime.send({ jsonrpc: "2.0", id: 4, method: "tools/call", params: { name: "archflow_apply", arguments: applyInput } });
    await runtime.waitForLines(5);
    const responses = runtime.lines.slice(1).map((line) => JSON.parse(line) as Record<string, unknown>);
    const missingArguments = responses[0] as { result: { structuredContent: { ok: boolean; error?: { code: string } }; isError: boolean } };
    expect(missingArguments.result.structuredContent.ok).toBe(false);
    expect(missingArguments.result.structuredContent.error?.code).toBe("CONTRACT_INVALID");
    expect(missingArguments.result.isError).toBe(true);
    const nonObjectArguments = responses[1] as { id: number; error: { code: number; message: string } };
    expect(nonObjectArguments.id).toBe(2);
    expect(nonObjectArguments.error.code).toBe(-32602);
    expect(nonObjectArguments.error.message.startsWith("Invalid tools/call request:")).toBe(true);
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
    await runtime.handle.close();
  });

  it("surfaces SDK wire-schema rejections and silently drops unparseable envelopes", async () => {
    const runtime = await harness();
    await ready(runtime);
    runtime.send({ jsonrpc: "2.0", id: 1, method: "tools/list", params: { _meta: null } });
    runtime.send({
      jsonrpc: "2.0",
      id: 2,
      method: "tools/call",
      params: { name: "archflow_status", task: "invalid", arguments: {} }
    });
    await runtime.waitForLines(2);
    await new Promise((resolve) => setTimeout(resolve, 20));
    // The null _meta fails the SDK's strict JSON-RPC envelope, so id 1 gets no
    // response at all; the invalid task shape is rejected by the SDK's own
    // tools/call wire schema with its validator prose.
    expect(runtime.lines).toHaveLength(2);
    const rejection = JSON.parse(runtime.lines[1]!) as { id: number; error: { code: number; message: string } };
    expect(rejection.id).toBe(2);
    expect(rejection.error.code).toBe(-32602);
    expect(rejection.error.message.startsWith("Invalid tools/call request:")).toBe(true);
    await runtime.handle.close();
  });

  it("ignores malformed cancellation without aborting or suppressing the normal response", async () => {
    let release!: () => void;
    let started!: () => void;
    const didStart = new Promise<void>((resolve) => { started = resolve; });
    const gate = new Promise<void>((resolve) => { release = resolve; });
    let signal: AbortSignal | undefined;
    const runtime = await harness({
      archflow_status: async (_call, context) => {
        signal = context.signal;
        started();
        await gate;
        return semanticSuccess;
      }
    });
    await ready(runtime);
    runtime.send({
      jsonrpc: "2.0",
      id: "call",
      method: "tools/call",
      params: { name: "archflow_status", arguments: statusInput }
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
    runtime.send({ jsonrpc: "2.0", id: "after", method: "ping" });
    await runtime.waitForLines(3);
    expect(runtime.lines[2]).toBe('{"jsonrpc":"2.0","id":"after","result":{}}');
    await runtime.handle.close();
  });

  it("accepts valid cancellation through the SDK schema, aborts, and suppresses the response", async () => {
    let started!: () => void;
    const didStart = new Promise<void>((resolve) => { started = resolve; });
    let aborted!: () => void;
    const didAbort = new Promise<void>((resolve) => { aborted = resolve; });
    const runtime = await harness({
      archflow_status: async (_call, context) => {
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
      params: { name: "archflow_status", arguments: statusInput }
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
    runtime.send({ jsonrpc: "2.0", id: 8, method: "ping" });
    await runtime.waitForLines(2);
    expect(runtime.lines[1]).toBe('{"jsonrpc":"2.0","id":8,"result":{}}');
    await runtime.handle.close();
  });

  it("quarantines a delayed enabled-handler result after caller close", async () => {
    let release!: () => void;
    let started!: () => void;
    const didStart = new Promise<void>((resolve) => { started = resolve; });
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const runtime = await harness({
      archflow_status: async () => {
        started();
        await gate;
        return semanticSuccess;
      }
    });
    await ready(runtime);
    runtime.send({
      jsonrpc: "2.0",
      id: "late",
      method: "tools/call",
      params: { name: "archflow_status", arguments: statusInput }
    });
    await didStart;
    await runtime.handle.close();
    release();
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(runtime.lines).toHaveLength(1);
  });

  it("answers every dispatched request before terminating on input EOF", async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const runtime = await harness({
      archflow_status: async () => {
        await gate;
        return semanticSuccess;
      }
    });
    runtime.send(initialize("init"));
    runtime.send({ jsonrpc: "2.0", method: "notifications/initialized" });
    runtime.send({
      jsonrpc: "2.0",
      id: "slow",
      method: "tools/call",
      params: { name: "archflow_status", arguments: statusInput }
    });
    runtime.input.end();
    await runtime.waitForLines(1);
    release();
    const termination = await runtime.handle.closed;
    expect(termination.reason).toBe("input-eof");
    await runtime.waitForLines(2);
    const slow = JSON.parse(runtime.lines[1]!) as { id: string; result: { isError: boolean } };
    expect(slow.id).toBe("slow");
    expect(slow.result.isError).toBe(false);
  });

  it("does not wait for a cancelled request when draining at input EOF", async () => {
    let abortable!: AbortSignal;
    let started!: () => void;
    const didStart = new Promise<void>((resolve) => { started = resolve; });
    const runtime = await harness({
      archflow_status: async (_input, context) => {
        abortable = context.signal;
        started();
        await new Promise<never>(() => undefined);
        return semanticSuccess;
      }
    });
    await ready(runtime);
    runtime.send({
      jsonrpc: "2.0",
      id: "doomed",
      method: "tools/call",
      params: { name: "archflow_status", arguments: statusInput }
    });
    await didStart;
    runtime.send({ jsonrpc: "2.0", method: "notifications/cancelled", params: { requestId: "doomed" } });
    runtime.input.end();
    const termination = await runtime.handle.closed;
    expect(termination.reason).toBe("input-eof");
    expect(abortable.aborted).toBe(true);
    expect(runtime.lines).toHaveLength(1);
  });

  it("emits fixed parse errors, serializes -0 ids as 0, and terminates without owning streams", async () => {
    const runtime = await harness();
    runtime.input.write("not-json\n");
    runtime.send(initialize(-0));
    await runtime.waitForLines(2);
    runtime.send({ jsonrpc: "2.0", id: 1, method: "ping" });
    await runtime.waitForLines(3);
    expect(runtime.lines[0]).toBe('{"jsonrpc":"2.0","id":null,"error":{"code":-32700,"message":"Parse error"}}');
    expect((JSON.parse(runtime.lines[1]!) as { id: number }).id).toBe(0);
    expect(runtime.lines[2]).toBe('{"jsonrpc":"2.0","id":1,"result":{}}');
    await runtime.handle.close();
    expect(runtime.input.destroyed).toBe(false);
    expect(runtime.output.destroyed).toBe(false);
  });
});

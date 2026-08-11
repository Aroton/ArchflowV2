import { Buffer } from "node:buffer";
import type { Readable, Writable } from "node:stream";

import {
  isJSONRPCRequest,
  ProtocolError as SdkProtocolError,
  Server,
  type JSONRPCMessage,
  type ListToolsResult,
  type Transport
} from "@modelcontextprotocol/server";

import {
  connectionContextFactory,
  createInvocationContext,
  type ConnectionContext
} from "../contracts/contexts.js";
import { createProtocolError, type ProtocolError } from "../contracts/errors.js";
import { deriveHostIdentity } from "../contracts/hosts.js";
import { createJsonLineFramer, type IngressFrame } from "./framing.js";
import { createSendQueue, type SendSource } from "./send-queue.js";
import {
  assertAuthenticToolBoundaryOutcome,
  createToolBoundary,
  type ToolBoundaryOutcome,
  type ToolHandlerRegistry
} from "./server.js";
import { ADVERTISED_TOOL_CATALOGUE } from "./tools.js";

export interface McpRuntimeOptions {
  readonly input: Readable;
  readonly output: Writable;
  readonly workingDirectory: string;
  readonly handlers?: ToolHandlerRegistry;
}

export type RuntimeTermination = Readonly<{
  reason: "caller-close" | "input-eof" | "input-error" | "output-error" | "protocol-fatal";
  close_failed: boolean;
}>;

export interface McpRuntimeHandle {
  readonly close: () => Promise<void>;
  readonly closed: Promise<RuntimeTermination>;
}

const PROTOCOL_VERSION = "2025-11-25";
const CONNECTION_ID = "connection-1";
const JSON_RPC = "2.0";

type JsonRpcId = string | number;

interface Deferred<T> {
  readonly promise: Promise<T>;
  readonly resolve: (value: T) => void;
}

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((settle) => { resolve = settle; });
  return { promise, resolve };
}

function isObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function canonicalMessage(value: Readonly<Record<string, unknown>>): Uint8Array {
  const message: Record<string, unknown> = { jsonrpc: JSON_RPC };
  if (Object.hasOwn(value, "id")) message.id = value.id;
  if (Object.hasOwn(value, "result")) {
    message.result = value.result;
  } else if (Object.hasOwn(value, "error")) {
    const supplied = value.error;
    if (!isObject(supplied)) throw new TypeError("an error response must contain an error object");
    const error: Record<string, unknown> = { code: supplied.code, message: supplied.message };
    if (Object.hasOwn(supplied, "data")) error.data = supplied.data;
    message.error = error;
  } else {
    throw new TypeError("a response must contain a result or error");
  }
  return Buffer.from(`${JSON.stringify(message)}\n`, "utf8");
}

const PROTOCOL_CODES = Object.freeze({
  TOOL_NOT_FOUND: -32001,
  TOOL_DISABLED: -32002,
  UNSUPPORTED_PROTOCOL: -32003,
  INITIALIZATION_REPEATED: -32004
} satisfies {
  readonly TOOL_NOT_FOUND: -32001;
  readonly TOOL_DISABLED: -32002;
  readonly UNSUPPORTED_PROTOCOL: -32003;
  readonly INITIALIZATION_REPEATED: -32004;
});

function protocolCode(error: ProtocolError): number {
  return PROTOCOL_CODES[error.code];
}

function protocolResponse(id: JsonRpcId, error: ProtocolError): Readonly<Record<string, unknown>> {
  return { jsonrpc: JSON_RPC, id, error: { code: protocolCode(error), message: error.code, data: error } };
}

function wireResult(outcome: Extract<ToolBoundaryOutcome, { kind: "project-result" }>): unknown {
  return JSON.parse(JSON.stringify(outcome.result)) as unknown;
}

// The pinned SDK's legacy codec rewrites -32002 to -32602 on egress (probe-pinned).
// The registry freezes each protocol error's wire code, so the code is restored
// whenever the error demonstrably carries a registry protocol-error payload.
function restoreProtocolErrorCode(message: Record<string, unknown>): Readonly<Record<string, unknown>> {
  const error = message.error;
  if (!isObject(error) || !isObject(error.data)) return message;
  const name = error.message;
  if (typeof name !== "string" || !Object.hasOwn(PROTOCOL_CODES, name)) return message;
  if (error.data.code !== name) return message;
  const code = PROTOCOL_CODES[name as keyof typeof PROTOCOL_CODES];
  if (error.code === code) return message;
  return { ...message, error: { ...error, code } };
}

function requestKey(id: JsonRpcId): string {
  return typeof id === "string" ? `s:${id}` : `n:${id}`;
}

function externalRequestId(id: JsonRpcId): JsonRpcId {
  return typeof id === "number" && Object.is(id, -0) ? 0 : id;
}

export async function startMcpRuntime(options: McpRuntimeOptions): Promise<McpRuntimeHandle> {
  if (!isObject(options) || typeof options.workingDirectory !== "string") {
    throw new TypeError("valid MCP runtime options are required");
  }

  const handlers = options.handlers ?? {};
  const boundary = createToolBoundary(handlers);
  const startup = connectionContextFactory.captureStartup({
    connection_id: CONNECTION_ID,
    startup_repository_candidate: { working_directory: options.workingDirectory }
  });
  const server = new Server(
    { name: "archflow-mcp", version: "0.0.0" },
    { supportedProtocolVersions: [PROTOCOL_VERSION] }
  );
  server.registerCapabilities({ tools: {} });

  const framer = createJsonLineFramer();
  // One token per SDK-dispatched request, minted at ingress and settled when the
  // response is enqueued. Duplicate in-flight IDs overwrite each other; a trusted
  // local host never reuses in-flight IDs (documented limitation).
  const requestTokens = new Map<string, string>();
  const closed = deferred<RuntimeTermination>();
  let connection: ConnectionContext | undefined;
  let nextRequestNumber = 1;
  let initializeAccepted = false;
  let initializeInFlightKey: string | undefined;
  let closing = false;
  let terminated = false;
  let processing = false;
  let eofPending = false;
  let closePromise: Promise<void> | undefined;

  const onObservedOutputError = (): void => { void terminate("output-error"); };
  options.output.on("error", onObservedOutputError);

  const removeInputListeners = (): void => {
    options.input.off("data", onData);
    options.input.off("end", onEnd);
    options.input.off("error", onInputError);
  };

  const queue = createSendQueue(
    options.output,
    (paused) => {
      if (closing) return;
      if (paused) options.input.pause();
      else {
        options.input.resume();
        drainFrames();
      }
    },
    () => { void terminate("output-error"); }
  );

  const enqueue = (
    source: SendSource,
    message: Readonly<Record<string, unknown>>,
    requestToken?: string
  ): Promise<void> => {
    if (closing) return Promise.reject(new Error("MCP runtime is closing"));
    try {
      const frame = canonicalMessage(message);
      const id = message.id;
      const settlesInitialize = initializeInFlightKey !== undefined &&
        (typeof id === "string" || typeof id === "number") &&
        requestKey(id) === initializeInFlightKey;
      const initializeSucceeded = Object.hasOwn(message, "result");
      const receipt = queue.enqueue({ source, frame, ...(requestToken === undefined ? {} : { requestToken }) });
      void receipt.admitted.then(
        () => {
          if (settlesInitialize && initializeInFlightKey !== undefined) {
            initializeInFlightKey = undefined;
            if (initializeSucceeded) initializeAccepted = true;
          }
          drainFrames();
        },
        () => undefined
      );
      return receipt.completed;
    } catch {
      void terminate("protocol-fatal");
      return Promise.reject(new Error("MCP response canonicalization failed"));
    }
  };

  const transport: Transport = {
    start: async () => undefined,
    send: async (message) => {
      if (closing) throw new Error("MCP runtime is closing");
      const raw = message as unknown as Record<string, unknown>;
      const id = Object.hasOwn(raw, "id") ? raw.id : undefined;
      let requestToken: string | undefined;
      if (typeof id === "string" || typeof id === "number") {
        const key = requestKey(id);
        requestToken = requestTokens.get(key);
        if (requestToken !== undefined) requestTokens.delete(key);
      }
      await enqueue("sdk", restoreProtocolErrorCode(raw), requestToken);
      if (eofPending && !closing && requestTokens.size === 0) drainFrames();
    },
    close: async () => { transport.onclose?.(); }
  };

  server.setRequestHandler("tools/list", async () => (
    { tools: structuredClone(ADVERTISED_TOOL_CATALOGUE) } as unknown as ListToolsResult
  ));
  server.setRequestHandler("tools/call", async (request, ctx) => {
    const id = ctx.mcpReq.id;
    const requestToken = requestTokens.get(requestKey(id)) ?? `request-${nextRequestNumber++}`;
    // A cancelled request never sends a response, so its token must settle
    // here or an EOF drain would wait on it forever.
    ctx.mcpReq.signal.addEventListener("abort", () => {
      const key = requestKey(id);
      if (requestTokens.delete(key) && eofPending && !closing && requestTokens.size === 0) drainFrames();
    }, { once: true });
    if (connection === undefined) throw new SdkProtocolError(-32603, "Internal error");
    const params = request.params;
    const args = Object.hasOwn(params, "arguments") ? params.arguments : undefined;
    let outcome: ToolBoundaryOutcome;
    try {
      const invocation = createInvocationContext(connection, {
        invocation_id: requestToken,
        transport_metadata: { request_id: externalRequestId(id), operation: "tools/call" }
      }, ctx.mcpReq.signal);
      outcome = await boundary.invoke(params.name, args, invocation);
      assertAuthenticToolBoundaryOutcome(outcome);
    } catch {
      // No branded outcome may cross the tool boundary unauthenticated; any
      // failure to produce one answers a prose-free internal error.
      throw new SdkProtocolError(-32603, "Internal error");
    }
    if (outcome.kind === "protocol-error") {
      const error = outcome.error.value;
      throw new SdkProtocolError(protocolCode(error), error.code, error);
    }
    const descriptor = ADVERTISED_TOOL_CATALOGUE.find(({ name }) => name === outcome.tool);
    if (descriptor === undefined) throw new SdkProtocolError(-32603, "Internal error");
    const structuredContent = wireResult(outcome);
    return server.projectCallToolResult({
      structuredContent,
      content: [{ type: "text", text: JSON.stringify(structuredContent) }],
      isError: !outcome.result.ok
    }, descriptor.outputSchema);
  });

  function handleFrame(frame: IngressFrame): void {
    if (closing) return;
    if (frame.kind === "parse-error") {
      void enqueue("direct", { jsonrpc: JSON_RPC, id: null, error: { code: -32700, message: "Parse error" } })
        .catch(() => undefined);
      if (frame.fatal) void terminate("protocol-fatal");
      return;
    }
    const value = frame.value;
    // The SDK's own dispatch predicate decides what counts as a request; the SDK
    // answers every dispatched request, so a token minted here always settles.
    if (isJSONRPCRequest(value as JSONRPCMessage)) {
      const request = value as { readonly id: JsonRpcId; readonly method: string };
      if (request.method === "initialize") {
        if (initializeAccepted || initializeInFlightKey !== undefined) {
          const repeated = createProtocolError("INITIALIZATION_REPEATED", { connection_id: CONNECTION_ID });
          void enqueue("direct", protocolResponse(externalRequestId(request.id), repeated)).catch(() => undefined);
          return;
        }
        initializeInFlightKey = requestKey(request.id);
      }
      requestTokens.set(requestKey(request.id), `request-${nextRequestNumber++}`);
    }
    transport.onmessage?.(value as JSONRPCMessage);
  }

  function drainFrames(): void {
    if (processing || closing || queue.backpressured || initializeInFlightKey !== undefined) return;
    processing = true;
    try {
      const frame = framer.next();
      if (frame !== undefined) {
        handleFrame(frame);
        // SDK dispatch and send admission settle through promises. Yield between
        // frames so initialized and a following request in one chunk observe
        // the admitted initialize response in protocol order.
        queueMicrotask(drainFrames);
      } else if (eofPending && !closing && !queue.backpressured) {
        const final = framer.finish();
        if (final !== undefined) {
          handleFrame(final);
          queueMicrotask(drainFrames);
        } else if (requestTokens.size === 0) {
          // Input is done and every dispatched request has settled; responses
          // still in flight keep the runtime alive until their tokens clear.
          void terminate("input-eof");
        }
      }
    } finally {
      processing = false;
    }
  }

  function onData(chunk: Buffer | string): void {
    if (closing) return;
    const bytes = typeof chunk === "string" ? Buffer.from(chunk, "utf8") : chunk;
    framer.append(bytes);
    drainFrames();
  }

  function onEnd(): void {
    eofPending = true;
    drainFrames();
  }

  function onInputError(): void {
    void terminate("input-error");
  }

  async function terminate(reason: RuntimeTermination["reason"]): Promise<void> {
    if (closePromise !== undefined) return closePromise;
    closing = true;
    removeInputListeners();
    options.input.pause();
    requestTokens.clear();
    closePromise = (async () => {
      let closeFailed = false;
      try { await server.close(); } catch { closeFailed = true; }
      try { await queue.close(); } catch { closeFailed = true; }
      options.output.off("error", onObservedOutputError);
      if (!terminated) {
        terminated = true;
        closed.resolve(Object.freeze({ reason, close_failed: closeFailed }));
      }
    })();
    return closePromise;
  }

  server.oninitialized = () => {
    if (closing || connection !== undefined) return;
    const client = server.getClientVersion();
    const protocolVersion = server.getNegotiatedProtocolVersion();
    if (client === undefined || protocolVersion === undefined) {
      void terminate("protocol-fatal");
      return;
    }
    try {
      connection = startup.initialize({
        client,
        host: deriveHostIdentity(client),
        protocol_version: protocolVersion
      });
    } catch {
      void terminate("protocol-fatal");
    }
  };

  await server.connect(transport);
  options.input.on("data", onData);
  options.input.on("end", onEnd);
  options.input.on("error", onInputError);
  options.input.resume();

  return Object.freeze({
    close: async (): Promise<void> => terminate("caller-close"),
    closed: closed.promise
  });
}

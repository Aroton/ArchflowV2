import { Buffer } from "node:buffer";
import type { Readable, Writable } from "node:stream";
import { isDeepStrictEqual } from "node:util";

import {
  ProtocolError as SdkProtocolError,
  Server,
  specTypeSchemas,
  type JSONRPCMessage,
  type ListToolsResult,
  type Transport
} from "@modelcontextprotocol/server";

import {
  connectionContextFactory,
  createInvocationContext,
  type ConnectionContext
} from "../contracts/contexts.js";
import type { ProtocolError } from "../contracts/errors.js";
import { deriveHostIdentity } from "../contracts/hosts.js";
import { createJsonLineFramer, type IngressFrame } from "./framing.js";
import { createSendQueue, type SendSource } from "./send-queue.js";
import {
  createToolBoundary,
  type ToolBoundaryOutcome,
  type ToolHandlerRegistry
} from "./server.js";
import {
  createSessionController,
  type ArgumentsCandidate,
  type ExpectedProjection,
  type JsonRpcId,
  type NameCandidate,
  type SessionAction
} from "./session.js";
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

interface ForwardedCall {
  readonly requestToken: string;
  readonly externalId: JsonRpcId;
  readonly nameCandidate: NameCandidate;
  readonly argumentsCandidate: ArgumentsCandidate;
}

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

function internalResponse(id: JsonRpcId): Readonly<Record<string, unknown>> {
  return { jsonrpc: JSON_RPC, id, error: { code: -32603, message: "Internal error" } };
}

function wireResult(outcome: Extract<ToolBoundaryOutcome, { kind: "project-result" }>): unknown {
  return JSON.parse(JSON.stringify(outcome.result)) as unknown;
}

function projectOutcome(
  server: Server,
  id: JsonRpcId,
  expected: ExpectedProjection
): Readonly<Record<string, unknown>> {
  const outcome = expected.outcome;
  if (outcome.kind === "protocol-error") return protocolResponse(id, outcome.error.value);
  const descriptor = ADVERTISED_TOOL_CATALOGUE.find(({ name }) => name === outcome.tool);
  if (descriptor === undefined) throw new TypeError("the projected tool is not advertised");
  const result = outcome.result;
  const structuredContent = wireResult(outcome);
  const projected = server.projectCallToolResult({
    structuredContent,
    content: [{ type: "text", text: JSON.stringify(structuredContent) }],
    isError: !result.ok
  }, descriptor.outputSchema);
  return { jsonrpc: JSON_RPC, id, result: projected };
}

function matchesExpectedProjection(
  server: Server,
  message: Readonly<Record<string, unknown>>,
  expected: ExpectedProjection
): boolean {
  const outcome = expected.outcome;
  if (outcome.kind === "protocol-error") {
    const error = message.error;
    return isObject(error) && error.message === outcome.error.value.code &&
      isDeepStrictEqual(error.data, outcome.error.value);
  }
  if (!Object.hasOwn(message, "result")) return false;
  const expectedMessage = projectOutcome(server, 0, expected);
  return isDeepStrictEqual(message.result, expectedMessage.result);
}

export async function startMcpRuntime(options: McpRuntimeOptions): Promise<McpRuntimeHandle> {
  if (!isObject(options) || typeof options.workingDirectory !== "string") {
    throw new TypeError("valid MCP runtime options are required");
  }

  const handlers = options.handlers ?? {};
  const boundary = createToolBoundary(handlers);
  const session = createSessionController({ connectionId: CONNECTION_ID });
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
  const forwardedCalls = new Map<number, ForwardedCall>();
  const sdkValidationCandidates = new Set<number>();
  const closed = deferred<RuntimeTermination>();
  let connection: ConnectionContext | undefined;
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
    requestToken?: string,
    expectedProjection?: ExpectedProjection
  ): Promise<void> => {
    if (closing) return Promise.reject(new Error("MCP runtime is closing"));
    let selected = message;
    try {
      if (expectedProjection !== undefined) {
        const id = message.id;
        if (typeof id !== "string" && typeof id !== "number") throw new TypeError("missing response ID");
        selected = matchesExpectedProjection(server, message, expectedProjection)
          ? projectOutcome(server, id, expectedProjection)
          : internalResponse(id);
      }
      const receipt = queue.enqueue({ source, frame: canonicalMessage(selected), ...(requestToken === undefined ? {} : { requestToken }) });
      void receipt.admitted.then(
        () => {
          session.onSendAdmitted(requestToken);
          drainFrames();
        },
        () => undefined
      );
      void receipt.completed.then(
        () => { if (requestToken !== undefined) session.onRouteSettled(requestToken); },
        () => undefined
      );
      return receipt.completed;
    } catch {
      if (requestToken !== undefined && typeof message.id !== "undefined") {
        try {
          const fallback = queue.enqueue({ source: "fallback", frame: canonicalMessage(internalResponse(message.id as JsonRpcId)), requestToken });
          void fallback.admitted.then(() => session.onSendAdmitted(requestToken), () => undefined);
          void fallback.completed.then(() => session.onRouteSettled(requestToken), () => undefined);
          return fallback.completed;
        } catch {
          // The terminal path below owns cleanup.
        }
      }
      void terminate("protocol-fatal");
      return Promise.reject(new Error("MCP response projection failed"));
    }
  };

  const applyActions = (actions: readonly SessionAction[]): void => {
    if (closing) return;
    for (const action of actions) {
      if (closing) return;
      if (action.kind === "protocol-fatal") {
        void terminate("protocol-fatal");
      } else if (action.kind === "connection-ready") {
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
      } else if (action.kind === "send") {
        void enqueue(action.source, action.message, action.requestToken, action.expectedProjection).catch(() => undefined);
      } else if (action.kind === "validate-cancellation") {
        if (specTypeSchemas.CancelledNotification["~standard"].validate(action.message).issues === undefined) {
          applyActions(session.acceptSdkMessage({
            kind: "cancellation-accepted",
            requestToken: action.requestToken
          }));
        }
      } else {
        if (action.route === "tools-call") {
          forwardedCalls.set(action.internalId, {
            requestToken: action.requestToken,
            externalId: action.externalId,
            nameCandidate: action.nameCandidate,
            argumentsCandidate: action.argumentsCandidate
          });
        }
        if (action.route === "tools-call" || action.route === "tools-list") {
          sdkValidationCandidates.add(action.internalId);
          const schema = action.route === "tools-call"
            ? specTypeSchemas.CallToolRequest
            : specTypeSchemas.ListToolsRequest;
          if (schema["~standard"].validate(action.message).issues !== undefined) {
            sdkValidationCandidates.delete(action.internalId);
            forwardedCalls.delete(action.internalId);
            const rejected = session.acceptSdkMessage({
              jsonrpc: JSON_RPC,
              id: action.internalId,
              error: { code: -32602, message: "Invalid params" }
            });
            for (const response of rejected) {
              if (response.kind === "send") {
                void enqueue("sdk", {
                  jsonrpc: JSON_RPC,
                  id: response.message.id,
                  error: { code: -32602, message: "Invalid params" }
                }, response.requestToken).catch(() => undefined);
              } else {
                applyActions([response]);
              }
            }
            continue;
          }
        }
        transport.onmessage?.(action.message as JSONRPCMessage);
      }
    }
  };

  const transport: Transport = {
    start: async () => undefined,
    send: async (message) => {
      if (closing) throw new Error("MCP runtime is closing");
      const rawMessage = message as unknown as Record<string, unknown>;
      const id = Object.hasOwn(rawMessage, "id") ? rawMessage.id : undefined;
      if (server.getNegotiatedProtocolVersion() !== undefined && typeof id === "number") {
        const token = `request-${id}`;
        applyActions(session.acceptSdkMessage({ kind: "initialize-mutated", requestToken: token }));
      }
      const actions = session.acceptSdkMessage(message);
      const completions: Promise<void>[] = [];
      for (const action of actions) {
        if (action.kind === "send") {
          if (typeof id === "number" && sdkValidationCandidates.delete(id) && Object.hasOwn(rawMessage, "error")) {
            forwardedCalls.delete(id);
            completions.push(enqueue("sdk", {
              jsonrpc: JSON_RPC,
              id: action.message.id,
              error: { code: -32602, message: "Invalid params" }
            }, action.requestToken));
          } else {
            completions.push(enqueue(action.source, action.message, action.requestToken, action.expectedProjection));
          }
        } else {
          applyActions([action]);
        }
      }
      await Promise.all(completions);
    },
    close: async () => { transport.onclose?.(); }
  };

  server.setRequestHandler("tools/list", async (_request, ctx) => {
    if (typeof ctx.mcpReq.id === "number") sdkValidationCandidates.delete(ctx.mcpReq.id);
    const token = `request-${String(ctx.mcpReq.id)}`;
    try {
      return { tools: structuredClone(ADVERTISED_TOOL_CATALOGUE) } as unknown as ListToolsResult;
    } finally {
      session.onRouteSettled(token);
    }
  });
  server.setRequestHandler("tools/call", async (_request, ctx) => {
    const internalId = ctx.mcpReq.id;
    if (typeof internalId === "number") sdkValidationCandidates.delete(internalId);
    const record = typeof internalId === "number" ? forwardedCalls.get(internalId) : undefined;
    if (record === undefined || connection === undefined || !record.nameCandidate.present) {
      throw new SdkProtocolError(-32603, "Internal error");
    }
    try {
      const args = record.argumentsCandidate.present ? record.argumentsCandidate.value : undefined;
      const invocation = createInvocationContext(connection, {
        invocation_id: record.requestToken,
        transport_metadata: { request_id: record.externalId, operation: "tools/call" }
      }, ctx.mcpReq.signal);
      const outcome = await boundary.invoke(record.nameCandidate.value, args, invocation);
      applyActions(session.acceptSdkMessage({
        kind: "tool-boundary-outcome",
        requestToken: record.requestToken,
        outcome
      }));
      if (outcome.kind === "protocol-error") {
        const error = outcome.error.value;
        throw new SdkProtocolError(protocolCode(error), error.code, error);
      }
      const descriptor = ADVERTISED_TOOL_CATALOGUE.find(({ name }) => name === outcome.tool);
      if (descriptor === undefined) throw new SdkProtocolError(-32603, "Internal error");
      const result = outcome.result;
      const structuredContent = wireResult(outcome);
      return server.projectCallToolResult({
        structuredContent,
        content: [{ type: "text", text: JSON.stringify(structuredContent) }],
        isError: !result.ok
      }, descriptor.outputSchema);
    } finally {
      forwardedCalls.delete(Number(internalId));
      session.onRouteSettled(record.requestToken);
    }
  });

  function handleFrame(frame: IngressFrame): void {
    if (closing) return;
    if (frame.kind === "parse-error") {
      void enqueue("direct", { jsonrpc: JSON_RPC, id: null, error: { code: -32700, message: "Parse error" } })
        .catch(() => undefined);
      if (frame.fatal) void terminate("protocol-fatal");
      return;
    }
    applyActions(session.accept(frame.value));
  }

  function drainFrames(): void {
    if (processing || closing || queue.backpressured || session.state === "INITIALIZING") return;
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
        } else if (!closing) {
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
    session.close();
    removeInputListeners();
    options.input.pause();
    forwardedCalls.clear();
    sdkValidationCandidates.clear();
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
    applyActions(session.acceptSdkMessage({ kind: "initialized-accepted" }));
    drainFrames();
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

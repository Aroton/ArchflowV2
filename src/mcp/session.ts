import { Buffer } from "node:buffer";

import { createProtocolError } from "../contracts/errors.js";
import { assertPlainJson, type PlainJsonValue } from "../contracts/plain-json.js";
import { isToolName } from "../contracts/tool-names.js";
import {
  assertAuthenticToolBoundaryOutcome,
  authenticateProtocolError,
  type ToolBoundaryOutcome
} from "./server.js";

export type SessionState =
  | "PRE_INIT"
  | "INITIALIZING"
  | "INIT_RESPONSE_ACCEPTED"
  | "READY"
  | "CLOSING"
  | "CLOSED";

export type RequestState = "executing" | "cancelling" | "response-queued";
export type JsonRpcId = string | number;
export type SessionRoute = "initialize" | "ping" | "tools-list" | "tools-call";

export type NameCandidate =
  | Readonly<{ present: false }>
  | Readonly<{ present: true; value: string }>;

export type ArgumentsCandidate =
  | Readonly<{ present: false }>
  | Readonly<{ present: true; value: unknown }>;

export type ExpectedProjection = Readonly<{
  kind: "tool-boundary";
  outcome: ToolBoundaryOutcome;
}>;

export type SessionSdkEvent =
  | Readonly<{
      kind: "tool-boundary-outcome";
      requestToken: string;
      outcome: ToolBoundaryOutcome;
    }>
  | Readonly<{
      kind: "initialize-mutated";
      requestToken: string;
    }>
  | Readonly<{ kind: "initialized-accepted" }>
  | Readonly<{ kind: "cancellation-accepted"; requestToken: string }>;

type BasicRequestRoute = "initialize" | "ping" | "tools-list";
type BasicRequestForwardAction = {
  readonly [R in BasicRequestRoute]: Readonly<{
      kind: "forward-sdk";
      route: R;
      message: Readonly<Record<string, unknown>>;
      requestToken: string;
      externalId: JsonRpcId;
      internalId: number;
    }>;
}[BasicRequestRoute];

type RequestForwardAction =
  | BasicRequestForwardAction
  | Readonly<{
      kind: "forward-sdk";
      route: "tools-call";
      message: Readonly<Record<string, unknown>>;
      requestToken: string;
      externalId: JsonRpcId;
      internalId: number;
      nameCandidate: NameCandidate;
      argumentsCandidate: ArgumentsCandidate;
    }>;

export type SessionAction =
  | Readonly<{
      kind: "send";
      source: "direct" | "sdk" | "fallback";
      message: Readonly<Record<string, unknown>>;
      requestToken?: string;
      expectedProjection?: ExpectedProjection;
    }>
  | RequestForwardAction
  | Readonly<{
      kind: "forward-sdk";
      route: "notifications/initialized";
      message: Readonly<Record<string, unknown>>;
    }>
  | Readonly<{
      kind: "validate-cancellation";
      message: Readonly<Record<string, unknown>>;
      requestToken: string;
      externalId: JsonRpcId;
      internalId: number;
    }>
  | Readonly<{
      kind: "forward-sdk";
      route: "cancel";
      message: Readonly<Record<string, unknown>>;
      requestToken: string;
      internalId: number;
    }>
  | Readonly<{ kind: "connection-ready" }>
  | Readonly<{ kind: "protocol-fatal" }>;

export interface SessionOptions {
  readonly connectionId: string;
  /** Production defaults are the protocol caps; lower values permit bounded harnesses. */
  readonly limits?: Readonly<{
    readonly seenIds?: number;
    readonly seenIdBytes?: number;
    readonly internalId?: number;
  }>;
}

export interface SessionController {
  readonly state: SessionState;
  readonly accept: (message: unknown) => readonly SessionAction[];
  readonly acceptSdkMessage: (message: unknown) => readonly SessionAction[];
  readonly onSendAdmitted: (requestToken?: string) => void;
  readonly onRouteSettled: (requestToken: string) => void;
  readonly close: () => void;
}

type AdmissionTransition = "initialize-success" | "initialize-error" | "ordinary";

interface RequestRecord {
  readonly token: string;
  readonly externalId: JsonRpcId;
  readonly internalId: number;
  readonly method: string;
  readonly route: SessionRoute;
  readonly nameCandidate: NameCandidate;
  readonly argumentsCandidate: ArgumentsCandidate;
  state: RequestState;
  initializeMutated: boolean;
  admissionTransition?: AdmissionTransition;
  outcome?: ToolBoundaryOutcome;
}

const JSON_RPC = "2.0";
const MAX_SEEN_IDS = 65_536;
const MAX_SEEN_ID_BYTES = 10 * 1024 * 1024;
const REQUEST_KEYS = new Set(["jsonrpc", "id", "method", "params"]);
const NOTIFICATION_KEYS = new Set(["jsonrpc", "method", "params"]);
const LIST_KEYS = new Set(["_meta"]);
const CALL_KEYS = new Set(["_meta", "task", "name", "arguments"]);

function deepFreeze<T>(value: T): T {
  if (value !== null && typeof value === "object" && !Object.isFrozen(value)) {
    for (const child of Object.values(value)) deepFreeze(child);
    Object.freeze(value);
  }
  return value;
}

function copiedObject(value: Record<string, unknown>): Readonly<Record<string, unknown>> {
  return deepFreeze(structuredClone(value as PlainJsonValue) as Record<string, unknown>);
}

function plainObject(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  try {
    assertPlainJson(value, "JSON-RPC message");
    return true;
  } catch {
    return false;
  }
}

function hasOnlyKeys(value: Record<string, unknown>, allowed: ReadonlySet<string>): boolean {
  return Object.keys(value).every((key) => allowed.has(key));
}

function normalizeId(value: unknown): JsonRpcId | undefined {
  if (typeof value === "string") return value;
  if (typeof value !== "number" || !Number.isSafeInteger(value)) return undefined;
  return Object.is(value, -0) ? 0 : value;
}

function idKey(id: JsonRpcId): string {
  return typeof id === "string" ? `s:${id}` : `n:${id}`;
}

function errorMessage(id: JsonRpcId | null, code: number, message: string, data?: unknown): Readonly<Record<string, unknown>> {
  const error: Record<string, unknown> = { code, message };
  if (data !== undefined) error.data = data;
  return deepFreeze({ jsonrpc: JSON_RPC, id, error: deepFreeze(error) });
}

function direct(message: Readonly<Record<string, unknown>>): readonly SessionAction[] {
  return [deepFreeze({ kind: "send" as const, source: "direct" as const, message })];
}

function invalidRequest(id: JsonRpcId | null): readonly SessionAction[] {
  return direct(errorMessage(id, -32600, "Invalid Request"));
}

function invalidParams(id: JsonRpcId): readonly SessionAction[] {
  return direct(errorMessage(id, -32602, "Invalid params"));
}

function methodNotFound(id: JsonRpcId): readonly SessionAction[] {
  return direct(errorMessage(id, -32601, "Method not found"));
}

function limits(options: SessionOptions): { seenIds: number; seenIdBytes: number; internalId: number } {
  const supplied = options.limits ?? {};
  const bounded = (value: number | undefined, maximum: number, label: string): number => {
    const selected = value ?? maximum;
    if (!Number.isSafeInteger(selected) || selected < 1 || selected > maximum) {
      throw new TypeError(`${label} must be a positive safe integer no greater than ${maximum}`);
    }
    return selected;
  };
  return {
    seenIds: bounded(supplied.seenIds, MAX_SEEN_IDS, "seen ID limit"),
    seenIdBytes: bounded(supplied.seenIdBytes, MAX_SEEN_ID_BYTES, "seen ID byte limit"),
    internalId: bounded(supplied.internalId, Number.MAX_SAFE_INTEGER, "internal ID limit")
  };
}

export function createSessionController(options: SessionOptions): SessionController {
  if (!plainObject(options as unknown)) throw new TypeError("session options must be a plain object");
  if (typeof options.connectionId !== "string") throw new TypeError("a connection ID is required");
  // The protocol constructor is the authority for the exact safe connection-ID vocabulary.
  createProtocolError("INITIALIZATION_REPEATED", { connection_id: options.connectionId });
  const caps = limits(options);
  const seen = new Set<string>();
  const byToken = new Map<string, RequestRecord>();
  const byInternalId = new Map<number, RequestRecord>();
  const byExternalId = new Map<string, RequestRecord>();
  const pendingCancellations = new Map<string, Readonly<Record<string, unknown>>>();
  let currentState: SessionState = "PRE_INIT";
  let seenBytes = 0;
  let nextInternalId = 1;

  const fatal = (): readonly SessionAction[] => {
    if (currentState === "CLOSING" || currentState === "CLOSED") return [];
    currentState = "CLOSING";
    byToken.clear();
    byInternalId.clear();
    byExternalId.clear();
    pendingCancellations.clear();
    return [deepFreeze({ kind: "protocol-fatal" as const })];
  };

  const admitId = (id: JsonRpcId): "new" | "seen" | "fatal" => {
    const key = idKey(id);
    if (seen.has(key)) return "seen";
    const bytes = Buffer.byteLength(key, "utf8");
    if (seen.size >= caps.seenIds || seenBytes + bytes > caps.seenIdBytes) return "fatal";
    seen.add(key);
    seenBytes += bytes;
    return "new";
  };

  const allocate = (
    externalId: JsonRpcId,
    method: string,
    route: SessionRoute,
    nameCandidate: NameCandidate = deepFreeze({ present: false }),
    argumentsCandidate: ArgumentsCandidate = deepFreeze({ present: false })
  ): RequestRecord | undefined => {
    if (nextInternalId > caps.internalId || !Number.isSafeInteger(nextInternalId)) return undefined;
    const internalId = nextInternalId;
    nextInternalId += 1;
    const token = `request-${internalId}`;
    const record: RequestRecord = {
      token,
      externalId,
      internalId,
      method,
      route,
      nameCandidate,
      argumentsCandidate,
      state: "executing",
      initializeMutated: false
    };
    byToken.set(token, record);
    byInternalId.set(internalId, record);
    byExternalId.set(idKey(externalId), record);
    return record;
  };

  const forward = (record: RequestRecord, message: Record<string, unknown>): readonly SessionAction[] => {
    const rewritten = copiedObject({ ...message, id: record.internalId });
    if (record.route === "tools-call") {
      return [deepFreeze({
        kind: "forward-sdk" as const,
        route: "tools-call" as const,
        message: rewritten,
        requestToken: record.token,
        externalId: record.externalId,
        internalId: record.internalId,
        nameCandidate: record.nameCandidate,
        argumentsCandidate: record.argumentsCandidate
      })];
    }
    return [deepFreeze({
      kind: "forward-sdk" as const,
      route: record.route,
      message: rewritten,
      requestToken: record.token,
      externalId: record.externalId,
      internalId: record.internalId
    }) as RequestForwardAction];
  };

  const acceptRequest = (message: Record<string, unknown>): readonly SessionAction[] => {
    const normalizedId = normalizeId(message.id);
    if (message.jsonrpc !== JSON_RPC || typeof message.method !== "string" || normalizedId === undefined) {
      return invalidRequest(null);
    }
    const idAdmission = admitId(normalizedId);
    if (idAdmission === "seen") return invalidRequest(null);
    if (idAdmission === "fatal") return fatal();
    if (!hasOnlyKeys(message, REQUEST_KEYS)) return invalidRequest(normalizedId);

    const method = message.method;
    if (method === "initialize") {
      if (currentState !== "PRE_INIT") {
        const error = authenticateProtocolError(createProtocolError("INITIALIZATION_REPEATED", {
          connection_id: options.connectionId
        }));
        return direct(errorMessage(normalizedId, -32004, "INITIALIZATION_REPEATED", error.value));
      }
      const record = allocate(normalizedId, method, "initialize");
      if (record === undefined) return fatal();
      currentState = "INITIALIZING";
      return forward(record, message);
    }

    if (currentState === "PRE_INIT") return invalidRequest(normalizedId);

    if (method === "ping") {
      const record = allocate(normalizedId, method, "ping");
      return record === undefined ? fatal() : forward(record, message);
    }

    if (method === "tools/list") {
      if (currentState !== "READY") return invalidRequest(normalizedId);
      if (Object.hasOwn(message, "params")) {
        if (!plainObject(message.params) || !hasOnlyKeys(message.params, LIST_KEYS)) return invalidParams(normalizedId);
      }
      const record = allocate(normalizedId, method, "tools-list");
      return record === undefined ? fatal() : forward(record, message);
    }

    if (method === "tools/call") {
      if (currentState !== "READY") return invalidRequest(normalizedId);
      if (!plainObject(message.params) || !hasOnlyKeys(message.params, CALL_KEYS)) return invalidParams(normalizedId);
      const params = message.params;
      if (typeof params.name !== "string") return invalidParams(normalizedId);
      const nameCandidate = deepFreeze({ present: true as const, value: params.name });
      const argumentsCandidate: ArgumentsCandidate = Object.hasOwn(params, "arguments")
        ? deepFreeze({ present: true as const, value: structuredClone(params.arguments as PlainJsonValue) })
        : deepFreeze({ present: false as const });
      if (argumentsCandidate.present && !plainObject(argumentsCandidate.value) && !isToolName(params.name)) {
        return invalidParams(normalizedId);
      }
      const record = allocate(normalizedId, method, "tools-call", nameCandidate, argumentsCandidate);
      if (record === undefined) return fatal();
      let forwarded = message;
      if (argumentsCandidate.present && !plainObject(argumentsCandidate.value)) {
        forwarded = {
          ...message,
          params: { ...params, name: params.name, arguments: {} }
        };
      }
      return forward(record, forwarded);
    }

    return currentState === "READY" ? methodNotFound(normalizedId) : invalidRequest(normalizedId);
  };

  const acceptNotification = (message: Record<string, unknown>): readonly SessionAction[] => {
    if (message.jsonrpc !== JSON_RPC || typeof message.method !== "string" || !hasOnlyKeys(message, NOTIFICATION_KEYS)) return [];
    if (message.method === "notifications/initialized") {
      if (currentState !== "INIT_RESPONSE_ACCEPTED") return [];
      return [deepFreeze({
        kind: "forward-sdk" as const,
        message: copiedObject(message),
        route: "notifications/initialized" as const
      })];
    }
    if (message.method !== "notifications/cancelled" || !plainObject(message.params)) return [];
    const target = normalizeId(message.params.requestId);
    if (target === undefined) return [];
    const record = byExternalId.get(idKey(target));
    if (record === undefined || record.route === "initialize" || record.state !== "executing") return [];
    const candidate = copiedObject(message);
    pendingCancellations.set(record.token, candidate);
    return [deepFreeze({
      kind: "validate-cancellation" as const,
      message: candidate,
      requestToken: record.token,
      externalId: record.externalId,
      internalId: record.internalId
    })];
  };

  const accept = (message: unknown): readonly SessionAction[] => {
    if (currentState === "CLOSING" || currentState === "CLOSED") return [];
    if (!plainObject(message)) return invalidRequest(null);
    if (Object.hasOwn(message, "id") && Object.hasOwn(message, "method")) return acceptRequest(message);
    if (!Object.hasOwn(message, "id") && Object.hasOwn(message, "method")) return acceptNotification(message);
    // This runtime initiates no requests. Any syntactically valid response is unmatched,
    // and malformed response-like input is also silent to avoid response loops.
    if (Object.hasOwn(message, "id") && message.jsonrpc === JSON_RPC) return [];
    return invalidRequest(null);
  };

  const acceptSdkEvent = (event: SessionSdkEvent): readonly SessionAction[] => {
    if (event.kind === "initialized-accepted") {
      if (currentState !== "INIT_RESPONSE_ACCEPTED") return [];
      currentState = "READY";
      return [deepFreeze({ kind: "connection-ready" as const })];
    }
    const record = byToken.get(event.requestToken);
    if (record === undefined || record.state === "response-queued") return [];
    if (event.kind === "cancellation-accepted") {
      const candidate = pendingCancellations.get(record.token);
      if (candidate === undefined || record.route === "initialize" || record.state !== "executing") return [];
      pendingCancellations.delete(record.token);
      record.state = "cancelling";
      const params = candidate.params as Record<string, unknown>;
      return [deepFreeze({
        kind: "forward-sdk" as const,
        route: "cancel" as const,
        message: copiedObject({ ...candidate, params: { ...params, requestId: record.internalId } }),
        requestToken: record.token,
        internalId: record.internalId
      })];
    }
    if (event.kind === "initialize-mutated") {
      if (record.route === "initialize") record.initializeMutated = true;
      return [];
    }
    assertAuthenticToolBoundaryOutcome(event.outcome);
    if (record.route !== "tools-call") return fatal();
    record.outcome = event.outcome;
    return [];
  };

  const isSdkEvent = (value: unknown): value is SessionSdkEvent => {
    if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
    try {
      const candidate = value as Record<string, unknown>;
      const kind = Object.getOwnPropertyDescriptor(candidate, "kind");
      if (kind === undefined || !("value" in kind)) return false;
      if (kind.value === "initialized-accepted") return true;
      const token = Object.getOwnPropertyDescriptor(candidate, "requestToken");
      if (token === undefined || !("value" in token)) return false;
      if (typeof token.value !== "string") return false;
      return kind.value === "initialize-mutated" || kind.value === "tool-boundary-outcome" ||
        kind.value === "cancellation-accepted";
    } catch {
      return false;
    }
  };

  const acceptSdkMessage = (message: unknown): readonly SessionAction[] => {
    if (currentState === "CLOSING" || currentState === "CLOSED") return [];
    if (isSdkEvent(message)) return acceptSdkEvent(message);
    if (!plainObject(message)) return fatal();
    const internalId = normalizeId(message.id);
    if (typeof internalId !== "number" || internalId <= 0) return [];
    const record = byInternalId.get(internalId);
    if (record === undefined || record.state === "response-queued") return [];
    const hasResult = Object.hasOwn(message, "result");
    const hasError = Object.hasOwn(message, "error");
    if (message.jsonrpc !== JSON_RPC || hasResult === hasError) return fatal();

    let projected: Readonly<Record<string, unknown>>;
    let source: "sdk" | "fallback" = "sdk";
    if (record.route === "initialize") {
      if (hasError) {
        if (record.initializeMutated) return fatal();
        projected = errorMessage(record.externalId, -32602, "Invalid params");
        record.admissionTransition = "initialize-error";
      } else {
        projected = copiedObject({ jsonrpc: JSON_RPC, id: record.externalId, result: message.result });
        record.admissionTransition = "initialize-success";
      }
    } else {
      projected = copiedObject(hasResult
        ? { jsonrpc: JSON_RPC, id: record.externalId, result: message.result }
        : { jsonrpc: JSON_RPC, id: record.externalId, error: message.error });
      record.admissionTransition = "ordinary";
      if (record.route === "tools-call" && record.outcome === undefined) {
        projected = errorMessage(record.externalId, -32603, "Internal error");
        source = "fallback";
      }
    }
    record.state = "response-queued";
    const expectedProjection = record.outcome === undefined
      ? undefined
      : deepFreeze({ kind: "tool-boundary" as const, outcome: record.outcome });
    const action = {
      kind: "send" as const,
      source,
      message: projected,
      requestToken: record.token,
      ...(expectedProjection === undefined ? {} : { expectedProjection })
    };
    return [deepFreeze(action)];
  };

  const removeRecord = (record: RequestRecord): void => {
    byToken.delete(record.token);
    byInternalId.delete(record.internalId);
    byExternalId.delete(idKey(record.externalId));
    pendingCancellations.delete(record.token);
  };

  const onSendAdmitted = (requestToken?: string): void => {
    if (currentState === "CLOSING" || currentState === "CLOSED" || requestToken === undefined) return;
    const record = byToken.get(requestToken);
    if (record === undefined || record.state !== "response-queued") return;
    const transition = record.admissionTransition;
    removeRecord(record);
    if (transition === "initialize-success" && currentState === "INITIALIZING") {
      currentState = "INIT_RESPONSE_ACCEPTED";
    } else if (transition === "initialize-error" && currentState === "INITIALIZING") {
      currentState = "PRE_INIT";
    }
  };

  const onRouteSettled = (requestToken: string): void => {
    if (currentState === "CLOSING" || currentState === "CLOSED") return;
    const record = byToken.get(requestToken);
    if (record?.state === "cancelling") removeRecord(record);
  };

  const controller: SessionController = {
    get state(): SessionState {
      return currentState;
    },
    accept,
    acceptSdkMessage,
    onSendAdmitted,
    onRouteSettled,
    close: (): void => {
      if (currentState === "CLOSED") return;
      currentState = "CLOSED";
      byToken.clear();
      byInternalId.clear();
      byExternalId.clear();
      pendingCancellations.clear();
    }
  };
  return Object.freeze(controller);
}

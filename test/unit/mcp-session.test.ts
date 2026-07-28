import { describe, expect, it } from "vitest";

import { connectionContextFactory, createInvocationContext } from "../../src/contracts/contexts.js";
import { createSessionController, type SessionAction, type SessionController } from "../../src/mcp/session.js";
import { createToolBoundary } from "../../src/mcp/server.js";

if (false) {
  // @ts-expect-error tools-call forwards require both recovery candidates
  const incompleteToolsCall: SessionAction = {
    kind: "forward-sdk", route: "tools-call", message: {}, requestToken: "request-1", externalId: 1, internalId: 1
  };
  const identifiedInitialized: SessionAction = {
    kind: "forward-sdk", route: "notifications/initialized", message: {},
    // @ts-expect-error initialized forwards carry no request identity
    requestToken: "request-1"
  };
  const externalCancellation: SessionAction = {
    kind: "forward-sdk", route: "cancel", message: {}, requestToken: "request-1", internalId: 1,
    // @ts-expect-error cancellation forwards expose only their internal route identity
    externalId: 1
  };
  void incompleteToolsCall;
  void identifiedInitialized;
  void externalCancellation;
}

const request = (id: string | number, method: string, params?: unknown): Record<string, unknown> => ({
  jsonrpc: "2.0",
  id,
  method,
  ...(params === undefined ? {} : { params })
});

const notification = (method: string, params?: unknown): Record<string, unknown> => ({
  jsonrpc: "2.0",
  method,
  ...(params === undefined ? {} : { params })
});

const first = (actions: readonly SessionAction[]): SessionAction => {
  expect(actions).toHaveLength(1);
  return actions[0]!;
};

type RequestForward = Extract<SessionAction, { kind: "forward-sdk" }> & {
  readonly requestToken: string;
  readonly externalId: string | number;
  readonly internalId: number;
  readonly nameCandidate?: unknown;
  readonly argumentsCandidate?: unknown;
};

const forwarded = (actions: readonly SessionAction[]): RequestForward => {
  const action = first(actions);
  expect(action.kind).toBe("forward-sdk");
  return action as RequestForward;
};

const sent = (actions: readonly SessionAction[]): Extract<SessionAction, { kind: "send" }> => {
  const action = first(actions);
  expect(action.kind).toBe("send");
  return action as Extract<SessionAction, { kind: "send" }>;
};

const cancellationCandidate = (
  actions: readonly SessionAction[]
): Extract<SessionAction, { kind: "validate-cancellation" }> => {
  const action = first(actions);
  expect(action.kind).toBe("validate-cancellation");
  return action as Extract<SessionAction, { kind: "validate-cancellation" }>;
};

function initialize(controller: SessionController, id: string | number = "init"): string {
  const action = forwarded(controller.accept(request(id, "initialize", {
    protocolVersion: "2025-11-25",
    capabilities: {},
    clientInfo: { name: "Codex", version: "1" }
  })));
  const response = sent(controller.acceptSdkMessage({
    jsonrpc: "2.0",
    id: action.internalId,
    result: {
      protocolVersion: "2025-11-25",
      capabilities: { tools: {} },
      serverInfo: { name: "archflow-mcp", version: "0.0.0" }
    }
  }));
  controller.onSendAdmitted(response.requestToken);
  expect(controller.state).toBe("INIT_RESPONSE_ACCEPTED");
  const initialized = controller.accept(notification("notifications/initialized"));
  expect(forwarded(initialized).route).toBe("notifications/initialized");
  expect(controller.state).toBe("INIT_RESPONSE_ACCEPTED");
  const ready = controller.acceptSdkMessage({ kind: "initialized-accepted" });
  expect(ready).toEqual([{ kind: "connection-ready" }]);
  expect(controller.state).toBe("READY");
  return action.requestToken!;
}

describe("MCP session admission and lifecycle", () => {
  it("normalizes IDs, rewrites internal IDs, and becomes ready before the next message", () => {
    const controller = createSessionController({ connectionId: "connection-1" });
    const init = forwarded(controller.accept(request(-0, "initialize", {})));
    expect(init).toMatchObject({ route: "initialize", externalId: 0, internalId: 1, requestToken: "request-1" });
    expect(init.message.id).toBe(1);
    expect(controller.state).toBe("INITIALIZING");

    const response = sent(controller.acceptSdkMessage({ jsonrpc: "2.0", id: 1, result: { ok: true } }));
    expect(response.message).toEqual({ jsonrpc: "2.0", id: 0, result: { ok: true } });
    controller.onSendAdmitted(response.requestToken);
    expect(controller.state).toBe("INIT_RESPONSE_ACCEPTED");

    const initialized = controller.accept(notification("notifications/initialized"));
    expect(forwarded(initialized).route).toBe("notifications/initialized");
    expect(controller.state).toBe("INIT_RESPONSE_ACCEPTED");
    const ready = controller.acceptSdkMessage({ kind: "initialized-accepted" });
    expect(ready).toEqual([{ kind: "connection-ready" }]);
    expect(controller.state).toBe("READY");
    expect(forwarded(controller.accept(request("call", "tools/list"))).internalId).toBe(2);
  });

  it("makes malformed initialization retry transactional only after error send admission", () => {
    const controller = createSessionController({ connectionId: "connection-2" });
    const initial = forwarded(controller.accept(request(1, "initialize", { malformed: true })));
    const response = sent(controller.acceptSdkMessage({
      jsonrpc: "2.0",
      id: initial.internalId,
      error: { code: -32602, message: "SDK validator prose", data: { arbitrary: "input" } }
    }));
    expect(response.message).toEqual({
      jsonrpc: "2.0",
      id: 1,
      error: { code: -32602, message: "Invalid params" }
    });
    expect(controller.state).toBe("INITIALIZING");
    controller.onSendAdmitted(response.requestToken);
    expect(controller.state).toBe("PRE_INIT");
    expect(forwarded(controller.accept(request(2, "initialize", {}))).internalId).toBe(2);
  });

  it("fails closed when an initialize error follows an observed SDK mutation", () => {
    const controller = createSessionController({ connectionId: "connection-3" });
    const action = forwarded(controller.accept(request(1, "initialize", {})));
    expect(controller.acceptSdkMessage({ kind: "initialize-mutated", requestToken: action.requestToken })).toEqual([]);
    expect(controller.acceptSdkMessage({ jsonrpc: "2.0", id: action.internalId, error: { code: -32602 } })).toEqual([
      { kind: "protocol-fatal" }
    ]);
    expect(controller.state).toBe("CLOSING");
  });

  it("mints readiness only after SDK acceptance of the exact initialized notification", () => {
    const controller = createSessionController({ connectionId: "initialized" });
    const init = forwarded(controller.accept(request(1, "initialize", {})));
    const response = sent(controller.acceptSdkMessage({ jsonrpc: "2.0", id: init.internalId, result: {} }));
    controller.onSendAdmitted(response.requestToken);
    expect(controller.state).toBe("INIT_RESPONSE_ACCEPTED");

    expect(controller.accept(notification("initialized"))).toEqual([]);
    expect(controller.state).toBe("INIT_RESPONSE_ACCEPTED");
    const malformed = forwarded(controller.accept(notification("notifications/initialized", { unexpected: true })));
    expect(malformed.route).toBe("notifications/initialized");
    expect(controller.state).toBe("INIT_RESPONSE_ACCEPTED");

    const valid = forwarded(controller.accept(notification("notifications/initialized")));
    expect(valid.message).toEqual({ jsonrpc: "2.0", method: "notifications/initialized" });
    expect(controller.state).toBe("INIT_RESPONSE_ACCEPTED");
    expect(controller.acceptSdkMessage({ kind: "initialized-accepted" })).toEqual([{ kind: "connection-ready" }]);
    expect(controller.state).toBe("READY");
    expect(controller.acceptSdkMessage({ kind: "initialized-accepted" })).toEqual([]);
  });

  it("uses authentic INITIALIZATION_REPEATED projection and spends the repeated ID", () => {
    const controller = createSessionController({ connectionId: "connection-4" });
    controller.accept(request("first", "initialize", {}));
    const repeated = sent(controller.accept(request("second", "initialize", {})));
    expect(repeated.message).toMatchObject({
      id: "second",
      error: {
        code: -32004,
        message: "INITIALIZATION_REPEATED",
        data: { code: "INITIALIZATION_REPEATED", diagnostic: { parameters: { connection_id: "connection-4" } } }
      }
    });
    expect(sent(controller.accept(request("second", "initialize", {}))).message).toEqual({
      jsonrpc: "2.0",
      id: null,
      error: { code: -32600, message: "Invalid Request" }
    });
  });

  it("implements ping and closed request routing in every lifecycle class", () => {
    const pre = createSessionController({ connectionId: "pre" });
    expect(sent(pre.accept(request(1, "ping"))).message).toMatchObject({ id: 1, error: { code: -32600 } });
    expect(sent(pre.accept(request(2, "tools/list"))).message).toMatchObject({ id: 2, error: { code: -32600 } });
    expect(sent(pre.accept(request(3, "other"))).message).toMatchObject({ id: 3, error: { code: -32600 } });

    const active = createSessionController({ connectionId: "active" });
    active.accept(request("i", "initialize", {}));
    expect(forwarded(active.accept(request("p", "ping"))).route).toBe("ping");
    expect(sent(active.accept(request("l", "tools/list"))).message).toMatchObject({ error: { code: -32600 } });

    const ready = createSessionController({ connectionId: "ready" });
    initialize(ready);
    expect(forwarded(ready.accept(request("p", "ping"))).route).toBe("ping");
    expect(sent(ready.accept(request("x", "unknown/method"))).message).toMatchObject({
      id: "x",
      error: { code: -32601, message: "Method not found" }
    });
  });

  it("rejects unsafe envelopes and exact extra request members before routing", () => {
    const controller = createSessionController({ connectionId: "envelopes" });
    expect(sent(controller.accept([])).message).toMatchObject({ id: null, error: { code: -32600 } });
    expect(sent(controller.accept({ jsonrpc: "1.0", id: 1, method: "initialize" })).message).toMatchObject({ id: null });
    expect(sent(controller.accept({ jsonrpc: "2.0", id: Number.MAX_SAFE_INTEGER + 1, method: "initialize" })).message).toMatchObject({ id: null });
    expect(sent(controller.accept({ ...request("spent", "initialize"), extra: true })).message).toMatchObject({ id: "spent" });
    expect(sent(controller.accept(request("spent", "initialize"))).message).toMatchObject({ id: null });
  });
});

describe("MCP session tool routing", () => {
  it("enforces the exact tools/list params allowlist while preserving _meta", () => {
    const controller = createSessionController({ connectionId: "list" });
    initialize(controller);
    expect(forwarded(controller.accept(request(1, "tools/list"))).message).not.toHaveProperty("params");
    expect(forwarded(controller.accept(request(2, "tools/list", {}))).message.params).toEqual({});
    const metadata = { progressToken: "token" };
    expect(forwarded(controller.accept(request(3, "tools/list", { _meta: metadata }))).message.params).toEqual({ _meta: metadata });
    expect(sent(controller.accept(request(4, "tools/list", { cursor: "x" }))).message).toMatchObject({ error: { code: -32602 } });
    expect(sent(controller.accept(request(5, "tools/list", { other: true }))).message).toMatchObject({ error: { code: -32602 } });
    expect(sent(controller.accept(request(6, "tools/list", null))).message).toMatchObject({ error: { code: -32602 } });
  });

  it("preserves SDK-only call fields and tags missing and object argument candidates", () => {
    const controller = createSessionController({ connectionId: "calls" });
    initialize(controller);
    const missing = forwarded(controller.accept(request(1, "tools/call", {
      _meta: { progressToken: 1 },
      task: { id: "legacy" },
      name: "archflow_state"
    })));
    expect(missing.message.params).toEqual({
      _meta: { progressToken: 1 },
      task: { id: "legacy" },
      name: "archflow_state"
    });
    expect(missing.nameCandidate).toEqual({ present: true, value: "archflow_state" });
    expect(missing.argumentsCandidate).toEqual({ present: false });

    const object = { schema_version: "1", extra: "boundary-owned" };
    const present = forwarded(controller.accept(request(2, "tools/call", {
      name: "archflow_state",
      arguments: object
    })));
    expect((present.message.params as Record<string, unknown>).arguments).toEqual(object);
    expect(present.argumentsCandidate).toEqual({ present: true, value: object });
  });

  it("uses a surrogate only for known present non-object arguments", () => {
    const controller = createSessionController({ connectionId: "surrogate" });
    initialize(controller);
    for (const [id, value] of [[1, null], [2, "bad"], [3, []]] as const) {
      const action = forwarded(controller.accept(request(id, "tools/call", {
        name: "archflow_state",
        arguments: value
      })));
      expect((action.message.params as Record<string, unknown>).arguments).toEqual({});
      expect(action.argumentsCandidate).toEqual({ present: true, value });
    }
    expect(sent(controller.accept(request(4, "tools/call", { name: "not-a-tool", arguments: 1 }))).message)
      .toMatchObject({ error: { code: -32602 } });
    expect(forwarded(controller.accept(request(5, "tools/call", { name: "not-a-tool", arguments: {} }))).argumentsCandidate)
      .toEqual({ present: true, value: {} });
  });

  it("rejects missing names, missing params, and every extra call key", () => {
    const controller = createSessionController({ connectionId: "call-shape" });
    initialize(controller);
    expect(sent(controller.accept(request(1, "tools/call"))).message).toMatchObject({ error: { code: -32602 } });
    expect(sent(controller.accept(request(2, "tools/call", {}))).message).toMatchObject({ error: { code: -32602 } });
    expect(sent(controller.accept(request(3, "tools/call", { name: 1 }))).message).toMatchObject({ error: { code: -32602 } });
    expect(sent(controller.accept(request(4, "tools/call", { name: "archflow_state", extra: true }))).message)
      .toMatchObject({ error: { code: -32602 } });
  });

  it("retains authentic outcomes as expected projections and falls back when absent", async () => {
    const controller = createSessionController({ connectionId: "outcomes" });
    initialize(controller);
    const call = forwarded(controller.accept(request(1, "tools/call", { name: "unknown", arguments: {} })));
    const connection = connectionContextFactory.captureStartup({
      connection_id: "outcomes",
      startup_repository_candidate: { working_directory: "/work" }
    }).initialize({ client: { name: "Codex", version: "1" }, host: "codex", protocol_version: "2025-11-25" });
    const context = createInvocationContext(connection, {
      invocation_id: "request-1",
      transport_metadata: { request_id: 1, operation: "tools/call" }
    }, new AbortController().signal);
    const outcome = await createToolBoundary({}).invoke("unknown", {}, context);
    expect(controller.acceptSdkMessage({
      kind: "tool-boundary-outcome",
      requestToken: call.requestToken,
      outcome
    })).toEqual([]);
    const projected = sent(controller.acceptSdkMessage({
      jsonrpc: "2.0",
      id: call.internalId,
      error: { code: -32602, message: "SDK rewrite" }
    }));
    expect(projected.expectedProjection).toEqual({ kind: "tool-boundary", outcome });
    expect(projected.source).toBe("sdk");
    controller.onSendAdmitted(projected.requestToken);
    expect(sent(controller.accept(request(1, "ping"))).message).toMatchObject({
      id: null,
      error: { code: -32600 }
    });

    const missing = forwarded(controller.accept(request(2, "tools/call", { name: "unknown", arguments: {} })));
    const fallback = sent(controller.acceptSdkMessage({ jsonrpc: "2.0", id: missing.internalId, result: {} }));
    expect(fallback.source).toBe("fallback");
    expect(fallback.message).toMatchObject({ id: 2, error: { code: -32603, message: "Internal error" } });
    controller.onSendAdmitted(fallback.requestToken);
    expect(sent(controller.accept(request(2, "ping"))).message).toMatchObject({
      id: null,
      error: { code: -32600 }
    });
  });
});

describe("MCP session cancellation, ledgers, and shutdown", () => {
  it("keeps cancelling tombstones, ignores initialize/completed targets, and never frees seen IDs", () => {
    const controller = createSessionController({ connectionId: "cancel" });
    const init = forwarded(controller.accept(request("init", "initialize", {})));
    expect(controller.accept(notification("notifications/cancelled", { requestId: "init" }))).toEqual([]);
    controller.acceptSdkMessage({ jsonrpc: "2.0", id: init.internalId, result: {} });
    controller.onSendAdmitted(init.requestToken);
    controller.accept(notification("notifications/initialized"));
    controller.acceptSdkMessage({ kind: "initialized-accepted" });

    const active = forwarded(controller.accept(request(-0, "ping")));
    const candidate = cancellationCandidate(controller.accept(notification("notifications/cancelled", { requestId: 0, reason: "stop" })));
    expect(candidate).toMatchObject({ internalId: active.internalId, requestToken: active.requestToken });
    expect(candidate.message).toMatchObject({ params: { requestId: 0, reason: "stop" } });
    const cancellation = forwarded(controller.acceptSdkMessage({
      kind: "cancellation-accepted",
      requestToken: candidate.requestToken
    }));
    expect(cancellation).toMatchObject({ route: "cancel", internalId: active.internalId, requestToken: active.requestToken });
    expect(cancellation.message).toMatchObject({ params: { requestId: active.internalId, reason: "stop" } });
    expect(controller.accept(notification("notifications/cancelled", { requestId: 0 }))).toEqual([]);
    controller.onRouteSettled(active.requestToken!);
    expect(sent(controller.accept(request(0, "ping"))).message).toMatchObject({ id: null, error: { code: -32600 } });

    const queued = forwarded(controller.accept(request("queued", "ping")));
    const send = sent(controller.acceptSdkMessage({ jsonrpc: "2.0", id: queued.internalId, result: {} }));
    expect(controller.accept(notification("notifications/cancelled", { requestId: "queued" }))).toEqual([]);
    controller.onSendAdmitted(send.requestToken);
  });

  it("does not mutate a request until a cancellation candidate is accepted", () => {
    const controller = createSessionController({ connectionId: "candidate" });
    initialize(controller);
    const active = forwarded(controller.accept(request(1, "ping")));
    const malformed = cancellationCandidate(controller.accept(notification("notifications/cancelled", {
      requestId: 1,
      reason: { invalid: true }
    })));
    const response = sent(controller.acceptSdkMessage({ jsonrpc: "2.0", id: active.internalId, result: {} }));
    expect(response.message).toEqual({ jsonrpc: "2.0", id: 1, result: {} });
    expect(controller.acceptSdkMessage({
      kind: "cancellation-accepted",
      requestToken: malformed.requestToken
    })).toEqual([]);
  });

  it("distinguishes string and numeric IDs and rejects normalized reuse permanently", () => {
    const controller = createSessionController({ connectionId: "ids" });
    controller.accept(request(-0, "initialize", {}));
    expect(sent(controller.accept(request(0, "ping"))).message).toMatchObject({ id: null, error: { code: -32600 } });
    expect(forwarded(controller.accept(request("0", "ping"))).externalId).toBe("0");
  });

  it("fails closed at the seen-count, seen-byte, and monotonic internal-ID boundaries", () => {
    const count = createSessionController({ connectionId: "count", limits: { seenIds: 2 } });
    count.accept(request(1, "initialize", {}));
    count.accept(request(2, "ping"));
    expect(count.accept(request(3, "ping"))).toEqual([{ kind: "protocol-fatal" }]);
    expect(count.state).toBe("CLOSING");

    const byte = createSessionController({ connectionId: "byte", limits: { seenIdBytes: 4 } });
    expect(byte.accept(request("abc", "initialize", {}))).toEqual([{ kind: "protocol-fatal" }]);

    const internal = createSessionController({ connectionId: "internal", limits: { internalId: 1 } });
    internal.accept(request(1, "initialize", {}));
    expect(internal.accept(request(2, "ping"))).toEqual([{ kind: "protocol-fatal" }]);
  });

  it("silently drops notifications and unmatched responses", () => {
    const controller = createSessionController({ connectionId: "silence" });
    expect(controller.accept(notification("unknown", { arbitrary: true }))).toEqual([]);
    expect(controller.accept({ ...notification("unknown"), extra: true })).toEqual([]);
    expect(controller.accept({ jsonrpc: "2.0", id: 10, result: {} })).toEqual([]);
    expect(controller.accept({ jsonrpc: "2.0", id: "x", error: { code: -1 } })).toEqual([]);
    expect(controller.acceptSdkMessage({ jsonrpc: "2.0", id: 999, result: {} })).toEqual([]);
  });

  it("quarantines every late effect and clears active records on close", () => {
    const controller = createSessionController({ connectionId: "close" });
    const active = forwarded(controller.accept(request(1, "initialize", {})));
    controller.close();
    expect(controller.state).toBe("CLOSED");
    expect(controller.accept(request(2, "ping"))).toEqual([]);
    expect(controller.acceptSdkMessage({ jsonrpc: "2.0", id: active.internalId, result: {} })).toEqual([]);
    controller.onRouteSettled(active.requestToken!);
    controller.onSendAdmitted(active.requestToken);
    controller.close();
    expect(controller.state).toBe("CLOSED");
  });
});

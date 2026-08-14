import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

import {
  isJSONRPCRequest,
  LATEST_PROTOCOL_VERSION,
  ProtocolError,
  Server,
  SUPPORTED_PROTOCOL_VERSIONS,
  specTypeSchemas
} from "@modelcontextprotocol/server";

const repositoryRoot = resolve(fileURLToPath(new URL("..", import.meta.url)));
const expectedVersion = "2.0.0";
const protocolVersion = "2025-11-25";
const packageNames = ["@modelcontextprotocol/server", "@modelcontextprotocol/core"];

class ProbeTransport {
  sent = [];
  started = false;
  closed = false;
  supportedVersions;
  protocolVersion;
  onclose;
  onerror;
  onmessage;

  async start() {
    this.started = true;
  }

  async send(message) {
    this.sent.push(structuredClone(message));
  }

  async close() {
    this.closed = true;
    this.onclose?.();
  }

  setProtocolVersion = (version) => {
    this.protocolVersion = version;
  };

  setSupportedProtocolVersions = (versions) => {
    this.supportedVersions = [...versions];
  };

  receive(message) {
    assert.equal(typeof this.onmessage, "function", "Server.connect must install Transport.onmessage");
    this.onmessage(message);
  }
}

async function waitFor(predicate, label) {
  const deadline = Date.now() + 2_000;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error(`timed out waiting for ${label}`);
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 5));
  }
}

for (const packageName of packageNames) {
  const packageJson = JSON.parse(
    await readFile(resolve(repositoryRoot, "node_modules", packageName, "package.json"), "utf8")
  );
  assert.equal(packageJson.name, packageName);
  assert.equal(packageJson.version, expectedVersion);
  assert.equal(packageJson.license, "MIT");
  assert.ok(packageJson.exports?.["."], `${packageName} must retain its public root export`);
}

assert.equal(LATEST_PROTOCOL_VERSION, protocolVersion);
assert.ok(SUPPORTED_PROTOCOL_VERSIONS.includes(protocolVersion));
assert.equal(typeof Server, "function");
assert.equal(typeof ProtocolError, "function");
const publicSchemaNames = [
  "InitializeRequest",
  "ListToolsRequest",
  "CallToolRequest",
  "CancelledNotification"
];
for (const schemaName of publicSchemaNames) {
  assert.equal(
    typeof specTypeSchemas[schemaName]?.safeParse,
    "function",
    `public specTypeSchemas.${schemaName} hook drifted`
  );
}
assert.equal(specTypeSchemas.InitializeRequest.safeParse({
  jsonrpc: "2.0",
  id: 1,
  method: "initialize",
  params: {
    protocolVersion,
    capabilities: {},
    clientInfo: { name: "mcp-sdk-probe", version: "0.0.0" }
  }
}).success, true);
assert.equal(specTypeSchemas.ListToolsRequest.safeParse({
  jsonrpc: "2.0",
  id: 2,
  method: "tools/list"
}).success, true);
assert.equal(specTypeSchemas.CallToolRequest.safeParse({
  jsonrpc: "2.0",
  id: 3,
  method: "tools/call",
  params: { name: "archflow_state", arguments: {} }
}).success, true);
assert.equal(specTypeSchemas.CancelledNotification.safeParse({
  jsonrpc: "2.0",
  method: "notifications/cancelled",
  params: { requestId: 3, reason: "probe" }
}).success, true);
assert.equal(specTypeSchemas.CancelledNotification.safeParse({
  jsonrpc: "2.0",
  method: "notifications/cancelled",
  params: { requestId: 3, reason: { invalid: true } }
}).success, false);
for (const method of ["registerCapabilities", "setRequestHandler", "connect", "close", "projectCallToolResult"]) {
  assert.equal(typeof Server.prototype[method], "function", `public Server.${method} declaration/runtime hook drifted`);
}

const transport = new ProbeTransport();
const server = new Server(
  { name: "archflow-mcp", version: "0.0.0" },
  { supportedProtocolVersions: [protocolVersion] }
);
server.registerCapabilities({ tools: {} });
let initializedCount = 0;
server.oninitialized = () => {
  initializedCount += 1;
};
server.setRequestHandler("tools/list", async () => ({ tools: [] }));
server.setRequestHandler("tools/call", async () => {
  throw new ProtocolError(-32002, "TOOL_DISABLED", {
    code: "TOOL_DISABLED",
    owner: "protocol",
    retryable: false,
    next_action: "enable-tool",
    diagnostic: { tool: "archflow_state" }
  });
});
await server.connect(transport);
assert.equal(transport.started, true);
assert.deepEqual(transport.supportedVersions, [protocolVersion]);
for (const hook of ["onmessage", "onclose", "onerror", "setProtocolVersion", "setSupportedProtocolVersions"]) {
  assert.equal(typeof transport[hook], "function", `public Transport.${hook} hook drifted`);
}

transport.receive({
  jsonrpc: "2.0",
  id: 1,
  method: "initialize",
  params: {
    protocolVersion,
    capabilities: {},
    clientInfo: { name: 1, version: "invalid" }
  }
});
await waitFor(() => transport.sent.length === 1, "malformed initialize response");
assert.equal(transport.sent[0].id, 1);
assert.equal(
  transport.sent[0].error.code,
  -32603,
  "stable 2.0.0 must retain the malformed-initialize -32603 rejection the adapter now passes through"
);
assert.equal(server.getClientVersion(), undefined, "malformed initialize must not mutate client identity");
assert.equal(server.getNegotiatedProtocolVersion(), undefined, "malformed initialize must remain retryable");

transport.receive({
  jsonrpc: "2.0",
  id: 2,
  method: "initialize",
  params: {
    protocolVersion,
    capabilities: {},
    clientInfo: { name: "mcp-sdk-probe", version: "0.0.0" }
  }
});
await waitFor(() => transport.sent.length === 2, "valid initialize response after malformed retry");
assert.deepEqual(transport.sent[1], {
  jsonrpc: "2.0",
  id: 2,
  result: {
    protocolVersion,
    capabilities: { tools: {} },
    serverInfo: { name: "archflow-mcp", version: "0.0.0" }
  }
});
assert.deepEqual(server.getClientVersion(), { name: "mcp-sdk-probe", version: "0.0.0" });
assert.equal(server.getNegotiatedProtocolVersion(), protocolVersion);
assert.equal(transport.protocolVersion, protocolVersion);

transport.receive({ jsonrpc: "2.0", method: "notifications/initialized" });
await waitFor(() => initializedCount === 1, "Server.oninitialized callback");
transport.receive({
  jsonrpc: "2.0",
  id: 3,
  method: "tools/call",
  params: { name: "archflow_state", arguments: {} }
});
await waitFor(() => transport.sent.length === 3, "tools/call ProtocolError response");
assert.equal(
  transport.sent[2].error.code,
  -32602,
  "stable 2.0.0 must retain legacy TOOL_DISABLED rewriting for adapter restoration"
);
assert.equal(transport.sent[2].error.message, "TOOL_DISABLED");

assert.deepEqual(
  server.projectCallToolResult({ content: [], structuredContent: [1, 2] }, undefined),
  {
    content: [{ type: "text", text: "[1,2]" }],
    structuredContent: { result: [1, 2] }
  }
);

await server.close();
assert.equal(transport.closed, true);
assert.equal(
  typeof transport.onmessage,
  "function",
  "stable 2.0.0 must retain the observed Transport teardown behavior guarded by adapter quarantine"
);

// --- Behavioral pins: the SDK behaviors that replaced the retired session layer. ---
// Each pin covers one defense the adapter no longer re-implements; a pin failure means the
// installed SDK no longer has the behavior the adapter relies on.

async function behavioralServer(callHandler) {
  const probeTransport = new ProbeTransport();
  const probeServer = new Server(
    { name: "archflow-mcp", version: "0.0.0" },
    { supportedProtocolVersions: [protocolVersion] }
  );
  probeServer.registerCapabilities({ tools: {} });
  const errors = [];
  probeServer.onerror = (error) => errors.push(String(error?.message ?? error));
  probeServer.setRequestHandler("tools/list", async () => ({ tools: [] }));
  probeServer.setRequestHandler("tools/call", callHandler ?? (async () => ({
    content: [{ type: "text", text: "ok" }],
    structuredContent: { ok: true },
    isError: false
  })));
  await probeServer.connect(probeTransport);
  return { server: probeServer, transport: probeTransport, errors };
}

function initializeRequest(id, clientInfo = { name: "mcp-sdk-probe", version: "0.0.0" }) {
  return {
    jsonrpc: "2.0",
    id,
    method: "initialize",
    params: { protocolVersion, capabilities: {}, clientInfo }
  };
}

async function initialized(probe, id = "init") {
  probe.transport.receive(initializeRequest(id));
  await waitFor(() => probe.transport.sent.length >= 1, "initialize response");
  probe.transport.receive({ jsonrpc: "2.0", method: "notifications/initialized" });
}

// Pin 1 — malformed tools/call params: the SDK's own wire-schema validation answers
// -32602 with validator prose; the adapter no longer runs an eager spec-schema
// pre-pass or doctors non-object `arguments` into a surrogate.
{
  const probe = await behavioralServer();
  await initialized(probe);
  probe.transport.receive({
    jsonrpc: "2.0",
    id: 2,
    method: "tools/call",
    params: { name: "archflow_state", arguments: "bad" }
  });
  await waitFor(() => probe.transport.sent.length === 2, "non-object arguments rejection");
  assert.equal(probe.transport.sent[1].id, 2);
  assert.equal(probe.transport.sent[1].error.code, -32602);
  assert.ok(
    probe.transport.sent[1].error.message.startsWith("Invalid tools/call request:"),
    "non-object tools/call arguments must be rejected by the SDK wire schema"
  );
  probe.transport.receive({ jsonrpc: "2.0", id: 3, method: "tools/call" });
  await waitFor(() => probe.transport.sent.length === 3, "missing params rejection");
  assert.equal(probe.transport.sent[2].error.code, -32602);
  // Missing `arguments` still reaches the handler (the tool boundary owns that rejection),
  // and extra params keys pass the loose params schema; only extra TOP-LEVEL request
  // members fail the strict JSON-RPC envelope (pin 7). The per-method key allowlists
  // the session enforced are gone by design.
  probe.transport.receive({
    jsonrpc: "2.0",
    id: 4,
    method: "tools/call",
    params: { name: "archflow_state", arguments: {}, extraKey: true }
  });
  await waitFor(() => probe.transport.sent.length === 4, "loose params acceptance");
  assert.ok(Object.hasOwn(probe.transport.sent[3], "result"), "extra params keys must stay handler-reachable");
  // The egress result is the handler's return after codec revalidation: deep-equal,
  // with CallToolResult keys in schema-shape order. This is what replaced the
  // adapter's wire-level response arbitration.
  assert.deepEqual(probe.transport.sent[3].result, {
    content: [{ type: "text", text: "ok" }],
    structuredContent: { ok: true },
    isError: false
  });
  assert.deepEqual(Object.keys(probe.transport.sent[3].result), ["content", "structuredContent", "isError"]);
  await probe.server.close();
}

// Pin 2 — unknown method: the SDK answers -32601 itself.
{
  const probe = await behavioralServer();
  await initialized(probe);
  probe.transport.receive({ jsonrpc: "2.0", id: 9, method: "bogus/method" });
  await waitFor(() => probe.transport.sent.length === 2, "unknown method rejection");
  assert.deepEqual(probe.transport.sent[1], {
    jsonrpc: "2.0",
    id: 9,
    error: { code: -32601, message: "Method not found" }
  });
  await probe.server.close();
}

// Pin 3 — request before initialize: the SDK serves registered methods on the default
// legacy codec without a lifecycle gate. The adapter does not reject early requests;
// tools/call before connection capture answers -32603 from the adapter's own handler
// invariant (covered by adapter tests, not probeable here).
{
  const probe = await behavioralServer();
  probe.transport.receive({ jsonrpc: "2.0", id: 1, method: "tools/list" });
  await waitFor(() => probe.transport.sent.length === 1, "pre-initialize tools/list response");
  assert.deepEqual(probe.transport.sent[0].result, { tools: [] });
  await probe.server.close();
}

// Pin 4 — cancellation: a valid notifications/cancelled aborts ctx.mcpReq.signal for
// the in-flight request id and the SDK suppresses that request's response; a
// cancellation with invalid params is dropped to onerror without aborting. This is
// the abort mechanism that replaced the session's cancellation arbitration.
{
  let signal;
  let started = false;
  const probe = await behavioralServer(async (_request, ctx) => {
    signal = ctx.mcpReq.signal;
    started = true;
    await new Promise((_resolve, reject) => {
      ctx.mcpReq.signal.addEventListener("abort", () => reject(new Error("cancelled")), { once: true });
    });
  });
  await initialized(probe);
  probe.transport.receive({
    jsonrpc: "2.0",
    id: 5,
    method: "tools/call",
    params: { name: "archflow_state", arguments: {} }
  });
  await waitFor(() => started, "tools/call handler start");
  probe.transport.receive({
    jsonrpc: "2.0",
    method: "notifications/cancelled",
    params: { requestId: 5, reason: { invalid: true } }
  });
  await waitFor(() => probe.errors.length === 1, "malformed cancellation drop");
  assert.equal(signal.aborted, false, "an invalid cancellation must not abort");
  probe.transport.receive({
    jsonrpc: "2.0",
    method: "notifications/cancelled",
    params: { requestId: 5, reason: "stop" }
  });
  await waitFor(() => signal.aborted, "cancellation abort");
  await new Promise((resolvePromise) => setTimeout(resolvePromise, 20));
  assert.equal(probe.transport.sent.length, 1, "a cancelled request's response must be suppressed");
  await probe.server.close();
}

// Pin 5 — repeated initialize: the SDK accepts it, re-negotiates, and overwrites the
// captured client identity. This is exactly why the adapter mints INITIALIZATION_REPEATED
// (-32004) itself before the frame reaches the SDK.
{
  const probe = await behavioralServer();
  await initialized(probe);
  probe.transport.receive(initializeRequest(2, { name: "second-client", version: "9.9.9" }));
  await waitFor(() => probe.transport.sent.length === 2, "repeated initialize response");
  assert.ok(Object.hasOwn(probe.transport.sent[1], "result"), "the SDK must not reject a repeated initialize");
  assert.deepEqual(probe.server.getClientVersion(), { name: "second-client", version: "9.9.9" });
  await probe.server.close();
}

// Pin 6 — duplicate in-flight request IDs: the SDK dispatches both and answers both
// with the same external id. There is no duplicate-ID tombstone or ledger to preserve;
// a well-behaved local host never reuses in-flight ids (documented limitation).
{
  const tags = [];
  const probe = await behavioralServer(async (request) => {
    tags.push(request.params.arguments.tag);
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 10));
    return { content: [{ type: "text", text: "x" }], structuredContent: { tag: request.params.arguments.tag } };
  });
  await initialized(probe);
  probe.transport.receive({ jsonrpc: "2.0", id: 7, method: "tools/call", params: { name: "t", arguments: { tag: "first" } } });
  probe.transport.receive({ jsonrpc: "2.0", id: 7, method: "tools/call", params: { name: "t", arguments: { tag: "second" } } });
  await waitFor(() => probe.transport.sent.length === 3, "duplicate-id responses");
  assert.deepEqual(tags, ["first", "second"]);
  assert.equal(probe.transport.sent[1].id, 7);
  assert.equal(probe.transport.sent[2].id, 7);
  await probe.server.close();
}

// Pin 7 — exotic id types: string ids echo verbatim; -0 satisfies the integer id schema
// and serializes as 0 on egress; null ids, fractional ids, and extra top-level request
// members all fail the strict JSONRPCRequest schema and are dropped silently (onerror
// only, no wire response). The public isJSONRPCRequest predicate makes the same
// judgments, so the adapter's request-token minting can rely on it verbatim.
{
  const probe = await behavioralServer();
  await initialized(probe);
  probe.transport.receive({ jsonrpc: "2.0", id: "str", method: "tools/list" });
  await waitFor(() => probe.transport.sent.length === 2, "string-id response");
  assert.equal(probe.transport.sent[1].id, "str");
  probe.transport.receive({ jsonrpc: "2.0", id: -0, method: "tools/list" });
  await waitFor(() => probe.transport.sent.length === 3, "negative-zero-id response");
  assert.equal(JSON.stringify(probe.transport.sent[2].id), "0");
  const silent = [
    { jsonrpc: "2.0", id: null, method: "tools/list" },
    { jsonrpc: "2.0", id: 1.5, method: "tools/list" },
    { jsonrpc: "2.0", id: 99, method: "tools/list", extra: true }
  ];
  for (const message of silent) {
    probe.transport.receive(message);
    assert.equal(isJSONRPCRequest(message), false);
  }
  await waitFor(() => probe.errors.length === 3, "silent envelope drops");
  assert.equal(probe.transport.sent.length, 3, "unparseable envelopes must produce no wire response");
  assert.equal(isJSONRPCRequest({ jsonrpc: "2.0", id: -0, method: "tools/list" }), true);
  assert.equal(isJSONRPCRequest({ jsonrpc: "2.0", id: 1, method: "tools/list", params: { _meta: {} } }), true);
  await probe.server.close();
}

// Pin 8 — __proto__-keyed arguments: the SDK's record validation drops the key before
// the handler runs; the received object keeps a clean Object.prototype and no
// pollution occurs, so the frame is inert before the tool boundary's own
// assertPlainJson (which rejects dangerous keys) could even see it.
// WAIVER — accessor-bearing or otherwise non-plain frames cannot be probed through
// this surface: JSON.parse output (the only ingress the retained framer produces)
// contains data properties only, so there is no wire-reachable state to observe.
{
  let received;
  const probe = await behavioralServer(async (request) => {
    received = request.params.arguments;
    return { content: [{ type: "text", text: "x" }], structuredContent: { ok: true } };
  });
  await initialized(probe);
  probe.transport.receive(JSON.parse(
    '{"jsonrpc":"2.0","id":3,"method":"tools/call","params":{"name":"t","arguments":{"__proto__":{"polluted":true},"x":1}}}'
  ));
  await waitFor(() => probe.transport.sent.length === 2, "__proto__ arguments response");
  assert.equal(Object.prototype.polluted, undefined, "no prototype pollution may occur");
  assert.deepEqual(Object.getOwnPropertyNames(received), ["x"], "the __proto__ key must be stripped or inert");
  assert.equal(Object.getPrototypeOf(received), Object.prototype);
  await probe.server.close();
}

// WAIVER — the adapter's missing-outcome invariant (a tools/call response without a
// branded ToolBoundaryOutcome answers -32603) is adapter-side machinery, not an SDK
// behavior; it is pinned by the adapter unit tests instead of this probe.

console.log(
  `MCP SDK compatibility probe passed for stable server/core 2.0.0 public Server, Transport, projection, mutation, rewrite, and teardown behavior under ${process.version}.`
);

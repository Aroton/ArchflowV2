import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

import {
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

console.log(
  "MANUAL GATE REQUIRED: immediately before review, verify official MCP SDK stable status and legacy hand-built Server guidance from dated official sources; npm dist-tags alone are not sufficient."
);

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

function checkRegistryCurrency(packageName) {
  const result = spawnSync("npm", ["view", packageName, "dist-tags", "--json"], {
    cwd: repositoryRoot,
    encoding: "utf8",
    timeout: 30_000
  });
  assert.equal(result.status, 0, `could not read live npm dist-tags for ${packageName}: ${result.stderr}`);
  const tags = JSON.parse(result.stdout);
  assert.equal(tags.latest, expectedVersion, `${packageName} latest tag drifted; stop for design review`);
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
    clientInfo: { name: "phase-4-probe", version: "0.0.0" }
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
  "stable 2.0.0 must retain malformed initialize behavior required for adapter canonicalization"
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
    clientInfo: { name: "phase-4-probe", version: "0.0.0" }
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
assert.deepEqual(server.getClientVersion(), { name: "phase-4-probe", version: "0.0.0" });
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

for (const packageName of packageNames) checkRegistryCurrency(packageName);

console.log(
  `Phase 4 MCP compatibility probe passed for stable server/core 2.0.0 public Server, Transport, projection, mutation, rewrite, and teardown behavior under ${process.version}.`
);

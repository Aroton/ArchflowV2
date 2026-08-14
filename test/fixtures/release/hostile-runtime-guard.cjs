"use strict";

// This preload is intentionally dependency-free. It is copied beside the release
// payload and reports every guarded operation on the inherited fd-3 oracle.
const fs = require("node:fs");
const moduleBuiltin = require("node:module");
const path = require("node:path");

function report(type, surface, operation) {
  observe(type, surface, operation);
  throw new Error(`ARCHFLOW_HOSTILE_RUNTIME_GUARD:${surface}.${operation}`);
}

function observe(type, surface, operation) {
  const record = `${JSON.stringify({ operation, surface, type })}\n`;
  try {
    fs.writeSync(3, record);
  } catch {
    // A missing oracle must not turn a diagnostic guard into runtime authority.
  }
}

function replace(target, name, surface) {
  if (target === undefined || typeof target[name] !== "function") return;
  Object.defineProperty(target, name, {
    configurable: true,
    enumerable: Object.prototype.propertyIsEnumerable.call(target, name),
    value: function guardedNetworkOperation() {
      return report("network-attempt", surface, name);
    },
    writable: true,
  });
}

const guardedModules = [
  ["node:net", ["connect", "createConnection", "createServer"]],
  ["node:tls", ["connect", "createServer"]],
  ["node:dgram", ["createSocket"]],
  ["node:http", ["request", "get", "createServer"]],
  ["node:https", ["request", "get", "createServer"]],
  ["node:http2", ["connect", "createServer", "createSecureServer"]],
  ["node:dns", ["lookup", "resolve", "resolve4", "resolve6"]],
  ["node:dns/promises", ["lookup", "resolve", "resolve4", "resolve6"]],
];

for (const [specifier, names] of guardedModules) {
  const target = require(specifier);
  for (const name of names) replace(target, name, specifier);
}

for (const name of ["fetch", "WebSocket", "EventSource"]) {
  if (!(name in globalThis)) continue;
  Object.defineProperty(globalThis, name, {
    configurable: true,
    value: function guardedGlobalNetworkOperation() {
      return report("network-attempt", "globalThis", name);
    },
    writable: true,
  });
}

const repositoryCanary = path.resolve(__dirname, "../repository-canary/SECRET");
const guardedReadNames = ["open", "openSync", "readFile", "readFileSync", "stat", "statSync"];
for (const name of guardedReadNames) {
  const original = fs[name];
  if (typeof original !== "function") continue;
  fs[name] = function guardedCanaryRead(candidate, ...args) {
    if (typeof candidate === "string" && path.resolve(candidate) === repositoryCanary) {
      observe("canary-attempt", "repository-canary", name);
    }
    return Reflect.apply(original, this, [candidate, ...args]);
  };
}

const originalResolveFilename = moduleBuiltin._resolveFilename;
moduleBuiltin._resolveFilename = function guardedModuleCanary(request, ...args) {
  if (request !== "archflow-release-canary") return Reflect.apply(originalResolveFilename, this, [request, ...args]);
  try {
    const result = Reflect.apply(originalResolveFilename, this, [request, ...args]);
    observe("canary-attempt", "module-canary", "resolved");
    return result;
  } catch (error) {
    observe("canary-attempt", "module-canary", "unresolved");
    throw error;
  }
};

// Make CommonJS patches visible to any ESM named imports loaded afterwards.
moduleBuiltin.syncBuiltinESMExports();

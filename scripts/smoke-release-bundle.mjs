import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { cp, mkdtemp, mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const fixturesRoot = resolve(repositoryRoot, "test/fixtures/mcp/runtime");
const guardSource = resolve(repositoryRoot, "test/fixtures/release/hostile-runtime-guard.cjs");
const timeoutMs = 10_000;

function usage(message) {
  const error = new Error(message);
  error.exitCode = 2;
  return error;
}

function parseArguments(argv) {
  if (argv.length !== 2 || argv[0] !== "--payload" || argv[1] === "") {
    throw usage("usage: smoke-release-bundle.mjs --payload <dir>");
  }
  return resolve(argv[1]);
}

function canonicalJson(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value !== null && typeof value === "object") {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

async function runChild({ argv, cwd, env, input }) {
  const child = spawn(process.execPath, argv, {
    cwd,
    env,
    stdio: ["pipe", "pipe", "pipe", "pipe"],
  });
  const stdout = [];
  const stderr = [];
  const oracle = [];
  child.stdout.on("data", (chunk) => stdout.push(Buffer.from(chunk)));
  child.stderr.on("data", (chunk) => stderr.push(Buffer.from(chunk)));
  child.stdio[3].on("data", (chunk) => oracle.push(Buffer.from(chunk)));
  child.stdin.end(input);
  let timer;
  try {
    const exit = await Promise.race([
      new Promise((resolveExit, rejectExit) => {
        child.once("error", rejectExit);
        child.once("exit", (code, signal) => resolveExit({ code, signal }));
      }),
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error("release smoke child timed out")), timeoutMs);
      }),
    ]);
    return {
      ...exit,
      oracle: Buffer.concat(oracle),
      stderr: Buffer.concat(stderr),
      stdout: Buffer.concat(stdout),
    };
  } finally {
    clearTimeout(timer);
    if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
  }
}

function minimalEnvironment(ambientRoot) {
  return {
    HOME: resolve(ambientRoot, "unusable-home"),
    LANG: "C.UTF-8",
    LC_ALL: "C.UTF-8",
    NPM_CONFIG_CACHE: resolve(ambientRoot, "unusable-npm-cache"),
    PATH: dirname(process.execPath),
    TMPDIR: resolve(ambientRoot, "empty-tmp"),
    XDG_CACHE_HOME: resolve(ambientRoot, "unusable-xdg-cache"),
    XDG_CONFIG_HOME: resolve(ambientRoot, "unusable-xdg-config"),
    XDG_DATA_HOME: resolve(ambientRoot, "unusable-xdg-data"),
  };
}

async function assertGuardNegative({ cwd, env, guard }) {
  const dns = await runChild({
    argv: ["--require", guard, "--eval", "require('node:dns').lookup('archflow.invalid',()=>{})"],
    cwd,
    env,
    input: Buffer.alloc(0),
  });
  assert.notEqual(dns.code, 0, "DNS negative control must be stopped by the guard");
  assert.match(dns.oracle.toString("utf8"), /"surface":"node:dns"/u);

  const websocket = await runChild({
    argv: ["--require", guard, "--eval", "new WebSocket('ws://archflow.invalid')"],
    cwd,
    env,
    input: Buffer.alloc(0),
  });
  assert.notEqual(websocket.code, 0, "WebSocket negative control must be stopped by the guard");
  assert.match(websocket.oracle.toString("utf8"), /"operation":"WebSocket"/u);

  const repositoryCanary = await runChild({
    argv: ["--require", guard, "--eval", "require('node:fs').readFileSync('../repository-canary/SECRET')"],
    cwd,
    env,
    input: Buffer.alloc(0),
  });
  assert.equal(repositoryCanary.code, 0, "repository canary observation control must complete normally");
  assert.match(repositoryCanary.oracle.toString("utf8"), /"type":"canary-attempt"/u);
  assert.equal(repositoryCanary.stdout.toString("utf8"), "", "repository canary control must not print its contents");
}

function jsonLine(value) {
  return `${JSON.stringify(value)}\n`;
}

function assertCleanExit(result, label) {
  assert.deepEqual(result.stderr, Buffer.alloc(0), `${label} emitted diagnostics`);
  assert.deepEqual(result.oracle, Buffer.alloc(0), `${label} wrote to the guard oracle`);
  assert.deepEqual({ code: result.code, signal: result.signal }, { code: 0, signal: null }, `${label} did not exit cleanly`);
}

function assertCallTranscript(bytes, initialize, calls) {
  const lines = bytes.toString("utf8").trimEnd().split("\n").map((line) => JSON.parse(line));
  assert.equal(lines.length, 7, "complete initialize/calls sequence must emit seven frames");
  assert.deepEqual(lines[0], initialize.malformed_response);
  assert.deepEqual(lines[1], initialize.response);
  assert.deepEqual(lines[2]?.jsonrpc, "2.0");
  assert.deepEqual(lines[2]?.id, calls.list.id);
  assert.deepEqual(lines[2]?.result?.tools?.map((tool) => tool.name), [
    "archflow_state",
    "archflow_counter_review",
    "archflow_adjudicate",
    "archflow_gate",
    "archflow_waiver",
  ]);
  assert.deepEqual(lines[3], {
    jsonrpc: "2.0",
    id: calls.unknown.id,
    error: {
      code: -32001,
      message: "TOOL_NOT_FOUND",
      data: {
        schema_version: "1",
        code: "TOOL_NOT_FOUND",
        owner: "protocol",
        retryable: false,
        diagnostic: {
          template_id: "TOOL_NOT_FOUND",
          parameters: { tool_name_digest: createHash("sha256").update(calls.unknown.params.name).digest("hex") },
        },
        next_action: "call-advertised-tool",
      },
    },
  });
  for (const [index, request] of [[4, calls.missing_arguments], [5, calls.non_object_arguments]]) {
    const frame = lines[index];
    assert.equal(frame.id, request.id);
    assert.equal(frame.result?.isError, true);
    assert.equal(frame.result?.structuredContent?.ok, false);
    assert.equal(frame.result?.structuredContent?.error?.code, "CONTRACT_INVALID");
    assert.equal(frame.result?.structuredContent?.error?.diagnostic?.parameters?.issue_code, "input-not-object");
    assert.equal(frame.result?.content?.[0]?.text, JSON.stringify(frame.result.structuredContent));
  }
  assert.deepEqual(lines[6], {
    jsonrpc: "2.0",
    id: calls.valid_disabled.id,
    error: {
      code: -32002,
      message: "TOOL_DISABLED",
      data: {
        schema_version: "1",
        code: "TOOL_DISABLED",
        owner: "protocol",
        retryable: false,
        diagnostic: {
          template_id: "TOOL_DISABLED",
          parameters: { tool: "archflow_state", lifecycle_state: "inert-no-handler" },
        },
        next_action: "wait-for-tool-enable",
      },
    },
  });
}

async function exerciseProtocolFixtures({ copiedBundle, copiedPayload, env, guard, initialize, calls, adversarial }) {
  const callInput = Buffer.from([
    jsonLine(initialize.malformed_request),
    jsonLine(initialize.request),
    jsonLine(initialize.initialized),
    ...Object.values(calls).map(jsonLine),
  ].join(""));
  const exact = await runChild({ argv: [copiedBundle], cwd: copiedPayload, env, input: callInput });
  assertCleanExit(exact, "exact copied payload call sequence");
  assertCallTranscript(exact.stdout, initialize, calls);

  const guarded = await runChild({
    argv: ["--require", guard, copiedBundle],
    cwd: copiedPayload,
    env,
    input: callInput,
  });
  assertCleanExit(guarded, "guarded copied payload call sequence");
  assert.deepEqual(guarded.stdout, exact.stdout, "guarded complete call transcript is not byte-exact");

  const expectedParseError = Buffer.from(adversarial.parse_error_frame_utf8, "base64");
  let exactTranscriptBytes = exact.stdout.length;
  let guardedTranscriptBytes = guarded.stdout.length;
  for (const [fixture, expectedCode, expectedDiagnostic] of [
    ["malformed_json_utf8", 0, ""],
    ["partial_json_utf8", 0, ""],
    ["invalid_utf8", 1, "ARCHFLOW_MCP_TRANSPORT_ERROR\n"],
  ]) {
    const input = Buffer.from(adversarial[fixture], "base64");
    const unguardedResult = await runChild({ argv: [copiedBundle], cwd: copiedPayload, env, input });
    const guardedResult = await runChild({ argv: ["--require", guard, copiedBundle], cwd: copiedPayload, env, input });
    for (const [mode, result] of [["exact", unguardedResult], ["guarded", guardedResult]]) {
      assert.deepEqual(result.stdout, expectedParseError, `${mode} ${fixture} stdout drifted`);
      assert.deepEqual(result.stderr, Buffer.from(expectedDiagnostic), `${mode} ${fixture} diagnostics drifted`);
      assert.deepEqual(result.oracle, Buffer.alloc(0), `${mode} ${fixture} wrote to fd 3`);
      assert.deepEqual({ code: result.code, signal: result.signal }, { code: expectedCode, signal: null });
    }
    exactTranscriptBytes += unguardedResult.stdout.length;
    guardedTranscriptBytes += guardedResult.stdout.length;
    assert.deepEqual(guardedResult.stdout, unguardedResult.stdout, `${fixture} modes were not byte-exact`);
  }
  assert.equal(guardedTranscriptBytes, exactTranscriptBytes, "protocol transcript byte counts differ between modes");
  return { guarded, guardedTranscriptBytes };
}

async function proveModuleCanaryIsolation({ copiedPayload, ambientRoot, env, guard }) {
  const canaryModuleRoot = resolve(ambientRoot, "node_modules");
  const canaryEntry = resolve(canaryModuleRoot, "archflow-release-canary/index.js");
  const control = await runChild({
    argv: ["--eval", "process.stdout.write(require.resolve('archflow-release-canary')+'\\n'+require('archflow-release-canary'))"],
    cwd: copiedPayload,
    env: { ...env, NODE_PATH: canaryModuleRoot },
    input: Buffer.alloc(0),
  });
  assert.deepEqual({ code: control.code, signal: control.signal }, { code: 0, signal: null });
  const [resolvedCanary, canaryContents] = control.stdout.toString("utf8").split("\n");
  assert.equal(resolve(resolvedCanary), canaryEntry, "module canary must resolve on the control lookup path");
  assert.equal(canaryContents, "ARCHFLOW_MODULE_CANARY", "control child must read the resolved module canary");
  assert.deepEqual(control.oracle, Buffer.alloc(0));

  assert.equal(Object.hasOwn(env, "NODE_PATH"), false, "hostile environment must scrub NODE_PATH");
  const hostile = await runChild({
    argv: ["--require", guard, "--eval", "require('archflow-release-canary')"],
    cwd: copiedPayload,
    env,
    input: Buffer.alloc(0),
  });
  assert.notEqual(hostile.code, 0, "scrubbed hostile launch unexpectedly resolved the module canary");
  assert.match(hostile.stderr.toString("utf8"), /Cannot find module 'archflow-release-canary'/u);
  assert.match(hostile.oracle.toString("utf8"), /"operation":"unresolved","surface":"module-canary"/u);
  return "resolved-via-NODE_PATH";
}

export async function smokeReleasePayload(payloadRoot) {
  const bundle = resolve(payloadRoot, "archflow-mcp.mjs");
  assert.equal((await stat(bundle)).isFile(), true, "payload must contain archflow-mcp.mjs");
  const temporaryRoot = await mkdtemp(resolve(tmpdir(), "archflow-release-hostile-"));
  try {
    const copiedPayload = resolve(temporaryRoot, "payload");
    const ambientRoot = resolve(temporaryRoot, "ambient");
    const guard = resolve(copiedPayload, "hostile-runtime-guard.cjs");
    await cp(payloadRoot, copiedPayload, { recursive: true, verbatimSymlinks: true });
    await cp(guardSource, guard);
    await mkdir(resolve(ambientRoot, "empty-tmp"), { recursive: true });
    await mkdir(resolve(temporaryRoot, "repository-canary"), { recursive: true });
    await mkdir(resolve(ambientRoot, "node_modules/archflow-release-canary"), { recursive: true });
    await writeFile(resolve(temporaryRoot, "repository-canary/SECRET"), "ARCHFLOW_REPOSITORY_CANARY\n");
    await writeFile(resolve(ambientRoot, "node_modules/archflow-release-canary/index.js"), "module.exports = 'ARCHFLOW_MODULE_CANARY'\n");

    const initialize = JSON.parse(await readFile(resolve(fixturesRoot, "initialize.json"), "utf8"));
    const calls = JSON.parse(await readFile(resolve(fixturesRoot, "calls.json"), "utf8"));
    const adversarial = JSON.parse(await readFile(resolve(fixturesRoot, "adversarial-bytes.json"), "utf8"));
    const env = minimalEnvironment(ambientRoot);
    const copiedBundle = resolve(copiedPayload, "archflow-mcp.mjs");
    const { guarded, guardedTranscriptBytes } = await exerciseProtocolFixtures({
      copiedBundle,
      copiedPayload,
      env,
      guard,
      initialize,
      calls,
      adversarial,
    });
    for (const canary of ["ARCHFLOW_REPOSITORY_CANARY", "ARCHFLOW_MODULE_CANARY_READ"]) {
      assert.equal(Buffer.concat([guarded.stdout, guarded.stderr]).includes(Buffer.from(canary)), false);
    }

    const moduleCanary = await proveModuleCanaryIsolation({ copiedPayload, ambientRoot, env, guard });
    await assertGuardNegative({ cwd: copiedPayload, env, guard });
    return {
      bundle: "archflow-mcp.mjs",
      fixture_sequences: ["initialize-and-calls", "malformed-json", "partial-json", "invalid-utf8"],
      guarded_transcript_bytes: guardedTranscriptBytes,
      modes: ["exact-copy", "guarded-copy"],
      module_canary_control: moduleCanary,
      network_oracle_bytes: guarded.oracle.length,
      payload_root: payloadRoot,
    };
  } finally {
    await rm(temporaryRoot, { force: true, recursive: true });
  }
}

async function main() {
  const payloadRoot = parseArguments(process.argv.slice(2));
  const result = await smokeReleasePayload(payloadRoot);
  process.stdout.write(`${canonicalJson(result)}\n`);
}

if (process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = Number.isInteger(error?.exitCode) ? error.exitCode : 1;
  });
}

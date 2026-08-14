import { readFile } from "node:fs/promises";

import { afterEach, describe, expect, it, vi } from "vitest";

import { connectionContextFactory, createInvocationContext } from "../../src/contracts/contexts.js";
import { createProjectError, createProtocolError } from "../../src/contracts/errors.js";
import type { InvocationContext } from "../../src/contracts/contexts.js";
import {
  assertAuthenticToolBoundary,
  assertAuthenticToolBoundaryOutcome,
  authenticateProtocolError,
  createToolBoundary,
  type ToolBoundaryOutcome
} from "../../src/mcp/server.js";

afterEach(() => {
  vi.restoreAllMocks();
});

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
const counterReviewInput = {
  schema_version: "1",
  task_id: "task-1",
  intent_id: "intent-1",
  expected_revision: 2,
  input_fingerprint: digest,
  artifact_path: `${"é".repeat(600)}.md`,
  rubric: { schema_version: "1", criteria: [{ id: "paths", text: "Paths are correct", blocking: true }] }
} as const;

interface ClassificationFixtures {
  readonly not_object: readonly unknown[];
  readonly missing_schema_version: unknown;
  readonly invalid_schema_versions: readonly unknown[];
  readonly unsupported_schema_version: string;
  readonly version_one_but_invalid: unknown;
}

async function loadClassificationFixtures(): Promise<ClassificationFixtures> {
  return JSON.parse(await readFile(new URL("../fixtures/mcp/boundary/input-classification.json", import.meta.url), "utf8")) as ClassificationFixtures;
}

function context(invocationId = "boundary-correlation-1"): InvocationContext {
  const connection = connectionContextFactory.captureStartup({
    connection_id: `connection-${invocationId}`,
    startup_repository_candidate: { working_directory: "/repo" }
  }).initialize({
    client: { name: "test-client", version: "1" },
    host: "codex",
    protocol_version: "2025-11-25"
  });
  return createInvocationContext(connection, {
    invocation_id: invocationId,
    transport_metadata: { request_id: `request-${invocationId}`, operation: "tools/call" }
  }, new AbortController().signal);
}

function expectProjectFailure(
  outcome: ToolBoundaryOutcome,
  tool: "archflow_state",
  code: string,
  parameters: Readonly<Record<string, unknown>>
): void {
  expect(outcome.kind).toBe("project-result");
  if (outcome.kind !== "project-result") throw new Error("expected project result");
  expect(outcome.tool).toBe(tool);
  expect(outcome.result.ok).toBe(false);
  if (outcome.result.ok) throw new Error("expected project failure");
  expect(outcome.result.error.code).toBe(code);
  expect(outcome.result.error.diagnostic.parameters).toEqual(parameters);
  expect(Object.isFrozen(outcome)).toBe(true);
  expect(Object.isFrozen(outcome.result)).toBe(true);
  expect(Object.isFrozen(outcome.result.error)).toBe(true);
  expect(Object.isFrozen(outcome.result.error.diagnostic)).toBe(true);
  expect(Object.isFrozen(outcome.result.error.diagnostic.parameters)).toBe(true);
  expect(() => assertAuthenticToolBoundaryOutcome(outcome)).not.toThrow();
}

describe("SDK-free MCP tool boundary", () => {
  it("copies and authenticates protocol errors without mutating the source", () => {
    const source = createProtocolError("TOOL_DISABLED", {
      tool: "archflow_state",
      lifecycle_state: "inert-no-handler"
    });
    const authenticated = authenticateProtocolError(source);
    expect(authenticated.value).toEqual(source);
    expect(authenticated.value).not.toBe(source);
    expect(Object.isFrozen(authenticated)).toBe(true);
    expect(Object.isFrozen(authenticated.value)).toBe(true);
    expect(Object.isFrozen(authenticated.value.diagnostic.parameters)).toBe(true);
    expect(() => authenticateProtocolError({ ...authenticated })).toThrow();
    expect(() => authenticateProtocolError({ ...source, retryable: true })).toThrow();
  });

  it("authenticates and freezes boundaries while copied registries ignore later mutation", async () => {
    const handlers = {
      archflow_state: () => stateSuccess
    };
    const boundary = createToolBoundary(handlers);
    handlers.archflow_state = () => { throw new Error("replacement must not run"); };

    expect(Object.isFrozen(boundary)).toBe(true);
    expect(Object.isFrozen(boundary.invoke)).toBe(true);
    expect(() => assertAuthenticToolBoundary(boundary)).not.toThrow();
    expect(() => assertAuthenticToolBoundary({ ...boundary })).toThrow(/authentic tool boundary/);
    expect(() => assertAuthenticToolBoundary({ invoke: boundary.invoke })).toThrow(/authentic tool boundary/);
    const outcome = await boundary.invoke("archflow_state", stateInput, context());
    expect(outcome.kind).toBe("project-result");
    if (outcome.kind === "project-result") expect(outcome.result.ok).toBe(true);
  });

  it("rejects invalid registry surfaces without reading accessors", () => {
    let getterCalls = 0;
    const accessor = Object.defineProperty({}, "archflow_state", {
      enumerable: true,
      get() { getterCalls += 1; return () => stateSuccess; }
    });
    expect(() => createToolBoundary(accessor as never)).toThrow(/data properties/);
    expect(getterCalls).toBe(0);
    expect(() => createToolBoundary({ unknown_tool: () => stateSuccess } as never)).toThrow(/unknown tool/);
    expect(() => createToolBoundary({ archflow_state: 1 } as never)).toThrow(/functions/);
  });

  it("requires a string name and an authentic invocation context", async () => {
    const boundary = createToolBoundary({});
    const authentic = context("boundary-auth-1");
    await expect(boundary.invoke(1 as never, {}, authentic)).rejects.toThrow(/string tool name/);
    await expect(boundary.invoke("unknown", {}, { ...authentic } as never)).rejects.toThrow(/authentic invocation/);
    await expect(boundary.invoke("unknown", {}, {
      invocation_id: authentic.invocation_id,
      connection: authentic.connection,
      signal: authentic.signal,
      transport_metadata: authentic.transport_metadata
    } as never)).rejects.toThrow(/authentic invocation/);
  });

  it("returns exact authenticated protocol outcomes for unknown and disabled tools", async () => {
    const boundary = createToolBoundary({});
    const invocation = context("boundary-protocol-1");
    const unknown = await boundary.invoke("Ü\u0000tool", { secret: "arguments are irrelevant" }, invocation);
    expect(unknown).toMatchObject({
      kind: "protocol-error",
      error: {
        value: {
          code: "TOOL_NOT_FOUND",
          diagnostic: {
            parameters: { tool_name_digest: "cc0ce9406e03db1f4ade8582fb75373ed26e9cf7bc19cb496b548fc3aab0cd21" }
          }
        }
      }
    });
    expect(JSON.stringify(unknown)).not.toContain("Ü");
    expect(Object.isFrozen(unknown)).toBe(true);
    if (unknown.kind !== "protocol-error") throw new Error("expected protocol outcome");
    expect(Object.isFrozen(unknown.error)).toBe(true);
    expect(Object.isFrozen(unknown.error.value.diagnostic.parameters)).toBe(true);
    expect(() => assertAuthenticToolBoundaryOutcome(unknown)).not.toThrow();
    const unknownWithMissingArgs = await boundary.invoke("Ü\u0000tool", undefined, invocation);
    expect(unknownWithMissingArgs).toMatchObject({
      kind: "protocol-error",
      error: { value: { code: "TOOL_NOT_FOUND" } }
    });

    const disabled = await boundary.invoke("archflow_state", stateInput, invocation);
    expect(disabled).toMatchObject({
      kind: "protocol-error",
      error: {
        value: {
          code: "TOOL_DISABLED",
          diagnostic: { parameters: { tool: "archflow_state", lifecycle_state: "inert-no-handler" } }
        }
      }
    });
    expect(() => assertAuthenticToolBoundaryOutcome({ ...disabled })).toThrow(/authentic tool boundary outcome/);
    expect(() => assertAuthenticToolBoundaryOutcome(structuredClone(disabled) as never)).toThrow(/authentic tool boundary outcome/);
  });

  it("classifies missing, non-object, and portable-shaped runtime-invalid known input before inert availability", async () => {
    const boundary = createToolBoundary({});
    const invocation = context("boundary-inert-precedence-1");

    for (const candidate of [undefined, 42] as const) {
      expectProjectFailure(await boundary.invoke("archflow_state", candidate, invocation), "archflow_state", "CONTRACT_INVALID", {
        tool: "archflow_state", issue_code: "input-not-object"
      });
    }
    const semantic = await boundary.invoke("archflow_counter_review", counterReviewInput, invocation);
    expect(semantic.kind).toBe("project-result");
    if (semantic.kind !== "project-result" || semantic.result.ok) throw new Error("expected project failure");
    expect(semantic.result.error.code).toBe("CONTRACT_INVALID");
    expect(semantic.result.error.diagnostic.parameters).toMatchObject({
      tool: "archflow_counter_review", issue_code: "input-invalid"
    });

    const valid = await boundary.invoke("archflow_state", stateInput, invocation);
    expect(valid).toMatchObject({
      kind: "protocol-error",
      error: { value: { code: "TOOL_DISABLED" } }
    });
  });

  it("classifies every known-tool argument failure before calling the handler", async () => {
    const fixtures = await loadClassificationFixtures();
    let calls = 0;
    const boundary = createToolBoundary({ archflow_state: () => { calls += 1; return stateSuccess; } });
    const invocation = context("boundary-input-1");

    expectProjectFailure(await boundary.invoke("archflow_state", undefined, invocation), "archflow_state", "CONTRACT_INVALID", {
      tool: "archflow_state", issue_code: "input-not-object"
    });

    for (const candidate of fixtures.not_object) {
      expectProjectFailure(await boundary.invoke("archflow_state", candidate, invocation), "archflow_state", "CONTRACT_INVALID", {
        tool: "archflow_state", issue_code: "input-not-object"
      });
    }
    const nonPlain: readonly unknown[] = [
      new Map(),
      Object.create({ schema_version: "1" }),
      { schema_version: "1", nested: undefined },
      Object.defineProperty({}, "schema_version", { enumerable: true, get: () => "1" }),
      (() => { const value: Record<string, unknown> = { schema_version: "1" }; value.self = value; return value; })()
    ];
    for (const candidate of nonPlain) {
      expectProjectFailure(await boundary.invoke("archflow_state", candidate, invocation), "archflow_state", "CONTRACT_INVALID", {
        tool: "archflow_state", issue_code: "input-not-object"
      });
    }
    expectProjectFailure(await boundary.invoke("archflow_state", fixtures.missing_schema_version, invocation), "archflow_state", "CONTRACT_INVALID", {
      tool: "archflow_state", issue_code: "schema-version-missing"
    });
    for (const schema_version of fixtures.invalid_schema_versions) {
      expectProjectFailure(await boundary.invoke("archflow_state", { schema_version }, invocation), "archflow_state", "CONTRACT_INVALID", {
        tool: "archflow_state", issue_code: "schema-version-invalid"
      });
    }
    expectProjectFailure(await boundary.invoke("archflow_state", { schema_version: fixtures.unsupported_schema_version }, invocation), "archflow_state", "CONTRACT_VERSION_UNSUPPORTED", {
      schema_version: fixtures.unsupported_schema_version, supported_version: "1"
    });
    const invalid = await boundary.invoke("archflow_state", fixtures.version_one_but_invalid, invocation);
    if (invalid.kind !== "project-result" || invalid.result.ok) throw new Error("expected project failure");
    expect(invalid.result.error.code).toBe("CONTRACT_INVALID");
    expect(invalid.result.error.diagnostic.parameters).toMatchObject({ tool: "archflow_state", issue_code: "input-invalid" });

    // A rejected input names its offending fields: the diagnostic that only said "input-invalid"
    // was observed leaving a caller retrying byte-cosmetic variants of the same wrong shape.
    const stringTyped = await boundary.invoke(
      "archflow_state",
      { ...stateInput, expected_revision: "0", artifact: "{\"artifact_kind\":\"task-initialization\"}" },
      invocation
    );
    if (stringTyped.kind !== "project-result" || stringTyped.result.ok) throw new Error("expected project failure");
    expect(stringTyped.result.error.code).toBe("CONTRACT_INVALID");
    const issues = (stringTyped.result.error.diagnostic.parameters as { issues?: readonly string[] }).issues;
    expect(issues).toBeDefined();
    expect(issues!.length).toBeGreaterThan(0);
    expect(issues!.length).toBeLessThanOrEqual(5);
    expect(issues!.join("; ")).toMatch(/expected_revision/u);

    expect(calls).toBe(0);
  });

  it("calls a valid handler once and deeply freezes an authenticated correlated success", async () => {
    let calls = 0;
    const boundary = createToolBoundary({
      archflow_state: (call, invocation) => {
        calls += 1;
        expect(call.name).toBe("archflow_state");
        expect(call.input.status).toBe("succeeded");
        expect(invocation.invocation_id).toBe("boundary-success-1");
        return stateSuccess;
      }
    });
    const outcome = await boundary.invoke("archflow_state", stateInput, context("boundary-success-1"));
    expect(calls).toBe(1);
    expect(outcome).toMatchObject({ kind: "project-result", tool: "archflow_state", result: stateSuccess });
    expect(Object.isFrozen(outcome)).toBe(true);
    if (outcome.kind !== "project-result" || !outcome.result.ok) throw new Error("expected success");
    expect(Object.isFrozen(outcome.result)).toBe(true);
    expect(Object.isFrozen(outcome.result.value)).toBe(true);
    expect(() => assertAuthenticToolBoundaryOutcome(outcome)).not.toThrow();
    expect(() => assertAuthenticToolBoundaryOutcome({ ...outcome })).toThrow(/authentic tool boundary outcome/);
    expect(() => assertAuthenticToolBoundaryOutcome({ kind: "project-result", tool: "archflow_state", result: outcome.result })).toThrow(/authentic tool boundary outcome/);
  });

  it("accepts a closed tool-neutral failure returned on a known path", async () => {
    const returned = {
      schema_version: "1",
      ok: false,
      error: createProjectError("WORKFLOW_INVALID", { issue_code: "workflow-broken" })
    } as const;
    const boundary = createToolBoundary({ archflow_state: () => returned });
    const outcome = await boundary.invoke("archflow_state", stateInput, context("boundary-failure-1"));
    expectProjectFailure(outcome, "archflow_state", "WORKFLOW_INVALID", { issue_code: "workflow-broken" });
    if (outcome.kind === "project-result" && !outcome.result.ok) {
      expect(outcome.result).not.toBe(returned);
      expect(outcome.result.error).not.toBe(returned.error);
    }
  });

  it("accepts matching and neutral failure bindings but contains cross-tool substitutions", async () => {
    const cases = [
      {
        label: "contract-neutral",
        returned: { schema_version: "1", ok: false, error: createProjectError("CONTRACT_INVALID", { issue_code: "input-invalid" }) },
        expectedCode: "CONTRACT_INVALID",
        expectedParameters: { issue_code: "input-invalid" }
      },
      {
        label: "contract-matching",
        returned: { schema_version: "1", ok: false, error: createProjectError("CONTRACT_INVALID", { tool: "archflow_state", issue_code: "input-invalid" }) },
        expectedCode: "CONTRACT_INVALID",
        expectedParameters: { tool: "archflow_state", issue_code: "input-invalid" }
      },
      {
        label: "result-matching",
        returned: { schema_version: "1", ok: false, error: createProjectError("RESULT_INVALID", { tool: "archflow_state", result_id: "result-1" }) },
        expectedCode: "RESULT_INVALID",
        expectedParameters: { tool: "archflow_state", result_id: "result-1" }
      }
    ] as const;
    for (const item of cases) {
      let calls = 0;
      const boundary = createToolBoundary({ archflow_state: () => { calls += 1; return item.returned; } });
      const outcome = await boundary.invoke("archflow_state", stateInput, context(`boundary-binding-${item.label}`));
      expect(calls).toBe(1);
      expectProjectFailure(outcome, "archflow_state", item.expectedCode, item.expectedParameters);
    }

    vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    for (const item of [
      { label: "contract", returned: { schema_version: "1", ok: false, error: createProjectError("CONTRACT_INVALID", { tool: "archflow_gate", issue_code: "input-invalid" }) } },
      { label: "result", returned: { schema_version: "1", ok: false, error: createProjectError("RESULT_INVALID", { tool: "archflow_gate", result_id: "result-1" }) } },
      {
        label: "result-required-tool-missing",
        returned: (() => {
          const error = createProjectError("RESULT_INVALID", { tool: "archflow_state", result_id: "result-1" });
          return { schema_version: "1", ok: false, error: { ...error, diagnostic: { ...error.diagnostic, parameters: { result_id: "result-1" } } } };
        })()
      }
    ] as const) {
      let calls = 0;
      const boundary = createToolBoundary({ archflow_state: () => { calls += 1; return item.returned; } });
      const invocationId = `boundary-cross-tool-${item.label}`;
      const outcome = await boundary.invoke("archflow_state", stateInput, context(invocationId));
      expect(calls).toBe(1);
      expectProjectFailure(outcome, "archflow_state", "INTERNAL_ERROR", { correlation_id: invocationId });
      expect(JSON.stringify(outcome)).not.toContain("archflow_gate");
    }
  });

  it("reduces malformed, substituted, thrown, and rejected handler results to correlation-only internal errors", async () => {
    const write = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    const cases = [
      { label: "malformed", handler: () => ({ schema_version: "1", ok: true, value: { secret: "handler prose" } }) },
      { label: "cross-tool", handler: () => ({ schema_version: "1", ok: true, value: { path: "phases/3/review.md", verdict: "pass", blocking_count: 0, revision: 3 } }) },
      { label: "throw", handler: () => { throw new Error("raw synchronous secret"); } },
      { label: "reject", handler: async () => { throw new Error("raw asynchronous secret"); } }
    ] as const;
    for (const item of cases) {
      let calls = 0;
      const boundary = createToolBoundary({ archflow_state: () => { calls += 1; return item.handler(); } });
      const invocationId = `boundary-internal-${item.label}`;
      const outcome = await boundary.invoke("archflow_state", stateInput, context(invocationId));
      expect(calls).toBe(1);
      expectProjectFailure(outcome, "archflow_state", "INTERNAL_ERROR", { correlation_id: invocationId });
      const serialized = JSON.stringify(outcome);
      expect(serialized).not.toContain("secret");
      expect(serialized).not.toContain("handler prose");
      expect(
        write.mock.calls.map(([chunk]) => String(chunk)).join(""),
        item.label,
      ).toContain(`correlation_id=${invocationId}`);
    }
    const logged = write.mock.calls.map(([chunk]) => String(chunk)).join("");
    expect(logged).toContain("raw synchronous secret");
    expect(logged).toContain("raw asynchronous secret");
  });
});

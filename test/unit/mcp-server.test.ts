import { afterEach, describe, expect, it, vi } from "vitest";

import { connectionContextFactory, createInvocationContext } from "../../src/contracts/contexts.js";
import type { InvocationContext } from "../../src/contracts/contexts.js";
import { createProtocolError } from "../../src/contracts/errors.js";
import { unavailableImplementationRecommendation } from "../../src/contracts/semantic-workflow.js";
import { createToolBoundary, assertAuthenticToolBoundary, assertAuthenticToolBoundaryOutcome, authenticateProtocolError, type ToolBoundaryOutcome } from "../../src/mcp/server.js";
import { TOOL_NAMES } from "../../src/contracts/tool-names.js";

afterEach(() => {
  vi.restoreAllMocks();
});

const semanticView = {
  schema_version: "1",
  task_id: "task-1",
  condition: "ready",
  headline: "Ready",
  detail: "Inspect the current workflow.",
  resources: [],
  next_action: { kind: "inspect", instruction: "Inspect status." },
  implementation_recommendation: unavailableImplementationRecommendation(
    "not-applicable",
    "Fixture has no implementation-effort evidence.",
  ),
} as const;
const semanticSuccess = {
  schema_version: "1",
  ok: true,
  value: semanticView,
} as const;

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

function expectSemanticFailure(outcome: ToolBoundaryOutcome, code: string): void {
  expect(outcome.kind).toBe("semantic-result");
  if (outcome.kind !== "semantic-result") throw new Error("expected semantic result");
  expect(outcome.result.ok).toBe(false);
  if (outcome.result.ok) throw new Error("expected semantic failure");
  expect(outcome.result.error.code).toBe(code);
}

describe("SDK-free MCP tool boundary", () => {
  it("copies and authenticates protocol errors without mutating the source", () => {
    const source = createProtocolError("TOOL_DISABLED", {
      tool: "archflow_status",
      lifecycle_state: "inert-no-handler"
    });
    const authenticated = authenticateProtocolError(source);
    expect(authenticated.value).toEqual(source);
    expect(Object.isFrozen(authenticated)).toBe(true);
    expect(Object.isFrozen(authenticated.value)).toBe(true);
    expect(Object.isFrozen(authenticated.value.diagnostic.parameters)).toBe(true);
    expect(() => authenticateProtocolError({ ...authenticated })).toThrow();
    expect(() => authenticateProtocolError({ ...source, retryable: true })).toThrow();
  });

  it("authenticates and freezes boundaries while copied registries ignore later mutation", async () => {
    const handlers = {
      archflow_status: () => semanticSuccess
    };
    const boundary = createToolBoundary(handlers);
    handlers.archflow_status = () => { throw new Error("replacement must not run"); };

    expect(Object.isFrozen(boundary)).toBe(true);
    expect(Object.isFrozen(boundary.invoke)).toBe(true);
    expect(() => assertAuthenticToolBoundary(boundary)).not.toThrow();
    expect(() => assertAuthenticToolBoundary({ ...boundary })).toThrow(/authentic tool boundary/);
    expect(() => assertAuthenticToolBoundary({ invoke: boundary.invoke })).toThrow(/authentic tool boundary/);
    const outcome = await boundary.invoke("archflow_status", { schema_version: "1", task_id: "task-1" }, context());
    expect(outcome.kind).toBe("semantic-result");
    if (outcome.kind === "semantic-result") expect(outcome.result.ok).toBe(true);
  });

  it("rejects invalid registry surfaces without reading accessors", () => {
    let getterCalls = 0;
    const accessor = Object.defineProperty({}, "archflow_status", {
      enumerable: true,
      get() { getterCalls += 1; return () => semanticSuccess; }
    });
    expect(() => createToolBoundary(accessor as never)).toThrow(/data properties/);
    expect(getterCalls).toBe(0);
    expect(() => createToolBoundary({ unknown_tool: () => semanticSuccess } as never)).toThrow(/unknown tool/);
    expect(() => createToolBoundary({ archflow_state: () => semanticSuccess } as never)).toThrow(/unknown tool/);
    expect(() => createToolBoundary({ archflow_status: 1 } as never)).toThrow(/functions/);
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

    const disabled = await boundary.invoke("archflow_status", { schema_version: "1", task_id: "task-1" }, invocation);
    expect(disabled).toMatchObject({
      kind: "protocol-error",
      error: {
        value: {
          code: "TOOL_DISABLED",
          diagnostic: { parameters: { tool: "archflow_status", lifecycle_state: "inert-no-handler" } }
        }
      }
    });
    expect(() => assertAuthenticToolBoundaryOutcome({ ...disabled })).toThrow(/authentic tool boundary outcome/);
    expect(() => assertAuthenticToolBoundaryOutcome(structuredClone(disabled) as never)).toThrow(/authentic tool boundary outcome/);
  });

  it("fails every retired durable-vocabulary tool name exactly like an unknown name", async () => {
    const boundary = createToolBoundary({});
    const invocation = context("boundary-retired-1");
    for (const retired of TOOL_NAMES) {
      const outcome = await boundary.invoke(retired, { schema_version: "1", anything: true }, invocation);
      expect(outcome.kind, retired).toBe("protocol-error");
      if (outcome.kind !== "protocol-error") throw new Error("expected protocol outcome");
      expect(outcome.error.value.code, retired).toBe("TOOL_NOT_FOUND");
      const digest = (outcome.error.value.diagnostic.parameters as { tool_name_digest?: string }).tool_name_digest;
      expect(digest, retired).toMatch(/^[0-9a-f]{64}$/u);
      // No argument surface of a retired name ever reaches parsing: the name itself is the refusal.
      expect(JSON.stringify(outcome), retired).not.toContain("anything");
    }
  });

  it("parses semantic inputs and validates compact semantic results on a separate boundary branch", async () => {
    let observed: unknown;
    const boundary = createToolBoundary({
      archflow_status: (input) => {
        observed = input;
        return { schema_version: "1", ok: true, value: semanticView };
      },
    });
    const invocation = context("semantic-boundary-1");
    const input = { schema_version: "1", task_id: "task-1" };
    const success = await boundary.invoke("archflow_status", input, invocation);
    expect(success).toMatchObject({ kind: "semantic-result", tool: "archflow_status", result: { ok: true, value: semanticView } });
    expect(observed).toEqual(input);
    expect(observed).not.toBe(input);
    expect(() => assertAuthenticToolBoundaryOutcome(success)).not.toThrow();

    const invalid = await boundary.invoke("archflow_status", { ...input, intent_id: "mechanical-field" }, invocation);
    expect(invalid).toMatchObject({ kind: "semantic-result", tool: "archflow_status", result: { ok: false, error: { code: "CONTRACT_INVALID" } } });
    const disabled = await createToolBoundary({}).invoke("archflow_apply", {
      schema_version: "1", task_id: "task-1", invocation: { skill: "archflow-prd", intent: "resume" },
      action: { offer: `af1_${"a".repeat(64)}` },
    }, invocation);
    expect(disabled).toMatchObject({ kind: "protocol-error", error: { value: { code: "TOOL_DISABLED", diagnostic: { parameters: { tool: "archflow_apply" } } } } });
  });

  it("classifies invalid semantic inputs before inert availability and names the offending fields", async () => {
    const boundary = createToolBoundary({});
    const invocation = context("boundary-input-1");

    for (const candidate of [undefined, 42, null, "input", []] as const) {
      const outcome = await boundary.invoke("archflow_status", candidate, invocation);
      expectSemanticFailure(outcome, "CONTRACT_INVALID");
    }
    // Non-plain-JSON surfaces (accessors, undefined holes, cycles) fail the same way.
    for (const candidate of [
      new Map(),
      Object.create({ schema_version: "1" }),
      (() => { const value: Record<string, unknown> = { schema_version: "1" }; value.self = value; return value; })()
    ] as const) {
      const outcome = await boundary.invoke("archflow_status", candidate, invocation);
      expectSemanticFailure(outcome, "CONTRACT_INVALID");
    }
    // A wrong-typed field is reported with its path so a caller is not left guessing.
    const stringTyped = await boundary.invoke("archflow_status", { schema_version: "1", task_id: 7 }, invocation);
    expectSemanticFailure(stringTyped, "CONTRACT_INVALID");
    if (stringTyped.kind === "semantic-result" && !stringTyped.result.ok) {
      expect(stringTyped.result.error.message).toMatch(/task_id/u);
    }

    const applyInvalid = await boundary.invoke("archflow_apply", {
      schema_version: "1", task_id: "task-1", invocation: { skill: "archflow-prd", intent: "resume" },
      action: { offer: "not-an-offer-token" },
    }, invocation);
    expectSemanticFailure(applyInvalid, "CONTRACT_INVALID");
    if (applyInvalid.kind === "semantic-result" && !applyInvalid.result.ok) {
      expect(applyInvalid.result.error.message).toMatch(/offer/u);
    }

    // Classification precedes handler availability: a valid input on an unregistered tool is
    // TOOL_DISABLED, never a parse artifact.
    const disabled = await boundary.invoke("archflow_status", { schema_version: "1", task_id: "task-1" }, invocation);
    expect(disabled).toMatchObject({ kind: "protocol-error", error: { value: { code: "TOOL_DISABLED" } } });
  });

  it("calls a valid handler once and deeply freezes an authenticated success", async () => {
    let calls = 0;
    const boundary = createToolBoundary({
      archflow_status: (input, invocation) => {
        calls += 1;
        expect(input.task_id).toBe("task-1");
        expect(invocation.invocation_id).toBe("boundary-success-1");
        return semanticSuccess;
      }
    });
    const outcome = await boundary.invoke("archflow_status", { schema_version: "1", task_id: "task-1" }, context("boundary-success-1"));
    expect(calls).toBe(1);
    expect(outcome).toMatchObject({ kind: "semantic-result", tool: "archflow_status", result: semanticSuccess });
    expect(Object.isFrozen(outcome)).toBe(true);
    if (outcome.kind !== "semantic-result" || !outcome.result.ok) throw new Error("expected success");
    expect(Object.isFrozen(outcome.result)).toBe(true);
    expect(Object.isFrozen(outcome.result.value)).toBe(true);
    expect(() => assertAuthenticToolBoundaryOutcome(outcome)).not.toThrow();
    expect(() => assertAuthenticToolBoundaryOutcome({ ...outcome })).toThrow(/authentic tool boundary outcome/);
    expect(() => assertAuthenticToolBoundaryOutcome({ kind: "semantic-result", tool: "archflow_status", result: outcome.result })).toThrow(/authentic tool boundary outcome/);
  });

  it("passes an authenticated semantic failure through unchanged", async () => {
    const returned = {
      schema_version: "1",
      ok: false,
      error: { code: "WORKFLOW_INVALID", message: "The pinned workflow is broken.", retryable: false },
    } as const;
    const boundary = createToolBoundary({ archflow_status: () => returned });
    const outcome = await boundary.invoke("archflow_status", { schema_version: "1", task_id: "task-1" }, context("boundary-failure-1"));
    expectSemanticFailure(outcome, "WORKFLOW_INVALID");
    expect(() => assertAuthenticToolBoundaryOutcome(outcome)).not.toThrow();
  });

  it("reduces malformed, substituted, thrown, and rejected handler results to correlation-only internal errors", async () => {
    const write = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    const cases = [
      { label: "malformed", handler: () => ({ schema_version: "1", ok: true, value: { secret: "handler prose" } }) },
      { label: "cross-shape", handler: () => ({ schema_version: "1", ok: true, value: { kind: "state-success", path: "phases/3" } }) },
      { label: "throw", handler: () => { throw new Error("raw synchronous secret"); } },
      { label: "reject", handler: async () => { throw new Error("raw asynchronous secret"); } }
    ] as const;
    for (const item of cases) {
      let calls = 0;
      const boundary = createToolBoundary({ archflow_status: () => { calls += 1; return item.handler(); } });
      const invocationId = `boundary-internal-${item.label}`;
      const outcome = await boundary.invoke("archflow_status", { schema_version: "1", task_id: "task-1" }, context(invocationId));
      expect(calls, item.label).toBe(1);
      expectSemanticFailure(outcome, "INTERNAL_ERROR");
      if (outcome.kind === "semantic-result" && !outcome.result.ok) {
        expect(outcome.result.error.message).toContain(invocationId);
      }
      const serialized = JSON.stringify(outcome);
      expect(serialized, item.label).not.toContain("secret");
      expect(serialized, item.label).not.toContain("handler prose");
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

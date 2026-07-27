import { describe, expect, it } from "vitest";

import { PROJECT_ERROR_DEFINITIONS, PROTOCOL_ERROR_DEFINITIONS, createProjectError, createProtocolError, parseProjectError, parseProtocolError } from "../../src/contracts/errors.js";

const D = "a".repeat(64);

describe("error registries", () => {
  it("are exhaustive, separate, and recursively immutable at definition boundaries", () => {
    expect(Object.keys(PROJECT_ERROR_DEFINITIONS)).toHaveLength(52);
    expect(Object.keys(PROTOCOL_ERROR_DEFINITIONS)).toEqual(["TOOL_NOT_FOUND", "TOOL_DISABLED", "UNSUPPORTED_PROTOCOL", "INITIALIZATION_REPEATED"]);
    expect(Object.keys(PROJECT_ERROR_DEFINITIONS).some((code) => Object.hasOwn(PROTOCOL_ERROR_DEFINITIONS, code))).toBe(false);
    expect(Object.isFrozen(PROJECT_ERROR_DEFINITIONS)).toBe(true);
    expect(Object.isFrozen(PROJECT_ERROR_DEFINITIONS.STATE_CONFLICT)).toBe(true);
    expect(Object.isFrozen(PROJECT_ERROR_DEFINITIONS.STATE_CONFLICT.parameter_parser)).toBe(true);
  });

  it("constructs only registry-correlated serialized values", () => {
    const conflict = createProjectError("STATE_CONFLICT", { expected_revision: 2, observed_revision: 3 });
    expect(conflict).toEqual({ schema_version: "1", code: "STATE_CONFLICT", owner: "state", retryable: true, diagnostic: { template_id: "STATE_CONFLICT", parameters: { expected_revision: 2, observed_revision: 3 } }, next_action: "reread-and-retry-intent" });
    expect(parseProjectError(conflict)).toBe(conflict);
    expect(() => parseProjectError({ ...conflict, retryable: false })).toThrow();
    expect(() => createProjectError("STATE_CONFLICT", { expected_revision: 2, observed_revision: 3, raw_exception: "secret" } as never)).toThrow();
    const reordered = { next_action: conflict.next_action, diagnostic: { parameters: { observed_revision: 3, expected_revision: 2 }, template_id: conflict.code }, retryable: conflict.retryable, owner: conflict.owner, code: conflict.code, schema_version: conflict.schema_version };
    expect(parseProjectError(reordered)).toBe(reordered);
  });

  it("keeps protocol diagnostics safe and distinct from project errors", () => {
    const missing = createProtocolError("TOOL_NOT_FOUND", { tool_name_digest: D });
    expect(missing.diagnostic.parameters).toEqual({ tool_name_digest: D });
    expect(parseProtocolError(missing)).toBe(missing);
    expect(() => createProtocolError("TOOL_NOT_FOUND", { tool_name_digest: D, tool_name: "unknown-secret-name" } as never)).toThrow();
    expect(() => parseProjectError(missing)).toThrow();
  });

  it("requires sorted exact snapshot paths and preserves cancellation ownership", () => {
    expect(() => createProjectError("SNAPSHOT_LIMIT", { limit_scope: "task", offending_paths: ["z/file", "a/file"], current_bytes: 2, byte_cap: 1 })).toThrow();
    const child = createProjectError("CANCELLED", { source: "client", attempt: 1 });
    const gate = createProjectError("GATE_CANCELLED", { gate_id: "gate-1", gate_kind: "artifact-approval" });
    expect([child.owner, child.retryable, child.next_action]).toEqual(["dispatch", true, "restart-child-attempt"]);
    expect([gate.owner, gate.retryable, gate.next_action]).toEqual(["gate", false, "restart-gate-flow"]);
  });
});

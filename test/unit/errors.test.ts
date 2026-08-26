import { describe, expect, it } from "vitest";

import { PROJECT_ERROR_DEFINITIONS, PROTOCOL_ERROR_DEFINITIONS, createProjectError, createProtocolError, parseProjectError, parseProtocolError } from "../../src/contracts/errors.js";

const D = "a".repeat(64);

describe("error registries", () => {
  it("are exhaustive, separate, and recursively immutable at definition boundaries", () => {
    expect(Object.keys(PROJECT_ERROR_DEFINITIONS)).toHaveLength(53);
    // The staged-request kinds retired with the local staging path.
    expect(Object.keys(PROJECT_ERROR_DEFINITIONS)).not.toContain("STAGED_REQUEST_NOT_FOUND");
    // Retired with the byte pin: config became an editable input, so no comparison fires.
    expect(Object.keys(PROJECT_ERROR_DEFINITIONS)).not.toContain("PINNED_CONFIG_MISMATCH");
    expect(Object.keys(PROJECT_ERROR_DEFINITIONS)).not.toContain("STAGED_REQUEST_MISMATCH");
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

  it("routes heterogeneous invalid state to inspection instead of a nonexistent universal repair", () => {
    const invalid = createProjectError("STATE_INVALID", {
      phase_instance: "phase-impl-2",
      issue_code: "produce-projection-not-current",
    });
    expect(invalid.next_action).toBe("inspect-current-state");
  });

  it("pins the retired immutable intent outcome", () => {
    const error = createProjectError("INTENT_NOT_CURRENT", {
      intent_id: "intent-0001",
      receipt_revision: 7,
      current_revision: 9,
    });
    expect(error).toEqual({
      schema_version: "1",
      code: "INTENT_NOT_CURRENT",
      owner: "intent",
      retryable: false,
      diagnostic: {
        template_id: "INTENT_NOT_CURRENT",
        parameters: { intent_id: "intent-0001", receipt_revision: 7, current_revision: 9 },
      },
      next_action: "inspect-current-state",
    });
    expect(() => createProjectError("INTENT_NOT_CURRENT", {
      intent_id: "bad:intent",
      receipt_revision: 7,
      current_revision: 9,
    })).toThrow();
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

  it("retightens task and gate identifiers and the offending-path frame in error parameters", () => {
    for (const taskId of ["Task_1", "Task:1", "TASK-1"]) {
      expect(() => createProjectError("TASK_INVALID", { task_id: taskId as never, issue_code: "archflow-tree-mode-illegal" })).toThrow();
      expect(() => createProjectError("PATH_INVALID", { task_id: taskId as never, path_class: "task-state" })).toThrow();
    }
    for (const gateId of ["Gate:1", "gate:1"]) {
      expect(() => createProjectError("GATE_ACTIVE", { gate_id: gateId as never, gate_kind: "artifact-approval" })).toThrow();
    }
    expect(createProjectError("PATH_ESCAPE", { task_id: "task-1" as never, path_class: "authority-result" }).diagnostic.parameters.path_class).toBe("authority-result");
    expect(() => createProjectError("PATH_ESCAPE", { task_id: "task-1" as never, path_class: "not-a-class" as never })).toThrow();
    // offending_paths is repository-relative and shares the tightened claim grammar.
    expect(createProjectError("SNAPSHOT_LIMIT", { limit_scope: "task", offending_paths: [".archflow/tasks/task-1/a.json" as never], current_bytes: 2, byte_cap: 1 }).diagnostic.parameters.offending_paths).toHaveLength(1);
    expect(() => createProjectError("SNAPSHOT_LIMIT", { limit_scope: "task", offending_paths: ["bad:path" as never], current_bytes: 2, byte_cap: 1 })).toThrow();
    // detector_id keeps the broad grammar.
    expect(createProjectError("SECRET_DETECTED", { path_class: "document", detector_id: "Detector:1" }).diagnostic.parameters.detector_id).toBe("Detector:1");
  });
});

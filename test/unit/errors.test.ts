import { describe, expect, it } from "vitest";

import { DISPATCH_FAILURE_CODES } from "../../src/contracts/dispatch-failure.js";
import { PROJECT_ERROR_DEFINITIONS, createProjectError, parseProjectError } from "../../src/contracts/errors.js";

describe("error registry", () => {
  it("is exhaustive and recursively immutable at definition boundaries", () => {
    expect(Object.keys(PROJECT_ERROR_DEFINITIONS)).toEqual([
      "CONTRACT_INVALID",
      "CONFIG_INVALID", "CONFIG_MODEL_UNSUPPORTED", "CONFIG_FAMILY_UNSUPPORTED",
      "REPOSITORY_NOT_FOUND", "REPOSITORY_VIEW_UNAVAILABLE",
      "UNSUPPORTED_HOST", "UNSUPPORTED_MODEL", "FAMILY_MISMATCH", "CLI_VERSION_UNSUPPORTED", "AUTH_UNAVAILABLE", "CLI_MISSING",
      "RATE_LIMITED", "TIMEOUT", "CANCELLED", "MODEL_OUTPUT_INVALID", "IO_ERROR", "OUTPUT_OVERFLOW", "PROCESS_FAILED",
    ]);
    // The staged-request kinds retired with the local staging path.
    expect(Object.keys(PROJECT_ERROR_DEFINITIONS)).not.toContain("STAGED_REQUEST_NOT_FOUND");
    // Retired with the byte pin: config became an editable input, so no comparison fires.
    expect(Object.keys(PROJECT_ERROR_DEFINITIONS)).not.toContain("PINNED_CONFIG_MISMATCH");
    expect(Object.keys(PROJECT_ERROR_DEFINITIONS)).not.toContain("STAGED_REQUEST_MISMATCH");
    expect(Object.isFrozen(PROJECT_ERROR_DEFINITIONS)).toBe(true);
    expect(Object.isFrozen(PROJECT_ERROR_DEFINITIONS.TIMEOUT)).toBe(true);
    expect(Object.isFrozen(PROJECT_ERROR_DEFINITIONS.TIMEOUT.parameter_parser)).toBe(true);
  });

  it("constructs only registry-correlated serialized values", () => {
    const timeout = createProjectError("TIMEOUT", { adapter: "codex-cli", attempt: 2, limit_ms: 900_000 });
    expect(timeout).toEqual({ schema_version: "1", code: "TIMEOUT", owner: "dispatch", retryable: true, diagnostic: { template_id: "TIMEOUT", parameters: { adapter: "codex-cli", attempt: 2, limit_ms: 900_000 } }, next_action: "retry-unchanged-attempt" });
    expect(parseProjectError(timeout)).toBe(timeout);
    expect(() => parseProjectError({ ...timeout, retryable: false })).toThrow();
    expect(() => createProjectError("TIMEOUT", { adapter: "codex-cli", attempt: 2, limit_ms: 900_000, raw_exception: "secret" } as never)).toThrow();
    const reordered = { next_action: timeout.next_action, diagnostic: { parameters: { limit_ms: 900_000, attempt: 2, adapter: "codex-cli" }, template_id: timeout.code }, retryable: timeout.retryable, owner: timeout.owner, code: timeout.code, schema_version: timeout.schema_version };
    expect(parseProjectError(reordered)).toBe(reordered);
  });

  it("rejects a serialized value whose code the registry does not declare", () => {
    const timeout = createProjectError("TIMEOUT", { adapter: "codex-cli", attempt: 2, limit_ms: 900_000 });
    expect(() => parseProjectError({ ...timeout, code: "NOT_A_CODE", diagnostic: { ...timeout.diagnostic, template_id: "NOT_A_CODE" } })).toThrow("unknown code");
  });

  it("preserves cancellation ownership", () => {
    const child = createProjectError("CANCELLED", { source: "client", attempt: 1 });
    expect([child.owner, child.retryable, child.next_action]).toEqual(["dispatch", true, "restart-child-attempt"]);
    expect(() => createProjectError("CANCELLED", { source: "gate" as never, attempt: 1 })).toThrow();
  });

  it("registers every dispatch failure code a reviewer child can raise", () => {
    for (const code of DISPATCH_FAILURE_CODES) {
      expect(PROJECT_ERROR_DEFINITIONS, code).toHaveProperty(code);
    }
  });
});

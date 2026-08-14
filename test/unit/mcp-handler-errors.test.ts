import { afterEach, describe, expect, it, vi } from "vitest";

import { createProjectError } from "../../src/contracts/errors.js";
import { CliAdapterError } from "../../src/dispatch/cli.js";
import { DispatchProcessError } from "../../src/dispatch/process.js";
import { DispatchRoutingError } from "../../src/dispatch/routing.js";
import { mapHandlerErrors } from "../../src/mcp/handlers/errors.js";
import { ReviewEnvelopeError } from "../../src/review/envelopes.js";

describe("mapHandlerErrors", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it.each([
    new DispatchRoutingError(createProjectError("UNSUPPORTED_HOST", { host: "unknown" })),
    new CliAdapterError(createProjectError("AUTH_UNAVAILABLE", { adapter: "codex-cli" })),
    new DispatchProcessError(createProjectError("CANCELLED", { source: "client", attempt: 1 })),
    new ReviewEnvelopeError(createProjectError("MODEL_OUTPUT_INVALID", {
      adapter: "codex-cli", attempt: 1, issue_code: "envelope-too-large",
    })),
  ])("preserves the classified project error carried by %s", async (error) => {
    const result = await mapHandlerErrors<"archflow_state">("correlation-1", async () => {
      throw error;
    });
    expect(result).toMatchObject({ ok: false, error: { code: error.project_error.code } });
  });

  it("maps an unexpected operational exception without exposing its message", async () => {
    vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    const result = await mapHandlerErrors<"archflow_state">("correlation-2", async () => {
      throw new Error("private child diagnostic");
    });
    expect(result).toMatchObject({
      ok: false,
      error: { code: "INTERNAL_ERROR", diagnostic: { parameters: { correlation_id: "correlation-2" } } },
    });
    expect(JSON.stringify(result)).not.toContain("private child diagnostic");
  });

  it("writes the correlation id and stack to stderr when emitting an internal error", async () => {
    const write = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    const thrown = new Error("private child diagnostic");
    const result = await mapHandlerErrors<"archflow_state">("correlation-3", async () => {
      throw thrown;
    });
    expect(result).toMatchObject({ ok: false, error: { code: "INTERNAL_ERROR" } });
    const logged = write.mock.calls.map(([chunk]) => String(chunk)).join("");
    expect(logged).toContain("correlation_id=correlation-3");
    expect(logged).toContain(thrown.stack ?? "private child diagnostic");
    expect(JSON.stringify(result)).not.toContain("private child diagnostic");
  });

  it("does not write to stderr when the error carries a classified project result", async () => {
    const write = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    const result = await mapHandlerErrors<"archflow_state">("correlation-4", async () => {
      throw new DispatchRoutingError(createProjectError("UNSUPPORTED_HOST", { host: "unknown" }));
    });
    expect(result).toMatchObject({ ok: false, error: { code: "UNSUPPORTED_HOST" } });
    expect(write).not.toHaveBeenCalled();
  });
});

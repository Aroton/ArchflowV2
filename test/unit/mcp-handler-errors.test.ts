import { describe, expect, it } from "vitest";

import { createProjectError } from "../../src/contracts/errors.js";
import { CliAdapterError } from "../../src/dispatch/cli.js";
import { DispatchProcessError } from "../../src/dispatch/process.js";
import { DispatchRoutingError } from "../../src/dispatch/routing.js";
import { mapHandlerErrors } from "../../src/mcp/handlers/errors.js";
import { ReviewEnvelopeError } from "../../src/review/envelopes.js";

describe("mapHandlerErrors", () => {
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
    const result = await mapHandlerErrors<"archflow_state">("correlation-2", async () => {
      throw new Error("private child diagnostic");
    });
    expect(result).toMatchObject({
      ok: false,
      error: { code: "INTERNAL_ERROR", diagnostic: { parameters: { correlation_id: "correlation-2" } } },
    });
    expect(JSON.stringify(result)).not.toContain("private child diagnostic");
  });
});

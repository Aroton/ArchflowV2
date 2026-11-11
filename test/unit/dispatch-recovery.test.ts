import { describe, expect, it } from "vitest";

import { createProjectError } from "../../src/contracts/errors.js";
import { classifiedDispatchFailure, isTransientDispatchFailure } from "../../src/dispatch/failure-classification.js";
import { DispatchRoutingError } from "../../src/dispatch/routing.js";
import { CliAdapterError, selectCliAdapter } from "../../src/dispatch/cli.js";
import { createRawAdjudicationV2Schema } from "../../src/contracts/adjudication.js";
import { judgmentSlots, nativeStream, recoveredCapacityEvents, syntheticJudgments } from "../helpers/antigravity-output.js";

const limited = () => new DispatchRoutingError(createProjectError("RATE_LIMITED", { adapter: "codex-cli", attempt: 1 }));

describe("dispatch failure recovery classification", () => {
  it.each([false, true])("validates recovered Gemini judgments before accepting them (invalid=%s)", async invalid => {
    const route = { model: "gemini-3.8-flash-high", effort: "high" } as const;
    const adapter = selectCliAdapter("claude", { adapter: "antigravity-cli", family: "gemini", ...route });
    const events = recoveredCapacityEvents();
    if (invalid) {
      const output = syntheticJudgments();
      delete output.judgments["slot-10"];
      events.at(-1)!.result!.structured_output = output;
    }
    const result = { exit_code: 0, signal: null, stdout: nativeStream(events), stderr: Buffer.alloc(0) };
    // A capacity error the CLI recovered from in the same run is not a failure.
    expect(adapter.classifyFailure(result)).toBeUndefined();
    const output: unknown = JSON.parse(Buffer.from(adapter.parseOutput(result)).toString());
    if (invalid) expect(() => createRawAdjudicationV2Schema(judgmentSlots).parse(output)).toThrow();
    else expect(createRawAdjudicationV2Schema(judgmentSlots).parse(output)).toEqual(syntheticJudgments());
  });

  it("explains each failed reviewer's cause without raw exception text", () => {
    expect(classifiedDispatchFailure(new DispatchRoutingError(createProjectError("RATE_LIMITED", {
      adapter: "claude-cli", attempt: 1, reason: "session-limit",
    })))).toMatchObject({ code: "RATE_LIMITED", message: expect.stringContaining("session limit") });
    expect(classifiedDispatchFailure(new DispatchRoutingError(createProjectError("TIMEOUT", {
      adapter: "antigravity-cli", attempt: 1, limit_ms: 300_000, origin: "cli",
    })))).toMatchObject({ code: "TIMEOUT", message: expect.stringContaining("300 seconds") });
    expect(classifiedDispatchFailure(new DispatchRoutingError(createProjectError("MODEL_OUTPUT_INVALID", {
      adapter: "antigravity-cli", attempt: 1, issue_code: "structured-output-missing",
    })))).toEqual({ code: "MODEL_OUTPUT_INVALID", message: "The reviewer CLI response was missing structured_output." });
  });

  it("treats rate limits, timeouts, unavailable repository views, and transient transport as transient", () => {
    expect(isTransientDispatchFailure(limited())).toBe(true);
    expect(isTransientDispatchFailure(new DispatchRoutingError(createProjectError("TIMEOUT", {
      adapter: "codex-cli", attempt: 1, limit_ms: 300_000, origin: "cli",
    })))).toBe(true);
    expect(isTransientDispatchFailure(new DispatchRoutingError(createProjectError("REPOSITORY_VIEW_UNAVAILABLE", {
      repository_name: "primary",
    })))).toBe(true);
    expect(isTransientDispatchFailure(new CliAdapterError(createProjectError("PROCESS_FAILED", {
      adapter: "codex-cli", exit_class: "transient-transport",
    })))).toBe(true);
  });

  it("never treats authentication, cancellation, generic process errors, or invalid output as transient", () => {
    expect(isTransientDispatchFailure(new DispatchRoutingError(createProjectError("AUTH_UNAVAILABLE", { adapter: "codex-cli" })))).toBe(false);
    expect(isTransientDispatchFailure(new Error("timeout in arbitrary prose"))).toBe(false);
    expect(isTransientDispatchFailure(new DispatchRoutingError(createProjectError("CANCELLED", { source: "client", attempt: 1 })))).toBe(false);
    expect(isTransientDispatchFailure(new DispatchRoutingError(createProjectError("PROCESS_FAILED", { adapter: "codex-cli", exit_class: "exit-1" })))).toBe(false);
    expect(isTransientDispatchFailure(new DispatchRoutingError(createProjectError("MODEL_OUTPUT_INVALID", { adapter: "codex-cli", attempt: 1, issue_code: "invalid" })))).toBe(false);
  });
});

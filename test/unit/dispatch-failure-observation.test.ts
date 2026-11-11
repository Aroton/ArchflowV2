import { describe, expect, it } from "vitest";

import { createProjectError } from "../../src/contracts/errors.js";
import { classifiedDispatchFailure } from "../../src/dispatch/failure-classification.js";
import { DispatchRoutingError } from "../../src/dispatch/routing.js";

describe("dispatch-failure classification", () => {
  it.each([
    ["structured-output-missing", "missing structured_output"],
    ["structured-output-invalid", "valid plain JSON value"],
    ["antigravity-wrapper-invalid", "valid final result wrapper"],
  ])("explains %s without copying raw exception text", (issueCode, explanation) => {
    const error = new DispatchRoutingError(createProjectError("MODEL_OUTPUT_INVALID", {
      adapter: "antigravity-cli", attempt: 1, issue_code: issueCode,
    }));
    error.message = "private raw model response";
    const classified = classifiedDispatchFailure(error)!;
    expect(classified.message).toContain(explanation);
    expect(classified.message.length).toBeLessThanOrEqual(256);
    expect(classified.message).not.toContain("private");
  });

  it("classifies only the bounded outage set without carrying raw exception text", () => {
    const classified = classifiedDispatchFailure(new DispatchRoutingError(
      createProjectError("AUTH_UNAVAILABLE", { adapter: "claude-cli" }),
    ));
    expect(classified).toEqual({
      code: "AUTH_UNAVAILABLE",
      message: "The required reviewer authentication is unavailable.",
    });
    expect(classifiedDispatchFailure(new DispatchRoutingError(
      createProjectError("MODEL_OUTPUT_INVALID", { adapter: "claude-cli", attempt: 1, issue_code: "secret-tail" }),
    ))).toEqual({ code: "MODEL_OUTPUT_INVALID", message: "The reviewer returned unusable structured output. Inspect the output validation failure before retrying." });
    expect(classifiedDispatchFailure(new Error("raw child stderr"))).toBeUndefined();
  });
});

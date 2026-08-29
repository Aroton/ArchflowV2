import { describe, expect, it } from "vitest";
import { reviewOutputIssueCode } from "../../src/review/counter-review.js";
import { z } from "zod";

import { adjudicationOutputIssueCode } from "../../src/review/counter-review.js";

describe("counter-review adjudication diagnostics", () => {
  it.each([
    [new SyntaxError("redacted model output"), "adjudication-json-invalid"],
    [new TypeError("drift_findings must exactly cover approved_upstream_digests"), "adjudication-upstream-coverage"],
    [new TypeError("rule_findings must be sorted and unique"), "adjudication-finding-duplicate"],
    [new TypeError("subject_digest does not match observation capability"), "adjudication-binding-mismatch"],
    [new TypeError("some internal detail"), "adjudication-schema-invalid"],
  ])("classifies a safe issue code", (error, expected) => {
    expect(adjudicationOutputIssueCode(error)).toBe(expected);
  });

  it("classifies Zod unexpected-field errors without exposing field values", () => {
    const result = z.object({ expected: z.string() }).strict().safeParse({ expected: "ok", extra: "secret" });
    if (result.success) throw new Error("expected strict schema rejection");
    expect(adjudicationOutputIssueCode(result.error)).toBe("adjudication-unexpected-fields");
  });
});

describe("reviewOutputIssueCode", () => {
  it.each([
    [new SyntaxError("Unexpected token"), "review-json-invalid"],
    [new TypeError("subject_digest does not match observation capability"), "review-binding-mismatch"],
    [new TypeError("Unrecognized key"), "review-schema-invalid"],
  ])("classifies %s as %s", (error, expected) => {
    expect(reviewOutputIssueCode(error)).toBe(expected);
  });
});

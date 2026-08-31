import { describe, expect, it } from "vitest";

import { extractPhaseDesignComponentManifest } from "../../src/contracts/component-manifest.js";
import { createProjectError } from "../../src/contracts/errors.js";
import { effortInputContractError, envelopeOverflowError } from "../../src/mcp/handlers/counter-review.js";
import { REVIEW_ENVELOPE_BYTE_CAP, ReviewEnvelopeError } from "../../src/review/envelopes.js";
import type { CurrentProduceSubject } from "../../src/state/produce-subject.js";

function subjectWithEntries(sizes: Readonly<Record<string, number>>): CurrentProduceSubject {
  return {
    artifact_digest: "a".repeat(64),
    artifact: {
      artifact_kind: "implementation-output",
      outputs: Object.entries(sizes).map(([path, size]) => ({ path, padding: "x".repeat(size) })),
    },
    retained: {
      projection_plan: {
        entries: Object.entries(sizes).map(([path, size]) => ({
          path,
          desired: {
            state: "present",
            file_type: "regular",
            mode: "100644",
            bytes: new TextEncoder().encode("x".repeat(size)),
          },
        })),
      },
    },
  } as unknown as CurrentProduceSubject;
}

const capError = new ReviewEnvelopeError(
  createProjectError("CONTRACT_INVALID", { issue_code: "envelope-byte-cap" }),
  2_000_000,
);

describe("envelope overflow translation", () => {
  it("preserves an actionable bounded manifest ordering diagnostic", () => {
    let validationError: unknown;
    try {
      extractPhaseDesignComponentManifest(`# Phase

## Implementation Components

\`\`\`archflow-components-v1
schema_version: "1"
components:
  - id: grouped-effort-dispatch
    name: Grouped dispatch
    scope: Dispatch effort review.
    mechanism: Reuse grouped dispatch.
    repositories:
      - name: primary
        paths:
          - src/z.ts
          - src/a.ts
    verification: Exercise the handler.
\`\`\`
`, ["primary"]);
    } catch (error) {
      validationError = error;
    }
    const error = effortInputContractError(
      "phase-design-component-manifest-invalid",
      validationError,
    );
    expect(error).toMatchObject({
      code: "CONTRACT_INVALID",
      diagnostic: { parameters: {
        issue_code: "phase-design-component-manifest-invalid",
        issues: ["component grouped-effort-dispatch repositories primary paths must be ordinal-sorted with no duplicates"],
      } },
    });
  });

  it("names the five largest rendered contributors, sorted lexically, with the failed size", () => {
    const subject = subjectWithEntries({
      "src/f-small.ts": 10,
      "src/a-large.ts": 900,
      "src/e-mid.ts": 500,
      "src/c-huge.ts": 2000,
      "src/b-big.ts": 800,
      "src/d-bigger.ts": 850,
      "src/g-tiny.ts": 5,
    });

    const error = envelopeOverflowError(capError, subject);

    expect(error).toMatchObject({
      code: "ENVELOPE_OVERFLOW",
      next_action: "reduce-review-subject",
      diagnostic: {
        parameters: {
          offending_paths: [
            "src/a-large.ts",
            "src/b-big.ts",
            "src/c-huge.ts",
            "src/d-bigger.ts",
            "src/e-mid.ts",
          ],
          current_bytes: 2_000_000,
          byte_cap: REVIEW_ENVELOPE_BYTE_CAP,
        },
      },
    });
  });

  it("translates only the byte-cap failure and only when a contributor can be named", () => {
    const subject = subjectWithEntries({ "src/app.ts": 10 });
    const otherEnvelopeError = new ReviewEnvelopeError(
      createProjectError("CONTRACT_INVALID", { issue_code: "artifact-not-utf8" }),
    );

    expect(envelopeOverflowError(otherEnvelopeError, subject)).toBeUndefined();
    expect(envelopeOverflowError(new Error("unrelated"), subject)).toBeUndefined();
    expect(envelopeOverflowError(capError, subjectWithEntries({}))).toBeUndefined();
  });
});

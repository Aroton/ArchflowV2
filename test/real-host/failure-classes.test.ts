import { describe, expect, it } from "vitest";

import { reviewReportOutputSchema } from "../../src/contracts/review.js";
import type { PlainJsonValue } from "../../src/contracts/plain-json.js";
import { CliAdapterError } from "../../src/dispatch/cli.js";
import { createReviewDispatcher } from "../../src/dispatch/coordinator.js";
import { DispatchProcessError } from "../../src/dispatch/process.js";
import type { DispatchRoute } from "../../src/dispatch/routing.js";
import { sealDispatchInput, type DispatchEnvelope } from "../../src/review/envelopes.js";
import { REAL_HOST_TEST_TIMEOUT_MS, failedAttemptObserver, realHostsAvailable, requireRealHostsAvailable } from "../helpers/real-host.js";
import { createReviewRepository } from "../helpers/review-repository.js";
import { standaloneReviewFields } from "../helpers/standalone-review-input.js";

/** The standalone review output contract, as `createReviewResponseSchema` hands it to dispatch. */
const reviewSchema = JSON.parse(JSON.stringify(reviewReportOutputSchema.toJSONSchema({ target: "draft-2020-12" }))) as PlainJsonValue;

const REAL_HOSTS_AVAILABLE = realHostsAvailable();
requireRealHostsAvailable(REAL_HOSTS_AVAILABLE);
/** A sealed standalone counter-review input, the shape `runSimpleReview` dispatches. */
const ENVELOPE: DispatchEnvelope = sealDispatchInput("review", {
  ...standaloneReviewFields({ subject: "A local parser rejects malformed JSON before changing state." }),
  assignment: { reviewer_id: "counter-reviewer-1", focus: "general", criterion_ids: ["correctness"] },
  rubric: { schema_version: "1", kind: "implementation", mode: "adversarial", criteria: [{ id: "correctness", text: "Report a concrete correctness defect.", blocking: true }] },
});

describe.skipIf(!REAL_HOSTS_AVAILABLE)("real-host failure classes", () => {
  it("classifies a real Codex invalid-model rejection as UNSUPPORTED_MODEL", async () => {
    const repository = await createReviewRepository({ label: "real-failure-model" });
    const route: DispatchRoute = {
      adapter: "codex-cli",
      family: "codex",
      model: "gpt-model-does-not-exist",
      effort: "xhigh",
    };
    const observer = failedAttemptObserver();
    try {
      const dispatch = createReviewDispatcher({
        host: "claude",
        repository_root: repository.root,
        signal: new AbortController().signal,
        cancellation_source: "client",
      }, observer.observe);
      await expect(dispatch(route, ENVELOPE, reviewSchema)).rejects.toSatisfy((error: unknown) =>
        error instanceof CliAdapterError && error.project_error.code === "UNSUPPORTED_MODEL");
      expect(observer.attempts).toHaveLength(1);
      expect(observer.attempts[0]).toMatchObject({
        adapter: "codex-cli",
        model: route.model,
        failure_code: "UNSUPPORTED_MODEL",
        cli_version: expect.stringMatching(/^\d+\.\d+\.\d+$/u),
      });
    } finally {
      repository.dispose();
    }
  }, REAL_HOST_TEST_TIMEOUT_MS);

  it("classifies an aborted real dispatch path as CANCELLED", async () => {
    const repository = await createReviewRepository({ label: "real-failure-cancel" });
    const controller = new AbortController();
    const route: DispatchRoute = {
      adapter: "codex-cli", family: "codex", model: "gpt-5.6-sol", effort: "xhigh",
    };
    const observer = failedAttemptObserver();
    try {
      const dispatch = createReviewDispatcher({
        host: "claude",
        repository_root: repository.root,
        signal: controller.signal,
        cancellation_source: "client",
      }, observer.observe);
      const pending = dispatch(route, ENVELOPE, reviewSchema);
      setTimeout(() => controller.abort(), 1).unref();
      await expect(pending).rejects.toSatisfy((error: unknown) =>
        error instanceof DispatchProcessError && error.project_error.code === "CANCELLED");
      expect(observer.attempts).toHaveLength(1);
      expect(observer.attempts[0]).toMatchObject({ adapter: "codex-cli", failure_code: "CANCELLED" });
    } finally {
      repository.dispose();
    }
  }, REAL_HOST_TEST_TIMEOUT_MS);

  // Real TIMEOUT would intentionally spend the full 300 s dispatch budget; OUTPUT_OVERFLOW would
  // buy an enormous generation; RATE_LIMITED would consume quota to exhaustion; and logged-out
  // AUTH_UNAVAILABLE would require clobbering the developer's own credentials. Those destructive
  // or disproportionate cases remain covered by the existing fake-host fault suites only.
});

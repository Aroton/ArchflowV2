import { spawnSync } from "node:child_process";

import { describe, expect, it } from "vitest";

import { reviewReportOutputSchema } from "../../src/contracts/review.js";
import { parseRubricV1 } from "../../src/contracts/rubric.js";
import { selectCliAdapter } from "../../src/dispatch/cli.js";
import { runDispatchChild } from "../../src/dispatch/process.js";
import type { DispatchRoute } from "../../src/dispatch/routing.js";
import { createDispatchWorkspace } from "../../src/dispatch/workspace.js";
import { sealDispatchInput } from "../../src/review/envelopes.js";
import { dispatchInputRecord } from "../../src/review/inputs.js";
import { reviewAssignment } from "../../src/review/rubrics.js";
import { REAL_HOST_TEST_TIMEOUT_MS, realHostsAvailable, requireRealHostsAvailable } from "../helpers/real-host.js";
import { standaloneReviewFields } from "../helpers/standalone-review-input.js";

const REAL_HOSTS_AVAILABLE = realHostsAvailable();
requireRealHostsAvailable(REAL_HOSTS_AVAILABLE);

/**
 * The cc-switch provider id to exercise, e.g. ARCHFLOW_CC_SWITCH_PROVIDER=zai. The suite skips
 * when unset, so machines without a configured alternative provider still get an ordinary
 * real-host run; the probe below only spawns after the real-host opt-in has been checked.
 */
const PROVIDER = process.env.ARCHFLOW_CC_SWITCH_PROVIDER;
const MODEL = process.env.ARCHFLOW_CC_SWITCH_MODEL ?? "glm-5.3";

function providerConfigured(): boolean {
  if (!REAL_HOSTS_AVAILABLE || PROVIDER === undefined) return false;
  const probe = spawnSync("cc-switch", ["provider", "list"], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "ignore"],
    timeout: 10_000,
  });
  return probe.status === 0 && probe.stdout.includes(PROVIDER);
}

describe.skipIf(!providerConfigured())("cc-switch provider dispatch", () => {
  it("launches the real claude child through the configured provider and returns a valid review", {
    timeout: REAL_HOST_TEST_TIMEOUT_MS,
  }, async () => {
    const route: DispatchRoute = {
      adapter: "claude-cli",
      family: "claude",
      model: MODEL,
      effort: "high",
      provider: PROVIDER!,
    };
    const workspace = await createDispatchWorkspace("claude-cli");
    try {
      const adapter = selectCliAdapter("codex", route);
      const rubric = parseRubricV1({
        schema_version: "1",
        kind: "implementation",
        mode: "adversarial",
        criteria: [{
          id: "correctness",
          text: "This is a dispatch smoke subject; the artifact is intentionally trivial. A sound artifact is expected to yield zero blocking findings.",
          blocking: true,
        }],
      });
      const envelope = sealDispatchInput("review", {
        ...standaloneReviewFields({
          subject: "# Smoke artifact\n\nNothing to review — this exists only to prove the dispatch pipeline reaches a real model through cc-switch.\n",
        }),
        assignment: reviewAssignment("counter-reviewer-1", "general", "phase-impl", rubric),
        rubric,
      });
      const invocation = await adapter.buildInvocation(envelope, route, workspace, dispatchInputRecord(envelope).response_schema!);

      // The wrap is exactly `cc-switch start claude <provider> -- <lockdown argv…>`, the requested
      // model rides through it, and the child PATH can reach the cc-switch binary.
      expect(invocation.command).toBe("cc-switch");
      expect(invocation.argv.slice(0, 4)).toEqual(["start", "claude", PROVIDER!, "--"]);
      const lockdownArgv = invocation.argv.slice(invocation.argv.indexOf("--") + 1);
      expect(lockdownArgv[lockdownArgv.indexOf("--model") + 1]).toBe(MODEL);
      expect(String(invocation.env.PATH).split(":")).toContain(`${workspace.env.HOME}/.local/bin`);

      const result = await runDispatchChild({
        ...invocation,
        signal: new AbortController().signal,
        cancellation_source: "client",
      });
      expect(result.exit_code).toBe(0);

      // Which model traveled: the JSON wrapper carries no model field in this CLI version, but
      // Claude Code's stderr "unrecognized_model" notice names the exact model id it sent
      // upstream — non-Anthropic ids always draw it, so it doubles as pass-through proof.
      expect(result.stderr.toString("utf8")).toContain(`"model":"${MODEL}"`);

      // A complete, schema-valid review came back through the provider: the structured output
      // parses and satisfies the standalone review report contract.
      const extracted = adapter.parseOutput(result);
      expect(reviewReportOutputSchema.strict().safeParse(JSON.parse(new TextDecoder().decode(extracted))).success).toBe(true);
    } finally {
      await workspace.dispose();
    }
  });
});

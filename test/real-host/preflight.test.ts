import { execFileSync } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { reviewReportOutputSchema } from "../../src/contracts/review.js";
import type { PlainJsonValue } from "../../src/contracts/plain-json.js";
import { detectManagedPolicyPaths, preflightAdapter } from "../../src/dispatch/cli.js";
import { createReviewDispatcher } from "../../src/dispatch/coordinator.js";
import { CliAdapterError } from "../../src/dispatch/cli.js";
import type { DispatchRoute } from "../../src/dispatch/routing.js";
import { createDispatchWorkspace } from "../../src/dispatch/workspace.js";
import { sealDispatchInput, type DispatchEnvelope } from "../../src/review/envelopes.js";
import { REAL_HOST_PROBE_TIMEOUT_MS, REAL_HOST_TEST_TIMEOUT_MS, failedAttemptObserver, realHostsAvailable, requireRealHostsAvailable } from "../helpers/real-host.js";
import { createReviewRepository } from "../helpers/review-repository.js";
import { standaloneReviewFields } from "../helpers/standalone-review-input.js";

/** The standalone review output contract, as `createReviewResponseSchema` hands it to dispatch. */
const reviewSchema = JSON.parse(JSON.stringify(reviewReportOutputSchema.toJSONSchema({ target: "draft-2020-12" }))) as PlainJsonValue;

const REAL_HOSTS_AVAILABLE = realHostsAvailable();
requireRealHostsAvailable(REAL_HOSTS_AVAILABLE);

function command(commandName: string, argv: readonly string[]): string {
  return execFileSync(commandName, [...argv], {
    encoding: "utf8",
    timeout: REAL_HOST_PROBE_TIMEOUT_MS,
    stdio: ["ignore", "pipe", "pipe"],
  }).trim();
}

describe.skipIf(!REAL_HOSTS_AVAILABLE)("real-host preflight", () => {
  it("accepts exact real version and authentication shapes through production preflight", async () => {
    const claudeVersion = command("claude", ["--version"]);
    const codexVersion = command("codex", ["--version"]);
    expect(claudeVersion).toMatch(/^\d+\.\d+\.\d+ \(Claude Code\)$/u);
    expect(codexVersion).toMatch(/^codex-cli \d+\.\d+\.\d+$/u);

    const repositoryRoot = process.cwd();
    const claudeWorkspace = await createDispatchWorkspace("claude-cli", repositoryRoot);
    const codexWorkspace = await createDispatchWorkspace("codex-cli", repositoryRoot);
    try {
      const [claude, codex] = await Promise.all([
        preflightAdapter("claude-cli", claudeWorkspace),
        preflightAdapter("codex-cli", codexWorkspace),
      ]);
      expect(claude).toEqual({
        cli_version: claudeVersion.match(/^(\d+\.\d+\.\d+)/u)![1],
        managed_policy_present: claude.managed_policy_paths.length > 0,
        managed_policy_paths: expect.any(Array),
      });
      expect(codex).toEqual({
        cli_version: codexVersion.match(/^(?:codex-cli )?(\d+\.\d+\.\d+)/u)![1],
        managed_policy_present: codex.managed_policy_paths.length > 0,
        managed_policy_paths: expect.any(Array),
      });
      for (const result of [claude, codex]) {
        expect(new Set(result.managed_policy_paths).size).toBe(result.managed_policy_paths.length);
        expect(result.managed_policy_paths.every((path) => path.startsWith("/"))).toBe(true);
      }
    } finally {
      await Promise.all([claudeWorkspace.dispose(), codexWorkspace.dispose()]);
    }
  }, REAL_HOST_PROBE_TIMEOUT_MS * 4);

  it("reports a synthesized present managed-policy path through production detection", async () => {
    const root = await mkdtemp(join(tmpdir(), "archflow-managed-policy-"));
    const present = join(root, "managed-policy.json");
    const missing = join(root, "missing-policy.json");
    try {
      await writeFile(present, "{}\n");
      await expect(detectManagedPolicyPaths([missing, present])).resolves.toEqual([present]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  }, REAL_HOST_PROBE_TIMEOUT_MS);

  it("never surfaces Claude authentication PII values in a failed attempt's error or diagnostics", async () => {
    const rawAuth = JSON.parse(command("claude", ["auth", "status"])) as Record<string, unknown>;
    expect(rawAuth.loggedIn).toBe(true);
    // The installed CLI no longer echoes account fields from `auth status`; the canaries are the
    // long secret strings of the OAuth credential file the CLI itself authenticates with. The
    // values are read into the scan and never printed.
    const credentialsPath = join(process.env.CLAUDE_CONFIG_DIR ?? join(homedir(), ".claude"), ".credentials.json");
    const credentials = JSON.parse(await readFile(credentialsPath, "utf8")) as {
      claudeAiOauth?: Record<string, unknown>;
    };
    const pii = Object.values(credentials.claudeAiOauth ?? {})
      .filter((value): value is string => typeof value === "string" && value.length >= 16);
    expect(pii.length).toBeGreaterThan(0);

    const repository = await createReviewRepository({ label: "real-preflight-pii" });
    const route: DispatchRoute = {
      adapter: "claude-cli", family: "claude", model: "claude-model-does-not-exist", effort: "high",
    };
    const envelope: DispatchEnvelope = sealDispatchInput("review", {
      ...standaloneReviewFields({ subject: "A local parser rejects malformed JSON before changing state." }),
      assignment: { reviewer_id: "counter-reviewer-1", focus: "general", criterion_ids: ["correctness"] },
      rubric: { schema_version: "1", kind: "implementation", mode: "adversarial", criteria: [{ id: "correctness", text: "Report a concrete correctness defect.", blocking: true }] },
    });
    const observer = failedAttemptObserver();
    try {
      const dispatch = createReviewDispatcher({
        host: "codex",
        repository_root: repository.root,
        signal: new AbortController().signal,
        cancellation_source: "client",
      }, observer.observe);
      await expect(dispatch(route, envelope, reviewSchema)).rejects.toSatisfy((error: unknown) =>
        error instanceof CliAdapterError && error.project_error.code === "PROCESS_FAILED");
      expect(observer.attempts).toHaveLength(1);
      const error = observer.attempts[0]!.error as CliAdapterError;
      const diagnosticBytes = Buffer.from(JSON.stringify({ attempt: { ...observer.attempts[0], error: undefined }, project_error: error.project_error, message: error.message }));
      for (const value of pii) expect(diagnosticBytes.includes(Buffer.from(value))).toBe(false);
    } finally {
      repository.dispose();
    }
  }, REAL_HOST_TEST_TIMEOUT_MS);
});

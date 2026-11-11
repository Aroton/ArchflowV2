import { randomUUID } from "node:crypto";
import { afterAll, describe, expect, it } from "vitest";
import { canonicalJsonDigest } from "../../src/contracts/canonical.js";
import { parseRubricV1 } from "../../src/contracts/rubric.js";
import { createReviewDispatcher } from "../../src/dispatch/coordinator.js";
import { serializeDispatchAll } from "../../src/dispatch/cli.js";
import type { DispatchRoute } from "../../src/dispatch/routing.js";
import { shareRepositoryViewWorkspace, projectRepositoryWorkspaceBinding, type DispatchRepositoryViewPlan, type ReviewProjectionPlan } from "../../src/dispatch/workspace.js";
import { sealDispatchInput } from "../../src/review/envelopes.js";
import { dispatchInputRecord } from "../../src/review/inputs.js";
import { reviewAssignment } from "../../src/review/rubrics.js";
import { standaloneReviewFields } from "../helpers/standalone-review-input.js";
import { cleanupTemporaryRepositories, createTempRepository } from "../helpers/temp-repository.js";
import { REAL_HOST_TEST_TIMEOUT_MS, realHostsAvailable, requireRealHostsAvailable } from "../helpers/real-host.js";

const available = realHostsAvailable();
requireRealHostsAvailable(available);
const bytes = (text: string) => new TextEncoder().encode(text);
const routes: DispatchRoute[] = [
  { adapter: "antigravity-cli", family: "gemini", model: "gemini-3.7-flash-high", effort: "high" },
  { adapter: "claude-cli", family: "claude", model: "claude-fable-5", effort: "medium" },
  { adapter: "codex-cli", family: "codex", model: "gpt-5.6-sol", effort: "medium" },
];
afterAll(cleanupTemporaryRepositories);

describe.skipIf(!available)("real reviewer filesystem access", () => {
  it.each(routes)("reads a source-only value from the repository view through $adapter", async route => {
    const repository = createTempRepository({ label: "real-review-source" });
    // The random value never appears in the envelope; the reviewer can learn it only by reading
    // the file from its repository view.
    const sourceToken = randomUUID();
    repository.write("context.ts", `export const sourceToken = "${sourceToken}";\n`);
    repository.write("changed.ts", `export const previousToken = "${randomUUID()}";\n`);
    repository.commitAll("review baseline");
    const projection = { entries: [{ path: "changed.ts", desired: {
      state: "present", file_type: "regular", mode: "100644", bytes: bytes('export const enabled = true;\n'),
    } }], collisions: [], collision_choices: ["discard-and-restore", "adopt-as-new-generation", "abort"] } as unknown as ReviewProjectionPlan;
    const repositories: DispatchRepositoryViewPlan = [{ name: "primary", member_kind: "primary",
      repository_root: repository.path, repository_identity_digest: canonicalJsonDigest({ repository: "probe" }),
      commit: repository.git("rev-parse", "HEAD") as never, projection_plan: projection,
      snapshot_digest: canonicalJsonDigest({ snapshot: "probe" }),
    }];
    const shared = shareRepositoryViewWorkspace(repositories, repository.path);
    try {
      const rubric = parseRubricV1({ schema_version: "1", kind: "implementation", mode: "adversarial",
        criteria: [{ id: "file-access", text: "Verify filesystem access by quoting the requested exact values; report any access failure honestly.", blocking: true }] });
      const envelope = sealDispatchInput("review", {
        ...standaloneReviewFields({
          subject: "This is a filesystem-access acceptance test. Read context.ts from the repository view. In your report quote the exact sourceToken string from context.ts. The value is not supplied here. You must read the file; if tools or access are unavailable, explicitly report that failure. Do not infer values from metadata.",
          paths: ["changed.ts"],
          workspace: projectRepositoryWorkspaceBinding(repositories),
        }),
        assignment: reviewAssignment("counter-reviewer-1", "general", "phase-impl", rubric),
        rubric,
      });
      const prompt = new TextDecoder().decode(envelope.bytes);
      expect(prompt).not.toContain(sourceToken);
      const dispatch = createReviewDispatcher({ host: route.family === "claude" ? "codex" : "claude",
        repository_root: repository.path, signal: new AbortController().signal, cancellation_source: "client", shared_workspace: shared });
      const [result] = await serializeDispatchAll([() => dispatch(route, envelope, dispatchInputRecord(envelope).response_schema!)]);
      const report = new TextDecoder().decode(result!.extracted_output_bytes);
      console.info(`[real-host] ${route.adapter} ${route.model} CLI ${result!.cli_version}: ${report}`);
      expect(report, "reviewer must read unchanged source").toContain(sourceToken);
    } finally {
      await shared.dispose();
    }
  }, REAL_HOST_TEST_TIMEOUT_MS);
});

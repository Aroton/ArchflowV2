import { randomUUID } from "node:crypto";
import { afterAll, describe, expect, it } from "vitest";
import reviewSchema from "../../src/contracts/schemas/v1/review.schema.json" with { type: "json" };
import { canonicalJsonDigest } from "../../src/contracts/canonical.js";
import type { PlainJsonValue } from "../../src/contracts/plain-json.js";
import { parsePhaseInstanceId } from "../../src/contracts/phase-instance.js";
import { parseRubricV1 } from "../../src/contracts/rubric.js";
import { createDispatchCoordinator } from "../../src/dispatch/coordinator.js";
import { serializeDispatch } from "../../src/dispatch/cli.js";
import type { DispatchRoute } from "../../src/dispatch/routing.js";
import { shareRepositoryViewWorkspace, projectRepositoryWorkspaceBinding, type DispatchRepositoryViewPlan } from "../../src/dispatch/workspace.js";
import { createGitRunner } from "../../src/repository/git.js";
import { discoverWorktree } from "../../src/repository/identity.js";
import { prepareReviewDiffs } from "../../src/review/diffs.js";
import { buildReviewEnvelope } from "../../src/review/envelopes.js";
import { reviewAssignment } from "../../src/review/rubrics.js";
import type { ProjectionPlan } from "../../src/state/snapshots.js";
import { createTaskWorkspace } from "../helpers/task-workspace.js";
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
  it.each(routes)("reads source-only and deleted patch-only values through $adapter", async route => {
    const task = await createTaskWorkspace({ taskId: "real-file-access", label: "real-file-access" });
    const repository = createTempRepository({ label: "real-review-source" });
    // Random values never appear in the envelope. The deleted value exists only in the patch;
    // the unchanged source value is absent from the patch. Both reads are required to pass.
    const sourceToken = randomUUID();
    const patchToken = randomUUID();
    repository.write("context.ts", `export const sourceToken = "${sourceToken}";\n`);
    repository.write("changed.ts", `export const previousToken = "${patchToken}";\n`);
    repository.commitAll("review baseline");
    const projection = { entries: [{ path: "changed.ts", desired: {
      state: "present", file_type: "regular", mode: "100644", bytes: bytes('export const enabled = true;\n'),
    } }], collisions: [], collision_choices: ["discard-and-restore", "adopt-as-new-generation", "abort"] } as unknown as ProjectionPlan;
    const repositories: DispatchRepositoryViewPlan = [{ name: "primary", member_kind: "primary",
      repository_root: repository.path, repository_identity_digest: canonicalJsonDigest({ repository: "probe" }),
      commit: repository.git("rev-parse", "HEAD") as never, projection_plan: projection,
      snapshot_digest: canonicalJsonDigest({ snapshot: "probe" }),
    }];
    const shared = shareRepositoryViewWorkspace(repositories, repository.path);
    try {
      const discovered = await discoverWorktree(createGitRunner({ cwd: repository.path }), task.services.authority.context);
      if (!discovered.ok) throw new Error(discovered.error.code);
      const subjectDigest = canonicalJsonDigest({ subject: randomUUID() });
      const prepared = await prepareReviewDiffs({
        workspace: await shared.acquire(), repositories, runners: new Map([["primary", discovered.value]]),
        subject: { artifact_digest: subjectDigest, artifact: { artifact_kind: "implementation-output" } } as never,
        state: { task_id: task.taskId, phase_instance: "phase-impl-1", authoritative_results: [] } as never,
        dependencies: {}, signal: new AbortController().signal,
      });
      const rubric = parseRubricV1({ schema_version: "1", kind: "implementation", mode: "adversarial",
        criteria: [{ id: "file-access", text: "Verify filesystem access by quoting the requested exact values; report any access failure honestly.", blocking: true }] });
      // Exercise the file-only fallback: inline text would bypass the access being tested.
      const patch = prepared.full.patch;
      const stat = prepared.full.stat;
      const envelope = buildReviewEnvelope({
        artifact: "This is a filesystem-access acceptance test. Read context.ts from the repository view and the complete patch at diffs.full.patch.path. In your report quote the exact sourceToken string from context.ts and the exact deleted previousToken string from the patch. Neither value is supplied here. You must read both files; if tools or access are unavailable, explicitly report that failure. Also read diffs.full.stat.path and name the changed file. Do not infer values from metadata.",
        diffs: { full: { ...prepared.full, patch, stat } }, context: [], rubric,
        assignment: reviewAssignment("general", "general", "phase-impl", rubric, { expected_upstream_digests: [] }),
        workspace: projectRepositoryWorkspaceBinding(repositories),
        subject: { task_id: task.taskId, phase_instance: parsePhaseInstanceId("phase-impl-1"),
          role: "counter-review", step: "counter_review", attempt: 1,
          subject_digest: subjectDigest, input_fingerprint: canonicalJsonDigest({ input: "probe" }),
          rubric_digest: canonicalJsonDigest(rubric as unknown as PlainJsonValue), producer_family: route.family === "claude" ? "codex" : "claude",
          invocation_id: "file-access-invocation", result_id: "file-access-result" } as never,
      });
      const prompt = new TextDecoder().decode(envelope.bytes);
      expect(prompt).not.toContain(sourceToken);
      expect(prompt).not.toContain(patchToken);
      const dispatch = createDispatchCoordinator({ authority: task.services.authority,
        dependencies: task.services.dependencies, host: route.family === "claude" ? "codex" : "claude",
        repository_root: repository.path, phase_instance: parsePhaseInstanceId("phase-impl-1"),
        signal: new AbortController().signal, cancellation_source: "client", shared_workspace: shared });
      const result = await serializeDispatch(() => dispatch(route, envelope, reviewSchema));
      const report = new TextDecoder().decode(result.extracted_output_bytes);
      console.info(`[real-host] ${route.adapter} ${route.model} CLI ${result.cli_version}: ${report}`);
      expect(report, "reviewer must read unchanged source").toContain(sourceToken);
      expect(report, "reviewer must read deleted patch content").toContain(patchToken);
    } finally {
      await shared.dispose();
      task.dispose();
    }
  }, REAL_HOST_TEST_TIMEOUT_MS);
});

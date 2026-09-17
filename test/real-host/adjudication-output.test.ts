import { randomUUID } from "node:crypto";
import { afterAll, describe, expect, it } from "vitest";
import { createRawAdjudicationV2Schema, parseRawAdjudicationV2 } from "../../src/contracts/adjudication.js";
import { judgmentSlots } from "../helpers/antigravity-output.js";
import { canonicalJsonDigest } from "../../src/contracts/canonical.js";
import type { PlainJsonValue } from "../../src/contracts/plain-json.js";
import { parsePhaseInstanceId } from "../../src/contracts/phase-instance.js";
import { createDispatchCoordinator } from "../../src/dispatch/coordinator.js";
import { serializeDispatch } from "../../src/dispatch/cli.js";
import type { DispatchRoute } from "../../src/dispatch/routing.js";
import { shareRepositoryViewWorkspace, projectRepositoryWorkspaceBinding, type DispatchRepositoryViewPlan } from "../../src/dispatch/workspace.js";
import { createGitRunner } from "../../src/repository/git.js";
import { discoverWorktree } from "../../src/repository/identity.js";
import { prepareReviewDiffs } from "../../src/review/diffs.js";
import { buildAdjudicationEnvelope } from "../../src/review/envelopes.js";
import type { ProjectionPlan } from "../../src/state/snapshots.js";
import { createTaskWorkspace } from "../helpers/task-workspace.js";
import { cleanupTemporaryRepositories, createTempRepository } from "../helpers/temp-repository.js";
import { REAL_HOST_TEST_TIMEOUT_MS, realHostsEnabled } from "../helpers/real-host.js";

const available = realHostsEnabled();
const bytes = (text: string) => new TextEncoder().encode(text);
const route: DispatchRoute = {
  adapter: "antigravity-cli", family: "gemini", model: "gemini-3.8-flash-high", effort: "high",
};
afterAll(cleanupTemporaryRepositories);

describe.skipIf(!available)("real Gemini adjudication output", () => {
  it("returns ten valid judgments after reading source and complete diff files", async () => {
    const task = await createTaskWorkspace({ taskId: "real-adjudication-output", label: "real-adjudication-output" });
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
      const reviewDigest = canonicalJsonDigest({ review: "synthetic" });
      // Exercise the file-only fallback: inline text would bypass the access being tested.
      const patch = prepared.full.patch;
      const stat = prepared.full.stat;
      const envelope = buildAdjudicationEnvelope({
        artifact: "This is a filesystem-access acceptance test. Read context.ts from the repository view and the complete patch at diffs.full.patch.path. In your judgment rationales quote the exact sourceToken string from context.ts and the exact deleted previousToken string from the patch. Neither value is supplied here. You must read both files; if tools or access are unavailable, explicitly report that failure. Also read diffs.full.stat.path and name the changed file. Do not infer values from metadata.",
        diffs: { full: { ...prepared.full, patch, stat } },
        source_review_envelope_digest: reviewDigest,
        rules: judgmentSlots.map(({ slot }) => ({ slot,
          text: "For this synthetic test, verify that the supplied patch replaces previousToken with enabled=true. Include the source and deleted patch values in your rationale; return uncertain if either cannot be read.",
          enforced_by: [],
        })),
        workspace: projectRepositoryWorkspaceBinding(repositories),
        subject: { task_id: task.taskId, phase_instance: parsePhaseInstanceId("phase-impl-1"),
          role: "adjudication", step: "adjudicate",
          subject_digest: subjectDigest, input_fingerprint: canonicalJsonDigest({ input: "probe" }),
          pinned_constitution_digest: canonicalJsonDigest({ rules: judgmentSlots }), source_review_envelope_digest: reviewDigest,
          invocation_id: "adjudication-invocation", result_id: "adjudication-result" },
      });
      const prompt = new TextDecoder().decode(envelope.bytes);
      expect(prompt).not.toContain(sourceToken);
      expect(prompt).not.toContain(patchToken);
      const dispatch = createDispatchCoordinator({ authority: task.services.authority,
        dependencies: task.services.dependencies, host: "claude",
        repository_root: repository.path, phase_instance: parsePhaseInstanceId("phase-impl-1"),
        signal: new AbortController().signal, cancellation_source: "client", shared_workspace: shared });
      const schema = JSON.parse(JSON.stringify(createRawAdjudicationV2Schema(judgmentSlots)
        .toJSONSchema({ target: "draft-2020-12" }))) as PlainJsonValue;
      const result = await serializeDispatch(() => dispatch(route, envelope, schema));
      const report = new TextDecoder().decode(result.extracted_output_bytes);
      console.info(`[real-host] ${route.adapter} ${route.model} CLI ${result.cli_version}: received ${result.extracted_output_bytes.byteLength} bytes`);
      const judgments = parseRawAdjudicationV2(JSON.parse(report), judgmentSlots);
      expect(Object.keys(judgments.judgments)).toHaveLength(10);
      expect(report, "reviewer must read unchanged source").toContain(sourceToken);
      expect(report, "reviewer must read deleted patch content").toContain(patchToken);
    } finally {
      await shared.dispose();
      task.dispose();
    }
  }, REAL_HOST_TEST_TIMEOUT_MS);
});

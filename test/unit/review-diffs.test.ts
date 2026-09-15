import { readFile, lstat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { sha256Bytes } from "../../src/contracts/canonical.js";
import { createDispatchWorkspace, materializeRepositoryViews, type DispatchRepositoryViewPlan, type DispatchWorkspace } from "../../src/dispatch/workspace.js";
import { createGitRunner } from "../../src/repository/git.js";
import { discoverWorktree } from "../../src/repository/identity.js";
import { selectCliAdapter } from "../../src/dispatch/cli.js";
import type { DispatchRoute } from "../../src/dispatch/routing.js";
import reviewSchema from "../../src/contracts/schemas/v1/review.schema.json" with { type: "json" };
import { prepareImplementationDiffs } from "../../src/review/diffs.js";
import { buildReviewEnvelope } from "../../src/review/envelopes.js";
import type { ProjectionDesired, ProjectionPlan } from "../../src/state/snapshots.js";
import { cleanupTemporaryRepositories, createTempRepository } from "../helpers/temp-repository.js";

const bytes = (value: string) => new TextEncoder().encode(value);
const digest = (value: string) => sha256Bytes(bytes(value));
const present = (value: string): ProjectionDesired => ({ state: "present", file_type: "regular", mode: "100644", bytes: bytes(value) });
const plan = (files: Record<string, ProjectionDesired>): ProjectionPlan => ({
  entries: Object.entries(files).map(([path, desired]) => ({ path, desired })), collisions: [], collision_choices: ["discard-and-restore", "adopt-as-new-generation", "abort"],
}) as unknown as ProjectionPlan;
const workspaces: DispatchWorkspace[] = [];
afterEach(async () => { await Promise.all(workspaces.splice(0).map(workspace => workspace.dispose())); cleanupTemporaryRepositories(); });

async function fixture(changes: Record<string, ProjectionDesired>, before: Record<string, string> = {}) {
  const repository = createTempRepository({ label: "review-diffs", attributes: undefined });
  for (const [path, value] of Object.entries(before)) repository.write(path, value);
  repository.write("unrelated.txt", "baseline context\n");
  repository.commitAll("baseline");
  const commit = repository.git("rev-parse", "HEAD");
  const discovered = await discoverWorktree(createGitRunner({ cwd: repository.path }), {
    task_id: "diff-test", phase_instance: "phase-impl-1", operation: "diff-test", attempt: 1,
  } as never);
  if (!discovered.ok) throw new Error(discovered.error.code);
  const projection = plan(changes);
  const repositories: DispatchRepositoryViewPlan = [{ name: "primary", member_kind: "primary", repository_root: repository.path,
    repository_identity_digest: digest("repository"), commit: commit as never, projection_plan: projection, snapshot_digest: digest("snapshot") }];
  const workspace = await materializeRepositoryViews(await createDispatchWorkspace("codex-cli", repository.path), repositories);
  workspaces.push(workspace);
  const input: Parameters<typeof prepareImplementationDiffs>[0] = {
    workspace, repositories, runners: new Map([["primary", discovered.value]]),
    subject: { artifact_digest: digest("current"), artifact: { artifact_kind: "implementation-output" } } as never,
    state: { task_id: "diff-test", phase_instance: "phase-impl-1", authoritative_results: [] } as never,
    dependencies: {}, signal: new AbortController().signal,
  };
  const read = (path: string) => readFile(join(workspace.repository_view_root!, path), "utf8");
  return { input, read, repository, commit, projection };
}

describe("implementation review diff files", () => {
  it("shows complete Git changes, excludes every .archflow output, and ignores live drift", async () => {
    const h = await fixture({
      "src/change.ts": present("after\n"), "src/delete.ts": { state: "absent" },
      "src/add space.ts": present("new content\n"), "src/[literal].ts": present("literal after\n"), "src/old.ts": { state: "absent" }, "src/renamed.ts": present("rename identity\n"),
      "run.sh": { ...present("#!/bin/sh\n"), mode: "100755" } as ProjectionDesired,
      "link": { state: "present", file_type: "symlink", mode: "120000", bytes: bytes("src/change.ts") },
      "binary.dat": { ...present("a\0b"), bytes: new Uint8Array([0, 1, 2]) } as ProjectionDesired,
      ".archflow/tasks/diff-test/prd.md": present("PRIVATE NEW\n"),
      ".archflow/constitution/rule.md": { state: "absent" },
    }, { "src/change.ts": "before\n", "src/[literal].ts": "literal before\n", "src/delete.ts": "deleted content\n", "src/old.ts": "rename identity\n", "run.sh": "#!/bin/sh\n",
      ".archflow/tasks/diff-test/prd.md": "PRIVATE OLD\n", ".archflow/constitution/rule.md": "PRIVATE RULE\n" });
    h.repository.write("src/change.ts", "unreviewed live drift\n");
    const result = await prepareImplementationDiffs(h.input);
    const patch = await h.read(result.full.patch.path);
    expect(patch).toContain("-before\n+after");
    expect(patch).toContain("-literal before\n+literal after");
    expect(patch).toContain("-deleted content");
    expect(patch).toContain("+new content");
    expect(patch).toContain("rename from");
    expect(patch).toContain("old mode 100644\nnew mode 100755");
    expect(patch).toContain("new file mode 120000");
    expect(patch).toContain("Binary files");
    expect(patch).not.toMatch(/PRIVATE|\.archflow|unreviewed live drift|unrelated.txt/);
    expect(result.full.patch.byte_count).toBe(Buffer.byteLength(patch));
    expect(result.full.patch.content_digest).toBe(sha256Bytes(bytes(patch)));
    expect((await lstat(join(h.input.workspace.repository_view_root!, result.full.patch.path))).mode & 0o222).toBe(0);
  });

  it.each<DispatchRoute>([
    { adapter: "claude-cli", family: "claude", model: "claude-opus-4-6", effort: "high" },
    { adapter: "claude-cli", family: "claude", model: "claude-opus-4-6", effort: "high", provider: "test-provider" },
    { adapter: "codex-cli", family: "codex", model: "gpt-5.4", effort: "high" },
    { adapter: "antigravity-cli", family: "gemini", model: "gemini-3.7-flash-high", effort: "high" },
  ])("delivers a complete large diff and source view through $adapter ($provider)", async route => {
    const text = `${"a substantive changed line with enough content for a large patch\n".repeat(24_000)}FINAL PATCH LINE\n`;
    const h = await fixture({ "large.txt": present(text) });
    const result = await prepareImplementationDiffs(h.input);
    expect(result.full.patch.byte_count).toBeGreaterThan(1_048_576);
    expect(await h.read(result.full.patch.path)).toContain("+FINAL PATCH LINE\n");
    const envelope = buildReviewEnvelope({ artifact: "implementation metadata", diffs: { full: result.full }, context: [],
      rubric: { schema_version: "1", kind: "implementation", mode: "adversarial", criteria: [{ id: "correctness", text: "Review behavior", blocking: true }] },
      subject: { task_id: "diff-test", phase_instance: "phase-impl-1", role: "counter-review", step: "counter_review", attempt: 1,
        subject_digest: h.input.subject.artifact_digest, input_fingerprint: digest("input"), rubric_digest: digest("rubric"),
        producer_family: "claude", invocation_id: "invocation-1", result_id: "result-1" },
    } as never);
    expect(envelope.byte_count).toBeLessThan(10_000);
    expect(new TextDecoder().decode(envelope.bytes)).not.toContain("FINAL PATCH LINE");

    const invocation = await selectCliAdapter("codex", route).buildInvocation(
      envelope, route, h.input.workspace, reviewSchema,
    );
    const stdin = new TextDecoder().decode(invocation.stdin);
    const delivered = JSON.parse(route.adapter === "antigravity-cli" ? JSON.parse(stdin).message.content : stdin);
    expect(delivered.diffs).toEqual({ full: result.full });
    expect(delivered.instructions.changes).toContain("complete patch");
    const childRoot = route.adapter === "codex-cli"
      ? invocation.argv[invocation.argv.indexOf("-C") + 1]!
      : invocation.cwd;
    expect(childRoot).toBe(h.input.workspace.repository_view_root);
    // Resolve only paths actually delivered to the child, from its actual working directory.
    // A valid descriptor in a parent envelope is insufficient if the child cannot locate it.
    for (const kind of ["patch", "stat"] as const) {
      const descriptor = delivered.diffs.full[kind];
      const content = await readFile(join(childRoot, descriptor.path));
      expect(content.byteLength).toBe(descriptor.byte_count);
      expect(sha256Bytes(content)).toBe(descriptor.content_digest);
      expect(content.toString()).toContain(kind === "patch" ? "+FINAL PATCH LINE\n" : "large.txt");
    }
    expect(await readFile(join(childRoot, "large.txt"), "utf8")).toBe(text);
    if (route.adapter === "claude-cli") {
      expect(invocation.argv[invocation.argv.indexOf("--tools") + 1]).toBe("Read,Grep,Glob");
      if (route.provider !== undefined) expect(invocation.command).toBe("cc-switch");
    }
    if (route.adapter === "codex-cli") {
      expect(invocation.argv[invocation.argv.indexOf("-s") + 1]).toBe("read-only");
    }
  });

  it("uses each selected reviewer's last subject, including a skipped round and reverted output", async () => {
    const h = await fixture({ "change.txt": present("current\n") }, { "change.txt": "baseline\n", "reverted.txt": "original\n" });
    const first = digest("first"), second = digest("second");
    const refs = [first, second].map((value, i) => ({ phase_instance: "phase-impl-1", step: "produce", result_digest: value, result_id: `result-${i}`, input_fingerprint: digest("input") }));
    const oldPlans = new Map([[first, plan({ "change.txt": present("first\n"), "reverted.txt": present("temporary\n") })],
      [second, plan({ "change.txt": present("second\n") })]]);
    const output = await prepareImplementationDiffs({ ...h.input,
      state: { ...h.input.state, superseded_production_results: refs } as never,
      prior_triage: { response: { decision: "revise", rationale: "Fix issues", reviewers: [{ reviewer_id: "general", request: "Check fix" }, { reviewer_id: "test", request: "Check tests" }] },
        source_review: { evidence: { schema_version: "4", previous_reports: [{ reviewer_id: "general", subject_digest: first }], reports: [{ reviewer_id: "test", subject_digest: second }] } } } as never,
      dependencies: {
        load_retained_manifest: async ref => ({ ok: true, value: { manifest: { value: { artifact_digest: ref.result_digest } } } }) as never,
        load_retained_result: async ref => ({ ok: true, value: { prepared: { manifest: { value: { source_artifact: {
          artifact_kind: "implementation-output", task_id: "diff-test", phase_instance: "phase-impl-1", base_commit: h.commit,
        } } } }, projection_plan: oldPlans.get(ref.result_digest) } }) as never,
      },
    });
    const general = output.reviewers.get("general")!.revision!;
    const tests = output.reviewers.get("test")!.revision!;
    expect(general.base_subject_digest).toBe(first);
    expect(tests.base_subject_digest).toBe(second);
    expect(await h.read(general.patch.path)).toContain("-first\n+current");
    expect(await h.read(general.patch.path)).toContain("-temporary\n+original");
    expect(await h.read(tests.patch.path)).toContain("-second\n+current");
    expect(await h.read(tests.patch.path)).not.toContain("reverted.txt");
    expect(await h.read(output.full.patch.path)).toContain("-baseline\n+current");
  });

  it("qualifies multiple repository patches and omits secondary workflow state", async () => {
    const h = await fixture({ "same.ts": present("primary change\n") });
    const secondary = createTempRepository({ label: "review-secondary", attributes: undefined });
    secondary.write("same.ts", "secondary baseline\n");
    secondary.commitAll("secondary baseline");
    const discovered = await discoverWorktree(createGitRunner({ cwd: secondary.path }), {
      task_id: "diff-test", phase_instance: "phase-impl-1", operation: "diff-test", attempt: 1,
    } as never);
    if (!discovered.ok) throw new Error(discovered.error.code);
    const repositories: DispatchRepositoryViewPlan = [...h.input.repositories, {
      name: "api" as never, member_kind: "secondary", repository_root: secondary.path,
      repository_identity_digest: digest("secondary"), commit: secondary.git("rev-parse", "HEAD") as never,
      snapshot_digest: digest("secondary-snapshot"), projection_plan: plan({
        "same.ts": present("secondary change\n"), ".archflow/tasks/other/prd.md": present("OTHER TASK\n"),
      }),
    }];
    const workspace = await materializeRepositoryViews(await createDispatchWorkspace("codex-cli", h.repository.path), repositories);
    workspaces.push(workspace);
    const output = await prepareImplementationDiffs({ ...h.input, workspace, repositories,
      runners: new Map([...h.input.runners, ["api", discovered.value]]) });
    const patch = await readFile(join(workspace.repository_view_root!, output.full.patch.path), "utf8");
    expect(patch).toContain("b/primary/same.ts");
    expect(patch).toContain("b/api/same.ts");
    expect(patch).toContain("-secondary baseline\n+secondary change");
    expect(patch).not.toMatch(/OTHER TASK|\.archflow/);
    expect(output.full.patch.path).toBe("../review-diffs/full.patch");
  });

  it("reports a full-diff preparation failure without returning partial descriptors", async () => {
    const h = await fixture({ "source.ts": present("new code\n") });
    await writeFile(join(h.input.workspace.root, "review-diffs"), "occupied");
    await expect(prepareImplementationDiffs(h.input)).rejects.toMatchObject({
      code: "IO_ERROR", diagnostic: { parameters: { operation: "review-diff-generation" } },
    });
  });

  it("reports an unavailable historical baseline and supplies an empty full diff when only workflow files changed", async () => {
    const h = await fixture({ ".archflow/tasks/diff-test/prd.md": present("private\n") });
    const output = await prepareImplementationDiffs({ ...h.input, prior_triage: {
      response: { decision: "revise", rationale: "Recheck", reviewers: [{ reviewer_id: "general", request: "Check" }] },
    } as never });
    expect(await h.read(output.full.patch.path)).toBe("");
    expect(output.reviewers.get("general")).toMatchObject({ full: output.full, revision_unavailable: expect.any(String) });
    expect(output.reviewers.get("general")).not.toHaveProperty("revision");
  });
});

import { execFileSync } from "node:child_process";
import { mkdtemp, mkdir, readFile, readdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { connectionContextFactory, createInvocationContext } from "../../src/contracts/contexts.js";
import { parseSimpleReviewInput, type SimpleReviewInput } from "../../src/contracts/simple-review.js";
import { createProjectError } from "../../src/contracts/errors.js";
import { CliAdapterError } from "../../src/dispatch/cli.js";
import { runSimpleReview, type SimpleReviewDependencies } from "../../src/review/simple-review.js";
import { captureSimpleContext, loadSimplePolicy } from "../../src/review/simple-context.js";
import { shareRepositoryViewWorkspace } from "../../src/dispatch/workspace.js";
import { createToolBoundary } from "../../src/mcp/server.js";

const roots: string[] = [];
const git = (root: string, ...args: string[]) => execFileSync("git", ["-C", root, ...args], {
  encoding: "utf8", env: { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_SYSTEM: "/dev/null",
    GIT_AUTHOR_NAME: "Test", GIT_AUTHOR_EMAIL: "test@example.invalid", GIT_COMMITTER_NAME: "Test", GIT_COMMITTER_EMAIL: "test@example.invalid" },
}).trim();
async function repo() {
  const root = await mkdtemp(join(tmpdir(), "archflow-simple-test-")); roots.push(root);
  git(root, "init", "-q");
  await writeFile(join(root, "app.txt"), "before\n");
  await writeFile(join(root, "deleted.txt"), "remove me\n");
  git(root, "add", "."); git(root, "commit", "-qm", "base");
  const base_commit = git(root, "rev-parse", "HEAD");
  const controller = new AbortController();
  const connection = connectionContextFactory.captureStartup({ connection_id: "simple-test", startup_repository_candidate: { working_directory: root } })
    .initialize({ client: { name: "codex", version: "test" }, host: "codex", protocol_version: "2025-11-25" });
  const context = createInvocationContext(connection, { invocation_id: "simple-test", transport_metadata: { request_id: "test", operation: "tools/call" } }, controller.signal);
  const input: SimpleReviewInput = { schema_version: "1", stage: "plan", ask: "Update app", plan: "Update app and test it", base_commit, paths: ["app.txt"] };
  return { root, input, context, controller };
}
function fakeDispatch(calls: Array<{ role: string; envelope: Record<string, any>; route: any }>, change?: (role: string, body: any) => unknown): NonNullable<SimpleReviewDependencies["dispatch"]> {
  return async (route, envelope) => {
    const body = JSON.parse(new TextDecoder().decode(envelope.bytes));
    const role = envelope.result_kind === "adjudication" ? "adjudicator" : body.assignment.focus === "tests" ? "test-reviewer" : "counter-reviewer";
    calls.push({ role, envelope: body, route });
    const override = change?.(role, body);
    const result = override ?? (role === "adjudicator" ? { schema_version: "2", judgments: Object.fromEntries(body.rules.map((rule: any) => [rule.slot, {
      compliance: "pass", rationale: "No policy issue.", trigger: "not-matched", trigger_evidence: "No trigger evidence.",
    }])) } : { report: "Fix the concrete issue in the declared output." });
    return { cli_version: "test", extracted_output_bytes: new TextEncoder().encode(JSON.stringify(result)) };
  };
}
afterEach(async () => { await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))); });

describe("standalone simple review", () => {
  it("runs each role once at both stages without initialization, effort advice, or workflow state", async () => {
    const { root, input, context } = await repo();
    const calls: Parameters<typeof fakeDispatch>[0] = [];
    const dependencies = { dispatch: fakeDispatch(calls) };
    const plan = await runSimpleReview(input, context, dependencies);
    expect(plan.ok, JSON.stringify(plan)).toBe(true);
    expect(calls.map((call) => call.role)).toEqual(["counter-reviewer", "test-reviewer", "adjudicator"]);
    expect(calls[0]!.route.model).toBe("claude-fable-5-1");
    expect(calls[0]!.envelope.rubric.criteria.some((criterion: any) => criterion.id === "phase-plan-soundness")).toBe(false);
    expect(calls[1]!.envelope.assignment.criterion_ids).toEqual(["test-strategy"]);
    await writeFile(join(root, "app.txt"), "after plan fixes\n");
    const implementation = await runSimpleReview({ ...input, stage: "implementation", plan: "Corrected plan", verification: "Relevant check passed",
      expected_policy_digest: plan.value!.policy_digest }, context, dependencies);
    expect(implementation.ok, JSON.stringify(implementation)).toBe(true);
    expect(calls).toHaveLength(6);
    expect(calls[4]!.envelope.assignment.criterion_ids).toEqual(["verification-evidence", "test-quality"]);
    expect(await readdir(root)).not.toContain(".archflow");
    expect(JSON.stringify(implementation)).not.toMatch(/next_action|implementation_recommendation|task_id|phase_instance/);
    expect(git(root, "rev-parse", "HEAD")).toBe(input.base_commit);
  });

  it("captures additions, deletions and pre-existing edits in disposable baseline/current views", async () => {
    const { root, input, context } = await repo();
    await writeFile(join(root, "new.txt"), "added\n");
    await rm(join(root, "deleted.txt"));
    await writeFile(join(root, "app.txt"), "pre-existing edit\n");
    const captured = await captureSimpleContext(root, { ...input, paths: ["new.txt", "deleted.txt"] }, context.signal);
    const shared = shareRepositoryViewWorkspace(captured.views, root);
    let workspaceRoot = "";
    try {
      const workspace = await shared.acquire(); workspaceRoot = workspace.root;
      const primary = join(workspace.root, "repos", "primary");
      const baseline = join(workspace.root, "repos", "baseline");
      expect(await readFile(join(primary, "new.txt"), "utf8")).toBe("added\n");
      expect(await readFile(join(primary, "app.txt"), "utf8")).toBe("pre-existing edit\n");
      await expect(readFile(join(primary, "deleted.txt"))).rejects.toMatchObject({ code: "ENOENT" });
      expect(await readFile(join(baseline, "app.txt"), "utf8")).toBe("before\n");
      expect(await readFile(join(baseline, "deleted.txt"), "utf8")).toBe("remove me\n");
    } finally { await shared.dispose(); }
    await expect(readdir(workspaceRoot)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("honors route declarations and custom constitution plus path triggers without gates", async () => {
    const { root, input, context } = await repo();
    await mkdir(join(root, ".archflow/constitution/custom"), { recursive: true });
    await writeFile(join(root, ".archflow/constitution/custom/10-custom.md"), "---\nid: custom-review\nversion: 1\nstatus: active\nreview_trigger: The app changes.\n---\nRequire a person for app changes.\n");
    await writeFile(join(root, ".archflow/config.yaml"), "schema_version: '1'\nroles:\n  counter-reviewer: {model: gpt-6-astra, effort: low}\n  adjudicator: {model: gpt-6-astra, effort: low}\napproval_rules:\n  subjects: []\n  content:\n    - paths: ['app.txt']\n");
    const calls: Parameters<typeof fakeDispatch>[0] = [];
    const result = await runSimpleReview({ ...input, review_routes: { "counter-reviewer": { model: "gpt-5.6-sol", effort: "medium" } } }, context, {
      dispatch: fakeDispatch(calls, (role, body) => role === "adjudicator" ? { schema_version: "2", judgments: { [body.rules[0].slot]: {
        compliance: "pass", rationale: "Needs user decision.", trigger: "matched", trigger_evidence: "app.txt changes",
      } } } : undefined),
    });
    expect(result.ok, JSON.stringify(result)).toBe(true);
    expect(calls[0]!.route.model).toBe("gpt-5.6-sol");
    expect(result.value!.human_review_reasons).toHaveLength(2);
    expect(result.value!.constitution.judgments[0]!.rule_id).toBe("custom-review");
    expect(await readdir(join(root, ".archflow"))).not.toContain("tasks");
  });

  it("returns successful sibling reports and no repeated passes on malformed output", async () => {
    const { input, context } = await repo();
    const calls: Parameters<typeof fakeDispatch>[0] = [];
    const result = await runSimpleReview(input, context, { dispatch: fakeDispatch(calls, (role) => role === "adjudicator" ? { schema_version: "2", judgments: {} } : undefined) });
    expect(result.ok).toBe(false);
    expect(result.error!.code).toBe("REVIEW_INCOMPLETE");
    expect(result.value!.reports).toHaveLength(2);
    expect(result.value!.failures[0]!.code).toBe("MODEL_OUTPUT_INVALID");
    expect(calls).toHaveLength(3);
  });

  it("rejects changed policy before dispatch and changed bytes during review", async () => {
    const { root, input, context } = await repo();
    const calls: Parameters<typeof fakeDispatch>[0] = [];
    const mismatch = await runSimpleReview({ ...input, expected_policy_digest: "a".repeat(64) }, context, { dispatch: fakeDispatch(calls) });
    expect(mismatch.error!.code).toBe("POLICY_CHANGED"); expect(calls).toHaveLength(0);
    const realFake = fakeDispatch(calls);
    const changed = await runSimpleReview(input, context, { dispatch: async (...args) => {
      await writeFile(join(root, "app.txt"), "concurrent edit"); return realFake(...args);
    } });
    expect(changed.error!.code).toBe("SUBJECT_CHANGED");
  });

  it("detects branch switches even when both names point to the same commit", async () => {
    const { root, input, context } = await repo();
    const captured = await captureSimpleContext(root, input, context.signal);
    git(root, "checkout", "-qb", "other");
    await expect(captured.assertCurrent()).rejects.toMatchObject({ code: "SUBJECT_CHANGED" });
  });

  it("rejects invalid existing configuration without defaults or dispatch", async () => {
    const { root, input, context } = await repo();
    await mkdir(join(root, ".archflow"));
    await writeFile(join(root, ".archflow/config.yaml"), "schema_version: invalid\n");
    const calls: Parameters<typeof fakeDispatch>[0] = [];
    const result = await runSimpleReview(input, context, { dispatch: fakeDispatch(calls) });
    expect(result.ok).toBe(false); expect(calls).toHaveLength(0);
  });

  it("supports an explicitly empty constitution without silently restoring shipped rules", async () => {
    const { root, input, context } = await repo();
    await mkdir(join(root, ".archflow/constitution"), { recursive: true });
    expect((await loadSimplePolicy(root)).rules).toEqual([]);
    const calls: Parameters<typeof fakeDispatch>[0] = [];
    const result = await runSimpleReview(input, context, { dispatch: fakeDispatch(calls) });
    expect(result.ok).toBe(true); expect(calls).toHaveLength(2);
    expect(result.value!.constitution.status).toBe("not-applicable");
  });

  it("blocks path traversal, symlink parents, and workflow storage", async () => {
    const { root, input, context } = await repo();
    for (const path of ["../secret", "/tmp/secret", ".git/config", ".archflow/tasks/other/ask.md"]) {
      expect(() => parseSimpleReviewInput({ ...input, paths: [path] })).toThrow();
    }
    await symlink(tmpdir(), join(root, "outside"));
    const result = await runSimpleReview({ ...input, paths: ["outside/secret"] }, context, { dispatch: fakeDispatch([]) });
    expect(result.error!.code).toBe("INPUT_INVALID");
  });

  it("retries classified transport failure only on the failed role and original route", async () => {
    const { input, context } = await repo();
    const calls: Parameters<typeof fakeDispatch>[0] = [];
    const fake = fakeDispatch(calls);
    let attempts = 0;
    const waits: number[] = [];
    const result = await runSimpleReview(input, context, { wait: async (ms) => { waits.push(ms); }, dispatch: async (...args) => {
      const body = JSON.parse(new TextDecoder().decode(args[1].bytes));
      if (body.assignment?.focus === "general" && attempts++ < 2) throw new CliAdapterError(createProjectError("PROCESS_FAILED", { adapter: args[0].adapter, exit_class: "transient-transport" }));
      return fake(...args);
    } });
    expect(result.ok, JSON.stringify(result)).toBe(true);
    expect(waits).toEqual([1000, 4000]); expect(calls).toHaveLength(3); expect(attempts).toBe(3);
  });

  it("does not launch reviews after cancellation", async () => {
    const { input, context, controller } = await repo(); controller.abort();
    const calls: Parameters<typeof fakeDispatch>[0] = [];
    const result = await runSimpleReview(input, context, { dispatch: fakeDispatch(calls) });
    expect(result.error!.code).toBe("CANCELLED"); expect(calls).toHaveLength(0);
  });

  it("validates input and output at the public MCP boundary", async () => {
    const { input, context } = await repo();
    const boundary = createToolBoundary({ archflow_review: async () => ({ schema_version: "1", ok: true }) });
    const badOutput = await boundary.invoke("archflow_review", input, context);
    expect(badOutput.kind).toBe("review-result");
    if (badOutput.kind === "review-result") expect(badOutput.result.error!.code).toBe("INTERNAL_ERROR");
    const badInput = await boundary.invoke("archflow_review", { ...input, stage: "implementation" }, context);
    if (badInput.kind === "review-result") expect(badInput.result.error!.message).toContain("verification");
    else throw new Error("missing public review result");
  });
});

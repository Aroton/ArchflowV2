import { execFileSync } from "node:child_process";
import { mkdtemp, mkdir, readFile, readdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { parseSimpleReviewInput, parseSimpleReviewResult, type SimpleReviewInput } from "../../src/contracts/simple-review.js";
import { createProjectError } from "../../src/contracts/errors.js";
import { CliAdapterError } from "../../src/dispatch/cli.js";
import { runSimpleReview, type SimpleReviewContext, type SimpleReviewDependencies } from "../../src/review/simple-review.js";
import { captureSimpleContext, loadSimplePolicy } from "../../src/review/simple-context.js";
import { shareRepositoryViewWorkspace } from "../../src/dispatch/workspace.js";
import { loadCanonicalRubricForSimpleStage } from "../../src/review/rubrics.js";

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
  const context: SimpleReviewContext = { working_directory: root, host: "codex", signal: controller.signal, invocation_id: "simple-test" };
  const input: SimpleReviewInput = { schema_version: "1", stage: "plan", ask: "Update app", plan: "Update app and test it", base_commit, paths: ["app.txt"] };
  return { root, input, context, controller };
}
function fakeDispatch(calls: Array<{ role: string; envelope: Record<string, any>; route: any }>, change?: (role: string, body: any) => unknown): NonNullable<SimpleReviewDependencies["dispatch"]> {
  return async (route, envelope, schema) => {
    const body = JSON.parse(new TextDecoder().decode(envelope.bytes));
    expect(schema).toEqual(body.response_schema);
    const role = envelope.result_kind === "adjudication" ? "adjudicator" : body.assignment.focus === "tests" ? "test-reviewer" : "counter-reviewer";
    calls.push({ role, envelope: body, route });
    const override = change?.(role, body);
    const result = override ?? (role === "adjudicator" ? { schema_version: "2", judgments: Object.fromEntries(body.rules.map((rule: any) => [rule.slot, {
      compliance: "pass", rationale: "No policy issue.", trigger: "not-matched", trigger_evidence: "No trigger evidence.",
    }])) } : { outcome: "issues_found", feedback: "Fix the concrete issue in the declared output." });
    return { cli_version: "test", extracted_output_bytes: new TextEncoder().encode(JSON.stringify(result)) };
  };
}
afterEach(async () => { await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))); });

describe("standalone simple review", () => {
  it("returns explicit clean feedback and keeps it distinct from failed or ambiguous output", async () => {
    const { input, context } = await repo();
    const clean = await runSimpleReview(input, context, { dispatch: fakeDispatch([], role => role === "adjudicator" ? undefined
      : { outcome: "no_issues_found", feedback: "Reviewed the changes; no actionable issues." }) });
    expect(clean.ok).toBe(true);
    expect(clean.value?.reports.filter(report => report.role !== "adjudicator")).toEqual([
      expect.objectContaining({ outcome: "no_issues_found", feedback: expect.any(String) }),
      expect.objectContaining({ outcome: "no_issues_found", feedback: expect.any(String) }),
    ]);
    for (const invalid of [{ feedback: "Looks good" }, { outcome: "no_issues_found", feedback: " " }, { findings: [] }]) {
      const calls: Parameters<typeof fakeDispatch>[0] = [];
      const result = await runSimpleReview(input, context, { dispatch: fakeDispatch(calls, role => role === "counter-reviewer" ? invalid : undefined) });
      expect(result.ok).toBe(false);
      expect(result.value?.failures).toEqual([expect.objectContaining({ role: "counter-reviewer", code: "MODEL_OUTPUT_INVALID" })]);
      expect(calls.filter(call => call.role === "counter-reviewer")).toHaveLength(1);
    }
  });

  it("runs each role once at both stages without initialization, effort advice, or workflow state", async () => {
    const { root, input, context } = await repo();
    const calls: Parameters<typeof fakeDispatch>[0] = [];
    const dependencies = { dispatch: fakeDispatch(calls) };
    const plan = await runSimpleReview(input, context, dependencies);
    expect(plan.ok, JSON.stringify(plan)).toBe(true);
    expect(calls.map((call) => call.role)).toEqual(["counter-reviewer", "test-reviewer", "adjudicator"]);
    expect(calls[0]!.route.model).toBe("claude-opus-5-5");
    const planRubric = await loadCanonicalRubricForSimpleStage("plan");
    if (!planRubric.ok) throw planRubric.error;
    expect(planRubric.value.rubric_id).toBe("simple-plan-v1");
    expect(calls[0]!.envelope.rubric).toEqual(planRubric.value.rubric);
    expect(calls[0]!.envelope.rendered_inputs.files).toContainEqual(expect.objectContaining({
      name: "rubric.md", source: "assets/rubrics/simple-plan.yaml",
    }));
    expect(calls[0]!.envelope.rubric.criteria.some((criterion: any) => criterion.id === "phase-plan-soundness")).toBe(false);
    expect(calls[0]!.envelope.assignment.criterion_ids).toContain("decision-readiness");
    expect(calls[0]!.envelope.assignment.criterion_ids).not.toContain("predecessor-guarantees");
    expect(calls[0]!.envelope.assignment.criterion_ids).not.toContain("test-strategy");
    expect(calls[1]!.envelope.assignment.criterion_ids).toEqual(["test-strategy"]);
    await writeFile(join(root, "app.txt"), "after plan fixes\n");
    const implementation = await runSimpleReview({ ...input, stage: "implementation", plan: "Corrected plan", verification: "Relevant check passed",
      expected_policy_digest: plan.value!.policy_digest }, context, dependencies);
    expect(implementation.ok, JSON.stringify(implementation)).toBe(true);
    expect(calls).toHaveLength(6);
    for (const call of calls) {
      const prompt = call.envelope.rendered_inputs.prompt as string;
      const example = JSON.parse(prompt.match(/```json\n([\s\S]*?)\n```/u)![1]!);
      expect(prompt).not.toContain('"$schema"');
      if (call.role === "adjudicator") {
        expect(Object.keys(example.judgments)).toEqual(call.envelope.rules.map((rule: { slot: string }) => rule.slot));
      } else expect(example).toMatchObject({ outcome: "issues_found", feedback: expect.any(String) });
    }
    const implementationRubric = await loadCanonicalRubricForSimpleStage("implementation");
    if (!implementationRubric.ok) throw implementationRubric.error;
    expect(implementationRubric.value.rubric_id).toBe("implementation-v1");
    expect(calls[3]!.envelope.rubric).toEqual(implementationRubric.value.rubric);
    expect(calls[3]!.envelope.assignment.criterion_ids).not.toContain("verification-evidence");
    expect(calls[4]!.envelope.assignment.criterion_ids).toEqual(["verification-evidence", "test-quality"]);
    expect(await readdir(root)).not.toContain(".archflow");
    expect(JSON.stringify(implementation)).not.toMatch(/next_action|implementation_recommendation|task_id|phase_instance/);
    expect(git(root, "rev-parse", "HEAD")).toBe(input.base_commit);
  });

  it("delivers stage-specific ordinary framing and one stage-independent constitution method", async () => {
    const { root, input, context } = await repo();
    const calls: Parameters<typeof fakeDispatch>[0] = [];
    const plan = await runSimpleReview(input, context, { dispatch: fakeDispatch(calls) });
    expect(plan.ok, JSON.stringify(plan)).toBe(true);
    await writeFile(join(root, "app.txt"), "after plan fixes\n");
    const implementation = await runSimpleReview({ ...input, stage: "implementation", plan: "Corrected plan",
      verification: "Relevant check passed", expected_policy_digest: plan.value!.policy_digest }, context, { dispatch: fakeDispatch(calls) });
    expect(implementation.ok, JSON.stringify(implementation)).toBe(true);
    expect(calls).toHaveLength(6);
    const instructions = calls.map((call) => call.envelope.rendered_inputs.prompt as unknown);
    const text = (value: unknown) => typeof value === "string" ? value : JSON.stringify(value);
    // Every ordinary and constitution envelope at both stages carries the shared method, including
    // the instruction to disclose a material missing-evidence limitation.
    for (const instruction of instructions) {
      expect(text(instruction)).toContain("plausible consequential failure");
      expect(text(instruction)).toContain("disclose that limitation");
    }
    const [planGeneral, planTest, planAdjudicator, implGeneral, implTest, implAdjudicator] = instructions;
    // Plan and implementation ordinary reviews start from different evidence...
    expect(text(planGeneral)).toContain("Plan review starts from");
    expect(text(implGeneral)).toContain("compares the declared paths in the current view with the baseline view");
    expect(text(planGeneral)).not.toBe(text(implGeneral));
    // ...and each stage's delivered framing affirmatively disclaims the workflow evidence it does
    // not have, so reviewers cannot be directed toward nonexistent patches or task artifacts.
    for (const instruction of [planGeneral, planTest]) {
      expect(text(instruction)).toContain("No implementation, Git patch, statistics file, or task document");
    }
    for (const instruction of [implGeneral, implTest]) {
      expect(text(instruction)).toContain("No generated patch file or statistics file");
    }
    // ...while constitution framing is one shared, stage-independent composition.
    expect(text(planAdjudicator)).toContain("Judge every supplied rule");
    expect(text(implAdjudicator)).toContain("Judge every supplied rule");
    expect(text(planAdjudicator)).toContain("exactly one judgment per supplied rule slot");
    expect(text(planAdjudicator)).toContain("trigger must report not-matched");
    // Each ordinary role receives only its own responsibility boundary.
    for (const instruction of [planGeneral, implGeneral]) {
      expect(text(instruction)).toContain("Leave test-owned criteria to the test reviewer");
    }
    for (const instruction of [planTest, implTest]) {
      expect(text(instruction)).toMatch(/existing code and tests|actual assertions/u);
      expect(text(instruction)).toContain("cheapest credible");
    }
    // Standalone delivery never promises workflow patches, diff files, or task artifacts. Rule
    // text is subject evidence and may name policy paths, so only instructions and scope bind.
    for (const call of calls) {
      expect(call.envelope.diffs).toBeUndefined();
      for (const promise of [text(call.envelope.rendered_inputs.prompt), call.envelope.scope as string]) {
        expect(promise).not.toContain("review-diffs");
        expect(promise).not.toContain(".archflow");
      }
    }
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
      const primary = join(workspace.root, "review", "repositories", "primary");
      const baseline = join(workspace.root, "review", "repositories", "baseline");
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
    // One reason from the approval rule's content path match, one from the constitution trigger.
    expect(result.value!.human_review_reasons).toEqual([
      expect.stringMatching(/^Approval rule trigger: these changed paths matched the project's content rules:\n- .*app\.txt/u),
      "custom-review: matched. app.txt changes",
    ]);
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

  it("dispatches only the requested roles and still reports deterministic path triggers", async () => {
    const { root, input, context } = await repo();
    await mkdir(join(root, ".archflow"), { recursive: true });
    await writeFile(join(root, ".archflow/config.yaml"), "schema_version: '1'\nroles:\n  counter-reviewer: {model: gpt-6-astra, effort: low}\n  adjudicator: {model: gpt-6-astra, effort: low}\napproval_rules:\n  subjects: []\n  content:\n    - paths: ['app.txt']\n");
    const calls: Parameters<typeof fakeDispatch>[0] = [];
    const result = await runSimpleReview({ ...input, roles: ["counter-reviewer"] }, context, { dispatch: fakeDispatch(calls) });
    expect(result.ok, JSON.stringify(result)).toBe(true);
    expect(calls.map((call) => call.role)).toEqual(["counter-reviewer"]);
    expect(result.value!.reports.map((report) => report.role)).toEqual(["counter-reviewer"]);
    expect(result.value!.constitution).toEqual({ status: "not-requested", judgments: [] });
    expect(result.value!.human_review_reasons).toHaveLength(1);
    const retried: Parameters<typeof fakeDispatch>[0] = [];
    const specialists = await runSimpleReview({ ...input, roles: ["adjudicator", "test-reviewer"] }, context, { dispatch: fakeDispatch(retried) });
    expect(specialists.ok, JSON.stringify(specialists)).toBe(true);
    expect(retried.map((call) => call.role)).toEqual(["test-reviewer", "adjudicator"]);
    expect(specialists.value!.constitution.status).toBe("complete");
  });

  it("rejects an empty, repeated, unknown, or inapplicable role selection without dispatch", async () => {
    const { root, input, context } = await repo();
    const calls: Parameters<typeof fakeDispatch>[0] = [];
    for (const roles of [[], ["counter-reviewer", "counter-reviewer"], ["effort-reviewer"]]) {
      const result = await runSimpleReview({ ...input, roles } as unknown as SimpleReviewInput, context, { dispatch: fakeDispatch(calls) });
      expect(result.ok).toBe(false);
      expect(result.error!.code).toBe("INPUT_INVALID");
      expect(result.error!.message).toContain("roles");
    }
    await mkdir(join(root, ".archflow/constitution"), { recursive: true });
    const inapplicable = await runSimpleReview({ ...input, roles: ["adjudicator"] }, context, { dispatch: fakeDispatch(calls) });
    expect(inapplicable.error).toMatchObject({ code: "INPUT_INVALID", message: expect.stringContaining("roles") });
    expect(calls).toHaveLength(0);
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

  it("raises a human review reason for an approval-rule subject only at its stage", async () => {
    const { root, input, context } = await repo();
    await mkdir(join(root, ".archflow"));
    await writeFile(join(root, ".archflow/config.yaml"), "schema_version: '1'\nroles:\n  counter-reviewer: {model: gpt-6-astra, effort: low}\n  adjudicator: {model: gpt-6-astra, effort: low}\napproval_rules:\n  subjects: ['phase-impl']\n  content: []\n");
    const plan = await runSimpleReview(input, context, { dispatch: fakeDispatch([]) });
    expect(plan.ok, JSON.stringify(plan)).toBe(true);
    expect(plan.value!.human_review_reasons).toEqual([]);
    const implementation = await runSimpleReview({ ...input, stage: "implementation", verification: "Relevant check passed",
      expected_policy_digest: plan.value!.policy_digest }, context, { dispatch: fakeDispatch([]) });
    expect(implementation.ok, JSON.stringify(implementation)).toBe(true);
    expect(implementation.value!.human_review_reasons).toEqual([
      'Approval rule trigger: this project requires human approval for the "phase-impl" subject.',
    ]);
  });

  it("raises the phase-design subject only on a plan review and ignores the legacy prd and design subjects", async () => {
    const { root, input, context } = await repo();
    await mkdir(join(root, ".archflow"));
    const configWithSubjects = (subjects: string) => writeFile(join(root, ".archflow/config.yaml"), `schema_version: '1'\nroles:\n  counter-reviewer: {model: gpt-6-astra, effort: low}\n  adjudicator: {model: gpt-6-astra, effort: low}\napproval_rules:\n  subjects: ${subjects}\n  content: []\n`);
    const review = async () => {
      const plan = await runSimpleReview(input, context, { dispatch: fakeDispatch([]) });
      expect(plan.ok, JSON.stringify(plan)).toBe(true);
      const implementation = await runSimpleReview({ ...input, stage: "implementation", verification: "Relevant check passed",
        expected_policy_digest: plan.value!.policy_digest }, context, { dispatch: fakeDispatch([]) });
      expect(implementation.ok, JSON.stringify(implementation)).toBe(true);
      return { plan: plan.value!.human_review_reasons, implementation: implementation.value!.human_review_reasons };
    };
    await configWithSubjects("['phase-design']");
    expect(await review()).toEqual({
      plan: ['Approval rule trigger: this project requires human approval for the "phase-design" subject.'],
      implementation: [],
    });
    await configWithSubjects("[prd, design]");
    expect(await review()).toEqual({ plan: [], implementation: [] });
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

  it("does not retry a non-transient failure and stops a transient one after three dispatches", async () => {
    const { input, context } = await repo();
    for (const [code, failure, expected] of [
      ["AUTH_UNAVAILABLE", () => createProjectError("AUTH_UNAVAILABLE", { adapter: "claude-cli" }), 1],
      ["RATE_LIMITED", () => createProjectError("RATE_LIMITED", { adapter: "claude-cli", attempt: 1 }), 3],
    ] as const) {
      let generalDispatches = 0;
      const waits: number[] = [];
      const fake = fakeDispatch([]);
      const result = await runSimpleReview(input, context, { wait: async (ms) => { waits.push(ms); }, dispatch: async (...args) => {
        const body = JSON.parse(new TextDecoder().decode(args[1].bytes));
        if (body.assignment?.focus === "general") { generalDispatches++; throw new CliAdapterError(failure()); }
        return fake(...args);
      } });
      expect(result.ok).toBe(false);
      expect(result.value!.failures).toEqual([expect.objectContaining({ role: "counter-reviewer", code })]);
      expect(result.value!.reports.map(report => report.role)).toEqual(["test-reviewer", "adjudicator"]);
      expect(generalDispatches).toBe(expected);
      expect(waits).toEqual(expected === 1 ? [] : [1000, 4000]);
    }
  });

  it("validates its own input and returns a result that satisfies the public result schema", async () => {
    const { input, context } = await repo();
    const badInput = await runSimpleReview({ ...input, stage: "implementation" }, context, { dispatch: fakeDispatch([]) });
    expect(badInput.error!.code).toBe("INPUT_INVALID");
    expect(badInput.error!.message).toContain("verification");
    expect(parseSimpleReviewResult(badInput)).toEqual(badInput);
    const reviewed = await runSimpleReview(input, context, { dispatch: fakeDispatch([]) });
    expect(parseSimpleReviewResult(reviewed)).toEqual(reviewed);
  });
});

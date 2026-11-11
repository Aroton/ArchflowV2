import { afterEach, describe, expect, it } from "vitest";
import { chmod, mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { sealDispatchInput } from "../../src/review/envelopes.js";
import { loadReviewInputConfiguration, parseReviewInputConfiguration, prepareReviewInputs, materializeReviewInputs, renderReviewPrompt } from "../../src/review/inputs.js";
import { projectCliOutputSchema, selectCliAdapter } from "../../src/dispatch/cli.js";
import type { DispatchWorkspace } from "../../src/dispatch/workspace.js";
import { loadCanonicalRubricForSimpleStage } from "../../src/review/rubrics.js";
import { createJsonSchemaValidator } from "../helpers/json-schema.js";
import { standaloneReviewFields } from "../helpers/standalone-review-input.js";
const bytes = (text: string) => new TextEncoder().encode(text);
const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });
const seed = (stage: "plan" | "implementation" = "plan", focus = "general") => ({
  ...standaloneReviewFields({ subject: "# Current subject\n", stage }),
  rubric: { schema_version: "1", kind: "artifact", mode: "adversarial", criteria: [{ id: "correctness", text: "Concrete correctness", blocking: true }, { id: "test-quality", text: "Meaningful coverage", blocking: true }] },
  assignment: { reviewer_id: focus === "tests" ? "test" : "general", focus, criterion_ids: focus === "tests" ? ["test-quality"] : ["correctness"] },
});
async function workspace(): Promise<DispatchWorkspace> {
  const root = await mkdtemp(join(tmpdir(), "archflow-inputs-test-")); roots.push(root);
  await mkdir(join(root, "repository"));
  return { root, env: {}, dispose: async () => {} };
}

describe("bundled review recipes", () => {
  it("keeps a complete recipe and an installed rubric for each standalone stage", async () => {
    const config = loadReviewInputConfiguration();
    expect(Object.keys(config.phases)).toEqual(["phase-design", "phase-impl"]);
    for (const [stage, phase] of [["plan", "phase-design"], ["implementation", "phase-impl"]] as const) {
      expect(Object.keys(config.phases[phase].reviewers)).toEqual(["general", "tests", "constitution"]);
      const rubric = await loadCanonicalRubricForSimpleStage(stage);
      if (!rubric.ok) throw rubric.error;
      expect(rubric.value.rubric_id).toBe(config.phases[phase].rubric.id);
      const criteria = rubric.value.rubric.criteria.map(criterion => criterion.id);
      expect(config.phases[phase].rubric.test_criteria.length).toBeGreaterThan(0);
      for (const id of config.phases[phase].rubric.test_criteria) expect(criteria).toContain(id);
    }
  });
  it("refuses recipes and subjects for phases and reviewers that have no recipe", () => {
    const config = loadReviewInputConfiguration();
    const plan = config.phases["phase-design"];
    expect(() => parseReviewInputConfiguration({ ...config, phases: { ...config.phases, prd: plan } })).toThrow();
    expect(() => parseReviewInputConfiguration({ ...config, phases: { ...config.phases, "phase-design": { ...plan, reviewers: { ...plan.reviewers, effort: plan.reviewers.constitution } } } })).toThrow();
    for (const stage of ["prd", "design", "phase-impl"]) {
      expect(() => sealDispatchInput("review", { ...seed(), subject: { ...seed().subject, stage } })).toThrow(/Invalid option/);
    }
  });
  it("covers each applicable reviewer with an explicit recipe and rejects unknown blocks and follow-up rounds", () => {
    const config = loadReviewInputConfiguration();
    for (const phase of ["phase-design", "phase-impl"] as const) {
      for (const reviewer of Object.values(config.phases[phase].reviewers)) {
        expect(reviewer.inputs).toContain("subject");
        expect(reviewer.inputs).toContain("repository");
      }
    }
    const general = config.phases["phase-design"].reviewers.general;
    expect(() => parseReviewInputConfiguration({ ...config, phases: { ...config.phases, "phase-design": { ...config.phases["phase-design"], reviewers: { ...config.phases["phase-design"].reviewers, general: { initial: general, follow_up: general } } } } })).toThrow();
    expect(() => parseReviewInputConfiguration({ ...config, phases: { ...config.phases, "phase-design": { ...config.phases["phase-design"], reviewers: { ...config.phases["phase-design"].reviewers, general: { ...general, inputs: [...general.inputs, "previous-feedback"] } } } } })).toThrow();
    const { simple_plan: _removed, ...withoutStageBlock } = config.instructions;
    expect(() => parseReviewInputConfiguration({ ...config, instructions: withoutStageBlock })).toThrow(/simple_plan/);
    general.instructions.push("not-a-block");
    expect(() => parseReviewInputConfiguration(config)).toThrow(/Unknown/);
  });
  it.each(["plan", "implementation"] as const)("renders human instructions and references for %s without bookkeeping", stage => {
    const prepared = prepareReviewInputs(sealDispatchInput("review", seed(stage)));
    const prompt = renderReviewPrompt(prepared, "review-inputs");
    expect(prompt).toContain("primary subject");
    expect(prompt).toContain("entire supplied base context");
    expect(prompt).toContain("Read as much of this context as possible");
    expect(prompt).not.toMatch(/input_fingerprint|invocation_id|subject_digest/);
    expect(prepared.files.map(file => file.name)).toEqual([stage === "plan" ? "phase-design.md" : "implementation.md", "ask.md", "declared-paths.md", "rubric.md", ...(stage === "plan" ? [] : ["verification.md"])]);
  });
  it("fails when a recipe or prepared review would omit its rubric", () => {
    const config = loadReviewInputConfiguration();
    config.phases["phase-design"].reviewers.general.inputs = config.phases["phase-design"].reviewers.general.inputs.filter(name => name !== "rubric");
    expect(() => parseReviewInputConfiguration(config)).toThrow(/must supply/);
    const record = JSON.parse(new TextDecoder().decode(sealDispatchInput("review", seed()).bytes));
    delete record.rubric;
    delete record.rendered_inputs;
    expect(() => prepareReviewInputs(sealDispatchInput("review", record))).toThrow(/Missing rubric/);
  });
  it("restricts rubric criteria to the authenticated assignment", () => {
    const general = prepareReviewInputs(sealDispatchInput("review", seed()));
    const tests = prepareReviewInputs(sealDispatchInput("review", seed("plan", "tests")));
    expect(general.files.find(file => file.group === "rubric")?.content).toContain("Concrete correctness");
    expect(general.files.find(file => file.group === "rubric")?.content).not.toContain("Meaningful coverage");
    expect(tests.files.find(file => file.group === "rubric")?.content).not.toContain("Concrete correctness");
    expect(tests.instructions).toContain("proposed verification strategy");
    const unassigned = { ...seed(), assignment: { ...seed().assignment, criterion_ids: ["not-in-rubric"] } };
    expect(() => sealDispatchInput("review", unassigned)).toThrow(/no assigned rubric criteria/);
  });
  it("binds recipe changes and full file contents into retained-output identity", () => {
    const before = sealDispatchInput("review", seed());
    const after = sealDispatchInput("review", { ...seed(), plan: "changed subject" });
    expect(before.digest).not.toBe(after.digest);
    const config = JSON.parse(new TextDecoder().decode(before.bytes));
    config.review_configuration.instructions.base += " Additional instruction.";
    const altered = { ...before, bytes: bytes(JSON.stringify(config)) };
    expect(() => prepareReviewInputs(altered)).toThrow(/binding changed/);
    const original = seed();
    const changedAuthority = sealDispatchInput("review", { ...original, rubric: { ...original.rubric, criteria: original.rubric.criteria.map(criterion => ({ ...criterion, text: `${criterion.text} (revised)` })) } });
    expect(changedAuthority.digest).not.toBe(before.digest);
  });
  it("rejects an oversized instruction/reference prompt without truncating evidence", () => {
    const prepared = prepareReviewInputs(sealDispatchInput("review", seed()));
    prepared.instructions = "x".repeat(16384);
    expect(() => renderReviewPrompt(prepared, "review-inputs")).toThrow(/16 KiB/);
    expect(prepared.files.find(file => file.group === "subject")?.content).toBe(seed().plan);
  });
  it("counts the response example toward the prompt limit without truncating it", () => {
    const prepared = prepareReviewInputs(sealDispatchInput("review", seed()));
    prepared.response_schema = { type: "object", properties: { fixed_value: { const: "x".repeat(16384) } } };
    expect(() => renderReviewPrompt(prepared, "review-inputs")).toThrow(/response example.*16 KiB/);
    expect(prepared.response_schema).toEqual({ type: "object", properties: { fixed_value: { const: "x".repeat(16384) } } });
  });
  it("rejects response contract changes that are not authenticated by the envelope", () => {
    const envelope = sealDispatchInput("review", seed());
    const record = JSON.parse(new TextDecoder().decode(envelope.bytes));
    record.response_schema.properties.outcome.enum = ["invented-outcome"];
    expect(() => prepareReviewInputs({ ...envelope, bytes: bytes(JSON.stringify(record)) })).toThrow(/binding changed/);
  });
});

describe("materialized review inputs", () => {
  it("preserves complete document bytes and rejects a modified materialization", async () => {
    const input = seed();
    const content = "é\n".repeat(600_000) + "END OF DOCUMENT\n";
    const envelope = sealDispatchInput("review", { ...input, plan: content });
    const ws = await workspace();
    const prepared = await materializeReviewInputs(envelope, ws);
    const path = join(prepared.directory, "phase-design.md");
    expect(await readFile(path, "utf8")).toBe(content);
    expect(prepared.prompt).not.toContain("END OF DOCUMENT");
    await chmod(path, 0o644); await writeFile(path, "changed");
    await expect(materializeReviewInputs(envelope, ws)).rejects.toThrow(/changed/);
  });
  it.each([
    { adapter: "claude-cli", family: "claude", model: "claude-fable-5-1", effort: "medium" },
    { adapter: "codex-cli", family: "codex", model: "gpt-5.6-sol", effort: "medium" },
    { adapter: "antigravity-cli", family: "gemini", model: "gemini-3.8-flash-high", effort: "high" },
  ] as const)("matches preview prompt and references exactly for $adapter", async (route) => {
    const ws = await workspace(); const envelope = sealDispatchInput("review", seed());
    const preview = await materializeReviewInputs(envelope, ws);
    const invocation = await selectCliAdapter("claude", route).buildInvocation(envelope, route, ws, { type: "object", properties: {}, additionalProperties: false });
    const prompt = route.adapter === "antigravity-cli" ? invocation.argv[1] : invocation.argv.at(-1);
    expect(prompt).toBe(preview.prompt);
    const schemaFlag = route.adapter === "codex-cli" ? "--output-schema" : "--json-schema";
    const schemaArgument = invocation.argv[invocation.argv.indexOf(schemaFlag) + 1]!;
    const schemaText = route.adapter === "claude-cli" ? schemaArgument : await readFile(schemaArgument, "utf8");
    expect(JSON.parse(schemaText)).toEqual(projectCliOutputSchema(preview.prepared.response_schema, route.adapter));
    expect(invocation.stdin).toBeUndefined();
    for (const file of preview.prepared.files) expect((await readFile(join(preview.directory, file.name))).byteLength).toBe(file.byte_count);
    const other = sealDispatchInput("review", { ...seed(), subject: { ...seed().subject, invocation_id: "different-invocation", result_id: "different-result" } });
    expect((await materializeReviewInputs(other, ws)).prompt).toBe(preview.prompt);
  });
  it.each([
    { adapter: "claude-cli", family: "claude", model: "claude-fable-5-1", effort: "medium" },
    { adapter: "codex-cli", family: "codex", model: "gpt-5.6-sol", effort: "medium" },
    { adapter: "antigravity-cli", family: "gemini", model: "gemini-3.8-flash-high", effort: "high" },
  ] as const)("keeps the constitution example and CLI contract aligned for $adapter", async (route) => {
    const envelope = sealDispatchInput("adjudication", {
      ...standaloneReviewFields({ subject: "# Current subject", stage: "plan" }),
      rules: ["rule-a", "rule-b"].map(slot => ({ slot, text: "Preserve the public interface.", enforced_by: [] })),
    });
    const ws = await workspace();
    const preview = await materializeReviewInputs(envelope, ws);
    const invocation = await selectCliAdapter("claude", route).buildInvocation(envelope, route, ws, preview.prepared.response_schema);
    const prompt = route.adapter === "antigravity-cli" ? invocation.argv[1]! : invocation.argv.at(-1)!;
    expect(prompt).toBe(preview.prompt);
    const example = JSON.parse(prompt.match(/```json\n([\s\S]*?)\n```/u)![1]!);
    const schemaFlag = route.adapter === "codex-cli" ? "--output-schema" : "--json-schema";
    const argument = invocation.argv[invocation.argv.indexOf(schemaFlag) + 1]!;
    const schema = JSON.parse(route.adapter === "claude-cli" ? argument : await readFile(argument, "utf8"));
    expect(schema).toEqual(projectCliOutputSchema(preview.prepared.response_schema, route.adapter));
    expect(createJsonSchemaValidator(schema).validate(example)).toBe(true);
    expect(Object.keys(example.judgments)).toEqual(["rule-a", "rule-b"]);
    expect(createJsonSchemaValidator(schema).validate({ ...example, judgments: { "rule-a": example.judgments["rule-a"] } })).toBe(false);
  });
});

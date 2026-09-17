import { afterEach, describe, expect, it } from "vitest";
import { chmod, mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { sha256Bytes } from "../../src/contracts/canonical.js";
import { buildReviewEnvelope, sealDispatchInput, type ReviewEnvelopeInput } from "../../src/review/envelopes.js";
import { pinnedContextEntry } from "../../src/review/pinned-context.js";
import { governingReviewBindings, loadReviewDocumentConfiguration } from "../../src/review/documents.js";
import { loadReviewInputConfiguration, parseReviewInputConfiguration, prepareReviewInputs, materializeReviewInputs, renderReviewPrompt } from "../../src/review/inputs.js";
import { selectCliAdapter } from "../../src/dispatch/cli.js";
import type { DispatchWorkspace } from "../../src/dispatch/workspace.js";
const bytes = (text: string) => new TextEncoder().encode(text);
const hash = (text: string) => sha256Bytes(bytes(text));
const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });
const seed = (phase = "phase-design-2", focus = "general"): ReviewEnvelopeInput => ({
  artifact: "# Current subject\n", rubric: { schema_version: "1", kind: "artifact", mode: "adversarial", criteria: [{ id: "correctness", text: "Concrete correctness", blocking: true }, { id: "test-quality", text: "Meaningful coverage", blocking: true }] },
  assignment: { reviewer_id: focus === "tests" ? "test" : "general", focus, criterion_ids: focus === "tests" ? ["test-quality"] : ["correctness"] },
  context: [pinnedContextEntry("approved-upstream", "prd.md", bytes("approved PRD\n")), pinnedContextEntry("approved-upstream", "design.md", bytes("approved architecture\n"))],
  subject: { task_id: "inputs", phase_instance: phase, role: "counter-review", step: "counter_review", attempt: 1, subject_digest: hash("subject"), input_fingerprint: hash("fingerprint"), rubric_digest: hash("rubric"), producer_family: "claude", invocation_id: "review-invocation", result_id: "review-result" },
} as unknown as ReviewEnvelopeInput);
async function workspace(): Promise<DispatchWorkspace> {
  const root = await mkdtemp(join(tmpdir(), "archflow-inputs-test-")); roots.push(root);
  await mkdir(join(root, "repository"));
  return { root, repository_view_root: join(root, "repository"), env: {}, dispose: async () => {} };
}

describe("bundled review recipes", () => {
  it("explicitly enumerates governing documents and authoritative versions", () => {
    expect(loadReviewDocumentConfiguration().version).toContain("Never substitute");
    expect(governingReviewBindings("prd" as never)).toEqual([]);
    expect(governingReviewBindings("design" as never).map(binding => binding.path)).toEqual(["prd.md"]);
    expect(governingReviewBindings("phase-design-2" as never).map(binding => binding.path)).toEqual(["design.md", "prd.md"]);
    expect(governingReviewBindings("phase-impl-2" as never).map(binding => binding.path)).toEqual(["phases/2/design.md", "design.md", "prd.md"]);
  });
  it("covers each applicable reviewer with explicit initial and follow-up recipes", () => {
    const config = loadReviewInputConfiguration();
    for (const phase of ["prd", "design", "phase-design", "phase-impl"] as const) {
      for (const reviewer of Object.values(config.phases[phase].reviewers)) {
        expect(reviewer?.initial.inputs).toContain("subject");
        expect(reviewer?.follow_up.inputs).toContain("governing-documents");
      }
    }
    expect(config.phases["phase-design"].reviewers.effort).toBeDefined();
    expect(config.phases["phase-impl"].reviewers.effort).toBeUndefined();
    config.phases.prd.reviewers.general.initial.instructions.push("not-a-block");
    expect(() => parseReviewInputConfiguration(config)).toThrow(/Unknown/);
  });
  it.each(["prd", "design", "phase-design-2", "phase-impl-2"])("renders human instructions and references for %s without bookkeeping", phase => {
    const prepared = prepareReviewInputs(buildReviewEnvelope(seed(phase)));
    const prompt = renderReviewPrompt(prepared, "review-inputs");
    expect(prompt).toContain("primary subject");
    expect(prompt).toContain("entire supplied base context");
    expect(prompt).toContain("Read as much of this context as possible");
    expect(prompt).not.toMatch(/input_fingerprint|invocation_id|subject_digest|approved architecture/);
    expect(prepared.files.some(file => file.name === "task-design.md")).toBe(true);
  });
  it("fails when a recipe or prepared review would omit its rubric", () => {
    const config = loadReviewInputConfiguration();
    config.phases.prd.reviewers.general.initial.inputs = config.phases.prd.reviewers.general.initial.inputs.filter(name => name !== "rubric");
    expect(() => parseReviewInputConfiguration(config)).toThrow(/must supply/);
    const record = JSON.parse(new TextDecoder().decode(buildReviewEnvelope(seed()).bytes));
    delete record.rubric;
    delete record.rendered_inputs;
    expect(() => prepareReviewInputs(sealDispatchInput("review", record))).toThrow(/Missing rubric/);
  });
  it("restricts rubric criteria to the authenticated assignment", () => {
    const general = prepareReviewInputs(buildReviewEnvelope(seed()));
    const tests = prepareReviewInputs(buildReviewEnvelope(seed("phase-design-2", "tests")));
    expect(general.files.find(file => file.group === "rubric")?.content).toContain("Concrete correctness");
    expect(general.files.find(file => file.group === "rubric")?.content).not.toContain("Meaningful coverage");
    expect(tests.files.find(file => file.group === "rubric")?.content).not.toContain("Concrete correctness");
    expect(tests.instructions).toContain("proposed verification strategy");
  });
  it("makes unavailable follow-up evidence explicit without removing the complete subject", () => {
    const input = seed();
    const current = buildReviewEnvelope({ ...input, context: [...input.context, { kind: "prior-triage", label: "previous-feedback", status: "unavailable", note: "Historical feedback is unavailable; do not infer resolution." }] });
    const prepared = prepareReviewInputs(current);
    expect(prepared.mode).toBe("follow_up");
    expect(prepared.files.some(file => file.status === "unavailable")).toBe(true);
    expect(prepared.files.find(file => file.group === "subject")?.content).toBe(input.artifact);
    expect(prepared.instructions).toContain("Verify the revisions");
  });
  it("does not silently omit imported governing documents", () => {
    const input = seed();
    const prepared = prepareReviewInputs(buildReviewEnvelope({ ...input, context: [pinnedContextEntry("imported-reference", "prd.md", bytes("migrated PRD"))] }));
    expect(prepared.files.find(file => file.name === "prd.md")?.content).toBe("migrated PRD");
  });
  it("binds recipe changes and full file contents into retained-output identity", () => {
    const before = buildReviewEnvelope(seed());
    const after = buildReviewEnvelope({ ...seed(), artifact: "changed subject" });
    expect(before.digest).not.toBe(after.digest);
    const config = JSON.parse(new TextDecoder().decode(before.bytes));
    config.review_configuration.instructions.base += " Additional instruction.";
    const altered = { ...before, bytes: bytes(JSON.stringify(config)) };
    expect(() => prepareReviewInputs(altered)).toThrow(/binding changed/);
    const original = seed();
    const changedAuthority = buildReviewEnvelope({ ...original, context: original.context.map(entry => ({ ...entry, source_version: hash("different approved version") })) });
    expect(changedAuthority.digest).not.toBe(before.digest);
  });
  it("rejects an oversized instruction/reference prompt without truncating evidence", () => {
    const prepared = prepareReviewInputs(buildReviewEnvelope(seed()));
    prepared.instructions = "x".repeat(16384);
    expect(() => renderReviewPrompt(prepared, "review-inputs")).toThrow(/16 KiB/);
    expect(prepared.files.find(file => file.group === "subject")?.content).toBe(seed().artifact);
  });
});

describe("materialized review inputs", () => {
  it("preserves complete document bytes and rejects a modified materialization", async () => {
    const input = seed();
    const content = "é\n".repeat(600_000) + "END OF DOCUMENT\n";
    const envelope = buildReviewEnvelope({ ...input, artifact: content });
    const ws = await workspace();
    const prepared = await materializeReviewInputs(envelope, ws);
    const path = join(prepared.directory, "phase-design.md");
    expect(await readFile(path, "utf8")).toBe(content);
    expect(prepared.prompt).not.toContain("END OF DOCUMENT");
    await chmod(path, 0o644); await writeFile(path, "changed");
    await expect(materializeReviewInputs(envelope, ws)).rejects.toThrow(/changed/);
  });
  it("validates external complete patch bytes before sending references", async () => {
    const ws = await workspace(); await mkdir(join(ws.root, "review-diffs"));
    const patch = "-old\n+new\n";
    await writeFile(join(ws.root, "review-diffs/full.patch"), patch);
    await writeFile(join(ws.root, "review-diffs/full.stat"), "1 1 file");
    const input = seed();
    const envelope = buildReviewEnvelope({ ...input, diffs: { full: { kind: "document", subject_digest: input.subject.subject_digest, patch: { path: "review-diffs/full.patch", content_digest: hash(patch), byte_count: Buffer.byteLength(patch) }, stat: { path: "review-diffs/full.stat", content_digest: hash("1 1 file"), byte_count: 8 } } } });
    await expect(materializeReviewInputs(envelope, ws)).resolves.toHaveProperty("prompt");
    await writeFile(join(ws.root, "review-diffs/full.patch"), "tampered");
    await expect(materializeReviewInputs(envelope, ws)).rejects.toThrow(/changed before dispatch/);
  });
  it.each([
    { adapter: "claude-cli", family: "claude", model: "claude-fable-5-1", effort: "medium" },
    { adapter: "codex-cli", family: "codex", model: "gpt-5.6-sol", effort: "medium" },
    { adapter: "antigravity-cli", family: "gemini", model: "gemini-3.8-flash-high", effort: "high" },
  ] as const)("matches preview prompt and references exactly for $adapter", async (route) => {
    const ws = await workspace(); const envelope = buildReviewEnvelope(seed());
    const preview = await materializeReviewInputs(envelope, ws);
    const invocation = await selectCliAdapter("claude", route).buildInvocation(envelope, route, ws, { type: "object", properties: {}, additionalProperties: false });
    const prompt = route.adapter === "antigravity-cli" ? invocation.argv[1] : invocation.argv.at(-1);
    expect(prompt).toBe(preview.prompt);
    expect(invocation.stdin).toBeUndefined();
    for (const file of preview.prepared.files) expect((await readFile(join(preview.directory, file.name))).byteLength).toBe(file.byte_count);
    const other = buildReviewEnvelope({ ...seed(), subject: { ...seed().subject, invocation_id: "different-invocation", result_id: "different-result" } });
    expect((await materializeReviewInputs(other, ws)).prompt).toBe(preview.prompt);
  });
});

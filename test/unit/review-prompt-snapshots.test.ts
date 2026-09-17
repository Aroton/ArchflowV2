import { describe, expect, it } from "vitest";
import { mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { sha256Bytes } from "../../src/contracts/canonical.js";
import { sealDispatchInput } from "../../src/review/envelopes.js";
import { loadReviewInputConfiguration, materializeReviewInputs } from "../../src/review/inputs.js";
import { governingReviewBindings } from "../../src/review/documents.js";
import { pinnedContextEntry } from "../../src/review/pinned-context.js";
import { loadCanonicalRubricForPhaseKind, reviewCriterionIds } from "../../src/review/rubrics.js";
import type { PlainJsonValue } from "../../src/contracts/plain-json.js";

const config = loadReviewInputConfiguration();
const baseCases = Object.entries(config.phases).flatMap(([phase, value]) => Object.keys(value.reviewers).flatMap(reviewer => ["initial", "follow_up"].map(mode => ({ phase, reviewer, mode }))));
const cases = [
  ...baseCases.map(value => ({ ...value, amendment: false })),
  ...["general", "constitution"].map(reviewer => ({ phase: "phase-impl", reviewer, mode: "initial", amendment: true })),
];
const bytes = (text: string) => new TextEncoder().encode(text);
const hash = (text: string) => sha256Bytes(bytes(text));

/** These checked-in Markdown files ARE the exact dispatched prompts for representative inputs. */
describe("readable final review prompts", () => {
  it.each(cases)("$phase / $reviewer / $mode", async ({ phase, reviewer, mode, amendment }) => {
    const root = await mkdtemp(join(tmpdir(), "archflow-prompt-snapshot-"));
    const repository_view_root = join(root, "repository"); await mkdir(repository_view_root);
    try {
      const instance = phase.startsWith("phase-") ? `${phase}-2` : phase;
      const loaded = await loadCanonicalRubricForPhaseKind(phase as keyof typeof config.phases);
      if (!loaded.ok) throw new Error(loaded.error.code);
      const rubric = loaded.value.rubric;
      const focus = reviewer === "tests" ? "tests" : "general";
      const reviewer_id = reviewer === "tests" ? "test" : reviewer;
      const context = governingReviewBindings(instance as never).filter(binding => !amendment || binding.path !== "design.md").map(binding => pinnedContextEntry("approved-upstream", binding.path, bytes(`# Approved ${binding.artifact_kind}\n\nPreserve the specified public behavior.\n`)));
      if (phase === "prd") context.push(pinnedContextEntry("user-ask", "ask.md", bytes("Add a reliable document search.\n")));
      if (phase === "phase-impl") context.push(pinnedContextEntry("verification-transcript", "verification.txt", bytes("$ npm test\nAll behavior checks passed.\n")));
      const followUp = mode === "follow_up" && ["general", "tests"].includes(reviewer);
      if (followUp) context.push(pinnedContextEntry("prior-triage", "previous-feedback.md", bytes(JSON.stringify({ previous_feedback: "An empty query must not return all documents.", verification_request: "Confirm empty-query behavior and the regression test." }))));
      const record = {
        artifact: `# ${phase} subject\n\nSpecify and implement document search.\n`,
        subject: { phase_instance: instance, subject_digest: hash("current subject"), rubric_digest: loaded.value.rubric_digest },
        assignment: { reviewer_id, focus, criterion_ids: reviewCriterionIds(phase as keyof typeof config.phases, rubric, focus) },
        rubric, context,
        ...(phase === "phase-impl" ? { documents: [{ path: "phases/2/impl-notes.md", content: "# Implementation notes\n\nImplemented document search and checked empty-query behavior.\n", source_version: hash("current subject") }, ...(amendment ? [{ path: "design.md", content: "# Proposed architecture amendment\n\nUse cursor-based pagination.\n", source_version: hash("current subject") }] : [])] } : {}),
        ...(reviewer === "effort" ? { hazard_registry: { state: "captured", registry_digest: hash("hazards"), hazards: [{ path: "src/search.ts", description: "Preserve cancellation behavior." }] } } : {}),
        ...(reviewer === "constitution" ? { rules: [{ slot: "rule-1", text: "Preserve approved public interfaces.", review_trigger: "An approved interface changes.", enforced_by: ["contract tests"] }] } : {}),
        ...(amendment ? { governing_document_comparisons: [{ path: "design.md", baseline: { status: "authenticated", content: "# Approved architecture\n\nUse page-based pagination.\n", content_digest: hash("approved architecture") }, proposed_content_digest: hash("proposed architecture") }] } : {}),
        workspace: { note: "Inspect the read-only repository snapshot for further investigation. Task state is excluded." },
      };
      // Real diff generation is tested separately; these exact bytes exercise file selection and rendering.
      const { writeFile } = await import("node:fs/promises");
      await mkdir(join(root, "review-diffs"));
      const descriptor = async (name: string, text: string) => { await writeFile(join(root, "review-diffs", name), text); return { path: `review-diffs/${name}`, byte_count: Buffer.byteLength(text), content_digest: hash(text) }; };
      const full = { kind: phase === "phase-impl" ? "implementation" : "document", subject_digest: hash("current subject"), patch: await descriptor("full.patch", "-old behavior\n+new behavior\n"), stat: await descriptor("full.stat", "1\t1\tsubject\n") };
      const revision = followUp ? { kind: "revision", subject_digest: hash("current subject"), base_subject_digest: hash("previous reviewer subject"), patch: await descriptor("revision.patch", "+reject empty query\n"), stat: await descriptor("revision.stat", "1\t0\tsubject\n") } : undefined;
      const resultKind = reviewer === "constitution" ? "adjudication" : reviewer === "effort" ? "effort-review" : "review";
      const envelope = sealDispatchInput(resultKind, { ...record, ...(reviewer === "effort" ? record.subject : {}), diffs: { full, ...(revision === undefined ? {} : { revision }) } } as unknown as PlainJsonValue);
      const rendered = await materializeReviewInputs(envelope, { root, repository_view_root, env: {}, dispose: async () => {} });
      expect(rendered.prompt).not.toContain("@..");
      for (const reference of rendered.prompt.split("\n").filter(line => line.startsWith("@"))) expect(reference).toMatch(/^@review-inputs\/[a-z-]+\/[a-zA-Z0-9._-]+$/u);
      if (["general", "tests"].includes(reviewer)) {
        expect(rendered.prompt).toContain(`/rubric.md`);
        expect(rendered.prompt).toContain("Read and apply rubric.md");
        const rubricFile = rendered.prepared.files.find(file => file.name === "rubric.md")!;
        expect(rubricFile.content).toContain(config.phases[phase as keyof typeof config.phases].rubric.file);
        for (const id of record.assignment.criterion_ids) expect(rubricFile.content).toContain(id);
      }
      await expect(rendered.prompt).toMatchFileSnapshot(`../fixtures/review-prompts/${phase}-${reviewer}-${mode}${amendment ? "-with-amendment" : ""}.md`);
      if (amendment) {
        expect(rendered.prompt).toContain("### Co-produced document change");
        expect(rendered.prompt).toContain(`/proposed-task-design.md`);
        expect(rendered.prompt).toContain(`/governing-comparisons.md`);
        expect(rendered.prompt).not.toContain(`@review-inputs/${reviewer_id}/task-design.md`);
      }
      for (const file of rendered.prepared.files) {
        expect((await readFile(join(rendered.directory, file.name))).byteLength).toBe(file.byte_count);
        expect(file.guidance?.use).toBeTruthy();
        expect(rendered.prompt).toContain(`review-inputs/${reviewer_id}/${file.name}`);
        expect(rendered.prompt).toContain(file.guidance!.use);
        if (file.delivery === "available") expect(rendered.prompt).not.toContain(`@review-inputs/${reviewer_id}/${file.name}`);
      }
    } finally { await rm(root, { recursive: true, force: true }); }
  });
});

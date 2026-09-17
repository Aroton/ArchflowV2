/**
 * Credential-free review-efficiency checks: the historical baseline's provenance against the
 * pinned blobs, executable fixture oracles, envelope pair parity and instruction composition,
 * stream observation grammar, the checkpoint journal and stage rules, and the whole experiment
 * loop driven by stubbed hosts and preflight.
 */

import { execFileSync } from "node:child_process";
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  canonicalJsonBytes,
  canonicalJsonDigest,
  parseCanonicalDocument,
  sha256Bytes,
} from "../../src/contracts/canonical.js";
import { createProjectError } from "../../src/contracts/errors.js";
import { parseSafeId, parseSafeInteger, parseSha256Digest, parseTaskSlug } from "../../src/contracts/evidence.js";
import type { PlainJsonValue } from "../../src/contracts/plain-json.js";
import { parsePhaseInstanceId } from "../../src/contracts/phase-instance.js";
import type { DispatchChildResult, DispatchChildSpec } from "../../src/dispatch/process.js";
import { DispatchProcessError } from "../../src/dispatch/process.js";
import { selectCliAdapter } from "../../src/dispatch/cli.js";
import { createDispatchWorkspace } from "../../src/dispatch/workspace.js";
import { prepareReviewInputs, REVIEW_PROMPT_BYTE_LIMIT, ReviewInputError } from "../../src/review/inputs.js";
import {
  buildReviewEnvelope,
  type DispatchEnvelope,
} from "../../src/review/envelopes.js";
import {
  aggregateUsage,
  assertPairParity,
  buildEfficiencyFixtures,
  buildObservationDocument,
  CASE_IDS,
  CASE_ORACLE_CONTRACT,
  checkpointDocumentDigest,
  computeAggregates,
  decodeEnvelopeDocument,
  dispositionSlots,
  DOCUMENT_CASES,
  EfficiencyJournal,
  fillInconclusiveAssessment,
  freshCheckpoint,
  GENERAL_FEEDBACK,
  GENERAL_REQUEST,
  GROUP_PLAN,
  historicalAdjudicationInstructions,
  historicalReviewInstructions,
  IMPLEMENTATION_CASES,
  INITIAL_CHECKPOINT_DIGEST,
  loadBaselineInstructions,
  loadEfficiencyCheckpoint,
  parseClaudeStream,
  PLANNED_TURNS,
  probeProblem,
  repeatedSignatureCount,
  REVISION_RATIONALE,
  REVIEW_EFFICIENCY_ROUTE,
  rolesForCase,
  runReviewEfficiencyExperiment,
  streamJsonInvocation,
  substituteInstructions,
  validateEfficiencyDocument,
  validateEfficiencyStageAndOutput,
  validateStageLayout,
  VERIFICATION_TEXT,
  writeStagedOutput,
  usageFromTerminal,
  type CaseId,
  type DispositionRecord,
  type EfficiencyBinding,
  type EfficiencyCaseFixture,
  type EfficiencyCheckpoint,
  type EfficiencyObservationDocument,
  type ObservationAggregates,
} from "../helpers/review-efficiency/index.js";

const repositoryRoot = fileURLToPath(new URL("../../", import.meta.url));
const utf8 = new TextEncoder();
const decode = (bytes: Uint8Array): string => new TextDecoder().decode(bytes);
const digest = (character: string) => parseSha256Digest(character.repeat(64));

// A full-shaped stub binding: the journal only compares it byte-wise, but the observation
// document embeds its route, provenance, and policy digests, so every field must be present.
const fakeBinding = Object.freeze({
  experiment_version: "1",
  marker: "unit-journal",
  source_commit: "1".repeat(40),
  requested_route: { model: "claude-opus-5", effort: "high" },
  baseline_provenance: {
    source_commit: "0".repeat(40),
    envelopes_blob: "0".repeat(40),
    simple_review_blob: "0".repeat(40),
  },
  baseline_instructions_digest: digest("0"),
  rubric_digests: { design: digest("0"), phase_impl: digest("1") },
  constitution_slots_digest: digest("2"),
  output_schema_digests: { review: digest("3"), adjudication: digest("4") },
  cases: [],
  group_plan: GROUP_PLAN,
}) as unknown as EfficiencyBinding;

const temporaryStage = async (): Promise<string> => mkdtemp(join(tmpdir(), "review-efficiency-unit-"));

// ---------------------------------------------------------------------------
// Historical baseline fixture
// ---------------------------------------------------------------------------

describe("historical baseline fixture", () => {
  it("is a canonical document carrying the captured provenance", async () => {
    const baseline = await loadBaselineInstructions();
    const path = fileURLToPath(new URL("../fixtures/review-efficiency/baseline-instructions.json", import.meta.url));
    const bytes = new Uint8Array(await readFile(path));
    const parsed = parseCanonicalDocument(bytes, "baseline instructions fixture");
    expect(decode(bytes)).toBe(decode(canonicalJsonBytes(parsed.value)));
    expect(baseline.provenance.source_commit).toBe("202bd38793d662c1e4594d6d5fdfb27684e4b826");
    expect(baseline.provenance.envelopes_path).toBe("src/review/envelopes.ts");
    expect(baseline.provenance.envelopes_blob).toBe("325e456235c260a550929a7116484b9ed819e99c");
    expect(baseline.provenance.simple_review_path).toBe("src/review/simple-review.ts");
    expect(baseline.provenance.simple_review_blob).toBe("415dcada5ba1170af9bc2911970087298c5bc2f2");
    expect(baseline.provenance.captured).toContain("never executed or imported");
    expect(Object.keys(baseline.instructions).sort()).toEqual([
      "adjudication_enforcement_context",
      "diff",
      "document_review",
      "general_assignment",
      "implementation_review",
      "prior_triage",
      "test_assignment",
    ]);
  });

  it("stores only strings that appear verbatim in the pinned historical blobs", async () => {
    const baseline = await loadBaselineInstructions();
    const envelopes = execFileSync("git", ["cat-file", "blob", baseline.provenance.envelopes_blob], {
      cwd: repositoryRoot, encoding: "utf8", maxBuffer: 1 << 24,
    });
    const simpleReview = execFileSync("git", ["cat-file", "blob", baseline.provenance.simple_review_blob], {
      cwd: repositoryRoot, encoding: "utf8", maxBuffer: 1 << 24,
    });
    for (const [name, entry] of Object.entries(baseline.instructions)) {
      const text = entry as string;
      // The implementation review is the composed form `${document_review} ${tail}`: the source
      // pins the tail as a template remainder, never the composed string.
      const tail = text.startsWith(`${baseline.instructions.document_review} `)
        ? text.slice(baseline.instructions.document_review.length + 1)
        : text;
      expect({ name, contained: envelopes.includes(text) || simpleReview.includes(text) || envelopes.includes(tail) })
        .toEqual({ name, contained: true });
    }
    expect(baseline.instructions.implementation_review.startsWith(`${baseline.instructions.document_review} `)).toBe(true);
    expect(baseline.instructions.document_review).not.toBe(baseline.instructions.implementation_review);
  });
});

// ---------------------------------------------------------------------------
// Frozen case fixtures, oracles, and envelope pairs
// ---------------------------------------------------------------------------

let fixtures: Awaited<ReturnType<typeof buildEfficiencyFixtures>> | undefined;

beforeAll(async () => {
  fixtures = await buildEfficiencyFixtures(repositoryRoot);
}, 300_000);

afterAll(async () => {
  await fixtures?.cleanup();
  fixtures = undefined;
});

const priorTriageCases = (caseId: CaseId): boolean =>
  caseId === "localized-correction" || caseId === "correction-regression";

describe("case fixtures and envelope pairs", () => {
  it("builds one fixture per frozen case with the planned roles and passes the executable oracles", async () => {
    const built = fixtures!;
    expect([...built.cases.keys()].sort()).toEqual([...CASE_IDS].sort());
    await built.runOracles();
    for (const caseId of CASE_IDS) {
      const fixture = built.cases.get(caseId)!;
      expect(fixture.roles).toEqual(rolesForCase(caseId));
      if (DOCUMENT_CASES.includes(caseId)) {
        expect(fixture.verification_entry).toBeUndefined();
        expect(fixture.workspace).toBeUndefined();
        expect(fixture.diffs).toBeUndefined();
      } else {
        expect(fixture.verification_entry?.kind).toBe("verification-transcript");
        expect(fixture.workspace).toBeDefined();
        expect(fixture.diffs).toBeDefined();
      }
    }
  }, 60_000);

  it("pins fixture commit dates so rebuilds under a different ambient environment bind identically", async () => {
    const built = fixtures!;
    // Direct oracle: every fixture commit carries the pinned author and committer dates, so any
    // stale captured environment that lets wall-clock reach git fails here deterministically —
    // two in-process builds alone could collide within Git's one-second timestamp resolution.
    const commitLines = (repository: NonNullable<EfficiencyCaseFixture["repository"]>): string[] =>
      repository.git("log", "--format=%H %aI %cI").split("\n");
    const firstCommits = new Map(CASE_IDS.map((caseId) => {
      const repository = built.cases.get(caseId)!.repository;
      return [caseId, repository === undefined ? undefined : commitLines(repository)] as const;
    }));
    for (const [, lines] of firstCommits) {
      for (const line of lines ?? []) {
        const [, authorDate, committerDate] = line.split(" ");
        expect(authorDate!.startsWith("2026-01-01T00:00:00")).toBe(true);
        expect(committerDate!.startsWith("2026-01-01T00:00:00")).toBe(true);
      }
    }
    // A second build under a deliberately different ambient date environment must reproduce the
    // exact commit identities: the per-call environment evaluation lets the fixture pin dominate
    // whatever ambient state exists at commit time.
    process.env.GIT_AUTHOR_DATE = "1999-12-31T23:59:59+0000";
    process.env.GIT_COMMITTER_DATE = "1999-12-31T23:59:59+0000";
    let second: Awaited<ReturnType<typeof buildEfficiencyFixtures>> | undefined;
    try {
      second = await buildEfficiencyFixtures(repositoryRoot);
      for (const [caseId, lines] of firstCommits) {
        const repository = second.cases.get(caseId)!.repository;
        if (lines === undefined) {
          expect(repository).toBeUndefined();
          continue;
        }
        expect(repository!.git("log", "--format=%H %aI %cI").split("\n")).toEqual(lines);
      }
    } finally {
      delete process.env.GIT_AUTHOR_DATE;
      delete process.env.GIT_COMMITTER_DATE;
      await second?.cleanup();
    }
  }, 300_000);

  it("pins truthful per-case producer verification samples", () => {
    expect(VERIFICATION_TEXT["document-control"]).toBe("");
    expect(VERIFICATION_TEXT["document-defect"]).toBe("");
    const unchanged = VERIFICATION_TEXT["unchanged-caller-defect"]!;
    expect(unchanged).toContain("did not exercise the summary consumer");
    expect(unchanged).not.toContain("(0)");
    const regression = VERIFICATION_TEXT["correction-regression"]!;
    expect(regression).not.toMatch(/\(0\)/u);
    for (const caseId of IMPLEMENTATION_CASES) {
      expect(VERIFICATION_TEXT[caseId]!.length).toBeGreaterThan(0);
    }
  });

  it("proves pair parity for every case and role", () => {
    const built = fixtures!;
    for (const caseId of CASE_IDS) {
      const fixture = built.cases.get(caseId)!;
      assertPairParity(fixture.envelopes.new.general, fixture.envelopes.old.general, { label: `${caseId}/general` });
      if (fixture.envelopes.new.test !== undefined && fixture.envelopes.old.test !== undefined) {
        assertPairParity(fixture.envelopes.new.test, fixture.envelopes.old.test, { label: `${caseId}/test` });
      }
      const newConstitution = fixture.envelopes.new.constitution;
      const oldConstitution = fixture.envelopes.old.constitution;
      if (newConstitution !== undefined && oldConstitution !== undefined) {
        assertPairParity(newConstitution.envelope, oldConstitution.envelope, {
          normalizeSourceDigest: true, label: `${caseId}/constitution`,
        });
      }
    }
  }, 30_000);

  it("derives the historical variant by substituting exactly the composed instruction object", () => {
    const built = fixtures!;
    const baseline = built.baseline;
    for (const caseId of CASE_IDS) {
      const fixture = built.cases.get(caseId)!;
      const isDocument = DOCUMENT_CASES.includes(caseId);
      const pairs = [
        ["general", "general"],
        ["test", "tests"],
      ] as const;
      for (const [role, focus] of pairs) {
        const current = fixture.envelopes.new[role];
        const historical = fixture.envelopes.old[role];
        if (current === undefined || historical === undefined) continue;
        const composed = historicalReviewInstructions({
          baseline,
          rubricKind: isDocument ? "document" : "implementation",
          focus,
          hasDiffs: !isDocument,
          hasPriorTriage: priorTriageCases(caseId),
        });
        expect(decodeEnvelopeDocument(historical).instructions).toEqual(composed);
      }
    }
  }, 30_000);

  it("adapts only the historical output format while both variants require explicit feedback", () => {
    const built = fixtures!;
    const oldFormat = "Prefer a JSON object with one report string; no finding taxonomy, IDs, or ordering are required.";
    for (const fixture of built.cases.values()) {
      const baselineReview = DOCUMENT_CASES.includes(fixture.case_id)
        ? built.baseline.instructions.document_review
        : built.baseline.instructions.implementation_review;
      for (const role of ["general", "test"] as const) {
        const historical = fixture.envelopes.old[role];
        const current = fixture.envelopes.new[role];
        if (historical === undefined || current === undefined) continue;
        const oldReview = (decodeEnvelopeDocument(historical).instructions as Record<string, string>).review!;
        const newReview = prepareReviewInputs(current).instructions;
        const [prefix, suffix] = baselineReview.split(oldFormat);
        expect(oldReview.startsWith(prefix!)).toBe(true);
        expect(oldReview.endsWith(suffix!)).toBe(true);
        for (const review of [oldReview, newReview]) {
          expect(review).toContain("JSON object with outcome and feedback");
          expect(review).toContain("outcome=issues_found");
          expect(review).toContain("outcome=no_issues_found");
          expect(review).not.toContain("one report string");
        }
      }
    }
    expect(built.baseline.instructions.document_review).toContain(oldFormat);
  });

  it("delivers different instruction variants with identical files through the production renderer", () => {
    for (const fixture of fixtures!.cases.values()) {
      for (const role of ["general", "test"] as const) {
        const current = fixture.envelopes.new[role];
        const historical = fixture.envelopes.old[role];
        if (current === undefined || historical === undefined) continue;
        const newInput = prepareReviewInputs(current);
        const oldInput = prepareReviewInputs(historical);
        expect(newInput.files).toEqual(oldInput.files);
        expect(newInput.instructions).toContain("plausible consequential failure");
        expect(oldInput.instructions).not.toContain("plausible consequential failure");
        expect(newInput.instructions).not.toBe(oldInput.instructions);
      }
    }
  });

  it("carries unchanged adjudication literals and gives adjudication the full diff only", () => {
    const built = fixtures!;
    const baseline = built.baseline;
    for (const caseId of IMPLEMENTATION_CASES) {
      const fixture = built.cases.get(caseId)!;
      const currentDocument = decodeEnvelopeDocument(fixture.envelopes.new.constitution!.envelope);
      const historicalDocument = decodeEnvelopeDocument(fixture.envelopes.old.constitution!.envelope);
      const current = prepareReviewInputs(fixture.envelopes.new.constitution!.envelope).instructions;
      const historical = historicalDocument.instructions as Record<string, PlainJsonValue>;
      expect(historical.enforcement_context).toBe(baseline.instructions.adjudication_enforcement_context);
      expect(historical.changes).toBe(baseline.instructions.diff);
      expect(current).toContain("plausible consequential failure");
      const oldPrompt = prepareReviewInputs(fixture.envelopes.old.constitution!.envelope).instructions;
      expect(oldPrompt).toContain(String(historical.enforcement_context));
      expect(oldPrompt).toContain("exactly one judgment per supplied rule slot");
      expect(Object.keys(currentDocument.diffs as Record<string, PlainJsonValue>)).toEqual(["full"]);
      // Each variant's derived binding names its own ordinary general envelope.
      expect(currentDocument.source_review_envelope_digest).toBe(fixture.envelopes.new.general.digest);
      expect(historicalDocument.source_review_envelope_digest).toBe(fixture.envelopes.old.general.digest);
      const subjectOf = (document: ReturnType<typeof decodeEnvelopeDocument>): PlainJsonValue | undefined => {
        const subject = document.subject;
        return subject !== null && typeof subject === "object" && !Array.isArray(subject)
          ? (subject as Record<string, PlainJsonValue>).source_review_envelope_digest
          : undefined;
      };
      expect(subjectOf(currentDocument)).toBe(fixture.envelopes.new.general.digest);
      expect(subjectOf(historicalDocument)).toBe(fixture.envelopes.old.general.digest);
    }
  }, 30_000);

  it("pins the prior-round response scoped per reviewer", () => {
    const built = fixtures!;
    const contextOf = (envelope: DispatchEnvelope): readonly Record<string, PlainJsonValue>[] =>
      decodeEnvelopeDocument(envelope).context as readonly Record<string, PlainJsonValue>[];
    const generalContext = contextOf(built.cases.get("localized-correction")!.envelopes.new.general);
    expect(generalContext[0]!.kind).toBe("prior-triage");
    expect(generalContext[0]!.label).toBe("prior-round-response");
    const generalRendered = String(generalContext[0]!.content);
    expect(generalRendered).toContain(GENERAL_FEEDBACK);
    expect(generalRendered).toContain(GENERAL_REQUEST);
    expect(generalRendered).toContain(REVISION_RATIONALE);
    expect(generalRendered).not.toContain("existing checks do not exercise");
    const testContext = contextOf(built.cases.get("localized-correction")!.envelopes.new.test!);
    const testRendered = String(testContext[0]!.content);
    // Quote-free substrings: the rendered JSON escapes the literal's embedded quotes.
    expect(testRendered).toContain("The existing checks do not exercise summary for any input");
    expect(testRendered).toContain("Verify the consumer behavior is covered");
    expect(testRendered).not.toContain("The reviewed change makes formatCount return a number");
    expect(contextOf(built.cases.get("document-defect")!.envelopes.new.general)).toEqual([]);
  }, 30_000);

  it("keeps adapter-built invocations intact under the stream transformation, per access shape", async () => {
    const built = fixtures!;
    const adapter = selectCliAdapter("claude", REVIEW_EFFICIENCY_ROUTE);
    // No-view document case: created per group at run time, exactly as the runner does.
    const documentWorkspace = await createDispatchWorkspace("claude-cli", repositoryRoot);
    try {
      const documentFixture = built.cases.get("document-control")!;
      const documentInvocation = streamJsonInvocation(await adapter.buildInvocation(
        documentFixture.envelopes.old.general, REVIEW_EFFICIENCY_ROUTE, documentWorkspace, documentFixture.output_schema,
      ));
      expect(documentInvocation.argv[documentInvocation.argv.indexOf("--tools") + 1]).toBe("Read,Grep,Glob");
      expect(documentInvocation.argv).toContain("--add-dir");
      expect(documentInvocation.cwd).toBe(documentWorkspace.root);
      expect(documentInvocation.argv[documentInvocation.argv.indexOf("--output-format") + 1]).toBe("stream-json");
      expect(documentInvocation.argv[documentInvocation.argv.length - 1]).toBe("--verbose");
      expect(documentInvocation.argv[documentInvocation.argv.indexOf("--setting-sources") + 1]).toBe("");
      expect(documentInvocation.argv).toContain("--no-session-persistence");
      expect(documentInvocation.argv).toContain("--safe-mode");
    } finally {
      await documentWorkspace.dispose();
    }
    // Materialized-diff implementation case: the fixture workspace carries the sealed view.
    const implementationFixture = built.cases.get("unchanged-caller-defect")!;
    const viewInvocation = streamJsonInvocation(await adapter.buildInvocation(
      implementationFixture.envelopes.new.test!, REVIEW_EFFICIENCY_ROUTE, implementationFixture.workspace!, implementationFixture.output_schema,
    ));
    const argv = [...viewInvocation.argv];
    expect(argv[argv.indexOf("--tools") + 1]).toBe("Read,Grep,Glob");
    expect(argv[argv.indexOf("--add-dir") + 1]).toBe(join(implementationFixture.workspace!.review_root!, "review-inputs", "test"));
    expect(argv[argv.indexOf("--output-format") + 1]).toBe("stream-json");
    expect(argv[argv.length - 1]).toBe("--verbose");
    expect(viewInvocation.stdin).toBeUndefined();
    expect(argv.join("\n")).toContain("@review-inputs/test/");
  }, 60_000);

  it("seals an empty full patch and the exact defect-to-correction revision patch", async () => {
    const built = fixtures!;
    const fixture = built.cases.get("localized-correction")!;
    const diffsDir = join(fixture.workspace!.root, "review-diffs");
    const general = fixture.diffs!.reviewers.get("general")!;
    expect(fixture.diffs!.full.patch.byte_count).toBe(0);
    expect(general.revision).toBeDefined();
    expect(general.revision!.patch.byte_count).toBeGreaterThan(0);
    const revisionText = decode(await readFile(join(diffsDir, basename(general.revision!.patch.path))));
    expect(revisionText).toContain("-export const formatCount = (value) => Number(value);");
    expect(revisionText).toContain("+export const formatCount = (value) => String(value);");
    const document = decodeEnvelopeDocument(fixture.envelopes.new.general);
    const documentDiffs = document.diffs as Record<string, PlainJsonValue>;
    expect(Object.keys(documentDiffs).sort()).toEqual(["full", "revision"]);
  }, 30_000);
});

// ---------------------------------------------------------------------------
// Instruction substitution mechanics
// ---------------------------------------------------------------------------

describe("instruction substitution", () => {
  const rubric = {
    schema_version: "1",
    kind: "artifact",
    mode: "adversarial",
    criteria: [{ id: "contract-match", text: "Match the approved contract.", blocking: true }],
  } as const;
  const envelope = (): DispatchEnvelope => buildReviewEnvelope({
    artifact: "# Review Subject\n\nSubstitution contract.\n",
    rubric,
    context: [],
    subject: {
      task_id: parseTaskSlug("review-efficiency"),
      phase_instance: parsePhaseInstanceId("design"),
      role: "counter-review",
      step: "counter_review",
      attempt: parseSafeInteger(1),
      subject_digest: digest("a"),
      input_fingerprint: digest("b"),
      rubric_digest: digest("c"),
      producer_family: "claude",
      invocation_id: parseSafeId("invocation-unit-substitute"),
      result_id: parseSafeId("result-unit-substitute"),
    },
  });

  it("re-serializes exactly as the production finisher and recomputes the domain-tagged digest", () => {
    const replaced = substituteInstructions(envelope(), { review: "Historical instruction." }, "dispatch-envelope");
    const document = decodeEnvelopeDocument(replaced);
    expect(document.instructions).toEqual({ review: "Historical instruction." });
    expect(replaced.bytes[replaced.bytes.byteLength - 1]).toBe(0x0a);
    expect(replaced.byte_count).toBe(replaced.bytes.byteLength);
    expect(replaced.digest).toBe(canonicalJsonDigest({ ...document, digest_kind: "dispatch-envelope" }));
  });

  it("rejects a substitution that exceeds the rendered prompt byte limit", () => {
    expect(() => substituteInstructions(envelope(), { review: "x".repeat(REVIEW_PROMPT_BYTE_LIMIT + 1) }, "dispatch-envelope"))
      .toThrow(ReviewInputError);
  });

  it("keeps the composed historical adjudication order with carried literals", () => {
    const baseline = fixtures!.baseline;
    const composed = historicalAdjudicationInstructions({
      baseline,
      currentInstructions: {
        rule_coverage: "Cover every rule.",
        uncertainty: "Report uncertainty.",
        trigger: "Triggers are mechanical.",
        implementation_scope: "Implementation scope.",
      },
      hasDiffs: true,
    });
    expect(Object.keys(composed)).toEqual([
      "rule_coverage", "changes", "enforcement_context", "uncertainty", "trigger", "implementation_scope",
    ]);
    expect(composed.enforcement_context).toBe(baseline.instructions.adjudication_enforcement_context);
    expect(composed.changes).toBe(baseline.instructions.diff);
  });
});

// ---------------------------------------------------------------------------
// Stream observation
// ---------------------------------------------------------------------------

describe("stream observation", () => {
  const streamBytes = (...events: unknown[]): Uint8Array =>
    utf8.encode(`${events.map((event) => JSON.stringify(event)).join("\n")}\n`);

  const toolUse = (id: string, input: PlainJsonValue, name = "Read"): unknown => ({
    type: "assistant",
    message: { content: [{ type: "tool_use", id, name, input }] },
  });
  const toolResult = (id: string, isError = false): unknown => ({
    type: "user",
    message: { content: [{ type: "tool_result", tool_use_id: id, is_error: isError }] },
  });
  const terminal = (overrides: Record<string, PlainJsonValue> = {}): unknown => ({
    type: "result",
    subtype: "success",
    is_error: false,
    model: "claude-opus-5",
    usage: { input_tokens: 100, output_tokens: 40, cache_creation_input_tokens: 0, cache_read_input_tokens: 3 },
    structured_output: { outcome: "no_issues_found", feedback: "Reviewed change; no material findings." },
    ...overrides,
  });

  it("parses one terminal wrapper, deduped read-only tool calls, and their result status", () => {
    const parsed = parseClaudeStream(streamBytes(
      toolUse("toolu_1", { file_path: "src/format-count.js" }),
      toolResult("toolu_1"),
      terminal(),
    ));
    expect(parsed.toolCalls).toHaveLength(1);
    const call = parsed.toolCalls[0]!;
    expect(call.name).toBe("Read");
    expect(call.repeated).toBe(false);
    expect(call.result_error).toBe(false);
    expect(call.signature).toBe(sha256Bytes(canonicalJsonBytes({ name: "Read", input: { file_path: "src/format-count.js" } })));
    expect(parsed.terminal).toEqual(terminal());
    expect(usageFromTerminal(parsed.terminal).usage).toEqual({
      input_tokens: 100, output_tokens: 40, cache_creation_input_tokens: 0, cache_read_input_tokens: 3,
    });
    expect(usageFromTerminal(parsed.terminal).usage_raw).toEqual((terminal() as Record<string, PlainJsonValue>).usage);
  });

  it("counts an identical id replay once and a different-input reuse as invalid", () => {
    const identical = parseClaudeStream(streamBytes(
      toolUse("toolu_1", { file_path: "a.js" }),
      toolUse("toolu_1", { file_path: "a.js" }),
      terminal(),
    ));
    expect(identical.toolCalls).toHaveLength(1);
    expect(identical.toolCalls[0]!.repeated).toBe(false);
    expect(() => parseClaudeStream(streamBytes(
      toolUse("toolu_1", { file_path: "a.js" }),
      toolUse("toolu_1", { file_path: "b.js" }),
      terminal(),
    ))).toThrow(/reused with different bytes/u);
    const repeated = parseClaudeStream(streamBytes(
      toolUse("toolu_1", { file_path: "a.js" }),
      toolUse("toolu_2", { file_path: "a.js" }),
      terminal(),
    ));
    expect(repeated.toolCalls).toHaveLength(2);
    expect(repeatedSignatureCount(repeated.toolCalls)).toBe(1);
  });

  it("carries a failed tool result and rejects unknown tools and malformed blocks", () => {
    const failed = parseClaudeStream(streamBytes(
      toolUse("toolu_1", { file_path: "a.js" }),
      toolResult("toolu_1", true),
      terminal(),
    ));
    expect(failed.toolCalls[0]!.result_error).toBe(true);
    expect(() => parseClaudeStream(streamBytes(toolUse("toolu_1", {}, "Bash"), terminal()))).toThrow(/unknown tool/u);
    expect(() => parseClaudeStream(streamBytes({ type: "assistant", message: { content: [{ type: "tool_use", input: {} }] } }, terminal())))
      .toThrow(/no tool-use id/u);
    expect(() => parseClaudeStream(streamBytes({ type: "assistant", message: { content: [{ type: "tool_use", id: "toolu_1" }] } }, terminal())))
      .toThrow(/no input/u);
  });

  it("records the CLI's StructuredOutput emission separately from investigation activity", () => {
    const parsed = parseClaudeStream(streamBytes(
      toolUse("toolu_1", { file_path: "a.js" }),
      toolUse("toolu_out", { outcome: "no_issues_found", feedback: "final answer" }, "StructuredOutput"),
      toolResult("toolu_1"),
      toolResult("toolu_out"),
      terminal(),
    ));
    expect(parsed.toolCalls.map((call) => call.name)).toEqual(["Read"]);
    expect(parsed.structuredOutputCalls).toHaveLength(1);
    expect(parsed.structuredOutputCalls[0]!.name).toBe("StructuredOutput");
    expect(parsed.structuredOutputCalls[0]!.input).toEqual({ outcome: "no_issues_found", feedback: "final answer" });
    expect(parsed.structuredOutputCalls[0]!.result_error).toBe(false);
    expect(repeatedSignatureCount([...parsed.toolCalls, ...parsed.structuredOutputCalls])).toBe(0);
  });

  it("captures the stream-reported model: init as fallback, last real assistant voice as authority", () => {
    const fromAssistant = parseClaudeStream(streamBytes(
      { type: "system", subtype: "init", model: "claude-opus-5" },
      { type: "assistant", message: { model: "claude-opus-5-20260115", content: [{ type: "text", text: "Working." }] } },
      { type: "assistant", message: { model: "<synthetic>", content: [{ type: "text", text: "error voice" }] } },
      terminal(),
    ));
    expect(fromAssistant.model).toBe("claude-opus-5-20260115");
    const fromInit = parseClaudeStream(streamBytes(
      { type: "system", subtype: "init", model: "claude-opus-5" },
      terminal(),
    ));
    expect(fromInit.model).toBe("claude-opus-5");
    expect(parseClaudeStream(streamBytes(terminal())).model).toBeUndefined();
  });

  it("rejects malformed lines, wrong terminal counts, and events after the terminal", () => {
    expect(() => parseClaudeStream(utf8.encode("not-json\n"))).toThrow(/malformed or truncated/u);
    expect(() => parseClaudeStream(new Uint8Array([0xff, 0xfe, 0x0a]))).toThrow(/not valid UTF-8/u);
    expect(() => parseClaudeStream(streamBytes(toolUse("toolu_1", {})))).toThrow(/exactly one terminal/u);
    expect(() => parseClaudeStream(streamBytes(terminal(), terminal()))).toThrow(/follow the terminal/u);
    expect(() => parseClaudeStream(streamBytes(terminal(), toolResult("toolu_1")))).toThrow(/follow the terminal/u);
  });

  it("normalizes usage per field and never invents zeros", () => {
    expect(usageFromTerminal({}).usage).toEqual({});
    expect(usageFromTerminal({}).usage_raw).toBeUndefined();
    const partial = usageFromTerminal({
      usage: { input_tokens: 10, output_tokens: -1, cache_creation_input_tokens: "many", cache_read_input_tokens: 1.5 },
    });
    expect(partial.usage).toEqual({ input_tokens: 10 });
  });

  it("aggregates each usage field only when every contributor exposes it", () => {
    expect(aggregateUsage([])).toEqual({});
    const complete = aggregateUsage([
      { input_tokens: 10, output_tokens: 2, cache_creation_input_tokens: 1, cache_read_input_tokens: 0 },
      { input_tokens: 5, output_tokens: 1, cache_creation_input_tokens: 0, cache_read_input_tokens: 4 },
    ]);
    expect(complete).toEqual({ input_tokens: 15, output_tokens: 3, cache_creation_input_tokens: 1, cache_read_input_tokens: 4 });
    const partial = aggregateUsage([
      { input_tokens: 10, output_tokens: 2, cache_creation_input_tokens: 1 },
      { input_tokens: 5, output_tokens: 1 },
    ]);
    expect(partial).toEqual({ input_tokens: 15, output_tokens: 3 });
  });
});

// ---------------------------------------------------------------------------
// Test-only stream transformation
// ---------------------------------------------------------------------------

describe("stream-json invocation transform", () => {
  const invocation = (tools: string, addDir = true) => ({
    adapter: "claude-cli" as const,
    command: "claude",
    argv: [
      "-p", "--safe-mode", "--tools", tools,
      ...(addDir ? ["--add-dir", "/tmp/view/review-diffs"] : []),
      "--disable-slash-commands", "--strict-mcp-config", "--mcp-config", "/tmp/view/empty-mcp.json",
      "--no-session-persistence", "--setting-sources", "", "--output-format", "json",
      "--json-schema", '{"type":"object"}', "--model", "claude-opus-5", "--effort", "high",
    ],
    cwd: "/tmp/view",
    env: { PATH: "/usr/bin" },
    stdin: utf8.encode("envelope"),
  });

  it("changes only the output format value and appends --verbose", () => {
    const materialized = invocation("Read,Grep,Glob");
    const transformed = streamJsonInvocation(materialized);
    const expected = [...materialized.argv];
    expected[expected.indexOf("json")] = "stream-json";
    expected.push("--verbose");
    expect([...transformed.argv]).toEqual(expected);
    expect(transformed.command).toBe(materialized.command);
    expect(transformed.cwd).toBe(materialized.cwd);
    expect(transformed.env).toBe(materialized.env);
    expect(Buffer.compare(Buffer.from(transformed.stdin!), Buffer.from(materialized.stdin!))).toBe(0);
    const noView = streamJsonInvocation(invocation(""));
    expect(noView.argv[noView.argv.indexOf("--tools") + 1]).toBe("");
  });

  it("rejects invocations that do not carry exactly one production json format flag", () => {
    expect(() => streamJsonInvocation({
      ...invocation("Read"),
      argv: ["-p", "--output-format", "json", "--output-format", "json"],
    })).toThrow(/exactly one --output-format/u);
    expect(() => streamJsonInvocation({
      ...invocation("Read"),
      argv: ["-p", "--safe-mode", "--tools", "Read", "--setting-sources", "", "--model", "claude-opus-5"],
    })).toThrow(/exactly one --output-format/u);
    expect(() => streamJsonInvocation({ ...invocation("Read"), argv: ["-p", "--output-format", "stream-json"] }))
      .toThrow(/not the production json form/u);
  });
});

// ---------------------------------------------------------------------------
// Checkpoint journal and stage rules
// ---------------------------------------------------------------------------

const canonicalBytes = (value: unknown): Uint8Array => canonicalJsonBytes(value as PlainJsonValue);

describe("checkpoint journal", () => {
  it("starts every fresh checkpoint from the empty-byte chain root", () => {
    const checkpoint = freshCheckpoint(fakeBinding);
    expect(checkpoint.prior_digest).toBe(INITIAL_CHECKPOINT_DIGEST);
    expect(checkpoint.generation).toBe(1);
    expect(checkpoint.groups).toHaveLength(GROUP_PLAN.length);
    expect(dispositionSlots(checkpoint)).toHaveLength(PLANNED_TURNS);
  });

  it("promotes an extending pending file and discards a non-extending one", async () => {
    const stage = await temporaryStage();
    try {
      const canonical = freshCheckpoint(fakeBinding);
      await writeFile(join(stage, "checkpoint.json"), canonicalBytes(canonical));
      const pending = JSON.parse(decode(canonicalBytes(canonical))) as Record<string, unknown>;
      pending.generation = 2;
      pending.prior_digest = checkpointDocumentDigest(canonical);
      (pending.groups as { status: string }[])[0]!.status = "completed";
      await writeFile(join(stage, "checkpoint.pending"), canonicalBytes(pending));
      const layout = await validateStageLayout(stage, join(stage, "out.json"));
      expect(layout.mode).toBe("resume-pending");
      const loaded = await loadEfficiencyCheckpoint(stage, fakeBinding, layout);
      expect(loaded.generation).toBe(2);
      expect(loaded.groups[0]!.status).toBe("completed");
      await expect(readdir(stage)).resolves.toEqual(["checkpoint.json"]);

      const stale = JSON.parse(decode(canonicalBytes(loaded))) as Record<string, unknown>;
      stale.generation = 3;
      stale.prior_digest = digest("0");
      await writeFile(join(stage, "checkpoint.pending"), canonicalBytes(stale));
      const discarded = await loadEfficiencyCheckpoint(stage, fakeBinding, await validateStageLayout(stage, join(stage, "out.json")));
      expect(discarded.generation).toBe(2);
      await expect(readdir(stage)).resolves.toEqual(["checkpoint.json"]);
    } finally {
      await rm(stage, { recursive: true, force: true });
    }
  });

  it("fails closed on a different experiment binding", async () => {
    const stage = await temporaryStage();
    try {
      await writeFile(join(stage, "checkpoint.json"), canonicalBytes(freshCheckpoint(fakeBinding)));
      const other = { marker: "different" } as unknown as EfficiencyBinding;
      await expect(loadEfficiencyCheckpoint(stage, other, { mode: "resume" }))
        .rejects.toThrow(/different experiment binding/u);
    } finally {
      await rm(stage, { recursive: true, force: true });
    }
  });

  it("marks leftover running records interrupted and bumps the generation", async () => {
    const stage = await temporaryStage();
    try {
      const canonical = JSON.parse(decode(canonicalBytes(freshCheckpoint(fakeBinding)))) as Record<string, unknown>;
      canonical.generation = 4;
      canonical.prior_digest = checkpointDocumentDigest(freshCheckpoint(fakeBinding));
      const groups = canonical.groups as { status: string; roles: { status: string; attempts: Record<string, unknown>[] }[] }[];
      groups[0]!.status = "running";
      groups[0]!.roles[0]!.status = "running";
      groups[0]!.roles[0]!.attempts.push({ index: 1, status: "running", started_at: "2026-09-16T00:00:00.000Z" });
      (canonical.preflight_runs as Record<string, unknown>[]).push({ status: "running", started_at: "2026-09-16T00:00:00.000Z" });
      await writeFile(join(stage, "checkpoint.json"), canonicalBytes(canonical));
      const loaded = await loadEfficiencyCheckpoint(stage, fakeBinding, { mode: "resume" });
      expect(loaded.generation).toBe(5);
      expect(loaded.preflight_runs[0]!.status).toBe("interrupted");
      expect(loaded.groups[0]!.status).toBe("pending");
      expect(loaded.groups[0]!.roles[0]!.status).toBe("pending");
      expect(loaded.groups[0]!.roles[0]!.attempts[0]!.status).toBe("interrupted");
    } finally {
      await rm(stage, { recursive: true, force: true });
    }
  });

  it("serializes updates through the mutex with a generation and digest chain on disk", async () => {
    const stage = await temporaryStage();
    try {
      const initial = freshCheckpoint(fakeBinding);
      const journal = new EfficiencyJournal(stage, initial);
      await journal.update((draft) => {
        draft.groups[0]!.status = "running";
      });
      const generation2 = JSON.parse(decode(new Uint8Array(await readFile(join(stage, "checkpoint.json"))))) as { generation: number; prior_digest: string; groups: { status: string }[] };
      expect(generation2.generation).toBe(2);
      expect(generation2.prior_digest).toBe(checkpointDocumentDigest(initial));
      expect(generation2.groups[0]!.status).toBe("running");
      const generation2Digest = checkpointDocumentDigest(journal.value);
      await journal.update((draft) => {
        draft.groups[0]!.status = "completed";
      });
      const generation3 = JSON.parse(decode(new Uint8Array(await readFile(join(stage, "checkpoint.json"))))) as { generation: number; prior_digest: string };
      expect(generation3.generation).toBe(3);
      expect(generation3.prior_digest).toBe(generation2Digest);
      await expect(readdir(stage)).resolves.toEqual(["checkpoint.json"]);
    } finally {
      await rm(stage, { recursive: true, force: true });
    }
  });

  it("rejects unexpected stage contents, pending without canonical, and an existing output", async () => {
    const stage = await temporaryStage();
    try {
      await writeFile(join(stage, "notes.txt"), "stray");
      await expect(validateStageLayout(stage, join(stage, "out.json"))).rejects.toThrow(/unexpected entries/u);
    } finally {
      await rm(stage, { recursive: true, force: true });
    }
    const pendingOnly = await temporaryStage();
    try {
      await writeFile(join(pendingOnly, "checkpoint.pending"), canonicalBytes(freshCheckpoint(fakeBinding)));
      await expect(validateStageLayout(pendingOnly, join(pendingOnly, "out.json"))).rejects.toThrow(/pending file without a canonical checkpoint/u);
    } finally {
      await rm(pendingOnly, { recursive: true, force: true });
    }
    const withOutput = await temporaryStage();
    try {
      await writeFile(join(withOutput, "review-efficiency.json"), "{}\n");
      // The stray-entry check fails closed first, naming the output path either way.
      await expect(validateStageLayout(withOutput, join(withOutput, "review-efficiency.json")))
        .rejects.toThrow(/unexpected entries: review-efficiency\.json/u);
    } finally {
      await rm(withOutput, { recursive: true, force: true });
    }
  });
});

describe("stage and output path rules", () => {
  it("requires explicit absolute stage and output paths under the temporary directory", async () => {
    await expect(validateEfficiencyStageAndOutput({})).rejects.toThrow(/explicit absolute path/u);
    await expect(validateEfficiencyStageAndOutput({
      ARCHFLOW_REVIEW_EFFICIENCY_STAGE: "relative/stage",
      ARCHFLOW_REVIEW_EFFICIENCY_OUTPUT: "/tmp/out.json",
    })).rejects.toThrow(/explicit absolute path/u);
    await expect(validateEfficiencyStageAndOutput({
      ARCHFLOW_REVIEW_EFFICIENCY_STAGE: join(repositoryRoot, "does-not-exist"),
      ARCHFLOW_REVIEW_EFFICIENCY_OUTPUT: join(repositoryRoot, "out.json"),
    })).rejects.toThrow(/does not exist/u);
    await expect(validateEfficiencyStageAndOutput({
      ARCHFLOW_REVIEW_EFFICIENCY_STAGE: join(repositoryRoot, "docs"),
      ARCHFLOW_REVIEW_EFFICIENCY_OUTPUT: join(repositoryRoot, "docs", "out.json"),
    })).rejects.toThrow(/temporary directory/u);
    const stage = await temporaryStage();
    try {
      await expect(validateEfficiencyStageAndOutput({
        ARCHFLOW_REVIEW_EFFICIENCY_STAGE: stage,
        ARCHFLOW_REVIEW_EFFICIENCY_OUTPUT: join(tmpdir(), "elsewhere.json"),
      })).rejects.toThrow(/direct child/u);
      const existing = join(stage, "taken.json");
      await writeFile(existing, "{}\n");
      await expect(validateEfficiencyStageAndOutput({
        ARCHFLOW_REVIEW_EFFICIENCY_STAGE: stage,
        ARCHFLOW_REVIEW_EFFICIENCY_OUTPUT: existing,
      })).rejects.toThrow(/already exists/u);
      const resolved = await validateEfficiencyStageAndOutput({
        ARCHFLOW_REVIEW_EFFICIENCY_STAGE: stage,
        ARCHFLOW_REVIEW_EFFICIENCY_OUTPUT: join(stage, "review-efficiency.json"),
      });
      expect(resolved.stage).toBe(stage);
      expect(resolved.output).toBe(join(stage, "review-efficiency.json"));
    } finally {
      await rm(stage, { recursive: true, force: true });
    }
  });

  it("writes the staged output exactly once", async () => {
    const stage = await temporaryStage();
    try {
      const output = join(stage, "review-efficiency.json");
      const document = buildObservationDocument(freshCheckpoint(fakeBinding));
      await writeStagedOutput(output, document);
      await expect(writeStagedOutput(output, document)).rejects.toThrow();
    } finally {
      await rm(stage, { recursive: true, force: true });
    }
  });
});

// ---------------------------------------------------------------------------
// Probe gate
// ---------------------------------------------------------------------------

function draftCheckpoint(): EfficiencyCheckpoint {
  const checkpoint = JSON.parse(decode(canonicalBytes(freshCheckpoint(fakeBinding)))) as {
    groups: { status: string; roles: { role: string; status: string; attempts: Record<string, unknown>[] }[] }[];
  };
  return checkpoint as unknown as EfficiencyCheckpoint;
}

describe("stream-shape probe", () => {
  it("names each measurement loss on the first planned turn and passes a complete probe", () => {
    const checkpoint = draftCheckpoint();
    expect(probeProblem(checkpoint)).toBeUndefined();
    const groups = JSON.parse(decode(canonicalBytes(checkpoint))) as {
      groups: { status: string; roles: { role: string; status: string; attempts: Record<string, unknown>[] }[] }[];
    };
    groups.groups[0]!.status = "completed";
    let mutated = groups as unknown as EfficiencyCheckpoint;
    expect(probeProblem(mutated)).toMatch(/no valid terminal wrapper/u);
    groups.groups[0]!.roles[0]!.status = "succeeded";
    groups.groups[0]!.roles[0]!.attempts.push({ index: 1, status: "succeeded", started_at: "2026-09-16T00:00:00.000Z" });
    mutated = groups as unknown as EfficiencyCheckpoint;
    expect(probeProblem(mutated)).toMatch(/usage fields are unavailable/u);
    (groups.groups[0]!.roles[0]!.attempts[0] as Record<string, unknown>).usage = { input_tokens: 100, output_tokens: 40 };
    mutated = groups as unknown as EfficiencyCheckpoint;
    expect(probeProblem(mutated)).toMatch(/accepted model/u);
    (groups.groups[0]!.roles[0]!.attempts[0] as Record<string, unknown>).accepted_model = "claude-opus-5";
    (groups.groups[0]!.roles[0]!.attempts[0] as Record<string, unknown>).tool_calls = [
      { tool_use_id: "toolu_1", name: "Read", input: {}, signature: digest("0"), repeated: false },
    ];
    mutated = groups as unknown as EfficiencyCheckpoint;
    expect(probeProblem(mutated)).toBeUndefined();
    (groups.groups[0]!.roles[0]!.attempts[0] as Record<string, unknown>).tool_calls = [];
    mutated = groups as unknown as EfficiencyCheckpoint;
    expect(probeProblem(mutated)).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// Full experiment loop with stubbed hosts
// ---------------------------------------------------------------------------

const judgment = (): PlainJsonValue => ({
  compliance: "pass",
  rationale: "No violation observed in the reviewed change.",
  trigger: "not-matched",
  trigger_evidence: "No trigger site exists in the reviewed change.",
});

function stubChild(spec: DispatchChildSpec, overrides: { withoutMeasurements?: boolean; reviewFeedback?: PlainJsonValue; rateLimited?: boolean } = {}): DispatchChildResult {
  const argv = [...spec.argv];
  const tools = argv[argv.indexOf("--tools") + 1] ?? "";
  // The projected output schema, not the child cwd (which is the shared materialized view for
  // view-enabled roles), is what distinguishes an adjudication child from a review child.
  const serializedSchema = argv[argv.indexOf("--json-schema") + 1] ?? "";
  const isAdjudication = serializedSchema.includes("judgments");
  const events: string[] = [];
  if (overrides.rateLimited === true) {
    // A classified, retryable terminal failure whose stream still carries real measurements.
    events.push(JSON.stringify({
      type: "assistant",
      message: {
        model: "claude-opus-5",
        content: [{ type: "text", text: "You've hit your session limit · resets soon" }],
      },
    }));
    events.push(JSON.stringify({
      type: "result",
      subtype: "success",
      is_error: true,
      result: "You've hit your session limit · resets soon",
      usage: { input_tokens: 50, output_tokens: 20, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 },
    }));
    return Object.freeze({
      exit_code: 1,
      signal: null,
      stdout: Buffer.from(`${events.join("\n")}\n`, "utf8"),
      stderr: Buffer.from(""),
    });
  }
  if (tools !== "") {
    events.push(JSON.stringify({
      type: "assistant",
      message: { content: [{ type: "tool_use", id: "toolu_1", name: "Read", input: { file_path: "src/format-count.js" } }] },
    }));
    events.push(JSON.stringify({
      type: "user",
      message: { content: [{ type: "tool_result", tool_use_id: "toolu_1", is_error: false }] },
    }));
  }
  const structured = isAdjudication
    ? { schema_version: "2", judgments: { "scope-a": judgment(), "scope-b": judgment() } }
    : overrides.reviewFeedback ?? { outcome: "no_issues_found", feedback: "Reviewed the declared change; no material findings." };
  // Mirror the real stream shape: the model is reported by the init event and the assistant
  // message; the stream-json terminal itself carries no top-level model.
  events.unshift(JSON.stringify({ type: "system", subtype: "init", model: "claude-opus-5" }));
  events.push(JSON.stringify({
    type: "assistant",
    message: { model: "claude-opus-5", content: [{ type: "text", text: "Final assessment." }] },
  }));
  events.push(JSON.stringify(overrides.withoutMeasurements === true
    ? { type: "result", subtype: "success", is_error: false, structured_output: structured }
    : {
      type: "result",
      subtype: "success",
      is_error: false,
      usage: { input_tokens: 100, output_tokens: 40, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 },
      structured_output: structured,
    }));
  return Object.freeze({
    exit_code: 0,
    signal: null,
    stdout: Buffer.from(`${events.join("\n")}\n`, "utf8"),
    stderr: Buffer.from(""),
  });
}

describe("experiment orchestration with stubbed hosts", () => {
  it("completes all twelve groups with one transient retry and exact aggregates", async () => {
    const stage = await temporaryStage();
    const output = join(stage, "review-efficiency.json");
    try {
      let preflightCalls = 0;
      const calls: DispatchChildSpec[] = [];
      let probeFailedOnce = false;
      const waits: number[] = [];
      const outcome = await runReviewEfficiencyExperiment({
        stage,
        output,
        repositoryRoot,
        preflight: async () => {
          preflightCalls += 1;
          return { cli_version: "2.0.0-stub", managed_policy_present: false, managed_policy_paths: [] };
        },
        runChild: async (spec) => {
          calls.push(spec);
          if (basename(spec.cwd) === "g1-general" && !probeFailedOnce) {
            probeFailedOnce = true;
            throw new DispatchProcessError(createProjectError("TIMEOUT", { adapter: "claude-cli", attempt: 1, limit_ms: 900_000 }));
          }
          return stubChild(spec, basename(spec.cwd) === "g2-general" ? {
            reviewFeedback: { outcome: "issues_found", feedback: "The declared contract contradicts the design." },
          } : {});
        },
        wait: async (milliseconds) => {
          waits.push(milliseconds);
        },
      });
      expect(outcome.status).toBe("completed");
      expect(preflightCalls).toBe(1);
      expect(waits).toEqual([1_000]);

      const document = JSON.parse(decode(new Uint8Array(await readFile(output)))) as EfficiencyObservationDocument;
      expect(() => validateEfficiencyDocument(document)).not.toThrow();
      expect(document.human_assessment.final_assessment).toBeNull();
      expect(document.human_assessment.dispositions).toHaveLength(PLANNED_TURNS);
      const payload = document.observation_payload as Readonly<{
        groups: EfficiencyCheckpoint["groups"];
        aggregates: ObservationAggregates;
      }>;
      const attempts = payload.groups.flatMap((group) => group.roles.flatMap((role) => role.attempts));
      const unexpected = payload.groups.flatMap((group) => group.roles.flatMap((role) =>
        role.attempts.length === 0
          ? [`no attempts: ${group.group_id}/${group.case_id}/${group.variant}/${role.role} (group ${group.status})`]
          : role.attempts
            .filter((attempt) => attempt.status !== "succeeded" && attempt.failure?.code !== "TIMEOUT")
            .map((attempt) => `${group.group_id}/${group.case_id}/${group.variant}/${role.role}: ${JSON.stringify(attempt.failure)}`)));
      expect(unexpected).toEqual([]);
      expect(attempts.filter((attempt) => attempt.status === "succeeded")).toHaveLength(PLANNED_TURNS);
      expect(attempts.filter((attempt) => attempt.status === "failed")).toHaveLength(1);
      expect(attempts.every((attempt) => attempt.status !== "running")).toBe(true);
      const failed = attempts.find((attempt) => attempt.status === "failed")!;
      expect(failed.failure?.code).toBe("TIMEOUT");
      expect(failed.failure?.transient).toBe(true);
      expect(failed.usage).toBeUndefined();
      for (const attempt of attempts) {
        if (attempt.status !== "succeeded") continue;
        expect(attempt.cli_version).toBe("2.0.0-stub");
        expect(attempt.managed_policy_present).toBe(false);
        expect(attempt.accepted_model).toBe("claude-opus-5");
      }
      for (const group of payload.groups) for (const role of group.roles) {
        const completed = role.attempts.find(attempt => attempt.status === "succeeded")!;
        if (role.role === "constitution") {
          expect(completed.judgments).toBeDefined();
          expect(completed.outcome).toBeUndefined();
        } else {
          expect(completed.outcome).toBe(group.group_id === "g2" ? "issues_found" : "no_issues_found");
          expect(completed.feedback).toBe(group.group_id === "g2"
            ? "The declared contract contradicts the design."
            : "Reviewed the declared change; no material findings.");
          expect(completed).not.toHaveProperty("report");
        }
      }

      const probeCalls = calls.filter((spec) => basename(spec.cwd) === "g1-general");
      expect(probeCalls).toHaveLength(2);
      expect(probeCalls[1]!.command).toBe(probeCalls[0]!.command);
      expect([...probeCalls[1]!.argv]).toEqual([...probeCalls[0]!.argv]);
      expect(probeCalls[1]!.cwd).toBe(probeCalls[0]!.cwd);
      expect(probeCalls[1]!.stdin).toBeUndefined();
      const counterpart = calls.find((spec) => basename(spec.cwd) === "g7-general")!;
      expect(probeCalls[0]!.stdin).toBeUndefined();
      expect(probeCalls[0]!.argv).not.toEqual(counterpart.argv);

      const old = payload.aggregates.per_variant.old;
      const fresh = payload.aggregates.per_variant.new;
      expect(old.attempt_total).toBe(15);
      expect(old.succeeded_total).toBe(14);
      expect(old.failed_or_interrupted_total).toBe(1);
      expect(fresh.attempt_total).toBe(14);
      expect(fresh.succeeded_total).toBe(14);
      expect(fresh.failed_or_interrupted_total).toBe(0);
      for (const aggregate of [old, fresh]) {
        expect(aggregate.tool_call_total).toBe(14);
        expect(aggregate.repeated_tool_signature_total).toBe(0);
      }
      // The thrown TIMEOUT attempt carries no terminal usage, so under the all-contributors rule
      // the old variant's usage fields propagate unavailable instead of reporting a partial sum;
      // the new variant's 14 measured attempts keep complete totals.
      expect(old.input_tokens).toBeUndefined();
      expect(old.output_tokens).toBeUndefined();
      expect(fresh.input_tokens).toBe(1_400);
      expect(fresh.output_tokens).toBe(560);
      expect(fresh.cache_creation_input_tokens).toBe(0);
      expect(fresh.cache_read_input_tokens).toBe(0);
      expect(payload.aggregates.per_variant_role.old.constitution?.succeeded_total).toBe(4);
      expect(payload.aggregates.per_variant_role.new.test?.attempt_total).toBe(4);
      expect(await readdir(stage)).toEqual(expect.arrayContaining(["checkpoint.json", "review-efficiency.json"]));
    } finally {
      await rm(stage, { recursive: true, force: true });
    }
  }, 600_000);

  it.each([
    { report: "No issues found." },
    { outcome: "no_issues_found", feedback: " " },
    { feedback: "No issues found." },
  ])("rejects obsolete or ambiguous reviewer output without signoff: %j", async reviewFeedback => {
    const stage = await temporaryStage();
    const output = join(stage, "review-efficiency.json");
    try {
      let childCalls = 0;
      const result = await runReviewEfficiencyExperiment({
        stage, output, repositoryRoot,
        preflight: async () => ({ cli_version: "2.0.0-stub", managed_policy_present: false, managed_policy_paths: [] }),
        runChild: async spec => { childCalls += 1; return stubChild(spec, { reviewFeedback }); },
      });
      expect(result.status).toBe("inconclusive");
      expect(childCalls).toBe(1);
      const document = JSON.parse(await readFile(output, "utf8")) as EfficiencyObservationDocument;
      const payload = document.observation_payload as Readonly<{ groups: EfficiencyCheckpoint["groups"]; aggregates: ObservationAggregates }>;
      expect(payload.groups[0]!.roles[0]!.attempts[0]).toMatchObject({
        status: "failed", failure: { code: "MODEL_OUTPUT_INVALID", transient: false },
      });
      expect(payload.groups[0]!.roles[0]!.attempts[0]).not.toHaveProperty("outcome");
    } finally {
      await rm(stage, { recursive: true, force: true });
    }
  });

  it("stops inconclusively after the probe turn when its measurements are unavailable", async () => {
    const stage = await temporaryStage();
    const output = join(stage, "review-efficiency.json");
    try {
      const calls: DispatchChildSpec[] = [];
      const outcome = await runReviewEfficiencyExperiment({
        stage,
        output,
        repositoryRoot,
        preflight: async () => ({ cli_version: "2.0.0-stub", managed_policy_present: false, managed_policy_paths: [] }),
        runChild: async (spec) => {
          calls.push(spec);
          return stubChild(spec, { withoutMeasurements: basename(spec.cwd) === "g1-general" });
        },
      });
      expect(outcome.status).toBe("inconclusive");
      if (outcome.status !== "inconclusive") throw new Error("unreachable");
      expect(outcome.reason).toMatch(/probe turn/u);
      expect(outcome.output).toBe(output);
      expect(calls).toHaveLength(1);
      const document = JSON.parse(decode(new Uint8Array(await readFile(output)))) as EfficiencyObservationDocument;
      expect(() => validateEfficiencyDocument(document)).not.toThrow();
      expect(document.human_assessment.final_assessment).toBe("inconclusive");
      expect(document.human_assessment.final_assessment_reason).toBe(outcome.reason);
      const payload = document.observation_payload as Readonly<{ groups: EfficiencyCheckpoint["groups"]; aggregates: ObservationAggregates }>;
      expect(payload.groups[0]!.status).toBe("completed");
      expect(payload.groups.slice(1).every((group) => group.status === "pending")).toBe(true);
    } finally {
      await rm(stage, { recursive: true, force: true });
    }
  }, 600_000);

  it("stops inconclusively with zero attempts when preflight fails", async () => {
    const stage = await temporaryStage();
    const output = join(stage, "review-efficiency.json");
    try {
      let childCalls = 0;
      const outcome = await runReviewEfficiencyExperiment({
        stage,
        output,
        repositoryRoot,
        preflight: async () => {
          throw new DispatchProcessError(createProjectError("AUTH_UNAVAILABLE", { adapter: "claude-cli" }));
        },
        runChild: async () => {
          childCalls += 1;
          throw new Error("children must not run after a failed preflight");
        },
      });
      expect(outcome.status).toBe("inconclusive");
      if (outcome.status !== "inconclusive") throw new Error("unreachable");
      expect(outcome.reason).toMatch(/^route\/preflight unavailable: AUTH_UNAVAILABLE$/u);
      expect(childCalls).toBe(0);
      const document = JSON.parse(decode(new Uint8Array(await readFile(output)))) as EfficiencyObservationDocument;
      expect(() => validateEfficiencyDocument(document)).not.toThrow();
      const payload = document.observation_payload as Readonly<{
        groups: EfficiencyCheckpoint["groups"];
        preflight_runs: EfficiencyCheckpoint["preflight_runs"];
      }>;
      expect(payload.preflight_runs).toHaveLength(1);
      expect(payload.preflight_runs[0]!.status).toBe("failed");
      expect(payload.preflight_runs[0]!.failure?.code).toBe("AUTH_UNAVAILABLE");
      expect(payload.groups.every((group) => group.status === "pending" && group.roles.every((role) => role.attempts.length === 0))).toBe(true);
    } finally {
      await rm(stage, { recursive: true, force: true });
    }
  }, 600_000);

  it("keeps a classified transient failure's measurements and aggregates them with the retry", async () => {
    const stage = await temporaryStage();
    const output = join(stage, "review-efficiency.json");
    try {
      let g1Calls = 0;
      const logs: string[] = [];
      const outcome = await runReviewEfficiencyExperiment({
        stage,
        output,
        repositoryRoot,
        preflight: async () => ({ cli_version: "2.0.0-stub", managed_policy_present: false, managed_policy_paths: [] }),
        runChild: async (spec) => {
          if (basename(spec.cwd) === "g1-general" && g1Calls === 0) {
            g1Calls += 1;
            return stubChild(spec, { rateLimited: true });
          }
          return stubChild(spec);
        },
        wait: async () => undefined,
        log: (line) => logs.push(line),
      });
      if (outcome.status !== "completed") {
        throw new Error(`outcome ${JSON.stringify(outcome)} logs ${JSON.stringify(logs)}`);
      }
      expect(outcome.status).toBe("completed");
      const document = JSON.parse(decode(new Uint8Array(await readFile(output)))) as EfficiencyObservationDocument;
      const payload = document.observation_payload as Readonly<{ groups: EfficiencyCheckpoint["groups"]; aggregates: ObservationAggregates }>;
      const probeRole = payload.groups[0]!.roles[0]!;
      expect(probeRole.attempts).toHaveLength(2);
      const failedAttempt = probeRole.attempts[0]!;
      expect(failedAttempt.status).toBe("failed");
      expect(failedAttempt.failure?.code).toBe("RATE_LIMITED");
      expect(failedAttempt.failure?.transient).toBe(true);
      // The classified failure's real terminal measurements stay on the attempt.
      expect(failedAttempt.usage).toEqual({
        input_tokens: 50, output_tokens: 20, cache_creation_input_tokens: 0, cache_read_input_tokens: 0,
      });
      expect(failedAttempt.usage_raw).toBeDefined();
      expect(failedAttempt.tool_calls).toEqual([]);
      // Every attempt exposes every field, so the failed measurement joins the totals:
      // 13 sibling successes + the probe's success (100/40) + the failed attempt (50/20).
      const oldAggregate = payload.aggregates.per_variant.old;
      expect(oldAggregate.attempt_total).toBe(15);
      expect(oldAggregate.input_tokens).toBe(1_450);
      expect(oldAggregate.output_tokens).toBe(580);
    } finally {
      await rm(stage, { recursive: true, force: true });
    }
  }, 600_000);

  it("resumes a partially completed group without re-running succeeded siblings or resetting budgets", async () => {
    const stage = await temporaryStage();
    const firstOutput = join(stage, "first.json");
    const secondOutput = join(stage, "second.json");
    try {
      // Run 1 completes everything; the checkpoint then simulates an interruption inside g11
      // (general succeeded, test interrupted mid-attempt, constitution untouched) and rewinds g12.
      const first = await runReviewEfficiencyExperiment({
        stage,
        output: firstOutput,
        repositoryRoot,
        preflight: async () => ({ cli_version: "2.0.0-stub", managed_policy_present: false, managed_policy_paths: [] }),
        runChild: async (spec) => stubChild(spec),
      });
      expect(first.status).toBe("completed");
      // A real interruption never stages an observation; remove run 1's output so the stage
      // holds only the checkpoint, exactly as a resumed-in-the-field stage would look.
      await rm(firstOutput);
      const checkpointPath = join(stage, "checkpoint.json");
      const checkpoint = JSON.parse(decode(new Uint8Array(await readFile(checkpointPath)))) as {
        groups: { group_id: string; status: string; roles: { role: string; status: string; attempts: Record<string, unknown>[] }[] }[];
      };
      for (const group of checkpoint.groups) {
        if (group.group_id === "g11") {
          group.status = "pending";
          const general = group.roles.find((role) => role.role === "general")!;
          general.status = "succeeded";
          const testRole = group.roles.find((role) => role.role === "test")!;
          testRole.status = "pending";
          testRole.attempts = [{ index: 1, status: "interrupted", started_at: "2026-09-16T00:00:00.000Z" }];
          const constitution = group.roles.find((role) => role.role === "constitution")!;
          constitution.status = "pending";
          constitution.attempts = [];
        }
        if (group.group_id === "g12") {
          group.status = "pending";
          for (const role of group.roles) {
            role.status = "pending";
            role.attempts = [];
          }
        }
      }
      await writeFile(checkpointPath, canonicalBytes(checkpoint));

      // Run 2 rebuilds fixtures in a fresh process-equivalent pass; the binding must still match
      // (deterministic fixture commits), succeeded siblings must not re-dispatch, and the
      // interrupted role must continue at its retained attempt index.
      const calls: string[] = [];
      const second = await runReviewEfficiencyExperiment({
        stage,
        output: secondOutput,
        repositoryRoot,
        preflight: async () => ({ cli_version: "2.0.0-stub", managed_policy_present: false, managed_policy_paths: [] }),
        runChild: async (spec) => {
          // The per-role child root travels in TMPDIR; cwd itself is the shared view for
          // view-enabled roles.
          calls.push(basename(String(spec.env.TMPDIR ?? spec.cwd)));
          return stubChild(spec);
        },
      });
      expect(second.status).toBe("completed");
      expect(calls.sort()).toEqual([
        "g11-constitution", "g11-test",
        "g12-constitution", "g12-general", "g12-test",
      ]);
      const document = JSON.parse(decode(new Uint8Array(await readFile(secondOutput)))) as EfficiencyObservationDocument;
      const payload = document.observation_payload as Readonly<{ groups: EfficiencyCheckpoint["groups"]; aggregates: ObservationAggregates }>;
      const g11 = payload.groups.find((group) => group.group_id === "g11")!;
      const g11General = g11.roles.find((role) => role.role === "general")!;
      expect(g11General.attempts).toHaveLength(1);
      const g11Test = g11.roles.find((role) => role.role === "test")!;
      expect(g11Test.attempts.map((attempt) => attempt.status)).toEqual(["interrupted", "succeeded"]);
      expect(g11Test.attempts[1]!.index).toBe(2);
      const attempts = payload.groups.flatMap((group) => group.roles.flatMap((role) => role.attempts));
      expect(attempts.filter((attempt) => attempt.status === "succeeded")).toHaveLength(PLANNED_TURNS);
      // The retained interrupted attempt has no usage, so per the all-contributors rule the
      // new variant's usage fields propagate unavailable instead of reporting a partial sum.
      expect(payload.aggregates.per_variant.new.input_tokens).toBeUndefined();
      expect(payload.aggregates.per_variant.old.input_tokens).toBe(1_400);
    } finally {
      await rm(stage, { recursive: true, force: true });
    }
  }, 600_000);

  it("preserves terminally failed roles across recovery and the crash window while running siblings continue", async () => {
    const stage = await temporaryStage();
    const firstOutput = join(stage, "first.json");
    const secondOutput = join(stage, "second.json");
    try {
      const first = await runReviewEfficiencyExperiment({
        stage,
        output: firstOutput,
        repositoryRoot,
        preflight: async () => ({ cli_version: "2.0.0-stub", managed_policy_present: false, managed_policy_paths: [] }),
        runChild: async (spec) => stubChild(spec),
      });
      expect(first.status).toBe("completed");
      await rm(firstOutput);
      // Rewind g11 and g12 to the real pre-recovery states a stop can leave behind. g11-general
      // is the crash window: the role is still running while its only attempt is already
      // finalized as a nontransient failure (the stop landed between attempt finalization and
      // role end). g12 exercises recovery with a running sibling ahead of a retained terminal
      // failure: its general role carries a leftover running attempt, its test role carries a
      // finalized nontransient failure (which shared-flag recovery used to demote to pending),
      // and its constitution role is untouched-pending.
      const checkpointPath = join(stage, "checkpoint.json");
      const checkpoint = JSON.parse(decode(new Uint8Array(await readFile(checkpointPath)))) as {
        groups: { group_id: string; status: string; roles: { role: string; status: string; attempts: Record<string, unknown>[] }[] }[];
      };
      const terminalFailure = {
        code: "OUTPUT_SCHEMA_MISMATCH",
        message: "simulated terminal rejection",
        transient: false,
      };
      for (const group of checkpoint.groups) {
        if (group.group_id === "g11") {
          group.status = "pending";
          const general = group.roles.find((role) => role.role === "general")!;
          general.status = "running";
          general.attempts = [{
            index: 1,
            status: "failed",
            started_at: "2026-09-16T00:00:00.000Z",
            elapsed_ms: 1_000,
            failure: { ...terminalFailure },
          }];
        }
        if (group.group_id === "g12") {
          group.status = "pending";
          for (const role of group.roles) {
            if (role.role === "general") {
              role.status = "running";
              role.attempts = [{ index: 1, status: "running", started_at: "2026-09-16T00:00:00.000Z" }];
            } else if (role.role === "test") {
              role.status = "failed";
              role.attempts = [{
                index: 1,
                status: "failed",
                started_at: "2026-09-16T00:00:00.000Z",
                elapsed_ms: 1_000,
                failure: { ...terminalFailure },
              }];
            } else {
              role.status = "pending";
              role.attempts = [];
            }
          }
        }
      }
      await writeFile(checkpointPath, canonicalBytes(checkpoint));

      const calls: string[] = [];
      const second = await runReviewEfficiencyExperiment({
        stage,
        output: secondOutput,
        repositoryRoot,
        preflight: async () => ({ cli_version: "2.0.0-stub", managed_policy_present: false, managed_policy_paths: [] }),
        runChild: async (spec) => {
          calls.push(basename(String(spec.env.TMPDIR ?? spec.cwd)));
          return stubChild(spec);
        },
      });
      expect(second.status).toBe("completed");
      // Neither terminal role is re-dispatched; the recovered running sibling continues at its
      // retained index and the untouched-pending sibling runs once.
      expect(calls.sort()).toEqual(["g12-constitution", "g12-general"]);
      const document = JSON.parse(decode(new Uint8Array(await readFile(secondOutput)))) as EfficiencyObservationDocument;
      const payload = document.observation_payload as Readonly<{ groups: EfficiencyCheckpoint["groups"] }>;
      const g11General = payload.groups.find((group) => group.group_id === "g11")!.roles.find((role) => role.role === "general")!;
      expect(g11General.status).toBe("failed");
      expect(g11General.attempts).toHaveLength(1);
      expect(g11General.attempts[0]!.failure?.code).toBe("OUTPUT_SCHEMA_MISMATCH");
      expect(g11General.attempts[0]!.failure?.transient).toBe(false);
      const g12 = payload.groups.find((group) => group.group_id === "g12")!;
      const g12Test = g12.roles.find((role) => role.role === "test")!;
      expect(g12Test.status).toBe("failed");
      expect(g12Test.attempts).toHaveLength(1);
      expect(g12Test.attempts[0]!.failure?.transient).toBe(false);
      const g12General = g12.roles.find((role) => role.role === "general")!;
      expect(g12General.attempts.map((attempt) => attempt.status)).toEqual(["interrupted", "succeeded"]);
      expect(g12General.attempts[1]!.index).toBe(2);
      // The retained interrupted attempt has no usage, so the new variant propagates unavailable.
      const aggregates = (payload as unknown as { aggregates: ObservationAggregates }).aggregates;
      expect(aggregates.per_variant.new.input_tokens).toBeUndefined();
    } finally {
      await rm(stage, { recursive: true, force: true });
    }
  }, 600_000);

  it("stops inconclusively on resume when the CLI version changed across runs", async () => {
    const stage = await temporaryStage();
    const firstOutput = join(stage, "first.json");
    const secondOutput = join(stage, "second.json");
    try {
      const first = await runReviewEfficiencyExperiment({
        stage,
        output: firstOutput,
        repositoryRoot,
        preflight: async () => ({ cli_version: "1.0.0-stub", managed_policy_present: false, managed_policy_paths: [] }),
        runChild: async (spec) => stubChild(spec),
      });
      expect(first.status).toBe("completed");
      await rm(firstOutput);
      let childCalls = 0;
      const second = await runReviewEfficiencyExperiment({
        stage,
        output: secondOutput,
        repositoryRoot,
        preflight: async () => ({ cli_version: "2.0.0-stub", managed_policy_present: false, managed_policy_paths: [] }),
        runChild: async (spec) => {
          childCalls += 1;
          return stubChild(spec);
        },
      });
      expect(second.status).toBe("inconclusive");
      if (second.status !== "inconclusive") throw new Error("unreachable");
      expect(second.reason).toMatch(/cli version changed across runs/u);
      expect(childCalls).toBe(0);
    } finally {
      await rm(stage, { recursive: true, force: true });
    }
  }, 600_000);
});

// ---------------------------------------------------------------------------
// Observation document conclusion contract
// ---------------------------------------------------------------------------

function syntheticCheckpoint(options: { roleFailure?: boolean; missingUsage?: boolean } = {}): EfficiencyCheckpoint {
  const checkpoint = JSON.parse(decode(canonicalBytes(freshCheckpoint(fakeBinding)))) as {
    groups: {
      status: string;
      roles: { status: string; attempts: Record<string, unknown>[] }[];
    }[];
  };
  for (const group of checkpoint.groups) {
    group.status = "completed";
    for (const role of group.roles) {
      const failed = options.roleFailure === true && group === checkpoint.groups[0];
      role.status = failed ? "failed" : "succeeded";
      role.attempts.push(failed
        ? { index: 1, status: "failed", started_at: "2026-09-16T00:00:00.000Z", failure: { code: "TIMEOUT", message: "stub", transient: true } }
        : {
          index: 1,
          status: "succeeded",
          started_at: "2026-09-16T00:00:00.000Z",
          elapsed_ms: 5,
          ...(options.missingUsage === true && group === checkpoint.groups[0] ? {} : { usage: { input_tokens: 10, output_tokens: 5 } }),
        });
    }
  }
  return checkpoint as unknown as EfficiencyCheckpoint;
}

function supportedAssessment(document: EfficiencyObservationDocument): EfficiencyObservationDocument {
  const dispositions: DispositionRecord[] = document.human_assessment.dispositions.map((slot) => {
    const oracle = CASE_ORACLE_CONTRACT.find((entry) => entry.case_id === slot.case_id)!;
    return {
      ...slot,
      defect_detected: oracle.kind === "control" ? "not-applicable" : "detected",
      unsupported_material_blocker: false,
      legacy_auth_scope_leak: false,
      follow_up_resolution_confirmed: slot.role === "constitution" ? "not-applicable" : oracle.kind === "follow-up",
      rationale: "Observed in the stubbed transcript.",
    };
  });
  return {
    ...document,
    human_assessment: {
      ...document.human_assessment,
      dispositions,
      repeated_investigation: null,
      final_assessment: "supported",
    },
  };
}

describe("observation document conclusion contract", () => {
  it("aggregates each usage field once across every attempt of a bucket, unavailable propagating", () => {
    const attempt = (usage: Record<string, number> | undefined, overrides: Record<string, unknown> = {}): Record<string, unknown> => ({
      index: 1, status: "succeeded", started_at: "2026-09-16T00:00:00.000Z", tool_calls: [],
      ...(usage === undefined ? {} : { usage }), ...overrides,
    });
    const groups = [
      {
        order: 1, group_id: "g1", case_id: "document-control", variant: "old", status: "completed",
        roles: [{ role: "general", status: "succeeded", attempts: [
          attempt({ input_tokens: 10, output_tokens: 2, cache_creation_input_tokens: 1, cache_read_input_tokens: 0 }),
          // Cross-group availability: this same-variant group's attempt exposes input/output but
          // not the cache fields, so the whole old-variant aggregate propagates unavailable
          // instead of reporting the measured subset as a total.
          attempt({ input_tokens: 5, output_tokens: 1 }),
        ] }],
      },
      {
        order: 2, group_id: "g2", case_id: "document-defect", variant: "old", status: "completed",
        roles: [{ role: "general", status: "succeeded", attempts: [attempt(undefined)] }],
      },
      {
        order: 3, group_id: "g3", case_id: "document-control", variant: "new", status: "completed",
        roles: [{ role: "general", status: "succeeded", attempts: [
          // A classified failure's measured usage belongs to the bucket alongside successes.
          attempt({ input_tokens: 3, output_tokens: 1, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 },
            { status: "failed", failure: { code: "RATE_LIMITED", message: "limit", transient: true } }),
          attempt({ input_tokens: 4, output_tokens: 2, cache_creation_input_tokens: 1, cache_read_input_tokens: 1 }),
        ] }],
      },
    ] as unknown as EfficiencyCheckpoint["groups"];
    const aggregates = computeAggregates(groups);
    expect(aggregates.per_variant.old.input_tokens).toBeUndefined();
    expect(aggregates.per_variant.old.output_tokens).toBeUndefined();
    expect(aggregates.per_variant.old.cache_creation_input_tokens).toBeUndefined();
    expect(aggregates.per_variant.old.attempt_total).toBe(3);
    expect(aggregates.per_variant.old.succeeded_total).toBe(3);
    expect(aggregates.per_variant.old.failed_or_interrupted_total).toBe(0);
    expect(aggregates.per_variant.new.input_tokens).toBe(7);
    expect(aggregates.per_variant.new.output_tokens).toBe(3);
    expect(aggregates.per_variant.new.cache_creation_input_tokens).toBe(1);
    expect(aggregates.per_variant.new.cache_read_input_tokens).toBe(1);
    expect(aggregates.per_variant_role.old.general?.attempt_total).toBe(3);
    expect(aggregates.per_variant_role.new.general?.failed_or_interrupted_total).toBe(1);
  });

  it("accepts a fully supported document built from a complete synthetic run", () => {
    const document = supportedAssessment(buildObservationDocument(syntheticCheckpoint()));
    expect(() => validateEfficiencyDocument(document)).not.toThrow();
    const inconclusive = fillInconclusiveAssessment(buildObservationDocument(freshCheckpoint(fakeBinding)), "unavailable: usage");
    expect(inconclusive.human_assessment.final_assessment).toBe("inconclusive");
    expect(() => validateEfficiencyDocument(inconclusive)).not.toThrow();
  });

  it("rejects tampered digests, bindings, coverage, and decision-rule violations", () => {
    const base = supportedAssessment(buildObservationDocument(syntheticCheckpoint()));
    type MutableDisposition = {
      case_id: string; variant: string; role: string; order: number;
      defect_detected: string | null;
      unsupported_material_blocker: boolean | null;
      legacy_auth_scope_leak: boolean | null;
      follow_up_resolution_confirmed: boolean | "not-applicable" | null;
      rationale: string | null;
    };
    type MutableDocument = {
      observation_digest: string;
      observation_payload: Record<string, PlainJsonValue>;
      human_assessment: {
        observation_digest: string;
        dispositions: MutableDisposition[];
        repeated_investigation: string | null;
        final_assessment: string | null;
        final_assessment_reason?: string;
      };
    };
    const clone = (): MutableDocument => JSON.parse(decode(canonicalBytes(base))) as MutableDocument;
    const validate = (document: MutableDocument): void => validateEfficiencyDocument(document as unknown as EfficiencyObservationDocument);

    const tamperedPayload = clone();
    tamperedPayload.observation_payload.schema_version = "9";
    expect(() => validate(tamperedPayload)).toThrow(/does not bind the observation payload/u);

    const tamperedBinding = clone();
    tamperedBinding.human_assessment.observation_digest = digest("f");
    expect(() => validate(tamperedBinding)).toThrow(/does not bind the observation digest/u);

    const missing = clone();
    missing.human_assessment.dispositions.pop();
    expect(() => validate(missing)).toThrow(/missing disposition/u);

    const duplicated = clone();
    duplicated.human_assessment.dispositions.push({ ...duplicated.human_assessment.dispositions[0]! });
    expect(() => validate(duplicated)).toThrow(/duplicate disposition/u);

    const undecided = clone();
    undecided.human_assessment.final_assessment = "mixed";
    undecided.human_assessment.dispositions[0]!.rationale = null;
    expect(() => validate(undecided)).toThrow(/fully decided dispositions/u);

    const missed = clone();
    const seeded = missed.human_assessment.dispositions
      .find((slot) => CASE_ORACLE_CONTRACT.find((entry) => entry.case_id === slot.case_id)!.kind === "seeded")!;
    seeded.defect_detected = "missed";
    expect(() => validate(missed)).toThrow(/cannot miss a known defect/u);

    const controlDetected = clone();
    controlDetected.human_assessment.dispositions[0]!.defect_detected = "detected";
    expect(() => validate(controlDetected)).toThrow(/must be not-applicable/u);

    const blocked = clone();
    blocked.human_assessment.dispositions[0]!.unsupported_material_blocker = true;
    expect(() => validate(blocked)).toThrow(/cannot carry an unsupported blocker/u);

    const leaked = clone();
    leaked.human_assessment.dispositions[0]!.legacy_auth_scope_leak = true;
    expect(() => validate(leaked)).toThrow(/cannot leak legacy-auth/u);

    const unresolved = clone();
    const followUp = unresolved.human_assessment.dispositions
      .find((slot) => CASE_ORACLE_CONTRACT.find((entry) => entry.case_id === slot.case_id)!.kind === "follow-up" && slot.role !== "constitution")!;
    followUp.follow_up_resolution_confirmed = false;
    expect(() => validate(unresolved)).toThrow(/must confirm follow-up resolution/u);

    const brokenRole = supportedAssessment(buildObservationDocument(syntheticCheckpoint({ roleFailure: true })));
    expect(() => validateEfficiencyDocument(brokenRole)).toThrow(/complete role coverage/u);

    const missingUsage = supportedAssessment(buildObservationDocument(syntheticCheckpoint({ missingUsage: true })));
    expect(() => validateEfficiencyDocument(missingUsage)).toThrow(/available paired usage/u);

    const vocabulary = clone();
    vocabulary.human_assessment.final_assessment = "excellent";
    expect(() => validate(vocabulary)).toThrow(/conclusion vocabulary/u);

    const noReason = clone();
    noReason.human_assessment.final_assessment = "inconclusive";
    delete noReason.human_assessment.final_assessment_reason;
    expect(() => validate(noReason)).toThrow(/must name the unavailable fields/u);
  });
});

// ---------------------------------------------------------------------------
// Committed validation evidence
// ---------------------------------------------------------------------------

describe("committed validation evidence", () => {
  it("binds the recorded observation to a valid completed assessment", async () => {
    const path = fileURLToPath(new URL("../../docs/validation/review-efficiency-2026-09-16.json", import.meta.url));
    const document = JSON.parse(decode(new Uint8Array(await readFile(path)))) as EfficiencyObservationDocument;
    expect(document.observation_payload).toBeDefined();
    expect(() => validateEfficiencyDocument(document)).not.toThrow();
    expect(document.human_assessment.final_assessment).toBe("mixed");
    expect(document.human_assessment.dispositions.filter((slot) => slot.defect_detected === "detected"))
      .toHaveLength(20);
    // The recorded run: 28 turns, every required role succeeded on its first attempt.
    const payload = document.observation_payload as Readonly<{ groups: EfficiencyCheckpoint["groups"]; aggregates: ObservationAggregates }>;
    const attempts = payload.groups.flatMap((group) => group.roles.flatMap((role) => role.attempts));
    expect(attempts.filter((attempt) => attempt.status === "succeeded")).toHaveLength(28);
    expect(attempts.every((attempt) => attempt.status === "succeeded")).toBe(true);
    expect(document.observation_payload as Readonly<Record<string, PlainJsonValue>>).toHaveProperty("source_commit");
  });
});

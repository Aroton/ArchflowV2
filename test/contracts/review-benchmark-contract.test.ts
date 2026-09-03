import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { canonicalJsonBytes, canonicalJsonDigest, sha256Bytes } from "../../src/contracts/canonical.js";
import type { PlainJsonValue } from "../../src/contracts/plain-json.js";
import type { ReviewFindingV2 } from "../../src/contracts/review.js";
import {
  REAL_HOST_OPT_IN_ENV,
  REVIEW_BENCHMARK_OPT_IN_ENV,
  benchmarkEnabled,
} from "../helpers/real-host.js";
import {
  BENCHMARK_DIRECTIONS,
  BENCHMARK_DISPOSITION_VOCABULARY,
  BENCHMARK_REPEAT_COUNT,
  CORPUS_MANIFEST_SHA256,
  buildBenchmarkDocument,
  classifyCleanControl,
  classifySeededClaim,
  computeBenchmarkMatrixTurns,
  deriveBenchmarkSummary,
  loadCorpusManifest,
  validateBenchmarkFalsifier,
  validateBenchmarkStageAndOutput,
  type SeededCorpusCaseV2,
} from "../helpers/review-benchmark.js";
import { loadTestRubric } from "../helpers/rubrics.js";

describe("benchmark V2 contract and vocabulary", () => {
  it("pins the production design rubric digest and criteria", async () => {
    const designRubric = await loadTestRubric("design");
    expect(designRubric.rubric_id).toBe("design-v3");
    expect(designRubric.rubric_digest).toBe("bb840e3ec194160c05b0ff21eb46fe4ef2ab7bd689c6cc0c883d97b1fc4b0dd8");
    expect(designRubric.rubric.criteria.map((c) => c.id)).toEqual([
      "substantive-correctness",
      "upstream-coverage",
      "interface-reality",
      "quantitative-consistency",
      "boundary-and-mechanism-coverage",
      "evidence-completeness",
      "proportionality",
      "phase-plan-soundness",
      "test-strategy",
      "unverifiable-claims",
      "reviewer-confidence",
      "advisory-observations",
    ]);
  });

  it("derives server-style verdict, total, and all 12 taxonomy cells from validated findings", () => {
    const emptySummary = deriveBenchmarkSummary([]);
    expect(emptySummary.verdict).toBe("pass");
    expect(emptySummary.total_findings).toBe(0);
    expect(Object.keys(emptySummary.partition_counts)).toHaveLength(12);
    for (const value of Object.values(emptySummary.partition_counts)) {
      expect(value).toBe(0);
    }

    const preferenceFinding: ReviewFindingV2 = {
      finding_id: "pref-1",
      claim_type: "preference",
      confidence: "likely",
      falsifier: "Inspect style guide section 4.",
      summary: "Naming preference.",
      evidence: "Variable name could be clearer.",
      suggested_resolution: "Rename variable.",
    };
    const advisorySummary = deriveBenchmarkSummary([preferenceFinding]);
    expect(advisorySummary.verdict).toBe("advisory");
    expect(advisorySummary.total_findings).toBe(1);
    expect(advisorySummary.partition_counts["preference:likely"]).toBe(1);
    expect(advisorySummary.partition_counts["defect:certain"]).toBe(0);

    const mixedFindings: readonly ReviewFindingV2[] = [
      preferenceFinding,
      {
        finding_id: "defect-1",
        claim_type: "defect",
        confidence: "certain",
        falsifier: "Run test case test_edge_case.",
        summary: "Buffer overflow defect.",
        evidence: "Buffer allocation is 16 bytes but 32 are written.",
        suggested_resolution: "Increase buffer size.",
      },
      {
        finding_id: "risk-1",
        claim_type: "risk",
        confidence: "suspicion",
        falsifier: "Observe whether concurrent calls deadlock under load.",
        summary: "Potential deadlock risk.",
        evidence: "Locks acquired in arbitrary order.",
        suggested_resolution: "Enforce lock hierarchy.",
      },
    ];
    const mixedSummary = deriveBenchmarkSummary(mixedFindings);
    expect(mixedSummary.verdict).toBe("review-raised");
    expect(mixedSummary.total_findings).toBe(3);
    expect(mixedSummary.partition_counts["preference:likely"]).toBe(1);
    expect(mixedSummary.partition_counts["defect:certain"]).toBe(1);
    expect(mixedSummary.partition_counts["risk:suspicion"]).toBe(1);
    expect(mixedSummary.partition_counts["gap:certain"]).toBe(0);
  });

  it("validates and projects falsifiers within the 4096 UTF-16 code unit bound", () => {
    const valid = "Run `npm test` and inspect failure.";
    expect(validateBenchmarkFalsifier(valid)).toBe(valid);

    expect(() => validateBenchmarkFalsifier("")).toThrow(/non-whitespace/u);
    expect(() => validateBenchmarkFalsifier("   \n\t  ")).toThrow(/non-whitespace/u);
    expect(() => validateBenchmarkFalsifier(null)).toThrow(/string/u);
    expect(() => validateBenchmarkFalsifier(123)).toThrow(/string/u);

    const boundary4096 = "a".repeat(4096);
    expect(validateBenchmarkFalsifier(boundary4096)).toBe(boundary4096);

    const oversized = "a".repeat(4097);
    expect(() => validateBenchmarkFalsifier(oversized)).toThrow(RangeError);
  });

  it("classifies seeded consequential claims using explicit expectation identifiers without fuzzy matching", () => {
    const seededCase: SeededCorpusCaseV2 = {
      id: "retention-contradiction",
      artifact: "seeded-retention-contradiction.md",
      artifact_sha256: "9f57633bc7b1beb8bb6222fefc33c0d52e7c10fa273b88e67e82b0676daa1809",
      kind: "seeded",
      expected_outcome: "substantive-finding",
      expectation_id: "retention-contradiction",
      seeded_claim: "The audit-record example persists the raw bearer token.",
    };

    const matchingFinding: ReviewFindingV2 = {
      finding_id: "retention-contradiction",
      claim_type: "defect",
      confidence: "certain",
      falsifier: "Inspect audit-record persistence logic.",
      summary: "Audit record persists raw bearer token.",
      evidence: "Bearer token in plain text.",
      suggested_resolution: "Hash or redact bearer token.",
    };

    const textuallySimilarFinding: ReviewFindingV2 = {
      finding_id: "token-persistence-issue",
      claim_type: "defect",
      confidence: "certain",
      falsifier: "Inspect audit-record persistence logic.",
      summary: "The audit-record example persists the raw bearer token.",
      evidence: "The audit-record example persists the raw bearer token even though prohibited.",
      suggested_resolution: "Do not persist bearer token.",
    };

    // Expected identifier is credited
    const detectedResult = classifySeededClaim(seededCase, [matchingFinding]);
    expect(detectedResult.detected).toBe(true);
    expect(detectedResult.disposition).toBe("seed-detected");
    expect(detectedResult.seedFindings).toHaveLength(1);
    expect(detectedResult.unrelatedFindings).toHaveLength(0);

    // Textually similar finding without matching expectation_id is classified as unrelated, NOT seed-detected
    const unrelatedResult = classifySeededClaim(seededCase, [textuallySimilarFinding]);
    expect(unrelatedResult.detected).toBe(false);
    expect(unrelatedResult.disposition).toBe("unrelated-substantive");
    expect(unrelatedResult.seedFindings).toHaveLength(0);
    expect(unrelatedResult.unrelatedFindings).toHaveLength(1);

    // Both present: matching finding is seed, other is unrelated
    const combinedResult = classifySeededClaim(seededCase, [matchingFinding, textuallySimilarFinding]);
    expect(combinedResult.detected).toBe(true);
    expect(combinedResult.disposition).toBe("seed-detected");
    expect(combinedResult.seedFindings).toHaveLength(1);
    expect(combinedResult.unrelatedFindings).toHaveLength(1);

    // Empty or advisory findings result in missed
    const missedResult = classifySeededClaim(seededCase, []);
    expect(missedResult.detected).toBe(false);
    expect(missedResult.disposition).toBe("missed");

    const prefOnlyResult = classifySeededClaim(seededCase, [{
      finding_id: "some-pref",
      claim_type: "preference",
      confidence: "likely",
      falsifier: "Inspect styling.",
      summary: "Style note.",
      evidence: "Style preference.",
      suggested_resolution: "Adjust style.",
    }]);
    expect(prefOnlyResult.detected).toBe(false);
    expect(prefOnlyResult.disposition).toBe("missed");

    // With scoring attribution mapping, finding_id mapped to expectation_id is credited as seed-detected
    const attributedResult = classifySeededClaim(
      seededCase,
      [textuallySimilarFinding],
      { "token-persistence-issue": "retention-contradiction" },
    );
    expect(attributedResult.detected).toBe(true);
    expect(attributedResult.disposition).toBe("seed-detected");
    expect(attributedResult.seedFindings).toHaveLength(1);
    expect(attributedResult.seedFindings[0]?.finding_id).toBe("token-persistence-issue");
  });

  it("classifies clean control outcomes into clean-pass, false-substantive, and advisory-preference", () => {
    // 1. Empty pass
    expect(classifyCleanControl([])).toBe("clean-pass");

    // 2. False substantive (defect, risk, or gap)
    const substantiveFinding: ReviewFindingV2 = {
      finding_id: "false-defect",
      claim_type: "defect",
      confidence: "likely",
      falsifier: "Check assertion in module X.",
      summary: "False positive defect.",
      evidence: "Misinterpreted code path.",
      suggested_resolution: "None needed.",
    };
    expect(classifyCleanControl([substantiveFinding])).toBe("false-substantive");

    // 3. Advisory preference
    const preferenceFinding: ReviewFindingV2 = {
      finding_id: "pref-1",
      claim_type: "preference",
      confidence: "likely",
      falsifier: "Review style conventions.",
      summary: "Stylistic suggestion.",
      evidence: "Could be formatted more concisely.",
      suggested_resolution: "Refactor format.",
    };
    expect(classifyCleanControl([preferenceFinding])).toBe("advisory-preference");

    // Unrelated partition counts cannot change clean-pass or advisory-preference classification
    const multiplePreferences: readonly ReviewFindingV2[] = [
      preferenceFinding,
      { ...preferenceFinding, finding_id: "pref-2" },
      { ...preferenceFinding, finding_id: "pref-3", confidence: "certain" },
    ];
    expect(classifyCleanControl(multiplePreferences)).toBe("advisory-preference");
  });

  it("migrates corpus vocabulary and validates required V2 fields for all cases", async () => {
    const manifest = await loadCorpusManifest();
    expect(manifest.value.schema_version).toBe("1");
    expect(manifest.value.disposition_vocabulary).toEqual(BENCHMARK_DISPOSITION_VOCABULARY);
    expect(manifest.value.cases).toHaveLength(13);

    for (const c of manifest.value.cases) {
      expect(typeof c.id).toBe("string");
      expect(typeof c.artifact).toBe("string");
      expect(typeof c.artifact_sha256).toBe("string");
      expect(c.artifact_sha256).toMatch(/^[0-9a-f]{64}$/u);

      // Must not contain legacy blocker-oriented labels
      expect(c).not.toHaveProperty("seeded_defect");
      expect(c).not.toHaveProperty("blocking-finding");

      if (c.kind === "seeded") {
        expect(c.expected_outcome).toBe("substantive-finding");
        expect(typeof c.expectation_id).toBe("string");
        expect(c.expectation_id.length).toBeGreaterThan(0);
        expect(typeof c.seeded_claim).toBe("string");
        expect(c.seeded_claim.length).toBeGreaterThan(0);
      } else {
        expect(c.kind).toBe("control");
        expect(c.expected_outcome).toBe("pass");
        expect(c).not.toHaveProperty("expectation_id");
        expect(c).not.toHaveProperty("seeded_claim");
      }
    }
  });

  it("rebinds and verifies the corpus manifest digest", async () => {
    const manifest = await loadCorpusManifest();
    const computedDigest = sha256Bytes(manifest.bytes);
    expect(computedDigest).toBe(CORPUS_MANIFEST_SHA256);

    // Any mutation to manifest bytes changes the digest
    const mutatedBytes = new Uint8Array(manifest.bytes);
    mutatedBytes[mutatedBytes.length - 2] = mutatedBytes[mutatedBytes.length - 2]! ^ 1;
    expect(sha256Bytes(mutatedBytes)).not.toBe(CORPUS_MANIFEST_SHA256);
  });

  it("verifies matrix arithmetic at exactly 26 turns", async () => {
    const manifest = await loadCorpusManifest();
    const caseCount = manifest.value.cases.length;
    const directionCount = BENCHMARK_DIRECTIONS.length;
    const repeatCount = BENCHMARK_REPEAT_COUNT;

    expect(caseCount).toBe(13);
    expect(directionCount).toBe(2);
    expect(repeatCount).toBe(1);

    const turns = computeBenchmarkMatrixTurns(caseCount, directionCount, repeatCount);
    expect(turns).toBe(26);

    expect(computeBenchmarkMatrixTurns(12, 2, 1)).not.toBe(26);
    expect(computeBenchmarkMatrixTurns(13, 1, 1)).not.toBe(26);
  });

  it("serializes immutable benchmark observations and preserves digest stability", () => {
    const payload = {
      schema_version: "1",
      benchmark_input_digest: "a".repeat(64),
      rubric_digest: "b".repeat(64),
      run_conditions: {
        serialized_model_turn_count: 26,
        repeat_count_per_direction: 1,
        wall_clock_seconds: 42.5,
      },
      runs: [{
        run_id: "case-1-claude-to-codex-r1",
        case_id: "case-1",
        verdict: "review-raised",
        total_findings: 1,
      }],
    } as const satisfies PlainJsonValue;

    const digest1 = canonicalJsonDigest(payload);
    const digest2 = canonicalJsonDigest(structuredClone(payload));
    expect(digest1).toBe(digest2);
    expect(canonicalJsonBytes(payload)).toEqual(canonicalJsonBytes(structuredClone(payload)));

    const mutatedPayload = {
      ...payload,
      runs: [{
        run_id: "case-1-claude-to-codex-r1",
        case_id: "case-1",
        verdict: "pass",
        total_findings: 0,
      }],
    } as const satisfies PlainJsonValue;
    expect(canonicalJsonDigest(mutatedPayload)).not.toBe(digest1);
  });

  it("excludes human state from observation digest and preserves point-in-time validation evidence", async () => {
    const payload = {
      schema_version: "1",
      benchmark_input_digest: "a".repeat(64),
      runs: [{ run_id: "run-1", verdict: "pass" }],
    } as const satisfies PlainJsonValue;

    const document = buildBenchmarkDocument(payload, ["run-1"]);
    const expectedDigest = canonicalJsonDigest(payload);

    expect(document.benchmark_result_digest).toBe(expectedDigest);
    expect(document.human_scoring.observation_digest).toBe(expectedDigest);

    // Later human scoring cannot alter the observation payload digest
    const scoredDocument = {
      ...document,
      human_scoring: {
        ...document.human_scoring,
        dispositions: [{ run_id: "run-1", disposition: "clean-pass" }],
        primary_metrics: {
          approval_detection_rate: 1,
          false_substantive_rate: 0,
          triage_completeness: { status: "complete", value: 1 },
          defects_found_after_pass: { status: "complete", value: 0 },
        },
      },
    } as const satisfies PlainJsonValue;

    expect(canonicalJsonDigest(scoredDocument.observation_payload)).toBe(expectedDigest);
    expect(scoredDocument.human_scoring.observation_digest).toBe(expectedDigest);

    // Point-in-time validation files remain untouched and readable
    const validationResultPath = join(process.cwd(), "docs", "validation", "review-benchmark.json");
    const thresholdsPath = join(process.cwd(), "docs", "validation", "thresholds.json");

    const validationJson = JSON.parse(await readFile(validationResultPath, "utf8")) as {
      benchmark_result_digest: string;
    };
    const thresholdsJson = JSON.parse(await readFile(thresholdsPath, "utf8")) as {
      benchmark_result_digest: string;
    };

    expect(validationJson.benchmark_result_digest).toBe(thresholdsJson.benchmark_result_digest);
  });

  it("enforces dual opt-in Boolean gate for benchmarkEnabled without provider probes", () => {
    const originalRealHosts = process.env[REAL_HOST_OPT_IN_ENV];
    const originalBenchmark = process.env[REVIEW_BENCHMARK_OPT_IN_ENV];

    try {
      // Unset
      delete process.env[REAL_HOST_OPT_IN_ENV];
      delete process.env[REVIEW_BENCHMARK_OPT_IN_ENV];
      expect(benchmarkEnabled()).toBe(false);

      // Empty string
      process.env[REAL_HOST_OPT_IN_ENV] = "";
      process.env[REVIEW_BENCHMARK_OPT_IN_ENV] = "";
      expect(benchmarkEnabled()).toBe(false);

      // Noncanonical strings
      for (const noncanonical of ["true", "yes", "0", "2", "TRUE", "1.0"]) {
        process.env[REAL_HOST_OPT_IN_ENV] = noncanonical;
        process.env[REVIEW_BENCHMARK_OPT_IN_ENV] = "1";
        expect(benchmarkEnabled()).toBe(false);

        process.env[REAL_HOST_OPT_IN_ENV] = "1";
        process.env[REVIEW_BENCHMARK_OPT_IN_ENV] = noncanonical;
        expect(benchmarkEnabled()).toBe(false);
      }

      // Canonical 0/1 combinations
      process.env[REAL_HOST_OPT_IN_ENV] = "0";
      process.env[REVIEW_BENCHMARK_OPT_IN_ENV] = "0";
      expect(benchmarkEnabled()).toBe(false);

      process.env[REAL_HOST_OPT_IN_ENV] = "1";
      process.env[REVIEW_BENCHMARK_OPT_IN_ENV] = "0";
      expect(benchmarkEnabled()).toBe(false);

      process.env[REAL_HOST_OPT_IN_ENV] = "0";
      process.env[REVIEW_BENCHMARK_OPT_IN_ENV] = "1";
      expect(benchmarkEnabled()).toBe(false);

      // Only "1" and "1" activates the gate
      process.env[REAL_HOST_OPT_IN_ENV] = "1";
      process.env[REVIEW_BENCHMARK_OPT_IN_ENV] = "1";
      expect(benchmarkEnabled()).toBe(true);
    } finally {
      if (originalRealHosts !== undefined) process.env[REAL_HOST_OPT_IN_ENV] = originalRealHosts;
      else delete process.env[REAL_HOST_OPT_IN_ENV];

      if (originalBenchmark !== undefined) process.env[REVIEW_BENCHMARK_OPT_IN_ENV] = originalBenchmark;
      else delete process.env[REVIEW_BENCHMARK_OPT_IN_ENV];
    }
  });

  it("validates authenticated benchmark staged output path rules strictly", async () => {
    // Missing values
    await expect(validateBenchmarkStageAndOutput({})).rejects.toThrow(/ARCHFLOW_REVIEW_BENCHMARK_STAGE/u);
    await expect(validateBenchmarkStageAndOutput({ ARCHFLOW_REVIEW_BENCHMARK_STAGE: "/tmp/stage" })).rejects.toThrow(/ARCHFLOW_REVIEW_BENCHMARK_OUTPUT/u);

    // Relative paths
    await expect(validateBenchmarkStageAndOutput({
      ARCHFLOW_REVIEW_BENCHMARK_STAGE: "relative/stage",
      ARCHFLOW_REVIEW_BENCHMARK_OUTPUT: "/tmp/stage/output.json",
    })).rejects.toThrow(/absolute/u);

    await expect(validateBenchmarkStageAndOutput({
      ARCHFLOW_REVIEW_BENCHMARK_STAGE: "/tmp/stage",
      ARCHFLOW_REVIEW_BENCHMARK_OUTPUT: "output.json",
    })).rejects.toThrow(/absolute/u);

    // Path traversal
    await expect(validateBenchmarkStageAndOutput({
      ARCHFLOW_REVIEW_BENCHMARK_STAGE: "/tmp/foo/../stage",
      ARCHFLOW_REVIEW_BENCHMARK_OUTPUT: "/tmp/stage/output.json",
    })).rejects.toThrow(/traversal/u);

    // Outside os.tmpdir()
    await expect(validateBenchmarkStageAndOutput({
      ARCHFLOW_REVIEW_BENCHMARK_STAGE: "/var/log/stage",
      ARCHFLOW_REVIEW_BENCHMARK_OUTPUT: "/var/log/stage/output.json",
    })).rejects.toThrow(/does not exist|temporary directory/u);

    // Non-empty stage
    const tmpDir = await mkdtemp(join(os.tmpdir(), "archflow-stage-test-"));
    try {
      const stageChildFile = join(tmpDir, "existing.txt");
      await writeFile(stageChildFile, "non-empty");

      await expect(validateBenchmarkStageAndOutput({
        ARCHFLOW_REVIEW_BENCHMARK_STAGE: tmpDir,
        ARCHFLOW_REVIEW_BENCHMARK_OUTPUT: join(tmpDir, "output.json"),
      })).rejects.toThrow(/empty directory/u);

      await rm(stageChildFile);

      // Output already exists
      const outputTarget = join(tmpDir, "output.json");
      await writeFile(outputTarget, "pre-existing");
      await expect(validateBenchmarkStageAndOutput({
        ARCHFLOW_REVIEW_BENCHMARK_STAGE: tmpDir,
        ARCHFLOW_REVIEW_BENCHMARK_OUTPUT: outputTarget,
      })).rejects.toThrow(/already exists/u);

      await rm(outputTarget);

      // Output targeting docs/validation
      await expect(validateBenchmarkStageAndOutput({
        ARCHFLOW_REVIEW_BENCHMARK_STAGE: tmpDir,
        ARCHFLOW_REVIEW_BENCHMARK_OUTPUT: join(process.cwd(), "docs", "validation", "review-benchmark.json"),
      })).rejects.toThrow(/direct child/u);

      // Valid empty temporary stage with direct-child output succeeds
      const result = await validateBenchmarkStageAndOutput({
        ARCHFLOW_REVIEW_BENCHMARK_STAGE: tmpDir,
        ARCHFLOW_REVIEW_BENCHMARK_OUTPUT: outputTarget,
      });
      expect(result.stage).toBe(tmpDir);
      expect(result.output).toBe(outputTarget);
    } finally {
      await rm(tmpDir, { recursive: true, force: true });
    }
  });
});

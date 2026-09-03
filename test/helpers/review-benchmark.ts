import { lstat, readdir, readFile, realpath, stat } from "node:fs/promises";
import os from "node:os";
import { basename, dirname, isAbsolute, join, normalize, resolve } from "node:path";

import { canonicalJsonBytes, canonicalJsonDigest, sha256Bytes } from "../../src/contracts/canonical.js";
import type { PlainJsonValue } from "../../src/contracts/plain-json.js";
import {
  expectedReviewSummaryV2,
  isSubstantiveClaim,
  type FindingPartitionCounts,
  type ReviewFindingV2,
  type ReviewVerdict,
} from "../../src/contracts/review.js";

export const CORPUS_MANIFEST_SHA256 = "fc4c619a6c3beea849bdcef8a32e5a1ee72ce9842d166a6da6e2d1ccf6a365b0";
export const BENCHMARK_REPEAT_COUNT = 1;
export const BENCHMARK_DIRECTIONS = Object.freeze([
  Object.freeze({ id: "claude-to-codex", producer_family: "claude" as const, reviewer_family: "codex" as const }),
  Object.freeze({ id: "codex-to-claude", producer_family: "codex" as const, reviewer_family: "claude" as const }),
]);

export const BENCHMARK_DISPOSITION_VOCABULARY = Object.freeze({
  seeded: Object.freeze(["seed-detected", "unrelated-substantive", "missed"] as const),
  control: Object.freeze(["clean-pass", "false-substantive", "advisory-preference"] as const),
});

export type SeededCorpusCaseV2 = Readonly<{
  id: string;
  artifact: string;
  artifact_sha256: string;
  kind: "seeded";
  expected_outcome: "substantive-finding";
  expectation_id: string;
  seeded_claim: string;
}>;

export type ControlCorpusCaseV2 = Readonly<{
  id: string;
  artifact: string;
  artifact_sha256: string;
  kind: "control";
  expected_outcome: "pass";
  seeded_claim?: null;
  expectation_id?: null;
}>;

export type CorpusCaseV2 = SeededCorpusCaseV2 | ControlCorpusCaseV2;

export type CorpusManifestV2 = Readonly<{
  schema_version: "1";
  disposition_vocabulary: typeof BENCHMARK_DISPOSITION_VOCABULARY;
  cases: readonly CorpusCaseV2[];
}>;

export type SeededClaimClassification = Readonly<{
  detected: boolean;
  disposition: (typeof BENCHMARK_DISPOSITION_VOCABULARY.seeded)[number];
  seedFindings: readonly ReviewFindingV2[];
  unrelatedFindings: readonly ReviewFindingV2[];
}>;

export type CleanControlClassification = (typeof BENCHMARK_DISPOSITION_VOCABULARY.control)[number];

const decoder = new TextDecoder("utf-8", { fatal: true });

export async function loadCorpusManifest(
  manifestPath?: string,
): Promise<Readonly<{ bytes: Uint8Array; value: CorpusManifestV2 }>> {
  const target = manifestPath ?? join(process.cwd(), "test", "fixtures", "corpus", "artifacts", "manifest.json");
  const bytes = await readFile(target);
  const value = JSON.parse(decoder.decode(bytes)) as CorpusManifestV2;
  if (value.schema_version !== "1") {
    throw new TypeError("Corpus manifest must have schema_version '1'");
  }
  return { bytes, value };
}

export function deriveBenchmarkSummary(findings: readonly ReviewFindingV2[]): Readonly<{
  verdict: ReviewVerdict;
  total_findings: number;
  partition_counts: FindingPartitionCounts;
}> {
  return expectedReviewSummaryV2(findings);
}

export function validateBenchmarkFalsifier(falsifier: unknown): string {
  if (typeof falsifier !== "string") {
    throw new TypeError("Falsifier must be a string");
  }
  const trimmed = falsifier.trim();
  if (trimmed.length === 0) {
    throw new TypeError("Falsifier must contain non-whitespace characters");
  }
  if (falsifier.length > 4096) {
    throw new RangeError(`Falsifier exceeds 4096 UTF-16 code units (length: ${falsifier.length})`);
  }
  return falsifier;
}

/**
 * Classifies findings on a seeded corpus case against the case's expectation_id.
 *
 * During autonomous model review runs, reviewers choose arbitrary finding_ids and are
 * never given private corpus expectation identifiers in their prompts. In human scoring
 * workflows, finding-to-expectation attribution can be supplied via the optional
 * attribution mapping (`{ [finding_id]: expectation_id }`). If no attribution mapping is
 * provided, `finding.finding_id` is compared directly with `corpusCase.expectation_id`
 * (as used in deterministic test contracts and pre-attributed fixtures).
 *
 * Matches are evaluated strictly by exact identifier comparison; fuzzy matching is forbidden.
 */
export function classifySeededClaim(
  corpusCase: SeededCorpusCaseV2,
  findings: readonly ReviewFindingV2[],
  attribution?: Readonly<Record<string, string>>,
): SeededClaimClassification {
  const seedFindings: ReviewFindingV2[] = [];
  const unrelatedFindings: ReviewFindingV2[] = [];

  for (const finding of findings) {
    validateBenchmarkFalsifier(finding.falsifier);
    const matchedExpectation = attribution?.[finding.finding_id] ?? finding.finding_id;
    if (matchedExpectation === corpusCase.expectation_id) {
      seedFindings.push(finding);
    } else {
      unrelatedFindings.push(finding);
    }
  }

  const detected = seedFindings.length > 0;
  let disposition: (typeof BENCHMARK_DISPOSITION_VOCABULARY.seeded)[number];
  if (detected) {
    disposition = "seed-detected";
  } else if (unrelatedFindings.some(isSubstantiveClaim)) {
    disposition = "unrelated-substantive";
  } else {
    disposition = "missed";
  }

  return Object.freeze({
    detected,
    disposition,
    seedFindings: Object.freeze(seedFindings),
    unrelatedFindings: Object.freeze(unrelatedFindings),
  });
}

export function classifyCleanControl(findings: readonly ReviewFindingV2[]): CleanControlClassification {
  for (const finding of findings) {
    validateBenchmarkFalsifier(finding.falsifier);
  }
  if (findings.length === 0) {
    return "clean-pass";
  }
  if (findings.some(isSubstantiveClaim)) {
    return "false-substantive";
  }
  return "advisory-preference";
}

export function computeBenchmarkMatrixTurns(
  caseCount: number,
  directionCount: number,
  repeatCount: number,
): number {
  return caseCount * directionCount * repeatCount;
}

export function buildBenchmarkDocument(
  observationPayload: PlainJsonValue,
  runIds: readonly string[],
) {
  const benchmarkResultDigest = canonicalJsonDigest(observationPayload);
  return {
    schema_version: "1",
    benchmark_result_digest: benchmarkResultDigest,
    observation_payload: observationPayload,
    human_scoring: {
      observation_digest: benchmarkResultDigest,
      dispositions: runIds.map((runId) => ({ run_id: runId, disposition: null })),
      primary_metrics: {
        approval_detection_rate: null,
        false_substantive_rate: null,
        triage_completeness: { status: "pending-human-disposition", value: null },
        defects_found_after_pass: { status: "pending-human-disposition", value: null },
      },
    },
  } as const satisfies PlainJsonValue;
}

export async function validateBenchmarkStageAndOutput(
  env: Record<string, string | undefined> = process.env,
): Promise<{ stage: string; output: string }> {
  const stageEnv = env.ARCHFLOW_REVIEW_BENCHMARK_STAGE;
  const outputEnv = env.ARCHFLOW_REVIEW_BENCHMARK_OUTPUT;

  if (!stageEnv || stageEnv.trim().length === 0 || !isAbsolute(stageEnv)) {
    throw new Error("ARCHFLOW_REVIEW_BENCHMARK_STAGE must be an explicit absolute path");
  }
  if (!outputEnv || outputEnv.trim().length === 0 || !isAbsolute(outputEnv)) {
    throw new Error("ARCHFLOW_REVIEW_BENCHMARK_OUTPUT must be an explicit absolute path");
  }

  if (stageEnv.includes("..") || normalize(stageEnv) !== resolve(stageEnv)) {
    throw new Error("ARCHFLOW_REVIEW_BENCHMARK_STAGE must not contain path traversal");
  }
  if (outputEnv.includes("..") || normalize(outputEnv) !== resolve(outputEnv)) {
    throw new Error("ARCHFLOW_REVIEW_BENCHMARK_OUTPUT must not contain path traversal");
  }

  let stageStat;
  try {
    stageStat = await stat(stageEnv);
  } catch {
    throw new Error(`ARCHFLOW_REVIEW_BENCHMARK_STAGE does not exist: ${stageEnv}`);
  }

  if (!stageStat.isDirectory()) {
    throw new Error(`ARCHFLOW_REVIEW_BENCHMARK_STAGE is not a directory: ${stageEnv}`);
  }

  const stageLstat = await lstat(stageEnv);
  if (stageLstat.isSymbolicLink()) {
    throw new Error("ARCHFLOW_REVIEW_BENCHMARK_STAGE must not be a symlink");
  }

  const realStage = await realpath(stageEnv);
  const realTmp = await realpath(os.tmpdir());

  if (realStage === realTmp || !realStage.startsWith(realTmp.endsWith("/") ? realTmp : `${realTmp}/`)) {
    throw new Error(`ARCHFLOW_REVIEW_BENCHMARK_STAGE must be located under temporary directory ${realTmp}`);
  }

  const outputDir = dirname(outputEnv);
  const realOutputDir = await realpath(outputDir).catch(() => resolve(outputDir));

  if (realOutputDir !== realStage) {
    throw new Error("ARCHFLOW_REVIEW_BENCHMARK_OUTPUT must be a direct child of ARCHFLOW_REVIEW_BENCHMARK_STAGE");
  }

  const outputBase = basename(outputEnv);
  if (join(realStage, outputBase) !== resolve(outputEnv)) {
    throw new Error("ARCHFLOW_REVIEW_BENCHMARK_OUTPUT must be a direct child file of the stage");
  }

  try {
    await lstat(outputEnv);
    throw new Error(`ARCHFLOW_REVIEW_BENCHMARK_OUTPUT already exists: ${outputEnv}`);
  } catch (err: unknown) {
    if (err instanceof Error && "code" in err && (err as { code: string }).code === "ENOENT") {
      // Expected: file does not exist yet
    } else {
      throw err;
    }
  }

  const stageEntries = await readdir(realStage);
  if (stageEntries.length > 0) {
    throw new Error("ARCHFLOW_REVIEW_BENCHMARK_STAGE must be an empty directory");
  }

  return { stage: realStage, output: resolve(outputEnv) };
}

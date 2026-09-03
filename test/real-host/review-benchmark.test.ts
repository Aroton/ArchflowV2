import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { performance } from "node:perf_hooks";

import { describe, expect, it } from "vitest";

import reviewOutputSchema from "../../src/contracts/schemas/v1/review.schema.json" with { type: "json" };
import { canonicalJsonBytes, canonicalJsonDigest, sha256Bytes } from "../../src/contracts/canonical.js";
import { parseConfigYaml } from "../../src/contracts/config.js";
import { parseSafeId, parseSafeInteger, parseSha256Digest } from "../../src/contracts/evidence.js";
import { parsePhaseInstanceId } from "../../src/contracts/phase-instance.js";
import type { PlainJsonValue } from "../../src/contracts/plain-json.js";
import { createJsonSchemaValidator } from "../helpers/json-schema.js";
import { loadTestRubric } from "../helpers/rubrics.js";
import { mintReviewObservation, serializeDispatch } from "../../src/dispatch/cli.js";
import { createDispatchCoordinator } from "../../src/dispatch/coordinator.js";
import { resolveDispatchRoute } from "../../src/dispatch/routing.js";
import { buildReviewEnvelope } from "../../src/review/envelopes.js";
import {
  benchmarkEnabled,
  realHostsAvailable,
  requireRealHostsAvailable,
  REVIEW_BENCHMARK_TEST_TIMEOUT_MS,
} from "../helpers/real-host.js";
import { createTaskWorkspace } from "../helpers/task-workspace.js";
import {
  BENCHMARK_DIRECTIONS as directions,
  BENCHMARK_REPEAT_COUNT as repeatCount,
  buildBenchmarkDocument,
  loadCorpusManifest,
  validateBenchmarkStageAndOutput,
  type CorpusCaseV2,
} from "../helpers/review-benchmark.js";

const utf8 = new TextEncoder();
const decoder = new TextDecoder("utf-8", { fatal: true });
const corpusRoot = new URL("../fixtures/corpus/artifacts/", import.meta.url);
const resultPath = join(process.cwd(), "docs", "validation", "review-benchmark.json");

const claudeProducerConfig = `schema_version: "1"
roles:
  counter-reviewer:
    model: gpt-5.6-sol
    effort: xhigh
  adjudicator:
    model: gpt-5.6-sol
    effort: xhigh
`;

const codexProducerConfig = `schema_version: "1"
roles:
  counter-reviewer:
    model: claude-opus-5
    effort: high
  adjudicator:
    model: claude-opus-5
    effort: high
`;

// The benchmark reviews with the exact production design rubric so its measurements are about the
// policy tasks actually run under. Earlier rounds used a two-criterion benchmark-only rubric, which
// measured a rubric no task ever saw; the recorded thresholds in docs/validation say which.
const designRubric = await loadTestRubric("design");
const rubric = designRubric.rubric;
const rubricDigest = designRubric.rubric_digest;
const phase = parsePhaseInstanceId("design");
const validateReviewOutput = createJsonSchemaValidator<Record<string, unknown>>(
  reviewOutputSchema,
);

// Both checks are intentionally captured once at module scope. The short circuit means an ordinary
// test run never probes a CLI, while the second opt-in still requires the real-host opt-in.
const benchmarkAvailable = benchmarkEnabled() && realHostsAvailable();
requireRealHostsAvailable(!benchmarkEnabled() || benchmarkAvailable);

describe("benchmark digest contract", () => {
  it("pins the production design rubric and the twenty-six-run matrix without real model calls", async () => {
    expect(designRubric.rubric_id).toBe("design-v3");
    expect(rubricDigest).toBe("bb840e3ec194160c05b0ff21eb46fe4ef2ab7bd689c6cc0c883d97b1fc4b0dd8");
    expect(rubric.criteria.map((criterion) => criterion.id)).toEqual([
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

    const manifest = await loadCorpusManifest();
    expect(directions).toEqual([
      { id: "claude-to-codex", producer_family: "claude", reviewer_family: "codex" },
      { id: "codex-to-claude", producer_family: "codex", reviewer_family: "claude" },
    ]);
    expect(repeatCount).toBe(1);
    expect(manifest.value.cases.length * directions.length * repeatCount).toBe(26);
  });

  it("keeps human dispositions and derived metrics outside the immutable observation digest", () => {
    const observationPayload = {
      schema_version: "1",
      benchmark_input_digest: "a".repeat(64),
      runs: [{ run_id: "case-1-claude-to-codex-r1", verdict: "fail" }],
    } as const satisfies PlainJsonValue;
    const document = buildBenchmarkDocument(
      observationPayload,
      ["case-1-claude-to-codex-r1"],
    );
    const dispositioned = {
      ...document,
      human_scoring: {
        ...document.human_scoring,
        dispositions: [{
          run_id: "case-1-claude-to-codex-r1",
          disposition: "seed-detected",
        }],
        primary_metrics: {
          approval_detection_rate: 1,
          false_blocker_rate: 0,
          triage_completeness: { status: "complete", value: 1 },
          defects_found_after_pass: { status: "complete", value: 0 },
        },
      },
    } as const satisfies PlainJsonValue;

    expect(canonicalJsonDigest(document.observation_payload)).toBe(document.benchmark_result_digest);
    expect(canonicalJsonDigest(dispositioned.observation_payload)).toBe(document.benchmark_result_digest);
    expect(dispositioned.human_scoring.observation_digest).toBe(document.benchmark_result_digest);
    expect(canonicalJsonDigest({
      ...observationPayload,
      runs: [{ run_id: "case-1-claude-to-codex-r1", verdict: "pass" }],
    })).not.toBe(document.benchmark_result_digest);
  });

  it("binds approved thresholds to the current immutable observation and human scoring", async () => {
    const benchmark = JSON.parse(await readFile(resultPath, "utf8")) as {
      readonly benchmark_result_digest: string;
      readonly human_scoring: { readonly primary_metrics: PlainJsonValue };
    };
    const thresholds = JSON.parse(await readFile(
      join(process.cwd(), "docs", "validation", "thresholds.json"),
      "utf8",
    )) as {
      readonly benchmark_result_digest: string;
      readonly observed_metrics: {
        readonly approval_detection_rate: number;
        readonly defects_found_after_pass: number;
        readonly false_blocker_rate: number;
        readonly triage_completeness: number;
      };
    };

    expect(thresholds.benchmark_result_digest).toBe(benchmark.benchmark_result_digest);
    expect(thresholds.observed_metrics).toEqual({
      approval_detection_rate: 12 / 14,
      defects_found_after_pass: 1,
      false_blocker_rate: 0,
      triage_completeness: 20,
    });
    expect(benchmark.human_scoring.primary_metrics).toEqual({
      approval_detection_rate: 12 / 14,
      defects_found_after_pass: { status: "complete", value: 1 },
      false_blocker_rate: 0,
      triage_completeness: { status: "complete", value: 20 },
    });
  });
});

describe.skipIf(!benchmarkAvailable)("real-host review-quality benchmark", () => {
  it("records both opposite-family directions without asserting a quality threshold", async () => {
    const { stage: _stage, output: stagedOutputPath } = await validateBenchmarkStageAndOutput(process.env);
    const manifest = await loadCorpusManifest();
    const plannedTurns = manifest.value.cases.length * directions.length * repeatCount;
    expect(plannedTurns).toBe(26);

    const benchmarkInput = {
      schema_version: "1",
      corpus_manifest_sha256: sha256Bytes(manifest.bytes),
      rubric_digest: rubricDigest,
      disposition_vocabulary: manifest.value.disposition_vocabulary,
      directions: directions.map((direction) => ({
        id: direction.id,
        producer_family: direction.producer_family,
        reviewer_family: direction.reviewer_family,
      })),
      repeat_count_per_direction: repeatCount,
      serialized_model_turn_count: plannedTurns,
    } as const satisfies PlainJsonValue;
    const benchmarkInputDigest = canonicalJsonDigest(benchmarkInput);
    const observations: PlainJsonValue[] = [];
    const runIds: string[] = [];
    const started = performance.now();

    for (const direction of directions) {
      const configSource = direction.producer_family === "claude"
        ? claudeProducerConfig
        : codexProducerConfig;
      const config = parseConfigYaml(configSource, `${direction.id} benchmark config`);
      const workspace = await createTaskWorkspace({
        taskId: `benchmark-${direction.id}`,
        label: `benchmark-${direction.id}`,
        operation: "review-benchmark",
        configBytes: utf8.encode(configSource),
      });

      try {
        const route = resolveDispatchRoute(config, "phase-impl", "counter-reviewer");
        expect(route.family).toBe(direction.reviewer_family);
        const dispatch = createDispatchCoordinator({
          authority: workspace.services.authority,
          dependencies: workspace.services.dependencies,
          host: direction.producer_family,
          repository_root: workspace.root,
          phase_instance: phase,
          signal: new AbortController().signal,
          cancellation_source: "client",
        });

        for (const corpusCase of manifest.value.cases) {
          const artifactBytes = await readFile(new URL(corpusCase.artifact, corpusRoot));
          const artifactDigest = sha256Bytes(artifactBytes);
          expect(artifactDigest).toBe(parseSha256Digest(corpusCase.artifact_sha256));
          const artifact = decoder.decode(artifactBytes);

          for (let repeat = 1; repeat <= repeatCount; repeat += 1) {
            const runId = parseSafeId(`${corpusCase.id}-${direction.id}-r${String(repeat)}`);
            const inputFingerprint = canonicalJsonDigest({
              benchmark_input_digest: benchmarkInputDigest,
              artifact_sha256: artifactDigest,
              direction: direction.id,
              repeat,
            });
            const subject = {
              task_id: workspace.taskId,
              phase_instance: phase,
              role: "counter-review" as const,
              step: "counter_review" as const,
              attempt: parseSafeInteger(1),
              subject_digest: artifactDigest,
              input_fingerprint: inputFingerprint,
              rubric_digest: rubricDigest,
              producer_family: direction.producer_family,
              invocation_id: parseSafeId(`invocation-${runId}`),
              result_id: parseSafeId(`result-${runId}`),
            };
            const envelope = buildReviewEnvelope({ artifact, rubric, context: [], subject });
            const dispatched = await serializeDispatch(() =>
              dispatch(route, envelope, reviewOutputSchema as PlainJsonValue));

            // The production adapter supplies this same schema to the CLI. Validate again before
            // attestation so the benchmark records only schema-valid model output.
            const rawOutput = JSON.parse(decoder.decode(dispatched.extracted_output_bytes)) as unknown;
            validateReviewOutput.assert(rawOutput, `${runId} review output`);
            const observed = mintReviewObservation({
              subject,
              adapter: route.adapter,
              cli_version: dispatched.cli_version,
              route,
              repositories: [{
                name: "primary",
                repository_identity_digest: workspace.initialization.repository_identity_digest,
                commit: workspace.initialization.code_baseline_commit,
              }],
              envelope_input_digest: envelope.digest,
              extracted_output_bytes: dispatched.extracted_output_bytes,
            });
            const evidence = observed.evidence;
            expect(evidence.assurance).toBe("server-attested");
            expect(evidence.model_family).toBe(direction.reviewer_family);

            observations.push({
              run_id: runId,
              case_id: corpusCase.id,
              case_kind: corpusCase.kind,
              expectation_id: corpusCase.kind === "seeded" ? corpusCase.expectation_id : null,
              seeded_claim: corpusCase.kind === "seeded" ? corpusCase.seeded_claim : null,
              direction: direction.id,
              repeat,
              artifact_sha256: artifactDigest,
              envelope_input_sha256: envelope.digest,
              observed_output_sha256: evidence.observed_output_digest,
              reviewer: {
                adapter: evidence.adapter,
                family: evidence.model_family,
                model: evidence.model,
                effort: evidence.effort,
                cli_version: evidence.cli_version,
              },
              verdict: evidence.verdict,
              ...(evidence.schema_version === "2"
                ? { total_findings: evidence.total_findings, partition_counts: evidence.partition_counts }
                : { blocking_count: evidence.blocking_count }),
              findings: evidence.findings,
            });
            runIds.push(runId);
          }
        }
      } finally {
        workspace.dispose();
      }
    }

    const elapsedSeconds = Math.round((performance.now() - started) / 100) / 10;
    const observationRecord = (entry: PlainJsonValue): Readonly<Record<string, PlainJsonValue>> | undefined =>
      typeof entry === "object" && entry !== null && !Array.isArray(entry)
        ? entry as Readonly<Record<string, PlainJsonValue>>
        : undefined;
    const failedRuns = observations.filter((entry) => {
      const verdict = observationRecord(entry)?.verdict;
      return verdict === "fail" || verdict === "review-raised";
    }).length;
    const substantiveRuns = observations.filter((entry) => {
      const observation = observationRecord(entry);
      const partitions = observationRecord(observation?.partition_counts as PlainJsonValue);
      if (partitions === undefined) {
        const verdict = observation?.verdict;
        return verdict === "fail" || verdict === "review-raised";
      }
      return Object.entries(partitions).some(([key, value]) =>
        !key.startsWith("preference:") && typeof value === "number" && value > 0,
      );
    }).length;
    const advisoryRuns = observations.filter((entry) => {
      const observation = observationRecord(entry);
      const partitions = observationRecord(observation?.partition_counts as PlainJsonValue);
      if (partitions === undefined) return false;
      const hasSubstantive = Object.entries(partitions).some(([key, value]) =>
        !key.startsWith("preference:") && typeof value === "number" && value > 0,
      );
      if (hasSubstantive) return false;
      return Object.entries(partitions).some(([key, value]) =>
        key.startsWith("preference:") && typeof value === "number" && value > 0,
      );
    }).length;
    const observationPayload = {
      schema_version: "1",
      benchmark_input_digest: benchmarkInputDigest,
      rubric_digest: rubricDigest,
      run_conditions: {
        serialized_model_turn_count: plannedTurns,
        repeat_count_per_direction: repeatCount,
        wall_clock_seconds: elapsedSeconds,
        sample_size_note: "Thirteen corpus cases, two producer directions, one real model turn per case and direction; all twenty-six turns were serialized by the production dispatch FIFO.",
      },
      runs: observations,
      secondary_raw_telemetry: {
        fail_verdict_count: failedRuns,
        fail_verdict_rate: failedRuns / plannedTurns,
        substantive_run_count: substantiveRuns,
        substantive_run_rate: substantiveRuns / plannedTurns,
        advisory_run_count: advisoryRuns,
        advisory_run_rate: advisoryRuns / plannedTurns,
      },
    } as const satisfies PlainJsonValue;
    const document = buildBenchmarkDocument(observationPayload, runIds);

    await writeFile(stagedOutputPath, canonicalJsonBytes(document), { flag: "wx", mode: 0o644 });
    expect(observations).toHaveLength(plannedTurns);
    expect(runIds).toHaveLength(plannedTurns);
    expect(new Set(runIds).size).toBe(plannedTurns);
  }, REVIEW_BENCHMARK_TEST_TIMEOUT_MS);
});

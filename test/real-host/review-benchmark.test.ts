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
import { parseRubricV1 } from "../../src/contracts/rubric.js";
import { createJsonSchemaValidator } from "../helpers/json-schema.js";
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

type CorpusCase = Readonly<{
  id: string;
  artifact: string;
  artifact_sha256: string;
  kind: "seeded" | "control";
  expected_outcome: "blocking-finding" | "pass";
  seeded_defect: string | null;
}>;

type CorpusManifest = Readonly<{
  schema_version: "1";
  disposition_vocabulary: Readonly<{
    seeded: readonly ["seed-detected", "unrelated-blocker", "missed"];
    control: readonly ["clean-pass", "false-blocker"];
  }>;
  cases: readonly CorpusCase[];
}>;

const utf8 = new TextEncoder();
const decoder = new TextDecoder("utf-8", { fatal: true });
const corpusRoot = new URL("../fixtures/corpus/artifacts/", import.meta.url);
const resultPath = join(process.cwd(), "docs", "validation", "review-benchmark.json");
const repeatCount = 1;
const directions = Object.freeze([
  Object.freeze({ id: "claude-to-codex", producer_family: "claude" as const, reviewer_family: "codex" as const }),
  Object.freeze({ id: "codex-to-claude", producer_family: "codex" as const, reviewer_family: "claude" as const }),
]);

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

const rubric = parseRubricV1({
  schema_version: "1",
  kind: "artifact",
  mode: "adversarial",
  criteria: [
    {
      id: "substantive-correctness",
      text: "Report a blocking defect only when it requires producer action, and cite the specific artifact statement it contradicts or stated requirement it leaves unmet; citation is necessary but not sufficient. The violation must follow from the artifact's own text without assuming implementation behavior, ordering, or environment it does not specify. A contradiction that depends on such an assumption, or a debatable reading of whether stated text satisfies a criterion, is not blocking. Missing handling is a defect only for a condition the artifact claims to cover or a stated requirement demands. Local edge-case handling belongs to the implementer. A sound artifact is expected to yield zero blocking findings; that is successful review, not under-performance.",
      blocking: true,
    },
    {
      id: "advisory-observations",
      text: "Use non-blocking findings for completeness suggestions, debatable readings, and observations, including handling for conditions outside the artifact's stated scope. Do not inflate them into blockers merely to report them.",
      blocking: false,
    },
  ],
});
const rubricDigest = canonicalJsonDigest(rubric as unknown as PlainJsonValue);
const phase = parsePhaseInstanceId("prd");
const validateReviewOutput = createJsonSchemaValidator<Record<string, unknown>>(
  reviewOutputSchema,
);

function buildBenchmarkDocument(
  observationPayload: PlainJsonValue,
  runIds: readonly string[],
) {
  // thresholds.json binds this digest. Human dispositions and the metrics derived from them live
  // beside, rather than inside, the immutable payload so recording them cannot move that binding.
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
        false_blocker_rate: null,
        triage_completeness: { status: "pending-human-disposition", value: null },
        defects_found_after_pass: { status: "pending-human-disposition", value: null },
      },
    },
  } as const satisfies PlainJsonValue;
}

// Both checks are intentionally captured once at module scope. The short circuit means an ordinary
// test run never probes a CLI, while the second opt-in still requires the real-host opt-in.
const benchmarkAvailable = benchmarkEnabled() && realHostsAvailable();
requireRealHostsAvailable(!benchmarkEnabled() || benchmarkAvailable);

describe("benchmark digest contract", () => {
  it("pins the recalibrated rubric and unchanged twelve-run matrix without real model calls", async () => {
    expect(rubric.criteria).toEqual([
      {
        id: "substantive-correctness",
        text: "Report a blocking defect only when it requires producer action, and cite the specific artifact statement it contradicts or stated requirement it leaves unmet; citation is necessary but not sufficient. The violation must follow from the artifact's own text without assuming implementation behavior, ordering, or environment it does not specify. A contradiction that depends on such an assumption, or a debatable reading of whether stated text satisfies a criterion, is not blocking. Missing handling is a defect only for a condition the artifact claims to cover or a stated requirement demands. Local edge-case handling belongs to the implementer. A sound artifact is expected to yield zero blocking findings; that is successful review, not under-performance.",
        blocking: true,
      },
      {
        id: "advisory-observations",
        text: "Use non-blocking findings for completeness suggestions, debatable readings, and observations, including handling for conditions outside the artifact's stated scope. Do not inflate them into blockers merely to report them.",
        blocking: false,
      },
    ]);

    const manifest = await loadManifest();
    expect(directions).toEqual([
      { id: "claude-to-codex", producer_family: "claude", reviewer_family: "codex" },
      { id: "codex-to-claude", producer_family: "codex", reviewer_family: "claude" },
    ]);
    expect(repeatCount).toBe(1);
    expect(manifest.value.cases.length * directions.length * repeatCount).toBe(12);
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
      approval_detection_rate: 2 / 3,
      defects_found_after_pass: 2,
      false_blocker_rate: 0,
      triage_completeness: 12,
    });
    expect(benchmark.human_scoring.primary_metrics).toEqual({
      approval_detection_rate: 2 / 3,
      defects_found_after_pass: { status: "complete", value: 2 },
      false_blocker_rate: 0,
      triage_completeness: { status: "complete", value: 12 },
    });
  });
});

async function loadManifest(): Promise<Readonly<{ bytes: Uint8Array; value: CorpusManifest }>> {
  const bytes = await readFile(new URL("manifest.json", corpusRoot));
  const value = JSON.parse(decoder.decode(bytes)) as CorpusManifest;
  expect(value.schema_version).toBe("1");
  expect(value.disposition_vocabulary).toEqual({
    seeded: ["seed-detected", "unrelated-blocker", "missed"],
    control: ["clean-pass", "false-blocker"],
  });
  expect(value.cases).toHaveLength(6);
  return { bytes, value };
}

describe.skipIf(!benchmarkAvailable)("real-host review-quality benchmark", () => {
  it("records both opposite-family directions without asserting a quality threshold", async () => {
    const manifest = await loadManifest();
    const plannedTurns = manifest.value.cases.length * directions.length * repeatCount;
    expect(plannedTurns).toBe(12);

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
              seeded_defect: corpusCase.seeded_defect,
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
              blocking_count: evidence.blocking_count,
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
    const failedRuns = observations.filter((entry) => observationRecord(entry)?.verdict === "fail").length;
    const blockingRuns = observations.filter((entry) => {
      const count = observationRecord(entry)?.blocking_count;
      return typeof count === "number" && count > 0;
    }).length;
    const observationPayload = {
      schema_version: "1",
      benchmark_input_digest: benchmarkInputDigest,
      rubric_digest: rubricDigest,
      run_conditions: {
        serialized_model_turn_count: plannedTurns,
        repeat_count_per_direction: repeatCount,
        wall_clock_seconds: elapsedSeconds,
        sample_size_note: "Six corpus cases, two producer directions, one real model turn per case and direction; all twelve turns were serialized by the production dispatch FIFO.",
      },
      runs: observations,
      secondary_raw_telemetry: {
        fail_verdict_count: failedRuns,
        fail_verdict_rate: failedRuns / plannedTurns,
        blocking_run_count: blockingRuns,
        blocking_run_rate: blockingRuns / plannedTurns,
      },
    } as const satisfies PlainJsonValue;
    const document = buildBenchmarkDocument(observationPayload, runIds);

    await mkdir(dirname(resultPath), { recursive: true });
    await writeFile(resultPath, canonicalJsonBytes(document), { mode: 0o644 });
    expect(observations).toHaveLength(plannedTurns);
    expect(runIds).toHaveLength(plannedTurns);
    expect(new Set(runIds).size).toBe(plannedTurns);
  }, REVIEW_BENCHMARK_TEST_TIMEOUT_MS);
});

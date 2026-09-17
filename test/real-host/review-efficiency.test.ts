/**
 * The opt-in live paired experiment: twenty-eight real reviewer turns on the fixed route against
 * real hosts. Doubly gated behind ARCHFLOW_REAL_HOSTS and ARCHFLOW_REVIEW_EFFICIENCY, with an
 * explicit absolute stage and output; an inconclusive run fails visibly instead of skipping.
 */

import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { expect, it } from "vitest";

import {
  PLANNED_TURNS,
  REVIEW_EFFICIENCY_OPT_IN_ENV,
  REVIEW_EFFICIENCY_TEST_TIMEOUT_MS,
  runReviewEfficiencyExperiment,
  validateEfficiencyDocument,
  validateEfficiencyStageAndOutput,
  type EfficiencyCheckpoint,
  type EfficiencyObservationDocument,
} from "../helpers/review-efficiency/index.js";

const repositoryRoot = fileURLToPath(new URL("../../", import.meta.url));
const optedIn = process.env.ARCHFLOW_REAL_HOSTS === "1" &&
  process.env[REVIEW_EFFICIENCY_OPT_IN_ENV] === "1";

(optedIn ? it : it.skip)("completes the paired reviewer-efficiency experiment against real hosts", async () => {
  const paths = await validateEfficiencyStageAndOutput(process.env);
  const outcome = await runReviewEfficiencyExperiment({
    stage: paths.stage,
    output: paths.output,
    repositoryRoot,
    log: (line) => console.log(`[review-efficiency] ${line}`),
  });
  if (outcome.status === "inconclusive") {
    throw new Error(
      `the live review-efficiency run was inconclusive: ${outcome.reason}` +
      (outcome.output === undefined ? "" : ` (observation staged at ${outcome.output})`),
    );
  }
  const document = JSON.parse(new TextDecoder().decode(new Uint8Array(await readFile(outcome.output)))) as EfficiencyObservationDocument;
  expect(document.human_assessment.final_assessment).toBeNull();
  expect(() => validateEfficiencyDocument(document)).not.toThrow();
  const payload = document.observation_payload as Readonly<{ groups: EfficiencyCheckpoint["groups"] }>;
  expect(payload.groups).toHaveLength(12);
  const succeededRoles = payload.groups
    .flatMap((group) => group.roles)
    .filter((role) => role.status === "succeeded" && role.attempts.some((attempt) => attempt.status === "succeeded"));
  expect(succeededRoles).toHaveLength(PLANNED_TURNS);
}, REVIEW_EFFICIENCY_TEST_TIMEOUT_MS);

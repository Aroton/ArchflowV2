/**
 * Opt-in semantic probe for the implementation-review scope boundary. It is intentionally outside
 * release checks: model judgment is useful validation evidence, not a deterministic build gate.
 */
import { execFileSync } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { describe, expect, it, type TestContext } from "vitest";

import {
  createRawAdjudicationV2Schema,
  type AdjudicationRuleSlotV1,
} from "../../src/contracts/adjudication.js";
import type { GitOid } from "../../src/contracts/canonical.js";
import { parseConfigYaml } from "../../src/contracts/config.js";
import { reviewReportOutputSchema } from "../../src/contracts/review.js";
import { CliAdapterError, preflightAdapter, serializeDispatchAll } from "../../src/dispatch/cli.js";
import { createReviewDispatcher } from "../../src/dispatch/coordinator.js";
import { DispatchProcessError } from "../../src/dispatch/process.js";
import type { DispatchRoute } from "../../src/dispatch/routing.js";
import { configuredRoute } from "../helpers/dispatch-routes.js";
import {
  createDispatchWorkspace,
  projectRepositoryWorkspaceBinding,
  shareRepositoryViewWorkspace,
  type DispatchRepositoryViewPlan,
} from "../../src/dispatch/workspace.js";
import { sealDispatchInput, type DispatchEnvelope } from "../../src/review/envelopes.js";
import { dispatchInputRecord } from "../../src/review/inputs.js";
import { reviewAssignment } from "../../src/review/rubrics.js";
import { loadTestRubric } from "../helpers/rubrics.js";
import {
  REAL_HOST_TEST_TIMEOUT_MS,
  realHostsEnabled,
} from "../helpers/real-host.js";
import { createReviewRepository } from "../helpers/review-repository.js";
import { standaloneReviewFields } from "../helpers/standalone-review-input.js";

const enabled = realHostsEnabled();
const utf8 = new TextEncoder();
const decoder = new TextDecoder("utf-8", { fatal: true });
const selectedRubric = await loadTestRubric("phase-impl");

const directions = Object.freeze([
  Object.freeze({
    id: "codex",
    producer: "claude" as const,
    adapter: "codex-cli" as const,
    family: "codex" as const,
    config: `schema_version: "1"\nroles:\n  counter-reviewer: {model: gpt-5.6-sol, effort: medium}\n  test-reviewer: {model: gpt-5.6-luna, effort: xhigh}\n  adjudicator: {model: gpt-5.6-sol, effort: medium}\n`,
  }),
  Object.freeze({
    id: "claude",
    producer: "codex" as const,
    adapter: "claude-cli" as const,
    family: "claude" as const,
    config: `schema_version: "1"\nroles:\n  counter-reviewer: {model: claude-fable-5, effort: medium}\n  test-reviewer: {model: claude-fable-5, effort: medium}\n  adjudicator: {model: claude-fable-5, effort: medium}\n`,
  }),
  Object.freeze({
    id: "gemini",
    producer: "claude" as const,
    adapter: "antigravity-cli" as const,
    family: "gemini" as const,
    config: `schema_version: "1"\nroles:\n  counter-reviewer: {model: gemini-3.7-flash-high, effort: high}\n  test-reviewer: {model: gemini-3.7-flash-high, effort: high}\n  adjudicator: {model: gemini-3.7-flash-high, effort: high}\n`,
  }),
]);

async function skipUnavailable(context: TestContext, direction: (typeof directions)[number]): Promise<void> {
  const probe = await createDispatchWorkspace(direction.adapter, process.cwd());
  try {
    await preflightAdapter(direction.adapter, probe);
  } catch (error) {
    if ((error instanceof CliAdapterError || error instanceof DispatchProcessError) &&
        ["AUTH_UNAVAILABLE", "CLI_VERSION_UNSUPPORTED", "PROCESS_FAILED"].includes(error.project_error.code)) {
      context.skip(`${direction.family} unavailable: ${error.project_error.code}`);
      return;
    }
    throw error;
  } finally {
    await probe.dispose();
  }
}

async function dispatchOrSkip<T>(context: TestContext, operation: () => Promise<T>): Promise<T> {
  try {
    return await operation();
  } catch (error) {
    if (error instanceof CliAdapterError && [
      "AUTH_UNAVAILABLE", "CLI_VERSION_UNSUPPORTED", "UNSUPPORTED_MODEL",
    ].includes(error.project_error.code)) {
      context.skip(`host unavailable during dispatch: ${error.project_error.code}`);
    }
    throw error;
  }
}

/** Dispatches one sealed input with the response schema it carries, as the standalone review does. */
const serialized = (dispatch: ReturnType<typeof createReviewDispatcher>, route: DispatchRoute, envelope: DispatchEnvelope) =>
  serializeDispatchAll([() => dispatch(route, envelope, dispatchInputRecord(envelope).response_schema!)]).then(([result]) => result!);

function git(root: string, ...argv: string[]): string {
  return execFileSync("git", argv, { cwd: root, encoding: "utf8" }).trim();
}

describe.skipIf(!enabled)("real-host reviewer-owned evidence scope", () => {
  for (const direction of directions) {
    it(`keeps role-scoped reviews and constitution judgments to the declared outputs for ${direction.id}`, async (context) => {
      await skipUnavailable(context, direction);
      const workspace = await createReviewRepository({ label: `scope-${direction.id}`, configBytes: utf8.encode(direction.config) });
      let disposeViews = async (): Promise<void> => undefined;
      try {
        await mkdir(join(workspace.root, "src"), { recursive: true });
        await writeFile(join(workspace.root, "src", "format-count.js"),
          "export const formatCount = (value) => String(value);\n");
        await writeFile(join(workspace.root, "src", "summary.js"), [
          'import { formatCount } from "./format-count.js";',
          "export const summary = (value) => formatCount(value).toUpperCase();",
          "",
        ].join("\n"));
        await writeFile(join(workspace.root, "src", "legacy-auth.js"), [
          "// Pre-existing unrelated defect: this legacy check always grants access.",
          "export const legacyAllowsAccess = () => true;",
          "",
        ].join("\n"));
        git(workspace.root, "add", "--", "src");
        git(workspace.root, "commit", "-q", "-m", "scope probe baseline");
        const baseline = git(workspace.root, "rev-parse", "HEAD") as GitOid;

        // The phase changes only this producer. The unchanged consumer now throws because numbers
        // do not have toUpperCase(); legacy-auth.js remains defective but is outside the phase.
        await writeFile(join(workspace.root, "src", "format-count.js"),
          "export const formatCount = (value) => Number(value);\n");
        git(workspace.root, "add", "--", "src/format-count.js");
        git(workspace.root, "commit", "-q", "-m", "phase after-image");
        const after = git(workspace.root, "rev-parse", "HEAD") as GitOid;

        const artifact = `${JSON.stringify({
          schema_version: "1",
          artifact_kind: "implementation-output",
          phase: "phase-impl-1",
          baseline_commit: baseline,
          declared_outputs: [{
            path: "src/format-count.js",
            operation: "modify",
            before: "formatCount returns a string",
            after: "formatCount returns a number",
          }],
          co_produced_documents: [],
        }, null, 2)}\n`;
        // The standalone review's view plan: the work under review as primary, its starting commit as baseline.
        const repositoryViews: DispatchRepositoryViewPlan = Object.freeze([Object.freeze({
          name: "primary" as const,
          member_kind: "primary" as const,
          repository_root: workspace.root,
          repository_identity_digest: workspace.repository_identity_digest,
          commit: after,
        }), Object.freeze({
          name: "baseline",
          member_kind: "secondary" as const,
          repository_root: workspace.root,
          repository_identity_digest: workspace.repository_identity_digest,
          commit: baseline,
        })]);
        const shared = shareRepositoryViewWorkspace(repositoryViews, workspace.root);
        disposeViews = shared.dispose;
        const config = parseConfigYaml(direction.config, `${direction.id} scope config`);
        const generalRoute = configuredRoute(config, "phase-impl", "counter-reviewer");
        const testRoute = configuredRoute(config, "phase-impl", "test-reviewer");
        const adjudicationRoute = configuredRoute(config, "phase-impl", "adjudicator");
        for (const route of [generalRoute, testRoute, adjudicationRoute]) {
          expect(route).toMatchObject({ adapter: direction.adapter, family: direction.family });
        }
        const fields = standaloneReviewFields({
          subject: artifact,
          paths: ["src/format-count.js"],
          workspace: projectRepositoryWorkspaceBinding(repositoryViews),
        });
        const generalAssignment = reviewAssignment("counter-reviewer-1", "general", "phase-impl", selectedRubric.rubric);
        const generalEnvelope = sealDispatchInput("review", { ...fields, assignment: generalAssignment, rubric: selectedRubric.rubric });
        const dispatch = createReviewDispatcher({
          host: direction.producer,
          repository_root: workspace.root,
          signal: new AbortController().signal,
          cancellation_source: "client",
          shared_workspace: shared,
        });
        const generalResult = await dispatchOrSkip(context, () => serialized(dispatch, generalRoute, generalEnvelope));
        const generalReport = reviewReportOutputSchema.strict().parse(JSON.parse(decoder.decode(generalResult.extracted_output_bytes))).feedback.toLowerCase();
        expect(generalReport).toContain("format-count");
        expect(["summary", "touppercase", "call site", "consumer", "string operation", "interface"].some(term => generalReport.includes(term)), generalReport).toBe(true);
        expect(generalReport.includes("legacy-auth") || generalReport.includes("always grants access"), generalReport).toBe(false);

        const testAssignment = reviewAssignment("test-reviewer-1", "tests", "phase-impl", selectedRubric.rubric);
        const testEnvelope = sealDispatchInput("review", { ...fields, assignment: testAssignment, rubric: selectedRubric.rubric });
        const testResult = await dispatchOrSkip(context, () => serialized(dispatch, testRoute, testEnvelope));
        const testReport = reviewReportOutputSchema.strict().parse(JSON.parse(decoder.decode(testResult.extracted_output_bytes))).feedback;
        expect(testReport.trim().length).toBeGreaterThan(0);
        expect(testReport.toLowerCase()).toMatch(/test|assert|coverage|regression/u);

        const ruleSlots: readonly AdjudicationRuleSlotV1[] = Object.freeze([
          Object.freeze({ slot: "scope-b", rule_id: "consumer-compatibility", rule_version: 1 }),
          Object.freeze({ slot: "scope-a", rule_id: "declared-output-scope", rule_version: 1 }),
        ]);
        const adjudicationEnvelope = sealDispatchInput("adjudication", {
          ...fields,
          rules: [
            {
              slot: "scope-b",
              text: "A declared output must preserve the behavior required by its unchanged direct consumers.",
              review_trigger: "A declared output breaks an unchanged direct consumer.",
              enforced_by: ["repository-view-inspection"],
            },
            {
              slot: "scope-a",
              text: "Judge only declared outputs and do not treat unrelated pre-existing defects as this phase's work.",
              enforced_by: ["declared-output-review-scope"],
            },
          ],
        });
        const adjudicationResult = await dispatchOrSkip(context, () => serialized(dispatch, adjudicationRoute, adjudicationEnvelope));
        const adjudication = createRawAdjudicationV2Schema(ruleSlots).parse(
          JSON.parse(decoder.decode(adjudicationResult.extracted_output_bytes)),
        );
        expect(adjudication.schema_version).toBe("2");
        expect(Object.keys(adjudication.judgments).sort()).toEqual(["scope-a", "scope-b"]);
        expect(["fail", "uncertain"]).toContain(adjudication.judgments["scope-b"]?.compliance);
        expect(["matched", "uncertain"]).toContain(adjudication.judgments["scope-b"]?.trigger);
      } finally {
        await disposeViews();
        workspace.dispose();
      }
    }, REAL_HOST_TEST_TIMEOUT_MS);
  }
});

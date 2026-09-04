/**
 * Opt-in semantic probe for the implementation-review scope boundary. It is intentionally outside
 * release checks: model judgment is useful validation evidence, not a deterministic build gate.
 */
import { execFileSync } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { describe, expect, it, type TestContext } from "vitest";

import reviewOutputSchema from "../../src/contracts/schemas/v1/review.schema.json" with { type: "json" };
import {
  createRawAdjudicationV2Schema,
  parseRawAdjudicationV2,
  type AdjudicationRuleSlotV1,
} from "../../src/contracts/adjudication.js";
import { canonicalJsonDigest, sha256Bytes, type GitOid } from "../../src/contracts/canonical.js";
import { parseConfigYaml } from "../../src/contracts/config.js";
import { parseSafeId, parseSafeInteger } from "../../src/contracts/evidence.js";
import { parsePhaseInstanceId } from "../../src/contracts/phase-instance.js";
import type { PlainJsonValue } from "../../src/contracts/plain-json.js";
import {
  parseGeneralReviewOutputV3,
  parseTestReviewOutputV3,
} from "../../src/contracts/review.js";
import { CliAdapterError, preflightAdapter, serializeDispatch } from "../../src/dispatch/cli.js";
import { createDispatchCoordinator } from "../../src/dispatch/coordinator.js";
import { DispatchProcessError } from "../../src/dispatch/process.js";
import { resolveDispatchRoute } from "../../src/dispatch/routing.js";
import {
  createDispatchWorkspace,
  projectRepositoryWorkspaceBinding,
  type DispatchRepositoryViewPlan,
} from "../../src/dispatch/workspace.js";
import { buildAdjudicationEnvelope, buildReviewEnvelope } from "../../src/review/envelopes.js";
import { reviewAssignment } from "../../src/review/rubrics.js";
import { loadTestRubric } from "../helpers/rubrics.js";
import {
  REAL_HOST_TEST_TIMEOUT_MS,
  realHostsEnabled,
} from "../helpers/real-host.js";
import { createTaskWorkspace } from "../helpers/task-workspace.js";

const enabled = realHostsEnabled();
const utf8 = new TextEncoder();
const decoder = new TextDecoder("utf-8", { fatal: true });
const phase = parsePhaseInstanceId("phase-impl-1");
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

function git(root: string, ...argv: string[]): string {
  return execFileSync("git", argv, { cwd: root, encoding: "utf8" }).trim();
}

describe.skipIf(!enabled)("real-host reviewer-owned evidence scope", () => {
  for (const direction of directions) {
    it(`records role-scoped Review V3 and judgment-only Adjudication V2 for ${direction.id}`, async (context) => {
      await skipUnavailable(context, direction);
      const workspace = await createTaskWorkspace({
        taskId: `scope-${direction.id}`,
        operation: "real-review-scope",
        configBytes: utf8.encode(direction.config),
      });
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
        const repositoryViews: DispatchRepositoryViewPlan = Object.freeze([Object.freeze({
          name: "primary" as const,
          member_kind: "primary" as const,
          repository_root: workspace.root,
          repository_identity_digest: workspace.initialization.repository_identity_digest,
          commit: after,
        })]);
        const config = parseConfigYaml(direction.config, `${direction.id} scope config`);
        const generalRoute = resolveDispatchRoute(config, "phase-impl", "counter-reviewer");
        const testRoute = resolveDispatchRoute(config, "phase-impl", "test-reviewer");
        const adjudicationRoute = resolveDispatchRoute(config, "phase-impl", "adjudicator");
        for (const route of [generalRoute, testRoute, adjudicationRoute]) {
          expect(route).toMatchObject({ adapter: direction.adapter, family: direction.family });
        }
        const subjectBase = {
          task_id: workspace.taskId,
          phase_instance: phase,
          role: "counter-review" as const,
          step: "counter_review" as const,
          attempt: parseSafeInteger(1),
          subject_digest: sha256Bytes(utf8.encode(artifact)),
          input_fingerprint: canonicalJsonDigest({ probe: direction.id, baseline, after }),
          rubric_digest: selectedRubric.rubric_digest,
          producer_family: direction.producer,
        };
        const generalAssignment = reviewAssignment(
          "general", "general", "phase-impl", selectedRubric.rubric,
          { expected_upstream_digests: [] },
        );
        const generalEnvelope = buildReviewEnvelope({
          artifact,
          rubric: selectedRubric.rubric,
          assignment: generalAssignment,
          context: [],
          workspace: projectRepositoryWorkspaceBinding(repositoryViews),
          subject: {
            ...subjectBase,
            invocation_id: parseSafeId(`invocation-general-${direction.id}`),
            result_id: parseSafeId(`result-general-${direction.id}`),
          },
        });
        const dispatch = createDispatchCoordinator({
          authority: workspace.services.authority,
          dependencies: workspace.services.dependencies,
          host: direction.producer,
          repository_root: workspace.root,
          phase_instance: phase,
          signal: new AbortController().signal,
          cancellation_source: "client",
          repository_views: repositoryViews,
        });
        const generalResult = await dispatchOrSkip(context, () => serializeDispatch(() =>
          dispatch(generalRoute, generalEnvelope, reviewOutputSchema as PlainJsonValue)));
        const expectedUpstreamDigests = generalAssignment.expected_upstream_digests;
        if (expectedUpstreamDigests === undefined) {
          throw new TypeError("primary general scope probe must own upstream alignment");
        }
        const general = parseGeneralReviewOutputV3(
          JSON.parse(decoder.decode(generalResult.extracted_output_bytes)),
          {
            criterion_ids: generalAssignment.criterion_ids,
            expected_upstream_digests: expectedUpstreamDigests,
          },
        );
        expect(general.schema_version).toBe("3");
        expect(general.upstream_alignment).toEqual([]);
        expect(general.findings.every((finding) => generalAssignment.criterion_ids.includes(finding.criterion_id))).toBe(true);
        const findings = general.findings.map((finding) =>
          `${finding.finding_id} ${finding.summary} ${finding.evidence} ${finding.suggested_resolution}`.toLowerCase());

        expect(findings.some((finding) =>
          finding.includes("format-count") &&
          ["summary", "touppercase", "call site", "consumer", "string operation", "interface"]
            .some((term) => finding.includes(term))), JSON.stringify(general.findings)).toBe(true);
        expect(findings.some((finding) =>
          finding.includes("legacy-auth") || finding.includes("always grants access")), JSON.stringify(general.findings)).toBe(false);

        const testAssignment = reviewAssignment("test", "tests", "phase-impl", selectedRubric.rubric);
        const testEnvelope = buildReviewEnvelope({
          artifact,
          rubric: selectedRubric.rubric,
          assignment: testAssignment,
          context: [],
          workspace: projectRepositoryWorkspaceBinding(repositoryViews),
          subject: {
            ...subjectBase,
            invocation_id: parseSafeId(`invocation-test-${direction.id}`),
            result_id: parseSafeId(`result-test-${direction.id}`),
          },
        });
        const testResult = await dispatchOrSkip(context, () => serializeDispatch(() =>
          dispatch(testRoute, testEnvelope, reviewOutputSchema as PlainJsonValue)));
        const testReview = parseTestReviewOutputV3(
          JSON.parse(decoder.decode(testResult.extracted_output_bytes)),
          { criterion_ids: testAssignment.criterion_ids },
        );
        expect(testReview.schema_version).toBe("3");
        expect(testReview.findings.length).toBeGreaterThan(0);
        expect(testReview.findings.every((finding) =>
          testAssignment.criterion_ids.includes(finding.criterion_id))).toBe(true);
        expect(testReview.findings.every((finding) =>
          finding.required_behavior_or_risk_boundary.trim().length > 0 &&
          finding.coverage_or_oracle_problem.trim().length > 0 &&
          finding.consequence.trim().length > 0 &&
          finding.proposed_verification_change.trim().length > 0)).toBe(true);

        const ruleSlots: readonly AdjudicationRuleSlotV1[] = Object.freeze([
          Object.freeze({ slot: "scope-b", rule_id: "consumer-compatibility", rule_version: 1 }),
          Object.freeze({ slot: "scope-a", rule_id: "declared-output-scope", rule_version: 1 }),
        ]);
        const adjudicationEnvelope = buildAdjudicationEnvelope({
          artifact,
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
          source_review_envelope_digest: generalEnvelope.digest,
          workspace: projectRepositoryWorkspaceBinding(repositoryViews),
          subject: {
            task_id: workspace.taskId,
            phase_instance: phase,
            role: "adjudication",
            step: "adjudicate",
            subject_digest: subjectBase.subject_digest,
            input_fingerprint: subjectBase.input_fingerprint,
            pinned_constitution_digest: canonicalJsonDigest({ probe: "constitution", direction: direction.id }),
            source_review_envelope_digest: generalEnvelope.digest,
            invocation_id: parseSafeId(`invocation-adjudication-${direction.id}`),
            result_id: parseSafeId(`result-adjudication-${direction.id}`),
          },
        });
        const adjudicationSchema = JSON.parse(JSON.stringify(
          createRawAdjudicationV2Schema(ruleSlots).toJSONSchema({ target: "draft-2020-12" }),
        )) as PlainJsonValue;
        const adjudicationResult = await dispatchOrSkip(context, () => serializeDispatch(() =>
          dispatch(adjudicationRoute, adjudicationEnvelope, adjudicationSchema)));
        const adjudication = parseRawAdjudicationV2(
          JSON.parse(decoder.decode(adjudicationResult.extracted_output_bytes)),
          ruleSlots,
        );
        expect(adjudication.schema_version).toBe("2");
        expect(Object.keys(adjudication.judgments).sort()).toEqual(["scope-a", "scope-b"]);
        expect(["fail", "uncertain"]).toContain(adjudication.judgments["scope-b"]?.compliance);
        expect(["matched", "uncertain"]).toContain(adjudication.judgments["scope-b"]?.trigger);
      } finally {
        workspace.dispose();
      }
    }, REAL_HOST_TEST_TIMEOUT_MS);
  }
});

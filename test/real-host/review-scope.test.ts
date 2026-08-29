/**
 * Opt-in semantic probe for the implementation-review scope boundary. It is intentionally outside
 * release checks: model judgment is useful validation evidence, not a deterministic build gate.
 */
import { execFileSync } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import reviewOutputSchema from "../../src/contracts/schemas/v1/review.schema.json" with { type: "json" };
import { canonicalJsonDigest, sha256Bytes, type GitOid } from "../../src/contracts/canonical.js";
import { parseConfigYaml } from "../../src/contracts/config.js";
import { parseSafeId, parseSafeInteger } from "../../src/contracts/evidence.js";
import { parsePhaseInstanceId } from "../../src/contracts/phase-instance.js";
import type { PlainJsonValue } from "../../src/contracts/plain-json.js";
import { parseAndDeriveReview } from "../../src/contracts/review.js";
import { serializeDispatch } from "../../src/dispatch/cli.js";
import { createDispatchCoordinator } from "../../src/dispatch/coordinator.js";
import { resolveDispatchRoute } from "../../src/dispatch/routing.js";
import {
  projectRepositoryWorkspaceBinding,
  type DispatchRepositoryViewPlan,
} from "../../src/dispatch/workspace.js";
import { buildReviewEnvelope } from "../../src/review/envelopes.js";
import { createJsonSchemaValidator } from "../helpers/json-schema.js";
import { loadTestRubric } from "../helpers/rubrics.js";
import {
  REAL_HOST_TEST_TIMEOUT_MS,
  realHostsAvailable,
  requireRealHostsAvailable,
} from "../helpers/real-host.js";
import { createTaskWorkspace } from "../helpers/task-workspace.js";

const available = realHostsAvailable();
requireRealHostsAvailable(available);
const utf8 = new TextEncoder();
const decoder = new TextDecoder("utf-8", { fatal: true });
const phase = parsePhaseInstanceId("phase-impl-1");
const selectedRubric = await loadTestRubric("phase-impl");
const validateReview = createJsonSchemaValidator<Record<string, unknown>>(reviewOutputSchema);

const directions = Object.freeze([
  Object.freeze({
    id: "claude-codex",
    producer: "claude" as const,
    reviewer: "codex" as const,
    config: `schema_version: "1"\nroles:\n  counter-reviewer: {model: gpt-5.6-sol, effort: xhigh}\n  adjudicator: {model: gpt-5.6-sol, effort: xhigh}\n`,
  }),
  Object.freeze({
    id: "codex-claude",
    producer: "codex" as const,
    reviewer: "claude" as const,
    config: `schema_version: "1"\nroles:\n  counter-reviewer: {model: claude-opus-5, effort: high}\n  adjudicator: {model: claude-opus-5, effort: high}\n`,
  }),
]);

function git(root: string, ...argv: string[]): string {
  return execFileSync("git", argv, { cwd: root, encoding: "utf8" }).trim();
}

describe.skipIf(!available)("real-host implementation review scope", () => {
  for (const direction of directions) {
    it(`ignores unrelated unchanged defects and catches changed-to-unchanged breakage for ${direction.id}`, async () => {
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
        const route = resolveDispatchRoute(config, "phase-impl", "counter-reviewer");
        expect(route.family).toBe(direction.reviewer);
        const subject = {
          task_id: workspace.taskId,
          phase_instance: phase,
          role: "counter-review" as const,
          step: "counter_review" as const,
          attempt: parseSafeInteger(1),
          subject_digest: sha256Bytes(utf8.encode(artifact)),
          input_fingerprint: canonicalJsonDigest({ probe: direction.id, baseline, after }),
          rubric_digest: selectedRubric.rubric_digest,
          producer_family: direction.producer,
          invocation_id: parseSafeId(`invocation-scope-${direction.id}`),
          result_id: parseSafeId(`result-scope-${direction.id}`),
        };
        const envelope = buildReviewEnvelope({
          artifact,
          rubric: selectedRubric.rubric,
          context: [],
          workspace: projectRepositoryWorkspaceBinding(repositoryViews),
          subject,
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
        const result = await serializeDispatch(() =>
          dispatch(route, envelope, reviewOutputSchema as PlainJsonValue));
        const raw = JSON.parse(decoder.decode(result.extracted_output_bytes)) as unknown;
        validateReview.assert(raw, `${direction.id} scope review`);
        const review = parseAndDeriveReview(raw);
        const findings = review.findings.map((finding) =>
          `${finding.finding_id} ${finding.summary} ${finding.evidence} ${finding.suggested_resolution}`.toLowerCase());

        expect(review.verdict).toBe("fail");
        expect(findings.some((finding) =>
          finding.includes("format-count") &&
          (finding.includes("summary") || finding.includes("touppercase")))).toBe(true);
        expect(findings.some((finding) =>
          finding.includes("legacy-auth") || finding.includes("always grants access"))).toBe(false);
      } finally {
        workspace.dispose();
      }
    }, REAL_HOST_TEST_TIMEOUT_MS);
  }
});

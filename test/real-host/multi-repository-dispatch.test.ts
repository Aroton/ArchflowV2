/**
 * Real-host proof that a task-scoped secondary repository reaches both reviewer families.
 *
 * Each direction builds a primary task workspace plus one context-only secondary (`api`) that
 * holds a file the primary does not, dispatches a real counter-review of a design document that
 * leans on that file, and checks the server-attested evidence pins `primary` then `api` at the
 * secondary's exact HEAD. Whether the reviewer actually cites `api/<path>` is model prose and is
 * recorded softly rather than required, so the test cannot flake on reviewer wording.
 */

import { readFile, readdir } from "node:fs/promises";
import { join } from "node:path";

import { afterAll, describe, expect, it } from "vitest";

import reviewOutputSchema from "../../src/contracts/schemas/v1/review.schema.json" with { type: "json" };
import { canonicalJsonDigest, sha256Bytes } from "../../src/contracts/canonical.js";
import { parseConfigYaml } from "../../src/contracts/config.js";
import { parseSafeId, parseSafeInteger } from "../../src/contracts/evidence.js";
import type { PlainJsonValue } from "../../src/contracts/plain-json.js";
import { parsePhaseInstanceId } from "../../src/contracts/phase-instance.js";
import { parseRubricV1 } from "../../src/contracts/rubric.js";
import { mintReviewObservation, serializeDispatch } from "../../src/dispatch/cli.js";
import { createDispatchCoordinator } from "../../src/dispatch/coordinator.js";
import { resolveDispatchRoute } from "../../src/dispatch/routing.js";
import {
  projectRepositoryWorkspaceBinding,
  projectReviewedRepositories,
  type DispatchRepositoryViewPlan,
} from "../../src/dispatch/workspace.js";
import { resolveRepositorySet } from "../../src/repository/repository-set.js";
import { buildReviewEnvelope } from "../../src/review/envelopes.js";
import { createJsonSchemaValidator } from "../helpers/json-schema.js";
import { REAL_HOST_TEST_TIMEOUT_MS, realHostsAvailable, requireRealHostsAvailable } from "../helpers/real-host.js";
import { createTaskWorkspace } from "../helpers/task-workspace.js";
import { cleanupTemporaryRepositories, createTempRepository } from "../helpers/temp-repository.js";

const REAL_HOSTS_AVAILABLE = realHostsAvailable();
requireRealHostsAvailable(REAL_HOSTS_AVAILABLE);
const encoder = new TextEncoder();
const decoder = new TextDecoder("utf-8", { fatal: true });

const SECONDARY_NAME = "api";
const SECONDARY_FILE = "src/handler.ts";
const SECONDARY_CITATION = `${SECONDARY_NAME}/${SECONDARY_FILE}`;
/** A function name that exists nowhere in the primary, so any mention of it came from the secondary view. */
const SECONDARY_FUNCTION = "handleCounterRequestQuorum";
const SECONDARY_SOURCE = `export type CounterRequest = { readonly count: number };

/** Accepts a counter request and answers with the HTTP status the gateway must relay. */
export function ${SECONDARY_FUNCTION}(request: CounterRequest): { readonly status: number } {
  if (!Number.isSafeInteger(request.count) || request.count < 0) return { status: 400 };
  // Synchronous: the handler answers only after the counter is durably written.
  return { status: 200 };
}
`;

/** The design under review claims an asynchronous 202 contract that the secondary's handler contradicts. */
const DESIGN_UNDER_REVIEW = `# Gateway relay design

The gateway forwards every counter request to the \`api\` service and relays the handler's status.

- The relay calls \`${SECONDARY_FUNCTION}\` in \`${SECONDARY_CITATION}\` and expects it to
  acknowledge asynchronously with HTTP 202 before the counter is written.
- Negative counts are rejected by the gateway before the call, so the handler never validates input.

Verify these claims against the handler's actual implementation in the \`${SECONDARY_NAME}\` repository.
`;

function configSource(roles: string, secondaryPath: string): string {
  return `schema_version: "1"
roles:
${roles}
repositories:
  ${SECONDARY_NAME}:
    path: ${JSON.stringify(secondaryPath)}
    mode: context-only
`;
}

const CLAUDE_PRODUCER_ROLES = `  counter-reviewer: {model: gpt-5.6-sol, effort: xhigh}
  adjudicator: {model: gpt-5.6-sol, effort: xhigh}`;
const CODEX_PRODUCER_ROLES = `  counter-reviewer: {model: claude-opus-5, effort: high}
  adjudicator: {model: claude-opus-5, effort: high}`;

const rubric = parseRubricV1({
  schema_version: "1",
  kind: "artifact",
  mode: "adversarial",
  criteria: [{
    id: "repository-consistency",
    text: "Report only a concrete contradiction between the artifact and the files in the named repository views; cite files as <name>/<path>.",
    blocking: true,
  }],
});
const rubricDigest = canonicalJsonDigest(rubric as unknown as PlainJsonValue);
const PHASE = parsePhaseInstanceId("design");
const validateReview = createJsonSchemaValidator<Record<string, unknown>>(reviewOutputSchema);

const directions = Object.freeze([
  Object.freeze({
    name: "Claude producer to Codex reviewer",
    task: "real-multi-repo-claude-codex",
    producer: "claude" as const,
    reviewer: "codex" as const,
    roles: CLAUDE_PRODUCER_ROLES,
    adapter: "codex-cli" as const,
    model: "gpt-5.6-sol",
    effort: "xhigh" as const,
  }),
  Object.freeze({
    name: "Codex producer to Claude reviewer",
    task: "real-multi-repo-codex-claude",
    producer: "codex" as const,
    reviewer: "claude" as const,
    roles: CODEX_PRODUCER_ROLES,
    adapter: "claude-cli" as const,
    model: "claude-opus-5",
    effort: "high" as const,
  }),
]);

async function attemptRecords(root: string, taskId: string): Promise<readonly Record<string, unknown>[]> {
  const directory = join(root, ".archflow", "runtime", "tasks", taskId, "diagnostics", "attempts", "design");
  const names = await readdir(directory).catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") return [];
    throw error;
  });
  return Promise.all(names.map(async (name) =>
    JSON.parse(decoder.decode(await readFile(join(directory, name)))) as Record<string, unknown>));
}

function findingTexts(output: Record<string, unknown>): readonly string[] {
  const findings = Array.isArray(output.findings) ? output.findings : [];
  return findings.flatMap((finding) => {
    if (finding === null || typeof finding !== "object" || Array.isArray(finding)) return [];
    return Object.values(finding as Record<string, unknown>).filter((value): value is string => typeof value === "string");
  });
}

afterAll(cleanupTemporaryRepositories);

describe.skipIf(!REAL_HOSTS_AVAILABLE)("real-host multi-repository counter-review dispatch", () => {
  for (const direction of directions) {
    it(`pins primary and the api secondary in server-attested evidence for ${direction.name}`, async () => {
      // The secondary exists before the primary is initialized so task initialization resolves
      // the declared repository set exactly as a real task would.
      const secondary = createTempRepository({ label: `${direction.task}-api` });
      secondary.write(SECONDARY_FILE, SECONDARY_SOURCE);
      secondary.commitAll("api handler");
      const secondaryHead = secondary.git("rev-parse", "HEAD");
      const source = configSource(direction.roles, secondary.path);

      const workspace = await createTaskWorkspace({
        taskId: direction.task,
        label: direction.task,
        operation: "real-multi-repo-dispatch",
        configBytes: encoder.encode(source),
      });
      try {
        const config = parseConfigYaml(source, `${direction.name} config`);
        const route = resolveDispatchRoute(config, "design", "counter-reviewer");
        expect(route).toEqual({
          adapter: direction.adapter,
          family: direction.reviewer,
          model: direction.model,
          effort: direction.effort,
        });

        const repositorySet = await resolveRepositorySet(
          { runner: workspace.services.runner, environment: workspace.services.environment },
          config,
          workspace.services.authority.context,
        );
        if (!repositorySet.ok) throw new Error(`repository set unavailable: ${repositorySet.error.code}`);
        expect(repositorySet.value.members.map((member) => member.name)).toEqual(["primary", SECONDARY_NAME]);
        const repositoryViews: DispatchRepositoryViewPlan = Object.freeze(
          repositorySet.value.members.map((member, index) => Object.freeze({
            name: member.name,
            member_kind: index === 0 ? "primary" as const : "secondary" as const,
            repository_root: member.binding.runner.location.worktreeRoot,
            repository_identity_digest: member.identity.digest,
            commit: member.head,
          })),
        );
        const reviewedRepositories = projectReviewedRepositories(repositoryViews);
        expect(reviewedRepositories).toEqual([
          {
            name: "primary",
            repository_identity_digest: workspace.initialization.repository_identity_digest,
            commit: workspace.initialization.code_baseline_commit,
          },
          {
            name: SECONDARY_NAME,
            repository_identity_digest: repositorySet.value.members[1]!.identity.digest,
            commit: secondaryHead,
          },
        ]);

        const subject = {
          task_id: workspace.taskId,
          phase_instance: PHASE,
          role: "counter-review" as const,
          step: "counter_review" as const,
          attempt: parseSafeInteger(1),
          subject_digest: sha256Bytes(encoder.encode(DESIGN_UNDER_REVIEW)),
          input_fingerprint: canonicalJsonDigest({ direction: direction.name, repositories: SECONDARY_NAME }),
          rubric_digest: rubricDigest,
          producer_family: direction.producer,
          invocation_id: parseSafeId(`invocation-${direction.task}`),
          result_id: parseSafeId(`result-${direction.task}`),
        };
        const envelope = buildReviewEnvelope({
          artifact: DESIGN_UNDER_REVIEW,
          rubric,
          context: [],
          subject,
          workspace: projectRepositoryWorkspaceBinding(repositoryViews),
        });
        const dispatch = createDispatchCoordinator({
          authority: workspace.services.authority,
          dependencies: workspace.services.dependencies,
          host: direction.producer,
          repository_root: workspace.root,
          phase_instance: PHASE,
          signal: new AbortController().signal,
          cancellation_source: "client",
          repository_views: repositoryViews,
        });

        let succeeded: Awaited<ReturnType<typeof dispatch>>;
        try {
          succeeded = await serializeDispatch(() => dispatch(route, envelope, reviewOutputSchema as PlainJsonValue));
        } catch (error) {
          const attempts = await attemptRecords(workspace.root, workspace.taskId);
          const code = error instanceof Error && "project_error" in error
            ? String((error as { project_error: { code: string } }).project_error.code)
            : error instanceof Error ? error.name : typeof error;
          const stages = attempts.map((attempt) => `${String(attempt.status)}@${String(attempt.failure_stage ?? attempt.stage ?? "?")}`);
          throw new Error(
            `${direction.name} expected a successful ${route.model} two-repository dispatch but observed ${code}; attempts=[${stages.join(", ")}]`,
            { cause: error },
          );
        }
        expect(await attemptRecords(workspace.root, workspace.taskId)).toEqual([]);

        const rawOutput = JSON.parse(decoder.decode(succeeded.extracted_output_bytes)) as unknown;
        validateReview.assert(rawOutput, `${direction.name} output`);
        const output = rawOutput as Record<string, unknown>;

        const observed = mintReviewObservation({
          subject,
          adapter: route.adapter,
          cli_version: succeeded.cli_version,
          route,
          repositories: reviewedRepositories,
          envelope_input_digest: envelope.digest,
          extracted_output_bytes: succeeded.extracted_output_bytes,
        });
        expect(observed.evidence).toMatchObject({
          assurance: "server-attested",
          adapter: direction.adapter,
          model_family: direction.reviewer,
          model: direction.model,
          effort: direction.effort,
          cli_version: expect.stringMatching(/^\d+\.\d+\.\d+$/u),
        });
        if (observed.evidence.assurance !== "server-attested") throw new Error("unexpected assurance");
        const pins = observed.evidence.repositories ?? [];
        expect(pins).toEqual(reviewedRepositories);
        expect(pins.map((pin) => pin.name)).toEqual(["primary", SECONDARY_NAME]);
        expect(pins[1]).toMatchObject({ name: SECONDARY_NAME, commit: secondaryHead });

        // Reviewer prose is not a contract. Either outcome satisfies the journey: the reviewer read
        // the secondary and cited it, or it returned a verdict while the evidence still carries the
        // `api` pin asserted above. Record which one happened instead of failing on wording.
        const texts = findingTexts(output);
        const citedSecondary = texts.some((text) => text.includes(SECONDARY_CITATION) || text.includes(SECONDARY_FUNCTION));
        expect(["pass", "advisory", "fail"]).toContain(output.verdict);
        console.info(
          `[real-host] ${direction.name}: verdict=${String(output.verdict)} findings=${String(Array.isArray(output.findings) ? output.findings.length : 0)} cited-secondary=${String(citedSecondary)}${citedSecondary ? "" : ` (no finding cited ${SECONDARY_CITATION}; api pin still attested)`}`,
        );
      } finally {
        workspace.dispose();
      }
    }, REAL_HOST_TEST_TIMEOUT_MS);
  }
});

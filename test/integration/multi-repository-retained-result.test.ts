import { dirname, join } from "node:path";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { canonicalDocument, canonicalJsonDigest, parseGitOid, sha256Bytes } from "../../src/contracts/canonical.js";
import { connectionContextFactory, createInvocationContext } from "../../src/contracts/contexts.js";
import type { ImplementationOutputV1 } from "../../src/contracts/durable-implementation-output.js";
import type { TaskStateV1 } from "../../src/contracts/durable-state.js";
import { parseSafeCode, parseSafeInteger, parseSha256Digest, parseTaskSlug } from "../../src/contracts/evidence.js";
import { encodePhaseInstance, parsePositiveSafePhaseNumber } from "../../src/contracts/phase-instance.js";
import { parseRepositoryPathClaim, parseTaskPathClaim } from "../../src/contracts/path-claims.js";
import { computeInputFingerprint } from "../../src/contracts/fingerprints.js";
import { parseToolCall } from "../../src/contracts/mcp-tools.js";
import { handleCounterReview } from "../../src/mcp/handlers/counter-review.js";
import { loadTestRubric } from "../helpers/rubrics.js";
import { createGitRunner, preflightGit } from "../../src/repository/git.js";
import { discoverWorktree } from "../../src/repository/identity.js";
import { resolveRepositorySet } from "../../src/repository/repository-set.js";
import { prepareImplementationResult } from "../../src/mcp/handlers/state-results.js";
import { createAtomicWriter } from "../../src/state/atomic.js";
import { createInternalTransactionAuthority } from "../../src/state/authority.js";
import { resolvePinnedConstitution } from "../../src/state/constitution.js";
import { buildImplementationOutput } from "../../src/state/implementation-manifest.js";
import { ensureResultDirectory } from "../../src/state/layout.js";
import { readRetainedResult } from "../../src/state/production.js";
import { installSnapshot } from "../../src/state/snapshots.js";
import {
  prepareResultInstallation,
  resultPayloadTargetIsContained,
  secondaryProjectionPlansMatchRepositorySet,
} from "../../src/state/transaction.js";
import { cleanupTemporaryRepositories, createTempRepository } from "../helpers/temp-repository.js";

afterAll(cleanupTemporaryRepositories);

function implementationInputFor(
  phase: ReturnType<typeof encodePhaseInstance>,
  bases: Readonly<{ primary: ReturnType<typeof parseGitOid>; secondary: ReturnType<typeof parseGitOid>; scanOnly: ReturnType<typeof parseGitOid> }>,
  fingerprint: ReturnType<typeof parseSha256Digest>,
) {
  return {
    phase_instance: phase, step: "produce", base_commit: bases.primary,
    outputs: [parseRepositoryPathClaim("primary.txt")], restore_targets: [parseRepositoryPathClaim("primary.txt")],
    parent_documents: [{ document_path: parseTaskPathClaim("prd.md"), role: "prd" }], declared_inputs: [],
    repositories: [
      { name: "api" as never, base_commit: bases.secondary,
        outputs: [parseRepositoryPathClaim("secondary.txt")], restore_targets: [parseRepositoryPathClaim("secondary.txt")], declared_inputs: [] },
      { name: "scan" as never, base_commit: bases.scanOnly, outputs: [], restore_targets: [], declared_inputs: [] },
    ],
    input_fingerprint: fingerprint,
  } as const;
}

type Fixture = Readonly<{
  primary: ReturnType<typeof createTempRepository>;
  secondary: ReturnType<typeof createTempRepository>;
  scanOnly: ReturnType<typeof createTempRepository>;
  task: ReturnType<typeof parseTaskSlug>;
  phase: ReturnType<typeof encodePhaseInstance>;
  workflow: Buffer;
  primaryBase: ReturnType<typeof parseGitOid>;
  discovered: Extract<Awaited<ReturnType<typeof discoverWorktree>>, { ok: true }>["value"];
  environment: Extract<Awaited<ReturnType<typeof preflightGit>>, { ok: true }>["value"];
  authority: Extract<Awaited<ReturnType<typeof createInternalTransactionAuthority>>, { ok: true }>["value"];
  constitution: Extract<Awaited<ReturnType<typeof resolvePinnedConstitution>>, { ok: true }>["value"];
  repositorySet: Extract<Awaited<ReturnType<typeof resolveRepositorySet>>, { ok: true }>["value"];
  state: ReturnType<typeof canonicalDocument<TaskStateV1>>;
  dependencies: never;
  implementationInput: ReturnType<typeof implementationInputFor>;
  scanner: Parameters<typeof prepareImplementationResult>[0]["scanner"];
  build: (input?: Parameters<typeof buildImplementationOutput>[3]) => ReturnType<typeof buildImplementationOutput>;
  prepare: (artifact: ImplementationOutputV1, resultId: string) => ReturnType<typeof prepareImplementationResult>;
  artifact: ImplementationOutputV1;
  prepared: Extract<Awaited<ReturnType<typeof prepareImplementationResult>>, { ok: true }>["value"];
  reloaded: Extract<Awaited<ReturnType<typeof readRetainedResult>>, { ok: true }>["value"];
}>;

/**
 * One primary with three secondaries — a writable one with a declared change, a writable one
 * with no declared change (the undeclared-dirt scan target), and a context-only one carrying
 * dirt — driven through build, prepare, install, and reload once. Tests that mutate repository
 * state clean up after themselves or run last.
 */
async function fixture(): Promise<Fixture> {
  const primary = createTempRepository({ label: "retained-primary" });
  const secondary = createTempRepository({ label: "retained-secondary" });
  const scanOnly = createTempRepository({ label: "retained-scan-only" });
  const contextOnly = createTempRepository({ label: "retained-context-only" });
  const task = parseTaskSlug("retained-multi");
  const phase = encodePhaseInstance({ kind: "phase-impl", phase: parsePositiveSafePhaseNumber(1) });
  const config = `schema_version: "1"
roles:
  counter-reviewer:
    model: gpt-fixture
    effort: high
repositories:
  api:
    path: ${JSON.stringify(secondary.path)}
    mode: writable
  context:
    path: ${JSON.stringify(contextOnly.path)}
    mode: context-only
  scan:
    path: ${JSON.stringify(scanOnly.path)}
    mode: writable
`;
  const workflow = readFileSync(new URL("../../assets/workflow.yaml", import.meta.url));
  primary.write(".archflow/workflow.yaml", workflow);
  primary.write(".archflow/constitution/00-retired.md", `---
id: retired
version: 1
status: deprecated
---
No active rule.
`);
  primary.write(`.archflow/tasks/${task}/config.yaml`, config);
  primary.write(`.archflow/tasks/${task}/state.json`, "{}\n");
  primary.write(`.archflow/tasks/${task}/prd.md`, "requirements\n");
  primary.write("primary.txt", "primary before\n");
  primary.commitAll("primary base");
  secondary.write("secondary.txt", "secondary before\n");
  secondary.commitAll("secondary base");
  scanOnly.write("unchanged.txt", "scan-only base\n");
  scanOnly.commitAll("scan-only base");
  contextOnly.write("context.txt", "context base\n");
  contextOnly.commitAll("context base");
  const primaryBase = parseGitOid(primary.git("rev-parse", "HEAD"));
  const secondaryBase = parseGitOid(secondary.git("rev-parse", "HEAD"));
  const scanOnlyBase = parseGitOid(scanOnly.git("rev-parse", "HEAD"));

  const context = { task_id: task, phase_instance: phase, operation: parseSafeCode("retained-multi"), attempt: parseSafeInteger(1) };
  const discovered = await discoverWorktree(createGitRunner({ cwd: primary.path }), context);
  if (!discovered.ok) throw new Error(`discover: ${discovered.error.code}`);
  const environment = await preflightGit(discovered.value, context);
  if (!environment.ok) throw new Error(`preflight: ${environment.error.code}`);
  const authority = await createInternalTransactionAuthority({
    runner: discovered.value, environment: environment.value, task_id: task, context,
  });
  if (!authority.ok) throw new Error(`authority: ${authority.error.code}`);
  const constitution = await resolvePinnedConstitution(discovered.value, primaryBase, context);
  if (!constitution.ok) throw new Error(`constitution: ${constitution.error.code}`);
  const repositorySet = await resolveRepositorySet(
    { runner: discovered.value, environment: environment.value },
    { repositories: {
      api: { path: secondary.path, mode: "writable" },
      context: { path: contextOnly.path, mode: "context-only" },
      scan: { path: scanOnly.path, mode: "writable" },
    } }, context,
  );
  if (!repositorySet.ok) throw new Error(`repository-set: ${repositorySet.error.code}`);

  primary.write("primary.txt", "primary after\n");
  secondary.write("secondary.txt", "secondary after\n");
  // Context-only dirt is review context, never scanned as undeclared implementation change.
  contextOnly.write("unrelated-context.txt", "context-only dirt is outside writable scanning\n");
  mkdirSync(join(authority.value.workspace_root, "cache", "phases", "1"), { recursive: true });
  primary.write(`.archflow/runtime/tasks/${task}/cache/phases/1/verification.txt`, "tests passed\n");
  const fingerprint = parseSha256Digest("1".repeat(64));
  const state = canonicalDocument({
    schema_version: "1", task_id: task, repository_identity_digest: authority.value.repository_identity_digest,
    revision: parseSafeInteger(2), phase_instance: phase, step: "produce", status: "running",
    attempt: parseSafeInteger(1), input_fingerprint: fingerprint,
    initialization_digest: parseSha256Digest("2".repeat(64)),
    config_digest: sha256Bytes(new TextEncoder().encode(config)),
    workflow_digest: sha256Bytes(workflow), constitution_digest: constitution.value.digest,
    policy_base_commit: primaryBase, authoritative_results: [], approvals: [], waivers: [],
  } as TaskStateV1);
  const dependencies = {
    runner: discovered.value, environment: environment.value,
    read_retained_task_bytes: async () => parseSafeInteger(0),
  } as never;
  const implementationInput = implementationInputFor(
    phase, { primary: primaryBase, secondary: secondaryBase, scanOnly: scanOnlyBase }, fingerprint,
  );
  const build = (input: Parameters<typeof buildImplementationOutput>[3] = implementationInput) =>
    buildImplementationOutput(dependencies, authority.value, state, input, repositorySet.value);
  const scanner = { scan: async (candidates: readonly any[]) => ({
    schema_version: "1" as const, outcome: "clean" as const, detector_set_id: "retained-test" as never,
    scanned_paths: candidates.map((candidate) => candidate.virtual_path),
  }) };
  const prepare = (artifact: ImplementationOutputV1, resultId: string) => prepareImplementationResult({
    services: { runner: discovered.value, environment: environment.value, authority: authority.value,
      dependencies, repository_set: repositorySet.value },
    artifact, result_id: resultId as never,
    retained_task_bytes: parseSafeInteger(0), measured_at_revision: parseSafeInteger(2), scanner,
  });

  const artifact = await build();
  if (!artifact.ok) throw new Error(`artifact: ${artifact.error.code}`);
  const prepared = await prepare(artifact.value, "retained-result");
  if (!prepared.ok) throw new Error(`prepared: ${JSON.stringify(prepared.error)}`);
  await ensureResultDirectory(authority.value, prepared.value.reference.result_digest);
  for (const payload of prepared.value.prepared.payloads) mkdirSync(dirname(payload.target.absolute), { recursive: true });
  const installed = await installSnapshot(
    createAtomicWriter(), prepared.value.prepared, prepared.value.manifest_target,
    discovered.value.location.worktreeRoot as never,
  );
  if (!installed.ok) throw new Error(`installed: ${installed.error.code}`);
  const reloaded = await readRetainedResult(discovered.value, authority.value, prepared.value.reference, repositorySet.value);
  if (!reloaded.ok) throw new Error(`reloaded: ${reloaded.error.code}`);

  return {
    primary, secondary, scanOnly, task, phase, workflow, primaryBase,
    discovered: discovered.value, environment: environment.value, authority: authority.value,
    constitution: constitution.value, repositorySet: repositorySet.value, state, dependencies,
    implementationInput, scanner, build, prepare,
    artifact: artifact.value, prepared: prepared.value, reloaded: reloaded.value,
  };
}

describe("multi-repository retained implementation result", () => {
  let h: Fixture;
  beforeAll(async () => { h = await fixture(); });

  it("rejects .git paths as primary outputs, secondary outputs, and secondary declared inputs", async () => {
    const { implementationInput } = h;
    await expect(h.build({
      ...implementationInput,
      outputs: [parseRepositoryPathClaim(".git/config")],
      restore_targets: [parseRepositoryPathClaim(".git/config")],
    })).resolves.toMatchObject({ ok: false, error: { code: "PATH_INVALID" } });
    for (const path of [".git/config", ".git/HEAD"] as const) {
      const claim = parseRepositoryPathClaim(path);
      await expect(h.build({
        ...implementationInput,
        repositories: [
          { ...implementationInput.repositories[0], outputs: [claim], restore_targets: [claim] },
          implementationInput.repositories[1],
        ],
      })).resolves.toMatchObject({ ok: false, error: { code: "PATH_INVALID" } });
    }
    await expect(h.build({
      ...implementationInput,
      repositories: [
        { ...implementationInput.repositories[0], declared_inputs: [{
          input_id: "git-hook" as never,
          path: parseRepositoryPathClaim(".git/hooks/x"),
        }] },
        implementationInput.repositories[1],
      ],
    })).resolves.toMatchObject({ ok: false, error: { code: "PATH_INVALID" } });
  });

  it("reports undeclared writable-secondary dirt in that repository's section, ignoring runtime scratch and counting unrepresentable paths", async () => {
    // Undeclared dirt in a writable secondary is caught exactly as it is in the primary: recorded
    // in that repository's section report (naming the paths) rather than rejected at build time.
    const scanReport = (artifact: Awaited<ReturnType<typeof buildImplementationOutput>>) => {
      if (!artifact.ok) throw new Error(`artifact: ${artifact.error.code}`);
      return artifact.value.secondary_repositories?.find((section) => section.repository === "scan")?.undeclared_changes;
    };
    h.scanOnly.write("undeclared.txt", "scan-only writable dirt\n");
    h.scanOnly.write(".archflow/runtime/ignored.txt", "runtime scratch is never undeclared dirt\n");
    try {
      expect(scanReport(await h.build())).toEqual({ scanned: true, undeclared_paths: ["undeclared.txt"], unrepresentable_count: 0 });
    } finally {
      rmSync(join(h.scanOnly.path, "undeclared.txt"));
      rmSync(join(h.scanOnly.path, ".archflow"), { recursive: true });
    }
    const unrepresentablePath = Buffer.concat([Buffer.from(`${h.scanOnly.path}/`, "utf8"), Buffer.from([0xff])]);
    writeFileSync(unrepresentablePath, "unrepresentable scan-only dirt\n");
    try {
      expect(scanReport(await h.build())).toEqual({ scanned: true, undeclared_paths: [], unrepresentable_count: 1 });
    } finally {
      rmSync(unrepresentablePath);
    }
  });

  it("retains only the writable secondary with declared outputs and ignores context-only dirt", () => {
    expect(h.prepared.prepared.manifest.value.source_artifact).toMatchObject({
      secondary_repositories: [{ repository: "api" }, { repository: "scan", outputs: [] }],
    });
    expect(h.prepared.prepared.manifest.value.secondary_projections).toEqual([
      expect.objectContaining({ repository: "api" }),
    ]);
    expect(h.prepared.secondary_projection_plans).toHaveLength(1);
  });

  it("rejects a valid but unrelated secondary base commit before preparing anything retainable", async () => {
    const mismatchedArtifact = {
      ...h.artifact,
      secondary_repositories: h.artifact.secondary_repositories?.map((section) => ({
        ...section,
        // A valid but unrelated commit object must be rejected against the authenticated member
        // HEAD before manifest preparation can produce anything retainable.
        base_commit: h.primaryBase,
      })),
    } as ImplementationOutputV1;
    await expect(h.prepare(mismatchedArtifact, "rejected-base")).resolves.toMatchObject({
      ok: false,
      error: { code: "CONTRACT_INVALID", diagnostic: { parameters: { issue_code: "implementation-secondary-base-commit-mismatch" } } },
    });
  });

  it("contains secondary raw payload targets inside the result directory and rejects a primary-root escape", () => {
    const secondaryPayload = h.prepared.prepared.payloads.find((payload) => payload.repository === "api");
    if (secondaryPayload === undefined) throw new Error("secondary raw payload missing");
    const digest = h.prepared.reference.result_digest;
    expect(resultPayloadTargetIsContained(h.task, digest, h.authority.workspace_root, secondaryPayload)).toBe(true);
    const primaryRootPath = parseRepositoryPathClaim(
      `.archflow/runtime/tasks/${h.task}/cache/results/${digest}/payload/${secondaryPayload.path}`,
    );
    expect(resultPayloadTargetIsContained(
      h.task, digest, h.authority.workspace_root,
      { ...secondaryPayload, target: { ...secondaryPayload.target, repositoryRelative: primaryRootPath } },
    )).toBe(false);
  });

  it("reloads the exact secondary after-image and projection plans that bind to the live repository set", () => {
    const { reloaded, prepared, repositorySet } = h;
    expect(reloaded.prepared.payloads.map((payload) => ({ repository: payload.repository, path: payload.path })))
      .toContainEqual({ repository: "api", path: "secondary.txt" });
    expect(reloaded.secondary_projection_plans).toHaveLength(1);
    const secondaryEntry = reloaded.secondary_projection_plans?.[0]?.projection_plan.entries
      .find((entry) => entry.path === "secondary.txt");
    expect(secondaryEntry?.desired).toMatchObject({ state: "present", file_type: "regular" });
    if (secondaryEntry?.desired.state !== "present") throw new Error("secondary after-image missing");
    expect(new TextDecoder().decode(secondaryEntry.desired.bytes)).toBe("secondary after\n");
    expect(() => prepareResultInstallation({ reference: prepared.reference, ...reloaded })).not.toThrow();
    expect(secondaryProjectionPlansMatchRepositorySet(reloaded.secondary_projection_plans, repositorySet)).toBe(true);
  });

  it("detects a forged secondary worktree root only against the live repository set", () => {
    const { reloaded, prepared, repositorySet, secondary } = h;
    const authenticatedSecondary = reloaded.secondary_projection_plans![0]!;
    const forgedRoots = [
      {
        root: join(secondary.path, ".git"),
        path: parseRepositoryPathClaim("config"),
        absolute: join(secondary.path, ".git", "config"),
      },
      {
        root: join(secondary.path, "alternate"),
        path: parseRepositoryPathClaim("secondary.txt"),
        absolute: join(secondary.path, "alternate", "secondary.txt"),
      },
    ];
    for (const forged of forgedRoots) {
      const forgedPlans = [{
        ...authenticatedSecondary,
        worktree_root: forged.root as never,
        projection_plan: {
          ...authenticatedSecondary.projection_plan,
          entries: authenticatedSecondary.projection_plan.entries.map((entry, index) => index === 0
            ? {
              ...entry,
              path: forged.path,
              target: {
                ...entry.target,
                repositoryRelative: forged.path,
                absolute: forged.absolute as never,
              },
            }
            : entry),
        },
      }];
      // The tuple is internally self-consistent under the caller-claimed root; only the live
      // RepositorySet member proves that root is not authoritative.
      expect(() => prepareResultInstallation({
        reference: prepared.reference, ...reloaded, secondary_projection_plans: forgedPlans,
      })).not.toThrow();
      expect(secondaryProjectionPlansMatchRepositorySet(forgedPlans, repositorySet)).toBe(false);
    }
  });

  it("rejects a forged secondary entry target that does not bind to its projection plan", () => {
    const { reloaded, prepared, secondary } = h;
    for (const forgedAbsolute of [
      join(secondary.path, ".git", "config"),
      join(secondary.path, "different.txt"),
    ]) {
      const forgedSecondaryPlans = reloaded.secondary_projection_plans!.map((secondaryPlan) => ({
        ...secondaryPlan,
        projection_plan: {
          ...secondaryPlan.projection_plan,
          entries: secondaryPlan.projection_plan.entries.map((entry, index) => index === 0
            ? { ...entry, target: { ...entry.target, absolute: forgedAbsolute as never } }
            : entry),
        },
      }));
      expect(() => prepareResultInstallation({
        reference: prepared.reference, ...reloaded, secondary_projection_plans: forgedSecondaryPlans,
      })).toThrow(/secondary projection plan does not bind/u);
    }
  });

  // Mutates the secondary and the durable state; keep it last.
  it("refuses pre-dispatch counter-review once a secondary HEAD advances past the retained result", async () => {
    const reviewFingerprint = computeInputFingerprint({
      schema_version: "1", workflow_digest: sha256Bytes(h.workflow),
      constitution_digest: h.constitution.digest, artifact_identities: [], upstream_identities: [],
      rubric_digest: (await loadTestRubric("phase-impl")).rubric_digest,
      phase_instance: h.phase, declared_inputs: [],
    });
    writeFileSync(h.authority.state.absolute, canonicalDocument({
      ...h.state.value, revision: parseSafeInteger(3), step: "counter_review", status: "running",
      input_fingerprint: reviewFingerprint, authoritative_results: [h.prepared.reference],
    } as TaskStateV1).bytes);
    h.secondary.commitAll("secondary descendant before review dispatch");
    const connection = connectionContextFactory.captureStartup({
      connection_id: "retained-secondary-staleness",
      startup_repository_candidate: { working_directory: h.primary.path },
    }).initialize({
      client: { name: "claude-code", version: "2.1.220" }, host: "claude", protocol_version: "2025-11-25",
    });
    const staleReview = await handleCounterReview(parseToolCall("archflow_counter_review", {
      schema_version: "1", task_id: h.task, intent_id: "retained-secondary-stale",
      expected_revision: 3, input_fingerprint: reviewFingerprint, artifact_path: "prd.md",
    }), createInvocationContext(connection, {
      invocation_id: "retained-secondary-stale",
      transport_metadata: { request_id: "retained-secondary-stale-request", operation: "tools/call" },
    }, new AbortController().signal));
    expect(staleReview).toMatchObject({
      ok: false,
      error: {
        code: "STATE_INVALID",
        diagnostic: { parameters: { issue_code: "counter-review-subject-not-current" } },
      },
    });
  });
});

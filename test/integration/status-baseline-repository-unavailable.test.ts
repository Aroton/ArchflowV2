import { afterAll, describe, expect, it } from "vitest";

import { parseGitOid } from "../../src/contracts/canonical.js";
import { parseSafeCode, parseSafeInteger, parseSha256Digest, parseTaskSlug } from "../../src/contracts/evidence.js";
import { parseRepositoryPathClaim } from "../../src/contracts/path-claims.js";
import { createGitRunner, preflightGit } from "../../src/repository/git.js";
import { discoverWorktree } from "../../src/repository/identity.js";
import { resolveRepositorySet } from "../../src/repository/repository-set.js";
import { BaselineRepositoryUnavailableError, currentBaselineTargetFacts } from "../../src/state/status.js";
import { cleanupTemporaryRepositories, createTempRepository } from "../helpers/temp-repository.js";

afterAll(cleanupTemporaryRepositories);

describe("baseline target facts for a repository that left the writable set", () => {
  it("names the repository in a typed error instead of a bare TypeError", async () => {
    const primary = createTempRepository({ label: "baseline-unavailable-primary" });
    const api = createTempRepository({ label: "baseline-unavailable-api" });
    primary.write("primary.txt", "primary\n");
    primary.commitAll("primary base");
    api.write("api.txt", "api\n");
    api.commitAll("api base");
    const context = {
      task_id: parseTaskSlug("baseline-unavailable"), phase_instance: "phase-impl-1" as never,
      operation: parseSafeCode("baseline-unavailable"), attempt: parseSafeInteger(1),
    };
    const discovered = await discoverWorktree(createGitRunner({ cwd: primary.path }), context);
    if (!discovered.ok) throw new Error(`discover: ${discovered.error.code}`);
    const environment = await preflightGit(discovered.value, context);
    if (!environment.ok) throw new Error(`preflight: ${environment.error.code}`);
    // The drift finding was recorded while `api` was writable; the live config now lists it as
    // context-only, so no writable member can supply its target facts.
    const repositorySet = await resolveRepositorySet(
      { runner: discovered.value, environment: environment.value },
      { repositories: { api: { path: api.path, mode: "context-only" } } },
      context,
    );
    if (!repositorySet.ok) throw new Error(`repository-set: ${repositorySet.error.code}`);
    const finding = {
      kind: "projection-mismatch" as const,
      repository: "api" as never,
      path: parseRepositoryPathClaim("api.txt"),
      recorded_digest: parseSha256Digest("1".repeat(64)),
      observed_digest: parseSha256Digest("2".repeat(64)),
    };
    const dependencies = { runner: discovered.value, environment: environment.value } as never;
    const rejection = currentBaselineTargetFacts(dependencies, [finding as never], repositorySet.value);
    await expect(rejection).rejects.toBeInstanceOf(BaselineRepositoryUnavailableError);
    await expect(rejection).rejects.toMatchObject({ repository: "api" });
    expect(parseGitOid(primary.git("rev-parse", "HEAD"))).toBeDefined();
  });
});

import { assertPlainJson } from "../contracts/plain-json.js";
import type { ProjectResult } from "../contracts/errors.js";
import type { Sha256Digest, TaskSlug } from "../contracts/evidence.js";
import { parseTaskPathClaim } from "../contracts/path-claims.js";
import type { GitEnvironment, RepositoryOperationContext } from "../repository/git.js";
import {
  computeTaskIdentity,
  resolveRepositoryIdentity,
  type RepositoryIdentity,
  type RootBoundGitRunner,
} from "../repository/identity.js";
import {
  resolveTaskPath,
  resolveTaskRoot,
  resolveTaskWorkspaceRoot,
  type ResolvedPath,
  type ResolvedTaskPath,
  type ResolvedTaskWorkspacePath,
} from "../repository/paths.js";

const transactionAuthorityBrand: unique symbol = Symbol("TransactionAuthority");
const authenticAuthorities = new WeakSet<object>();
const authorityDependencies = new WeakMap<object, Readonly<{ runner: RootBoundGitRunner; environment: GitEnvironment }>>();

export type TransactionAuthority = Readonly<{
  task_id: TaskSlug;
  repository_identity: RepositoryIdentity;
  repository_identity_digest: Sha256Digest;
  task_identity_digest: Sha256Digest;
  context: RepositoryOperationContext;
  task_root: ResolvedTaskPath;
  workspace_root: ResolvedTaskWorkspacePath;
  state: ResolvedPath;
  config: ResolvedPath;
}> & { readonly [transactionAuthorityBrand]: true };

export function assertInternalTransactionAuthority(
  value: TransactionAuthority,
  expected?: Readonly<{ runner: RootBoundGitRunner; environment: GitEnvironment }>,
): void {
  if (!authenticAuthorities.has(value)) throw new TypeError("an authentic transaction authority is required");
  if (expected !== undefined) {
    const registered = authorityDependencies.get(value);
    if (registered?.runner !== expected.runner || registered.environment !== expected.environment) {
      throw new TypeError("transaction dependencies do not match the authority registry");
    }
  }
}

/**
 * Mints an authority. `identity_source` lets a caller that has just minted one authority for the
 * same task through the same runner mint another (differing only in context) without re-querying
 * the repository; the donor must be authentic and registered against exactly this runner and
 * environment, so no unverified identity can enter through the seam.
 */
export async function createInternalTransactionAuthority(input: Readonly<{
  runner: RootBoundGitRunner;
  environment: GitEnvironment;
  task_id: TaskSlug;
  context: RepositoryOperationContext;
  identity_source?: TransactionAuthority;
}>): Promise<ProjectResult<TransactionAuthority>> {
  assertPlainJson(input.context, "repository operation context");
  const context = Object.freeze(structuredClone(input.context));
  if (context.task_id !== input.task_id) throw new TypeError("authority task_id must match context task_id");

  let repository: ProjectResult<RepositoryIdentity>;
  if (input.identity_source === undefined) {
    repository = await resolveRepositoryIdentity(input.runner, input.environment, context);
  } else {
    assertInternalTransactionAuthority(input.identity_source, { runner: input.runner, environment: input.environment });
    if (input.identity_source.task_id !== input.task_id) throw new TypeError("identity source must belong to the same task");
    repository = Object.freeze({ schema_version: "1", ok: true, value: input.identity_source.repository_identity });
  }
  if (!repository.ok) return repository;
  const taskIdentity = computeTaskIdentity(input.task_id, repository.value);
  const taskRoot = await resolveTaskRoot({ runner: input.runner, taskId: input.task_id, context });
  if (!taskRoot.ok) return taskRoot;
  const workspaceRoot = await resolveTaskWorkspaceRoot({ runner: input.runner, taskId: input.task_id, context });
  if (!workspaceRoot.ok) return workspaceRoot;
  const state = await resolveTaskPath({
    runner: input.runner,
    taskId: input.task_id,
    claim: parseTaskPathClaim("state.json"),
    expectedClass: "task-state",
    context,
  });
  if (!state.ok) return state;
  const config = await resolveTaskPath({
    runner: input.runner,
    taskId: input.task_id,
    claim: parseTaskPathClaim("config.yaml"),
    expectedClass: "task-config",
    context,
  });
  if (!config.ok) return config;

  const authority = {
    task_id: input.task_id,
    repository_identity: repository.value,
    repository_identity_digest: repository.value.digest,
    task_identity_digest: taskIdentity.digest,
    context,
    task_root: taskRoot.value,
    workspace_root: workspaceRoot.value,
    state: state.value,
    config: config.value,
  } as unknown as TransactionAuthority;
  Object.defineProperty(authority, transactionAuthorityBrand, {
    value: true,
    enumerable: false,
    writable: false,
    configurable: false,
  });
  Object.freeze(authority);
  authenticAuthorities.add(authority);
  authorityDependencies.set(authority, Object.freeze({ runner: input.runner, environment: input.environment }));
  return Object.freeze({ schema_version: "1", ok: true, value: authority });
}

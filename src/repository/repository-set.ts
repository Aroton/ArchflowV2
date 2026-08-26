import { isAbsolute, relative, resolve as resolveDirectory, sep } from "node:path";

import { canonicalJsonBytes, sha256Bytes, type GitOid } from "../contracts/canonical.js";
import { repositoryNameV1Schema, type RepositoryModeV1, type RepositoryName } from "../contracts/config.js";
import { createProjectError, type ProjectError, type ProjectResult } from "../contracts/errors.js";
import type { SafeCode, Sha256Digest } from "../contracts/evidence.js";
import {
  createGitRunner,
  GitInvocationError,
  preflightGit,
  projectErrorForGitFailure,
  readHeadCommit,
  type GitEnvironment,
  type RepositoryOperationContext,
} from "./git.js";
import {
  discoverWorktree,
  resolveRepositoryIdentity,
  type RepositoryIdentity,
  type RootBoundGitRunner,
} from "./identity.js";

export type RepositoryBinding = Readonly<{
  runner: RootBoundGitRunner;
  environment: GitEnvironment;
}>;

export type RepositoryMember = Readonly<{
  name: "primary" | RepositoryName;
  mode: RepositoryModeV1;
  binding: RepositoryBinding;
  identity: RepositoryIdentity;
  head: GitOid;
  declared_path?: string;
}>;

export type RepositorySet = Readonly<{
  members: readonly RepositoryMember[];
  digest: Sha256Digest;
}>;

type RepositorySetConfig = Readonly<{
  readonly repositories?: Readonly<Record<string, Readonly<{
    readonly path: string;
    readonly mode?: RepositoryModeV1 | undefined;
  }>>> | undefined;
}>;

const ok = <T>(value: T): ProjectResult<T> => Object.freeze({ schema_version: "1", ok: true, value });
const fail = <T>(error: ProjectError): ProjectResult<T> => Object.freeze({ schema_version: "1", ok: false, error });

/**
 * Git preflight is constant for a successful binding while its discovered worktree root remains
 * live. The cache is shared by primary production and repository-set resolution, bounded to
 * sixteen successful entries, and never records failures. Discovery is repeated before cache
 * reuse so adding or removing a nested repository cannot leave a stale root-bound runner.
 * Identity and HEAD are deliberately absent from the binding so callers must observe them live.
 */
const repositoryBindings = new Map<string, RepositoryBinding>();
const MAX_REPOSITORY_BINDINGS = 16;

export async function openRepository(
  workingDirectory: string,
  operationContext: RepositoryOperationContext,
): Promise<ProjectResult<RepositoryBinding>> {
  const candidateKey = resolveDirectory(workingDirectory);
  // Always rediscover the candidate before cache reuse. An interior path can become a nested root,
  // and an exact nested root can become an interior path when that repository is removed. Either
  // topology change must replace the root-bound runner rather than retain a stale location.
  const discovered = await discoverWorktree(createGitRunner({ cwd: workingDirectory }), operationContext);
  if (!discovered.ok) return discovered;
  const rootKey = discovered.value.location.worktreeRoot;
  const canonicalCached = repositoryBindings.get(rootKey);
  if (canonicalCached !== undefined) return ok(canonicalCached);
  const environment = await preflightGit(discovered.value, operationContext);
  if (!environment.ok) return environment;
  const binding: RepositoryBinding = Object.freeze({ runner: discovered.value, environment: environment.value });
  if (repositoryBindings.size >= MAX_REPOSITORY_BINDINGS) {
    const evictedRoot = repositoryBindings.keys().next().value as string;
    repositoryBindings.delete(evictedRoot);
  }
  repositoryBindings.set(rootKey, binding);
  return ok(binding);
}

function ordinal(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/**
 * Why a declared member could not be observed live. These three are environmental and retryable
 * (the declaration may be right and the repository merely absent right now), which is why a
 * dispatch caller may present them as `REPOSITORY_VIEW_UNAVAILABLE`; topology and declaration
 * faults stay plain `CONFIG_INVALID` with the `repository-set-invalid` issue code.
 */
export type RepositoryViewFailureReason = "open" | "identity" | "head";

const VIEW_FAILURE_ISSUE_CODES: Readonly<Record<RepositoryViewFailureReason, SafeCode>> = Object.freeze({
  open: "repository-open-failed" as SafeCode,
  identity: "repository-identity-unresolved" as SafeCode,
  head: "repository-head-unresolved" as SafeCode,
});
const VIEW_FAILURE_MESSAGES: Readonly<Record<RepositoryViewFailureReason, string>> = Object.freeze({
  open: "repository could not be opened",
  identity: "repository identity could not be resolved",
  head: "repository HEAD could not be resolved",
});
const VIEW_FAILURE_REASONS = new Map<string, RepositoryViewFailureReason>(
  (Object.keys(VIEW_FAILURE_ISSUE_CODES) as RepositoryViewFailureReason[]).map((reason) => [VIEW_FAILURE_ISSUE_CODES[reason], reason]),
);

// `memberField` and `memberFromIssue` are the two halves of one encoding: the bounded issue line
// is `repositories.<name>.path: <message>`, location-free, and the name is recoverable from it.
const MEMBER_FIELD_PREFIX = "repositories.";
const MEMBER_FIELD_SUFFIX = ".path";
function memberField(name: "primary" | RepositoryName): string {
  return name === "primary" ? "repositories.primary" : `${MEMBER_FIELD_PREFIX}${name}${MEMBER_FIELD_SUFFIX}`;
}
function memberFromIssue(issue: string): RepositoryName | undefined {
  const separator = issue.indexOf(": ");
  const field = separator === -1 ? issue : issue.slice(0, separator);
  if (!field.startsWith(MEMBER_FIELD_PREFIX) || !field.endsWith(MEMBER_FIELD_SUFFIX)) return undefined;
  const parsed = repositoryNameV1Schema.safeParse(field.slice(MEMBER_FIELD_PREFIX.length, field.length - MEMBER_FIELD_SUFFIX.length));
  return parsed.success ? parsed.data : undefined;
}

function configFailure(field: string, message: string, issueCode: SafeCode = "repository-set-invalid" as SafeCode): ProjectResult<never> {
  return fail(createProjectError("CONFIG_INVALID", {
    issue_code: issueCode,
    issues: [`${field}: ${message}`],
  }));
}

function viewFailure(name: "primary" | RepositoryName, reason: RepositoryViewFailureReason): ProjectResult<never> {
  return configFailure(memberField(name), VIEW_FAILURE_MESSAGES[reason], VIEW_FAILURE_ISSUE_CODES[reason]);
}

/**
 * Reads back the structured member failure `resolveRepositorySet` produced for one declared
 * secondary, or undefined for any other error (including primary and topology faults).
 */
export function unavailableRepositoryView(
  error: ProjectError,
): Readonly<{ repository_name: RepositoryName; reason: RepositoryViewFailureReason }> | undefined {
  if (error.code !== "CONFIG_INVALID") return undefined;
  const reason = VIEW_FAILURE_REASONS.get(error.diagnostic.parameters.issue_code);
  const issue = error.diagnostic.parameters.issues?.[0];
  if (reason === undefined || issue === undefined) return undefined;
  const repositoryName = memberFromIssue(issue);
  return repositoryName === undefined ? undefined : Object.freeze({ repository_name: repositoryName, reason });
}

function isWithin(parent: string, candidate: string): boolean {
  const path = relative(parent, candidate);
  return path !== "" && path !== ".." && !path.startsWith(`..${sep}`) && !isAbsolute(path);
}

async function observeMember(
  name: "primary" | RepositoryName,
  mode: RepositoryModeV1,
  binding: RepositoryBinding,
  context: RepositoryOperationContext,
  declaredPath?: string,
): Promise<ProjectResult<RepositoryMember>> {
  const identity = await resolveRepositoryIdentity(binding.runner, binding.environment, context);
  if (!identity.ok) return viewFailure(name, "identity");
  try {
    const head = await readHeadCommit(binding.runner);
    return ok(Object.freeze({
      name,
      mode,
      binding,
      identity: identity.value,
      head,
      ...(declaredPath === undefined ? {} : { declared_path: declaredPath }),
    }));
  } catch (error) {
    // Project the repository command through the normal boundary before replacing it with the
    // safe config-facing diagnostic. This preserves exhaustive handling of Git invocation kinds.
    if (error instanceof GitInvocationError) projectErrorForGitFailure(error, binding.runner, context);
    else if (!(error instanceof TypeError)) throw error;
    return viewFailure(name, "head");
  }
}

/** Resolves the live primary-plus-secondary repository set declared by one task config. */
export async function resolveRepositorySet(
  primaryBinding: RepositoryBinding,
  config: RepositorySetConfig,
  context: RepositoryOperationContext,
): Promise<ProjectResult<RepositorySet>> {
  const primary = await observeMember("primary", "writable", primaryBinding, context);
  if (!primary.ok) return primary;
  const members: RepositoryMember[] = [primary.value];
  const declarations = config.repositories ?? {};
  for (const rawName of Object.keys(declarations).sort(ordinal)) {
    const name = rawName as RepositoryName;
    const declaration = declarations[name]!;
    const declaredPath = declaration.path;
    const candidate = isAbsolute(declaredPath)
      ? declaredPath
      : resolveDirectory(primaryBinding.runner.location.worktreeRoot, declaredPath);
    const opened = await openRepository(candidate, context);
    if (!opened.ok) return viewFailure(name, "open");
    const observed = await observeMember(name, declaration.mode ?? "context-only", opened.value, context, declaredPath);
    if (!observed.ok) return observed;
    members.push(observed.value);
  }

  for (let left = 0; left < members.length; left += 1) {
    for (let right = left + 1; right < members.length; right += 1) {
      const leftRoot = members[left]!.binding.runner.location.worktreeRoot;
      const rightRoot = members[right]!.binding.runner.location.worktreeRoot;
      if (leftRoot === rightRoot || isWithin(leftRoot, rightRoot) || isWithin(rightRoot, leftRoot)) {
        // Name the earlier member it collides with so the human knows which pair to untangle.
        return configFailure(memberField(members[right]!.name), `repository must be distinct and non-nested (overlaps ${members[left]!.name})`);
      }
    }
  }

  const frozenMembers = Object.freeze(members);
  const digest = sha256Bytes(canonicalJsonBytes(frozenMembers.map((member) => ({
    name: member.name,
    mode: member.mode,
    repository_identity_digest: member.identity.digest,
  }))));
  return ok(Object.freeze({ members: frozenMembers, digest }));
}

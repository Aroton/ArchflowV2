import {
  canonicalJsonDigest,
  parseGitOid,
  type GitOid,
} from "../contracts/canonical.js";
import {
  parseConstitutionRuleFiles,
  type ConstitutionRegistry,
  type ConstitutionRuleV1,
} from "../contracts/constitution.js";
import {
  createProjectError,
  type ProjectError,
  type ProjectResult,
} from "../contracts/errors.js";
import type { Sha256Digest } from "../contracts/evidence.js";
import type { GateContext } from "../contracts/gates.js";
import {
  parseRepositoryPathClaim,
  rawGitPath,
  tryRepositoryPathClaim,
} from "../contracts/path-claims.js";
import { computePinnedConstitutionDigest } from "../contracts/fingerprints.js";
import {
  GitInvocationError,
  projectErrorForGitFailure,
  readChangedGitPaths,
  readCommitRangeChangedPaths,
  readCommitTreeEntries,
  readGitBlobBytes,
  readHeadCommit,
  type RepositoryOperationContext,
} from "../repository/git.js";
import type { RootBoundGitRunner } from "../repository/identity.js";
import { resolveRepositoryPath } from "../repository/paths.js";

const CONSTITUTION_DIRECTORY = ".archflow/constitution";
const RULE_FILE = /^\.archflow\/constitution\/[0-9]{2}-[A-Za-z0-9][A-Za-z0-9._-]*\.md$/u;
const decoder = new TextDecoder("utf-8", { fatal: true });

export type ResolvedConstitution = Readonly<{
  digest: Sha256Digest;
  rules: ConstitutionRegistry;
  files: readonly Readonly<{ path: string; oid: GitOid }>[];
}>;

const authenticResolvedConstitutions = new WeakSet<object>();

/** Refuses constitution values that were not resolved from an immutable commit tree here. */
export function assertResolvedConstitution(
  value: ResolvedConstitution,
): asserts value is ResolvedConstitution {
  if (
    value === null ||
    typeof value !== "object" ||
    !authenticResolvedConstitutions.has(value)
  ) {
    throw new TypeError("an authentic resolved constitution is required");
  }
}

function immutableRegistry(rules: ConstitutionRegistry): ConstitutionRegistry {
  const entries = [...rules].map(([id, rule]) => {
    const frozenRule = Object.freeze({
      ...rule,
      ...(rule.enforced_by === undefined
        ? {}
        : { enforced_by: Object.freeze([...rule.enforced_by]) }),
    });
    return Object.freeze([id, frozenRule] as const);
  });
  const backing = new Map(entries);
  let registry: ConstitutionRegistry;
  registry = Object.freeze({
    get size() { return backing.size; },
    has: (key: string) => backing.has(key),
    get: (key: string) => backing.get(key),
    entries: () => backing.entries(),
    keys: () => backing.keys(),
    values: () => backing.values(),
    [Symbol.iterator]: () => backing[Symbol.iterator](),
    forEach: (
      callback: (value: ConstitutionRuleV1, key: string, map: ConstitutionRegistry) => void,
      thisArg?: unknown,
    ) => backing.forEach((value, key) => callback.call(thisArg, value, key, registry)),
  });
  return registry;
}

const ok = <T>(value: T): ProjectResult<T> =>
  Object.freeze({ schema_version: "1", ok: true, value });
const fail = <T>(error: ProjectError): ProjectResult<T> =>
  Object.freeze({ schema_version: "1", ok: false, error });

async function readConstitutionTreeFiles(
  runner: RootBoundGitRunner,
  commit: GitOid,
): Promise<readonly Readonly<{ path: ReturnType<typeof parseRepositoryPathClaim>; oid: GitOid }>[]> {
  const listed = await readCommitTreeEntries(runner, commit, CONSTITUTION_DIRECTORY);
  return Object.freeze(listed
    .filter((entry) => RULE_FILE.test(entry.path))
    .map((entry) => Object.freeze({
      path: parseRepositoryPathClaim(entry.path),
      oid: parseGitOid(entry.oid),
    }))
    .sort((left, right) => left.path < right.path ? -1 : left.path > right.path ? 1 : 0));
}

function invalidPolicyBase(policyBaseCommit: GitOid, observed?: Sha256Digest): ProjectError {
  const expected = canonicalJsonDigest({
    schema_version: "1",
    digest_kind: "policy-base-commit",
    commit: policyBaseCommit,
  });
  return createProjectError("POLICY_BASE_INVALID", {
    expected_digest: expected,
    ...(observed === undefined ? {} : { observed_digest: observed }),
  });
}

/** Resolves the constitution registry and digest exclusively from one immutable commit tree. */
export async function resolvePinnedConstitution(
  runner: RootBoundGitRunner,
  policyBaseCommit: GitOid,
  context: RepositoryOperationContext,
): Promise<ProjectResult<ResolvedConstitution>> {
  try {
    const selected = await readConstitutionTreeFiles(runner, policyBaseCommit);
    if (selected.length === 0) return fail(invalidPolicyBase(policyBaseCommit));

    const sources: Record<string, string> = {};
    for (const file of selected) {
      sources[file.path] = decoder.decode(await readGitBlobBytes(runner, file.oid));
    }
    let rules: ConstitutionRegistry;
    try {
      rules = parseConstitutionRuleFiles(sources);
    } catch {
      return fail(invalidPolicyBase(policyBaseCommit));
    }
    if (rules.size === 0) return fail(invalidPolicyBase(policyBaseCommit));

    const resolved = Object.freeze({
      digest: computePinnedConstitutionDigest(selected),
      rules: immutableRegistry(rules),
      files: Object.freeze(selected.map((file) => Object.freeze({ ...file }))),
    });
    authenticResolvedConstitutions.add(resolved);
    return ok(resolved);
  } catch (error) {
    if (error instanceof GitInvocationError) {
      return fail(projectErrorForGitFailure(error, runner, context));
    }
    if (error instanceof TypeError || error instanceof RangeError) {
      return fail(invalidPolicyBase(policyBaseCommit));
    }
    throw error;
  }
}

/**
 * Detects both worktree/index and committed task-branch edits to the shared constitution.
 * The current digest always comes from HEAD; uncommitted bytes are only a wake-up signal.
 */
export async function detectTaskLocalConstitutionEdit(
  runner: RootBoundGitRunner,
  policyBaseCommit: GitOid,
  pinnedConstitutionDigest: Sha256Digest,
  context: RepositoryOperationContext,
): Promise<ProjectResult<GateContext<"constitution-edit"> | undefined>> {
  try {
    const uncommitted = await readChangedGitPaths(runner);
    const committed = await readCommitRangeChangedPaths(
      runner,
      policyBaseCommit,
      CONSTITUTION_DIRECTORY,
    );
    const candidates = new Set<string>(committed);
    for (const path of uncommitted.paths) {
      if (path.startsWith(`${CONSTITUTION_DIRECTORY}/`)) candidates.add(path);
    }
    if (candidates.size === 0) return ok(undefined);

    for (const value of candidates) {
      const claim = tryRepositoryPathClaim(rawGitPath(value));
      if (claim === undefined) continue;
      const resolved = await resolveRepositoryPath({
        runner,
        claim,
        expectedClass: "task-branch-constitution",
        context,
      });
      if (!resolved.ok) return resolved;
    }

    const head = parseGitOid(await readHeadCommit(runner));
    // A task-local edit must open the gate even when it deletes every rule or makes a rule
    // unparsable. Registry parsing authenticates the immutable policy base; the comparison
    // digest is only the HEAD tree's numbered-file membership and blob identity.
    const currentFiles = await readConstitutionTreeFiles(runner, head);
    return ok(Object.freeze({
      pinned_constitution_digest: pinnedConstitutionDigest,
      current_constitution_digest: computePinnedConstitutionDigest(currentFiles),
      changed_path_class: "task-branch-constitution",
    }));
  } catch (error) {
    if (error instanceof GitInvocationError) {
      return fail(projectErrorForGitFailure(error, runner, context));
    }
    throw error;
  }
}

/** The repository-frame claim used by the workflow fingerprint reader. */
export const PINNED_WORKFLOW_PATH = parseRepositoryPathClaim(".archflow/workflow.yaml");

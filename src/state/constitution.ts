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
import type { TaskStateV1 } from "../contracts/durable-state.js";
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
  policy_base_commit: GitOid;
  digest: Sha256Digest;
  rules: ConstitutionRegistry;
  files: readonly Readonly<{ path: string; oid: GitOid }>[];
}>;

type SupportedRuleAcceptanceEntry = Readonly<{
  id: string;
  version: number;
  status: "active";
  text: string;
  review_trigger: string;
  enforced_by: readonly string[];
}>;

/**
 * Exact policy bytes that mint settlement authority (rule-based advancement without a human
 * gate). The shipped seed and this repository's live rules match the newest profile; a task
 * pinned to an older policy-base commit keeps its authority through the earlier profile. Any
 * other bytes for these two rule IDs leave `rule_authority` unavailable for that task.
 */
export const SUPPORTED_RULE_ACCEPTANCE_PROFILE_V3: readonly SupportedRuleAcceptanceEntry[] = Object.freeze([
  Object.freeze({
    id: "approved-design-before-code",
    version: 3,
    status: "active",
    text: "Implementation starts only from a phase design that either passed its triggered human gate or advanced by rule after counter-review completed; the workflow server withholds the implementation window until then. The PRD, architecture design, and phase design stay truthful as work proceeds: a result that departs from its own phase design updates that phase design in the same reviewed result, and a result that departs from the architecture design or PRD updates those documents in the same result, where the project's approval rules decide whether a human approves the change. A departure from an approved upstream document is reported as a drift finding against that document, not as a failure of this rule.",
    review_trigger: "",
    enforced_by: Object.freeze([]),
  }),
  Object.freeze({
    id: "explicit-human-authority",
    version: 3,
    status: "active",
    text: "Required human decisions are explicit and bound to the exact artifact or code subject at gates opened by an approval rule or safety condition. Silence, elapsed time, agent prose, or a model verdict never supplies approval, waives a gate, or advances the workflow. Commits are not human-gated by default. The workflow server enforces this at its gates; an artifact complies unless it asserts, records, or relies on a human decision the workflow did not record.",
    review_trigger: "",
    enforced_by: Object.freeze([]),
  }),
]);

/** The previous supported profile; still authenticates tasks pinned before the v3 rules. */
export const SUPPORTED_RULE_ACCEPTANCE_PROFILE_V2: readonly SupportedRuleAcceptanceEntry[] = Object.freeze([
  Object.freeze({
    id: "approved-design-before-code",
    version: 2,
    status: "active",
    text: "Implementation starts only from a phase design that either passed its triggered human gate or advanced by rule after counter-review completed. The PRD, architecture, and phase design remain truthful as work proceeds; material deviations update the governing documents and re-enter the applicable review boundary before dependent work advances.",
    review_trigger: "Implementation begins before the applicable phase design passed its triggered human gate or advanced by rule after counter-review completed, or implementation materially departs from approved architecture without updating and re-reviewing its governing plan.",
    enforced_by: Object.freeze([]),
  }),
  Object.freeze({
    id: "explicit-human-authority",
    version: 2,
    status: "active",
    text: "Required human decisions are explicit and bound to the exact artifact or code subject at gates opened by an approval rule or safety condition. Silence, elapsed time, agent prose, or a model verdict never supplies approval, waives a gate, or advances the workflow. Commits are not human-gated by default.",
    review_trigger: "Authority over a gate opened by an approval rule or safety condition is inferred rather than explicitly recorded by a human for the exact subject.",
    enforced_by: Object.freeze([]),
  }),
]);

/** Newest first. Every profile pins the same two rule IDs, so selection by ID is profile-free. */
export const SUPPORTED_RULE_ACCEPTANCE_PROFILES: readonly (readonly SupportedRuleAcceptanceEntry[])[] =
  Object.freeze([SUPPORTED_RULE_ACCEPTANCE_PROFILE_V3, SUPPORTED_RULE_ACCEPTANCE_PROFILE_V2]);

export type AuthenticatedRuleAcceptancePolicy = Readonly<{
  task_id: TaskStateV1["task_id"];
  policy_base_commit: TaskStateV1["policy_base_commit"];
  constitution_digest: TaskStateV1["constitution_digest"];
}>;

const authenticResolvedConstitutions = new WeakSet<object>();

/**
 * A commit names an immutable tree, so a constitution resolved from one policy-base commit can
 * never change for that commit: successful resolutions are reused for the process lifetime,
 * keyed by worktree and commit. Failures are never cached — they carry call-specific context.
 */
const resolvedConstitutionCache = new Map<string, ResolvedConstitution>();
const MAX_CACHED_CONSTITUTIONS = 32;
const authenticRuleAcceptancePolicies = new WeakSet<object>();

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

function normalizedSelectedRule(rule: ConstitutionRuleV1): SupportedRuleAcceptanceEntry {
  return Object.freeze({
    id: rule.id,
    version: rule.version,
    status: "active",
    text: rule.text,
    review_trigger: rule.review_trigger ?? "",
    enforced_by: Object.freeze([...new Set(rule.enforced_by ?? [])].sort()),
  });
}

/** Mints settlement authority only for an authentic, task-pinned, exactly supported policy. */
export function authenticateRuleAcceptancePolicy(
  state: TaskStateV1,
  constitution: ResolvedConstitution,
): AuthenticatedRuleAcceptancePolicy | undefined {
  assertResolvedConstitution(constitution);
  if (
    constitution.policy_base_commit !== state.policy_base_commit ||
    constitution.digest !== state.constitution_digest
  ) return undefined;
  const selected = SUPPORTED_RULE_ACCEPTANCE_PROFILE_V3.map(({ id }) => constitution.rules.get(id));
  if (selected.some((rule) => rule === undefined || rule.status !== "active")) return undefined;
  const normalized = selected.map((rule) => normalizedSelectedRule(rule!))
    .sort((left, right) => left.id < right.id ? -1 : left.id > right.id ? 1 : 0);
  const digest = canonicalJsonDigest(normalized);
  if (!SUPPORTED_RULE_ACCEPTANCE_PROFILES.some((profile) => canonicalJsonDigest(profile) === digest)) {
    return undefined;
  }
  const policy = Object.freeze({
    task_id: state.task_id,
    policy_base_commit: state.policy_base_commit,
    constitution_digest: state.constitution_digest,
  });
  authenticRuleAcceptancePolicies.add(policy);
  return policy;
}

/** Refuses plain-object imitations of an authenticated rule-acceptance capability. */
export function assertAuthenticatedRuleAcceptancePolicy(
  value: AuthenticatedRuleAcceptancePolicy,
): asserts value is AuthenticatedRuleAcceptancePolicy {
  if (value === null || typeof value !== "object" || !authenticRuleAcceptancePolicies.has(value)) {
    throw new TypeError("an authenticated rule acceptance policy is required");
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
  let cacheKey: string;
  try {
    cacheKey = `${runner.location.worktreeRoot}\0${policyBaseCommit}`;
    const cached = resolvedConstitutionCache.get(cacheKey);
    if (cached !== undefined) return ok(cached);
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
      policy_base_commit: policyBaseCommit,
      digest: computePinnedConstitutionDigest(selected),
      rules: immutableRegistry(rules),
      files: Object.freeze(selected.map((file) => Object.freeze({ ...file }))),
    });
    authenticResolvedConstitutions.add(resolved);
    if (resolvedConstitutionCache.size >= MAX_CACHED_CONSTITUTIONS) {
      resolvedConstitutionCache.delete(resolvedConstitutionCache.keys().next().value as string);
    }
    resolvedConstitutionCache.set(cacheKey, resolved);
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

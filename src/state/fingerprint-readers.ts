import { lstat, readFile } from "node:fs/promises";

import { parseGitOid, sha256Bytes } from "../contracts/canonical.js";
import {
  createProjectError,
  type ProjectError,
  type ProjectResult,
} from "../contracts/errors.js";
import type {
  DeclaredInputRef,
  GitIdentityRef,
  SecondaryDeclaredInputSectionV1,
} from "../contracts/fingerprints.js";
import type { SafeCode, Sha256Digest } from "../contracts/evidence.js";
import type { TaskPathClaim } from "../contracts/path-claims.js";
import type { ParsedToolCall } from "../contracts/mcp-tools.js";
import type { ToolName } from "../contracts/tool-names.js";
import { decodePhaseInstance } from "../contracts/phase-instance.js";
import type { DocumentArtifactV1 } from "../contracts/durable-document.js";
import type { ImplementationOutputV1 } from "../contracts/durable-implementation-output.js";
import {
  GitInvocationError,
  hashGitBlob,
  projectErrorForGitFailure,
  readCommitTreeBlob,
} from "../repository/git.js";
import { resolveTaskPath } from "../repository/paths.js";
import {
  createInternalInputFingerprintResolver,
  type CanonicalConstitutionDigestReader,
  type CanonicalDeclaredInputReader,
  type CanonicalGitIdentityReader,
  type CanonicalWorkflowDigestReader,
  type FingerprintReadContext,
  type InputFingerprintResolver,
} from "./fingerprint.js";
import { PINNED_WORKFLOW_PATH, resolvePinnedConstitution } from "./constitution.js";

const ok = <T>(value: T): ProjectResult<T> =>
  Object.freeze({ schema_version: "1", ok: true, value });
const fail = <T>(error: ProjectError): ProjectResult<T> =>
  Object.freeze({ schema_version: "1", ok: false, error });

function stateIssue(input: FingerprintReadContext<ToolName>, issueCode: string): ProjectError {
  return createProjectError("STATE_INVALID", {
    phase_instance: input.state.value.phase_instance,
    issue_code: issueCode as SafeCode,
  });
}

/**
 * The workflow digest is a pure function of the immutable policy-base commit, so a successful
 * read is reused per worktree and commit for the process lifetime; failures are never cached.
 */
const workflowDigestCache = new Map<string, Sha256Digest>();
const MAX_CACHED_WORKFLOW_DIGESTS = 32;

/** Reads the workflow bytes from the immutable policy-base tree. */
export const readCanonicalWorkflowDigest: CanonicalWorkflowDigestReader = async (input) => {
  try {
    const cacheKey = `${input.runner.location.worktreeRoot}\0${input.state.value.policy_base_commit}`;
    const cached = workflowDigestCache.get(cacheKey);
    if (cached !== undefined) return ok(cached);
    const entry = await readCommitTreeBlob(
      input.runner,
      input.state.value.policy_base_commit,
      PINNED_WORKFLOW_PATH,
    );
    if (entry === undefined) {
      return fail(createProjectError("POLICY_BASE_INVALID", {
        expected_digest: input.state.value.workflow_digest,
      }));
    }
    const bytes = await input.runner.run({
      argv: ["cat-file", "blob", entry.oid],
      operation: "git-workflow-read" as SafeCode,
    });
    const digest = sha256Bytes(bytes.stdout);
    if (workflowDigestCache.size >= MAX_CACHED_WORKFLOW_DIGESTS) {
      workflowDigestCache.delete(workflowDigestCache.keys().next().value as string);
    }
    workflowDigestCache.set(cacheKey, digest);
    return ok(digest);
  } catch (error) {
    if (error instanceof GitInvocationError) {
      return fail(projectErrorForGitFailure(error, input.runner, input.context));
    }
    throw error;
  }
};

/** Recomputes the pinned constitution digest from the immutable policy-base tree. */
export const readCanonicalConstitutionDigest: CanonicalConstitutionDigestReader = async (input) => {
  const resolved = await resolvePinnedConstitution(
    input.runner,
    input.state.value.policy_base_commit,
    input.context,
  );
  return resolved.ok ? ok(resolved.value.digest) : resolved;
};

function artifactPaths(_input: FingerprintReadContext<ToolName>): readonly TaskPathClaim[] {
  return Object.freeze([]);
}

function upstreamPaths(_input: FingerprintReadContext<ToolName>): readonly TaskPathClaim[] {
  return Object.freeze([]);
}

async function identitiesFor(
  input: FingerprintReadContext<ToolName>,
  claims: readonly TaskPathClaim[],
  missingIssue: string,
): Promise<ProjectResult<readonly GitIdentityRef[]>> {
  if (claims.length === 0) return ok(Object.freeze([]));
  const resolved = [];
  for (const claim of claims) {
    const path = await resolveTaskPath({
      runner: input.runner,
      taskId: input.authority.task_id,
      claim,
      context: input.context,
    });
    if (!path.ok) return path;
    resolved.push(path.value);
  }
  const identities: GitIdentityRef[] = [];
  for (const path of resolved) {
    let bytes: Uint8Array;
    try {
      const stat = await lstat(path.absolute);
      if (!stat.isFile()) return fail(stateIssue(input, missingIssue));
      bytes = new Uint8Array(await readFile(path.absolute));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        return fail(stateIssue(input, missingIssue));
      }
      return fail(createProjectError("IO_ERROR", {
        operation: input.context.operation,
        attempt: input.context.attempt,
      }));
    }
    const oid = parseGitOid(await hashGitBlob(
      input.runner,
      bytes,
      path.repositoryRelative,
    ));
    identities.push(Object.freeze({
      path: path.repositoryRelative,
      mode: "100644",
      oid,
    }));
  }
  identities.sort((left, right) => left.path < right.path ? -1 : left.path > right.path ? 1 : 0);
  return ok(Object.freeze(identities));
}

/** Reads the exact current artifact paths selected by the closed per-tool input shape. */
export const readCanonicalArtifactIdentities: CanonicalGitIdentityReader = async (input) =>
  identitiesFor(input, artifactPaths(input), "fingerprint-artifact-missing");

/** Reads adjudication upstream paths; every other tool has no upstream-path selector. */
export const readCanonicalUpstreamIdentities: CanonicalGitIdentityReader = async (input) =>
  identitiesFor(input, upstreamPaths(input), "fingerprint-upstream-missing");

type ProduceArtifact = DocumentArtifactV1 | ImplementationOutputV1;
type ReadRetainedProduceArtifact = (
  input: FingerprintReadContext<ToolName>,
) => Promise<ProjectResult<ProduceArtifact | undefined>>;

async function fingerprintArtifact(
  input: FingerprintReadContext<ToolName>,
  readRetainedProduceArtifact: ReadRetainedProduceArtifact | undefined,
  retainForImplementationFollowup: boolean,
): Promise<ProjectResult<ProduceArtifact | undefined>> {
  const call = input.call as ParsedToolCall;
  if (call.name === "archflow_state" &&
      (call.input.artifact?.artifact_kind === "document" || call.input.artifact?.artifact_kind === "implementation-output")) {
    return ok(call.input.artifact);
  }
  const implementationFollowup = retainForImplementationFollowup &&
    decodePhaseInstance(input.state.value.phase_instance).kind === "phase-impl" &&
    (call.name === "archflow_counter_review" ||
      (call.name === "archflow_state" && call.input.operation !== "planning_restart" &&
        (call.input.step === "counter_review" || call.input.step === "triage")));
  if (!implementationFollowup) return ok(undefined);
  return readRetainedProduceArtifact === undefined
    ? ok(undefined)
    : readRetainedProduceArtifact(input);
}

/**
 * Primary declared inputs exist only on the caller-supplied document or implementation artifact,
 * exactly as before repository sets existed: follow-up review and triage steps never look them up
 * from retained authority, so a single-repository task's fingerprints are byte-identical to the
 * pre-multi-repository composition at every step.
 */
export async function readCanonicalDeclaredInputs(
  input: FingerprintReadContext<ToolName>,
): Promise<ProjectResult<readonly DeclaredInputRef[]>> {
  const artifact = await fingerprintArtifact(input, undefined, false);
  if (!artifact.ok) return artifact;
  return ok(Object.freeze(structuredClone(artifact.value?.declared_inputs ?? [])));
}

/**
 * Secondary declarations are read from the caller-supplied implementation artifact or, at the
 * implementation follow-up review and triage boundaries, from its retained authority — the
 * addendum is folded in only for tasks that actually declare secondary inputs.
 */
export async function readCanonicalSecondaryDeclaredInputs(
  input: FingerprintReadContext<ToolName>,
  readRetainedProduceArtifact?: ReadRetainedProduceArtifact,
): Promise<ProjectResult<readonly SecondaryDeclaredInputSectionV1[]>> {
  const loaded = await fingerprintArtifact(input, readRetainedProduceArtifact, true);
  if (!loaded.ok) return loaded;
  const artifact = loaded.value;
  if (artifact?.artifact_kind !== "implementation-output") {
    return ok(Object.freeze([]));
  }
  return ok(Object.freeze((artifact.secondary_repositories ?? []).flatMap((section) =>
    section.declared_inputs.length === 0 ? [] : [Object.freeze({
      repository: section.repository,
      declared_inputs: Object.freeze(section.declared_inputs.map((declared) => Object.freeze({
        input_id: declared.input_id,
        digest: declared.digest,
      }))),
    })],
  )));
}

/** The production resolver assembled solely from canonical live readers. */
export function createProductionInputFingerprintResolver(
  readRetainedProduceArtifact?: ReadRetainedProduceArtifact,
): InputFingerprintResolver {
  return createInternalInputFingerprintResolver({
    read_workflow_digest: readCanonicalWorkflowDigest,
    read_constitution_digest: readCanonicalConstitutionDigest,
    read_artifact_identities: readCanonicalArtifactIdentities,
    read_upstream_identities: readCanonicalUpstreamIdentities,
    read_declared_inputs: readCanonicalDeclaredInputs,
    read_secondary_declared_inputs: (input) => readCanonicalSecondaryDeclaredInputs(input, readRetainedProduceArtifact),
  });
}

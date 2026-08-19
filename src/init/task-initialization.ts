import { mkdir, open, readFile } from "node:fs/promises";
import { dirname, join } from "node:path";

import { canonicalJsonDigest, parseGitOid, sha256Bytes } from "../contracts/canonical.js";
import { parseConfigYaml } from "../contracts/config.js";
import type { GitOid } from "../contracts/canonical.js";
import type { TaskInitializationV1 } from "../contracts/durable-task-initialization.js";
import type { Sha256Digest, TaskSlug } from "../contracts/evidence.js";
import {
  createProjectError,
  type ProjectError,
  type ProjectResult,
} from "../contracts/errors.js";
import { parseSafeCode, parseSafeInteger, parseTaskSlug } from "../contracts/evidence.js";
import { computePinnedConfigDigest } from "../contracts/fingerprints.js";
import { parseRepositoryPathClaim } from "../contracts/path-claims.js";
import { parsePhaseInstanceId } from "../contracts/phase-instance.js";
import { assertPlainJson } from "../contracts/plain-json.js";
import {
  createGitRunner,
  GitInvocationError,
  preflightGit,
  projectErrorForGitFailure,
  readCommitTreeBlob,
  readGitBlobBytes,
  readHeadCommit,
  type RepositoryOperationContext,
} from "../repository/git.js";
import { discoverWorktree, resolveRepositoryIdentity } from "../repository/identity.js";
import { PINNED_WORKFLOW_PATH, resolvePinnedConstitution } from "../state/constitution.js";
import { parseWorkflowYaml } from "../contracts/workflow.js";
import type { RootBoundGitRunner } from "../repository/identity.js";

export type StageTaskInitializationInput = {
  readonly working_directory: string;
  readonly task_id: string;
};

export type StageTaskAskInput = StageTaskInitializationInput & {
  readonly text: string;
};

const decoder = new TextDecoder("utf-8", { fatal: true });
const ok = <T>(value: T): ProjectResult<T> =>
  Object.freeze({ schema_version: "1", ok: true, value });
const fail = <T>(error: ProjectError): ProjectResult<T> =>
  Object.freeze({ schema_version: "1", ok: false, error });

function errno(error: unknown, code: string): boolean {
  return error instanceof Error && (error as NodeJS.ErrnoException).code === code;
}

export function commitDigest(
  commit: GitOid,
  digest_kind: string,
): Sha256Digest {
  return canonicalJsonDigest({ schema_version: "1", digest_kind, commit });
}

export function policyBaseInvalid(commit: TaskInitializationV1["policy_base_commit"]): ProjectError {
  return createProjectError("POLICY_BASE_INVALID", {
    expected_digest: commitDigest(commit, "policy-base-commit"),
  });
}

export async function createTaskConfig(root: string, taskId: string): Promise<Uint8Array> {
  const taskConfig = join(root, ".archflow", "tasks", taskId, "config.yaml");
  try {
    return new Uint8Array(await readFile(taskConfig));
  } catch (error) {
    if (!errno(error, "ENOENT")) throw error;
  }
  const template = new Uint8Array(await readFile(join(root, ".archflow", "config.yaml")));
  await mkdir(dirname(taskConfig), { recursive: true });
  try {
    const handle = await open(taskConfig, "wx");
    try {
      await handle.writeFile(template);
    } finally {
      await handle.close();
    }
    return template;
  } catch (error) {
    if (!errno(error, "EEXIST")) throw error;
    return new Uint8Array(await readFile(taskConfig));
  }
}

/**
 * Installs the human's exact ask before revision-zero initialization. The byte-identical existing
 * file is an idempotent retry; any different existing content is a collision and remains intact.
 */
export async function stageTaskAsk(input: StageTaskAskInput): Promise<ProjectResult<Readonly<{
  path: ReturnType<typeof parseRepositoryPathClaim>;
  byte_count: number;
  digest: Sha256Digest;
}>>> {
  assertPlainJson(input, "task ask staging input");
  const snapshot = structuredClone(input);
  const taskId = parseTaskSlug(snapshot.task_id);
  if (typeof snapshot.text !== "string") throw new TypeError("task ask text must be a string");
  const bytes = new TextEncoder().encode(snapshot.text);
  const askPath = join(snapshot.working_directory, ".archflow", "tasks", taskId, "ask.md");
  try {
    await mkdir(dirname(askPath), { recursive: true });
    const handle = await open(askPath, "wx");
    try {
      await handle.writeFile(bytes);
    } finally {
      await handle.close();
    }
  } catch (error) {
    if (!errno(error, "EEXIST")) {
      return fail(createProjectError("IO_ERROR", {
        operation: parseSafeCode("stage-task-ask"),
        attempt: parseSafeInteger(1),
      }));
    }
    try {
      const existing = new Uint8Array(await readFile(askPath));
      if (!Buffer.from(existing).equals(Buffer.from(bytes))) {
        return fail(createProjectError("TASK_INVALID", {
          task_id: taskId,
          issue_code: parseSafeCode("task-ask-collision"),
        }));
      }
    } catch (readError) {
      if (!errno(readError, "ENOENT")) {
        return fail(createProjectError("IO_ERROR", {
          operation: parseSafeCode("stage-task-ask"),
          attempt: parseSafeInteger(1),
        }));
      }
      return stageTaskAsk(input);
    }
  }
  return ok(Object.freeze({
    path: parseRepositoryPathClaim(`.archflow/tasks/${taskId}/ask.md`),
    byte_count: bytes.byteLength,
    digest: sha256Bytes(bytes),
  }));
}

export function canonicalTaskPaths(taskId: TaskSlug) {
  const taskRoot = `.archflow/tasks/${taskId}`;
  return Object.freeze({
    task_root: parseRepositoryPathClaim(taskRoot),
    config: parseRepositoryPathClaim(`${taskRoot}/config.yaml`),
    state: parseRepositoryPathClaim(`${taskRoot}/state.json`),
    workflow: PINNED_WORKFLOW_PATH,
    constitution_root: parseRepositoryPathClaim(".archflow/constitution"),
  });
}

export async function resolveInitializationPolicyBase(
  runner: RootBoundGitRunner,
  commit: GitOid,
  context: RepositoryOperationContext,
): Promise<ProjectResult<Readonly<{ constitution_digest: Sha256Digest; workflow_digest: Sha256Digest }>>> {
  const constitution = await resolvePinnedConstitution(runner, commit, context);
  if (!constitution.ok) return constitution;
  try {
    const workflowEntry = await readCommitTreeBlob(runner, commit, PINNED_WORKFLOW_PATH);
    if (workflowEntry === undefined) return fail(policyBaseInvalid(commit));
    const workflowBytes = await readGitBlobBytes(runner, workflowEntry.oid);
    try {
      parseWorkflowYaml(decoder.decode(workflowBytes), "pinned workflow");
    } catch {
      return fail(policyBaseInvalid(commit));
    }
    return ok(Object.freeze({
      constitution_digest: constitution.value.digest,
      workflow_digest: sha256Bytes(workflowBytes),
    }));
  } catch (error) {
    if (error instanceof GitInvocationError) return fail(projectErrorForGitFailure(error, runner, context));
    throw error;
  }
}

/**
 * Stages the durable initialization artifact only. At this boundary both baseline commits are
 * HEAD: the human commit containing the scaffolded policy is the policy approval. No state or Git
 * commit is created here.
 */
export async function stageTaskInitialization(
  input: StageTaskInitializationInput,
): Promise<ProjectResult<TaskInitializationV1>> {
  const taskId = parseTaskSlug(input.task_id);
  const context: RepositoryOperationContext = Object.freeze({
    task_id: taskId,
    phase_instance: parsePhaseInstanceId("prd"),
    operation: parseSafeCode("stage-task-initialization"),
    attempt: parseSafeInteger(1),
  });
  const discovered = await discoverWorktree(createGitRunner({ cwd: input.working_directory }), context);
  if (!discovered.ok) return discovered;
  const runner = discovered.value;
  const environment = await preflightGit(runner, context);
  if (!environment.ok) return environment;
  const repository = await resolveRepositoryIdentity(runner, environment.value, context);
  if (!repository.ok) return repository;

  let configBytes: Uint8Array;
  try {
    configBytes = await createTaskConfig(runner.location.worktreeRoot, taskId);
  } catch {
    return fail(createProjectError("IO_ERROR", {
      operation: context.operation,
      attempt: context.attempt,
    }));
  }
  try {
    parseConfigYaml(decoder.decode(configBytes), "task config");
  } catch {
    return fail(createProjectError("CONFIG_INVALID", { issue_code: "task-config-invalid" }));
  }

  try {
    const head = parseGitOid(await readHeadCommit(runner));
    const policy = await resolveInitializationPolicyBase(runner, head, context);
    if (!policy.ok) return policy;
    return ok(Object.freeze({
      schema_version: "1",
      artifact_kind: "task-initialization",
      task_id: taskId,
      repository_identity_digest: repository.value.digest,
      code_baseline_commit: head,
      policy_base_commit: head,
      constitution_digest: policy.value.constitution_digest,
      workflow_digest: policy.value.workflow_digest,
      config_digest: computePinnedConfigDigest(configBytes),
      canonical_paths: canonicalTaskPaths(taskId),
    }));
  } catch (error) {
    if (error instanceof GitInvocationError) {
      return fail(projectErrorForGitFailure(error, runner, context));
    }
    if (error instanceof TypeError || error instanceof RangeError) {
      const head = parseGitOid(await readHeadCommit(runner));
      return fail(policyBaseInvalid(head));
    }
    throw error;
  }
}

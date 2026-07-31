import { mkdir, open, readFile } from "node:fs/promises";
import { dirname, join } from "node:path";

import { canonicalJsonDigest, parseGitOid, sha256Bytes } from "../contracts/canonical.js";
import { parseConfigYaml } from "../contracts/config.js";
import type { TaskInitializationV1 } from "../contracts/durable-task-initialization.js";
import {
  createProjectError,
  type ProjectError,
  type ProjectResult,
} from "../contracts/errors.js";
import { parseSafeCode, parseSafeInteger, parseTaskSlug } from "../contracts/evidence.js";
import { computePinnedConfigDigest } from "../contracts/fingerprints.js";
import { parseRepositoryPathClaim } from "../contracts/path-claims.js";
import { parsePhaseInstanceId } from "../contracts/phase-instance.js";
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

export type StageTaskInitializationInput = {
  readonly working_directory: string;
  readonly task_id: string;
};

const decoder = new TextDecoder("utf-8", { fatal: true });
const ok = <T>(value: T): ProjectResult<T> =>
  Object.freeze({ schema_version: "1", ok: true, value });
const fail = <T>(error: ProjectError): ProjectResult<T> =>
  Object.freeze({ schema_version: "1", ok: false, error });

function errno(error: unknown, code: string): boolean {
  return error instanceof Error && (error as NodeJS.ErrnoException).code === code;
}

function policyBaseInvalid(commit: TaskInitializationV1["policy_base_commit"]): ProjectError {
  return createProjectError("POLICY_BASE_INVALID", {
    expected_digest: canonicalJsonDigest({
      schema_version: "1",
      digest_kind: "policy-base-commit",
      commit,
    }),
  });
}

async function createTaskConfig(root: string, taskId: string): Promise<Uint8Array> {
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
    const constitution = await resolvePinnedConstitution(runner, head, context);
    if (!constitution.ok) return constitution;
    const workflowEntry = await readCommitTreeBlob(runner, head, PINNED_WORKFLOW_PATH);
    if (workflowEntry === undefined) return fail(policyBaseInvalid(head));
    const workflowBytes = await readGitBlobBytes(runner, workflowEntry.oid);
    try {
      parseWorkflowYaml(decoder.decode(workflowBytes), "pinned workflow");
    } catch {
      return fail(policyBaseInvalid(head));
    }

    const taskRoot = `.archflow/tasks/${taskId}`;
    return ok(Object.freeze({
      schema_version: "1",
      artifact_kind: "task-initialization",
      task_id: taskId,
      repository_identity_digest: repository.value.digest,
      code_baseline_commit: head,
      policy_base_commit: head,
      constitution_digest: constitution.value.digest,
      workflow_digest: sha256Bytes(workflowBytes),
      config_digest: computePinnedConfigDigest(configBytes),
      canonical_paths: Object.freeze({
        task_root: parseRepositoryPathClaim(taskRoot),
        config: parseRepositoryPathClaim(`${taskRoot}/config.yaml`),
        state: parseRepositoryPathClaim(`${taskRoot}/state.json`),
        workflow: PINNED_WORKFLOW_PATH,
        constitution_root: parseRepositoryPathClaim(".archflow/constitution"),
      }),
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

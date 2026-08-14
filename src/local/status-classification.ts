import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";

import type { ProjectResult } from "../contracts/errors.js";
import { parseSafeCode, parseSafeInteger, type SafeCode, type TaskSlug } from "../contracts/evidence.js";
import type { PlainJsonValue } from "../contracts/plain-json.js";
import { parsePhaseInstanceId } from "../contracts/phase-instance.js";
import { createGitRunner } from "../repository/git.js";
import { discoverWorktree } from "../repository/identity.js";
import { createProductionServices } from "../state/production.js";
import { classifyDurableStateReadability, computeTaskStatus, type TaskStatusV1 } from "../state/status.js";

export type StatusNextAction = Readonly<{
  code: string;
  detail: string;
  human_required: boolean;
  commands?: Readonly<{ claude: string; codex: string }>;
  input?: PlainJsonValue;
}>;

export type WorkflowStatusClassification = Readonly<{
  mode: "normal" | "degraded" | "repair-required" | "upgrade-staged" | "upgrade-restart-required";
  task_status?: TaskStatusV1;
  next_action: StatusNextAction;
}>;

export type ClassifyWorkflowStatusInput = Readonly<{
  working_directory: string;
  task_id: TaskSlug;
}>;

const ok = <T>(value: T): ProjectResult<T> => Object.freeze({ schema_version: "1", ok: true, value });

function action(code: string, detail: string, human: boolean, commands?: Readonly<{ claude: string; codex: string }>, input?: PlainJsonValue): StatusNextAction {
  return Object.freeze({ code, detail, human_required: human, ...(commands === undefined ? {} : { commands }), ...(input === undefined ? {} : { input }) });
}

async function stagedUpgradeStatus(input: ClassifyWorkflowStatusInput): Promise<WorkflowStatusClassification | undefined> {
  const discovered = await discoverWorktree(createGitRunner({ cwd: input.working_directory }), {
    task_id: input.task_id,
    phase_instance: parsePhaseInstanceId("prd"),
    operation: parseSafeCode("inspect-legacy-stage"),
    attempt: parseSafeInteger(1),
  });
  if (!discovered.ok) return undefined;
  const imports = join(discovered.value.location.worktreeRoot, ".archflow", "runtime", "tasks", input.task_id, "cache", "imports");
  let digests: string[];
  try { digests = (await readdir(imports)).filter((entry) => /^[a-f0-9]{64}$/u.test(entry)).sort(); }
  catch { return undefined; }
  if (digests.length === 0) return undefined;
  const stages: Array<Record<string, PlainJsonValue>> = [];
  for (const digest of digests) {
    try {
      const parsed = JSON.parse(await readFile(join(imports, digest, "stage.json"), "utf8")) as unknown;
      if (parsed !== null && !Array.isArray(parsed) && typeof parsed === "object") stages.push(parsed as Record<string, PlainJsonValue>);
    } catch { /* A pre-fix stage has no stage descriptor. */ }
  }
  if (digests.length === 1 && stages.length === 1 && stages[0]!.task_id === input.task_id && stages[0]!.import_digest === digests[0]) {
    return Object.freeze({
      mode: "upgrade-staged" as const,
      next_action: action(
        "resume-upgrade-in-mcp-session",
        `A reviewed legacy import is staged for this task and no durable state exists. Resume the upgrade in a session that exposes the ArchFlow MCP server; ${String(stages[0]!.resume_phase)} is the proposed continuation point.`,
        false,
        Object.freeze({ claude: `/archflow-upgrade ${input.task_id}`, codex: `$archflow-upgrade ${input.task_id}` }),
        structuredClone(stages[0]!) as PlainJsonValue,
      ),
    });
  }
  return Object.freeze({
    mode: "upgrade-restart-required" as const,
    next_action: action(
      "discard-incompatible-upgrade-stage",
      "An older or ambiguous legacy import stage exists, but no durable state was created. Discard the explicitly reported stage, then rerun upgrade preview and staging with an active MCP server.",
      true,
      undefined,
      { operation: "discard-stage", task_id: input.task_id, import_digests: digests },
    ),
  });
}

/** Read-only classifier: reports where durable authority stands and exactly one next action. */
export async function classifyWorkflowStatus(input: ClassifyWorkflowStatusInput): Promise<ProjectResult<WorkflowStatusClassification>> {
  const readability = await classifyDurableStateReadability({
    working_directory: input.working_directory,
    task_id: input.task_id,
  });
  if (readability.readability === "absent") {
    const staged = await stagedUpgradeStatus(input);
    if (staged !== undefined) return ok(staged);
    return ok(Object.freeze({
      mode: "degraded" as const,
      next_action: action(
        "wait-for-server",
        "No durable task state exists. The MCP server records all progress; when it is available, proceed through the workflow skills. No offline recording exists.",
        false,
      ),
    }));
  }
  if (readability.readability === "unreadable") {
    return ok(Object.freeze({
      mode: "repair-required" as const,
      next_action: action(
        "repair-durable-state",
        `Durable task state exists but is not readable canonical authority: ${readability.summary}`,
        true,
        undefined,
        readability.details,
      ),
    }));
  }
  const created = await createProductionServices({
    working_directory: input.working_directory,
    task_id: input.task_id,
    operation: "manual-status" as SafeCode,
  });
  if (!created.ok) return created;
  const status = await computeTaskStatus(created.value.dependencies, created.value.authority);
  if (!status.ok) return status;
  const derived = status.value.next_action;
  const args = [input.task_id, ...(derived.skill_args ?? [])].join(" ");
  const commands = derived.skill === undefined || derived.code === "task-complete"
    ? undefined
    : Object.freeze({
        claude: [`/${derived.skill}`, args].filter(Boolean).join(" "),
        codex: [`$${derived.skill}`, args].filter(Boolean).join(" "),
      });
  return ok(Object.freeze({
    mode: "normal" as const,
    task_status: status.value,
    next_action: action(
      derived.code,
      derived.detail,
      derived.human_required,
      commands,
      structuredClone(derived) as PlainJsonValue,
    ),
  }));
}

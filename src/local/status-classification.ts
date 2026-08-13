import type { ProjectResult } from "../contracts/errors.js";
import type { SafeCode, TaskSlug } from "../contracts/evidence.js";
import type { PlainJsonValue } from "../contracts/plain-json.js";
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
  mode: "normal" | "degraded" | "repair-required";
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

/** Read-only classifier: reports where durable authority stands and exactly one next action. */
export async function classifyWorkflowStatus(input: ClassifyWorkflowStatusInput): Promise<ProjectResult<WorkflowStatusClassification>> {
  const readability = await classifyDurableStateReadability({
    working_directory: input.working_directory,
    task_id: input.task_id,
  });
  if (readability.readability === "absent") {
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

import type { TaskStateV1 } from "../contracts/durable-state.js";
import { createProjectError, type ProjectResult } from "../contracts/errors.js";
import type { PathSafeId, TaskSlug } from "../contracts/evidence.js";
import type { PhaseInstanceId } from "../contracts/phase-instance.js";
import { readTaskState } from "./read.js";
import type { TransactionAuthority } from "./authority.js";
import { assertInternalTransactionAuthority } from "./authority.js";
import { readManualCheckpoints } from "./manual-checkpoints.js";
import type { TransactionDependencies } from "./transaction.js";

export type DegradedStatus = Readonly<{
  task_id: TaskSlug;
  state: "missing" | "active" | "complete" | "abandoned";
  revision?: number;
  phase_instance?: PhaseInstanceId;
  step?: TaskStateV1["step"];
  status?: TaskStateV1["status"];
  checkpoint_head_revision?: number;
  open_gate_id?: PathSafeId;
  blocking_reasons: readonly string[];
}>;

const ok = <T>(value: T): ProjectResult<T> => Object.freeze({ schema_version: "1", ok: true, value });

/** Computes a read-only, explicitly degraded summary from durable local authority. */
export async function computeDegradedStatus(
  dependencies: TransactionDependencies,
  authority: TransactionAuthority,
): Promise<ProjectResult<DegradedStatus>> {
  assertInternalTransactionAuthority(authority, dependencies);
  const stateRead = await readTaskState(authority.state);
  if (stateRead.kind === "unreadable" || stateRead.kind === "noncanonical") {
    return Object.freeze({
      schema_version: "1",
      ok: false,
      error: createProjectError("STATE_INVALID", {
        phase_instance: authority.context.phase_instance,
        issue_code: stateRead.kind === "unreadable" ? "state-unreadable" : "state-noncanonical",
      }),
    });
  }
  const checkpoints = await readManualCheckpoints(dependencies, authority);
  if (!checkpoints.ok) return checkpoints;
  const head = checkpoints.value.at(-1)?.value.revision;
  if (stateRead.kind === "missing") {
    return ok(Object.freeze({
      task_id: authority.task_id,
      state: "missing" as const,
      ...(head === undefined ? {} : { checkpoint_head_revision: head }),
      blocking_reasons: Object.freeze(["state-missing"]),
    }));
  }
  if (stateRead.kind !== "canonical") throw new TypeError("unreachable state read classification");
  const state = stateRead.document.value;
  const blockers: string[] = [];
  if (state.open_gate !== undefined) blockers.push("gate-decision-required");
  if (head !== undefined && head > state.revision) blockers.push("checkpoint-import-available");
  return ok(Object.freeze({
    task_id: authority.task_id,
    state: state.terminal ?? "active",
    revision: state.revision,
    phase_instance: state.phase_instance,
    step: state.step,
    status: state.status,
    ...(head === undefined ? {} : { checkpoint_head_revision: head }),
    ...(state.open_gate === undefined ? {} : { open_gate_id: state.open_gate.gate_id }),
    blocking_reasons: Object.freeze(blockers),
  }));
}

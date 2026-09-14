import { readFile } from "node:fs/promises";
import { setTimeout as delay } from "node:timers/promises";
import { z } from "zod";

import { assertPlainJson, type PlainJsonValue } from "../contracts/plain-json.js";
import { canonicalJsonBytes, canonicalJsonDigest } from "../contracts/canonical.js";
import { publicDispatchFailureDetailV1Schema, type PublicDispatchFailureV1, type PublicDispatchFailureDetailV1, type DispatchFailureRoleV1 } from "../contracts/dispatch-failure.js";
import type { TaskStateV1 } from "../contracts/durable-state.js";
import { createProjectError, parseProjectError } from "../contracts/errors.js";
import { parseTaskPathClaim } from "../contracts/path-claims.js";
import { resolveTaskPath } from "../repository/paths.js";
import type { TransactionAuthority } from "../state/authority.js";
import type { TransactionDependencies } from "../state/transaction.js";
import { classifiedDispatchFailure } from "./failure-observation.js";
import { routeFromConfiguredRoute, type SelectedRouteCandidate } from "./routing.js";

export const MAX_DISPATCHES = 3;
const BACKOFF_MS = [1000, 4000] as const;
const entrySchema = z.object({
  key: z.string().regex(/^[0-9a-f]{64}$/u),
  envelope_digest: z.string().regex(/^[0-9a-f]{64}$/u).optional(),
  role: z.enum(["counter-reviewer", "test-reviewer", "adjudicator", "effort-reviewer"]),
  dispatches: z.number().int().min(0).max(MAX_DISPATCHES),
  status: z.enum(["running", "retrying", "failed", "succeeded"]),
  failure: publicDispatchFailureDetailV1Schema.optional(),
  next_retry_at: z.iso.datetime().optional(),
}).strict();
const recordSchema = z.object({
  schema_version: z.literal("1"), binding: z.string().regex(/^[0-9a-f]{64}$/u),
  entries: z.array(entrySchema).max(64),
}).strict();
type Entry = { key: string; envelope_digest?: string; role: DispatchFailureRoleV1; dispatches: number;
  status: "running" | "retrying" | "failed" | "succeeded"; failure?: PublicDispatchFailureDetailV1; next_retry_at?: string };
type Record = { schema_version: "1"; binding: string; entries: Entry[] };
export type RecoveryContext = Readonly<{
  authority: TransactionAuthority;
  dependencies: TransactionDependencies;
  state: TaskStateV1;
  signal?: AbortSignal;
  /** Exact invocation identity of an explicitly reason-bearing one-dispatch human override. */
  retry_authorization?: string;
  wait?: (milliseconds: number) => Promise<void>;
}>;

function binding(state: TaskStateV1): string {
  return canonicalJsonDigest({
    task_id: state.task_id, phase_instance: state.phase_instance, attempt: state.attempt,
    input_fingerprint: state.input_fingerprint,
    produce: state.authoritative_results.find((ref) => ref.phase_instance === state.phase_instance && ref.step === "produce") ?? null,
  });
}
function key(role: DispatchFailureRoleV1, selected: SelectedRouteCandidate | undefined, authorization?: string, envelopeDigest?: string): string {
  const value = { role, selection: selected ?? null, authorization: authorization ?? null, envelope_digest: envelopeDigest ?? null };
  assertPlainJson(value, "dispatch recovery selection");
  return canonicalJsonDigest(structuredClone(value) as PlainJsonValue);
}
function failure(role: DispatchFailureRoleV1, selected: SelectedRouteCandidate | undefined, error: unknown): PublicDispatchFailureDetailV1 {
  const classified = classifiedDispatchFailure(error);
  const candidate = {
    role, code: classified?.code ?? "PROCESS_FAILED",
    message: classified?.message ?? "The reviewer failed without a classified transient cause. Inspect the failure before retrying.",
    ...(classified?.repository_name === undefined ? {} : { repository_name: classified.repository_name }),
    ...(selected === undefined ? {} : { route: { ...selected.raw_route, source: selected.source.provenance } }),
  };
  const parsed = publicDispatchFailureDetailV1Schema.safeParse(candidate);
  if (parsed.success) return parsed.data;
  // Invalid route input must still produce an actionable durable failure, without copying invalid bytes.
  return { role, code: "CONFIG_INVALID", message: "The selected reviewer route configuration is invalid." };
}

/** Retry only positively classified transient failures. Generic process, IO, schema, auth,
 * cancellation and integrity errors are deliberately not inferred to be temporary.
 */
export function isTransientDispatchFailure(error: unknown): boolean {
  if (error === null || typeof error !== "object") return false;
  const descriptor = Object.getOwnPropertyDescriptor(error, "project_error");
  if (descriptor?.enumerable !== true || !("value" in descriptor)) return false;
  try {
    const parsed = parseProjectError(descriptor.value);
    return parsed.code === "RATE_LIMITED" || parsed.code === "TIMEOUT" || parsed.code === "REPOSITORY_VIEW_UNAVAILABLE" ||
      (parsed.code === "PROCESS_FAILED" && parsed.diagnostic.parameters.exit_class === "transient-transport");
  } catch { return false; }
}

async function target(context: Pick<RecoveryContext, "authority" | "dependencies">) {
  const resolved = await resolveTaskPath({ runner: context.dependencies.runner, taskId: context.authority.task_id,
    claim: parseTaskPathClaim("authority/dispatch-recovery.json"), expectedClass: "authority-recovery", context: context.authority.context });
  if (!resolved.ok) throw new Error("Durable dispatch recovery path is unavailable");
  return resolved.value;
}
async function read(context: Pick<RecoveryContext, "authority" | "dependencies" | "state">): Promise<Record> {
  let bytes: Uint8Array;
  try { bytes = await readFile((await target(context)).absolute); }
  catch (error) {
    if (error !== null && typeof error === "object" && "code" in error && error.code === "ENOENT") {
      return { schema_version: "1", binding: binding(context.state), entries: [] };
    }
    throw error;
  }
  const record = recordSchema.parse(JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes))) as Record;
  if (Buffer.compare(Buffer.from(bytes), Buffer.from(canonicalJsonBytes(record))) !== 0 ||
      new Set(record.entries.map((entry) => entry.key)).size !== record.entries.length) {
    throw new Error("Durable dispatch recovery record is not canonical");
  }
  return record.binding === binding(context.state) ? record : { schema_version: "1", binding: binding(context.state), entries: [] };
}

/** A bounded operational journal, atomically replaced under the task lock. It cannot grant
 * review, approval, commit or advancement authority and never changes the workflow cursor.
 */
async function update(context: RecoveryContext, change: (record: Record) => void): Promise<Record> {
  return context.dependencies.lock.runExclusive(context.authority.workspace_root, async () => {
    const live = await context.dependencies.read_state(context.authority.state);
    if (live.kind !== "canonical" || live.document.value.terminal !== undefined ||
        live.document.value.step !== "counter_review" || live.document.value.status !== "running" ||
        binding(live.document.value) !== binding(context.state)) throw new Error("Dispatch recovery subject is stale");
    const record = await read(context);
    change(record);
    record.entries.sort((a, b) => a.key < b.key ? -1 : a.key > b.key ? 1 : 0);
    await context.dependencies.atomic.replace(await target(context), canonicalJsonBytes(recordSchema.parse(record) as Record));
    return record;
  });
}

export function createDispatchRecovery(context: RecoveryContext) {
  return {
    async observe(role: DispatchFailureRoleV1, selected: SelectedRouteCandidate | undefined, error: unknown): Promise<void> {
      const entryKey = key(role, selected, context.retry_authorization);
      await update(context, (record) => {
        if (record.entries.some((entry) => entry.role === role && entry.status === "failed" &&
            entry.failure?.route?.model === selected?.raw_route.model && entry.failure?.route?.effort === selected?.raw_route.effort && entry.failure?.route?.provider === selected?.raw_route.provider)) return;
        record.entries = record.entries.filter((entry) => entry.key !== entryKey);
        record.entries.push({ key: entryKey, role, dispatches: 0, status: "failed", failure: failure(role, selected, error) });
      });
    },
    async run<T>(role: DispatchFailureRoleV1, selected: SelectedRouteCandidate, operation: () => Promise<T>, envelopeDigest?: string): Promise<T> {
      const entryKey = key(role, selected, context.retry_authorization, envelopeDigest);
      while (true) {
        context.signal?.throwIfAborted();
        const scheduled = (await read(context)).entries.find((entry) => entry.key === entryKey)?.next_retry_at;
        if (scheduled !== undefined) {
          const remaining = Math.max(0, Date.parse(scheduled) - Date.now());
          if (remaining > 0) await (context.wait?.(remaining) ?? delay(remaining, undefined, { signal: context.signal }));
        }
        let previous: Entry | undefined;
        let exhausted = false;
        await update(context, (record) => {
          previous = record.entries.find((entry) => entry.key === entryKey);
          if (previous !== undefined && previous.status !== "succeeded" && previous.dispatches >= MAX_DISPATCHES) {
            previous.status = "failed";
            previous.failure ??= failure(role, selected, new Error("Interrupted dispatch"));
            exhausted = true;
            return;
          }
          const dispatches = previous?.status === "succeeded" ? 1 : (previous?.dispatches ?? 0) + 1;
          record.entries = record.entries.filter((entry) => {
            if (entry.key === entryKey) return false;
            if (entry.role !== role || entry.status !== "failed") return true;
            if (context.retry_authorization === undefined && entry.envelope_digest !== undefined && entry.envelope_digest !== envelopeDigest) return true;
            const oldRoute = entry.failure?.route;
            return oldRoute !== undefined && (oldRoute.model !== selected.raw_route.model || oldRoute.effort !== selected.raw_route.effort || oldRoute.provider !== selected.raw_route.provider);
          });
          record.entries.push({ key: entryKey, role, dispatches, status: "running",
            ...(envelopeDigest === undefined ? {} : { envelope_digest: envelopeDigest }),
            ...(previous?.failure === undefined ? {} : { failure: previous.failure }) });
        });
        if (exhausted) throw Object.assign(new Error("Automatic reviewer retries are exhausted; explicitly authorize another attempt or a substitute route."), {
          project_error: createProjectError("PROCESS_FAILED", { adapter: routeFromConfiguredRoute(selected.raw_route).adapter, exit_class: "retry-budget-exhausted" }),
        });
        try {
          const value = await operation();
          await update(context, (record) => {
            const entry = record.entries.find((item) => item.key === entryKey)!;
            entry.status = "succeeded";
            delete entry.failure;
            delete entry.next_retry_at;
          });
          return value;
        } catch (error) {
          let retry = false;
          await update(context, (record) => {
            const entry = record.entries.find((item) => item.key === entryKey)!;
            retry = isTransientDispatchFailure(error) && entry.dispatches < MAX_DISPATCHES && context.signal?.aborted !== true;
            entry.status = retry ? "retrying" : "failed";
            entry.failure = failure(role, selected, error);
            if (retry) entry.next_retry_at = new Date(Date.now() + BACKOFF_MS[entry.dispatches - 1]!).toISOString();
            else delete entry.next_retry_at;
          });
          if (!retry) throw error;
        }
      }
    },
  };
}

/** Durable failure takes precedence over the old disposable diagnostic. Missing journal means
 * a pre-feature or not-yet-dispatched round; malformed journal is an explicit repair boundary.
 */
export async function readDispatchRecovery(context: Pick<RecoveryContext, "authority" | "dependencies" | "state">): Promise<PublicDispatchFailureV1 | null | undefined> {
  if (context.state.terminal !== undefined || context.state.step !== "counter_review" || context.state.status !== "running") return undefined;
  try {
    const record = await read(context);
    const pending = record.entries.filter((entry) => entry.status !== "succeeded" && entry.failure !== undefined);
    const entry = pending.find((item) => item.status === "failed") ?? pending[0];
    if (entry?.failure === undefined) return record.entries.length === 0 ? undefined : null;
    const project = (item: Entry): PublicDispatchFailureDetailV1 => ({ ...item.failure!, recovery: {
      status: item.status === "failed" ? item.dispatches >= MAX_DISPATCHES ? "exhausted" : "repair-required" : "retrying",
      dispatches: item.dispatches, maximum_dispatches: MAX_DISPATCHES,
      ...(item.next_retry_at === undefined ? {} : { next_retry_at: item.next_retry_at }),
    } });
    const additional = pending.filter((item) => item !== entry).map(project);
    return { ...project(entry), ...(additional.length === 0 ? {} : { additional_failures: additional }) };
  } catch {
    return { role: "counter-reviewer", code: "RECOVERY_STATE_INVALID", message: "Durable reviewer recovery state is unreadable; repair it before retrying.",
      recovery: { status: "repair-required", dispatches: 0, maximum_dispatches: MAX_DISPATCHES } };
  }
}

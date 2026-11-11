import { appendFileSync, existsSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";

/**
 * Where the stack is kept so it outlives the response.
 *
 * Relative to the process's working directory, which is the repository under review. `.archflow/runtime/`
 * is scratch — it is excluded from every caller-change scan and deleted before a PR — and this
 * file belongs to no review workspace.
 * It is a process-level side channel for the operator, deliberately not routed through the
 * path-claim system.
 */
const INTERNAL_ERROR_LOG = join(".archflow", "runtime", "diagnostics", "internal-errors.log");

/**
 * Records the stack of an unexpected, unclassified review failure under the review's invocation
 * id. The review result carries only a generic failure message; this record is what lets the
 * operator find the cause.
 *
 * The stderr line alone proved insufficient: a host that owns the process's stderr may never
 * persist it, which leaves the one artifact that explains an opaque failure unrecoverable. So the
 * same detail is also appended to a file under the repository. Diagnostics must never change the
 * outcome of a call, so every failure to write is swallowed, and nothing is written outside an
 * ArchFlow repository.
 */
export function reportInternalError(correlationId: string, error: unknown): void {
  const detail = error instanceof Error ? error.stack ?? error.message : String(error);
  const record = `archflow INTERNAL_ERROR correlation_id=${correlationId}\n${detail}\n`;
  process.stderr.write(record);
  try {
    if (!existsSync(".archflow")) return;
    mkdirSync(dirname(INTERNAL_ERROR_LOG), { recursive: true });
    appendFileSync(INTERNAL_ERROR_LOG, `${new Date().toISOString()} ${record}`, "utf8");
  } catch {
    // A diagnostics write can never be allowed to alter the response.
  }
}

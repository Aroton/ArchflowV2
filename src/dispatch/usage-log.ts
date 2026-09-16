import { mkdir, readdir, unlink, writeFile } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import type { DispatchUsage } from "../contracts/dispatch-usage.js";

export const DISPATCH_USAGE_RETENTION_MS = 7 * 24 * 60 * 60 * 1000;
const RECORD_NAME = /^(\d{13})-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.json$/u;

export type DispatchUsageRecord = {
  readonly schema_version: "1";
  readonly dispatch_id: string;
  readonly started_at: string;
  readonly completed_at: string;
  readonly duration_ms: number;
  readonly repository: string;
  readonly task_id?: string;
  readonly phase_instance?: string;
  readonly attempt?: number;
  readonly adapter: string;
  readonly model: string;
  readonly effort: string;
  readonly provider?: string;
  readonly cli_version?: string;
  readonly result_kind: string;
  readonly envelope_digest: string;
  readonly input_byte_count: number;
  /** Completion of the CLI dispatch, not approval or completion of the workflow round. */
  readonly status: "succeeded" | "failed";
  readonly failure_code?: string;
  readonly failure_stage?: string;
  readonly usage?: DispatchUsage;
};

/** The installer always lays out <ARCHFLOW_HOME>/bundle/dist/<entry>.mjs. */
export function installedDispatchUsageDirectory(moduleUrl: string = import.meta.url): string | undefined {
  const entry = fileURLToPath(moduleUrl);
  const dist = dirname(entry);
  const bundle = dirname(dist);
  if (basename(dist) !== "dist" || basename(bundle) !== "bundle" ||
      !["archflow-mcp.mjs", "archflow-local.mjs"].includes(basename(entry))) return undefined;
  // Keep logs outside bundle/: installing an update replaces that entire directory.
  return join(dirname(bundle), "usage");
}

/** One small file per dispatch avoids interleaved appends from concurrent MCP servers. */
export async function writeDispatchUsageRecord(
  record: DispatchUsageRecord,
  directory = installedDispatchUsageDirectory(),
  now = Date.now(),
): Promise<void> {
  if (directory === undefined) return; // Source checkouts never write shared installation state.
  try {
    const name = `${Date.parse(record.completed_at)}-${record.dispatch_id}.json`;
    if (!RECORD_NAME.test(name)) return;
    await mkdir(directory, { recursive: true, mode: 0o700 });
    const cutoff = now - DISPATCH_USAGE_RETENTION_MS;
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const match = RECORD_NAME.exec(entry.name);
      if (entry.isFile() && match !== null && Number(match[1]) < cutoff) {
        await unlink(join(directory, entry.name)).catch(() => undefined);
      }
    }
    await writeFile(join(directory, name), `${JSON.stringify(record)}\n`, { flag: "wx", mode: 0o600 });
  } catch {
    // Accounting is best-effort: disk failures must never fail a review or authorize progress.
  }
}

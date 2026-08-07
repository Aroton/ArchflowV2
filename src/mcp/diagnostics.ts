/**
 * Emits the diagnostic trail for INTERNAL_ERROR results. The wire error carries
 * only a correlation id; this stderr line is the host-side record that makes
 * the "stop-and-inspect" next_action actionable.
 */
export function reportInternalError(correlationId: string, error: unknown): void {
  const detail = error instanceof Error ? error.stack ?? error.message : String(error);
  process.stderr.write(`archflow INTERNAL_ERROR correlation_id=${correlationId}\n${detail}\n`);
}

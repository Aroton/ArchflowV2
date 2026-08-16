import type { AuthoritativeResultRef, TaskStateV1 } from "../contracts/durable-state.js";
import type { Sha256Digest } from "../contracts/evidence.js";

/**
 * The single retained-result root graph. A result digest identifies one immutable manifest, so a
 * reference reachable through several audit roots is intentionally counted and retained once.
 */
export function retainedResultReferences(state: TaskStateV1): readonly AuthoritativeResultRef[] {
  const restartHistory = state.restart_history ?? [];
  const roots = [
    ...state.authoritative_results,
    ...(state.pending_human_revision?.evidence ?? []),
    ...(state.human_revision_history ?? []).flatMap((revision) => revision.evidence),
    ...restartHistory.flatMap((restart) => restart.superseded_results),
    ...restartHistory.flatMap((restart) => restart.cleared_pending_human_revision?.evidence ?? []),
  ];
  const byDigest = new Map<Sha256Digest, AuthoritativeResultRef>();
  for (const reference of roots) {
    if (!byDigest.has(reference.result_digest)) byDigest.set(reference.result_digest, reference);
  }
  return Object.freeze([...byDigest.values()].sort((left, right) =>
    left.result_digest.localeCompare(right.result_digest)));
}

export function retainedResultDigests(state: TaskStateV1): ReadonlySet<Sha256Digest> {
  return new Set(retainedResultReferences(state).map((reference) => reference.result_digest));
}

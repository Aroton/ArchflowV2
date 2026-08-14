import type { Sha256Digest } from "../contracts/evidence.js";
import type { TaskPathClaim } from "../contracts/path-claims.js";
import { assertPlainJson } from "../contracts/plain-json.js";
import type { TransactionAuthority } from "./authority.js";
import {
  inspectAbandonedTaskLock,
  removeConfirmedAbandonedTaskLock,
  type AbandonedTaskLockPlan,
} from "./lock.js";

export const MAX_REPAIR_HISTORY_ENTRIES = 128;

export type SuppliedHistoryEntry = Readonly<{
  path: TaskPathClaim;
  document_kind: "intent-receipt" | "gate-decision" | "result-manifest";
  digest: Sha256Digest;
  relation: "current" | "prepared" | "superseded" | "foreign" | "invalid";
}>;

export type RepairClassification = Readonly<{
  path: TaskPathClaim;
  digest: Sha256Digest;
  classification: "current-evidence" | "orphaned-preparation" | "retained-history" | "foreign-evidence" | "invalid-evidence" | "competing-successor";
  next_action: "none" | "resume-exact-intent" | "retain-for-audit" | "exclude-foreign-evidence" | "repair-or-remove-explicitly" | "request-human-successor-selection";
}>;

/** Classifies exactly the caller-supplied bounded list and never selects or promotes an entry. */
export function classifySuppliedRepairHistory(entries: readonly SuppliedHistoryEntry[]): readonly RepairClassification[] {
  assertPlainJson(entries, "repair history entries");
  const supplied = structuredClone(entries);
  if (supplied.length > MAX_REPAIR_HISTORY_ENTRIES) throw new RangeError("repair history exceeds the caller-bounded limit");
  const successorDigests = new Set(supplied.filter((entry) => entry.relation === "prepared").map((entry) => entry.digest));
  return Object.freeze(supplied.map((entry): RepairClassification => {
    if (entry.relation === "prepared" && successorDigests.size > 1) {
      return Object.freeze({ ...entry, classification: "competing-successor", next_action: "request-human-successor-selection" });
    }
    switch (entry.relation) {
      case "current": return Object.freeze({ ...entry, classification: "current-evidence", next_action: "none" });
      case "prepared": return Object.freeze({ ...entry, classification: "orphaned-preparation", next_action: "resume-exact-intent" });
      case "superseded": return Object.freeze({ ...entry, classification: "retained-history", next_action: "retain-for-audit" });
      case "foreign": return Object.freeze({ ...entry, classification: "foreign-evidence", next_action: "exclude-foreign-evidence" });
      case "invalid": return Object.freeze({ ...entry, classification: "invalid-evidence", next_action: "repair-or-remove-explicitly" });
    }
  }));
}

export async function planAbandonedLockRepair(authority: TransactionAuthority): Promise<AbandonedTaskLockPlan> {
  return inspectAbandonedTaskLock(authority);
}

export async function repairAbandonedLock(
  authority: TransactionAuthority,
  plan: AbandonedTaskLockPlan,
  human_confirmed_no_live_writer: boolean,
): Promise<void> {
  await removeConfirmedAbandonedTaskLock(authority, plan, human_confirmed_no_live_writer);
}

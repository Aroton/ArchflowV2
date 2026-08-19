import type { TaskConfigSnapshot } from "../contracts/config.js";
import type { ConfigChangeEntry } from "../contracts/durable-state.js";
import type { PlainJsonValue } from "../contracts/plain-json.js";

/**
 * Drops the retired `producer` routing role before any change detection, so a config whose only
 * edit is that cosmetic retire parses to the same normalized structure and reports no change. The
 * parser already accepts the role on read (`configRolesSchema`); this is the recording-side half
 * of that tolerance. The input is never mutated — a config without the role is returned as-is.
 */
export function normalizeForChangeDetection(config: TaskConfigSnapshot): TaskConfigSnapshot {
  if (config.roles.producer === undefined) return config;
  const { producer: _retired, ...roles } = config.roles;
  return { ...config, roles };
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function appendEntry(entries: ConfigChangeEntry[], path: string, before: unknown, after: unknown): void {
  entries.push({
    path,
    ...(before === undefined ? {} : { before: before as PlainJsonValue }),
    ...(after === undefined ? {} : { after: after as PlainJsonValue }),
  });
}

/**
 * Recursive leaf diff. Arrays are compared index by index (a length change reports only the
 * added or removed tail), objects key by key over the union of their keys in sorted order, and
 * primitives by identity. Both structures are normalized first, so a retired-role retire is
 * invisible here too. Byte-level comment or reorder edits never appear: the diff is over parsed
 * structures, and bytes that parse to the same structure produce no entries.
 */
function diffConfigValue(before: unknown, after: unknown, path: string, entries: ConfigChangeEntry[]): void {
  if (Array.isArray(before) && Array.isArray(after)) {
    const shared = Math.min(before.length, after.length);
    for (let index = 0; index < shared; index += 1) {
      diffConfigValue(before[index], after[index], `${path}.${index}`, entries);
    }
    for (let index = shared; index < before.length; index += 1) {
      appendEntry(entries, `${path}.${index}`, before[index], undefined);
    }
    for (let index = shared; index < after.length; index += 1) {
      appendEntry(entries, `${path}.${index}`, undefined, after[index]);
    }
    return;
  }
  if (isPlainObject(before) && isPlainObject(after)) {
    const keys = [...new Set([...Object.keys(before), ...Object.keys(after)])].sort();
    for (const key of keys) {
      diffConfigValue(before[key], after[key], path === "" ? key : `${path}.${key}`, entries);
    }
    return;
  }
  if (before === after) return;
  appendEntry(entries, path, before, after);
}

/**
 * The field-level change entries between two parsed configs: `path` is a dot-separated segment
 * string with array items addressed by index (e.g. `roles.counter-reviewer.model`), and an absent
 * side omits its field — an added leaf carries only `after`, a removed one only `before`.
 * Informational only; callers must never let an entry block or reroute work.
 */
export function computeConfigChange(
  before: TaskConfigSnapshot,
  after: TaskConfigSnapshot,
): readonly ConfigChangeEntry[] {
  const entries: ConfigChangeEntry[] = [];
  diffConfigValue(normalizeForChangeDetection(before), normalizeForChangeDetection(after), "", entries);
  return Object.freeze(entries);
}

/**
 * Records the parsed live config on a next-state draft as its `last_seen_config`, replacing the
 * draft's value only when the normalized structures differ. One shared normalization for every
 * config-observing commit path — the kernel's draft finalization, revision-zero seeding, and the
 * two gate-lifecycle commits — so the receipt's prepared state, its digest, the committed bytes,
 * and any crash replay all agree. The stored snapshot is the normalized form, so a cosmetic
 * retired-role retire never rewrites committed bytes.
 */
export function withLastSeenConfig<Draft extends { readonly last_seen_config?: TaskConfigSnapshot }>(
  draft: Draft,
  parsedLiveConfig: TaskConfigSnapshot,
): Draft {
  const normalized = normalizeForChangeDetection(parsedLiveConfig);
  const seen = draft.last_seen_config;
  if (seen !== undefined && computeConfigChange(seen, normalized).length === 0) return draft;
  return { ...draft, last_seen_config: normalized } as Draft;
}

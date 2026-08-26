import { isDeepStrictEqual } from "node:util";
import type { TaskConfigSnapshot } from "../contracts/config.js";
import type { ConfigChangeEntry, LastSeenRepositoryBindingV1, TaskStateV1 } from "../contracts/durable-state.js";
import { createProjectError, type ProjectResult } from "../contracts/errors.js";
import type { PlainJsonValue } from "../contracts/plain-json.js";
import type { RepositorySet } from "../repository/repository-set.js";

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
export function repositoryBindingsCheckpoint(
  repositorySet: RepositorySet,
): readonly LastSeenRepositoryBindingV1[] {
  return Object.freeze(repositorySet.members.map((member) => Object.freeze({
    name: member.name,
    ...(member.declared_path === undefined ? {} : { declared_path: member.declared_path }),
    repository_identity_digest: member.identity.digest,
  })));
}

/**
 * Refuses silent replacement of a repository whose name and exact declaration path have not
 * changed since the last successful config-observing transaction. Membership itself remains
 * entirely live-config-owned: removed members are ignored and an explicit path edit is accepted.
 */
export function validateRepositorySetContinuity(
  state: TaskStateV1,
  repositorySet: RepositorySet,
): ProjectResult<void> {
  const prior = state.last_seen_repository_bindings;
  if (prior === undefined) return Object.freeze({ schema_version: "1", ok: true, value: undefined });
  const priorByName = new Map(prior.map((entry) => [entry.name, entry]));
  for (const member of repositorySet.members) {
    if (member.name === "primary") continue;
    const checkpoint = priorByName.get(member.name);
    if (checkpoint === undefined || checkpoint.declared_path !== member.declared_path) continue;
    if (checkpoint.repository_identity_digest !== member.identity.digest) {
      return Object.freeze({
        schema_version: "1",
        ok: false,
        error: createProjectError("CONFIG_INVALID", {
          issue_code: "repository-identity-changed",
          issues: [`repositories.${member.name}.path: repository identity changed at the unchanged declared path`],
        }),
      });
    }
  }
  return Object.freeze({ schema_version: "1", ok: true, value: undefined });
}

export function withLastSeenConfig<Draft extends {
  readonly last_seen_config?: TaskConfigSnapshot;
  readonly last_seen_repository_bindings?: readonly LastSeenRepositoryBindingV1[];
}>(
  draft: Draft,
  parsedLiveConfig: TaskConfigSnapshot,
  repositorySet: RepositorySet,
): Draft {
  const normalized = normalizeForChangeDetection(parsedLiveConfig);
  const seen = draft.last_seen_config;
  const checkpoint = repositoryBindingsCheckpoint(repositorySet);
  const priorCheckpoint = draft.last_seen_repository_bindings;
  const configUnchanged = seen !== undefined && computeConfigChange(seen, normalized).length === 0;
  // Structural equality: a checkpoint read back from canonical JSON carries a different key order
  // than one freshly built, and a string comparison would rewrite the state on every transaction.
  const checkpointUnchanged = priorCheckpoint !== undefined && isDeepStrictEqual(priorCheckpoint, checkpoint);
  if (configUnchanged && checkpointUnchanged) return draft;
  return {
    ...draft,
    last_seen_config: normalized,
    last_seen_repository_bindings: checkpoint,
  } as Draft;
}

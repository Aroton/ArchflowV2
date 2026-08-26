import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

import { canonicalDocument } from "../../src/contracts/canonical.js";
import { validateDurableSemantics } from "../../src/contracts/durable.js";
import { taskStateV1Schema, type TaskStateV1 } from "../../src/contracts/durable-state.js";

const baseState = (): TaskStateV1 => {
  const state = JSON.parse(readFileSync(
    new URL("../fixtures/contracts/durable/task-state.valid.json", import.meta.url),
    "utf8",
  )) as TaskStateV1;
  const { open_gate: _openGate, ...withoutGate } = state;
  return withoutGate;
};

const withRepositories = (): TaskStateV1 => ({
  ...baseState(),
  last_seen_config: {
    schema_version: "1",
    roles: {},
    repositories: {
      stripe: { path: "../stripe", mode: "writable" },
      apis: { path: "../apis" },
    },
  },
  last_seen_repository_bindings: [
    { name: "primary", repository_identity_digest: "1".repeat(64) as never },
    { name: "apis", declared_path: "../apis", repository_identity_digest: "2".repeat(64) as never },
    { name: "stripe", declared_path: "../stripe", repository_identity_digest: "3".repeat(64) as never },
  ],
});

const semanticResult = (state: TaskStateV1) => validateDurableSemantics({ state: canonicalDocument(state) });

describe("last-seen repository checkpoint contract", () => {
  it("accepts legacy absence only when the last-seen config has no secondaries", () => {
    expect(semanticResult(baseState()).ok).toBe(true);
    expect(semanticResult({
      ...baseState(),
      last_seen_config: { schema_version: "1", roles: {} },
    }).ok).toBe(true);
    const { last_seen_repository_bindings: _bindings, ...missingCheckpoint } = withRepositories();
    expect(semanticResult(missingCheckpoint)).toMatchObject({ ok: false, error: { code: "STATE_INVALID", diagnostic: { parameters: { issue_code: "repository-checkpoint-mismatch" } } } });
  });

  it("requires primary followed by the exact ordinal secondary names and declared paths", () => {
    const valid = withRepositories();
    expect(taskStateV1Schema.safeParse(valid).success).toBe(true);
    expect(semanticResult(valid).ok).toBe(true);

    const bindings = valid.last_seen_repository_bindings!;
    for (const invalid of [
      { ...valid, last_seen_repository_bindings: bindings.slice(1) },
      { ...valid, last_seen_repository_bindings: [...bindings, { name: "extra", declared_path: "../extra", repository_identity_digest: "4".repeat(64) }] },
      { ...valid, last_seen_repository_bindings: [bindings[0], bindings[2], bindings[1]] },
      { ...valid, last_seen_repository_bindings: [bindings[0], bindings[1], bindings[1]] },
      { ...valid, last_seen_repository_bindings: [bindings[0], { ...bindings[1], declared_path: "../moved" }, bindings[2]] },
      { ...valid, last_seen_repository_bindings: [{ ...bindings[0], declared_path: "." }, bindings[1], bindings[2]] },
    ] as readonly TaskStateV1[]) {
      expect(semanticResult(invalid)).toMatchObject({
        ok: false,
        error: { code: "STATE_INVALID", diagnostic: { parameters: { issue_code: "repository-checkpoint-mismatch" } } },
      });
    }
  });
});

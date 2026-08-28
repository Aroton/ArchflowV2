import { describe, expect, it } from "vitest";

import { parseGitOid } from "../../src/contracts/canonical.js";
import type { TaskStateV1 } from "../../src/contracts/durable-state.js";
import { parseSafeInteger, parseSha256Digest, parseTaskSlug } from "../../src/contracts/evidence.js";
import { parseGateContext } from "../../src/contracts/gates.js";
import { encodePhaseInstance, parsePositiveSafePhaseNumber } from "../../src/contracts/phase-instance.js";
import { parseRepositoryPathClaim } from "../../src/contracts/path-claims.js";
import { baselineAdoptionInputFromFindings } from "../../src/state/status.js";

const D = (value: string) => parseSha256Digest(value.repeat(64));
const PHASE = encodePhaseInstance({ kind: "phase-impl", phase: parsePositiveSafePhaseNumber(10) });
const STATE: TaskStateV1 = {
  schema_version: "1", task_id: parseTaskSlug("task-1"), repository_identity_digest: D("1"),
  revision: parseSafeInteger(4), phase_instance: PHASE, step: "produce", status: "running",
  attempt: parseSafeInteger(1), input_fingerprint: D("2"), initialization_digest: D("3"),
  config_digest: D("4"), workflow_digest: D("5"), constitution_digest: D("6"),
  policy_base_commit: "abcdef0123456789abcdef0123456789abcdef01" as TaskStateV1["policy_base_commit"],
  authoritative_results: [], approvals: [], waivers: [],
};

// A mixed-case set whose localeCompare order differs from default code-unit .sort() — the exact
// shape that made composition reject its own input ("uncommitted paths must be sorted with no
// duplicates") in the transport-improvements failure.
const MIXED_CASE_PATHS = [
  "scripts/fixtures/transport-acceptance/ssh/v2/README.md",
  "scripts/fixtures/transport-acceptance/ssh/v2/archforge-acceptance-fixture-forced-command",
  "docs/transport-acceptance.md",
];
const BY_LOCALE = [...MIXED_CASE_PATHS].sort((left, right) => left.localeCompare(right));
const BY_CODE_UNIT = [...MIXED_CASE_PATHS].sort();

const driftFinding = (path: string, index: number) => ({
  kind: "projection-mismatch" as const,
  repository: undefined,
  path: parseRepositoryPathClaim(path),
  recorded_digest: D("a"),
  observed_digest: index % 2 === 0 ? D("b") : D("c"),
  next_action: "open-baseline-adoption-gate" as const,
});

describe("baselineAdoptionInputFromFindings", () => {
  it("emits localeCompare-ordered uncommitted paths that pass the gate context schema", () => {
    expect(BY_CODE_UNIT).not.toEqual(BY_LOCALE);
    const input = baselineAdoptionInputFromFindings(
      STATE.task_id,
      STATE,
      MIXED_CASE_PATHS.map((path, index) => driftFinding(path, index)),
      {
        target_ref: "refs/heads/main",
        target_head: parseGitOid("a".repeat(40)),
        uncommitted_paths: BY_CODE_UNIT.map((path) => parseRepositoryPathClaim(path)),
      },
    );
    if (input === undefined) throw new Error("expected a baseline-adoption input");
    expect([...input.context.uncommitted_paths!]).toEqual(BY_LOCALE);
    expect(() => parseGateContext("baseline-adoption", input.context)).not.toThrow();
  });

  it("keeps localeCompare order flowing through to secondary targets", () => {
    const input = baselineAdoptionInputFromFindings(
      STATE.task_id,
      STATE,
      MIXED_CASE_PATHS.map((path, index) => ({ ...driftFinding(path, index), repository: "apis" as never })),
      {
        target_ref: "refs/heads/main",
        target_head: parseGitOid("a".repeat(40)),
        uncommitted_paths: [],
        secondary_targets: [{
          repository: "apis",
          repository_identity_digest: D("d"),
          target_ref: "refs/heads/main",
          target_head: parseGitOid("b".repeat(40)),
          uncommitted_paths: BY_LOCALE.map((path) => parseRepositoryPathClaim(path)),
        }],
      },
    );
    if (input === undefined) throw new Error("expected a baseline-adoption input");
    expect([...input.context.secondary_targets![0]!.uncommitted_paths!]).toEqual(BY_LOCALE);
    expect(() => parseGateContext("baseline-adoption", input.context)).not.toThrow();
  });
});

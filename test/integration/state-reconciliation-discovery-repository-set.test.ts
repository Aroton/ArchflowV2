import { mkdirSync } from "node:fs";
import { join } from "node:path";

import { afterAll, describe, expect, it } from "vitest";

import { canonicalDocument } from "../../src/contracts/canonical.js";
import type { TaskStateV1 } from "../../src/contracts/durable-state.js";
import { parsePathSafeId, parseSafeCode, parseSafeId, parseSafeInteger, parseSha256Digest, parseTaskSlug } from "../../src/contracts/evidence.js";
import { parseRepositoryPathClaim } from "../../src/contracts/path-claims.js";
import { resolveRepositorySet } from "../../src/repository/repository-set.js";
import { createProductionServices } from "../../src/state/production.js";
import { discoverReconciliationInput } from "../../src/state/reconciliation-discovery.js";
import { cleanupTemporaryRepositories, createTempRepository } from "../helpers/temp-repository.js";

afterAll(cleanupTemporaryRepositories);
const TASK = parseTaskSlug("discovery-task");
const PHASE = "phase-impl-17" as TaskStateV1["phase_instance"];
const D = (character: string) => parseSha256Digest(character.repeat(64));

async function harness() {
  const primary = createTempRepository({ label: "reconciliation-discovery", attributes: undefined });
  primary.write("tracked.txt", "root\n");
  primary.commitAll("root");
  const root = primary.path;
  mkdirSync(join(root, ".archflow", "runtime", "tasks", TASK, "transient", "intents"), { recursive: true });
  const created = await createProductionServices({
    working_directory: root,
    task_id: TASK,
    operation: parseSafeCode("reconciliation-discovery-test"),
    phase_instance: PHASE,
  });
  if (!created.ok) throw new Error(`production setup failed: ${created.error.code}`);
  const state = (extra: Partial<TaskStateV1> = {}): TaskStateV1 => ({
    schema_version: "1", task_id: TASK,
    repository_identity_digest: created.value.authority.repository_identity_digest,
    revision: parseSafeInteger(4), phase_instance: PHASE, step: "produce", status: "running",
    attempt: parseSafeInteger(1), input_fingerprint: D("2"), initialization_digest: D("3"),
    config_digest: D("4"), workflow_digest: D("5"), constitution_digest: D("6"),
    policy_base_commit: "abcdef0123456789abcdef0123456789abcdef01" as TaskStateV1["policy_base_commit"],
    authoritative_results: [], approvals: [], waivers: [], ...extra,
  });
  return { root, services: created.value, state };
}

describe("reconciliation discovery across a declared repository set", () => {
  it("retains secondary repository attribution after adopted bytes become newest", async () => {
    const h = await harness();
    const secondary = createTempRepository({ label: "reconciliation-secondary", attributes: undefined });
    secondary.write("tracked.txt", "secondary\n");
    secondary.commitAll("root");
    const repositorySet = await resolveRepositorySet(
      { runner: h.services.runner, environment: h.services.environment },
      { repositories: { apis: { path: secondary.path, mode: "writable" } } } as never,
      h.services.authority.context,
    );
    if (!repositorySet.ok) throw new Error(repositorySet.error.code);
    const member = repositorySet.value.members.find((candidate) => candidate.name === "apis")!;
    const path = parseRepositoryPathClaim("tracked.txt");
    const reference = {
      phase_instance: PHASE, step: "produce", result_digest: D("7"), result_id: parseSafeId("result-secondary"),
      input_fingerprint: D("2"),
    } as TaskStateV1["authoritative_results"][number];
    const current = h.state({
      revision: parseSafeInteger(6), authoritative_results: [reference],
      baseline_adoptions: [{
        gate_id: parsePathSafeId("gate-secondary"), adopted_at_revision: parseSafeInteger(5),
        adopted_projections: [{ repository: "apis" as never, path, content_digest: D("c") }],
      }],
    });
    const dependencies = {
      ...h.services.dependencies,
      load_retained_manifest: async () => ({
        schema_version: "1" as const, ok: true as const,
        value: { manifest: { value: {
          outputs: [], projections: [], accounting: { measured_at_revision: 4 },
          source_artifact: { artifact_kind: "implementation-output", secondary_repositories: [{
            repository: "apis", outputs: [{ path, path_class: "repository-source", operation: "modify" }],
          }] },
          secondary_projections: [{
            repository: "apis", repository_identity_digest: member.identity.digest,
            projections: [{ repository: "apis", path, content_digest: D("a") }],
          }],
        } } } as never,
      }),
    };
    const discovered = await discoverReconciliationInput(
      dependencies, h.services.authority, canonicalDocument(current), repositorySet.value,
    );
    expect(discovered).toMatchObject({ ok: true, value: {
      recorded_projections: [{ repository: "apis", path, content_digest: D("c") }],
      current_projections: [{ repository: "apis", path }],
    } });
  });
});

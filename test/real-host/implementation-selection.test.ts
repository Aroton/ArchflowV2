import { readFile, writeFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import effortSchema from "../../src/contracts/schemas/v1/effort-review.schema.json" with { type: "json" };
import { canonicalJsonDigest, sha256Bytes } from "../../src/contracts/canonical.js";
import { parseConfigYaml } from "../../src/contracts/config.js";
import {
  EFFORT_SELECTOR_INSTRUCTIONS, IMPLEMENTATION_AGENT_SELECTOR_POLICY_ID,
  createEffortSelectionV3, parseEffortEnvelopeV3, type EffortSelectionV3,
} from "../../src/contracts/effort-review.js";
import { parsePhaseInstanceId } from "../../src/contracts/phase-instance.js";
import { createDispatchCoordinator } from "../../src/dispatch/coordinator.js";
import { serializeDispatch } from "../../src/dispatch/cli.js";
import { resolveDispatchRoute } from "../../src/dispatch/routing.js";
import { projectReviewedRepositories, shareRepositoryViewWorkspace, type DispatchRepositoryViewPlan } from "../../src/dispatch/workspace.js";
import { buildEffortEnvelope } from "../../src/review/envelopes.js";
import { loadImplementationSelectionInput } from "../../src/review/implementation-models.js";
import { createTaskWorkspace } from "../helpers/task-workspace.js";
import { realHostsEnabled, REAL_HOST_TEST_TIMEOUT_MS } from "../helpers/real-host.js";
import { cleanupTemporaryRepositories, createTempRepository } from "../helpers/temp-repository.js";

// Expected categories stay in the test process; the live reviewer receives only each design.
const cases = [
  {
    name: "many-file-copy", expected: "routine",
    artifact: "# Import approved designs\nCopy 120 Markdown design files using the supplied exact source-to-destination manifest. Create destination directories, preserve file bytes, and fail on collisions. The design specifies using the existing copy helper and manifest schema validator. Verify source/destination SHA-256 equality and run the existing link and schema checks. No transformations, new schemas, new recovery mechanisms, or undefined product behavior are required. The architecture and design decisions have already been reviewed.",
  },
  {
    name: "concurrent-cache", expected: "hard",
    artifact: "# Implement asynchronous cache consistency\nImplement a cache shared by concurrent readers, refresh operations, and invalidations. The design specifies that invalidate(key) prevents every older in-flight refresh from becoming visible, concurrent reads share one refresh, cancellation by one reader must not cancel another reader's work, and refresh failure must not poison a later read. Architecture and observable semantics are settled, but the implementation must derive the synchronization and ownership mechanism across these races; no existing helper provides it. Deterministic scheduler tests will exercise all relevant interleavings. The production code may fit in one small module.",
  },
  {
    name: "scheduler-derivation", expected: "exceptional",
    artifact: "# Derive a scheduling and recovery algorithm\nImplement a new scheduler for jobs with precedence constraints, shared resource reservations, and cancellation. Architecture fixes durable job records, leases, and the queue APIs. No known algorithm or existing helper satisfies the combined requirements: derive the allocation and reallocation procedure so weighted fairness among continuously eligible jobs coexists with deadlock freedom, reservations are reclaimed exactly once after partial worker failure, and cancellation remains correct while lease expiry and recovery interleave. Storage transactions are provided, but the cross-worker algorithm and its correctness argument remain to be derived. An executable simulator and property-based checks are required by the design.",
  },
] as const;

describe.skipIf(!realHostsEnabled())("live implementation difficulty assessment", () => {
  it("classifies mechanical volume and unresolved reasoning through the production reviewer adapter", async () => {
    const task = await createTaskWorkspace({ taskId: "live-implementation-selection", label: "live-implementation-selection" });
    const repository = createTempRepository({ label: "implementation-selection-context" });
    repository.write("README.md", "Synthetic design-assessment fixtures. All relevant implementation requirements are supplied in each phase design.\n");
    repository.commitAll("assessment context");
    const phase = parsePhaseInstanceId("phase-design-1");
    const views: DispatchRepositoryViewPlan = [{ name: "primary", member_kind: "primary", repository_root: repository.path,
      repository_identity_digest: canonicalJsonDigest({ fixture: "implementation-selection-context" }),
      commit: repository.git("rev-parse", "HEAD") as never }];
    const shared = shareRepositoryViewWorkspace(views, repository.path);
    const observations: { name: string; artifact: string; duration_ms: number; evidence: EffortSelectionV3 }[] = [];
    const config = parseConfigYaml(await readFile(new URL("../../assets/config.template.yaml", import.meta.url), "utf8"));
    const route = resolveDispatchRoute(config, "phase-design", "effort-reviewer", "claude");
    const selectionInput = await loadImplementationSelectionInput(config.implementation);
    expect(selectionInput.status).toBe("ready");
    const dispatch = createDispatchCoordinator({ authority: task.services.authority, dependencies: task.services.dependencies,
      host: "claude", repository_root: repository.path, phase_instance: phase,
      signal: new AbortController().signal, cancellation_source: "client", shared_workspace: shared });
    try {
      for (const sample of cases) {
        const envelope = parseEffortEnvelopeV3({
          schema_version: "3", instructions: EFFORT_SELECTOR_INSTRUCTIONS, policy_id: IMPLEMENTATION_AGENT_SELECTOR_POLICY_ID,
          task_id: task.taskId, phase_instance: phase, attempt: 1, artifact: sample.artifact,
          subject_digest: canonicalJsonDigest({ artifact: sample.artifact }), input_fingerprint: canonicalJsonDigest({ case: sample.name }),
          invocation_id: `live-${sample.name}`, result_id: `result-${sample.name}`,
          hazard_registry: { schema_version: "1", state: "absent", registry_digest: canonicalJsonDigest({ hazards: [] }), hazards: [] },
          repositories: projectReviewedRepositories(views), selection_input: selectionInput,
        });
        const sealed = buildEffortEnvelope(envelope);
        const started = Date.now();
        const result = await serializeDispatch(() => dispatch(route, sealed, effortSchema));
        const raw = JSON.parse(new TextDecoder().decode(result.extracted_output_bytes));
        const evidence = createEffortSelectionV3(raw, envelope, {
          adapter: route.adapter, cli_version: result.cli_version, model_family: route.family, model: route.model, effort: route.effort,
          invocation_id: envelope.invocation_id, result_id: envelope.result_id, envelope_input_digest: sealed.digest,
          observed_output_digest: sha256Bytes(result.extracted_output_bytes), route_source: { provenance: "configured" }, repositories: envelope.repositories,
        });
        observations.push({ name: sample.name, artifact: sample.artifact, duration_ms: Date.now() - started, evidence });
        console.info(`[live-selector] ${sample.name}: ${evidence.difficulty}; ${JSON.stringify(evidence.recommendation)}`);
      }
    } finally {
      const report = process.env.ARCHFLOW_IMPLEMENTATION_SELECTION_REPORT;
      if (report !== undefined) await writeFile(report, JSON.stringify({
        observed_at: new Date().toISOString(), route,
        instructions_digest: canonicalJsonDigest({ instructions: EFFORT_SELECTOR_INSTRUCTIONS }),
        output_schema_digest: canonicalJsonDigest(effortSchema), observations,
        limitation: "Three live assessments of synthetic phase designs, not an implementation capability benchmark or a complete multi-reviewer workflow.",
      }, null, 2) + "\n");
      await shared.dispose();
      task.dispose();
      cleanupTemporaryRepositories();
    }
    expect(observations.map(item => item.evidence.difficulty)).toEqual(cases.map(item => item.expected));
    expect(observations.map(item => item.evidence.recommendation)).toMatchObject([
      { status: "ready", model: "muse-spark-1.3", effort: "max" },
      { status: "ready", model: "gpt-6-astra", effort: "low" },
      { status: "ready", model: "gpt-6-astra", effort: "high" },
    ]);
  }, REAL_HOST_TEST_TIMEOUT_MS * cases.length);
});

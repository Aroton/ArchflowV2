import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

import { afterAll, describe, expect, it } from "vitest";

import { canonicalDocument, canonicalJsonDigest, gitBlobOid, parseGitOid, sha256Bytes } from "../../src/contracts/canonical.js";
import { connectionContextFactory, createInvocationContext } from "../../src/contracts/contexts.js";
import type { TaskStateV1 } from "../../src/contracts/durable-state.js";
import { parseSafeCode, parseSafeId, parseSafeInteger, parseTaskSlug } from "../../src/contracts/evidence.js";
import { computeInputFingerprint } from "../../src/contracts/fingerprints.js";
import { encodePhaseInstance, parsePositiveSafePhaseNumber } from "../../src/contracts/phase-instance.js";
import { parseRepositoryPathClaim } from "../../src/contracts/path-claims.js";
import type { ReviewEvidence } from "../../src/contracts/review.js";
import type { SecretScanner } from "../../src/contracts/secret-scan.js";
import { createToolHandlers } from "../../src/mcp/handlers/index.js";
import { createToolBoundary } from "../../src/mcp/server.js";
import { createGitRunner, preflightGit } from "../../src/repository/git.js";
import { discoverWorktree } from "../../src/repository/identity.js";
import { createAtomicWriter } from "../../src/state/atomic.js";
import { createInternalTransactionAuthority } from "../../src/state/authority.js";
import { resolvePinnedConstitution } from "../../src/state/constitution.js";
import { prepareEvidenceResult } from "../../src/state/evidence-results.js";
import { ensurePayloadParent, ensureResultDirectory } from "../../src/state/layout.js";
import { installSnapshot } from "../../src/state/snapshots.js";
import { cleanupTemporaryRepositories, createTempRepository } from "../helpers/temp-repository.js";

const TASK = parseTaskSlug("handler-adjudicate-constitution-edit");
const PHASE = encodePhaseInstance({ kind: "phase-impl", phase: parsePositiveSafePhaseNumber(15) });
const ARTIFACT = "phases/15/impl-notes.md";
const ARTIFACT_BYTES = new TextEncoder().encode("Reviewed phase implementation\n");
const CONFIG = `schema_version: "1"
roles:
  adjudicator:
    model: gpt-fixture
    effort: high
`;
const scanner: SecretScanner = {
  scan: async (candidates) => ({
    schema_version: "1", outcome: "clean", detector_set_id: parseSafeId("constitution-gate-test"),
    scanned_paths: candidates.map((candidate) => candidate.virtual_path),
  }),
};

afterAll(cleanupTemporaryRepositories);

describe("Phase 15 adjudicate constitution-edit gate", () => {
  it("returns a classified pre-dispatch gate response without fabricating success or launching a child", async () => {
    const repository = createTempRepository({ label: "handler-adjudicate-constitution-gate" });
    const workflow = readFileSync(new URL("../../assets/workflow.yaml", import.meta.url));
    const constitutionPath = ".archflow/constitution/00-process.md";
    repository.write(".archflow/workflow.yaml", workflow);
    repository.write(constitutionPath, `---
id: process
version: 1
status: active
---
Preserve explicit human review gates.
`);
    repository.write(`.archflow/tasks/${TASK}/config.yaml`, CONFIG);
    repository.write(`.archflow/tasks/${TASK}/${ARTIFACT}`, Buffer.from(ARTIFACT_BYTES));
    repository.write("tracked.txt", "base\n");
    repository.commitAll("adjudication constitution fixture");

    const context = {
      task_id: TASK, phase_instance: PHASE,
      operation: parseSafeCode("handler-adjudicate-constitution-fixture"), attempt: parseSafeInteger(1),
    } as const;
    const discovered = await discoverWorktree(createGitRunner({ cwd: repository.path }), context);
    if (!discovered.ok) throw new Error(discovered.error.code);
    const environment = await preflightGit(discovered.value, context);
    if (!environment.ok) throw new Error(environment.error.code);
    const authority = await createInternalTransactionAuthority({
      runner: discovered.value, environment: environment.value, task_id: TASK, context,
    });
    if (!authority.ok) throw new Error(authority.error.code);
    const policyBaseCommit = parseGitOid(repository.git("rev-parse", "HEAD"));
    const constitution = await resolvePinnedConstitution(discovered.value, policyBaseCommit, context);
    if (!constitution.ok) throw new Error(constitution.error.code);
    const artifactPath = parseRepositoryPathClaim(`.archflow/tasks/${TASK}/${ARTIFACT}`);
    const fingerprint = computeInputFingerprint({
      schema_version: "1", workflow_digest: sha256Bytes(workflow),
      config_digest: sha256Bytes(new TextEncoder().encode(CONFIG)), constitution_digest: constitution.value.digest,
      artifact_identities: [{ path: artifactPath, mode: "100644", oid: gitBlobOid(ARTIFACT_BYTES) }],
      upstream_identities: [], rubric_digest: canonicalJsonDigest({}), phase_instance: PHASE, declared_inputs: [],
    });
    const subjectDigest = sha256Bytes(ARTIFACT_BYTES);
    const reviewBase = {
      schema_version: "1", task_id: TASK, phase_instance: PHASE, subject_digest: subjectDigest,
      input_fingerprint: fingerprint, rubric_digest: canonicalJsonDigest({}), producer_family: "claude",
      findings: [], matched_rule_versions: [], verdict: "pass", blocking_count: 0,
    } as const;
    const reviews: readonly ReviewEvidence[] = [
      {
        ...reviewBase, step: "self_review", role: "self-review", assurance: "agent-declared",
        model_family: "claude", model: "claude-fixture", effort: "high",
      },
      {
        ...reviewBase, step: "counter_review", role: "counter-review", assurance: "server-attested",
        adapter: "codex-cli", cli_version: "0.146.0", model_family: "codex", model: "gpt-fixture", effort: "high",
        invocation_id: "counter-invocation", envelope_input_digest: "a".repeat(64) as never,
        observed_output_digest: "b".repeat(64) as never, result_id: "review-result-2",
      },
    ];
    const references = [];
    let retainedBytes = 0;
    for (const [index, evidence] of reviews.entries()) {
      const prepared = await prepareEvidenceResult({
        authority: authority.value, runner: discovered.value, result_id: parseSafeId(`review-result-${index + 1}`),
        retained_task_bytes: parseSafeInteger(retainedBytes), measured_at_revision: parseSafeInteger(7), scanner,
        value: { kind: "review", evidence },
      });
      if (!prepared.ok) throw new Error(prepared.error.code);
      await ensureResultDirectory(authority.value, prepared.value.reference.result_digest);
      for (const payload of prepared.value.prepared.payloads) {
        await ensurePayloadParent(authority.value, prepared.value.reference.result_digest, payload.target.absolute);
      }
      const installed = await installSnapshot(
        createAtomicWriter(), prepared.value.prepared, prepared.value.manifest_target,
        discovered.value.location.worktreeRoot as never,
      );
      if (!installed.ok) throw new Error(installed.error.code);
      references.push(prepared.value.reference);
      retainedBytes += prepared.value.prepared.manifest.value.accounting.result_bytes;
    }
    const state: TaskStateV1 = {
      schema_version: "1", task_id: TASK, repository_identity_digest: authority.value.repository_identity_digest,
      revision: parseSafeInteger(7), phase_instance: PHASE, step: "adjudicate", status: "running", attempt: parseSafeInteger(1),
      input_fingerprint: fingerprint, initialization_digest: canonicalJsonDigest({ fixture: "constitution-edit" }),
      config_digest: sha256Bytes(new TextEncoder().encode(CONFIG)), workflow_digest: sha256Bytes(workflow),
      constitution_digest: constitution.value.digest, policy_base_commit: policyBaseCommit,
      authoritative_results: references.sort((left, right) => left.step.localeCompare(right.step)), approvals: [], waivers: [],
    };
    writeFileSync(authority.value.state.absolute, canonicalDocument(state).bytes);

    // The immutable base remains unchanged, but the task branch now edits its pinned constitution.
    repository.write(constitutionPath, `${readFileSync(join(repository.path, constitutionPath), "utf8")}Unapproved task edit.\n`);
    const bin = join(repository.root, "bin");
    const dispatchMarker = join(repository.root, "dispatch-started");
    mkdirSync(bin);
    writeFileSync(join(bin, "codex"), `#!/usr/bin/env node
import { writeFileSync } from "node:fs";
writeFileSync(${JSON.stringify(dispatchMarker)}, "started\\n");
process.exit(99);
`);
    chmodSync(join(bin, "codex"), 0o755);
    const savedPath = process.env.PATH;
    process.env.PATH = `${bin}${savedPath === undefined ? "" : `:${savedPath}`}`;
    try {
      const connection = connectionContextFactory.captureStartup({
        connection_id: "adjudicate-constitution-gate",
        startup_repository_candidate: { working_directory: repository.path },
      }).initialize({
        client: { name: "claude-code", version: "2.1.220" }, host: "claude", protocol_version: "2025-11-25",
      });
      const invocation = createInvocationContext(connection, {
        invocation_id: "adjudicate-constitution-call",
        transport_metadata: { request_id: "adjudicate-constitution-request", operation: "tools/call" },
      }, new AbortController().signal);
      const outcome = await createToolBoundary(createToolHandlers()).invoke("archflow_adjudicate", {
        schema_version: "1", task_id: TASK, intent_id: "adjudicate-constitution-intent", expected_revision: 7,
        input_fingerprint: fingerprint, artifact_path: ARTIFACT, upstream_paths: [],
      }, invocation);

      expect(outcome).toMatchObject({
        kind: "project-result",
        result: {
          schema_version: "1", ok: false,
          error: { code: "GATE_ACTIVE", diagnostic: { parameters: { gate_kind: "constitution-edit" } } },
        },
      });
      if (outcome.kind === "project-result") expect("value" in outcome.result).toBe(false);
      expect(existsSync(dispatchMarker)).toBe(false);
      expect(JSON.parse(readFileSync(join(authority.value.task_root, "gate.json"), "utf8"))).toMatchObject({
        kind: "constitution-edit", subject_digest: subjectDigest,
      });
    } finally {
      if (savedPath === undefined) delete process.env.PATH; else process.env.PATH = savedPath;
    }
  });
});

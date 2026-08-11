import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import type { DegradedReview } from "../../src/contracts/review.js";
import { parseToolCall } from "../../src/contracts/mcp-tools.js";
import { parseRepositoryPathClaim, parseTaskPathClaim } from "../../src/contracts/path-claims.js";
import { parsePhaseInstanceId } from "../../src/contracts/phase-instance.js";
import { parseSafeCode, parseSafeId, parseSafeInteger, parseSha256Digest } from "../../src/contracts/evidence.js";
import type { SecretScanner } from "../../src/contracts/secret-scan.js";
import { stageLegacyUpgrade } from "../../src/init/legacy-upgrade.js";
import { computeCallEnvelope } from "../../src/local/call-envelope.js";
import { prepareDocumentResult, prepareImplementationResult } from "../../src/mcp/handlers/state-results.js";
import { resolveTaskPath, type ResolvedTaskPath } from "../../src/repository/paths.js";
import { buildDocumentArtifact } from "../../src/state/document-artifact.js";
import { prepareEvidenceResult } from "../../src/state/evidence-results.js";
import { buildImplementationOutput } from "../../src/state/implementation-manifest.js";
import { ensurePayloadParent, ensureResultDirectory } from "../../src/state/layout.js";
import { readRetainedResult } from "../../src/state/production.js";
import {
  captureProjectionTarget,
  installSnapshot,
  prepareProjectionPlan,
  type ProjectionSource,
} from "../../src/state/snapshots.js";
import { createAtomicWriter } from "../../src/state/atomic.js";
import { runStateTransaction, type PreparedTransaction } from "../../src/state/transaction.js";
import { createTaskWorkspace, type TaskWorkspace } from "../helpers/task-workspace.js";

// Keep the fixture detectable only after runtime assembly; never retain a secret-shaped token in
// the test source itself.
const SECRET = "ghp_" + "0123456789abcdefghijklmnopqrstuvwxyz";
const D = (character: string) => parseSha256Digest(character.repeat(64));
const PRD = parsePhaseInstanceId("prd");
const workspaces: TaskWorkspace[] = [];

afterEach(() => {
  for (const workspace of workspaces.splice(0)) workspace.dispose();
});

const detectedScanner = (counter?: { calls: number }): SecretScanner => ({
  scan: async (candidates) => {
    if (counter !== undefined) counter.calls += 1;
    const candidate = candidates[0];
    if (candidate === undefined) throw new TypeError("expected a projection candidate");
    return {
      schema_version: "1",
      outcome: "detected",
      detector_set_id: parseSafeId("secret-scan-test"),
      findings: [{
        detector_id: parseSafeId("test-secret"),
        path_class: candidate.path_class,
        virtual_path: candidate.virtual_path,
        line: parseSafeInteger(1),
        column: parseSafeInteger(1),
      }],
    };
  },
});

const unavailableScanner: SecretScanner = {
  scan: async () => ({ schema_version: "1", outcome: "unavailable", reason: parseSafeCode("scanner-unavailable") }),
};

const cleanScanner: SecretScanner = {
  scan: async (candidates) => ({
    schema_version: "1",
    outcome: "clean",
    detector_set_id: parseSafeId("secret-scan-test"),
    scanned_paths: candidates.map((candidate) => candidate.virtual_path),
  }),
};

async function workspace(label: string): Promise<TaskWorkspace> {
  const created = await createTaskWorkspace({ taskId: `secret-${label}`, label, operation: `secret-${label}` });
  workspaces.push(created);
  return created;
}

function expectSecret(result: { ok: boolean; error?: { code: string; diagnostic: { parameters: Record<string, unknown> } } }, detector = "test-secret"): void {
  expect(result).toMatchObject({
    ok: false,
    error: { code: "SECRET_DETECTED", diagnostic: { parameters: { detector_id: detector } } },
  });
}

async function sourceFor(h: TaskWorkspace, relative = "prd.md", bytes = new TextEncoder().encode("candidate\n")): Promise<ProjectionSource> {
  const claim = parseTaskPathClaim(relative);
  const target = await resolveTaskPath({
    runner: h.services.runner,
    taskId: h.taskId,
    claim,
    expectedClass: "document",
    context: h.services.authority.context,
  });
  if (!target.ok) throw new Error(target.error.code);
  writeFileSync(target.value.absolute, bytes);
  const captured = await captureProjectionTarget(target.value);
  return {
    path: target.value.repositoryRelative,
    target: target.value,
    desired: { state: "present", file_type: "regular", mode: "100644", bytes },
    authenticated_before: captured.observation,
    ...(captured.observation.state === "present" ? { rollback: captured.rollback } : {}),
    git_tracked: true,
  };
}

function durableShape(h: TaskWorkspace): unknown {
  const taskRoot = h.services.authority.task_root;
  const list = (name: string) => {
    const root = join(taskRoot, name);
    return existsSync(root) ? readdirSync(root, { recursive: true }).sort() : [];
  };
  return {
    state: readFileSync(h.services.authority.state.absolute, "utf8"),
    intents: list("intents"),
    results: list("results"),
    reviews: list("reviews"),
  };
}

describe("secret rejection propagation", () => {
  it("fails closed for both snapshot outcomes and leaves preparation durable state untouched", async () => {
    const h = await workspace("snapshots");
    const source = await sourceFor(h);
    const before = durableShape(h);
    expectSecret(await prepareProjectionPlan([source], detectedScanner(), h.root as ResolvedTaskPath));
    expectSecret(await prepareProjectionPlan([source], unavailableScanner, h.root as ResolvedTaskPath), "scanner-unavailable");
    expect(durableShape(h)).toEqual(before);
  });

  it("propagates rejection through evidence-result preparation", async () => {
    const h = await workspace("evidence");
    const review: DegradedReview = {
      schema_version: "1", task_id: h.taskId, phase_instance: "prd", step: "counter_review", role: "counter-review",
      subject_digest: D("a"), input_fingerprint: D("b"), rubric_digest: D("c"), producer_family: "claude",
      findings: [], matched_rule_versions: [], verdict: "pass", blocking_count: 0,
      assurance: "degraded", reason: "manual fallback", model_family: "codex", model: "unknown", effort: "unknown",
    };
    const before = durableShape(h);
    const result = await prepareEvidenceResult({
      authority: h.services.authority, runner: h.services.runner, result_id: parseSafeId("evidence-result"),
      retained_task_bytes: parseSafeInteger(0), measured_at_revision: h.services.state!.value.revision,
      scanner: detectedScanner(), value: { kind: "review", evidence: review },
    });
    expectSecret(result);
    expect(durableShape(h)).toEqual(before);
  });

  it("propagates rejection through document and implementation state-result paths", async () => {
    const h = await workspace("state-results");
    writeFileSync(join(h.services.authority.task_root, "prd.md"), "document\n");
    const document = await buildDocumentArtifact(h.services.runner, h.services.authority, {
      phase_instance: PRD, step: "produce", document_path: parseTaskPathClaim("prd.md"),
      declared_inputs: [], input_fingerprint: h.services.state!.value.input_fingerprint,
    });
    if (!document.ok) throw new Error(document.error.code);
    expectSecret(await prepareDocumentResult({
      services: h.services, artifact: document.value, result_id: parseSafeId("document-result"),
      retained_task_bytes: parseSafeInteger(0), measured_at_revision: h.services.state!.value.revision,
      scanner: detectedScanner(),
    }));

    const base = execFileSync("git", ["rev-parse", "HEAD"], { cwd: h.root, encoding: "utf8" }).trim() as never;
    writeFileSync(join(h.root, "README.md"), "implementation\n");
    const implementation = await buildImplementationOutput(
      h.services.dependencies, h.services.authority, h.services.state!, {
        phase_instance: PRD, step: "produce", base_commit: base,
        outputs: [parseRepositoryPathClaim("README.md")],
        restore_targets: [parseRepositoryPathClaim("README.md")],
        parent_documents: [{ document_path: parseTaskPathClaim("prd.md"), role: "prd" }],
        declared_inputs: [], input_fingerprint: h.services.state!.value.input_fingerprint,
      },
    );
    if (!implementation.ok) throw new Error(JSON.stringify(implementation.error));
    expectSecret(await prepareImplementationResult({
      services: h.services, artifact: implementation.value, result_id: parseSafeId("implementation-result"),
      retained_task_bytes: parseSafeInteger(0), measured_at_revision: h.services.state!.value.revision,
      scanner: detectedScanner(),
    }));
  });

  it("treats retry of the same rejected intent as a rerun and writes no receipt, result, or projection", async () => {
    const h = await workspace("retry");
    const counter = { calls: 0 };
    const source = await sourceFor(h, "prd.md", new TextEncoder().encode("unchanged projection\n"));
    const before = durableShape(h);
    const draft = {
      schema_version: "1" as const, task_id: h.taskId, intent_id: "same-rejected-intent",
      expected_revision: h.services.state!.value.revision,
      input_fingerprint: D("0"), phase_instance: PRD, step: "produce" as const, status: "failed" as const,
    };
    const envelope = await computeCallEnvelope(h.services, { tool: "archflow_state", input: draft });
    if (!envelope.ok) throw new Error(envelope.error.code);
    const call = parseToolCall("archflow_state", { ...draft, input_fingerprint: envelope.value.input_fingerprint });
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const result = await runStateTransaction(h.services.dependencies, { authority: h.services.authority, call }, async () => {
        const rejected = await prepareProjectionPlan([source], detectedScanner(counter), h.root as ResolvedTaskPath);
        return rejected as Awaited<ReturnType<typeof prepareProjectionPlan>> & { value?: PreparedTransaction<"archflow_state"> };
      });
      expectSecret(result);
      expect(durableShape(h)).toEqual(before);
      expect(readFileSync(source.target.absolute, "utf8")).toBe("unchanged projection\n");
    }
    expect(counter.calls).toBe(2);
  });

  it("a cut immediately before scan cannot leave a partial projection", async () => {
    const h = await workspace("pre-scan-cut");
    const source = await sourceFor(h, "prd.md", new TextEncoder().encode("prior bytes\n"));
    const before = durableShape(h);
    const cut: SecretScanner = { scan: async () => { throw new Error("cut-before-scan"); } };
    await expect(prepareProjectionPlan([source], cut, h.root as ResolvedTaskPath)).rejects.toThrow("cut-before-scan");
    expect(readFileSync(source.target.absolute, "utf8")).toBe("prior bytes\n");
    expect(durableShape(h)).toEqual(before);
  });

  it("rejects secret-bearing legacy staging before creating import projections", async () => {
    const h = await workspace("legacy");
    const source = join(h.root, ".archflow", "legacy-secret");
    mkdirSync(source, { recursive: true });
    writeFileSync(join(source, "prd.md"), `${SECRET}\n`);
    execFileSync("git", ["add", "-A"], { cwd: h.root });
    execFileSync("git", ["-c", "user.name=ArchFlow Test", "-c", "user.email=test@example.invalid", "commit", "-qm", "legacy secret fixture"], { cwd: h.root });
    const head = execFileSync("git", ["rev-parse", "HEAD"], { cwd: h.root, encoding: "utf8" }).trim();
    const taskId = "legacy-secret-destination";
    const result = await stageLegacyUpgrade({
      working_directory: h.root, source_root: source, task_id: taskId,
      policy_base_commit: head, import_baseline_commit: head, code_baseline_commit: head,
    });
    expectSecret(result, "secretlint:github");
    expect(existsSync(join(h.root, ".archflow", "tasks", taskId, "imports"))).toBe(false);
  });

  it("rescans retained payload bytes and rejects a secret-shaped generation", async () => {
    const h = await workspace("retained");
    writeFileSync(join(h.services.authority.task_root, "prd.md"), `${SECRET}\n`);
    const artifact = await buildDocumentArtifact(h.services.runner, h.services.authority, {
      phase_instance: PRD, step: "produce", document_path: parseTaskPathClaim("prd.md"),
      declared_inputs: [], input_fingerprint: h.services.state!.value.input_fingerprint,
    });
    if (!artifact.ok) throw new Error(artifact.error.code);
    const prepared = await prepareDocumentResult({
      services: h.services, artifact: artifact.value, result_id: parseSafeId("retained-secret"),
      retained_task_bytes: parseSafeInteger(0), measured_at_revision: h.services.state!.value.revision,
      scanner: cleanScanner,
    });
    if (!prepared.ok) throw new Error(prepared.error.code);
    await ensureResultDirectory(h.services.authority, prepared.value.reference.result_digest);
    for (const payload of prepared.value.prepared.payloads) {
      await ensurePayloadParent(h.services.authority, prepared.value.reference.result_digest, payload.target.absolute);
    }
    const installed = await installSnapshot(createAtomicWriter(), prepared.value.prepared, prepared.value.manifest_target, h.root as ResolvedTaskPath);
    if (!installed.ok) throw new Error(installed.error.code);
    expectSecret(await readRetainedResult(h.services.runner, h.services.authority, prepared.value.reference), "secretlint:github");
  });

});

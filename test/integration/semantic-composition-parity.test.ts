import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { parseSafeCode, parseTaskSlug } from "../../src/contracts/evidence.js";
import { parseSafeInteger } from "../../src/contracts/evidence.js";
import { canonicalDocument } from "../../src/contracts/canonical.js";
import { parseGateDecisionRecord, parseGateRequest } from "../../src/contracts/durable-gate.js";
import { computeGateContextDigest } from "../../src/contracts/fingerprints.js";
import { parsePathSafeId, parseSha256Digest } from "../../src/contracts/evidence.js";
import type { PlainJsonValue } from "../../src/contracts/plain-json.js";
import { scaffoldRepositoryAssets } from "../../src/init/assets.js";
import { stageTaskAsk } from "../../src/init/task-initialization.js";
import { runBuildRequest } from "../../src/local/build-request.js";
import { createProductionServices, type ProductionServices } from "../../src/state/production.js";
import { composeRequest } from "../../src/state/request-composition.js";
import { createTaskWorkspace } from "../helpers/task-workspace.js";

const roots: string[] = [];
const gitEnvironment: NodeJS.ProcessEnv = {
  ...process.env,
  GIT_CONFIG_GLOBAL: "/dev/null",
  GIT_CONFIG_SYSTEM: "/dev/null",
  GIT_AUTHOR_NAME: "ArchFlow Test",
  GIT_AUTHOR_EMAIL: "test@example.invalid",
  GIT_COMMITTER_NAME: "ArchFlow Test",
  GIT_COMMITTER_EMAIL: "test@example.invalid",
};

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function git(root: string, ...arguments_: readonly string[]): void {
  execFileSync("git", [...arguments_], { cwd: root, env: gitEnvironment, stdio: "ignore" });
}

async function uninitializedServices(): Promise<ProductionServices> {
  const root = mkdtempSync(join(tmpdir(), "archflow-composition-parity-"));
  roots.push(root);
  git(root, "-c", "init.defaultBranch=main", "init", "-q");
  writeFileSync(join(root, "README.md"), "repository\n");
  git(root, "add", "--", "README.md");
  git(root, "commit", "-q", "-m", "root");
  const scaffolded = await scaffoldRepositoryAssets({ working_directory: root });
  if (!scaffolded.ok) throw new Error(scaffolded.error.code);
  git(root, "add", "--", ".gitattributes", ".archflow/workflow.yaml", ".archflow/constitution", ".archflow/config.yaml");
  git(root, "commit", "-q", "-m", "policy");
  const created = await createProductionServices({
    working_directory: root,
    task_id: parseTaskSlug("composition-init"),
    operation: parseSafeCode("composition-parity"),
  });
  if (!created.ok) throw new Error(created.error.code);
  return created.value;
}

async function expectParity(services: ProductionServices, input: PlainJsonValue): Promise<void> {
  const direct = await composeRequest(services, input);
  const legacy = await runBuildRequest(services, input);
  expect(legacy.ok).toBe(direct.ok);
  if (!direct.ok || !legacy.ok) {
    expect(direct.ok ? undefined : direct.error).toEqual(legacy.ok ? undefined : legacy.error);
    return;
  }
  expect(legacy.value).toMatchObject(direct.value.envelope);
  expect(legacy.value.request).toEqual(direct.value.envelope.request);
  expect(legacy.value.request_digest).toBe(direct.value.envelope.request_digest);
  expect(legacy.value.input_fingerprint).toBe(direct.value.envelope.input_fingerprint);
  expect(legacy.value.staged === undefined).toBe(services.state === undefined);
}

describe("transport-neutral request composition parity", () => {
  it("preserves revision-zero initialization bytes while only the legacy adapter stages later requests", async () => {
    const services = await uninitializedServices();
    await expectParity(services, { kind: "initialize", intent_id: "initialize-parity" });
  });

  it("preserves document production and current-position errors across every legacy family", async () => {
    const fixture = await createTaskWorkspace({ taskId: "composition-families", label: "composition-families" });
    roots.push(fixture.root);
    writeFileSync(join(fixture.services.authority.task_root, "ask.md"), "Compose requests in process.\n");
    writeFileSync(join(fixture.services.authority.task_root, "prd.md"), "# Request composition\n");

    await expectParity(fixture.services, { kind: "produce", intent_id: "produce-parity" });
    for (const input of [
      { kind: "failed", intent_id: "failed-parity" },
      { kind: "running", step: "counter_review", intent_id: "running-parity" },
      { kind: "triage", dispositions: [], intent_id: "triage-parity" },
      { kind: "counter-review", intent_id: "review-parity" },
      { kind: "gate", summary: "Review the composed request.", intent_id: "gate-parity" },
      { kind: "advance", intent_id: "advance-parity" },
    ] satisfies PlainJsonValue[]) {
      await expectParity(fixture.services, input);
    }

    fixture.dispose();
    roots.pop();
  });

  it("composes successful failed, running, and review families from their legal positions", async () => {
    const fixture = await createTaskWorkspace({ taskId: "composition-success-families", label: "composition-success" });
    roots.push(fixture.root);
    await expectParity(fixture.services, { kind: "failed", intent_id: "failed-success-parity" });

    const initial = fixture.services.state!.value;
    const { last_transition: _transition, ...withoutTransition } = initial;
    await fixture.services.dependencies.atomic.replace(fixture.services.authority.state, canonicalDocument({
      ...withoutTransition, revision: parseSafeInteger(initial.revision + 1), status: "failed",
    }).bytes);
    let refreshed = await createProductionServices({ working_directory: fixture.root, task_id: fixture.taskId, operation: parseSafeCode("composition-running") });
    if (!refreshed.ok || refreshed.value.state === undefined) throw new Error("running parity services unavailable");
    await expectParity(refreshed.value, { kind: "running", step: "produce", intent_id: "running-success-parity" });

    await refreshed.value.dependencies.atomic.replace(refreshed.value.authority.state, canonicalDocument({
      ...refreshed.value.state.value, revision: parseSafeInteger(refreshed.value.state.value.revision + 1), status: "succeeded",
    }).bytes);
    refreshed = await createProductionServices({ working_directory: fixture.root, task_id: fixture.taskId, operation: parseSafeCode("composition-review") });
    if (!refreshed.ok || refreshed.value.state === undefined) throw new Error("review parity services unavailable");
    await expectParity(refreshed.value, { kind: "counter-review", intent_id: "review-success-parity" });

    fixture.dispose();
    roots.pop();
  });

  it("derives the pending waiver request entirely from authenticated gate archives", async () => {
    const fixture = await createTaskWorkspace({ taskId: "composition-waiver", label: "composition-waiver" });
    roots.push(fixture.root);
    const state = fixture.services.state!.value;
    const gateId = parsePathSafeId("origin-waiver-gate");
    const rule = { rule_id: "human-review", rule_version: 1 } as const;
    const scope = { operation: "review-trigger", boundary: "phase" } as const;
    const context = { constitution: "pass", failed_rules: [], uncertain_rules: [], matched_trigger_rules: [rule], uncertain_trigger_rules: [], eligible_waivers: [{ rule, scope }] } as const;
    const subject = parseSha256Digest("9".repeat(64));
    const currentEvidence = { set_digest: parseSha256Digest("a".repeat(64)), slots: [{ role: "counter-review" as const, evidence_digest: parseSha256Digest("b".repeat(64)), assurance: "server-attested" as const, producer_family: "claude" as const, reviewer_family: "codex" as const, independence: "opposite-family" as const }] };
    const request = parseGateRequest({ schema_version: "1", gate_id: gateId, intent_id: "waiver-origin-intent", request_digest: "c".repeat(64), task_id: fixture.taskId, phase_instance: state.phase_instance, summary: "Review constitution exception.", subject_digest: subject, context_digest: computeGateContextDigest("constitution-review", context), current_evidence: currentEvidence, kind: "constitution-review", context, allowed_decisions: ["approve", "revise", "reject", "waiver-requested", "cancel"], opened_at_revision: state.revision });
    const decision = parseGateDecisionRecord({ schema_version: "1", gate_id: gateId, task_id: fixture.taskId, phase_instance: state.phase_instance, kind: "constitution-review", subject_digest: subject, context_digest: request.context_digest, outcome: "decided", envelope: { schema_version: "1", gate_id: gateId, task_id: fixture.taskId, phase_instance: state.phase_instance, kind: "constitution-review", subject_digest: subject, context_digest: request.context_digest, human_provenance: { schema_version: "1", actor_class: "human", assurance: "declared-local-trace", channel: "archflow-local", decision_event_id: "waiver-origin-decision", helper_invocation_id: "waiver-origin-helper", recorded_at: "2026-08-16T12:00:00.000Z" }, payload: { decision: "waiver-requested", reason: "Request a narrow waiver.", rule, operation: "review-trigger", rationale: "The exception is bounded." } } });
    const archive = join(fixture.services.authority.task_root, "authority", "decisions", gateId);
    mkdirSync(archive, { recursive: true });
    writeFileSync(join(archive, "request.json"), canonicalDocument(request).bytes);
    writeFileSync(join(archive, "decision.json"), canonicalDocument(decision).bytes);
    const prior = state.last_transition!;
    await fixture.services.dependencies.atomic.replace(fixture.services.authority.state, canonicalDocument({ ...state, last_transition: { ...prior, tool: "archflow_gate", operation: parseSafeCode("gate"), result_id: gateId } }).bytes);
    const refreshed = await createProductionServices({ working_directory: fixture.root, task_id: fixture.taskId, operation: parseSafeCode("composition-waiver") });
    if (!refreshed.ok || refreshed.value.state === undefined) throw new Error("waiver services unavailable");
    const composed = await composeRequest(refreshed.value, { kind: "waiver", intent_id: "waiver-parity" });
    expect(composed.ok, composed.ok ? undefined : composed.error.code).toBe(true);
    if (composed.ok) expect(composed.value.envelope.request.input).toMatchObject({
      origin: { origin_gate_id: gateId, rule, scope, subject_digest: subject, current_evidence_set_digest: currentEvidence.set_digest },
      rationale: "The exception is bounded.",
    });
    fixture.dispose();
    roots.pop();
  });

  it("materializes caller-owned input once and rejects accessors before observing them", async () => {
    const services = await uninitializedServices();
    let observations = 0;
    const input = Object.defineProperty({}, "kind", {
      enumerable: true,
      get() {
        observations += 1;
        return "initialize";
      },
    });
    await expect(composeRequest(services, input as PlainJsonValue)).rejects.toThrow(/accessor properties/u);
    expect(observations).toBe(0);
  });

  it("stages exact ask bytes idempotently and refuses a different retry", async () => {
    const services = await uninitializedServices();
    const root = services.runner.location.worktreeRoot;
    const taskId = services.authority.task_id;
    const text = "Exact ask — no normalization.\n\n";
    const first = await stageTaskAsk({ working_directory: root, task_id: taskId, text });
    const retry = await stageTaskAsk({ working_directory: root, task_id: taskId, text });
    expect(first).toEqual(retry);
    expect(first).toMatchObject({ ok: true, value: { byte_count: Buffer.byteLength(text) } });
    expect(readFileSync(join(root, ".archflow", "tasks", taskId, "ask.md"), "utf8")).toBe(text);

    const collision = await stageTaskAsk({ working_directory: root, task_id: taskId, text: "different" });
    expect(collision).toMatchObject({
      ok: false,
      error: { code: "TASK_INVALID", diagnostic: { parameters: { issue_code: "task-ask-collision" } } },
    });
    expect(readFileSync(join(root, ".archflow", "tasks", taskId, "ask.md"), "utf8")).toBe(text);
  });
});

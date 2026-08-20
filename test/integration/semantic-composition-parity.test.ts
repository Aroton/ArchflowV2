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
import { derivePendingWaiverRequest } from "../../src/state/pending-waiver.js";
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

/** Composition is transport-neutral and never stages: the returned envelope is the finished call. */
async function expectComposed(services: ProductionServices, input: PlainJsonValue): Promise<void> {
  const composed = await composeRequest(services, input);
  expect(composed.ok, composed.ok ? undefined : composed.error.code).toBe(true);
  if (composed.ok) {
    expect(composed.value.envelope.request.tool).toBeDefined();
    expect(typeof composed.value.envelope.request_digest).toBe("string");
  }
}

describe("transport-neutral request composition", () => {
  it("composes the revision-zero initialization request without staging anything", async () => {
    const services = await uninitializedServices();
    const composed = await composeRequest(services, { kind: "initialize", intent_id: "initialize-composition" });
    expect(composed.ok, composed.ok ? undefined : composed.error.code).toBe(true);
    if (composed.ok) {
      expect(composed.value.envelope.request.input).toMatchObject({
        task_id: services.authority.task_id,
        phase_instance: "prd",
        expected_revision: 0,
      });
    }
  });

  it("composes document production and refuses current-position errors across every family", async () => {
    const fixture = await createTaskWorkspace({ taskId: "composition-families", label: "composition-families" });
    roots.push(fixture.root);
    writeFileSync(join(fixture.services.authority.task_root, "ask.md"), "Compose requests in process.\n");
    writeFileSync(join(fixture.services.authority.task_root, "prd.md"), "# Request composition\n");

    await expectComposed(fixture.services, { kind: "produce", intent_id: "produce-composition" });
    // From produce/running the only additional legal family is the failed record; every later
    // step, gate, and advance composes only from its own legal position.
    await expectComposed(fixture.services, { kind: "failed", intent_id: "failed-composition" });
    for (const [input, expectedCode] of [
      [{ kind: "running", step: "counter_review", intent_id: "running-refused" }, "TRANSITION_INVALID"],
      [{ kind: "triage", dispositions: [], intent_id: "triage-refused" }, "TRANSITION_INVALID"],
      [{ kind: "counter-review", intent_id: "review-refused" }, "TRANSITION_INVALID"],
      // No produce result exists yet, so the gate composer fails on the missing subject.
      [{ kind: "gate", summary: "Review the composed request.", intent_id: "gate-refused" }, "STATE_INVALID"],
      [{ kind: "advance", intent_id: "advance-refused" }, "TRANSITION_INVALID"],
    ] satisfies Readonly<[PlainJsonValue, string]>[]) {
      const composed = await composeRequest(fixture.services, input);
      expect(composed.ok, JSON.stringify(composed)).toBe(false);
      if (!composed.ok) expect(composed.error.code).toBe(expectedCode);
    }
    // The bounded gate-preview decision pair retired with its only producer: a supplied
    // preview_digest plus decision never reaches the composed request.
    const decided = await composeRequest(fixture.services, {
      kind: "gate",
      summary: "Review the composed request.",
      preview_digest: "0".repeat(64),
      decision: { choice: "approve", reason: "Retired bounded decision." },
      intent_id: "gate-decision-retired",
    });
    expect(decided.ok, JSON.stringify(decided)).toBe(false);

    fixture.dispose();
    roots.pop();
  });

  it("composes the failed record and the produce re-entry from their legal positions", async () => {
    const fixture = await createTaskWorkspace({ taskId: "composition-success-families", label: "composition-success" });
    roots.push(fixture.root);
    await expectComposed(fixture.services, { kind: "failed", intent_id: "failed-success-composition" });

    const initial = fixture.services.state!.value;
    const { last_transition: _transition, ...withoutTransition } = initial;
    await fixture.services.dependencies.atomic.replace(fixture.services.authority.state, canonicalDocument({
      ...withoutTransition, revision: parseSafeInteger(initial.revision + 1), status: "failed",
    }).bytes);
    const refreshed = await createProductionServices({ working_directory: fixture.root, task_id: fixture.taskId, operation: parseSafeCode("composition-running") });
    if (!refreshed.ok || refreshed.value.state === undefined) throw new Error("running composition services unavailable");
    await expectComposed(refreshed.value, { kind: "running", step: "produce", intent_id: "running-success-composition" });

    // The terminal counter-review record composes only once the step is running; a succeeded
    // produce alone leaves it refused.
    await refreshed.value.dependencies.atomic.replace(refreshed.value.authority.state, canonicalDocument({
      ...refreshed.value.state.value, revision: parseSafeInteger(refreshed.value.state.value.revision + 1), status: "succeeded",
    }).bytes);
    const atSucceeded = await createProductionServices({ working_directory: fixture.root, task_id: fixture.taskId, operation: parseSafeCode("composition-review") });
    if (!atSucceeded.ok || atSucceeded.value.state === undefined) throw new Error("review composition services unavailable");
    const premature = await composeRequest(atSucceeded.value, { kind: "counter-review", intent_id: "review-premature" });
    expect(premature.ok).toBe(false);
    if (!premature.ok) expect(premature.error.code).toBe("TRANSITION_INVALID");

    fixture.dispose();
    roots.pop();
  });

  it("composes a counter-review route override into the request digest while the subject fingerprint stays neutral", async () => {
    const fixture = await createTaskWorkspace({ taskId: "composition-review-dispatch", label: "composition-review-dispatch" });
    roots.push(fixture.root);
    writeFileSync(join(fixture.services.authority.task_root, "ask.md"), "Compose the review dispatch.\n");
    writeFileSync(join(fixture.services.authority.task_root, "prd.md"), "# Review dispatch\n");

    // The counter-review request composes from its running review position.
    const initial = fixture.services.state!.value;
    const { last_transition: _transition, ...withoutTransition } = initial;
    await fixture.services.dependencies.atomic.replace(fixture.services.authority.state, canonicalDocument({
      ...withoutTransition,
      revision: parseSafeInteger(initial.revision + 1),
      step: "counter_review",
      status: "running",
    }).bytes);
    const atReview = await createProductionServices({
      working_directory: fixture.root, task_id: fixture.taskId, operation: parseSafeCode("composition-review-dispatch"),
    });
    if (!atReview.ok || atReview.value.state === undefined) throw new Error("review composition services unavailable");

    const declaration = {
      reason: "codex CLI auth outage; substitute the reviewer for this dispatch",
      "counter-reviewer": { model: "gpt-5.6-outage-fallback", effort: "high" },
    } as const;
    const plain = await composeRequest(atReview.value, { kind: "counter-review", intent_id: "review-dispatch-plain" });
    expect(plain.ok, plain.ok ? undefined : plain.error.code).toBe(true);
    const substituted = await composeRequest(atReview.value, {
      kind: "counter-review", intent_id: "review-dispatch-plain", route_override: declaration,
    });
    expect(substituted.ok, substituted.ok ? undefined : substituted.error.code).toBe(true);
    if (!plain.ok || !substituted.ok) return;

    const plainInput = plain.value.envelope.request.input as Record<string, unknown>;
    const substitutedInput = substituted.value.envelope.request.input as Record<string, unknown>;
    expect(plainInput).not.toHaveProperty("route_override");
    expect(substitutedInput.route_override).toEqual(declaration);
    // The substitution is request-scoped: it changes what the call asks for, never the identity of
    // the reviewed subject.
    expect(substituted.value.envelope.request_digest).not.toBe(plain.value.envelope.request_digest);
    expect(substituted.value.envelope.input_fingerprint).toBe(plain.value.envelope.input_fingerprint);
    expect(substitutedInput.input_fingerprint).toBe(plainInput.input_fingerprint);

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
    // The waiver opens and awaits the human decision through the semantic surface; the
    // bounded preview_digest+decision pair retired with the gate-preview machinery.
    const pending = await derivePendingWaiverRequest(refreshed.value);
    if (!pending.ok) throw new Error(pending.error.code);
    const composed = await composeRequest(refreshed.value, {
      kind: "waiver",
      intent_id: "waiver-composition",
    });
    expect(composed.ok, composed.ok ? undefined : composed.error.code).toBe(true);
    if (composed.ok) expect(composed.value.envelope.request.input).toMatchObject({
      origin: { origin_gate_id: gateId, rule, scope, subject_digest: subject, current_evidence_set_digest: currentEvidence.set_digest },
      rationale: "The exception is bounded.",
    });
    // The bounded waiver decision pair retired with the gate-preview machinery: the composed
    // waiver request opens the gate and never carries preview_digest or decision.
    const decided = await composeRequest(refreshed.value, {
      kind: "waiver",
      intent_id: "waiver-decision-retired",
      preview_digest: "0".repeat(64),
      decision: { choice: "grant-exception", reason: "Retired bounded decision." },
    });
    expect(decided.ok, decided.ok ? undefined : decided.error.code).toBe(true);
    if (decided.ok) {
      const decidedInput = decided.value.envelope.request.input as Record<string, unknown>;
      expect(decidedInput).not.toHaveProperty("preview_digest");
      expect(decidedInput).not.toHaveProperty("decision");
    }
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

import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { canonicalDocument, canonicalJsonDigest } from "../../src/contracts/canonical.js";
import type { TaskStateV1 } from "../../src/contracts/durable-state.js";
import { parseSafeCode, parseSha256Digest, type Sha256Digest } from "../../src/contracts/evidence.js";
import type { InputFingerprintSubject } from "../../src/contracts/fingerprints.js";
import { parseToolCall, type ParsedToolCall } from "../../src/contracts/mcp-tools.js";
import { openDurableGate } from "../../src/state/gates.js";
import { createProductionServices } from "../../src/state/production.js";
import { readTaskConfig, readTaskState } from "../../src/state/read.js";
import { composeRequest } from "../../src/state/request-composition.js";
import {
  installSemanticReviewStub,
  semanticJourneyHarness,
} from "../helpers/semantic-journeys.js";
import { createTaskWorkspace, type TaskWorkspace } from "../helpers/task-workspace.js";

const workspaces: TaskWorkspace[] = [];
const restorers: (() => void)[] = [];

afterEach(() => {
  for (const restore of restorers.splice(0)) restore();
  for (const workspace of workspaces.splice(0)) workspace.dispose();
});

async function freshState(workspace: TaskWorkspace): Promise<TaskStateV1> {
  const read = await readTaskState(workspace.services.authority.state);
  if (read.kind !== "canonical") throw new Error("task state unavailable");
  return read.document.value;
}

function appendConfig(workspace: TaskWorkspace, line: string): void {
  const configPath = join(workspace.root, ".archflow", "tasks", String(workspace.taskId), "config.yaml");
  writeFileSync(configPath, `${readFileSync(configPath, "utf8")}${line}`);
}

function replaceConfigLine(workspace: TaskWorkspace, before: string, after: string): void {
  const configPath = join(workspace.root, ".archflow", "tasks", String(workspace.taskId), "config.yaml");
  const current = readFileSync(configPath, "utf8");
  if (!current.includes(before)) throw new Error(`config line ${before} not found`);
  writeFileSync(configPath, current.replace(before, after));
}

/**
 * The pre-cutover subject composition: the accepted subject with the recorded creation-time
 * config digest folded back in. The legacy fallback in `src/state/fingerprint.ts` computes
 * exactly this shape, so a recorded value of this form is what a pre-cutover task carries.
 */
function legacyComposition(subject: InputFingerprintSubject, configDigest: Sha256Digest): Sha256Digest {
  return canonicalJsonDigest({
    schema_version: subject.schema_version,
    workflow_digest: subject.workflow_digest,
    config_digest: configDigest,
    constitution_digest: subject.constitution_digest,
    artifact_identities: subject.artifact_identities,
    upstream_identities: subject.upstream_identities,
    rubric_digest: subject.rubric_digest,
    phase_instance: subject.phase_instance,
    declared_inputs: subject.declared_inputs,
  });
}

/** Probes the production resolver with the given call shape; the subject is the composition witness. */
async function probeResolver(
  workspace: TaskWorkspace,
  state: TaskStateV1,
  call: ParsedToolCall,
): Promise<Readonly<{ subject: InputFingerprintSubject; accepted: Sha256Digest }>> {
  const services = workspace.services;
  const config = await readTaskConfig(services.authority.config);
  if (config.kind !== "valid") throw new Error("live config unavailable");
  const resolved = await services.dependencies.resolve_input_fingerprint({
    runner: services.runner,
    authority: services.authority,
    state: canonicalDocument(state),
    call: call as never,
    live_config: config.snapshot,
    context: services.authority.context,
  });
  if (!resolved.ok) throw new Error(resolved.error.code);
  return { subject: resolved.value.subject, accepted: resolved.value.fingerprint };
}

/** A bare produce-shaped call: the synthetic reentry shape with no artifact and no declared inputs. */
function bareProduceCall(state: TaskStateV1): ParsedToolCall {
  return parseToolCall("archflow_state", {
    schema_version: "1",
    task_id: state.task_id,
    intent_id: "config-editing-probe",
    expected_revision: state.revision,
    input_fingerprint: state.input_fingerprint,
    phase_instance: state.phase_instance,
    step: "produce",
    status: "running",
  });
}

async function rewriteInputFingerprint(workspace: TaskWorkspace, fingerprint: Sha256Digest): Promise<void> {
  const read = await readTaskState(workspace.services.authority.state);
  if (read.kind !== "canonical") throw new Error("task state unavailable");
  const value = read.document.value;
  const next: TaskStateV1 = {
    ...value,
    input_fingerprint: fingerprint,
    ...(value.last_transition === undefined ? {} : {
      last_transition: { ...value.last_transition, input_fingerprint: fingerprint },
    }),
  };
  await workspace.services.dependencies.atomic.replace(workspace.services.authority.state, canonicalDocument(next).bytes);
}

function writeJourneyDocuments(workspace: TaskWorkspace): void {
  writeFileSync(join(workspace.services.authority.task_root, "ask.md"), "Describe a small semantic journey.\n");
  writeFileSync(join(workspace.services.authority.task_root, "prd.md"), "# Semantic journey\n\nThe client authors this document.\n");
}

/**
 * Config bytes that keep the PRD approval gate demanded by an approval rule: document-gate opening
 * is rule-driven, so a journey expecting the gate lists the prd subject explicitly.
 */
function prdApprovalConfig(): Uint8Array {
  return new TextEncoder().encode(`schema_version: "1"
roles:
  counter-reviewer: { model: gpt-5.6-sol, effort: xhigh }
  adjudicator: { model: gpt-5.6-sol, effort: xhigh }
approval_rules:
  subjects: [prd]
  content: []
`);
}

describe("config as an editable input", { timeout: 120_000 }, () => {
  it("accepts a mid-task config edit on the next apply, records the new baseline, and reports the field-level change", async () => {
    const workspace = await createTaskWorkspace({ taskId: "config-editing-notice", label: "config-editing-notice" });
    workspaces.push(workspace);
    restorers.push(installSemanticReviewStub(workspace.root, [[]]));
    const h = semanticJourneyHarness(workspace);
    const invocation = { skill: "archflow-prd", intent: "resume" } as const;
    writeJourneyDocuments(workspace);

    // The offer is computed before the edit; config is not part of the input fingerprint, so it
    // stays valid across the edit.
    const offered = await h.status(invocation);
    expect(offered.next_action).toMatchObject({ kind: "submit-work", expected_submission: "work-result" });

    appendConfig(workspace, "\nmax_attempts: 9\n");
    const noticed = await h.status(invocation);
    expect(noticed.config_change).toEqual([{ path: "max_attempts", after: 9 }]);

    const produced = await h.apply(invocation, offered, { kind: "work-result", outcome: "succeeded" });
    expect(produced.ok, JSON.stringify(produced)).toBe(true);
    if (!produced.ok) return;

    // The next config-observing commit establishes the edited config as the recorded baseline.
    const state = await freshState(workspace);
    expect(state.last_seen_config).toMatchObject({ max_attempts: 9 });
    const settled = await h.status(invocation);
    expect(settled.config_change).toBeUndefined();

    // A further edit reports the field-level old -> new change against that baseline.
    replaceConfigLine(workspace, "max_attempts: 9", "max_attempts: 12");
    const renoticed = await h.status(invocation);
    expect(renoticed.config_change).toEqual([{ path: "max_attempts", before: 9, after: 12 }]);
  });

  it("keeps an open gate and its recorded evidence valid across a config edit; the notice persists past the settlement commit until the next config-observing commit", async () => {
    const workspace = await createTaskWorkspace({
      taskId: "config-editing-gate", label: "config-editing-gate", configBytes: prdApprovalConfig(),
    });
    workspaces.push(workspace);
    restorers.push(installSemanticReviewStub(workspace.root, [[]]));
    const h = semanticJourneyHarness(workspace);
    const invocation = { skill: "archflow-prd", intent: "resume" } as const;
    writeJourneyDocuments(workspace);

    let view = await h.status(invocation);
    let stepped = await h.apply(invocation, view, { kind: "work-result", outcome: "succeeded" });
    expect(stepped.ok, JSON.stringify(stepped)).toBe(true);
    if (!stepped.ok) return;
    stepped = await h.apply(invocation, stepped.value);
    expect(stepped.ok, JSON.stringify(stepped)).toBe(true);
    if (!stepped.ok) return;
    view = stepped.value;
    expect(view.next_action).toMatchObject({ kind: "decide", expected_submission: "gate-summary" });
    const opened = await h.apply(invocation, view, { kind: "gate-summary", summary: "The PRD is ready for approval." });
    expect(opened.ok, JSON.stringify(opened)).toBe(true);
    if (!opened.ok) return;
    expect(opened.value.next_action).toMatchObject({ kind: "decide", expected_submission: "decision" });

    // Counter-review evidence is recorded and the gate is open; the edit invalidates neither.
    const beforeEdit = await freshState(workspace);
    expect(beforeEdit.open_gate).toBeDefined();
    expect(beforeEdit.authoritative_results.length).toBeGreaterThan(0);
    appendConfig(workspace, "\nmax_attempts: 7\n");
    const noticed = await h.status(invocation);
    expect(noticed.next_action).toMatchObject({ kind: "decide", expected_submission: "decision" });
    expect(noticed.config_change).toEqual([{ path: "max_attempts", after: 7 }]);

    // The gate resolves against the same recorded evidence despite the edit.
    const decided = await h.apply(invocation, opened.value, { kind: "decision", choice: "approve", reason: "The requirements are correct." });
    expect(decided.ok, JSON.stringify(decided)).toBe(true);
    if (!decided.ok) return;
    const settledState = await freshState(workspace);
    expect(settledState.open_gate).toBeUndefined();
    expect(settledState.approvals).toHaveLength(1);

    // The settlement commit never reads config, so it deliberately leaves the baseline alone:
    // the change notice persists until the next config-observing commit.
    expect(settledState.last_seen_config).not.toMatchObject({ max_attempts: 7 });
    const afterSettlement = await h.status(invocation);
    expect(afterSettlement.config_change).toEqual([{ path: "max_attempts", after: 7 }]);

    // The successor hand-off at the design tier is the next config-observing commit; it clears
    // the notice and records the edited config as the new baseline.
    const design = { skill: "archflow-design", intent: "resume" } as const;
    const successor = await h.status(design);
    expect(successor.next_action).toMatchObject({ kind: "start-next-skill", expected_submission: "none" });
    const started = await h.apply(design, successor);
    expect(started.ok, JSON.stringify(started)).toBe(true);
    if (!started.ok) return;
    const cleared = await h.status(design);
    expect(cleared.config_change).toBeUndefined();
    const finalState = await freshState(workspace);
    expect(finalState.last_seen_config).toMatchObject({ max_attempts: 7 });
  });

  it("keeps a legacy-recorded fingerprint transacting after the cutover, preserves its composition on the same-shape path, and converges at the gate-reentry landing", async () => {
    const workspace = await createTaskWorkspace({
      taskId: "config-editing-legacy", label: "config-editing-legacy", configBytes: prdApprovalConfig(),
    });
    workspaces.push(workspace);
    restorers.push(installSemanticReviewStub(workspace.root, [[]]));
    const h = semanticJourneyHarness(workspace);
    const invocation = { skill: "archflow-prd", intent: "resume" } as const;
    writeJourneyDocuments(workspace);

    // Recreate a pre-cutover task at its produce boundary: the recorded fingerprint is the legacy
    // composition over the produce call's subject (the document artifact's declared inputs are
    // part of that subject), and the live config has been edited since creation.
    const initial = await freshState(workspace);
    const shape = await composeRequest(workspace.services, { intent_id: "config-editing-legacy-probe", kind: "produce" });
    if (!shape.ok) throw new Error(shape.error.code);
    const shapeProbe = await probeResolver(workspace, initial, parseToolCall("archflow_state", shape.value.envelope.request.input));
    const legacyProduce = legacyComposition(shapeProbe.subject, initial.config_digest);
    expect(shapeProbe.accepted).not.toBe(legacyProduce);
    appendConfig(workspace, "\nmax_attempts: 5\n");
    await rewriteInputFingerprint(workspace, legacyProduce);

    // The ordinary kernel path transacts without mismatch: the envelope and the kernel both
    // supply the recorded fingerprint as the expected digest and the legacy fallback accepts it,
    // even though the live config bytes no longer match the creation-time digest.
    const offered = await h.status(invocation);
    expect(offered.next_action).toMatchObject({ kind: "submit-work", expected_submission: "work-result" });
    const produced = await h.apply(invocation, offered, { kind: "work-result", outcome: "succeeded" });
    expect(produced.ok, JSON.stringify(produced)).toBe(true);
    if (!produced.ok) return;
    const afterProduce = await freshState(workspace);
    expect(afterProduce.input_fingerprint).toBe(legacyProduce);
    expect(afterProduce.last_seen_config).toMatchObject({ max_attempts: 5 });

    // The review and gate cycles keep transacting on the same durable continuity.
    let stepped = await h.apply(invocation, produced.value);
    expect(stepped.ok, JSON.stringify(stepped)).toBe(true);
    if (!stepped.ok) return;
    expect(stepped.value.next_action).toMatchObject({ kind: "decide", expected_submission: "gate-summary" });
    const opened = await h.apply(invocation, stepped.value, { kind: "gate-summary", summary: "The PRD needs another revision pass." });
    expect(opened.ok, JSON.stringify(opened)).toBe(true);
    if (!opened.ok) return;
    const beforeDecision = await freshState(workspace);
    expect(beforeDecision.open_gate).toBeDefined();

    // The request-changes decision archives the revise choice; the following revise apply enters
    // the authorized reentry through the gate-reentry computation, which omits the expected
    // digest and writes the recomputed new composition; the evidence continuity pair records the
    // pre-decision fingerprint as the predecessor.
    const revised = await h.apply(invocation, opened.value, { kind: "decision", choice: "request-changes", reason: "The requirements need sharper success criteria." });
    expect(revised.ok, JSON.stringify(revised)).toBe(true);
    if (!revised.ok) return;
    expect(revised.value.next_action).toMatchObject({ kind: "revise" });
    const entered = await h.apply(invocation, revised.value);
    expect(entered.ok, JSON.stringify(entered)).toBe(true);
    if (!entered.ok) return;
    const landed = await freshState(workspace);
    expect(landed.input_fingerprint).not.toBe(beforeDecision.input_fingerprint);
    expect(landed.pending_human_revision?.predecessor_input_fingerprint).toBe(beforeDecision.input_fingerprint);
    // The reentry landing uses the bare synthetic produce shape; its recomputation is the new
    // composition over exactly that subject.
    const landedProbe = await probeResolver(workspace, landed, bareProduceCall(landed));
    expect(landed.input_fingerprint).toBe(landedProbe.accepted);

    // Replay validation after the cutover: a reentry that landed while the legacy composition was
    // still recorded (simulated by restoring the legacy value over the same landing shape) still
    // replays, because the replay seam supplies the recorded fingerprint as the expected digest
    // and the legacy fallback accepts it.
    const legacyLanding = legacyComposition(landedProbe.subject, landed.config_digest);
    expect(legacyLanding).not.toBe(landed.input_fingerprint);
    await rewriteInputFingerprint(workspace, legacyLanding);
    const replayServices = await createProductionServices({
      working_directory: workspace.root,
      task_id: workspace.taskId,
      operation: parseSafeCode("config-editing-replay"),
    });
    if (!replayServices.ok || replayServices.value.state === undefined) throw new Error("replay services unavailable");
    const gateId = landed.pending_human_revision?.gate_id;
    if (gateId === undefined) throw new Error("reentry gate id unavailable");
    const request = JSON.parse(readFileSync(
      join(workspace.root, ".archflow", "tasks", String(workspace.taskId), "authority", "decisions", String(gateId), "request.json"),
      "utf8",
    ));
    const replay = await openDurableGate(replayServices.value.dependencies, {
      authority: replayServices.value.authority,
      expected_revision: request.opened_at_revision,
      intent_id: request.intent_id,
      request_digest: parseSha256Digest(request.request_digest),
      input_fingerprint: legacyLanding,
      phase_instance: request.phase_instance,
      summary: request.summary,
      subject_digest: parseSha256Digest(request.subject_digest),
      current_evidence: request.current_evidence,
      kind: request.kind,
      context: request.context,
    });
    expect(replay.ok, JSON.stringify(replay)).toBe(true);
    if (replay.ok) expect(replay.value.replay).toBeDefined();
  });
});

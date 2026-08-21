import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { canonicalDocument, sha256Bytes } from "../../src/contracts/canonical.js";
import { connectionContextFactory, createInvocationContext } from "../../src/contracts/contexts.js";
import { parseToolCall } from "../../src/contracts/mcp-tools.js";
import { parseSafeCode, parseSafeInteger } from "../../src/contracts/evidence.js";
import { handleState } from "../../src/mcp/handlers/state.js";
import { createProductionServices } from "../../src/state/production.js";
import { readTaskState } from "../../src/state/read.js";
import { composeRequest } from "../../src/state/request-composition.js";
import { installSemanticReviewStub, semanticJourneyHarness } from "../helpers/semantic-journeys.js";
import {
  createTaskWorkspace,
  legacyHumanAuthorityConstitutionV1Bytes,
  type TaskWorkspace,
} from "../helpers/task-workspace.js";

const workspaces: TaskWorkspace[] = [];
afterEach(() => { for (const workspace of workspaces.splice(0)) workspace.dispose(); });
const restorers: (() => void)[] = [];
afterEach(() => { for (const restore of restorers.splice(0)) restore(); });

// The re-settle journey drives real review dispatches through the semantic harness.
const TIMEOUT = 60_000;

function invocation(root: string, id: string) {
  const connection = connectionContextFactory.captureStartup({
    connection_id: `connection-${id}`,
    startup_repository_candidate: { working_directory: root },
  }).initialize({ client: { name: "Codex", version: "1" }, host: "codex", protocol_version: "2025-11-25" });
  return createInvocationContext(connection, {
    invocation_id: `invocation-${id}`,
    transport_metadata: { request_id: `request-${id}`, operation: "tools/call" },
  }, new AbortController().signal);
}

describe("planning restart state handler", () => {
  it("rejects stale calls without editing ask, restarts once, and authenticates exact replay", async () => {
    const workspace = await createTaskWorkspace({ taskId: "restart-handler", label: "restart-handler" });
    workspaces.push(workspace);
    const askPath = join(workspace.root, ".archflow", "tasks", String(workspace.taskId), "ask.md");
    writeFileSync(askPath, "Original ask\n");
    const originalAsk = readFileSync(askPath);
    const source = workspace.services.state!.value;
    const { last_transition: _lastTransition, ...sourceWithoutTransition } = source;
    const prepared = canonicalDocument({
      ...sourceWithoutTransition,
      revision: parseSafeInteger(10),
      phase_instance: "phase-impl-2",
      step: "triage",
      status: "succeeded",
      attempt: parseSafeInteger(1),
      planned_final_phase: parseSafeInteger(2),
      authoritative_results: [],
      approvals: [],
      waivers: [],
    });
    await workspace.services.dependencies.atomic.replace(workspace.services.authority.state, prepared.bytes);
    const servicesResult = await createProductionServices({ working_directory: workspace.root, task_id: workspace.taskId, operation: parseSafeCode("restart-test") });
    if (!servicesResult.ok || servicesResult.value.state === undefined) throw new Error("services unavailable");
    const services = servicesResult.value;
    const base = {
      schema_version: "1" as const,
      task_id: workspace.taskId,
      expected_revision: 10,
      input_fingerprint: "0".repeat(64),
      phase_instance: "phase-impl-2" as const,
      step: "produce" as const,
      status: "running" as const,
      operation: "planning_restart" as const,
      target_phase_instance: "prd" as const,
      reason: "Reconsider the public API boundary.",
      ask_base_digest: sha256Bytes(originalAsk),
    };
    const composed = await composeRequest(services, {
      kind: "planning-restart",
      intent_id: "restart-first",
      invocation: { skill: "archflow-prd", intent: "reopen" },
      reason: base.reason,
    });
    if (!composed.ok) throw new Error(composed.error.code);
    const envelope = composed.value.envelope;
    expect(envelope.request.input).toMatchObject({
      target_phase_instance: "prd",
      reason: base.reason,
      ask_base_digest: base.ask_base_digest,
    });

    const stale = parseToolCall("archflow_state", { ...base, intent_id: "restart-stale", expected_revision: 9, input_fingerprint: envelope.input_fingerprint });
    const staleResult = await handleState(stale, invocation(workspace.root, "stale"));
    expect(staleResult.ok).toBe(false);
    expect(readFileSync(askPath)).toEqual(originalAsk);

    const call = parseToolCall("archflow_state", envelope.request.input);
    const result = await handleState(call, invocation(workspace.root, "first"));
    expect(result.ok, JSON.stringify(result)).toBe(true);
    const appendedAsk = readFileSync(askPath);
    expect(appendedAsk.subarray(0, originalAsk.byteLength)).toEqual(originalAsk);
    expect(appendedAsk.toString("utf8")).toContain(base.reason);

    const replay = parseToolCall("archflow_state", { ...base, intent_id: "restart-replay", input_fingerprint: envelope.input_fingerprint });
    const replayResult = await handleState(replay, invocation(workspace.root, "replay"));
    expect(replayResult.ok).toBe(true);
    expect(readFileSync(askPath)).toEqual(appendedAsk);

    writeFileSync(askPath, Buffer.concat([appendedAsk, Buffer.from("unrelated tail\n")]));
    const changedAskReplay = await handleState(replay, invocation(workspace.root, "changed-ask"));
    expect(changedAskReplay.ok).toBe(false);
    writeFileSync(askPath, appendedAsk);

    const after = await createProductionServices({ working_directory: workspace.root, task_id: workspace.taskId, operation: parseSafeCode("restart-after") });
    if (!after.ok || after.value.state === undefined) throw new Error("restarted state unavailable");
    await after.value.dependencies.atomic.replace(after.value.authority.state, canonicalDocument({
      ...after.value.state.value,
      revision: parseSafeInteger(after.value.state.value.revision + 1),
    }).bytes);
    const lateReplay = await handleState(replay, invocation(workspace.root, "late"));
    expect(lateReplay.ok).toBe(false);
  });

  it("re-settles a design rule evaluation across an exact planning restart at a fresh revision", async () => {
    // A rule-less config records wait:false for every document subject while an explicit legacy-v1
    // constitution fixture still requires human approval. A planning restart back to design (the target that
    // leaves ask.md untouched, so the re-production is byte-identical down to its git input
    // identities) makes the first design settlement ineligible across the restart cutoff, and the
    // identical re-production re-settles the same (phase_instance, subject_digest) at a new
    // revision: the triple sorted-set key holds both entries while the human gate remains required.
    const workspace = await createTaskWorkspace({
      taskId: "restart-rule-resettle",
      label: "restart-rule-resettle",
      constitutionBytes: legacyHumanAuthorityConstitutionV1Bytes(),
      configBytes: new TextEncoder().encode(`schema_version: "1"
roles:
  counter-reviewer: { model: gpt-5.6-sol, effort: xhigh }
  adjudicator: { model: gpt-5.6-sol, effort: xhigh }
`),
    });
    workspaces.push(workspace);
    restorers.push(installSemanticReviewStub(workspace.root, [[]]));
    const h = semanticJourneyHarness(workspace);
    const prd = { skill: "archflow-prd", intent: "resume" } as const;
    const design = { skill: "archflow-design", intent: "resume" } as const;
    writeFileSync(join(workspace.services.authority.task_root, "ask.md"), "Describe an exact restart journey.\n");
    writeFileSync(join(workspace.services.authority.task_root, "prd.md"), "# Semantic journey\n\nThe client authors this document.\n");

    async function stateValue() {
      const read = await readTaskState(workspace.services.authority.state);
      if (read.kind !== "canonical") throw new Error("task state unavailable");
      return read.document.value;
    }

    let result = await h.apply(prd, await h.status(prd), { kind: "work-result", outcome: "succeeded" });
    expect(result.ok, JSON.stringify(result)).toBe(true);
    if (!result.ok) return;
    result = await h.apply(prd, result.value);
    expect(result.ok, JSON.stringify(result)).toBe(true);
    if (!result.ok) return;
    const prdSettled = await stateValue();
    const prdReceipt = prdSettled.rule_settlements?.find((entry) => entry.phase_instance === "prd");
    if (prdReceipt === undefined) throw new Error("prd receipt unavailable");
    expect(result.value.next_action).toMatchObject({ kind: "decide", expected_submission: "gate-summary" });
    result = await h.apply(prd, result.value, {
      kind: "gate-summary", summary: "The rule result is recorded; the PRD still needs approval.",
    });
    expect(result.ok, JSON.stringify(result)).toBe(true);
    if (!result.ok) return;
    result = await h.apply(prd, result.value, {
      kind: "decision", choice: "approve", reason: "The requirements are correct.",
    });
    expect(result.ok, JSON.stringify(result)).toBe(true);
    if (!result.ok) return;

    let designResult = await h.apply(design, await h.status(design));
    expect(designResult.ok, JSON.stringify(designResult)).toBe(true);
    if (!designResult.ok) return;
    const designResource = designResult.value.resources.find((resource) => resource.role === "current-artifact");
    if (designResource === undefined) throw new Error("design resource unavailable");
    writeFileSync(join(workspace.root, designResource.path), "# Design\n\n### Phase 1: Implement the verified behavior\n");
    designResult = await h.apply(design, designResult.value, { kind: "work-result", outcome: "succeeded" });
    expect(designResult.ok, JSON.stringify(designResult)).toBe(true);
    if (!designResult.ok) return;
    designResult = await h.apply(design, designResult.value);
    expect(designResult.ok, JSON.stringify(designResult)).toBe(true);
    if (!designResult.ok) return;
    expect(designResult.value.next_action).toMatchObject({ kind: "decide", expected_submission: "gate-summary" });
    const firstSettle = await stateValue();
    const firstReceipt = firstSettle.rule_settlements?.find((entry) => entry.phase_instance === "design");
    if (firstReceipt === undefined) throw new Error("pre-restart design receipt unavailable");

    // Restart from a later phase exactly as the replay suite stages it, preserving the receipts.
    const { last_transition: _ignored, ...forward } = firstSettle;
    await workspace.services.dependencies.atomic.replace(workspace.services.authority.state, canonicalDocument({
      ...forward,
      revision: parseSafeInteger(firstSettle.revision + 1),
      phase_instance: "phase-impl-2",
      step: "triage",
      status: "succeeded",
      attempt: parseSafeInteger(1),
      planned_final_phase: parseSafeInteger(2),
      authoritative_results: [],
      approvals: [],
      waivers: [],
    }).bytes);
    const restartServices = await createProductionServices({
      working_directory: workspace.root,
      task_id: workspace.taskId,
      operation: parseSafeCode("restart-rule-compose"),
    });
    if (!restartServices.ok) throw new Error(restartServices.error.code);
    const composed = await composeRequest(restartServices.value, {
      kind: "planning-restart",
      intent_id: "restart-rule-resettle",
      invocation: { skill: "archflow-design", intent: "reopen" },
      reason: "Reconsider the architecture boundary.",
    });
    if (!composed.ok) throw new Error(composed.error.code);
    const restartedCall = await handleState(
      parseToolCall("archflow_state", composed.value.envelope.request.input),
      invocation(workspace.root, "rule-resettle"),
    );
    expect(restartedCall.ok, JSON.stringify(restartedCall)).toBe(true);

    const afterRestart = await stateValue();
    expect(afterRestart).toMatchObject({ phase_instance: "design", step: "produce", status: "running" });
    // Settlements survive the restart verbatim, but the reconsideration window owns the workflow.
    expect(afterRestart.rule_settlements).toContainEqual(firstReceipt);
    expect(afterRestart.rule_settlements).toContainEqual(prdReceipt);
    const window = await h.status(design);
    expect(window.next_action).not.toMatchObject({ kind: "commit" });
    expect(window.next_action).toMatchObject({ kind: "submit-work", expected_submission: "work-result" });

    // Byte-identical re-production: the design document is untouched, so the re-settle mints the
    // fresh settlement for the same pair at the new revision and human approval is requested again.
    let resumed = await h.apply(design, window, { kind: "work-result", outcome: "succeeded" });
    expect(resumed.ok, JSON.stringify(resumed)).toBe(true);
    if (!resumed.ok) return;
    resumed = await h.apply(design, resumed.value);
    expect(resumed.ok, JSON.stringify(resumed)).toBe(true);
    if (!resumed.ok) return;
    expect(resumed.value.next_action).toMatchObject({ kind: "decide", expected_submission: "gate-summary" });
    const resettle = await stateValue();
    const designReceipts = resettle.rule_settlements?.filter((entry) => entry.phase_instance === "design");
    if (designReceipts === undefined || designReceipts.length !== 2) {
      throw new Error("re-settled design receipts unavailable");
    }
    expect(designReceipts[0]).toEqual(firstReceipt);
    expect(designReceipts[1]).toMatchObject({
      task_id: workspace.taskId,
      phase_instance: "design",
      step: "triage",
      subject_digest: firstReceipt.subject_digest,
      conclusion: { wait: false, match: null },
      config_digest: sha256Bytes(readFileSync(workspace.services.authority.config.absolute)),
      settled_at_revision: resettle.revision,
    });
    expect(designReceipts[1]!.settled_at_revision).toBeGreaterThan(firstReceipt.settled_at_revision);
    expect(resettle.rule_settlements).toContainEqual(prdReceipt);
  }, TIMEOUT);
});

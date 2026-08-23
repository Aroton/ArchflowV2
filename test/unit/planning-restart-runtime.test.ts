import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { sha256Bytes } from "../../src/contracts/canonical.js";
import type { PlanningRestartRecord, TaskStateV1 } from "../../src/contracts/durable-state.js";
import {
  parsePathSafeId,
  parseSafeId,
  parseSafeInteger,
  parseSha256Digest,
  parseTaskSlug,
} from "../../src/contracts/evidence.js";
import { parsePhaseInstanceId } from "../../src/contracts/phase-instance.js";
import { createAtomicWriter } from "../../src/state/atomic.js";
import { installPlanningRestartAskAppend } from "../../src/state/phase-documents.js";
import { retainedResultReferences } from "../../src/state/retained-result-graph.js";
import {
  approvalIsEligibleAfterLatestRestart,
  isExactMilestoneRecoveryDraft,
  isExactPlanningRestartDraft,
  latestAuthorityCutoffRevision,
  latestRestartRevisionAffectingPhase,
} from "../../src/state/restart-authority.js";
import { planPlanningRestart } from "../../src/state/transitions.js";

const temporaryRoots: string[] = [];
afterEach(async () => {
  await Promise.all(temporaryRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

const D = (value: string) => parseSha256Digest(value.repeat(64));
const reference = (phase: string, step: "produce" | "counter_review", digit: string) => ({
  phase_instance: parsePhaseInstanceId(phase),
  step,
  result_digest: D(digit),
  result_id: parseSafeId(`result-${digit}`),
  input_fingerprint: D("f"),
});

function provenance(): PlanningRestartRecord["human_provenance"] {
  return {
    schema_version: "1",
    actor_class: "human",
    assurance: "declared-local-trace",
    channel: "connected-host",
    decision_event_id: parseSafeId("restart-decision"),
    connection_id: parseSafeId("connection-1"),
    request_id_digest: D("e"),
    recorded_at: "2026-08-16T12:00:00.000Z",
  };
}

function state(overrides: Partial<TaskStateV1> = {}): TaskStateV1 {
  return {
    schema_version: "1",
    task_id: parseTaskSlug("task-1"),
    repository_identity_digest: D("1"),
    revision: parseSafeInteger(20),
    phase_instance: parsePhaseInstanceId("phase-impl-2"),
    step: "triage",
    status: "succeeded",
    attempt: parseSafeInteger(3),
    input_fingerprint: D("2"),
    initialization_digest: D("3"),
    config_digest: D("4"),
    workflow_digest: D("5"),
    constitution_digest: D("6"),
    policy_base_commit: "abcdef0123456789abcdef0123456789abcdef01" as TaskStateV1["policy_base_commit"],
    authoritative_results: [
      reference("prd", "produce", "7"),
      reference("design", "produce", "8"),
      reference("phase-design-1", "produce", "9"),
      reference("phase-impl-1", "produce", "a"),
      reference("phase-design-2", "produce", "b"),
      reference("phase-impl-2", "produce", "c"),
    ],
    approvals: [],
    waivers: [],
    planned_final_phase: parseSafeInteger(3),
    ...overrides,
  };
}

describe("planning restart runtime", () => {
  it("archives target-and-downstream authority and lands at attempt one", () => {
    const current = state();
    const planned = planPlanningRestart({
      current,
      restart_id: parsePathSafeId("restart-1"),
      target_phase_instance: parsePhaseInstanceId("phase-design-1"),
      reason: "Change the phase-one boundary.",
      recomputed_input_fingerprint: D("d"),
      human_provenance: provenance(),
    });
    expect(planned.ok).toBe(true);
    if (!planned.ok) return;
    expect(planned.value).toMatchObject({
      phase_instance: "phase-design-1", step: "produce", status: "running", attempt: 1,
      input_fingerprint: D("d"), planned_final_phase: 3, waivers: [],
    });
    expect(planned.value.authoritative_results.map((item) => item.phase_instance)).toEqual(["prd", "design"]);
    expect(planned.value.restart_history?.[0]?.superseded_results.map((item) => item.phase_instance)).toEqual([
      "phase-design-1", "phase-impl-1", "phase-design-2", "phase-impl-2",
    ]);
    expect(isExactPlanningRestartDraft(current, planned.value)).toBe(true);
    expect(isExactPlanningRestartDraft(current, {
      ...planned.value,
      human_revision_history: [],
    })).toBe(false);
  });

  it("clears final-phase planning only for PRD and design targets", () => {
    for (const target of ["prd", "design"] as const) {
      const planned = planPlanningRestart({
        current: state(), restart_id: parsePathSafeId(`restart-${target}`),
        target_phase_instance: parsePhaseInstanceId(target), reason: "Replan.",
        recomputed_input_fingerprint: D("d"), human_provenance: provenance(),
      });
      expect(planned.ok && planned.value.planned_final_phase, target).toBeUndefined();
    }
  });

  it("refuses same, forward, implementation, blank, gated, and terminal restarts", () => {
    const cases = [
      { target: "phase-impl-2", current: state() },
      { target: "phase-design-3", current: state() },
      { target: "phase-impl-1", current: state() },
      { target: "design", current: state({ terminal: "complete" }) },
    ];
    for (const [index, item] of cases.entries()) {
      const result = planPlanningRestart({
        current: item.current, restart_id: parsePathSafeId(`restart-invalid-${index}`),
        target_phase_instance: parsePhaseInstanceId(item.target), reason: "Replan.",
        recomputed_input_fingerprint: D("d"), human_provenance: provenance(),
      });
      expect(result.ok, item.target).toBe(false);
    }
    const blank = planPlanningRestart({
      current: state(), restart_id: parsePathSafeId("restart-blank"),
      target_phase_instance: parsePhaseInstanceId("design"), reason: " \n ",
      recomputed_input_fingerprint: D("d"), human_provenance: provenance(),
    });
    expect(blank.ok).toBe(false);
  });

  it("deduplicates every active, revision, and restart-history retained root by digest", () => {
    const shared = reference("design", "counter_review", "e");
    const current = state({
      authoritative_results: [shared],
      pending_human_revision: {
        gate_id: parsePathSafeId("gate-1"), gate_kind: "design-approval",
        predecessor_subject_digest: D("1"), predecessor_input_fingerprint: D("2"),
        requested_at_revision: parseSafeInteger(10), attempt: parseSafeInteger(2), evidence: [shared],
      },
      restart_history: [{
        restart_id: parsePathSafeId("restart-history"), source_phase_instance: parsePhaseInstanceId("phase-impl-2"),
        target_phase_instance: parsePhaseInstanceId("design"), reason: "Earlier restart.",
        restarted_at_revision: parseSafeInteger(12), superseded_results: [shared], cleared_waivers: [],
        human_provenance: provenance(),
      }],
    });
    expect(retainedResultReferences(current)).toEqual([shared]);
  });

  it("cuts off approvals at the latest restart affecting their producer phase", () => {
    const current = state({ restart_history: [{
      restart_id: parsePathSafeId("restart-cutoff"), source_phase_instance: parsePhaseInstanceId("phase-impl-2"),
      target_phase_instance: parsePhaseInstanceId("phase-design-1"), reason: "Replan phase one.",
      restarted_at_revision: parseSafeInteger(15), superseded_results: [], cleared_waivers: [],
      human_provenance: provenance(),
    }] });
    expect(latestRestartRevisionAffectingPhase(current, parsePhaseInstanceId("design"))).toBeUndefined();
    expect(latestRestartRevisionAffectingPhase(current, parsePhaseInstanceId("phase-impl-1"))).toBe(15);
    const approval = {
      gate_id: parsePathSafeId("gate-approval"), gate_kind: "commit-authorization" as const,
      subject_digest: D("a"), decision_digest: D("b"), resolved_at_revision: parseSafeInteger(15),
    };
    expect(approvalIsEligibleAfterLatestRestart(current, approval, parsePhaseInstanceId("phase-impl-1"))).toBe(false);
    expect(approvalIsEligibleAfterLatestRestart(current, { ...approval, resolved_at_revision: parseSafeInteger(16) }, parsePhaseInstanceId("phase-impl-1"))).toBe(true);
  });

  it("validates same-position milestone recovery and cuts off older authority", () => {
    const current = state();
    const superseded = current.authoritative_results.filter((item) => item.phase_instance === current.phase_instance);
    const recovery = {
      recovery_id: parsePathSafeId("recovery-1"),
      phase_instance: current.phase_instance,
      cause: "milestone-proof-missing" as const,
      target_ref: "refs/heads/main",
      target_head: current.policy_base_commit,
      subject_digest: D("a"),
      recovered_at_revision: parseSafeInteger(current.revision + 1),
      superseded_results: superseded,
      cleared_waivers: current.waivers,
    };
    const { revision: _revision, last_transition: _transition, ...base } = current;
    const next = {
      ...base,
      step: "produce" as const,
      status: "running" as const,
      attempt: parseSafeInteger(1),
      input_fingerprint: D("d"),
      authoritative_results: current.authoritative_results.filter((item) => item.phase_instance !== current.phase_instance),
      waivers: [],
      milestone_recovery_history: [recovery],
    };
    expect(isExactMilestoneRecoveryDraft(current, next)).toBe(true);
    expect(latestAuthorityCutoffRevision({ ...next, revision: parseSafeInteger(21) }, current.phase_instance)).toBe(21);
    expect(approvalIsEligibleAfterLatestRestart(
      { ...next, revision: parseSafeInteger(21) },
      { gate_id: parsePathSafeId("gate-old"), gate_kind: "commit-authorization", subject_digest: D("b"), decision_digest: D("c"), resolved_at_revision: parseSafeInteger(20) },
      current.phase_instance,
    )).toBe(false);
    expect(isExactMilestoneRecoveryDraft(current, { ...next, authoritative_results: current.authoritative_results })).toBe(false);
  });

  it("installs one operation-bound PRD correction and authenticates exact retry", async () => {
    const root = await mkdtemp(join(tmpdir(), "archflow-restart-"));
    temporaryRoots.push(root);
    const path = join(root, "ask.md");
    const original = new TextEncoder().encode("Original ask without trailing newline");
    await writeFile(path, original);
    const input = {
      target: { absolute: path, path_class: "task-ask" } as never,
      expected_base_digest: sha256Bytes(original), restart_id: parsePathSafeId("restart-ask"),
      request: "  Preserve Unicode: café\n## Embedded heading\n  ",
    };
    const first = await installPlanningRestartAskAppend(createAtomicWriter(), input);
    const bytes = new Uint8Array(await readFile(path));
    const second = await installPlanningRestartAskAppend(createAtomicWriter(), input);
    expect(first.status).toBe("appended");
    expect(second.status).toBe("replayed");
    expect(new TextDecoder().decode(bytes)).toContain(input.request);
    expect(new Uint8Array(await readFile(path))).toEqual(bytes);
    await expect(installPlanningRestartAskAppend(createAtomicWriter(), {
      ...input, request: "changed request",
    })).rejects.toThrow(/conflicts/);
  });
});

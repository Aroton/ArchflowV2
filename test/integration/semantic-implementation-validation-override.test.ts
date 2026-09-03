import { execFileSync } from "node:child_process";
import {
  mkdirSync,
  readFileSync,
  rmSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { canonicalDocument } from "../../src/contracts/canonical.js";
import type { TaskStateV1 } from "../../src/contracts/durable-state.js";
import type { WorkflowViewV1 } from "../../src/contracts/semantic-workflow.js";
import { loadAuthenticatedValidationOverride } from "../../src/state/validation-overrides.js";
import {
  installSemanticReviewStub,
  reachImplementationHandoff,
  semanticJourneyHarness,
} from "../helpers/semantic-journeys.js";
import { createTaskWorkspace, type TaskWorkspace } from "../helpers/task-workspace.js";

const TIMEOUT = 180_000;
const workspaces: TaskWorkspace[] = [];
const restorers: Array<() => void> = [];

afterEach(() => {
  for (const restore of restorers.splice(0)) restore();
  for (const workspace of workspaces.splice(0)) workspace.dispose();
});

const VALIDATIONS = Object.freeze([
  "archforge hardware validation",
  "README fixture validation",
]);

function readState(workspace: TaskWorkspace): TaskStateV1 {
  return JSON.parse(readFileSync(workspace.services.authority.state.absolute, "utf8")) as TaskStateV1;
}

function head(workspace: TaskWorkspace): string {
  return execFileSync("git", ["rev-parse", "HEAD"], { cwd: workspace.root, encoding: "utf8" }).trim();
}

async function beginImplementation(workspace: TaskWorkspace) {
  const h = semanticJourneyHarness(workspace);
  const { invocation, handoff } = await reachImplementationHandoff(workspace, h, { phaseCount: 1 });
  const started = await h.apply(invocation, handoff);
  expect(started.ok, JSON.stringify(started)).toBe(true);
  if (!started.ok) throw new Error("implementation hand-off failed");
  expect(started.value.next_action).toMatchObject({ kind: "submit-work", expected_submission: "work-result" });
  return { h, invocation, view: started.value };
}

function installEnvelopeCapture(workspace: TaskWorkspace): string {
  const capture = join(workspace.root, "captured-review-envelopes.jsonl");
  const stub = join(workspace.root, "semantic-stub-bin", "codex");
  const source = readFileSync(stub, "utf8");
  const needle = "const envelope = JSON.parse(Buffer.concat(chunks).toString(\"utf8\"));";
  if (!source.includes(needle)) throw new Error("semantic codex stub shape changed");
  writeFileSync(stub, source.replace(
    needle,
    `${needle}\n  writeFileSync(${JSON.stringify(capture)}, JSON.stringify(envelope) + "\\n", { flag: "a" });`,
  ));
  return capture;
}

async function requestAndOpen(
  workspace: TaskWorkspace,
  decisionToken: "grant-validation-exception" | "deny-validation-exception" | "cancel",
) {
  const { h, invocation, view } = await beginImplementation(workspace);
  const before = readState(workspace);
  const failed = await h.apply(invocation, view, {
    kind: "work-result",
    outcome: "failed",
    reason: "The device lab is unavailable for this run.",
    validation_override_request: { displaced_validations: VALIDATIONS },
  });
  expect(failed.ok, JSON.stringify(failed)).toBe(true);
  if (!failed.ok) throw new Error("validation request failed");
  expect(failed.value.next_action).toMatchObject({ kind: "decide", expected_submission: "gate-summary" });
  const pending = readState(workspace);
  expect(pending).toMatchObject({
    phase_instance: "phase-impl-1",
    step: "produce",
    status: "failed",
    attempt: before.attempt,
    pending_validation_override: {
      phase_instance: "phase-impl-1",
      input_fingerprint: pending.input_fingerprint,
      displaced_validations: VALIDATIONS,
      producer_reason: "The device lab is unavailable for this run.",
      request_revision: pending.revision,
    },
    last_transition: { operation: "request-validation-override" },
  });

  const opened = await h.apply(invocation, failed.value, {
    kind: "gate-summary",
    summary: "The implementation needs a bounded validation exception.",
  });
  expect(opened.ok, JSON.stringify(opened)).toBe(true);
  if (!opened.ok) throw new Error("validation gate failed to open");
  expect(opened.value.presentation).toMatchObject({
    class: "exception",
    reasons: [expect.objectContaining({ class: "exception" })],
  });
  expect(opened.value.presentation?.details).toEqual([
    "Producer reason: The device lab is unavailable for this run.",
    ...VALIDATIONS.map((validation) => `Not run if granted: ${validation}`),
    "Only the validations listed above are covered; every unlisted check remains required.",
    "Granting this exception records missing verification. It does not treat any skipped validation as passed.",
  ]);
  expect(opened.value.presentation?.options.map((option) => option.token)).toEqual([
    "grant-validation-exception", "deny-validation-exception", "cancel",
  ]);

  const decided = await h.apply(invocation, opened.value, {
    kind: "decision",
    choice: decisionToken,
    reason: `Human chose ${decisionToken}.`,
  });
  if (decisionToken === "cancel") {
    expect(decided).toMatchObject({
      ok: false,
      error: { code: "GATE_CANCELLED" },
      view: { next_action: { kind: "begin-work", expected_submission: "none" } },
    });
  } else {
    expect(decided.ok, JSON.stringify(decided)).toBe(true);
  }
  const decidedView = decided.ok ? decided.value : decided.view;
  if (decidedView === undefined) throw new Error("validation gate decision returned no fresh view");
  expect(decidedView.next_action).toMatchObject({ kind: "begin-work", expected_submission: "none" });
  const settled = readState(workspace);
  expect(settled).toMatchObject({ step: "produce", status: "failed", attempt: before.attempt });
  expect(settled.pending_validation_override).toBeUndefined();
  expect(settled.approvals).toEqual(before.approvals);
  expect(settled.waivers).toEqual(before.waivers);
  return { h, invocation, view: decidedView, before, settled };
}

describe("semantic implementation validation override", { timeout: TIMEOUT }, () => {
  for (const decision of ["deny-validation-exception", "cancel"] as const) {
    it(`${decision} clears the request and returns to the failed attempt without granting authority`, async () => {
      const workspace = await createTaskWorkspace({ taskId: `validation-${decision}`, label: `validation-${decision}` });
      workspaces.push(workspace);
      restorers.push(installSemanticReviewStub(workspace.root, [[]]));
      const result = await requestAndOpen(workspace, decision);
      expect(result.settled.validation_overrides ?? []).toEqual([]);

      const retried = await result.h.apply(result.invocation, result.view);
      expect(retried.ok, JSON.stringify(retried)).toBe(true);
      if (!retried.ok) return;
      expect(readState(workspace).attempt).toBe(result.before.attempt + 1);
    });
  }

  it("grants exactly one audit record, retries ordinarily, authenticates the archive, and pins not-run disclosure", async () => {
    const workspace = await createTaskWorkspace({ taskId: "validation-grant", label: "validation-grant" });
    workspaces.push(workspace);
    restorers.push(installSemanticReviewStub(workspace.root, [[]]));
    const capture = installEnvelopeCapture(workspace);
    const result = await requestAndOpen(workspace, "grant-validation-exception");
    expect(result.settled.validation_overrides).toHaveLength(1);
    const record = result.settled.validation_overrides![0]!;
    // Gate/request order is localeCompare; the durable audit record uses ordinal code-unit order.
    expect(record.displaced_validations).toEqual(["README fixture validation", "archforge hardware validation"]);
    expect(record.human_reason).toBe("Human chose grant-validation-exception.");
    expect(await loadAuthenticatedValidationOverride(
      workspace.services.dependencies, workspace.services.authority, record,
    )).toMatchObject({ ok: true });

    const retried = await result.h.apply(result.invocation, result.view);
    expect(retried.ok, JSON.stringify(retried)).toBe(true);
    if (!retried.ok) return;
    const retriedState = readState(workspace);
    expect(retriedState.attempt).toBe(result.before.attempt + 1);
    expect(retriedState.input_fingerprint, "ordinary retry must preserve the validation grant's governing input identity")
      .toBe(record.input_fingerprint);
    const authenticatedAfterRetry = await loadAuthenticatedValidationOverride(
      workspace.services.dependencies, workspace.services.authority, record,
    );
    expect(authenticatedAfterRetry.ok, JSON.stringify(authenticatedAfterRetry)).toBe(true);

    const currentArtifact = retried.value.resources.find((resource) => resource.role === "current-artifact");
    const transcript = retried.value.resources.find((resource) => resource.role === "verification-transcript");
    if (currentArtifact === undefined || transcript === undefined) throw new Error("implementation resources unavailable");
    const sourcePath = "src/validation-override-fixture.ts";
    for (const path of [currentArtifact.path, transcript.path, sourcePath]) {
      mkdirSync(dirname(join(workspace.root, path)), { recursive: true });
    }
    writeFileSync(join(workspace.root, sourcePath), "export const validationOverrideFixture = true;\n");
    writeFileSync(join(workspace.root, currentArtifact.path), "# Implementation notes\n\nValidation exception fixture.\n");
    writeFileSync(join(workspace.root, transcript.path), "$ npm test\n\nNamed validations were not run under the recorded exception.\n");
    writeFileSync(capture, "");
    const outputs = [currentArtifact.path, sourcePath].sort();
    const submitted = await result.h.apply(result.invocation, retried.value, {
      kind: "work-result",
      outcome: "succeeded",
      implementation: {
        base_commit: head(workspace),
        outputs,
        restore_targets: outputs,
        declared_inputs: [],
      },
    });
    expect(submitted.ok, JSON.stringify(submitted)).toBe(true);
    if (!submitted.ok) return;
    expect(readState(workspace).input_fingerprint, "successful produce must preserve the validation grant's governing input identity")
      .toBe(record.input_fingerprint);
    const authenticatedAfterProduce = await loadAuthenticatedValidationOverride(
      workspace.services.dependencies, workspace.services.authority, record,
    );
    expect(authenticatedAfterProduce.ok, JSON.stringify(authenticatedAfterProduce)).toBe(true);
    const reviewed = await result.h.apply(result.invocation, submitted.value);
    expect(reviewed.ok, JSON.stringify(reviewed)).toBe(true);
    if (!reviewed.ok) return;
    const reauthenticatedAfterReview = await loadAuthenticatedValidationOverride(
      workspace.services.dependencies, workspace.services.authority, record,
    );
    expect(reauthenticatedAfterReview.ok, JSON.stringify(reauthenticatedAfterReview)).toBe(true);

    const envelopes = readFileSync(capture, "utf8").trim().split("\n")
      .filter(Boolean).map((line) => JSON.parse(line) as Record<string, any>);
    const implementationReview = envelopes.find((envelope) =>
      envelope.subject?.role === "counter-review" && envelope.subject?.phase_instance === "phase-impl-1");
    const pinned = implementationReview?.context?.find((entry: Record<string, unknown>) =>
      entry.kind === "validation-override");
    expect(pinned, JSON.stringify({
      input_fingerprint: readState(workspace).input_fingerprint,
      validation_overrides: readState(workspace).validation_overrides,
      context: implementationReview?.context,
    })).toMatchObject({ status: "pinned", encoding: "utf8" });
    const disclosure = JSON.parse(String(pinned.content));
    expect(disclosure).toMatchObject({
      evidence_kind: "validation-overrides",
      overrides: [{
        status: "not-run",
        human_reason: "Human chose grant-validation-exception.",
        displaced_validations: VALIDATIONS,
      }],
    });
    expect(disclosure.interpretation).toContain("not passing evidence");

    const decisionPath = join(
      workspace.services.authority.task_root,
      "authority", "decisions", record.gate_id, "decision.json",
    );
    const originalDecision = JSON.parse(readFileSync(decisionPath, "utf8"));
    writeFileSync(decisionPath, canonicalDocument({
      ...originalDecision,
      envelope: {
        ...originalDecision.envelope,
        payload: { ...originalDecision.envelope.payload, reason: "tampered reason" },
      },
    }).bytes);
    expect(await loadAuthenticatedValidationOverride(
      workspace.services.dependencies, workspace.services.authority, record,
    )).toMatchObject({ ok: false });
    unlinkSync(decisionPath);
    expect(await loadAuthenticatedValidationOverride(
      workspace.services.dependencies, workspace.services.authority, record,
    )).toMatchObject({ ok: false });
    rmSync(capture, { force: true });
  });
});

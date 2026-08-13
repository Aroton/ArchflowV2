/**
 * Executability proof for derived actions: everything status hands out — the next action, its
 * prefilled request, and the composed build-request output — must execute against the real tool
 * handlers from exactly the state it was derived in. The client fills only judgment placeholders
 * and copies resolved requests verbatim; no derived action may ever bounce with
 * TRANSITION_INVALID or INPUT_FINGERPRINT_MISMATCH.
 */
import { execFileSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { canonicalJsonDigest } from "../../src/contracts/canonical.js";
import { connectionContextFactory, createInvocationContext } from "../../src/contracts/contexts.js";
import { parseSafeCode, parseTaskSlug } from "../../src/contracts/evidence.js";
import type { PlainJsonValue } from "../../src/contracts/plain-json.js";
import type { ReviewEvidence } from "../../src/contracts/review.js";
import { scaffoldRepositoryAssets } from "../../src/init/assets.js";
import { stageTaskInitialization } from "../../src/init/task-initialization.js";
import { runBuildRequest } from "../../src/local/build-request.js";
import { computeCallEnvelope, type CallEnvelope } from "../../src/local/call-envelope.js";
import { runLocalCommand } from "../../src/local/commands.js";
import { createToolHandlers } from "../../src/mcp/handlers/index.js";
import { createToolBoundary } from "../../src/mcp/server.js";
import { createProductionServices } from "../../src/state/production.js";
import { computeTaskStatus, type TaskStatusV1 } from "../../src/state/status.js";

const TIMEOUT = 60_000;
const task = parseTaskSlug("roundtrip-task");
const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

const gitEnvironment: NodeJS.ProcessEnv = {
  ...process.env,
  GIT_CONFIG_GLOBAL: "/dev/null",
  GIT_CONFIG_SYSTEM: "/dev/null",
  GIT_AUTHOR_NAME: "ArchFlow Test",
  GIT_AUTHOR_EMAIL: "test@example.invalid",
  GIT_COMMITTER_NAME: "ArchFlow Test",
  GIT_COMMITTER_EMAIL: "test@example.invalid",
};

function git(root: string, ...argv: string[]): string {
  return execFileSync("git", argv, { cwd: root, env: gitEnvironment, encoding: "utf8" }).trim();
}

/**
 * The scaffolded rule set is replaced wholesale by exactly one rule whose status the test picks:
 * "deprecated" leaves zero active rules (the merged counter-review runs a single dispatch and
 * reports the constitution review as not-run), while "active" makes the same call run the
 * second, adjudicating dispatch and carry the evaluated outcome.
 */
async function repository(ruleStatus: "deprecated" | "active" = "deprecated") {
  const root = mkdtempSync(join(tmpdir(), "archflow-roundtrip-"));
  roots.push(root);
  git(root, "-c", "init.defaultBranch=main", "init", "-q");
  writeFileSync(join(root, "README.md"), "repository\n");
  git(root, "add", "--", "README.md");
  git(root, "commit", "-q", "-m", "root");
  const scaffolded = await scaffoldRepositoryAssets({ working_directory: root });
  if (!scaffolded.ok) throw new Error(scaffolded.error.code);
  for (const name of readdirSync(join(root, ".archflow", "constitution"))) {
    if (name.endsWith(".md") && name !== "README.md") rmSync(join(root, ".archflow", "constitution", name));
  }
  writeFileSync(join(root, ".archflow", "constitution", "20-data.md"), `---
id: task-and-evidence-isolation
version: 1
status: ${ruleStatus}
review_trigger: A task reads or mutates another task's files.
---
Tasks are isolated from one another.
`);
  git(root, "add", "--", ".gitattributes", ".archflow/workflow.yaml", ".archflow/constitution", ".archflow/config.yaml");
  git(root, "commit", "-q", "-m", "policy");
  const staged = await stageTaskInitialization({ working_directory: root, task_id: task });
  if (!staged.ok) throw new Error(staged.error.code);
  return { root, initialization: staged.value };
}

function harness(root: string, host: "codex" | "claude" = "codex") {
  const boundary = createToolBoundary(createToolHandlers());
  const connection = connectionContextFactory.captureStartup({
    connection_id: "connection-roundtrip",
    startup_repository_candidate: { working_directory: root },
  }).initialize({
    client: host === "codex"
      ? { name: "codex-mcp-client", version: "0.146.0" }
      : { name: "claude-code", version: "2.1.220" },
    host,
    protocol_version: "2025-11-25",
  });
  let sequence = 0;

  async function services() {
    const created = await createProductionServices({
      working_directory: root, task_id: task, operation: parseSafeCode("roundtrip-test"),
    });
    if (!created.ok) throw new Error(created.error.code);
    return created.value;
  }

  return {
    async status(): Promise<TaskStatusV1> {
      const s = await services();
      const status = await computeTaskStatus(s.dependencies, s.authority);
      if (!status.ok) throw new Error(status.error.code);
      return status.value;
    },
    async envelope(request: PlainJsonValue): Promise<CallEnvelope> {
      const resolved = await computeCallEnvelope(await services(), request);
      if (!resolved.ok) throw new Error(resolved.error.code);
      return resolved.value;
    },
    async buildRequest(value: PlainJsonValue): Promise<CallEnvelope> {
      const composed = await runBuildRequest(await services(), value);
      if (!composed.ok) throw new Error(composed.error.code);
      return composed.value;
    },
    async buildRequestError(value: PlainJsonValue): Promise<string> {
      const composed = await runBuildRequest(await services(), value);
      if (composed.ok) throw new Error("expected build-request to refuse");
      return composed.error.code;
    },
    async invoke(tool: string, input: PlainJsonValue): Promise<PlainJsonValue> {
      sequence += 1;
      const context = createInvocationContext(connection, {
        invocation_id: `invocation-${sequence}`,
        transport_metadata: { request_id: `request-${sequence}`, operation: "tools/call" },
      }, new AbortController().signal);
      const outcome = await boundary.invoke(tool, structuredClone(input), context);
      expect(outcome.kind).toBe("project-result");
      if (outcome.kind !== "project-result") throw new Error("tool invocation failed outside the result contract");
      const result = outcome.result as { ok: boolean; error?: { code?: string } };
      // The intent assertion of this whole suite: a derived request never bounces off the
      // transition law or the fingerprint check it was derived under.
      expect(result.error?.code).not.toBe("TRANSITION_INVALID");
      expect(result.error?.code).not.toBe("INPUT_FINGERPRINT_MISMATCH");
      expect(result.ok, JSON.stringify(result.error ?? result)).toBe(true);
      return outcome.result as PlainJsonValue;
    },
  };
}

/**
 * Stub reviewer CLI answering both child dispatches of the merged call: the rubric review with
 * one non-blocking finding, and the sealed constitution envelope with one schema-valid finding
 * per active rule (the fixture rule declares no enforcement, so "pass" is legal) whose trigger
 * result the test picks.
 */
function installReviewerStub(
  root: string,
  adjudicatorTrigger: "matched" | "not-matched" = "not-matched",
): { restore: () => void } {
  const bin = join(root, "stub-bin");
  const stubHome = join(root, "stub-home");
  mkdirSync(join(stubHome, ".codex"), { recursive: true });
  mkdirSync(bin, { recursive: true });
  writeFileSync(join(stubHome, ".codex", "auth.json"), "{}\n");
  writeFileSync(join(bin, "codex"), `#!/usr/bin/env node
import { writeFile } from "node:fs/promises";
const argv = process.argv.slice(2);
if (argv.length === 1 && argv[0] === "--version") process.stdout.write("codex-cli 0.146.0\\n");
else if (argv[0] === "login" && argv[1] === "status") process.stdout.write("Logged in using ChatGPT\\n");
else {
  const chunks = []; for await (const chunk of process.stdin) chunks.push(chunk);
  const envelope = JSON.parse(Buffer.concat(chunks).toString("utf8")); const subject = envelope.subject;
  const trigger = ${JSON.stringify(adjudicatorTrigger)};
  const output = subject.role === "counter-review" ? {
    schema_version: "1", task_id: subject.task_id, phase_instance: subject.phase_instance,
    step: "counter_review", role: "counter-review", subject_digest: subject.subject_digest,
    input_fingerprint: subject.input_fingerprint, rubric_digest: subject.rubric_digest,
    producer_family: subject.producer_family,
    findings: [{ finding_id: "requirement-untestable", severity: "minor", blocking: false,
      summary: "One requirement is not testable as written.", evidence: "prd.md line 3.",
      suggested_resolution: "State the observable behavior." }],
    matched_rule_versions: [], verdict: "advisory", blocking_count: 0
  } : {
    schema_version: "1", task_id: subject.task_id, phase_instance: subject.phase_instance,
    step: "adjudicate", subject_digest: subject.subject_digest,
    input_fingerprint: subject.input_fingerprint,
    pinned_constitution_digest: subject.pinned_constitution_digest,
    approved_upstream_digests: subject.approved_upstream_digests,
    source_evidence_set_digest: subject.source_evidence_set_digest,
    rule_findings: envelope.rules.map((rule) => ({ rule_id: rule.id, rule_version: rule.version,
      compliance: "pass", rationale: "Checked the sealed envelope.",
      trigger,
      trigger_evidence: trigger === "matched"
        ? "The artifact describes reading another task's files."
        : "No review trigger matched." })),
    drift_findings: subject.approved_upstream_digests.map((upstream_digest) => ({
      upstream_digest, drift: "aligned", affected_claim_ids: [], rationale: "No upstream drift found." })),
    constitution: "pass", drift: "aligned",
    matched_rule_versions: trigger === "matched"
      ? envelope.rules.map((rule) => ({ rule_id: rule.id, rule_version: rule.version }))
      : [],
    uncertain_rule_versions: []
  };
  await writeFile(argv[argv.indexOf("-o") + 1], JSON.stringify(output) + "\\n");
  process.stdout.write('{"type":"turn.completed"}\\n');
}`);
  chmodSync(join(bin, "codex"), 0o755);
  const saved = { PATH: process.env.PATH, HOME: process.env.HOME };
  process.env.PATH = `${bin}:${saved.PATH ?? ""}`;
  process.env.HOME = stubHome;
  return {
    restore() {
      if (saved.PATH === undefined) delete process.env.PATH; else process.env.PATH = saved.PATH;
      if (saved.HOME === undefined) delete process.env.HOME; else process.env.HOME = saved.HOME;
    },
  };
}

type RequestShape = Readonly<{ tool: string; input: Record<string, PlainJsonValue> }>;

function derivedRequest(status: TaskStatusV1): RequestShape {
  expect(status.next_action.request).toBeDefined();
  return structuredClone(status.next_action.request) as unknown as RequestShape;
}

async function approveComposedGate(
  root: string,
  h: ReturnType<typeof harness>,
  gate: CallEnvelope,
): Promise<void> {
  const pending = h.invoke(gate.request.tool, gate.request.input);
  let opened = false;
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const status = await h.status();
    if (status.open_gate !== undefined) {
      opened = true;
      break;
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  expect(opened, "the composed gate should become visible before its invocation returns").toBe(true);
  const decision = await runLocalCommand({
    command: "decide",
    working_directory: root,
    task_id: task,
    value: { kind: "choice", choice: "approve", reason: "Approve the reviewed artifact." },
  });
  expect(decision).toMatchObject({ ok: true });
  await pending;
}

async function completeDocumentPhase(
  root: string,
  h: ReturnType<typeof harness>,
  label: string,
  artifactPath: string,
  contents: string,
): Promise<void> {
  writeFileSync(join(root, ".archflow", "tasks", task, artifactPath), contents);
  const produced = await h.buildRequest({ intent_id: `${label}-produce`, kind: "produce" });
  await h.invoke(produced.request.tool, produced.staged?.reference ?? produced.request.input);
  const counterEntry = await h.buildRequest({ intent_id: `${label}-counter-entry`, kind: "running", step: "counter_review" });
  await h.invoke(counterEntry.request.tool, counterEntry.staged?.reference ?? counterEntry.request.input);
  const counter = await h.buildRequest({ intent_id: `${label}-counter`, kind: "counter-review" });
  await h.invoke(counter.request.tool, counter.staged?.reference ?? counter.request.input);
  const triageEntry = await h.buildRequest({ intent_id: `${label}-triage-entry`, kind: "running", step: "triage" });
  await h.invoke(triageEntry.request.tool, triageEntry.staged?.reference ?? triageEntry.request.input);
  const triage = await h.buildRequest({
    intent_id: `${label}-triage`,
    kind: "triage",
    dispositions: [{
      finding_id: "requirement-untestable",
      disposition: "rejected",
      rationale: "The artifact names observable behavior.",
      evidence: `${artifactPath} contains the reviewed behavior.`,
    }],
  });
  await h.invoke(triage.request.tool, triage.staged?.reference ?? triage.request.input);
  const gate = await h.buildRequest({
    intent_id: `${label}-gate`,
    kind: "gate",
    summary: `${label} is ready for approval.`,
  });
  await approveComposedGate(root, h, gate);
}

describe("status-derived requests execute against the real handlers", () => {
  it("drives the PRD phase from create-task into counter-review using only derived requests", async () => {
    const fixture = await repository();
    const h = harness(fixture.root);

    // 1. Missing state: the create-task template plus the staged initialization artifact is the
    //    entire first request; envelope resolves the sentinel fingerprint.
    const created = await h.status();
    expect(created.next_action).toMatchObject({ code: "create-task", request: { tool: "archflow_state" } });
    const createRequest = derivedRequest(created);
    createRequest.input.artifact = fixture.initialization as unknown as PlainJsonValue;
    const createResolved = await h.envelope(createRequest as unknown as PlainJsonValue);
    await h.invoke(createResolved.request.tool, createResolved.request.input);

    // 2. Mid-produce (the exact state the old surface bounced on): status must derive the
    //    terminal record, and build-request must compose it end to end. The task documents are
    //    written after status ran, so the status-time fingerprint is stale by construction —
    //    resolution at build time absorbs the drift.
    const midProduce = await h.status();
    expect(midProduce).toMatchObject({
      step: "produce", status: "running",
      next_action: {
        code: "run-step", step: "produce",
        detail: "Record the terminal produce result.",
        request: { tool: "archflow_state", input: { step: "produce", status: "succeeded" } },
      },
    });
    expect(midProduce.subject_digest).toBeUndefined();
    writeFileSync(join(fixture.root, ".archflow", "tasks", task, "ask.md"), "Build the round-trip proof.\n");
    writeFileSync(join(fixture.root, ".archflow", "tasks", task, "prd.md"), "# PRD\n\nRound-trip requirements.\n");
    const produceComposed = await h.buildRequest({ intent_id: "produce-prd-1" });
    expect(produceComposed.request.tool).toBe("archflow_state");
    const produceResult = await h.invoke(produceComposed.request.tool, produceComposed.request.input) as {
      value: { request_digest?: string };
    };
    // The tool result echoes the recorded request digest: comparing one string against the
    // helper's output proves the model-typed arguments arrived untranscribed.
    expect(produceResult.value.request_digest).toBe(produceComposed.request_digest);

    // 3. Produce recorded: the subject digest is now a status fact, and the derived action is
    //    the counter_review running entry whose resolved request differs from the template only
    //    in the judgment fields the client filled.
    const produced = await h.status();
    expect(produced.subject_digest).toBe(produceComposed.artifact_digest);
    expect(produced.next_action).toMatchObject({
      code: "run-step", step: "counter_review",
      request: { tool: "archflow_state", input: { step: "counter_review", status: "running" } },
    });
    const entryRequest = derivedRequest(produced);
    entryRequest.input.intent_id = "counter-review-entry-1";
    const entryResolved = await h.envelope(entryRequest as unknown as PlainJsonValue);
    expect(entryResolved.request.input).toEqual({
      ...entryRequest.input,
      input_fingerprint: entryResolved.input_fingerprint,
    });
    await h.invoke(entryResolved.request.tool, entryResolved.request.input);

    // 4. Mid-counter_review: the derived action is the terminal record through the dedicated
    //    counter-review tool, authored purely from status facts — subject digest, fingerprint,
    //    and the canonical review subject path.
    const midReview = await h.status();
    expect(midReview).toMatchObject({
      step: "counter_review", status: "running",
      next_action: {
        code: "run-step", step: "counter_review",
        request: { tool: "archflow_counter_review", input: { artifact_path: "prd.md" } },
      },
    });
    expect(midReview.subject_digest).toBeDefined();
  }, TIMEOUT);

  it("drives the whole PRD pipeline through build-request composers alone", async () => {
    const fixture = await repository();
    // The default config routes the counter-reviewer to the codex family, so the producing
    // connection must be the claude host for the opposite-family invariant to hold.
    const h = harness(fixture.root, "claude");
    const rubric = {
      schema_version: "1", kind: "artifact", mode: "adversarial",
      criteria: [{ id: "scope", text: "Check scope against the ask.", blocking: true }],
    };

    // Before state exists, initialize is the only kind build-request accepts; every other kind
    // still refuses with STATE_MISSING.
    expect(await h.buildRequestError({ intent_id: "early-0", kind: "produce" })).toBe("STATE_MISSING");
    const created = await h.status();
    expect(created.next_action).toMatchObject({ code: "create-task" });
    const createComposed = await h.buildRequest({ intent_id: "initialize-1", kind: "initialize" });
    expect(createComposed.request.tool).toBe("archflow_state");
    expect(createComposed.request.input).toMatchObject({
      expected_revision: 0, phase_instance: "prd", step: "produce", status: "running",
      artifact: fixture.initialization,
    });
    // Envelope over the composed initialize request is the same fixed point as every other kind.
    const createReplay = await h.envelope(createComposed.request as unknown as PlainJsonValue);
    expect(createReplay.request_digest).toBe(createComposed.request_digest);
    await h.invoke(createComposed.request.tool, createComposed.request.input);
    // Once durable state exists, initialize refuses with the transition law's own answer.
    expect(await h.buildRequestError({ intent_id: "late-1", kind: "initialize" })).toBe("TRANSITION_INVALID");
    writeFileSync(join(fixture.root, ".archflow", "tasks", task, "ask.md"), "Build the composer proof.\n");
    writeFileSync(join(fixture.root, ".archflow", "tasks", task, "prd.md"), "# PRD\n\nComposer requirements.\n");

    // Illegal targets refuse at compose time with the transition law's own answer, and payload
    // shape errors name the expected facts.
    expect(await h.buildRequestError({ intent_id: "early-1", kind: "counter-review" })).toBe("TRANSITION_INVALID");
    expect(await h.buildRequestError({ intent_id: "early-2", kind: "triage", dispositions: [] })).toBe("TRANSITION_INVALID");
    expect(await h.buildRequestError({ intent_id: "early-3", kind: "running", step: "produce" })).toBe("TRANSITION_INVALID");
    await expect(h.buildRequest({ intent_id: "early-4", kind: "running", step: "nonsense" })).rejects.toThrow(/one of produce, counter_review/u);
    await expect(h.buildRequest({ intent_id: "early-5", kind: "review-everything" })).rejects.toThrow(/not recognized/u);
    await expect(h.buildRequest({ intent_id: "early-6", kind: "gate", summary: "  " })).rejects.toThrow(/summary/u);

    // Terminal produce (the pre-existing composer path).
    const produceComposed = await h.buildRequest({ intent_id: "produce-1" });
    await h.invoke(produceComposed.request.tool, produceComposed.request.input);

    // Counter-review entry, then the composed archflow_counter_review call invoked for real
    // against a stub reviewer CLI on PATH (the default config routes the counter-reviewer to the
    // codex family), so the composed request must satisfy the whole dispatch pipeline.
    const counterEntry = await h.buildRequest({ intent_id: "counter-entry-1", kind: "running", step: "counter_review" });
    expect(counterEntry.request.input).toMatchObject({ step: "counter_review", status: "running" });
    await h.invoke(counterEntry.request.tool, counterEntry.request.input);
    const counterComposed = await h.buildRequest({ intent_id: "counter-1", kind: "counter-review" });
    expect(counterComposed.request.tool).toBe("archflow_counter_review");
    expect(counterComposed.request.input).toMatchObject({ artifact_path: "prd.md" });
    expect(counterComposed.request.input).not.toHaveProperty("rubric");
    // Envelope over the composed request is a fixed point: same digests, nothing left to resolve.
    const counterReplay = await h.envelope(counterComposed.request as unknown as PlainJsonValue);
    expect(counterReplay.request_digest).toBe(counterComposed.request_digest);

    const stub = installReviewerStub(fixture.root);
    try {
      const reviewed = await h.invoke(counterComposed.request.tool, counterComposed.request.input) as {
        value: { constitution?: Record<string, unknown> };
      };
      // Zero active rules: the merged call ran a single dispatch and says so explicitly.
      expect(reviewed.value.constitution).toEqual({ status: "not-run", reason: "no-active-constitution-rules" });

      // Triage: the caller authors only dispositions; the composer binds the evidence set, slot
      // order, digests, and counts, and resolves each finding to its review mechanically.
      const triageEntry = await h.buildRequest({ intent_id: "triage-entry-1", kind: "running", step: "triage" });
      await h.invoke(triageEntry.request.tool, triageEntry.request.input);
      const triageComposed = await h.buildRequest({
        intent_id: "triage-1", kind: "triage",
        dispositions: [
          { finding_id: "requirement-untestable", disposition: "rejected", rationale: "The requirement names observable output.", evidence: "prd.md line 3." },
        ],
      });
      const triaged = await h.status();
      expect(triaged.evidence?.available).toBe(true);
      const slots = (triaged.evidence as { current_evidence: { slots: readonly { evidence_digest: string }[] } })
        .current_evidence.slots.map((slot) => slot.evidence_digest);
      const triageArtifact = (triageComposed.request.input as {
        artifact: { evidence: { source_evidence_digests: readonly string[]; accepted_count: number; rejected_count: number } };
      }).artifact.evidence;
      expect(triageArtifact.source_evidence_digests).toEqual(slots);
      expect(triageArtifact).toMatchObject({ accepted_count: 0, rejected_count: 1 });

      // A disposition set that misses a finding refuses at compose time, before any tool call.
      await expect(h.buildRequest({
        intent_id: "triage-short", kind: "triage",
        dispositions: [],
      })).rejects.toThrow(/cover every current finding/u);
      await h.invoke(triageComposed.request.tool, triageComposed.request.input);

      // No adjudicate position or composer kind exists any more: the constitution review ran
      // inside archflow_counter_review. The retired step is not a legal movement target from
      // any position, and the composer kind is gone outright.
      expect(await h.buildRequestError({ intent_id: "adjudicate-entry-1", kind: "running", step: "adjudicate" }))
        .toBe("TRANSITION_INVALID");
      await expect(h.buildRequest({ intent_id: "adjudicate-1", kind: "adjudicate" }))
        .rejects.toThrow(/not recognized/u);

      // The composed artifact-approval gate is compose-only: invoking it opens a human gate.
      const gateComposed = await h.buildRequest({ intent_id: "gate-1", kind: "gate", summary: "PRD ready for approval." });
      expect(gateComposed.request.tool).toBe("archflow_gate");
      expect(gateComposed.gate?.gate_id).toBeDefined();
      expect(gateComposed.request.input).toMatchObject({
        kind: "artifact-approval",
        subject_digest: triaged.subject_digest,
        context: { artifact_kind: "prd" },
      });
      const gateEvidence = (gateComposed.request.input as {
        current_evidence: { slots: readonly { evidence_digest: string }[] };
      }).current_evidence.slots.map((slot) => slot.evidence_digest);
      expect(gateEvidence).toEqual(slots);
    } finally {
      stub.restore();
    }
  }, TIMEOUT);

  it("advances an approved design into phase-design-1 through the public composer", async () => {
    const fixture = await repository();
    const h = harness(fixture.root, "claude");
    const stub = installReviewerStub(fixture.root);
    try {
      const initialized = await h.buildRequest({ intent_id: "handoff-initialize", kind: "initialize" });
      await h.invoke(initialized.request.tool, initialized.request.input);
      writeFileSync(join(fixture.root, ".archflow", "tasks", task, "ask.md"), "Fix the approved-design handoff.\n");

      await completeDocumentPhase(
        fixture.root,
        h,
        "handoff-prd",
        "prd.md",
        "# PRD\n\nAfter design approval, the workflow advances to phase design.\n",
      );
      const prdAdvance = await h.buildRequest({ intent_id: "handoff-prd-advance", kind: "advance" });
      await h.invoke(prdAdvance.request.tool, prdAdvance.staged?.reference ?? prdAdvance.request.input);

      await completeDocumentPhase(
        fixture.root,
        h,
        "handoff-design",
        "design.md",
        "# Design\n\nAdvance through the existing state transition.\n\n### Phase 1: Implement the handoff\n",
      );

      const approved = await h.status();
      expect(approved).toMatchObject({
        phase_instance: "design",
        step: "triage",
        status: "succeeded",
        blocking_reasons: [],
        reconciliation: { findings: [] },
        evidence: { assessment: { next: "advance" } },
        next_action: {
          code: "commit-artifacts",
          human_required: false,
          commit_path: `.archflow/tasks/${task}`,
          commit_message: `ArchFlow: Approve ${task} design`,
          commit_target_ref: "refs/heads/main",
        },
      });
      const approvedRevision = approved.revision;
      expect(approvedRevision).toBeDefined();

      git(fixture.root, "add", "-A", "--", approved.next_action.commit_path!);
      git(
        fixture.root,
        "commit",
        "-q",
        "-m",
        approved.next_action.commit_message!,
        "--",
        approved.next_action.commit_path!,
      );
      const committed = await h.status();
      expect(committed.next_action).toMatchObject({
        code: "advance-phase",
        target_phase_instance: "phase-design-1",
        skill: "archflow-phase-design",
        skill_args: ["1"],
        request: {
          tool: "archflow_state",
          input: { phase_instance: "phase-design-1", step: "produce", status: "running" },
        },
      });

      const manual = await runLocalCommand({
        command: "manual-status",
        working_directory: fixture.root,
        task_id: task,
      });
      expect(manual).toMatchObject({
        ok: true, value: { next_action: { commands: {
          claude: `/archflow-phase-design ${task} 1`,
          codex: `$archflow-phase-design ${task} 1`,
        } } },
      });

      const advance = await h.buildRequest({ intent_id: "handoff-design-advance", kind: "advance" });
      expect(advance.staged?.reference).toBeDefined();
      expect(advance.request.input).toMatchObject({
        expected_revision: approvedRevision,
        phase_instance: "phase-design-1",
        step: "produce",
        status: "running",
      });
      await h.invoke(advance.request.tool, advance.staged?.reference ?? advance.request.input);

      const advanced = await h.status();
      expect(advanced).toMatchObject({
        revision: (approvedRevision as number) + 1,
        phase_instance: "phase-design-1",
        step: "produce",
        status: "running",
        next_action: { code: "run-step", step: "produce", skill: "archflow-phase-design" },
      });
      const durable = JSON.parse(readFileSync(
        join(fixture.root, ".archflow", "tasks", task, "state.json"),
        "utf8",
      )) as { planned_final_phase?: number };
      expect(durable.planned_final_phase).toBe(1);
      expect(await h.buildRequestError({ intent_id: "handoff-repeat", kind: "advance" }))
        .toBe("TRANSITION_INVALID");
    } finally {
      stub.restore();
    }
  }, TIMEOUT);

  it("derives the post-triage constitution-review gate and composes it mechanically", async () => {
    const fixture = await repository("active");
    const h = harness(fixture.root, "claude");
    const rubric = {
      schema_version: "1", kind: "artifact", mode: "adversarial",
      criteria: [{ id: "scope", text: "Check scope against the ask.", blocking: true }],
    };
    const rule = { rule_id: "task-and-evidence-isolation", rule_version: 1 };
    const stub = installReviewerStub(fixture.root, "matched");
    try {
      const createComposed = await h.buildRequest({ intent_id: "initialize-1", kind: "initialize" });
      await h.invoke(createComposed.request.tool, createComposed.request.input);
      writeFileSync(join(fixture.root, ".archflow", "tasks", task, "ask.md"), "Build the trigger-gate proof.\n");
      writeFileSync(join(fixture.root, ".archflow", "tasks", task, "prd.md"), "# PRD\n\nTrigger-gate requirements.\n");
      const produceComposed = await h.buildRequest({ intent_id: "produce-1" });
      await h.invoke(produceComposed.request.tool, produceComposed.request.input);

      // The merged call runs both children; the constitution review reports the matched trigger.
      const counterEntry = await h.buildRequest({ intent_id: "counter-entry-1", kind: "running", step: "counter_review" });
      await h.invoke(counterEntry.request.tool, counterEntry.request.input);
      const counterComposed = await h.buildRequest({ intent_id: "counter-1", kind: "counter-review" });
      const reviewed = await h.invoke(counterComposed.request.tool, counterComposed.request.input) as {
        value: { constitution?: Record<string, unknown> };
      };
      expect(reviewed.value.constitution).toMatchObject({
        status: "evaluated", constitution: "pass", drift: "aligned", triggers: [rule],
      });

      // The counter-review call itself opened NO gate: triage still comes first.
      const afterReview = await h.status();
      expect(afterReview.next_action).toMatchObject({ code: "run-step", step: "triage" });

      const triageEntry = await h.buildRequest({ intent_id: "triage-entry-1", kind: "running", step: "triage" });
      await h.invoke(triageEntry.request.tool, triageEntry.request.input);
      const triageComposed = await h.buildRequest({
        intent_id: "triage-1", kind: "triage",
        dispositions: [
          { finding_id: "requirement-untestable", disposition: "rejected", rationale: "The requirement names observable output.", evidence: "prd.md line 3." },
        ],
      });
      await h.invoke(triageComposed.request.tool, triageComposed.request.input);

      // Post-triage fixed point: the constitution-review gate derived from the retained
      // constitution evidence is the pending action, with the mechanical archflow_gate prefill
      // attached. Compliance passed, so the matched trigger is the whole of the question — and it
      // is the only gate, so no pending-gate queue is disclosed.
      const gated = await h.status();
      expect(gated.evidence?.assessment).toMatchObject({ next: "adjudication-gate" });
      expect(gated.next_action).toMatchObject({
        code: "open-gate",
        gate_kind: "constitution-review",
        request: { tool: "archflow_gate", input: { kind: "constitution-review" } },
      });
      expect(gated.next_action).not.toHaveProperty("pending_gate_kinds");

      // build-request kind "gate" composes the same pending gate mechanically — kind, subject,
      // and context all from retained adjudication evidence — in preference to artifact-approval.
      const gateComposed = await h.buildRequest({
        intent_id: "gate-1", kind: "gate", summary: "Resolve the matched review trigger.",
      });
      expect(gateComposed.request.tool).toBe("archflow_gate");
      expect(gateComposed.gate?.gate_id).toBeDefined();
      expect(gateComposed.request.input).toMatchObject({
        kind: "constitution-review",
        subject_digest: produceComposed.artifact_digest,
        context: {
          constitution: "pass",
          failed_rules: [],
          uncertain_rules: [],
          matched_trigger_rules: [rule],
          uncertain_trigger_rules: [],
          eligible_waivers: [{ rule, scope: { operation: "review-trigger", boundary: "subject" } }],
        },
      });
    } finally {
      stub.restore();
    }
  }, TIMEOUT);
});

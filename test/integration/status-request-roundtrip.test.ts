/**
 * Executability proof for derived actions: everything status hands out — the next action, its
 * prefilled request, and the composed build-request output — must execute against the real tool
 * handlers from exactly the state it was derived in. The client fills only judgment placeholders
 * and copies resolved requests verbatim; no derived action may ever bounce with
 * TRANSITION_INVALID or INPUT_FINGERPRINT_MISMATCH.
 */
import { execFileSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
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
import { computeCallEnvelope, type CallEnvelope } from "../../src/local/envelope.js";
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

async function repository() {
  const root = mkdtempSync(join(tmpdir(), "archflow-roundtrip-"));
  roots.push(root);
  git(root, "-c", "init.defaultBranch=main", "init", "-q");
  writeFileSync(join(root, "README.md"), "repository\n");
  git(root, "add", "--", "README.md");
  git(root, "commit", "-q", "-m", "root");
  const scaffolded = await scaffoldRepositoryAssets({ working_directory: root });
  if (!scaffolded.ok) throw new Error(scaffolded.error.code);
  // The scaffolded isolation rule declares mechanical enforcement, and a model adjudicator can
  // never claim "pass" for an enforced rule (src/review/adjudication.ts), so every adjudication
  // would end at a human gate and block this driver. The fixture pins a constitution without
  // enforcement declarations instead.
  writeFileSync(join(root, ".archflow", "constitution", "20-data.md"), `---
id: task-and-evidence-isolation
version: 1
status: active
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

type RequestShape = Readonly<{ tool: string; input: Record<string, PlainJsonValue> }>;

function derivedRequest(status: TaskStatusV1): RequestShape {
  expect(status.next_action.request).toBeDefined();
  return structuredClone(status.next_action.request) as unknown as RequestShape;
}

describe("status-derived requests execute against the real handlers", () => {
  it("drives the PRD phase from create-task through the recorded self-review using only derived requests", async () => {
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
    //    the self_review running entry whose resolved request differs from the template only in
    //    the judgment fields the client filled.
    const produced = await h.status();
    expect(produced.subject_digest).toBe(produceComposed.artifact_digest);
    expect(produced.next_action).toMatchObject({
      code: "run-step", step: "self_review",
      request: { tool: "archflow_state", input: { step: "self_review", status: "running" } },
    });
    const entryRequest = derivedRequest(produced);
    entryRequest.input.intent_id = "self-review-entry-1";
    const entryResolved = await h.envelope(entryRequest as unknown as PlainJsonValue);
    expect(entryResolved.request.input).toEqual({
      ...entryRequest.input,
      input_fingerprint: entryResolved.input_fingerprint,
    });
    await h.invoke(entryResolved.request.tool, entryResolved.request.input);

    // 4. Mid-self_review: the derived action is the terminal record carrying the review
    //    artifact, authored purely from status facts — subject digest, fingerprint, and the
    //    expected provenance status now publishes.
    const midReview = await h.status();
    expect(midReview).toMatchObject({
      step: "self_review", status: "running",
      next_action: {
        code: "run-step", step: "self_review",
        detail: "Record the terminal self_review result.",
        request: { tool: "archflow_state", input: { step: "self_review", status: "succeeded" } },
      },
    });
    expect(midReview.subject_digest).toBeDefined();
    expect(midReview.expected_self_review_provenance).toBeDefined();
    const provenance = midReview.expected_self_review_provenance!;
    const rubric = {
      schema_version: "1", kind: "artifact", mode: "adversarial",
      criteria: [{ id: "scope", text: "Check scope against the ask.", blocking: true }],
    };
    const evidence: ReviewEvidence = {
      schema_version: "1",
      task_id: task,
      phase_instance: midReview.phase_instance!,
      step: "self_review",
      role: "self-review",
      subject_digest: midReview.subject_digest!,
      input_fingerprint: midReview.input_fingerprint!,
      rubric_digest: canonicalJsonDigest(rubric),
      producer_family: provenance.producer_family,
      findings: [],
      matched_rule_versions: [],
      verdict: "pass",
      blocking_count: 0,
      assurance: provenance.assurance,
      model_family: provenance.model_family,
      model: provenance.model,
      effort: provenance.effort,
    } as ReviewEvidence;
    const reviewRequest = derivedRequest(midReview);
    reviewRequest.input.intent_id = "self-review-record-1";
    reviewRequest.input.artifact = {
      schema_version: "1", artifact_kind: "review-evidence", evidence,
    } as unknown as PlainJsonValue;
    const reviewResolved = await h.envelope(reviewRequest as unknown as PlainJsonValue);
    await h.invoke(reviewResolved.request.tool, reviewResolved.request.input);

    // 5. The recorded review is durable authority: the next derived action moves on to
    //    counter_review instead of re-deriving self_review.
    const reviewed = await h.status();
    expect(reviewed).toMatchObject({ step: "self_review", status: "succeeded" });
    expect(reviewed.next_action).toMatchObject({ code: "run-step", step: "counter_review" });
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

    // create-task is the one request build-request cannot compose (no durable state yet).
    const created = await h.status();
    const createRequest = derivedRequest(created);
    createRequest.input.artifact = fixture.initialization as unknown as PlainJsonValue;
    const createResolved = await h.envelope(createRequest as unknown as PlainJsonValue);
    await h.invoke(createResolved.request.tool, createResolved.request.input);
    writeFileSync(join(fixture.root, ".archflow", "tasks", task, "ask.md"), "Build the composer proof.\n");
    writeFileSync(join(fixture.root, ".archflow", "tasks", task, "prd.md"), "# PRD\n\nComposer requirements.\n");

    // Illegal targets refuse at compose time with the transition law's own answer, and payload
    // shape errors name the expected facts.
    expect(await h.buildRequestError({ intent_id: "early-1", kind: "self-review", review: { rubric, findings: [], matched_rule_versions: [] } })).toBe("TRANSITION_INVALID");
    expect(await h.buildRequestError({ intent_id: "early-2", kind: "triage", dispositions: [] })).toBe("TRANSITION_INVALID");
    expect(await h.buildRequestError({ intent_id: "early-3", kind: "running", step: "produce" })).toBe("TRANSITION_INVALID");
    await expect(h.buildRequest({ intent_id: "early-4", kind: "running", step: "nonsense" })).rejects.toThrow(/one of produce, self_review/u);
    await expect(h.buildRequest({ intent_id: "early-5", kind: "review-everything" })).rejects.toThrow(/not recognized/u);
    await expect(h.buildRequest({ intent_id: "early-6", kind: "gate", summary: "  " })).rejects.toThrow(/summary/u);

    // Terminal produce (the pre-existing composer path).
    const produceComposed = await h.buildRequest({ intent_id: "produce-1" });
    await h.invoke(produceComposed.request.tool, produceComposed.request.input);

    // Running boundary: the composer emits the one legal entry with no payload beyond the step.
    const reviewEntry = await h.buildRequest({ intent_id: "review-entry-1", kind: "running", step: "self_review" });
    expect(reviewEntry.request.input).toMatchObject({ step: "self_review", status: "running" });
    await h.invoke(reviewEntry.request.tool, reviewEntry.request.input);

    // Terminal self-review: the caller supplies rubric, findings, and matched rules; every
    // identity, provenance, and summary field is composed from durable authority.
    const selfFinding = {
      finding_id: "scope-drift-note", severity: "minor", blocking: false,
      summary: "Scope wording drifts from the ask.", evidence: "prd.md line 3.",
      suggested_resolution: "Align the wording.",
    };
    const selfComposed = await h.buildRequest({
      intent_id: "self-review-1", kind: "self-review",
      review: { rubric, findings: [selfFinding], matched_rule_versions: [] },
    });
    const composedEvidence = (selfComposed.request.input as {
      artifact: { evidence: ReviewEvidence };
    }).artifact.evidence;
    expect(composedEvidence).toMatchObject({
      step: "self_review", role: "self-review", assurance: "agent-declared",
      rubric_digest: canonicalJsonDigest(rubric), verdict: "advisory", blocking_count: 0,
    });
    // Envelope over the composed request is a fixed point: same digests, nothing left to resolve.
    const selfReplay = await h.envelope(selfComposed.request as unknown as PlainJsonValue);
    expect(selfReplay.request_digest).toBe(selfComposed.request_digest);
    await h.invoke(selfComposed.request.tool, selfComposed.request.input);

    // Counter-review entry, then the composed archflow_counter_review call invoked for real
    // against a stub reviewer CLI on PATH (the default config routes the counter-reviewer to the
    // codex family), so the composed request must satisfy the whole dispatch pipeline.
    const counterEntry = await h.buildRequest({ intent_id: "counter-entry-1", kind: "running", step: "counter_review" });
    await h.invoke(counterEntry.request.tool, counterEntry.request.input);
    const counterComposed = await h.buildRequest({ intent_id: "counter-1", kind: "counter-review", rubric });
    expect(counterComposed.request.tool).toBe("archflow_counter_review");
    expect(counterComposed.request.input).toMatchObject({ artifact_path: "prd.md", rubric });

    const bin = join(fixture.root, "stub-bin");
    const stubHome = join(fixture.root, "stub-home");
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
    step: "adjudicate", subject_digest: subject.subject_digest, input_fingerprint: subject.input_fingerprint,
    pinned_constitution_digest: subject.pinned_constitution_digest,
    approved_upstream_digests: subject.approved_upstream_digests,
    source_evidence_set_digest: subject.source_evidence_set_digest,
    rule_findings: envelope.rules.map((rule) => ({ rule_id: rule.id, rule_version: rule.version,
      compliance: "pass",
      rationale: "Checked the retained subject.",
      trigger: "not-matched", trigger_evidence: "No review trigger matched.",
      enforced_by: rule.enforced_by.map((mechanism) => ({ mechanism, state: "current",
        subject_digest: subject.subject_digest, evidence_digest: subject.subject_digest,
        details: "Mechanically verified in fixture." })) })),
    drift_findings: subject.approved_upstream_digests.map((upstream_digest) => ({ upstream_digest, drift: "aligned", affected_claim_ids: [], rationale: "No upstream drift found." })),
    constitution: "pass",
    drift: "aligned", matched_rule_versions: [], uncertain_rule_versions: []
  };
  await writeFile(argv[argv.indexOf("-o") + 1], JSON.stringify(output) + "\\n");
  process.stdout.write('{"type":"turn.completed"}\\n');
}`);
    chmodSync(join(bin, "codex"), 0o755);
    const saved = { PATH: process.env.PATH, HOME: process.env.HOME };
    process.env.PATH = `${bin}:${saved.PATH ?? ""}`;
    process.env.HOME = stubHome;
    try {
      await h.invoke(counterComposed.request.tool, counterComposed.request.input);

      // Triage: the caller authors only dispositions; the composer binds the evidence set, slot
      // order, digests, and counts, and resolves each finding to its review mechanically.
      const triageEntry = await h.buildRequest({ intent_id: "triage-entry-1", kind: "running", step: "triage" });
      await h.invoke(triageEntry.request.tool, triageEntry.request.input);
      const triageComposed = await h.buildRequest({
        intent_id: "triage-1", kind: "triage",
        dispositions: [
          { finding_id: "scope-drift-note", disposition: "rejected", rationale: "Wording is faithful to the ask.", evidence: "ask.md line 1." },
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
      expect(triageArtifact).toMatchObject({ accepted_count: 0, rejected_count: 2 });

      // A disposition set that misses a finding refuses at compose time, before any tool call.
      await expect(h.buildRequest({
        intent_id: "triage-short", kind: "triage",
        dispositions: [{ finding_id: "scope-drift-note", disposition: "rejected", rationale: "r", evidence: "e" }],
      })).rejects.toThrow(/cover every current finding/u);
      await h.invoke(triageComposed.request.tool, triageComposed.request.input);

      // Adjudicate entry and the composed adjudicate call, also invoked against the stub.
      const adjEntry = await h.buildRequest({ intent_id: "adjudicate-entry-1", kind: "running", step: "adjudicate" });
      await h.invoke(adjEntry.request.tool, adjEntry.request.input);
      const adjComposed = await h.buildRequest({ intent_id: "adjudicate-1", kind: "adjudicate" });
      expect(adjComposed.request.tool).toBe("archflow_adjudicate");
      expect(adjComposed.request.input).toMatchObject({ artifact_path: "prd.md", upstream_paths: [] });
      await h.invoke(adjComposed.request.tool, adjComposed.request.input);

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
      if (saved.PATH === undefined) delete process.env.PATH; else process.env.PATH = saved.PATH;
      if (saved.HOME === undefined) delete process.env.HOME; else process.env.HOME = saved.HOME;
    }
  }, TIMEOUT);
});

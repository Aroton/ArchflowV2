/**
 * Executability proof for derived actions: everything status hands out — the next action, its
 * prefilled request, and the composed build-request output — must execute against the real tool
 * handlers from exactly the state it was derived in. The client fills only judgment placeholders
 * and copies resolved requests verbatim; no derived action may ever bounce with
 * TRANSITION_INVALID or INPUT_FINGERPRINT_MISMATCH.
 */
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
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
  git(root, "add", "--", ".gitattributes", ".archflow/workflow.yaml", ".archflow/constitution", ".archflow/config.yaml");
  git(root, "commit", "-q", "-m", "policy");
  const staged = await stageTaskInitialization({ working_directory: root, task_id: task });
  if (!staged.ok) throw new Error(staged.error.code);
  return { root, initialization: staged.value };
}

function harness(root: string) {
  const boundary = createToolBoundary(createToolHandlers());
  const connection = connectionContextFactory.captureStartup({
    connection_id: "connection-roundtrip",
    startup_repository_candidate: { working_directory: root },
  }).initialize({
    client: { name: "codex-mcp-client", version: "0.146.0" },
    host: "codex",
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
      expect(result.ok).toBe(true);
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
});

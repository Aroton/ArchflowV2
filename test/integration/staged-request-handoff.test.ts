/**
 * The staged-request handoff: `build-request` persists every resolved request beside the intent
 * receipt slot, the MCP call passes only the four-field staged reference, and the server
 * rehydrates the full call from disk — refusing closed, with no state change, on any digest,
 * tool, or intent disagreement. Also proves the intents directory stays sound with both file
 * kinds present: receipts and staged requests never classify as each other, and maintenance,
 * reconciliation, and pruning ignore staged bytes.
 */
import { execFileSync } from "node:child_process";
import { chmodSync, copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { connectionContextFactory, createInvocationContext } from "../../src/contracts/contexts.js";
import { parseSafeCode, parseTaskSlug } from "../../src/contracts/evidence.js";
import { parseTaskPathClaim } from "../../src/contracts/path-claims.js";
import type { PlainJsonValue } from "../../src/contracts/plain-json.js";
import { scaffoldRepositoryAssets } from "../../src/init/assets.js";
import { runBuildRequest } from "../../src/local/build-request.js";
import { runLocalCommand } from "../../src/local/commands.js";
import type { CallEnvelope } from "../../src/local/envelope.js";
import { createToolHandlers } from "../../src/mcp/handlers/index.js";
import { createToolBoundary } from "../../src/mcp/server.js";
import { resolveTaskPath } from "../../src/repository/paths.js";
import { enumerateMaintenanceRoots, pruneSupersededResultPayloads } from "../../src/state/maintenance-roots.js";
import { createProductionServices } from "../../src/state/production.js";
import { computeTaskStatus, type TaskStatusV1 } from "../../src/state/status.js";

const TIMEOUT = 120_000;
const task = parseTaskSlug("staged-task");
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

async function repository(): Promise<string> {
  const root = mkdtempSync(join(tmpdir(), "archflow-staged-"));
  roots.push(root);
  git(root, "-c", "init.defaultBranch=main", "init", "-q");
  writeFileSync(join(root, "README.md"), "repository\n");
  git(root, "add", "--", "README.md");
  git(root, "commit", "-q", "-m", "root");
  const scaffolded = await scaffoldRepositoryAssets({ working_directory: root });
  if (!scaffolded.ok) throw new Error(scaffolded.error.code);
  // No mechanical enforcement declarations, so adjudication never forces a human gate here.
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
  return root;
}

function harness(root: string) {
  const boundary = createToolBoundary(createToolHandlers());
  const connection = connectionContextFactory.captureStartup({
    connection_id: "connection-staged",
    startup_repository_candidate: { working_directory: root },
  }).initialize({
    client: { name: "claude-code", version: "2.1.220" },
    host: "claude",
    protocol_version: "2025-11-25",
  });
  let sequence = 0;

  async function services() {
    const created = await createProductionServices({
      working_directory: root, task_id: task, operation: parseSafeCode("staged-test"),
    });
    if (!created.ok) throw new Error(created.error.code);
    return created.value;
  }

  return {
    services,
    async status(): Promise<TaskStatusV1> {
      const s = await services();
      const status = await computeTaskStatus(s.dependencies, s.authority);
      if (!status.ok) throw new Error(status.error.code);
      return status.value;
    },
    async buildRequest(value: PlainJsonValue): Promise<CallEnvelope> {
      const composed = await runBuildRequest(await services(), value);
      if (!composed.ok) throw new Error(composed.error.code);
      return composed.value;
    },
    async invokeRaw(tool: string, input: PlainJsonValue): Promise<{
      ok: boolean;
      value?: Record<string, unknown>;
      error?: { code?: string; diagnostic?: { parameters?: Record<string, unknown> } };
    }> {
      sequence += 1;
      const context = createInvocationContext(connection, {
        invocation_id: `invocation-${sequence}`,
        transport_metadata: { request_id: `request-${sequence}`, operation: "tools/call" },
      }, new AbortController().signal);
      const outcome = await boundary.invoke(tool, structuredClone(input), context);
      if (outcome.kind !== "project-result") throw new Error("tool invocation failed outside the result contract");
      return outcome.result as never;
    },
    async invoke(tool: string, input: PlainJsonValue): Promise<Record<string, unknown>> {
      const result = await this.invokeRaw(tool, input);
      expect(result.ok, JSON.stringify(result.error ?? result)).toBe(true);
      return result.value as Record<string, unknown>;
    },
  };
}

function installReviewerStub(root: string): { restore: () => void } {
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
  const output = {
    schema_version: "1", task_id: subject.task_id, phase_instance: subject.phase_instance,
    step: "counter_review", role: "counter-review", subject_digest: subject.subject_digest,
    input_fingerprint: subject.input_fingerprint, rubric_digest: subject.rubric_digest,
    producer_family: subject.producer_family,
    findings: [],
    matched_rule_versions: [],
    verdict: "pass",
    blocking_count: 0
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

describe("staged-request handoff", () => {
  it("stages, rehydrates, refuses mismatches closed, replays, and keeps maintenance sound", async () => {
    const root = await repository();
    const h = harness(root);
    const intentsDir = join(root, ".archflow", "tasks", task, "intents");

    // Initialize keeps its full-payload flow: no staged field, request.input passed verbatim.
    const initComposed = await h.buildRequest({ kind: "initialize" });
    expect(initComposed.staged).toBeUndefined();
    expect((initComposed.request.input as { intent_id: string }).intent_id)
      .toMatch(/^initialize-\d{8}T\d{6}-[0-9a-f]{4}$/u);
    await h.invoke(initComposed.request.tool, initComposed.request.input);

    writeFileSync(join(root, ".archflow", "tasks", task, "ask.md"), "Build the staged handoff proof.\n");
    writeFileSync(join(root, ".archflow", "tasks", task, "prd.md"), "# PRD\n\nStaged handoff requirements.\n");

    // Generated intent ids: valid PathSafeId shape, distinct across composes, echoed everywhere.
    const generatedA = await h.buildRequest({});
    const generatedB = await h.buildRequest({});
    const idA = (generatedA.request.input as { intent_id: string }).intent_id;
    const idB = (generatedB.request.input as { intent_id: string }).intent_id;
    expect(idA).toMatch(/^produce-\d{8}T\d{6}-[0-9a-f]{4}$/u);
    expect(idB).toMatch(/^produce-\d{8}T\d{6}-[0-9a-f]{4}$/u);
    expect(idA).not.toBe(idB);
    expect(generatedA.staged?.reference.intent_id).toBe(idA);

    // An explicit intent id keeps working and names the staged file.
    const produce = await h.buildRequest({ intent_id: "produce-explicit" });
    expect((produce.request.input as { intent_id: string }).intent_id).toBe("produce-explicit");
    expect(produce.staged).toBeDefined();
    const reference = structuredClone(produce.staged!.reference) as unknown as Record<string, PlainJsonValue>;
    expect(reference).toEqual({
      schema_version: "1",
      task_id: task,
      intent_id: "produce-explicit",
      request_digest: produce.request_digest,
    });
    expect(produce.staged!.path).toBe(`.archflow/tasks/${task}/intents/produce-explicit.request.json`);
    const stagedFile = join(intentsDir, "produce-explicit.request.json");
    const stagedBytes = readFileSync(stagedFile);
    const stagedRecord = JSON.parse(stagedBytes.toString("utf8")) as {
      schema_version: string; request: { tool: string; input: unknown }; request_digest: string;
    };
    expect(stagedRecord.schema_version).toBe("1");
    expect(stagedRecord.request.tool).toBe("archflow_state");
    expect(stagedRecord.request.input).toEqual(produce.request.input);
    expect(stagedRecord.request_digest).toBe(produce.request_digest);

    const before = await h.status();
    const beforeRevision = before.revision;

    // Every mismatch fails closed with its distinct code and no state change.
    const wrongDigest = await h.invokeRaw("archflow_state", { ...reference, request_digest: "f".repeat(64) });
    expect(wrongDigest.ok).toBe(false);
    expect(wrongDigest.error?.code).toBe("STAGED_REQUEST_MISMATCH");

    const missing = await h.invokeRaw("archflow_state", { ...reference, intent_id: "never-staged" });
    expect(missing.ok).toBe(false);
    expect(missing.error?.code).toBe("STAGED_REQUEST_NOT_FOUND");

    const wrongTool = await h.invokeRaw("archflow_counter_review", { ...reference });
    expect(wrongTool.ok).toBe(false);
    expect(wrongTool.error?.code).toBe("STAGED_REQUEST_MISMATCH");
    expect(wrongTool.error?.diagnostic?.parameters?.issue_code).toBe("staged-tool-mismatch");

    // A staged file whose inner intent disagrees with the reference naming it is refused.
    copyFileSync(stagedFile, join(intentsDir, "alias-id.request.json"));
    const aliased = await h.invokeRaw("archflow_state", { ...reference, intent_id: "alias-id" });
    expect(aliased.ok).toBe(false);
    expect(aliased.error?.code).toBe("STAGED_REQUEST_MISMATCH");
    expect(aliased.error?.diagnostic?.parameters?.issue_code).toBe("staged-intent-mismatch");

    // A tampered staged file no longer matches its own recorded digest. The flipped field is
    // `status`, which the request digest's closed field list covers; the tampered input still
    // parses, so only the digest recomputation catches it.
    const tampered = structuredClone(stagedRecord);
    (tampered.request.input as { status: string }).status = "failed";
    writeFileSync(stagedFile, JSON.stringify(tampered));
    const tamperedResult = await h.invokeRaw("archflow_state", { ...reference });
    expect(tamperedResult.ok).toBe(false);
    expect(tamperedResult.error?.code).toBe("STAGED_REQUEST_MISMATCH");
    expect(tamperedResult.error?.diagnostic?.parameters?.issue_code).toBe("staged-digest-mismatch");
    writeFileSync(stagedFile, stagedBytes);

    const unchanged = await h.status();
    expect(unchanged.revision).toBe(beforeRevision);
    expect(unchanged.step).toBe(before.step);
    expect(unchanged.status).toBe(before.status);

    // The genuine reference round-trips through a real transaction.
    const statePath = join(root, ".archflow", "tasks", task, "state.json");
    const priorStateBytes = readFileSync(statePath);
    const success = await h.invoke("archflow_state", { ...reference });
    expect(success.request_digest).toBe(produce.request_digest);
    expect(success.status).toBe("succeeded");
    const committed = await h.status();
    expect(committed.revision).toBe((beforeRevision ?? 0) + 1);

    // After a full commit the reference behaves exactly like the byte-identical full payload:
    // the compare-and-set precedes receipt arbitration, so the recorded expected_revision now
    // conflicts. Replay discipline is unchanged by staging.
    const postCommit = await h.invokeRaw("archflow_state", { ...reference });
    expect(postCommit.ok).toBe(false);
    expect(postCommit.error?.code).toBe("STATE_CONFLICT");

    // The replay that must hold byte-for-byte is the interrupted-call window: receipt durable,
    // state not yet promoted. Re-presenting the same reference rehydrates the same bytes, the
    // receipt comparison holds, and the recorded outcome is returned while the commit is
    // re-promoted.
    writeFileSync(statePath, priorStateBytes);
    const replayed = await h.invoke("archflow_state", { ...reference });
    expect(replayed).toEqual(success);
    expect((await h.status()).revision).toBe((beforeRevision ?? 0) + 1);

    // A second tool through its own staged reference: counter_review entry, then the review.
    const counterEntry = await h.buildRequest({ kind: "running", step: "counter_review" });
    await h.invoke("archflow_state", counterEntry.staged!.reference as unknown as PlainJsonValue);
    const stub = installReviewerStub(root);
    try {
      const counter = await h.buildRequest({
        kind: "counter-review",
        rubric: {
          schema_version: "1", kind: "artifact", mode: "adversarial",
          criteria: [{ id: "scope", text: "Check scope against the ask.", blocking: true }],
        },
      });
      expect(counter.tool).toBe("archflow_counter_review");
      const reviewed = await h.invoke("archflow_counter_review", counter.staged!.reference as unknown as PlainJsonValue);
      expect(reviewed.request_digest).toBe(counter.request_digest);
      expect(reviewed.verdict).toBe("pass");
    } finally {
      stub.restore();
    }

    // Maintenance and reconciliation stay sound with receipts, staged requests, and even a
    // garbage staged file sharing the intents directory.
    writeFileSync(join(intentsDir, "garbage.request.json"), "not json at all");
    const services = await h.services();
    const rootsEnumerated = await enumerateMaintenanceRoots(services.dependencies, services.authority);
    expect(rootsEnumerated.ok, rootsEnumerated.ok ? undefined : rootsEnumerated.error.code).toBe(true);
    const pruned = await pruneSupersededResultPayloads(services.dependencies, services.authority);
    expect(pruned.ok, pruned.ok ? undefined : pruned.error.code).toBe(true);
    const statusWithStaged = await h.status();
    expect(statusWithStaged.blocking_reasons).not.toContain("reconciliation-unavailable");

    // The receipt reader can never be handed a staged request: the intent class refuses the
    // reserved suffix at resolution time.
    const asReceipt = await resolveTaskPath({
      runner: services.runner,
      taskId: services.authority.task_id,
      claim: parseTaskPathClaim("intents/garbage.request.json"),
      expectedClass: "intent",
      context: services.authority.context,
    });
    expect(asReceipt.ok).toBe(false);
    if (!asReceipt.ok) expect(asReceipt.error.code).toBe("PATH_INVALID");

    // --brief is a strict projection of the same computed status: position and next action
    // survive; rule text, counter-prompts, and template bodies do not.
    const fullStatus = await runLocalCommand({ command: "status", working_directory: root, task_id: task });
    const briefStatus = await runLocalCommand({ command: "status", working_directory: root, task_id: task, brief: true });
    const full = (fullStatus as { value: TaskStatusV1 }).value;
    const brief = (briefStatus as { value: Record<string, unknown> }).value;
    expect(Object.keys(brief).sort()).toEqual([
      "attempt", "blocking_reasons", "constitution", "next_action",
      "phase_instance", "revision", "state", "status", "step", "task_id",
    ]);
    expect(brief.next_action).toEqual(full.next_action);
    expect(brief.constitution).toEqual({
      digest: full.constitution!.digest,
      active_rule_ids: full.constitution!.active_rules.map((rule) => rule.id),
    });
    expect(JSON.stringify(brief)).not.toContain("Tasks are isolated from one another.");
  }, TIMEOUT);
});

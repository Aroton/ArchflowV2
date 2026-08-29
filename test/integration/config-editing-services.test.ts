import { existsSync, mkdirSync, rmSync, writeFileSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { afterAll, afterEach, describe, expect, it } from "vitest";

import { connectionContextFactory, createInvocationContext } from "../../src/contracts/contexts.js";
import { parsePathSafeId, parseSha256Digest } from "../../src/contracts/evidence.js";
import { parseToolCall, createInternalResultExpectation, validateProjectResultStructure } from "../../src/contracts/mcp-tools.js";
import { parseTaskPathClaim } from "../../src/contracts/path-claims.js";
import { openHandlerSession } from "../../src/mcp/handlers/session.js";
import { computeCallEnvelope } from "../../src/local/call-envelope.js";
import { openDurableGate, type GateOpenInput } from "../../src/state/gates.js";
import { identifyStateInitialization } from "../../src/state/initialization.js";
import { computeTaskStatus } from "../../src/state/status.js";
import { identifyTransactionRequest } from "../../src/state/request.js";
import { runStateTransaction } from "../../src/state/transaction.js";
import { createTaskWorkspace, type TaskWorkspace } from "../helpers/task-workspace.js";
import { ordinaryApprovalFacts } from "../helpers/ordinary-approval.js";
import { cleanupTemporaryRepositories, createTempRepository, git } from "../helpers/temp-repository.js";

const workspaces: TaskWorkspace[] = [];
afterEach(() => {
  for (const workspace of workspaces.splice(0)) workspace.dispose();
});
afterAll(cleanupTemporaryRepositories);

const D = (character: string) => parseSha256Digest(character.repeat(64));

/** A committed secondary repository with no ArchFlow attributes of its own. */
function secondaryRepository(label: string): Readonly<{ root: string; head: string }> {
  const repository = createTempRepository({ label: `secondary-${label}`, attributes: undefined });
  repository.write("README.md", `${label}\n`);
  repository.commitAll("root");
  return Object.freeze({ root: repository.path, head: repository.git("rev-parse", "HEAD") });
}

type Mutation = Readonly<{
  name: string;
  apply: (source: string) => string;
}>;

const MODEL_CHANGE: Mutation = {
  name: "model change",
  apply: (source) => source.replace("model: gpt-5.6-sol", "model: glm-5.4"),
};
const EFFORT_CHANGE: Mutation = {
  name: "effort change",
  apply: (source) => source.replace("effort: high", "effort: max"),
};
const SEMANTIC_REWRITE: Mutation = {
  name: "semantically equivalent rewrite",
  apply: (source) => `${source}\n# Semantically inert byte change.\n`,
};

async function workspace(label: string): Promise<TaskWorkspace> {
  const created = await createTaskWorkspace({ taskId: `config-edit-${label}`, label });
  workspaces.push(created);
  return created;
}

function configPath(current: TaskWorkspace): string {
  return join(current.root, ".archflow", "tasks", current.taskId, "config.yaml");
}

function mutateConfig(current: TaskWorkspace, mutation: Mutation): void {
  const path = configPath(current);
  const source = readFileSync(path, "utf8");
  const changed = mutation.apply(source);
  expect(changed, mutation.name).not.toBe(source);
  writeFileSync(path, changed);
}

function readTaskConfig(current: TaskWorkspace): string {
  return readFileSync(configPath(current), "utf8");
}

function stateCall(current: TaskWorkspace, intentId: string, status?: "running" | "succeeded" | "failed") {
  const state = current.services.state?.value;
  if (state === undefined) throw new Error("initialized state unavailable");
  return parseToolCall("archflow_state", {
    schema_version: "1",
    task_id: current.taskId,
    intent_id: intentId,
    expected_revision: state.revision,
    input_fingerprint: state.input_fingerprint,
    phase_instance: state.phase_instance,
    step: state.step,
    status: status ?? state.status,
  });
}

/** The minimal valid preparer: a terminal produce result for the next revision. */
async function recordTerminalResult(current: TaskWorkspace, intentId: string) {
  const parsed = stateCall(current, intentId, "succeeded");
  const state = current.services.state?.value;
  if (state === undefined) throw new Error("initialized state unavailable");
  const digest = identifyTransactionRequest(parsed, current.services.authority, state.input_fingerprint).request_digest;
  return async () => {
    const { revision: _revision, last_transition: _lastTransition, ...draft } = state;
    const success = {
      path: parseTaskPathClaim("state.json"),
      revision: state.revision + 1,
      status: "succeeded" as const,
    };
    const expectation = createInternalResultExpectation({
      schema_version: "1",
      tool: "archflow_state",
      task_id: current.taskId,
      intent_id: parsePathSafeId(intentId),
      input_fingerprint: state.input_fingerprint,
      request_digest: digest,
      result_id: `state:${String(state.revision + 1)}`,
      resulting_revision: state.revision + 1,
      success,
    });
    const result = validateProjectResultStructure(parsed, { schema_version: "1", ok: true, value: success });
    return {
      schema_version: "1" as const,
      ok: true as const,
      value: { expectation, result, next_state: { ...draft, status: "succeeded" as const } },
    };
  };
}

describe("config as an editable input", () => {
  it("reports the implicit primary first, then the declared repositories in name order, without changing the action", async () => {
    const apis = secondaryRepository("apis");
    const stripe = secondaryRepository("stripe");
    const current = await createTaskWorkspace({
      taskId: "config-edit-repository-order",
      label: "repository-order",
      configBytes: new TextEncoder().encode([
        'schema_version: "1"',
        "roles: {}",
        "repositories:",
        "  stripe:",
        `    path: ${JSON.stringify(stripe.root)}`,
        "    mode: writable",
        "  apis:",
        `    path: ${JSON.stringify(apis.root)}`,
        "",
      ].join("\n")),
      rootBytes: new TextEncoder().encode("primary repository\n"),
    });
    workspaces.push(current);

    const status = await computeTaskStatus(current.services.dependencies, current.services.authority);
    expect(status.ok, status.ok ? undefined : JSON.stringify(status.error)).toBe(true);
    if (!status.ok) return;
    expect(status.value.repositories).toEqual([
      { name: "primary", mode: "writable", location: current.root, head: git(current.root, "rev-parse", "HEAD") },
      { name: "apis", mode: "context-only", location: apis.root, head: apis.head },
      { name: "stripe", mode: "writable", location: stripe.root, head: stripe.head },
    ]);
    expect(status.value.next_action.code).toBe("run-step");
    expect(current.services.state?.value.last_seen_config?.repositories).toEqual({
      stripe: { path: stripe.root, mode: "writable" },
      apis: { path: apis.root },
    });
    expect(current.services.state?.value.last_seen_repository_bindings?.map((entry) => ({
      name: entry.name,
      declared_path: entry.declared_path,
    }))).toEqual([
      { name: "primary", declared_path: undefined },
      { name: "apis", declared_path: apis.root },
      { name: "stripe", declared_path: stripe.root },
    ]);
  });

  it("treats repository removal and same-identity relocation as informational edits and checkpoints them", async () => {
    const apis = secondaryRepository("removed-apis");
    const stripe = secondaryRepository("relocated-stripe");
    const current = await createTaskWorkspace({
      taskId: "config-edit-repository-relocation",
      label: "repository-relocation",
      configBytes: new TextEncoder().encode([
        'schema_version: "1"',
        "roles: {}",
        "repositories:",
        "  apis:",
        `    path: ${JSON.stringify(apis.root)}`,
        "  stripe:",
        `    path: ${JSON.stringify(stripe.root)}`,
        "",
      ].join("\n")),
    });
    workspaces.push(current);
    const before = await computeTaskStatus(current.services.dependencies, current.services.authority);
    expect(before.ok).toBe(true);
    if (!before.ok) return;

    const relocatedDeclaration = join(stripe.root, "context");
    mkdirSync(relocatedDeclaration);
    writeFileSync(configPath(current), [
      'schema_version: "1"',
      "roles: {}",
      "repositories:",
      "  stripe:",
      `    path: ${JSON.stringify(relocatedDeclaration)}`,
      "",
    ].join("\n"));
    const noticed = await computeTaskStatus(current.services.dependencies, current.services.authority);
    expect(noticed.ok, noticed.ok ? undefined : JSON.stringify(noticed.error)).toBe(true);
    if (!noticed.ok) return;
    expect(noticed.value.config_change).toEqual([
      { path: "repositories.apis", before: { path: apis.root } },
      { path: "repositories.stripe.path", before: stripe.root, after: relocatedDeclaration },
    ]);
    expect(noticed.value.next_action).toEqual(before.value.next_action);
    expect(noticed.value.repositories?.map((repository) => repository.name)).toEqual(["primary", "stripe"]);
    expect(noticed.value.repositories?.[1]?.location).toBe(stripe.root);

    const advanced = await runStateTransaction(
      current.services.dependencies,
      { authority: current.services.authority, call: stateCall(current, "repository-relocation", "succeeded") },
      await recordTerminalResult(current, "repository-relocation"),
    );
    expect(advanced.ok, advanced.ok ? undefined : JSON.stringify(advanced.error)).toBe(true);
    if (!advanced.ok) return;
    expect(advanced.value.state.value.last_seen_config?.repositories).toEqual({
      stripe: { path: relocatedDeclaration },
    });
    expect(advanced.value.state.value.last_seen_repository_bindings?.map((entry) => ({
      name: entry.name,
      declared_path: entry.declared_path,
    }))).toEqual([
      { name: "primary", declared_path: undefined },
      { name: "stripe", declared_path: relocatedDeclaration },
    ]);
  });

  it("fails closed when an unchanged repository path is replaced by a different identity", async () => {
    const apis = secondaryRepository("original-apis");
    const current = await createTaskWorkspace({
      taskId: "config-edit-repository-replacement",
      label: "repository-replacement",
      configBytes: new TextEncoder().encode([
        'schema_version: "1"',
        "roles: {}",
        "repositories:",
        "  apis:",
        `    path: ${JSON.stringify(apis.root)}`,
        "",
      ].join("\n")),
    });
    workspaces.push(current);

    rmSync(join(apis.root, ".git"), { recursive: true, force: true });
    writeFileSync(join(apis.root, "README.md"), "replacement identity\n");
    git(apis.root, "-c", "init.defaultBranch=main", "init", "-q");
    git(apis.root, "add", "--", "README.md");
    git(apis.root, "commit", "-q", "-m", "replacement root");

    const status = await computeTaskStatus(current.services.dependencies, current.services.authority);
    expect(status.ok).toBe(true);
    if (!status.ok) return;
    expect(status.value.config).toMatchObject({
      verified: false,
      issue: "config-invalid",
      issues: ["repositories.apis.path: repository identity changed at the unchanged declared path"],
    });
    expect(status.value.repositories).toBeUndefined();
    expect(status.value.next_action.code).toBe("inspect-state");
  });

  it("accepts a model change during revision-zero initialization and seeds it as the baseline", async () => {
    const current = await workspace("initialization");
    mutateConfig(current, MODEL_CHANGE);
    const call = parseToolCall("archflow_state", {
      schema_version: "1",
      task_id: current.taskId,
      intent_id: "reidentify-initialization",
      expected_revision: 0,
      input_fingerprint: D("0"),
      phase_instance: "prd",
      step: "produce",
      status: "running",
      artifact: current.initialization,
    });

    const result = await identifyStateInitialization(current.services.dependencies, {
      authority: current.services.authority,
      call,
    });

    expect(result.ok, result.ok ? undefined : JSON.stringify(result.error)).toBe(true);
    if (!result.ok) return;
    // The edited config becomes the first recorded last_seen_config, while config_digest stays
    // the creation-time provenance of the bytes the task was created with.
    expect(result.value.prepared_state.value.last_seen_config).toMatchObject({
      roles: { "counter-reviewer": { model: "glm-5.4" } },
    });
    expect(result.value.prepared_state.value.config_digest).toBe(current.initialization.config_digest);
  });

  it("accepts an effort change in the transaction kernel and records the edited baseline", async () => {
    const current = await workspace("transaction");
    mutateConfig(current, EFFORT_CHANGE);
    let prepared = false;
    const preparer = await recordTerminalResult(current, "transaction-edit");

    const result = await runStateTransaction(
      current.services.dependencies,
      { authority: current.services.authority, call: stateCall(current, "transaction-edit", "succeeded") },
      async () => {
        prepared = true;
        return preparer();
      },
    );

    expect(result.ok, result.ok ? undefined : JSON.stringify(result.error)).toBe(true);
    if (!result.ok) return;
    expect(prepared).toBe(true);
    expect(result.value.state.value.last_seen_config).toMatchObject({
      roles: { "counter-reviewer": { effort: "max" } },
    });
  });

  it("reports a field-level change notice after a post-commit edit without blocking anything", async () => {
    const current = await workspace("notice");
    // One commit establishes the last_seen_config baseline...
    const first = await runStateTransaction(
      current.services.dependencies,
      { authority: current.services.authority, call: stateCall(current, "notice-baseline", "succeeded") },
      await recordTerminalResult(current, "notice-baseline"),
    );
    expect(first.ok).toBe(true);

    // ...then a mid-task edit is informational only: status reports the old and new value and
    // still derives an ordinary action.
    mutateConfig(current, MODEL_CHANGE);
    const status = await computeTaskStatus(current.services.dependencies, current.services.authority);
    expect(status).toMatchObject({ ok: true, value: { config: { verified: true } } });
    if (!status.ok) return;
    expect(status.value.config_change).toEqual([
      { path: "roles.counter-reviewer.model", before: "gpt-5.6-sol", after: "glm-5.4" },
    ]);
    expect(status.value.next_action.code).toBe("run-step");
  });

  it("accepts a semantically equivalent rewrite in the internal fingerprint resolver", async () => {
    const current = await workspace("fingerprint");
    const before = current.services.state?.value;
    if (before === undefined) throw new Error("initialized state unavailable");
    mutateConfig(current, SEMANTIC_REWRITE);
    const config = await current.services.dependencies.read_config(current.services.authority.config);
    if (config.kind !== "valid") throw new Error(`mutated config was ${config.kind}`);

    const result = await current.services.dependencies.resolve_input_fingerprint({
      runner: current.services.runner,
      authority: current.services.authority,
      state: current.services.state!,
      call: stateCall(current, "fingerprint-edit"),
      live_config: config.snapshot,
      expected_input_fingerprint: before.input_fingerprint,
      context: current.services.authority.context,
    });

    expect(result.ok, result.ok ? undefined : JSON.stringify(result.error)).toBe(true);
    if (!result.ok) return;
    // Config content is no longer composed into the fingerprint: the byte edit leaves the
    // accepted value equal to the recorded one, so existing evidence keeps validating.
    expect(result.value.fingerprint).toBe(before.input_fingerprint);
  });

  it("accepts a model change while computing a local call envelope", async () => {
    const current = await workspace("envelope");
    const before = current.services.state?.value;
    if (before === undefined) throw new Error("initialized state unavailable");
    mutateConfig(current, MODEL_CHANGE);
    const call = stateCall(current, "envelope-edit");

    const result = await computeCallEnvelope(current.services, {
      tool: call.name,
      input: {
        schema_version: call.input.schema_version,
        task_id: call.input.task_id,
        intent_id: call.input.intent_id,
        expected_revision: call.input.expected_revision,
        input_fingerprint: call.input.input_fingerprint,
        phase_instance: call.input.phase_instance,
        step: call.input.step,
        status: call.input.status,
      },
    });

    expect(result.ok, result.ok ? undefined : JSON.stringify(result.error)).toBe(true);
    if (!result.ok) return;
    expect(result.value.input_fingerprint).toBe(before.input_fingerprint);
  });

  it("accepts edits to a config created with the retired producer role", async () => {
    // A config created before the producer role was removed keeps working, and editing its
    // active routes is an ordinary accepted change — tolerance for the retired key is not special.
    const producerBytes = new TextEncoder().encode('schema_version: "1"\nroles:\n  producer:\n    model: gpt-example\n    effort: high\n  counter-reviewer:\n    model: claude-opus-5\n    effort: high\n');
    const current = await createTaskWorkspace({
      taskId: "config-edit-retired-producer",
      label: "retired-producer",
      configBytes: producerBytes,
    });
    workspaces.push(current);

    const read = await current.services.dependencies.read_config(current.services.authority.config);
    expect(read).toMatchObject({ kind: "valid" });
    const call = stateCall(current, "retired-producer-edit");
    const apply = () => computeCallEnvelope(current.services, {
      tool: call.name,
      input: {
        schema_version: call.input.schema_version,
        task_id: call.input.task_id,
        intent_id: call.input.intent_id,
        expected_revision: call.input.expected_revision,
        input_fingerprint: call.input.input_fingerprint,
        phase_instance: call.input.phase_instance,
        step: call.input.step,
        status: call.input.status,
      },
    });

    const unchanged = await apply();
    expect(unchanged.ok).toBe(true);

    const source = readTaskConfig(current);
    const changed = source.replace("model: claude-opus-5", "model: claude-opus-5.1");
    expect(changed).not.toBe(source);
    writeFileSync(configPath(current), changed);
    const result = await apply();
    expect(result.ok, result.ok ? undefined : JSON.stringify(result.error)).toBe(true);
  });

  it("accepts an effort change before opening a durable gate", async () => {
    const current = await workspace("gate");
    mutateConfig(current, EFFORT_CHANGE);
    const state = current.services.state?.value;
    if (state === undefined) throw new Error("initialized state unavailable");
    const input: GateOpenInput = {
      authority: current.services.authority,
      expected_revision: state.revision,
      intent_id: parsePathSafeId("gate-edit"),
      request_digest: D("8"),
      input_fingerprint: state.input_fingerprint,
      phase_instance: state.phase_instance,
      summary: "Approve the current artifact",
      subject_digest: D("9"),
      current_evidence: {
        set_digest: D("a"),
        slots: [
          { role: "counter-review", evidence_digest: D("c"), assurance: "server-attested", producer_family: "claude", reviewer_family: "codex" },
        ],
      },
      kind: "artifact-approval",
      context: { artifact_kind: "prd", ...ordinaryApprovalFacts("prd", D("9")) },
    };

    const result = await openDurableGate(current.services.dependencies, input);

    expect(result.ok, result.ok ? undefined : JSON.stringify(result.error)).toBe(true);
    if (!result.ok) return;
    expect(existsSync(join(current.services.authority.task_root, "authority", "decisions", result.value.gate_id))).toBe(true);
    // Gate open is a config-observing commit: the edited config becomes the new baseline.
    const committed = await current.services.dependencies.read_state(current.services.authority.state);
    expect(committed).toMatchObject({
      kind: "canonical",
      document: { value: { last_seen_config: { roles: { "counter-reviewer": { effort: "max" } } } } },
    });
  });

  it("accepts a semantically equivalent rewrite in the handler session before dispatch", async () => {
    const current = await workspace("handler");
    mutateConfig(current, SEMANTIC_REWRITE);
    const state = current.services.state?.value;
    if (state === undefined) throw new Error("initialized state unavailable");
    const call = parseToolCall("archflow_counter_review", {
      schema_version: "1",
      task_id: current.taskId,
      intent_id: "handler-edit",
      expected_revision: state.revision,
      input_fingerprint: state.input_fingerprint,
      artifact_path: "prd.md",
    });
    const connection = connectionContextFactory.captureStartup({
      connection_id: "config-editing-handler",
      startup_repository_candidate: { working_directory: current.root },
    }).initialize({
      client: { name: "claude-code", version: "test" },
      host: "claude",
      protocol_version: "2025-11-25",
    });
    const context = createInvocationContext(connection, {
      invocation_id: "config-editing-handler-call",
      transport_metadata: { request_id: "config-editing-handler-request", operation: "tools/call" },
    }, new AbortController().signal);

    const session = await openHandlerSession(call, context);

    expect(session.ok, session.ok ? undefined : JSON.stringify(session.error)).toBe(true);
    if (!session.ok) return;
    expect(session.value.config).toMatchObject({ schema_version: "1" });
  });

  it("rejects a named invalid repository entry before a review handler session opens", async () => {
    const current = await workspace("invalid-repository-handler");
    writeFileSync(configPath(current), [
      'schema_version: "1"',
      "roles: {}",
      "repositories:",
      "  Bad_Name:",
      "    path: ../apis",
      "",
    ].join("\n"));
    const state = current.services.state?.value;
    if (state === undefined) throw new Error("initialized state unavailable");
    const call = parseToolCall("archflow_counter_review", {
      schema_version: "1",
      task_id: current.taskId,
      intent_id: "invalid-repository-handler",
      expected_revision: state.revision,
      input_fingerprint: state.input_fingerprint,
      artifact_path: "prd.md",
    });
    const connection = connectionContextFactory.captureStartup({
      connection_id: "config-invalid-repository-handler",
      startup_repository_candidate: { working_directory: current.root },
    }).initialize({
      client: { name: "claude-code", version: "test" },
      host: "claude",
      protocol_version: "2025-11-25",
    });
    const context = createInvocationContext(connection, {
      invocation_id: "config-invalid-repository-handler-call",
      transport_metadata: { request_id: "config-invalid-repository-handler-request", operation: "tools/call" },
    }, new AbortController().signal);

    const session = await openHandlerSession(call, context);

    expect(session.ok).toBe(false);
    if (session.ok) return;
    expect(session.error.code).toBe("CONFIG_INVALID");
    if (session.error.code !== "CONFIG_INVALID") return;
    expect(session.error.diagnostic.parameters.issues).toEqual([
      expect.stringContaining("repositories.Bad_Name"),
    ]);
  });

  it("still fails closed on an unparseable config without leaking its content", async () => {
    const current = await workspace("invalid");
    const invalidBytes = new TextEncoder().encode(
      'schema_version: "1"\nroles:\n  reviewer:\n    model: leak-me-not\n    effort: high\n',
    );
    writeFileSync(configPath(current), invalidBytes);

    const result = await runStateTransaction(
      current.services.dependencies,
      { authority: current.services.authority, call: stateCall(current, "invalid-edit") },
      async () => {
        throw new Error("an unparseable config must reject before preparation");
      },
    );

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("expected a config rejection");
    expect(result.error.code).toBe("CONFIG_INVALID");
    const serialized = JSON.stringify(result);
    expect(serialized).not.toContain("leak-me-not");
  });
});

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { sha256Bytes } from "../../src/contracts/canonical.js";
import { connectionContextFactory, createInvocationContext } from "../../src/contracts/contexts.js";
import type { ProjectResult } from "../../src/contracts/errors.js";
import { parsePathSafeId, parseSha256Digest } from "../../src/contracts/evidence.js";
import { parseToolCall } from "../../src/contracts/mcp-tools.js";
import { handleCounterReview } from "../../src/mcp/handlers/counter-review.js";
import { computeCallEnvelope } from "../../src/local/envelope.js";
import { openDurableGate, type GateOpenInput } from "../../src/state/gates.js";
import { identifyStateInitialization } from "../../src/state/initialization.js";
import { runStateTransaction } from "../../src/state/transaction.js";
import { createTaskWorkspace, type TaskWorkspace } from "../helpers/task-workspace.js";

const workspaces: TaskWorkspace[] = [];
afterEach(() => {
  for (const workspace of workspaces.splice(0)) workspace.dispose();
});

const D = (character: string) => parseSha256Digest(character.repeat(64));
const RUBRIC = {
  schema_version: "1" as const,
  kind: "artifact" as const,
  mode: "adversarial" as const,
  criteria: [{ id: "scope", text: "Check the artifact against its approved scope.", blocking: true }],
};

type Mutation = Readonly<{
  name: string;
  apply: (source: string) => string;
}>;

const MODEL_CHANGE: Mutation = {
  name: "model change",
  apply: (source) => source.replace("model: claude-opus-5", "model: claude-opus-5.1"),
};
const EFFORT_CHANGE: Mutation = {
  name: "effort change",
  apply: (source) => source.replace("effort: high", "effort: medium"),
};
const SEMANTIC_REWRITE: Mutation = {
  name: "semantically equivalent rewrite",
  apply: (source) => `${source}\n# Semantically inert byte change.\n`,
};

async function workspace(label: string): Promise<TaskWorkspace> {
  const created = await createTaskWorkspace({ taskId: `config-pin-${label}`, label });
  workspaces.push(created);
  return created;
}

function mutateConfig(current: TaskWorkspace, mutation: Mutation): Uint8Array {
  const path = join(current.root, ".archflow", "tasks", current.taskId, "config.yaml");
  const source = readFileSync(path, "utf8");
  const changed = mutation.apply(source);
  expect(changed, mutation.name).not.toBe(source);
  writeFileSync(path, changed);
  return new TextEncoder().encode(changed);
}

function stateCall(current: TaskWorkspace, intentId: string) {
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
    status: state.status,
  });
}

function expectMismatch(
  result: ProjectResult<unknown>,
  current: TaskWorkspace,
  observedBytes: Uint8Array,
): void {
  const state = current.services.state?.value;
  if (state === undefined) throw new Error("initialized state unavailable");
  expect(result.ok).toBe(false);
  if (result.ok) throw new Error("expected pinned-config mismatch");
  expect(result.error).toMatchObject({
    code: "PINNED_CONFIG_MISMATCH",
    diagnostic: {
      parameters: {
        expected_digest: state.config_digest,
        observed_digest: sha256Bytes(observedBytes),
      },
    },
  });
  const serialized = JSON.stringify(result);
  for (const configContent of ["claude-opus-5.1", "effort: medium", "Semantically inert byte change"]) {
    expect(serialized).not.toContain(configContent);
  }
}

describe("pinned-config enforcement sites", () => {
  it("rejects a model change during revision-zero initialization", async () => {
    const current = await workspace("initialization");
    const observed = mutateConfig(current, MODEL_CHANGE);
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

    expectMismatch(result, current, observed);
  });

  it("rejects an effort change in the transaction kernel before preparation", async () => {
    const current = await workspace("transaction");
    const observed = mutateConfig(current, EFFORT_CHANGE);
    let prepared = false;

    const result = await runStateTransaction(
      current.services.dependencies,
      { authority: current.services.authority, call: stateCall(current, "transaction-mismatch") },
      async () => {
        prepared = true;
        throw new Error("config drift must reject before preparation");
      },
    );

    expectMismatch(result, current, observed);
    expect(prepared).toBe(false);
  });

  it("rejects a semantically equivalent rewrite in the internal fingerprint resolver", async () => {
    const current = await workspace("fingerprint");
    const observed = mutateConfig(current, SEMANTIC_REWRITE);
    const config = await current.services.dependencies.read_config(current.services.authority.config);
    if (config.kind !== "valid") throw new Error(`mutated config was ${config.kind}`);
    const state = current.services.state;
    if (state === undefined) throw new Error("initialized state unavailable");

    const result = await current.services.dependencies.resolve_input_fingerprint({
      runner: current.services.runner,
      authority: current.services.authority,
      state,
      call: stateCall(current, "fingerprint-mismatch"),
      live_config: config.snapshot,
      context: current.services.authority.context,
    });

    expectMismatch(result, current, observed);
  });

  it("rejects a model change while computing a local call envelope", async () => {
    const current = await workspace("envelope");
    const observed = mutateConfig(current, MODEL_CHANGE);
    const call = stateCall(current, "envelope-mismatch");

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

    expectMismatch(result, current, observed);
  });

  it("rejects an effort change before opening a durable gate", async () => {
    const current = await workspace("gate");
    const observed = mutateConfig(current, EFFORT_CHANGE);
    const state = current.services.state?.value;
    if (state === undefined) throw new Error("initialized state unavailable");
    const input: GateOpenInput = {
      authority: current.services.authority,
      expected_revision: state.revision,
      intent_id: parsePathSafeId("gate-mismatch"),
      request_digest: D("8"),
      input_fingerprint: state.input_fingerprint,
      phase_instance: state.phase_instance,
      summary: "Approve the current artifact",
      subject_digest: D("9"),
      current_evidence: {
        set_digest: D("a"),
        slots: [
          { role: "counter-review", evidence_digest: D("c"), assurance: "server-attested", producer_family: "claude", reviewer_family: "codex", independence: "opposite-family" },
        ],
      },
      kind: "artifact-approval",
      context: { artifact_kind: "prd" },
    };

    const result = await openDurableGate(current.services.dependencies, input);

    expectMismatch(result, current, observed);
    expect(existsSync(join(current.root, ".archflow", "tasks", current.taskId, "decisions"))).toBe(false);
  });

  it("rejects a semantically equivalent rewrite in the handler session before dispatch", async () => {
    const current = await workspace("handler");
    const observed = mutateConfig(current, SEMANTIC_REWRITE);
    const state = current.services.state?.value;
    if (state === undefined) throw new Error("initialized state unavailable");
    const call = parseToolCall("archflow_counter_review", {
      schema_version: "1",
      task_id: current.taskId,
      intent_id: "handler-mismatch",
      expected_revision: state.revision,
      input_fingerprint: state.input_fingerprint,
      artifact_path: "prd.md",
      rubric: RUBRIC,
    });
    const connection = connectionContextFactory.captureStartup({
      connection_id: "config-pinning-handler",
      startup_repository_candidate: { working_directory: current.root },
    }).initialize({
      client: { name: "claude-code", version: "test" },
      host: "claude",
      protocol_version: "2025-11-25",
    });
    const context = createInvocationContext(connection, {
      invocation_id: "config-pinning-handler-call",
      transport_metadata: { request_id: "config-pinning-handler-request", operation: "tools/call" },
    }, new AbortController().signal);

    const result = await handleCounterReview(call, context);

    expectMismatch(result, current, observed);
    expect(existsSync(join(current.root, ".archflow", "tasks", current.taskId, "attempts"))).toBe(false);
  });
});

import { mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { connectionContextFactory, createInvocationContext } from "../../src/contracts/contexts.js";
import { createToolHandlers } from "../../src/mcp/handlers/index.js";
import { createToolBoundary } from "../../src/mcp/server.js";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("live MCP handlers", () => {
  it("registers exactly the four workflow tools", () => {
    expect(Object.keys(createToolHandlers()).sort()).toEqual([
      "archflow_counter_review",
      "archflow_gate",
      "archflow_state",
      "archflow_waiver",
    ]);
  });

  it("routes a valid call into production discovery instead of the inert TOOL_DISABLED path", async () => {
    const directory = await realpath(await mkdtemp(join(tmpdir(), "archflow-live-handler-")));
    roots.push(directory);
    const connection = connectionContextFactory.captureStartup({
      connection_id: "connection-handler-test",
      startup_repository_candidate: { working_directory: directory },
    }).initialize({
      client: { name: "codex-mcp-client", version: "0.146.0" },
      host: "codex",
      protocol_version: "2025-11-25",
    });
    const context = createInvocationContext(connection, {
      invocation_id: "invocation-handler-test",
      transport_metadata: { request_id: "request-handler-test", operation: "tools/call" },
    }, new AbortController().signal);
    const outcome = await createToolBoundary(createToolHandlers()).invoke("archflow_state", {
      schema_version: "1",
      task_id: "handler-test",
      intent_id: "intent-1",
      expected_revision: 0,
      input_fingerprint: "a".repeat(64),
      phase_instance: "phase-impl-15",
      step: "produce",
      status: "running",
    }, context);

    expect(outcome.kind).toBe("project-result");
    if (outcome.kind !== "project-result") return;
    expect(outcome.result).toMatchObject({
      schema_version: "1",
      ok: false,
      error: { code: "REPOSITORY_NOT_FOUND" },
    });
  });
});

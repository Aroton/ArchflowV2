import { mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { connectionContextFactory, createInvocationContext } from "../../src/contracts/contexts.js";
import { createToolHandlers } from "../../src/mcp/handlers/index.js";
import { createToolBoundary } from "../../src/mcp/server.js";
import { TOOL_NAMES } from "../../src/contracts/tool-names.js";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("live MCP handlers", () => {
  it("registers exactly the two semantic workflow tools", () => {
    expect(Object.keys(createToolHandlers()).sort()).toEqual([
      "archflow_apply",
      "archflow_status",
    ]);
  });

  it("routes a valid status call into production discovery instead of the inert TOOL_DISABLED path", async () => {
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
    const outcome = await createToolBoundary(createToolHandlers()).invoke("archflow_status", {
      schema_version: "1",
      task_id: "handler-test",
    }, context);

    expect(outcome.kind).toBe("semantic-result");
    if (outcome.kind !== "semantic-result") return;
    // The empty scratch directory has no ArchFlow repository, so the live handler's read fails
    // closed with the repository-not-found code inside the semantic failure envelope.
    if (outcome.result.ok) throw new Error("expected the live handler to fail without a repository");
    expect(outcome.result.error.code).toBe("REPOSITORY_NOT_FOUND");
  });

  it("never dispatches a retired low-level handler name", async () => {
    const directory = await realpath(await mkdtemp(join(tmpdir(), "archflow-live-handler-")));
    roots.push(directory);
    const connection = connectionContextFactory.captureStartup({
      connection_id: "connection-retired-handler",
      startup_repository_candidate: { working_directory: directory },
    }).initialize({
      client: { name: "codex-mcp-client", version: "0.146.0" },
      host: "codex",
      protocol_version: "2025-11-25",
    });
    const context = createInvocationContext(connection, {
      invocation_id: "invocation-retired-handler",
      transport_metadata: { request_id: "request-retired-handler", operation: "tools/call" },
    }, new AbortController().signal);
    for (const retired of TOOL_NAMES) {
      const outcome = await createToolBoundary(createToolHandlers()).invoke(retired, {
        schema_version: "1",
        task_id: "handler-test",
      }, context);
      expect(outcome.kind, retired).toBe("protocol-error");
      if (outcome.kind === "protocol-error") {
        expect(outcome.error.value.code, retired).toBe("TOOL_NOT_FOUND");
      }
    }
  });
});

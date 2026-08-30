import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { connectionContextFactory, createInvocationContext } from "../../src/contracts/contexts.js";
import { PROJECT_ERROR_DEFINITIONS } from "../../src/contracts/errors.js";
import * as mcpTools from "../../src/contracts/mcp-tools.js";
import { ADVERTISED_TOOL_NAMES, TOOL_NAMES } from "../../src/contracts/tool-names.js";
import { LOCAL_COMMANDS, runLocalCommand } from "../../src/local/commands.js";
import * as mcpServer from "../../src/mcp/server.js";
import { ADVERTISED_TOOL_CATALOGUE } from "../../src/mcp/tools.js";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const schema = (name: string): unknown =>
  JSON.parse(readFileSync(resolve(root, "src/contracts/schemas/v1", `${name}.schema.json`), "utf8"));

/**
 * The retirement negatives: the low-level tools and helper choreography are gone from the
 * advertised and local surfaces, and every path that used to reach them fails closed with a
 * safe view. Durable-record vocabulary (TOOL_NAMES, gate archives, provenance channels) stays
 * readable history — retirement removes advertisement and dispatch, not the records.
 */
describe("retired workflow surface", () => {
  it("advertises exactly the semantic pair with plain object roots", () => {
    expect([...ADVERTISED_TOOL_NAMES]).toEqual(["archflow_status", "archflow_apply"]);
    expect(ADVERTISED_TOOL_CATALOGUE.map((descriptor) => descriptor.name)).toEqual([...ADVERTISED_TOOL_NAMES]);
    for (const descriptor of ADVERTISED_TOOL_CATALOGUE) {
      expect(descriptor.description.length).toBeGreaterThan(0);
      // Hosts flatten a root-level combinator in the *input* schema; the result union
      // (success | failure) is the established semantic result shape and stays.
      const inputSchema = descriptor.inputSchema as Readonly<Record<string, unknown>>;
      expect(inputSchema.type, `${descriptor.name} input root type`).toBe("object");
      for (const combinator of ["oneOf", "anyOf", "allOf", "$ref"] as const) {
        expect(inputSchema[combinator], `${descriptor.name} input root ${combinator}`).toBeUndefined();
      }
    }
  });

  it("fails every retired or unknown tool name with the digest-only TOOL_NOT_FOUND view", async () => {
    const connection = connectionContextFactory.captureStartup({
      connection_id: "connection-retired-surface",
      startup_repository_candidate: { working_directory: root },
    }).initialize({
      client: { name: "retired-surface-test", version: "0.0.0" },
      host: "claude",
      protocol_version: "2025-11-25",
    });
    const context = createInvocationContext(connection, {
      invocation_id: "invocation-retired-surface",
      transport_metadata: { request_id: "request-retired-surface", operation: "tools/call" },
    }, new AbortController().signal);
    const boundary = mcpServer.createToolBoundary({});

    for (const name of [...TOOL_NAMES, "archflow_never_a_tool"]) {
      const outcome = await boundary.invoke(name, { schema_version: "1" }, context);
      expect(outcome.kind, name).toBe("protocol-error");
      if (outcome.kind !== "protocol-error") continue;
      expect(outcome.error.value.code, name).toBe("TOOL_NOT_FOUND");
      expect(outcome.error.value.retryable, name).toBe(false);
    }
  });

  it("reflects no raw tool name in the TOOL_NOT_FOUND view", async () => {
    const connection = connectionContextFactory.captureStartup({
      connection_id: "connection-retired-surface-digest",
      startup_repository_candidate: { working_directory: root },
    }).initialize({
      client: { name: "retired-surface-test", version: "0.0.0" },
      host: "claude",
      protocol_version: "2025-11-25",
    });
    const context = createInvocationContext(connection, {
      invocation_id: "invocation-retired-surface-digest",
      transport_metadata: { request_id: "request-retired-surface-digest", operation: "tools/call" },
    }, new AbortController().signal);
    const boundary = mcpServer.createToolBoundary({});
    const outcome = await boundary.invoke("archflow_gate", { schema_version: "1" }, context);
    expect(outcome.kind).toBe("protocol-error");
    if (outcome.kind !== "protocol-error") return;
    expect(outcome.error.value.diagnostic.parameters).toEqual({
      tool_name_digest: createHash("sha256").update("archflow_gate", "utf8").digest("hex"),
    });
    expect(JSON.stringify(outcome)).not.toContain("archflow_gate");
  });

  it("keeps no staged-request rehydration path", () => {
    expect("classifyToolCallInput" in mcpTools).toBe(false);
    expect("parseStagedRequestReference" in mcpTools).toBe(false);
    for (const exported of Object.keys(mcpServer)) {
      expect(exported).not.toMatch(/rehydrate/iu);
    }
    expect(JSON.stringify(schema("mcp-tools"))).not.toContain("stagedReference");
    expect(JSON.stringify(schema("project-error"))).not.toContain("STAGED_REQUEST_");
    for (const code of Object.keys(PROJECT_ERROR_DEFINITIONS)) {
      expect(code).not.toMatch(/^STAGED_REQUEST_/u);
    }
  });

  it("ships only the surviving local commands and rejects the retired ones at the entry", async () => {
    expect([...LOCAL_COMMANDS].sort()).toEqual([
      "automation-status", "clean", "hash", "init", "manual-status", "reconcile", "render", "restore",
      "set-commit-authority", "snapshot", "upgrade", "upgrade-adopt", "validate",
    ]);
    for (const command of ["build-request", "envelope", "decide", "commit", "status", "gate-preview"]) {
      expect(LOCAL_COMMANDS).not.toContain(command);
      await expect(runLocalCommand({ command: command as never, working_directory: root }))
        .rejects.toThrow(`unknown local command: ${command}`);
    }
  });
});

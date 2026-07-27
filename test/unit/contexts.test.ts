import { describe, expect, it } from "vitest";
import { connectionContextFactory, createInvocationContext, ProtocolContextError } from "../../src/contracts/contexts.js";

describe("transport-neutral contexts", () => {
  it("defensively copies, deeply freezes, and initializes once", () => {
    const startup = { connection_id: "connection-1", startup_repository_candidate: { working_directory: "/work/repo" } };
    const initialization = { client: { name: "Codex", version: "1.0" }, host: "codex", protocol_version: "2026-01" } as const;
    const captured = connectionContextFactory.captureStartup(startup);
    startup.startup_repository_candidate.working_directory = "/changed";
    const connection = captured.initialize(initialization);
    expect(connection.startup_repository_candidate.working_directory).toBe("/work/repo");
    expect(Object.isFrozen(connection.initialization_candidates.client)).toBe(true);
    expect(() => captured.initialize(initialization)).toThrow(ProtocolContextError);
  });
  it("retains AbortSignal identity while freezing copied transport metadata", () => {
    const connection = connectionContextFactory.captureStartup({ connection_id: "connection-2", startup_repository_candidate: { working_directory: "/work/repo" } }).initialize({ client: { name: "Claude", version: "1.0" }, host: "claude", protocol_version: "2026-01" });
    const controller = new AbortController();
    const seed = { invocation_id: "invocation-1", transport_metadata: { request_id: "request-1", operation: "tools/call" } } as const;
    const invocation = createInvocationContext(connection, seed, controller.signal);
    expect(invocation.signal).toBe(controller.signal);
    expect(Object.isFrozen(invocation.transport_metadata)).toBe(true);
    controller.abort();
    expect(invocation.signal.aborted).toBe(true);
  });
  it("rejects unbranded and spread-cloned connection contexts", () => {
    const connection = connectionContextFactory.captureStartup({ connection_id: "connection-3", startup_repository_candidate: { working_directory: "/work/repo" } }).initialize({ client: { name: "Codex", version: "1.0" }, host: "codex", protocol_version: "2026-01" });
    const seed = { invocation_id: "invocation-2", transport_metadata: { request_id: "request-2", operation: "tools/call" } } as const;
    expect(() => createInvocationContext({ ...connection } as never, seed, new AbortController().signal)).toThrow(/branded connection/);
    expect(() => createInvocationContext({ connection_id: connection.connection_id, startup_repository_candidate: connection.startup_repository_candidate, initialization_candidates: connection.initialization_candidates } as never, seed, new AbortController().signal)).toThrow(/branded connection/);
  });
});

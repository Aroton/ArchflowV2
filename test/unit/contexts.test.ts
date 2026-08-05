import type { Implementation } from "@modelcontextprotocol/server";
import { describe, expect, it } from "vitest";
import * as publicContracts from "../../src/contracts/index.js";
import { assertAuthenticInvocationContext, connectionContextFactory, createInvocationContext, parseClientImplementation, parseTransportRequestId, ProtocolContextError } from "../../src/contracts/contexts.js";

const startup = (connection_id: string) => connectionContextFactory.captureStartup({ connection_id, startup_repository_candidate: { working_directory: "/work/repo" } });
const initialization = (client: { readonly name: string; readonly version: string }) => ({ client, host: "codex", protocol_version: "2026-01" } as const);

describe("transport-neutral contexts", () => {
  it("defensively copies, deeply freezes, and initializes once", () => {
    const startupSeed = { connection_id: "connection-1", startup_repository_candidate: { working_directory: "/work/repo" } };
    const candidates = initialization({ name: "Codex", version: "1.0" });
    const captured = connectionContextFactory.captureStartup(startupSeed);
    startupSeed.startup_repository_candidate.working_directory = "/changed";
    const connection = captured.initialize(candidates);
    expect(connection.startup_repository_candidate.working_directory).toBe("/work/repo");
    expect(Object.isFrozen(connection.initialization_candidates.client)).toBe(true);
    expect(() => captured.initialize(candidates)).toThrow(ProtocolContextError);
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

  it("preserves every admitted transport request ID through parser and authentic mint", () => {
    const connection = startup("connection-request-ids").initialize(initialization({ name: "", version: "" }));
    const admitted = ["", " arbitrary \n string \u0000 ", -0, -1, Number.MIN_SAFE_INTEGER, Number.MAX_SAFE_INTEGER] as const;
    for (const [index, candidate] of admitted.entries()) {
      const parsed = parseTransportRequestId(candidate);
      expect(Object.is(parsed, candidate), String(candidate)).toBe(true);
      const invocation = createInvocationContext(connection, { invocation_id: `invocation-${index}`, transport_metadata: { request_id: parsed, operation: "tools/call" } }, new AbortController().signal);
      expect(Object.is(invocation.transport_metadata.request_id, candidate), String(candidate)).toBe(true);
      expect(Object.isFrozen(invocation)).toBe(true);
      expect(Object.isFrozen(invocation.transport_metadata)).toBe(true);
      expect(() => assertAuthenticInvocationContext(invocation)).not.toThrow();
    }
  });

  it("rejects adjacent unsafe, fractional, nonfinite, and non-JSON request IDs in both consumers", () => {
    const connection = startup("connection-bad-request-ids").initialize(initialization({ name: "client", version: "version" }));
    const rejected: readonly unknown[] = [Number.MIN_SAFE_INTEGER - 1, Number.MAX_SAFE_INTEGER + 1, 0.5, Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY, null, true, undefined, 1n, {}, [], new String("request")];
    for (const [index, candidate] of rejected.entries()) {
      expect(() => parseTransportRequestId(candidate), `${index}`).toThrow();
      expect(() => createInvocationContext(connection, { invocation_id: `invocation-bad-${index}`, transport_metadata: { request_id: candidate, operation: "tools/call" } }, new AbortController().signal), `${index}`).toThrow();
    }
  });

  it("projects full client metadata to an exact frozen arbitrary-string pair", () => {
    const sdkImplementation = {
      name: "",
      title: "Client title",
      version: " version with spaces \n and \u0000 ",
      description: "Optional SDK metadata",
      icons: [{ src: "https://example.test/icon.png", mimeType: "image/png", sizes: ["64x64"] }],
      websiteUrl: "https://example.test",
    } as const satisfies Implementation;
    // Hosts own their self-description: extra clientInfo fields are stripped, never fatal
    // (Phase 21 Amendment 2). Real Claude Code sends title/description/websiteUrl.
    const fromFull = parseClientImplementation(sdkImplementation);
    expect(fromFull).toEqual({ name: "", version: sdkImplementation.version });
    expect(Object.isFrozen(fromFull)).toBe(true);
    expect(() => parseClientImplementation({ name: "client", version: 1 })).toThrow();
    expect(() => parseClientImplementation({ name: "client" })).toThrow();

    const projected: { name: string; version: string } = { name: sdkImplementation.name, version: sdkImplementation.version };
    const parsed = parseClientImplementation(projected);
    projected.name = "changed";
    expect(parsed).toEqual({ name: "", version: sdkImplementation.version });
    expect(Object.isFrozen(parsed)).toBe(true);

    const connection = startup("connection-client-projection").initialize(initialization(parsed));
    expect(connection.initialization_candidates.client).toEqual(parsed);
    expect(connection.initialization_candidates.client).not.toBe(parsed);
    expect(Object.isFrozen(connection.initialization_candidates.client)).toBe(true);
    const fullConnection = startup("connection-full-client").initialize(initialization(sdkImplementation));
    expect(fullConnection.initialization_candidates.client).toEqual({ name: "", version: sdkImplementation.version });
  });

  it("rejects fake and spread invocation contexts and keeps the connection factory direct-only", () => {
    const connection = startup("connection-invocation-auth").initialize(initialization({ name: "client", version: "version" }));
    const invocation = createInvocationContext(connection, { invocation_id: "invocation-auth", transport_metadata: { request_id: -0, operation: "tools/call" } }, new AbortController().signal);
    expect(() => assertAuthenticInvocationContext(invocation)).not.toThrow();
    expect(() => assertAuthenticInvocationContext({ ...invocation })).toThrow(/authentic invocation/);
    expect(() => assertAuthenticInvocationContext({ invocation_id: invocation.invocation_id, connection, signal: invocation.signal, transport_metadata: invocation.transport_metadata })).toThrow(/authentic invocation/);
    expect("connectionContextFactory" in publicContracts).toBe(false);
    expect(publicContracts.createInvocationContext).toBe(createInvocationContext);
    expect(publicContracts.parseTransportRequestId).toBe(parseTransportRequestId);
    expect(publicContracts.parseClientImplementation).toBe(parseClientImplementation);
    expect(publicContracts.assertAuthenticInvocationContext).toBe(assertAuthenticInvocationContext);
  });
});

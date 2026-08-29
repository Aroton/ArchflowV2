import { z } from "zod";
import { createProtocolError, type ProtocolError } from "./errors.js";
import { assertPlainJson, type PlainJsonValue } from "./plain-json.js";

const connectionContextBrand: unique symbol = Symbol("ConnectionContext");
const invocationContextBrand: unique symbol = Symbol("InvocationContext");
const authenticConnections = new WeakSet<object>();
const authenticInvocations = new WeakSet<object>();
export interface ConnectionContext { readonly connection_id: string; readonly startup_repository_candidate: Readonly<{ readonly working_directory: string }>; readonly initialization_candidates: Readonly<{ readonly client: Readonly<{ readonly name: string; readonly version: string }>; readonly host: "claude" | "codex" | "antigravity" | "unknown"; readonly protocol_version: string }>; readonly [connectionContextBrand]: true }
export interface InvocationContext { readonly invocation_id: string; readonly connection: ConnectionContext; readonly signal: AbortSignal; readonly transport_metadata: Readonly<{ readonly request_id: string | number; readonly operation: "tools/call" }>; readonly [invocationContextBrand]: true }
export interface ConnectionContextFactory { readonly captureStartup: (seed: unknown) => Readonly<{ initialize: (candidates: unknown) => ConnectionContext }> }
export class ProtocolContextError extends Error { public constructor(public readonly protocol_error: ProtocolError) { super(protocol_error.code); this.name = "ProtocolContextError"; } }

const id = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u);
const text = z.string().min(1).max(4096).regex(/\S/u);
const version = z.string().regex(/^[A-Za-z0-9.-]{1,64}$/u);
const requestIdSchema = z.union([z.string(), z.number().int().safe()]);
// Hosts own their self-description: real clients send extra clientInfo fields (Claude Code
// 2.1.221 adds title/description/websiteUrl). Default Zod object parsing strips unknown keys,
// so the durable ConnectionContext client shape stays exactly {name, version}.
const clientImplementationSchema = z.object({ name: z.string(), version: z.string() });
const startupSchema = z.object({ connection_id: id, startup_repository_candidate: z.object({ working_directory: text }).strict() }).strict();
const initializationSchema = z.object({ client: clientImplementationSchema, host: z.enum(["claude", "codex", "antigravity", "unknown"]), protocol_version: version }).strict();
const invocationSchema = z.object({ invocation_id: id, transport_metadata: z.object({ request_id: requestIdSchema, operation: z.literal("tools/call") }).strict() }).strict();
function deepFreeze<T>(value: T): T { if (value !== null && typeof value === "object") { for (const nested of Object.values(value)) deepFreeze(nested); Object.freeze(value); } return value; }
function copy<T>(value: T): T { return structuredClone(value as PlainJsonValue) as T; }

export const connectionContextFactory: ConnectionContextFactory = Object.freeze({ captureStartup(seed: unknown) { assertPlainJson(seed, "connection startup"); const startup = deepFreeze(copy(startupSchema.parse(seed))); let initialized = false; return Object.freeze({ initialize(candidates: unknown): ConnectionContext { if (initialized) throw new ProtocolContextError(createProtocolError("INITIALIZATION_REPEATED", { connection_id: startup.connection_id })); assertPlainJson(candidates, "connection initialization"); const initialization = deepFreeze(copy(initializationSchema.parse(candidates))); initialized = true; const connection = deepFreeze({ connection_id: startup.connection_id, startup_repository_candidate: startup.startup_repository_candidate, initialization_candidates: initialization }) as ConnectionContext; authenticConnections.add(connection); return connection; } }); } });
export function createInvocationContext(connection: ConnectionContext, seed: unknown, signal: AbortSignal): InvocationContext { if (!authenticConnections.has(connection)) throw new TypeError("a branded connection context is required"); if (!(signal instanceof AbortSignal)) throw new TypeError("an AbortSignal is required"); assertPlainJson(seed, "invocation context"); const invocation = deepFreeze(copy(invocationSchema.parse(seed))); const context = Object.freeze({ invocation_id: invocation.invocation_id, connection, signal, transport_metadata: invocation.transport_metadata }) as InvocationContext; authenticInvocations.add(context); return context; }
export function parseTransportRequestId(value: unknown): string | number { assertPlainJson(value, "transport request ID"); return requestIdSchema.parse(value); }
export function parseClientImplementation(value: unknown): Readonly<{ readonly name: string; readonly version: string }> { assertPlainJson(value, "client implementation"); return deepFreeze(copy(clientImplementationSchema.parse(value))); }
export function assertAuthenticInvocationContext(value: unknown): asserts value is InvocationContext { if (value === null || typeof value !== "object" || !authenticInvocations.has(value)) throw new TypeError("an authentic invocation context is required"); }

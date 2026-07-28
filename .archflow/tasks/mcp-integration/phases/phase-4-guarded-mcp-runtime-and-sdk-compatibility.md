# Phase 4: Guarded MCP Runtime and SDK Compatibility

**Status**: COMPLETE
**Implemented**: 2026-07-27
**Task**: mcp-integration
**Goal**: Consume Phase 3's authenticated seam to implement and prove the complete inert low-level stable `2.0.0` stdio runtime.
**Requirements**: REQ-04, REQ-05, REQ-11, REQ-27, REQ-28

## Context

Phases 1–3 established the exact dependencies, durable/MCP contracts, five-tool catalogue, authentic connection and invocation contexts, and SDK-free authenticated tool boundary. Phase 4 is the first runnable MCP phase. It preserves and projects already-authenticated outcomes; full model-result production and validation remain in later dispatch/assembly phases, so this phase does not claim REQ-33.

The target is protocol `2025-11-25` with exact `@modelcontextprotocol/server@2.0.0` and exact locked `@modelcontextprotocol/core@2.0.0`. The stable packages were published at `2026-07-27T23:55Z`; the completed 2026-07-27 currency review confirmed both root packages retain MIT metadata with unchanged transition-license text, and that all consumed public exports, declarations, handler signatures, and legacy runtime behaviors remain compatible. Official guidance confirms a hand-built low-level `Server` remains on the 2025-era path unless the application explicitly opts into the modern path. Phase 4 therefore retains singleton protocol `2025-11-25` and explicitly defers protocol `2026-07-28` adoption to a later approved design. Low-level `Server` remains a documented advanced-use exception and `src/mcp/sdk-adapter.ts` remains the sole production SDK import owner. Production code must not import `@modelcontextprotocol/core`, SDK internal/private paths, or patch SDK runtime behavior. Raw framing, session policy, output queueing, and process ownership remain separate SDK-free modules using Node streams only; there is no SDK stdio/framing owner, private import/patch, or new framing dependency.

### Design Revision — 2026-07-27

Stable `2.0.0` replaced the prior prerelease target after the stop-on-drift currency gate found that server/core had completed their stable transition without changing the public surface or legacy runtime behavior Phase 4 consumes. The user approved this revision on 2026-07-27. The completed migration is limited to exact pins, lockfile, dependency-policy/notices evidence, and compatibility-probe expectations; it required no runtime architecture rewrite. Malformed-initialize canonicalization, `TOOL_DISABLED` restoration, public result projection, and post-close quarantine remain required unchanged.

Phase 4 also repairs the Phase 3 boundary in `src/mcp/server.ts`: unknown names keep existing name-first `TOOL_NOT_FOUND` precedence, but known-tool arguments are classified before handler availability. Thus malformed known inputs produce `CONTRACT_*` even with the inert registry, while a valid known call with no handler produces `TOOL_DISABLED`. Missing `tools/call.arguments` is SDK-valid and passes unchanged; the boundary receives the tagged missing candidate as `undefined` and classifies a known tool as `input-not-object`. The adapter substitutes only a present non-object `arguments` value that the SDK would reject; object arguments pass unchanged and the boundary remains the sole semantic classifier. Inert and enabled-handler fixtures include missing, present non-object, and object inputs accepted by the portable advertised schema but rejected by runtime semantics.

## What We're Building

### SDK-free module contracts

```ts
// src/mcp/framing.ts
export type IngressFrame =
  | Readonly<{ kind: "json"; value: unknown }>
  | Readonly<{ kind: "parse-error"; fatal: boolean }>;
export interface JsonLineFramer {
  readonly retainedBytes: number;
  readonly append: (chunk: Uint8Array) => void;
  readonly next: () => IngressFrame | undefined;
  readonly finish: () => IngressFrame | undefined;
}
export function createJsonLineFramer(): JsonLineFramer;

// src/mcp/send-queue.ts
export type SendSource = "direct" | "sdk" | "fallback";
export interface SendEntry {
  readonly source: SendSource;
  readonly frame: Uint8Array;
  readonly requestToken?: string;
}
export interface SendReceipt {
  readonly admitted: Promise<void>;
  readonly completed: Promise<void>;
}
export interface SendQueue {
  readonly backpressured: boolean;
  readonly enqueue: (entry: SendEntry) => SendReceipt;
  readonly close: () => Promise<void>;
}
export function createSendQueue(
  output: Writable,
  onBackpressureChange: (paused: boolean) => void,
  onFatal: () => void
): SendQueue;

// src/mcp/session.ts
export type SessionState =
  | "PRE_INIT" | "INITIALIZING" | "INIT_RESPONSE_ACCEPTED"
  | "READY" | "CLOSING" | "CLOSED";
export type RequestState = "executing" | "cancelling" | "response-queued";
export interface SessionController {
  readonly state: SessionState;
  readonly accept: (message: unknown) => readonly SessionAction[];
  readonly acceptSdkMessage: (message: unknown) => readonly SessionAction[];
  readonly onSendAdmitted: (requestToken?: string) => void;
  readonly onRouteSettled: (requestToken: string) => void;
  readonly close: () => void;
}
export function createSessionController(options: SessionOptions): SessionController;

// src/mcp/sdk-adapter.ts
export interface McpRuntimeOptions {
  readonly input: Readable;
  readonly output: Writable;
  readonly workingDirectory: string;
  readonly handlers?: ToolHandlerRegistry;
}
export type RuntimeTermination = Readonly<{
  reason: "caller-close" | "input-eof" | "input-error" | "output-error" | "protocol-fatal";
  close_failed: boolean;
}>;
export interface McpRuntimeHandle {
  readonly close: () => Promise<void>;
  readonly closed: Promise<RuntimeTermination>;
}
export function startMcpRuntime(options: McpRuntimeOptions): Promise<McpRuntimeHandle>;

// src/mcp/process-runner.ts
export interface SignalSource {
  readonly on: (signal: "SIGINT" | "SIGTERM", listener: () => void) => void;
  readonly off: (signal: "SIGINT" | "SIGTERM", listener: () => void) => void;
}
export interface ProcessBindings {
  readonly input: Readable;
  readonly output: Writable;
  readonly diagnostic: Writable;
  readonly workingDirectory: string;
  readonly signals: SignalSource;
  readonly setExitCode: (code: number) => void;
}
export type RuntimeStarter = (options: McpRuntimeOptions) => Promise<McpRuntimeHandle>;
export function runMcpProcess(bindings: ProcessBindings, start: RuntimeStarter): Promise<void>;
```

`SessionAction`/`SessionOptions` are closed SDK-free tagged unions owned by `session.ts`; they carry only normalized JSON-RPC candidates, request tokens, route decisions, authentic boundary outcomes, and lifecycle/close actions. No SDK type crosses these seams. `src/main.ts` only supplies real process bindings and `startMcpRuntime` to `runMcpProcess`.

### Framing, ledgers, and admission

The framer consumes bytes with fatal UTF-8 decoding, strips exactly one CR before LF, and treats each LF-terminated segment independently. Empty lines and malformed JSON produce fixed `-32700 Parse error`; a partial final line at EOF produces the same error and then closes. Invalid UTF-8 or a frame/retained-buffer size above 10 MiB queues that fixed error when capacity permits and then closes; otherwise it closes with bounded transport failure. At the first output `write(false)`, the runtime pauses input and stops pulling frames; the framer retains the current chunk remainder within the same 10 MiB cap, then resumes only on `drain` while open.

For syntactically valid requests, admission order is: envelope/safe-ID validity; session-lifetime seen-ID ledger; lifecycle; method/shape; boundary semantics. The outer request member allowlist is exactly `jsonrpc`, `id`, `method`, `params`; any other top-level request key is fixed `-32600 Invalid Request` rather than being silently stripped. Numeric `-0` normalizes to `0`, while string `"0"` is distinct. Every new safe request ID is added to the ledger before lifecycle/method/shape handling and remains spent after success, direct rejection, protocol/project error, cancellation, send failure, or close. The ledger caps at 65,536 IDs and 10 MiB aggregate UTF-8 canonical key bytes; exceeding either cap closes protocol-fatal before SDK/boundary work. Internal IDs are positive, monotonically increasing, non-recycled safe integers; exhaustion also closes fail-closed. “Reuse” in architecture/tests means rejection after every terminal path, including `-0` versus previously seen `0`.

Active records are separate from the seen ledger. Each retains a request token, normalized external ID, internal ID, method, route kind, tagged original name/arguments candidates, state `executing`/`cancelling`/`response-queued`, and any authentic `ToolBoundaryOutcome` plus expected projection. Missing arguments are `{present:false}`, never `undefined`. Ordinary cancellation moves an executing record to `cancelling`, rewrites to the internal ID, and retains the tombstone until the route wrapper observes its authentic signal aborted or settles; this preserves same-chunk request/cancel ordering. Response queue admission moves it to `response-queued`, making later cancellation a completed-request no-op while retaining collision/projection ownership until write admission. Close clears all records/tombstones; internal IDs are never recycled.

### Closed routing and lifecycle

| Message | `PRE_INIT` | `INITIALIZING` | `INIT_RESPONSE_ACCEPTED` | `READY` |
|---|---|---|---|---|
| Request `initialize` | Guard envelope/ID, allocate, forward SDK | Distinct unseen ID: `-32004`; seen ID: `-32600/null` | same | same |
| Request `ping` | `-32600 Invalid Request` (initialize must be first) | Allocate and pass SDK | Allocate and pass SDK | Allocate and pass SDK |
| Request `tools/list` or `tools/call` | `-32600`, echo safe ID | same | same | Apply fixed route/shape policy and forward |
| Unknown request method | `-32600`, echo safe ID | same | same | `-32601 Method not found`, echo ID |
| Notification `initialized` | ignore | ignore | synchronously mint connection, enter `READY` before next same-chunk frame | ignore |
| Notification `notifications/cancelled` | ignore malformed/unknown/completed/initialize target; route active ordinary target as above | same | same | same |
| Unknown/invalid notification | ignore; notifications never receive responses | same | same | same |
| Syntactically valid unmatched inbound response | silently drop; Phase 4 initiates no requests and never responds to a response | same | same | same |

Initialization is a transaction whose semantic validator is the public SDK. The outer guard checks only obvious JSON-RPC envelope and ID validity. Construct `Server` with `{name:"archflow-mcp", version:"0.0.0"}` and singleton supported versions, call `registerCapabilities({tools:{}})`, register documented two-argument `tools/list` and `tools/call` handlers, then connect the public `Transport` facade. Fixtures pin initialize `serverInfo` to that identity and `capabilities` to `{tools:{}}`.

A malformed initialize is forwarded for SDK validation; its SDK error is canonicalized to fixed bounded `-32602 Invalid params` with no validator prose/data. Only error-frame write admission releases the record/candidate and returns to `PRE_INIT`, requiring a new unseen ID for retry. A successful canonical initialize response advances to `INIT_RESPONSE_ACCEPTED` only on its write admission. Projection/serialization/write failure after any SDK initialize mutation is terminal close; the public compatibility probe proves malformed-then-valid behavior and the boundary between pre-mutation retry and terminal mutation failure.

After `READY`, `tools/list` params may be absent or an object whose only key is `_meta`; `{}` is therefore valid. Any own `cursor` or any key other than `_meta` is fixed `-32602` before catalogue access. `_meta` is forwarded unchanged to public SDK validation; invalid metadata is canonical bounded `-32602`, and `_meta` never enters an ArchFlow boundary input. A valid list returns the exact catalogue/order with no `nextCursor`.

For `tools/call`, params must be an object whose keys are drawn exactly from `_meta`, `task`, `name`, and `arguments`; any other key is fixed `-32602`. Missing params or missing/non-string `name` is fixed `-32602`. `_meta` and legacy `task` are preserved unchanged for SDK validation/lifting, including canonical bounded `-32602` on invalid values, but neither enters the ArchFlow argument boundary. Missing `arguments` is forwarded unchanged to the two-argument handler; its record preserves `{present:false}`, and the boundary receives only that original candidate (`undefined`). A present object `arguments` value—including one that is semantically invalid—also passes unchanged. Only a present non-object `arguments` value for a known name uses the exact surrogate `{name: <same known name>, arguments: {}}` under the internal ID, while the handler recovers and supplies the original value by `ctx.mcpReq.id`. A present non-object value with an unknown name is direct `-32602`; an unknown name with missing or object arguments reaches unchanged name-first `TOOL_NOT_FOUND` precedence. SDK validator failures for `_meta`, `task`, or the preserved request are always canonical bounded `-32602` without validator prose.

The four ArchFlow mappings are `TOOL_NOT_FOUND -32001`, `TOOL_DISABLED -32002`, `UNSUPPORTED_PROTOCOL -32003`, and `INITIALIZATION_REPEATED -32004`; each message is the code string and `data` is the complete retained authenticated `ProtocolError`. `TOOL_NOT_FOUND`/`TOOL_DISABLED` originate at the boundary, `INITIALIZATION_REPEATED` at the lifecycle guard through the authentic constructor/wrapper, and `UNSUPPORTED_PROTOCOL` has no live Phase 4 route because version mismatch counter-offers successfully, but its mapping is unit-tested exhaustively. Before a handler throws public `ProtocolError(code,message,data)`, its record retains the authentic boundary outcome/expected projection. The facade matches the SDK response to that expectation and canonicalizes from the retained authentic value—never by reauthenticating SDK data—so stable `2.0.0`'s retained legacy rewrite of `TOOL_DISABLED` to `-32602` is restored to `-32002`. Unexpected projection failure becomes fixed `-32603` associated to the record before cleanup.

Project outcomes use public `Server.projectCallToolResult`, complete `structuredContent`, one text block equal to `JSON.stringify(result)` without newline, and `isError === !result.ok`. Every output frame is `JSON.stringify` plus one LF with success key order `jsonrpc,id,result`, error order `jsonrpc,id,error`, and inner `code,message,data` when data exists.

### Output and process ownership

Every direct, SDK, or fallback frame creates an independent FIFO `SendEntry` with optional request association. The queue caps at 1,024 entries and 10 MiB aggregate queued output; a single frame also caps at 10 MiB. Overflow closes fail-closed. `SendReceipt.admitted` records a normal return from `destination.write`; request release and initialization transitions use this event. `SendReceipt.completed` records the write callback. `write(false)` still admits the current entry but pauses input/later writes; `drain` only reopens the FIFO and never completes a write. Callback error is always fatal, even after admission or drain; it rejects incomplete completion, enters `CLOSING`, and quarantines later output. Close rejects every queued/incomplete entry and removes listeners without ending/destroying caller streams. Fallback entries are associated before affected record cleanup.

After `CLOSING`, no adapter-owned state/output effect, serialization, new write, or boundary invocation occurs; late results are quarantined. Injected handlers must honor `AbortSignal`; the adapter cannot revoke private effects from a non-cooperating handler. The runtime's `closed` promise is the sole adapter-to-runner fatal/termination seam. The runner alone owns fixed once-only diagnostics (`ARCHFLOW_MCP_START_FAILED`, `ARCHFLOW_MCP_TRANSPORT_ERROR`, `ARCHFLOW_MCP_CLOSE_FAILED`) and exits: startup/unsolicited transport/protocol fatal `1`, EOF `0`, SIGINT `130`, SIGTERM `143`; first reason wins, except close failure preserves selected signal codes and otherwise yields `1`.

## Files

| Action | File | Purpose |
|--------|------|---------|
| Modify | `src/mcp/server.ts`, `test/unit/mcp-server.test.ts` | Classify known arguments before handler availability; preserve unknown-name precedence; prove inert/enabled missing/non-object/object semantic cases. |
| Create | `src/mcp/framing.ts`, `test/unit/mcp-framing.test.ts` | SDK-free strict bounded JSONL byte framing and retained-chunk behavior. |
| Create | `src/mcp/session.ts`, `test/unit/mcp-session.test.ts` | SDK-free lifecycle, routing, seen ledger, monotonic IDs, records/tombstones, and authentic expected projections. |
| Create | `src/mcp/send-queue.ts`, `test/unit/mcp-send-queue.test.ts` | SDK-free bounded FIFO, write admission/completion, backpressure, and close ownership. |
| Create | `src/mcp/sdk-adapter.ts`, `test/unit/mcp-sdk-adapter.test.ts` | Sole SDK owner, exact Server construction, public facade/handlers, initialization transaction, and outbound canonicalization. |
| Create | `src/mcp/process-runner.ts`, `test/unit/mcp-process-runner.test.ts`, `src/main.ts` | SDK-free termination/diagnostic/exit arbitration plus thin real-process binding. |
| Create | `scripts/probe-phase-4-mcp-compatibility.mjs` | Stop-on-failure currency/public-hook/mutation-boundary probe. |
| Create | `test/integration/mcp-stdio.test.ts`, `test/fixtures/mcp/runtime/*.json` | Self-built isolated live transcripts and byte-exact adversarial fixtures. |
| Create | `scripts/build-temp-helper.mjs` | Shared explicit-output temporary builder for build script and unique OS-temp integration suites. |
| Modify | `scripts/build-temp.mjs`, `scripts/smoke-temp-bundle.mjs` | Build/smoke the inert runtime under untracked temporary output. |
| Delete/Create | Phase 3/4 MCP boundary policy scripts | Replace blanket SDK prohibition with adapter-only public-import allowlist and mutation tests. |
| Modify | `package.json`, `package-lock.json` | Replace the prior prerelease server/core lock entries with exact stable `2.0.0` pins after design approval. |
| Modify | `scripts/check-dependency-policy.mjs`, `THIRD_PARTY_NOTICES.md`, `.github/workflows/ci.yml` | Update stable pin policy, unchanged MIT/transition-license evidence, notices, and exact Node verification jobs. |

Beyond the approved exact stable pin/lock/policy/notices migration, no dependency addition, contract schema, catalogue, tracked `dist`, persistence, dispatch, gate, local helper, installer, or release bundle change belongs here. `@modelcontextprotocol/core` remains lock/evidence-only and is never a production import.

## Work Breakdown

1. **Compatibility and currency gate**: Use the completed stable review and refresh it immediately before final review; prove exact public construction, malformed/retry mutation boundary, handler/projection behavior (including stable `2.0.0` legacy `TOOL_DISABLED` rewrite/restoration), custom facade, and teardown on both Node patches. Stop on drift or failed invariant.
2. **Stable pin and evidence update**: After explicit design approval, update exact server/core `2.0.0` pins in `package.json`/`package-lock.json`, stable expectations in the compatibility probe and dependency-policy check, and unchanged MIT/transition-license evidence in notices. Do not mutate stable dependencies before approval; do not add a core/internal production import.
3. **Boundary repair**: Move known argument classification before handler availability in `server.ts` and prove unknown, inert, enabled, portable/runtime semantic, and at-most-once behavior.
4. **Bounded framing**: Implement/test strict UTF-8 JSONL, CRLF/empty/partial EOF, 10 MiB caps, retained current-chunk remainder, and fatal parse/overflow behavior.
5. **Session and routing**: Implement/test closed route table, exact top-level and list/call params allowlists, SDK metadata/task preservation, initialization transaction state, lifetime ledger/caps, monotonic IDs, active/cancelling/queued records, same-chunk order, and authentic expected outcomes.
6. **Send queue**: Implement/test universal FIFO entries, 10 MiB/1,024 caps, admission versus callback completion, false/drain flow control, fatal callbacks, association, and close cleanup.
7. **SDK adapter**: Implement exact Server/capability/handler/connect order, context minting, missing-argument pass-through, present-non-object surrogate recovery, SDK `_meta`/task validation, three-domain projection, retained-authentic canonicalization, and terminal mutation failures without core/internal imports.
8. **Process/runtime assembly**: Implement runner/main/termination seam, once-only diagnostics/exits, shared temporary builder, and self-contained integration harness.
9. **Live/adversarial verification**: Complete all transcripts/races/caps, exact Node verification, second stable currency check immediately before final review, and aggregate checks.

Nine bounded work areas, including the small stable pin/evidence update, fit the implementation budget; an immediate architecture phase split is unnecessary.

## Success Criteria

- [ ] The completed stable `2.0.0` currency/public API review is reconfirmed immediately before dependency mutation and final verification; any drift or public-hook failure stops without package mutation, core/internal import, or private workaround, and no stable mutation occurs before this design revision is user-approved.
- [ ] Known malformed inputs produce `CONTRACT_*` before disabled handling; missing arguments pass unchanged, only present non-objects use a surrogate, object arguments have one semantic authority, and inert/enabled fixtures preserve unknown-name and at-most-once behavior.
- [ ] Strict framing, request/member and params allowlists, SDK `_meta`/task validation, seen-ID/internal-ID caps, normalized non-reuse, closed routing, initialization retry/terminal boundaries, cancellation tombstones, and same-chunk sequences match the pinned contracts without stripping or unbounded memory.
- [ ] Exact Server identity/capabilities/order and initialize bytes are pinned; malformed initialize can retry only after error write admission, while post-mutation projection/write failure closes.
- [ ] All four protocol mappings are unit-proven, live routes use retained authentic outcomes, stable `2.0.0` legacy `TOOL_DISABLED` rewriting is restored, and malformed-initialize canonicalization plus SDK/project/direct/fallback frames remain byte-stable with safe `-32603` containment.
- [ ] Universal bounded FIFO/framer flow control pauses/resumes input correctly and leaves no queued entry, record/tombstone, listener, pending completion, post-close adapter effect, or caller-stream destruction; projection and post-close late-result quarantine remain unchanged under stable `2.0.0`.
- [ ] Runtime termination is observable through `closed`; the SDK-free runner alone emits fixed diagnostics/exits, and main is a thin binding.
- [ ] Exact stable server/core pins, regenerated lockfile, dependency policy, unchanged-license notices, compatibility probe, and focused/full/live/policy/aggregate checks pass under exact Node `24.15.0` and `24.18.0` with no dependency beyond the approved pin transition, schema, tracked release, persistence, dispatch, or REQ-33 completion claim.

## Verification Steps

1. After user approval and immediately before stable dependency mutation, then again immediately before final verification/review, use live official/npm sources to reconfirm exact server/core `2.0.0`, the `2026-07-27T23:55Z` publication, MIT roots and unchanged transition-license text, official hand-built-Server legacy guidance, protocol `2025-11-25` support, deferred `2026-07-28` opt-in, and every consumed public declaration/runtime hook. Stop on any drift; never import core/internal surfaces.
2. Under pre-provisioned exact Node `24.15.0` and `24.18.0`, run `npm run probe:phase4-mcp-compatibility`, `npm run typecheck`, `npm run test:mcp-runtime`, `npm test`, `npm run test:contracts`, Phase 4 boundary-policy/mutation checks, `npm run build:temp`, dependency/notices checks, and `npm run check`.
3. Prove boundary precedence with inert and enabled registries: unknown names; missing arguments passed unchanged and classified as `input-not-object` for known tools; present non-object arguments through the exact surrogate; unchanged object arguments including portable-accepted/runtime-rejected semantics; valid disabled calls, valid handler results, and at-most-once invocation.
4. Exercise split Unicode, invalid UTF-8, LF/CRLF, empty/malformed/partial final lines, exactly/over 10 MiB frames and retained chunks, many-line chunks, permanent backpressure, input pause/resume, 1,024-entry/10 MiB output boundaries, drain/callback races, overflow, and close while paused.
5. Cover every routing row/state and shape: unknown top-level request keys; list params absent/empty, valid/invalid `_meta`, cursor, and other keys; call params with valid/invalid `_meta`, valid/invalid legacy `task`, unknown keys, missing arguments, present non-object arguments, and object arguments. Assert metadata/task is preserved to SDK validation/lifting but never enters the ArchFlow boundary. Also cover exact initialize serverInfo/capabilities, malformed-then-valid initialize with a new ID, SDK mutation/projection/write failures, same-chunk initialized/call and request/cancel, ping states, unexpected responses, and notification silence.
6. Reject normalized ID reuse after success, direct/project/protocol error, cancellation, send failure, and close; hit both ledger caps and internal-ID exhaustion without SDK/boundary work; prove cancelling tombstones and close cleanup.
7. Unit-test all four mapping entries and live `TOOL_NOT_FOUND`, `TOOL_DISABLED` rewrite/restoration, `INITIALIZATION_REPEATED`, project results, fallback association, exact bytes/LF, and every projection throw point without reauthentication or peer/exception prose.
8. Spawn isolated OS-temp bundles for transcripts, EOF/input/output/protocol fatal, SIGINT/SIGTERM, startup/close failure overlaps, diagnostic once-only behavior, exit codes, stdout purity, cleanup, and absence of `.tmp` prerequisites or tracked `dist`.

---
*Designed: 2026-07-27*

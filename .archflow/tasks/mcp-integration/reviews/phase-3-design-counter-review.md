# Phase 3 Design Counter-Review

The design still has substantive issues. The exact `@modelcontextprotocol/server@2.0.0-beta.5` tarball and tagged upstream sources were checked on 2026-07-27 in addition to the PRD, architecture, Phase 2 design/log, current contracts, schemas, and dependency-policy code.

## Findings

### 1. Initialize cancellation can strand the lifecycle after SDK identity has already mutated

**Severity:** major

The design says every active request ID is normalized and every cancellation notification is translated through that map (lines 151–155, 184, 188, and 203–208), but it never carves out the initialize request. MCP 2025-11-25 says a client must not cancel initialize and invalid cancellation notifications should be ignored. Beta.5 does not enforce that method restriction: its cancellation handler aborts whichever request controller matches the supplied ID. In a same-buffer `initialize` followed by `notifications/cancelled` race, beta.5 can set negotiated version/client identity and then suppress the initialize response. The guard therefore never observes the success response that moves it out of `INITIALIZING`, leaving a mutated SDK identity behind a permanently wedged adapter state. This is distinct from the falsey-ID defect the design already handles. See the [MCP cancellation rules](https://modelcontextprotocol.io/specification/2025-11-25/basic/utilities/cancellation) and beta.5's tagged [`Protocol` implementation](https://github.com/modelcontextprotocol/typescript-sdk/blob/%40modelcontextprotocol/server%402.0.0-beta.5/packages/core-internal/src/shared/protocol.ts).

**Suggested resolution:** Make request-map records method-aware. Explicitly ignore/drop cancellation targeting the active initialize request without changing lifecycle or releasing its mapping, and add a same-buffer initialize-plus-cancel fixture that must still emit exactly one initialize response and proceed through `initialized` to `READY`.

### 2. Beta.5 validates the outer call before the designed known-tool error boundary can run

**Severity:** major

Lines 139–147 and 205 require a known tool whose arguments are non-plain JSON or not an object to return the closed project `CONTRACT_INVALID/input-not-object` result. Lines 137 and 231 simultaneously leave outer malformed `tools/call` parameters on the SDK path. Beta.5's low-level `Server._wrapHandler` validates the complete `CallToolRequest` before invoking the registered handler, and its schema requires `arguments` to be a record. The SDK therefore returns `InvalidParams` before `ToolBoundary.invoke`, making the first classification-table row unreachable through normal registration. Its error message is also `Invalid tools/call request: ${validatedRequest.message}`, so a malformed-name call returns `-32602` with the formatted validator issue/path text despite the no-parser-text criterion. See beta.5's tagged [`Server._wrapHandler`](https://github.com/modelcontextprotocol/typescript-sdk/blob/%40modelcontextprotocol/server%402.0.0-beta.5/packages/server/src/server/server.ts).

**Suggested resolution:** Pin an adapter/guard precedence table before SDK validation. At minimum, missing/non-string names need a fixed bounded SDK-domain `InvalidParams`, while a known string name with invalid/non-object `arguments` must be routed to the boundary if the project-result table is retained. Also state the precedence for an unknown string name combined with malformed arguments. Add byte-exact fixtures for absent params, absent name, non-string name, unknown name plus malformed arguments, and each known-tool malformed-arguments class.

### 3. Beta.5 does not expose the “actual 2025 ListToolsResult parser” required by the design

**Severity:** major

Lines 157, 166, 176, 186, 196, and 229 repeatedly make acceptance depend on parsing the catalogue with beta.5's “actual 2025” list-result parser. The public SDK/core schema surface is the neutral model; beta.5 deliberately keeps its revision-specific wire codecs and validators internal. Importing `@modelcontextprotocol/core/internal` or reaching `codecForVersion` would violate the public-hook compatibility gate and create another unstable dependency seam. As written, the contract test and success criterion are not implementable using the allowed public API. The SDK's tagged [`specTypeSchemas` source](https://github.com/modelcontextprotocol/typescript-sdk/blob/%40modelcontextprotocol/server%402.0.0-beta.5/packages/core-internal/src/types/specTypeSchema.ts) documents the neutral-versus-wire distinction.

**Suggested resolution:** Require the public neutral `ListToolsResult` schema for direct catalogue validation, and prove 2025 wire compatibility through the live pinned low-level `Server` transcript, which exercises the internal negotiated codec without importing it. Rename every “actual 2025 parser” criterion accordingly and add an explicit prohibition on internal SDK imports.

### 4. “Fresh stock Ajv 2020” cannot compile the projected closure as specified

**Severity:** major

Lines 157, 196, and 229 require every descriptor to compile in a fresh stock Ajv 2020 instance with no additional registrations. The exact schema closure includes `gate-decision.schema.json`, whose `recordedAt` definition uses `format: "date-time"`. Strict Ajv 2020 treats that format as unknown unless the separately pinned `ajv-formats` plugin is installed; stripping only `x-archflow-*` does not change it. The advertised-schema acceptance criterion will therefore fail before any instance corpus is evaluated.

**Suggested resolution:** Define the portability validator as fresh strict Ajv 2020 plus the pinned `ajv-formats` standard-format plugin, with no ArchFlow schemas or custom keywords, or deliberately remove/rewrite `format` during projection and classify the lost constraint as runtime-only. Add a test proving the selected validator setup from an empty registry.

### 5. Shutdown quarantine omits writes already blocked inside `StdioServerTransport.send()`

**Severity:** major

Lines 155, 188, 208, and 234 require close to clear listeners, resolve without waiting for arbitrary work, and prevent every late frame. In beta.5, a `StdioServerTransport.send()` whose `Writable.write()` returns `false` installs per-send `error` and `drain` listeners. `StdioServerTransport.close()` removes its long-lived stream listeners and clears its read buffer, but it neither cancels pending sends nor removes those per-send listeners. Closing the guard can therefore leave a pending write/listeners behind, and a later drain can complete a frame after the runtime entered `CLOSING`. The injected `Writable` interface does not establish that the runtime may destroy the caller-owned stream. See beta.5's tagged [`StdioServerTransport`](https://github.com/modelcontextprotocol/typescript-sdk/blob/%40modelcontextprotocol/server%402.0.0-beta.5/packages/server/src/server/stdio.ts).

**Suggested resolution:** Define an outbound-write ownership contract and add a permanently backpressured `Writable` fixture. Either use a transport implementation whose pending sends are adapter-owned and cancellable, or explicitly grant/encode stream-destruction ownership and prove close settles/removes all pending write listeners without a post-close frame. If neither is possible through public beta.5 hooks, the compatibility gate must stop for approval rather than claiming quarantine.

### 6. Exact request-ID preservation omits negative zero

**Severity:** major

Lines 133, 153, 198, 204, 213, and 233 adopt every number accepted by beta.5's `z.number().int()` and promise exact parsed-value restoration, but never address `-0`. `JSON.parse("-0")` produces JavaScript negative zero and beta.5 accepts it; `Map` key equality treats `-0` and `0` as the same key, while `JSON.stringify(-0)` emits `0`. The proposed bijection therefore cannot be both collision-free for parsed numeric identity and exactly restore negative zero through `StdioServerTransport`.

**Suggested resolution:** With explicit approval, define JSON-RPC numeric `-0` as normalized/protocol-equivalent to `0` and narrow the exact-preservation language, or choose a wire representation/serializer that actually preserves the distinction. Add `Object.is`-based parser tests plus live `-0`/`0` collision, response, cancellation, and reuse fixtures.

### 7. The “exact SDK-free exports” omit the constructors needed to mint authentic contexts

**Severity:** major

The adapter chunk is responsible for connection and invocation minting (lines 151, 168, and 188), but the supposedly exact inter-chunk export list at lines 18–131 exposes only parsers and `assertAuthenticInvocationContext`. In the current code, `createInvocationContext` is in the public barrel, while the one-shot `connectionContextFactory` is exported only from `src/contracts/contexts.ts` and intentionally absent from that barrel. The design neither pins those existing imports as part of the adapter seam nor introduces an adapter-only context-mint interface. It also does not pin whether the adapter extracts only `name` and `version` from beta.5's full `ImplementationSchema` before calling `parseClientImplementation`; passing the SDK-valid object through directly would encounter optional `title`, `icons`, `websiteUrl`, and `description` fields that the current strict context shape does not accept. Independent implementation of chunks 2 and 5 can therefore diverge on access, one-shot timing, and valid metadata projection.

**Suggested resolution:** Extend the pinned seam inventory to name the exact existing context constructors the adapter consumes, their module ownership, the explicit full-implementation-to-`{name, version}` projection, and the call order from startup capture through initialize response, initialized notification, and per-call invocation creation. Test every optional beta.5 implementation metadata field. Preserve the non-public mint boundary; do not solve this by broadly exporting the connection factory from `src/contracts/index.ts`.

### 8. The phase is too large for one implementation session despite having only seven nominal chunks

**Severity:** major

Chunk 5 alone combines a custom transport wrapper, six-state lifecycle, initialization interception, ID bijection, cancellation routing, context minting, three-domain error projection, shutdown ordering, and late-settlement quarantine. Chunk 3 is a cyclic eight-schema resolver and portability corpus; chunk 4 adds a second identity-backed authority subsystem; chunk 6 is effectively a full adversarial protocol matrix rather than a bounded verification step. The file table spans contract-owner changes, three new runtime modules, dependency/license policy, build smoke, CI, and multiple unit/contract/integration suites. The risk is not raw file count: the SDK race/backpressure findings above show that the adapter will require iterative live-spike work before the broad matrix can pass. This exceeds the phase-implementation budget described by the ArchFlow skill even with delegation.

**Suggested resolution:** Split the architecture phase, with explicit user approval, at a stable seam—for example (a) dependency admission, Phase 2 seam extensions, portable catalogue, and SDK-free tool boundary; then (b) guarded beta.5 transport, lifecycle/cancellation/error projection, process entry, and live protocol fixtures. Each resulting phase should own its corresponding tests and leave no half-adopted runtime entry.

### 9. Transition-license evidence omits the separately locked core package

**Severity:** minor

The file plan retains and digest-checks only `@modelcontextprotocol/server@2.0.0-beta.5`'s transition license (lines 170–171 and 190), but that package has an exact runtime dependency on `@modelcontextprotocol/core@2.0.0-beta.5`. Both registry tarballs contain the same MIT/Apache transition `LICENSE` (SHA-256 `0382b0057770ca05e9c350a50aa3b1c1fea84da0bc81d723bf00b9aa841be58a`), while npm metadata labels both simply MIT. A lock-visible SPDX check plus one server-only retained mapping does not prove the core package's applicable transition text was reviewed.

**Suggested resolution:** Map both exact server and core identities to the retained license asset (or retain both files), digest-check both installed/tarball sources, and mutation-test that either missing mapping fails. Keep Phase 4 responsible for bundle-component attribution, but make Phase 3's admitted lock evidence complete for both MCP runtime packages.

### 10. “Unsupported cursor” has no pinned wire behavior

**Severity:** minor

Chunk 6 says to test an unsupported `tools/list` cursor (line 189), but the boundary and error matrix never say whether a cursor is ignored, returns a fixed SDK `InvalidParams`, or uses another response. Beta.5 accepts the cursor structurally, so this is application policy rather than an automatic SDK result. Different implementations can satisfy the rest of the design while producing incompatible transcripts.

**Suggested resolution:** Pin the post-`READY` `tools/list` request contract: accept absent params/empty params, state the exact behavior for a present cursor, and add the corresponding byte-stable transcript and zero-boundary-call assertion.

## Triage

1. **Initialize cancellation — accepted.** The guarded runtime design will make active request records method-aware and ignore cancellation targeting the active `initialize` request without releasing its mapping or changing lifecycle. A same-buffer initialize-plus-cancel fixture will require one initialize response followed by a successful `initialized` transition to `READY`.

2. **`tools/call` validation precedence — accepted.** The guarded runtime will own a pre-SDK precedence table so raw SDK validator text cannot escape. Missing params or a missing/non-string name will receive a fixed bounded SDK-domain `InvalidParams`; an unknown string name combined with malformed arguments will also receive that outer-call error; a known name with missing/non-object/otherwise invalid arguments will reach the frozen tool boundary and its closed `CONTRACT_*` classification; an unknown name with structurally valid arguments will receive `TOOL_NOT_FOUND`.

3. **Public list-result validation — accepted with a proof correction.** The catalogue phase will validate through the public neutral `specTypeSchemas.ListToolsResult`, enforce the explicit object-root and other frozen-2025 subset invariants itself, and use a live negotiated transcript only to prove the emitted 2025 wire object. It will explicitly prohibit imports from SDK internal codec/schema paths and will not claim that the live server validates `tools/list` output.

4. **Ajv portability setup — accepted.** “Fresh stock” will mean strict `ajv@8.20.0` plus the already pinned `ajv-formats@3.0.1`, with an otherwise empty registry and no ArchFlow schemas or custom keywords. An empty-registry compile fixture will pin this setup.

5. **Backpressured stdio teardown — partially accepted.** The ownership/listener gap is real: beta.5 can leave per-send listeners and a pending promise after close on a permanently backpressured stream. The finding overstates the `drain` mechanism, because `write()` already accepted the bytes and `drain` settles that send rather than initiating another write. The guarded runtime design will introduce an adapter-owned cancellable `Writable` bridge, promise no new destination write after `CLOSING`, allow bytes already accepted by the caller-owned destination to flush, remove bridge/SDK-facing listeners without destroying the caller stream, and stop at the compatibility gate if public hooks cannot prove that scoped contract.

6. **Negative zero — accepted.** The guarded runtime design will normalize numeric `-0` to protocol-equivalent `0`, narrow exact-preservation language accordingly, and treat concurrent `-0`/`0` as duplicate numeric ID reuse. `Object.is` parser tests and live response/cancellation/reuse fixtures will pin the behavior; approval of that phase design will be the explicit approval for this normalization.

7. **Context constructor seam — accepted.** The phase boundary will name direct adapter imports of the non-barrel `connectionContextFactory` and `createInvocationContext`, keep the connection mint non-public, project the SDK implementation object explicitly to `{ name, version }`, and pin startup capture → initialize response → one `initialized` mint → per-call invocation ordering. Optional SDK metadata fields will be covered by fixtures.

8. **Phase sizing — accepted; architecture approval required.** The current Phase 3 exceeds the implementation budget even with delegation. The proposed split is Phase 3, **MCP Contract Boundary and Dependency Admission**, followed by Phase 4, **Guarded MCP Runtime and SDK Compatibility**. The current Offline Bundle phase and all later phases shift by one. No architecture or design revision will be made until the user explicitly approves this second split; approval authorizes planning only, not implementation.

9. **Core transition-license evidence — accepted.** Phase 3 will map both exact `@modelcontextprotocol/server@2.0.0-beta.5` and `@modelcontextprotocol/core@2.0.0-beta.5` identities to the reviewed byte-identical transition-license asset, verify both source digests, and mutation-test that either missing mapping fails. Distributed bundle attribution remains in the later offline-bundle phase.

10. **`tools/list` cursor behavior — accepted.** The guarded runtime will accept absent or empty params, return the full fixed catalogue without `nextCursor`, and reject any present cursor—including `""`—with fixed bounded `-32602 Invalid params`, no cursor echo, and zero catalogue/boundary invocation. Byte-stable transcripts will pin the policy.

## Human scope adjustment

After triage, the user explicitly narrowed Phase 3 legal admission to checking only the exact server and core root package-declared licenses against the existing allowed-license policy and recording those two root entries. This supersedes finding 9's retained transition-license evidence plan and any later proposal for tarball, embedded-component, documentation-class, or forensic legal inventory in Phase 3. Phase 5 independently owns legal completeness for the distributed bundle.

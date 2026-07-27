## Implementation Log: Phase 3 - MCP Contract Boundary and Dependency Admission

### Decisions Made

- Admitted exact direct `@modelcontextprotocol/server@2.0.0-beta.5` with exact locked `@modelcontextprotocol/core@2.0.0-beta.5` only after rechecking both root identities, root `MIT` declarations, protocol `2025-11-25`, the required public declarations, and current upstream beta/deprecation guidance. The dependency policy admits only those two MCP package identities and continues to reject later-phase MCP adapters/frameworks and runtime dependencies.
- Kept every production contract and MCP boundary module SDK-free. Public-root `specTypeSchemas.RequestId` and `specTypeSchemas.ListToolsResult` are test-only agreement oracles; the Phase 3 catalogue and handler boundary import only ArchFlow-owned contracts.
- Used one internal request-ID schema for both `parseTransportRequestId` and authentic invocation minting, preserving arbitrary strings and every finite safe integer including negative values and `-0`. Used one exact client-implementation schema for both its parser and direct-only connection mint, requiring the future adapter to project SDK metadata to `{ name, version }` first.
- Added failure-only structural authentication without granting success authority. `validateProjectFailureStructure` defensively reparses, copies, freezes, and identity-registers only closed known-tool failures.
- Materialized each advertised tool as a standalone JSON Schema 2020-12 object with an exact eight-document local `$defs` closure. Projection removes document identifiers and ArchFlow-only semantic keywords while retaining every portable branch; an explicit input/output corpus records each validation rule intentionally retained only by the Phase 2 runtime.
- Made the SDK-free handler boundary own exact input classification and safe outcome construction. Boundaries, protocol-error wrappers, project/protocol outcomes, and copied registries are frozen and authenticated by private identity sets; handler exceptions and malformed or substituted outputs reduce to correlation-only `INTERNAL_ERROR` failures.

### Deviations from Plan

- The integrated fresh-context review found that the first catalogue corpus covered only path byte length and rubric uniqueness and never exercised output schemas. The implementation added input/output-aware fixtures for MCP waiver/task and current-evidence relations, gate-context relations, project-error path byte limits, and sorted-unique error paths, plus an exact category-coverage assertion. Production catalogue behavior did not change.
- The optional cross-client implementation counter-review found three major contract/test gaps and one minor CI enforcement gap. All were accepted: failure diagnostics with a `tool` field are now correlated to the selected tool; waiver success reuses the shared safe-positive rule-version bound; the classified corpus now covers every removed validating keyword branch and call-correlated output; and the Phase 3 SDK-free control is an executable scanner with mutation tests rather than a partial grep.
- Exhaustive output-corpus work exposed an adjacent runtime omission: gate success reparsed decision envelopes but did not validate decision payload semantics against the authentic gate context. `successFor` now calls `validateGateDecision` before accepting a gate result, covering waiver eligibility, adjudication resolution order/coverage, and restore-adoption authority.
- Fixing the normative/runtime agreement required adding `src/contracts/schemas/v1/mcp-tools.schema.json` and the Phase 3 boundary-policy scripts to the implementation file set. This corrects the approved contract rather than expanding the Phase 3 runtime surface.
- No architectural scope, public interface, PRD requirement, or later phase changed. Phase 3 added no SDK adapter, transport, lifecycle, runnable server, tracked release payload, persistence, dispatch, durable gate lifecycle, or legal inventory beyond the two approved root notice entries.

### Patterns Established

- MCP SDK compatibility is proven at test boundaries through public package exports. Production contract and catalogue code does not import SDK types or runtime values; Phase 4 owns the isolated adapter seam.
- Trust-bearing wrappers use owner-private object identity in addition to frozen validated structure. Casts, structural fakes, serialized copies, and spread clones do not acquire authority.
- Portable advertised schemas are closed standalone projections of normative schemas. Every removed validating semantic keyword must have a named corpus case proving portable acceptance and runtime rejection; annotations are asserted absent but are not misrepresented as validation rules.
- Handler boundaries copy the registry, validate before invocation, invoke at most once, revalidate returned data, copy/freeze accepted results, and replace raw exceptions or malformed output with bounded correlation-only failures.
- A project failure is tool-neutral only when its validated diagnostic has no `tool` parameter. Any present binding must match the selected tool before structural authenticity can be granted.

### Gotchas

- Zod's safe-integer parser preserves JavaScript negative zero, but JSON serialization does not. Phase 3 preserves `-0` in process; Phase 4 remains responsible for the approved wire normalization to `0` and duplicate `-0`/`0` handling.
- The public SDK `specTypeSchemas` surface is neutral rather than a revision-specific wire codec. Phase 3 uses it only for neutral `RequestId` and `ListToolsResult` agreement; live negotiated 2025 wire proof remains Phase 4.
- Removing `x-archflow-*` keywords makes the advertised schema portable but deliberately moves several cross-field rules out of the portable validator. The classified corpus must evolve whenever the exact eight normative schemas add or remove such validating semantics.
- Schema projection tests must exercise both failure and success outputs. Successful outputs require a companion authentic parsed call so call-dependent state, gate, and waiver correlations are actually evaluated.
- The ambient shell uses Node `24.11.1`, below the supported floor. Exact Node packages placed first on `PATH` were required to run clean-install verification under `24.15.0` and `24.18.0` with npm `11.11.0`.

### Key Interfaces

- `src/contracts/contexts.ts`: `parseTransportRequestId(value: unknown): string | number`, `parseClientImplementation(value: unknown): Readonly<{ name: string; version: string }>`, `createInvocationContext(...)`, and `assertAuthenticInvocationContext(value: unknown): asserts value is InvocationContext`; `connectionContextFactory` remains a direct-only export from this module.
- `src/contracts/mcp-tools.ts`: `validateProjectFailureStructure<K extends ToolName>(name: K, value: unknown): StructurallyValidProjectResult<K>` authenticates only a closed failure for the selected known tool; `validateProjectResultStructure` applies the same diagnostic-tool correlation and validates gate decisions against the authentic gate context.
- `src/mcp/tools.ts`: `AdvertisedToolDescriptor` and `ADVERTISED_TOOL_CATALOGUE` are the exact supported direct imports for Phase 4; there is no `src/mcp/index.ts` or contract-barrel/package re-export.
- `src/mcp/server.ts`: `ToolHandler<K>`, `ToolHandlerRegistry`, `AuthenticatedProtocolError`, `ToolProjectOutcome`, `ToolBoundaryOutcome`, `ToolBoundary`, `authenticateProtocolError`, `createToolBoundary`, `assertAuthenticToolBoundary`, and `assertAuthenticToolBoundaryOutcome` define the frozen authenticated SDK-free execution boundary.
- `package.json` and `package-lock.json`: exact direct server beta.5 and exact locked core beta.5 with Node `>=24.15.0`; `scripts/check-dependency-policy.mjs` and `scripts/check-notices.mjs` enforce their identities, licenses, and notice presence.
- `scripts/check-phase-3-mcp-boundary.mjs` and `scripts/test-phase-3-mcp-boundary-policy.mjs`: scan all production TypeScript for any MCP SDK reference, reject premature Phase 4/5 paths, and mutation-test static, type, side-effect, dynamic, and re-export forms.

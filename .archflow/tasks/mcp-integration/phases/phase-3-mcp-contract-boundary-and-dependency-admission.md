# Phase 3: MCP Contract Boundary and Dependency Admission

**Status**: DESIGNED
**Task**: mcp-integration
**Goal**: Admit the exact MCP dependency surface and freeze a complete SDK-free five-tool catalogue and authenticated handler/error boundary for a later transport owner.
**Requirements**: REQ-04, REQ-05, REQ-11, REQ-27, REQ-33

## Context

Phase 2 established the normative five-tool contracts, closed project/protocol errors, and authentic immutable connection and invocation contexts without adopting MCP. Phase 3 adds the smallest MCP-facing contract layer that can be exercised entirely in process. The SDK adapter, transport, lifecycle, cancellation, process entry, and live transcript remain Phase 4; release packaging remains Phase 5.

The dependency target is exact `@modelcontextprotocol/server@2.0.0-beta.5`, exact locked `@modelcontextprotocol/core@2.0.0-beta.5`, and protocol `2025-11-25`. Before changing the package or lock, implementation must recheck the package identities, protocol support, maintenance/deprecation guidance, and these public exports/declarations: root `Server`, `StdioServerTransport` from `@modelcontextprotocol/server/stdio`, singleton `supportedProtocolVersions`, method-string request handlers and request signal, `Server.projectCallToolResult`, `close`, and root `specTypeSchemas` with `ListToolsResult` and `RequestId`. Tests import the neutral schemas exactly as `import { specTypeSchemas } from "@modelcontextprotocol/server"`; core-root and internal schema imports are not substitutes.

Phase 3 legal admission is deliberately shallow. Before dependency mutation, verify only that the exact server and core root packages each declare `MIT`, confirm `MIT` remains allowed by existing license policy, and record both root entries in the existing dependency notices. If either root declaration is not `MIT` or is no longer allowed, leave dependency changes unmade and return for phase-design review. Phase 3 performs no tarball-level, transitive, embedded-component, documentation-classification, or bundle-wide legal audit. Phase 5 independently owns legal completeness for the distributed bundle. Phase-design approval is not commit authorization; implementation still requires the workflow's separate explicit commit gate.

## What We're Building

Phase 3 extends the contract layer with one shared internal request-ID schema consumed by both `parseTransportRequestId` and authentic `createInvocationContext`. It accepts arbitrary strings and finite safe integers, including negative integers, `-0`, `Number.MIN_SAFE_INTEGER`, and `Number.MAX_SAFE_INTEGER`; rejects adjacent unsafe integers, fractions, and nonfinite/non-JSON values; and preserves admitted JavaScript values exactly. Phase 4 owns wire mapping and `-0` normalization.

One shared internal client-implementation schema is consumed by `parseClientImplementation` and direct-only `connectionContextFactory.initialize`. It accepts and freezes exact `{ name, version }` with arbitrary strings. Phase 4 must project a full SDK Implementation object to exact `{ name, version }` before either consumer, discarding optional SDK metadata. Parser-to-mint fixtures prove admitted request IDs and client strings survive unchanged into authentic frozen contexts.

The interoperating contract exports are:

```ts
export function validateProjectFailureStructure<K extends ToolName>(
  name: K,
  value: unknown
): StructurallyValidProjectResult<K>;

export function parseTransportRequestId(value: unknown): string | number;

export function parseClientImplementation(value: unknown): Readonly<{
  readonly name: string;
  readonly version: string;
}>;

export function assertAuthenticInvocationContext(
  value: unknown
): asserts value is InvocationContext;
```

`validateProjectFailureStructure` accepts only a closed `ok: false` project result, reparses/freezes it, and registers it in the existing structural-result identity owner; it cannot mint a success. `src/contracts/index.ts` remains contract-only. It exports the failure validator, candidate parsers, invocation constructor, and invocation assertion, but not `connectionContextFactory`, which remains a deliberate direct import from `src/contracts/contexts.ts`.

`src/mcp/tools.ts` is the supported direct catalogue import for Phase 4 and owns these exports:

```ts
export interface AdvertisedToolDescriptor {
  readonly name: ToolName;
  readonly inputSchema: Readonly<Record<string, unknown>>;
  readonly outputSchema: Readonly<Record<string, unknown>>;
}

export const ADVERTISED_TOOL_CATALOGUE:
  readonly AdvertisedToolDescriptor[];
```

There is no `src/mcp/index.ts`, package export, or contracts-barrel re-export for the catalogue. Phase 4 imports both `ADVERTISED_TOOL_CATALOGUE` and `AdvertisedToolDescriptor` only from `src/mcp/tools.ts`.

The catalogue contains exactly five deeply frozen descriptors in `TOOL_NAMES` order. It is derived from exactly `mcp-tools.schema.json`, `primitives.schema.json`, `path-claim.schema.json`, `evidence-slots.schema.json`, `rubric.schema.json`, `gate-contract.schema.json`, `gate-decision.schema.json`, and `project-error.schema.json`. Projection localizes references, removes embedded identifiers and `x-archflow-*` assertions, retains JSON Schema 2020-12, and proves object-root input/output schemas without weakening branches. Each schema compiles under strict `ajv@8.20.0` plus `ajv-formats@3.0.1` with an otherwise empty registry. Tests validate the catalogue through public-root `specTypeSchemas.ListToolsResult` and separately pin the fixed five-name/order/object-root/no-cursor surface. A classified corpus distinguishes portable structure from semantic checks retained by Phase 2 runtime validators.

`src/mcp/server.ts` owns the SDK-free authenticated handler/error boundary:

```ts
export type ToolHandler<K extends ToolName> = (
  call: Extract<ParsedToolCall, { readonly name: K }>,
  context: InvocationContext
) => unknown | Promise<unknown>;

export type ToolHandlerRegistry = Readonly<Partial<{
  [K in ToolName]: ToolHandler<K>;
}>>;

declare const authenticatedProtocolErrorBrand: unique symbol;
export type AuthenticatedProtocolError = Readonly<{
  readonly value: ProtocolError;
  readonly [authenticatedProtocolErrorBrand]: true;
}>;

export function authenticateProtocolError(
  value: unknown
): AuthenticatedProtocolError;

export type ToolProjectOutcome = {
  readonly [K in ToolName]: Readonly<{
    readonly kind: "project-result";
    readonly tool: K;
    readonly result: StructurallyValidProjectResult<K>;
  }>;
}[ToolName];

export type ToolBoundaryOutcome =
  | ToolProjectOutcome
  | Readonly<{
      readonly kind: "protocol-error";
      readonly error: AuthenticatedProtocolError;
    }>;

export interface ToolBoundary {
  readonly invoke: (
    name: string,
    args: unknown,
    context: InvocationContext
  ) => Promise<ToolBoundaryOutcome>;
}

export function createToolBoundary(
  handlers: ToolHandlerRegistry
): ToolBoundary;

export function assertAuthenticToolBoundary(
  value: unknown
): asserts value is ToolBoundary;

export function assertAuthenticToolBoundaryOutcome(
  value: unknown
): asserts value is ToolBoundaryOutcome;
```

The copied registry, boundary, authenticated protocol-error wrappers, and outcomes are deeply frozen and process-authenticated through private identity sets. Casts, structural fakes, and spread clones fail. The boundary accepts only a string name and authentic invocation context. Unknown names return authenticated `TOOL_NOT_FOUND` with a lowercase SHA-256 digest of the exact UTF-8 name; known tools without a handler return authenticated `TOOL_DISABLED` with `lifecycle_state: "inert-no-handler"`.

Known-tool argument failures use this closed classification and `validateProjectFailureStructure`; parser exception text never escapes:

| Input condition | Generated project error |
|-----------------|-------------------------|
| Non-plain JSON or not an object | `CONTRACT_INVALID`, `issue_code: "input-not-object"`, selected `tool` |
| Object missing `schema_version` | `CONTRACT_INVALID`, `issue_code: "schema-version-missing"`, selected `tool` |
| Present version is non-string or fails Phase 2 safe-version syntax | `CONTRACT_INVALID`, `issue_code: "schema-version-invalid"`, selected `tool` |
| Safe supplied version is not `"1"` | `CONTRACT_VERSION_UNSUPPORTED`, exact supplied version, `supported_version: "1"` |
| Version is `"1"` but any other parse/semantic check fails | `CONTRACT_INVALID`, `issue_code: "input-invalid"`, selected `tool` |

A valid handler is called at most once and its `unknown` return is structurally revalidated. Tool-neutral closed project failures may be accepted on any known-tool path. Malformed output, detectable cross-tool success substitution, or handler throw/rejection becomes a validated correlation-only `INTERNAL_ERROR` result; raw exception and handler prose do not escape. Transport precedence, cancellation, numeric error projection, `CallToolResult`, and wire serialization remain Phase 4.

## Files

| Action | File | Purpose |
|--------|------|---------|
| Modify | `package.json`, `package-lock.json` | Admit exact server beta.5, retain exact core beta.5 in the lock, and keep Node `24.15.0` as compatibility floor. |
| Modify | `scripts/check-dependency-policy.mjs`, `scripts/check-notices.mjs` | Enforce exact root server/core identities, their root package-declared licenses through existing allowed-license policy, and absence of later-phase dependencies. |
| Modify | `THIRD_PARTY_NOTICES.md`, `docs/dependency-upgrades.md` | Record both root package entries, protocol/public-surface currency evidence, and Node compatibility versus production patch guidance. |
| Modify | `src/contracts/mcp-tools.ts` | Add the failure-only structural validator without granting success authenticity. |
| Modify | `src/contracts/contexts.ts`, `src/contracts/index.ts` | Add shared request-ID/client schemas, parsers, and invocation assertion while keeping the connection factory direct-only and the barrel contract-only. |
| Create | `src/mcp/tools.ts` | Own and export the catalogue descriptor type and deterministic deeply frozen five-tool catalogue as the supported direct Phase 4 import. |
| Create | `src/mcp/server.ts` | Export the frozen authenticated SDK-free handler/error/outcome boundary and exact input classification. |
| Modify | `test/unit/mcp-tools.test.ts`, `test/contracts/mcp-contract-agreement.test.ts`, `test/unit/contexts.test.ts` | Prove failure-only construction, shared parser/mint agreement, exact safe request IDs, full Implementation projection, authenticity, and freezing. |
| Create | `test/unit/mcp-server.test.ts`, `test/contracts/mcp-advertised-schema.test.ts`, `test/fixtures/mcp/{catalogue,boundary}/**` | Exercise boundary behavior and catalogue portability/public-root agreement without a live transport. |
| Modify | `.github/workflows/ci.yml` | Run focused checks on the Node matrix and enforce the Phase 3 no-runtime boundary. |

Phase 3 creates no `src/main.ts`, SDK adapter, transport, lifecycle, cancellation, request-ID map, `-0` wire normalization, live protocol fixture, or runnable server. Those are Phase 4. It creates no release bundle, manifest, clean-copy smoke, or bundle-wide legal inventory. Those are Phase 5. Persistence, dispatch, durable gates, CLI, installer, registration, and skills remain out of scope.

## Work Breakdown

1. **Admit the exact root dependencies**: Before repository mutation, recheck exact server/core beta.5 identities, protocol/public declarations, guidance, and both root `MIT` declarations. Proceed only when they match the approved basis and existing allowed-license policy; otherwise leave dependency changes unmade and return for phase-design review. Update package/lock, root notices, currency guidance, and focused policy checks without deeper legal inventory.
2. **Extend the Phase 2 seams**: Add the failure-only result validator, one shared request-ID schema for parser and invocation mint, one shared client schema for parser and direct connection mint, and the narrow invocation assertion. Prove safe bounds, `-0`, arbitrary strings, exact full-Implementation projection, parser-to-mint preservation, freezing, and fake rejection.
3. **Freeze the portable catalogue**: Implement `src/mcp/tools.ts` from the exact eight-schema closure. Prove five-tool order, reference closure, object roots, deep freezing, strict Ajv compilation, public-root `specTypeSchemas.ListToolsResult` acceptance, frozen-2025 invariants, and the portable-versus-semantic corpus.
4. **Freeze the authenticated boundary**: Implement the handler/registry/error/outcome/boundary exports and private authenticity consumers. Classify unknown, disabled, and known-invalid calls exactly; invoke handlers at most once; revalidate returns; and reduce malformed/substituted/thrown results to safe closed outcomes.
5. **Verify phase boundaries**: Run focused unit, contract, schema, dependency, notice, and CI checks. Prove production Phase 3 source has no SDK import and runtime/release-only files remain absent.

## Success Criteria

- [ ] Implementation-start evidence confirms exact server/core beta.5, protocol `2025-11-25`, required public exports, and allowed root `MIT` declarations before package/lock mutation; a mismatch returns for phase-design review without dependency changes, and phase-design approval does not authorize a commit.
- [ ] Existing notices contain both root package entries, and Phase 3 adds no tarball, embedded-component, documentation-class, transitive, or bundle-wide legal audit.
- [ ] One shared request-ID schema is consumed by parser and authentic invocation mint, preserving arbitrary strings, negative safe integers, `-0`, and both safe bounds while rejecting adjacent unsafe integers, fractions, and nonfinite values; public-root `specTypeSchemas.RequestId` is a test-only agreement oracle.
- [ ] One shared client schema is consumed by parser and direct-only authentic connection mint; full SDK Implementation fixtures are projected to exact `{ name, version }`, admitted values survive parser-to-mint unchanged, and fake/spread contexts fail.
- [ ] `validateProjectFailureStructure` authenticates only closed known-tool failures and cannot mint success.
- [ ] `src/contracts/index.ts` remains contract-only. `src/mcp/tools.ts` is the only supported catalogue seam and owns/exports `AdvertisedToolDescriptor` plus `ADVERTISED_TOOL_CATALOGUE`; there is no `src/mcp/index.ts` or package/barrel catalogue export, and Phase 4 imports only from the exact tools module.
- [ ] Exactly five deeply frozen descriptors derive from the exact eight schemas, compile with strict Ajv/formats from an empty registry, pass public-root `ListToolsResult`, and retain the direct frozen-2025 surface without SDK internal imports.
- [ ] The SDK-free boundary and every outcome/error wrapper are frozen and process-authenticated; known/unknown/disabled/invalid/success/failure/substitution/throw cases produce the exact safe outcomes with at most one handler call and no raw error leakage.
- [ ] Focused checks pass on both Node versions; no Phase 4 runtime or Phase 5 release artifact is introduced.

## Verification Steps

1. Before any package/lock/policy/notice edit, check exact server/core beta.5 identities, protocol support, required public declarations/exports, current guidance, and both root `MIT` declarations against existing allowed-license policy. If either identity/public surface differs or either root declaration is not allowed `MIT`, leave dependency changes unmade and return for phase-design review; do not treat phase-design approval as commit authorization.
2. On Node `24.15.0` and `24.18.0`, run `npm ci`, typecheck, unit/contract tests, dependency policy, notices check, and the repository aggregate check.
3. Inspect `package-lock.json`, policy output, and `THIRD_PARTY_NOTICES.md` for exact server/core root entries and absence of later-phase dependencies. Confirm Phase 3 introduced no retained MCP legal assets or embedded/transitive legal inventory.
4. Exercise the failure-only validator across every tool and closed failure plus success, malformed/open values, casts, and substitutions.
5. Exercise both shared schemas through their parsers and authentic mints. Cover arbitrary strings, `-0`, negative values, both safe bounds, adjacent unsafe integers, fractions/nonfinite candidates, exact full-Implementation projection, one-shot connection minting, freezing, and fake/spread rejection.
6. Validate the catalogue through exact public-root `specTypeSchemas.ListToolsResult`; compile every schema with fresh strict Ajv 2020 plus formats and no preloaded project schemas/custom keywords; assert five names/order, local references, object roots, no custom keywords/identifiers/cursor, and deep freezing.
7. Invoke the boundary directly with authentic contexts and assert the exact unknown/disabled/input-classification/handler-result/fallback cases, zero-or-one calls, safe correlation-only errors, freezing, and authenticity rejection.
8. Verify module boundaries: `src/contracts/index.ts` exports only contract seams and excludes `connectionContextFactory` and all catalogue exports; `src/mcp/tools.ts` owns and exports only the supported catalogue type/constant; `src/mcp/index.ts` does not exist; Phase 4's planned import is exactly `src/mcp/tools.ts`; production `src/` has no MCP SDK import; and Phase 4 runtime plus Phase 5 release files remain absent.

---
*Designed: 2026-07-27*

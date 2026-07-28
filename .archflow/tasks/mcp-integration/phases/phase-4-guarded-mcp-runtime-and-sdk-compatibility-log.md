# Implementation Log: Phase 4 - Guarded MCP Runtime and SDK Compatibility

**Implemented**: 2026-07-27
**Status**: COMPLETE

## Decisions

- Retained the low-level public SDK `Server` behind `src/mcp/sdk-adapter.ts` as the only production SDK import owner. Framing, lifecycle/routing, output queueing, and process ownership remain SDK-free modules.
- Migrated the approved exact server/core dependency evidence from beta.5 to stable `2.0.0` after a stop-on-drift review showed the consumed public declarations, schemas, hooks, legacy behavior, and license metadata were unchanged.
- Kept singleton protocol `2025-11-25`. Protocol `2026-07-28` requires a later explicit design because the hand-built low-level server remains on the legacy path unless modern behavior is selected.
- Preserved authentic Phase 3 boundary outcomes across SDK projection, including restoration of `TOOL_DISABLED -32002` when the stable SDK rewrites it to `-32602`.
- Made cancellation a validate-then-transition operation: public SDK schema validation occurs before session state mutation, preventing malformed cancellation from suppressing a valid response.
- Kept the approved `append(chunk): void` bounded-framer contract. A delivered chunk whose retained remainder exceeds 10 MiB fails closed; removing delivery-partition dependence requires a design-level streaming interface revision.

## Deviations from Design

- Stable `2.0.0` was published during implementation review. Work stopped, the phase design and parent architecture were revised and reviewed, and the user approved the stable migration before package mutation. No runtime rewrite was needed.
- Counter-review reproduced malformed-cancellation response suppression. The session/adapter contract and composed tests were strengthened before approval.
- Counter-review requested broader composed coverage. Representative enabled-handler cancellation, late-result quarantine, terminal ID reuse, and all protocol mappings were added; a redundant exhaustive cross-product harness was not added because component and integration suites already cover the remaining bounded queue/session invariants.

## Patterns Established

- SDK compatibility is proved at three layers: an exact dependency/currency probe, compile-time public-surface fixtures, and composed runtime behavior tests.
- State mutations that depend on SDK validity use a two-step action: emit a validation request, then accept a closed validated event.
- Outbound request ownership is retained until write admission, while completion and backpressure are tracked independently.
- Integration bundles are built in unique OS temporary directories so tests do not depend on or leave tracked release output.

## Gotchas

- Stable `2.0.0` intentionally retains legacy low-level behavior used here, including malformed-initialize prose and `TOOL_DISABLED` rewriting; the adapter canonicalizes only the explicitly retained authenticated cases.
- `Writable.write(false)` means the entry was admitted but backpressure is active; it is not write completion. Callback errors remain fatal even after admission or drain.
- With the approved pull-based framer interface, accepting one aggregate delivered chunk above the retention cap would require unbounded retention or eager unbounded frame queueing.
- Exact Node patch verification matters because the project floor is Node `24.15.0` while developer ambient runtimes may differ.

## Key Interfaces

- `src/mcp/framing.ts`: strict bounded byte-to-JSONL framing.
- `src/mcp/session.ts`: closed lifecycle, route, request-ledger, cancellation, and projection actions.
- `src/mcp/send-queue.ts`: bounded FIFO with separate admission, completion, and backpressure ownership.
- `src/mcp/sdk-adapter.ts`: sole public SDK boundary and canonical response projection.
- `src/mcp/process-runner.ts`: SDK-free termination, diagnostic, signal, and exit arbitration.
- `src/main.ts`: thin real-process binding.

## Verification

- Public SDK currency, schema, hook, declaration, projection, and teardown probe against exact stable server/core `2.0.0`.
- Typecheck, 86 focused MCP runtime tests, 276 full tests, 42 contract tests, isolated build/smoke, dependency/notices checks, SDK boundary policy and policy-mutation checks.
- Full `npm run check` under exact Node `24.15.0` and `24.18.0`.

## Durable Convention Proposal

No new project-wide `CLAUDE.md` convention is proposed. The public-SDK isolation and protocol behavior are specific to this MCP task and are already recorded in its architecture and tests.

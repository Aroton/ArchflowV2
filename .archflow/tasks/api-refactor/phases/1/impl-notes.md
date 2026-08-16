## Implementation Log: Phase 1 - Semantic Contracts and Server-Side Composition

### Decisions Made

- Added one closed semantic contract graph for public workflow views, invocations, submissions, internal offers, operation keys, and compact results/errors. Public apply schemas retain a plain-object root and forbid caller-authored mechanical authority.
- Kept the semantic surface internal for this phase. The existing MCP catalogue remains unchanged; the only advertised compatibility addition is a bounded `planning_restart` operation on `archflow_state`.
- Extracted request construction into an in-process composer and reduced `archflow-local build-request` to a staging adapter. Initialization, successful and failed production, running transitions, triage, counter-review, ordinary gates, and phase handoff share the same composer.
- Represented semantic mutations as fixed named substeps with repository-bound offer and operation digests. Compound review preserves one operation identity while the executor refreshes authenticated status between substeps, stops at the next actor boundary, and returns a fresh view; it cannot dispatch producers, run verification, operate Git, or recursively consume another offer.
- Added a status-owned authoritative semantic assembler. Repository identity, complete findings, pending waiver, archived decision/revision markers, and legal reopen impacts come from the same durable state/evidence read and authenticated archives rather than caller-provided enrichments.
- Added a focused planning-restart kernel with canonical phase ordering, strict earlier-planning targets, exact PRD ask append/replay, archived invalidated authority, fresh attempt one, and restart-aware approval eligibility.
- Added shared planning-restart and no-submission pending-waiver composers. Semantic and legacy paths derive their mechanical bindings from the same authenticated services; only direct human-decision archive/settlement remains deferred to Phase 2.
- Unified active and archived result retention behind one deduplicated graph so cleanup and byte accounting agree about restart and human-revision evidence.
- Accepted durable human restart provenance only from the two existing human channels (`connected-host` and `archflow-local`), with non-human actors rejected by the restart schema.

### Deviations from Plan

- None. Phase 2 remains responsible for advertising the semantic MCP tools and extracting nonblocking direct human-decision archive/settlement. Phase 1 validates and projects those decision shapes but deliberately rejects their execution, as designed.

### Patterns Established

- Validate and materialize caller-owned JSON once before any repeated observation or hashing.
- Bind semantic offers to repository identity, task, invocation, durable position, evidence, and submission; bind each durable substep to a closed `afop-...-substep` intent.
- Treat planning restart as a narrow authenticated exception to ordinary forward-only transition preservation, and reconstruct the entire expected post-restart draft before accepting it.
- Derive approval freshness from the latest restart affecting the authority producer phase, not from a later consumer phase.
- Use a narrow atomic writer for the task ask rather than broadening general projection-write authority.

### Gotchas

- A PRD restart changes `ask.md` before its landing fingerprint is derived; reusing the pre-append fingerprint makes the valid transition self-conflicting.
- Material-drift restart must resolve the authenticated upstream artifact's actual producer phase. The current consumer phase is not a safe substitute, especially for compound documents.
- Exact replay after normal receipt cleanup must authenticate both restart history and the PRD ask tail; matching an intent identifier alone is insufficient.
- A semantic PRD restart must derive its restart ID from the stable `afop` operation identity, not from a request digest that includes mutable ask bytes. Recomposition after an ask-only crash recovers the original prefix digest from the operation-bound suffix.
- Invalid waiver archives are blocker evidence, never merely a defined pending-waiver marker; the view must emit inspection with no offer.
- Material-drift ownership is unique by affected digest and authenticated producer phase. Conflicting producer phases fail closed instead of relying on iteration order.
- Generated JSON Schema cannot express the Zod ordering refinements, so restart-history arrays must be added to the structural corpus explicitly.
- The tracked release payload becomes stale whenever contributing source changes and must be regenerated only after final source bytes are frozen.
- A semantic review owns one outer process-wide dispatch FIFO across replay, dispatch, and commit. Its bounded counter-review handler must bypass the handler's ordinary inner FIFO; nesting the same non-reentrant queue deadlocks before either dispatch can complete.

### Key Interfaces

- `src/contracts/semantic-workflow.ts`: semantic public/internal contract graph and strict parsers.
- `src/state/semantic-status.ts` and `src/state/semantic-view.ts`: consistent snapshot validation, exhaustive status projection, and opaque offer derivation.
- `src/state/semantic-actions.ts`: submission matching, stable operation keys, named-substep planning, and one-capability execution.
- `src/state/request-composition.ts`: transport-neutral request composition shared by semantic execution and the legacy CLI adapter.
- `src/state/transitions.ts` and `src/state/restart-authority.ts`: planning-restart mutation and restart-aware authority cutoff rules.
- `src/state/planning-restart.ts` and `src/state/pending-waiver.ts`: shared server-derived restart identity/replay and archived waiver-request derivation.
- `src/mcp/handlers/state.ts`: additive legacy planning-restart adapter, exact PRD append ordering, and replay authentication.
- `src/mcp/handlers/counter-review.ts`: ordinary queued entry point plus the explicit direct-inner entry point used only while semantic execution owns the outer FIFO.
- `src/state/retained-result-graph.ts`: shared liveness graph for cleanup and retained-byte accounting.

### Verification Evidence

- TypeScript compilation and generated-schema drift checks pass.
- The final repository-wide check passes: 169 Vitest files and 1,777 tests passed, 4 files and 24 real-host tests skipped by their normal guards, 454 contract tests passed, generated schemas matched, temporary bundles ran, notices and SDK boundaries passed, and the tracked release payload passed check, smoke, mutation, and reproducibility gates.
- Focused semantic contracts, semantic view/action, composition parity, restart runtime/handler/replay, material-drift lifecycle, durable structural corpus, and MCP advertised-schema tests pass.
- Two same-side adversarial review cycles completed. The accepted findings on authoritative snapshot derivation, compound action identity/execution, shared restart/waiver composition, semantic crash recovery, invalid-waiver projection, and conflicting producer ownership were implemented and re-verified.
- The final same-side review passed after two remediation cycles. With explicit user direction, the obsolete `.github/workflows/ci.yml` proof/control requirement was removed because that file had already been removed from the repository. The tracked release payload was then reproduced byte-for-byte and promoted successfully.
- The opposite-client counter-review found a nested FIFO deadlock in the semantic review execution path. The accepted remediation added an explicit direct-inner counter-review seam, retained the ordinary handler's FIFO behavior, removed an unreachable restart execution branch, and added a real fixed-point regression that completes both review dispatches under the semantic outer FIFO.

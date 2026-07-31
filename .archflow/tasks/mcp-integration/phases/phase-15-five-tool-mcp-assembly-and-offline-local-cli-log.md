## Implementation Log: Phase 15 - Five-Tool MCP Assembly and Offline Local CLI

### Decisions Made

- `src/main.ts` installs `createToolHandlers()` through the optional `ProcessBindings.handlers` seam in `src/mcp/process-runner.ts`. The registry contains exactly `archflow_state`, `archflow_counter_review`, `archflow_adjudicate`, `archflow_gate`, and `archflow_waiver`; `archflow-local` remains a separate non-MCP entry.
- `src/state/production.ts` exports `createProductionServices(input): Promise<ProjectResult<ProductionServices>>`. It discovers repository authority in two phases: resolve Git/task context first, then rebuild the authority and every dependency with the resolved operation context. It binds retained-result loading, task-byte accounting, projection writing, gate re-entry fingerprints, and retained supplemental-review resolution.
- `src/dispatch/coordinator.ts` exports `createDispatchCoordinator(input): DispatchCoordinator`. It owns routing, adapter preflight, isolated workspace creation, child execution, attempt telemetry, and cleanup. `allow_claude_dispatch` is deliberately `true` in production so both producer directions function; architecture release criterion 3 / `VAL-14` still forbids authorizing distribution of the Claude subscription-dispatch path without written clarification or a qualified legal determination.
- `src/contracts/supplemental-record.ts` makes the immutable compound counter-review/triage record the only supplemental authority. `src/local/commands.ts` writes that record with `createExclusive` before publishing its Markdown wake-up projection; `createProductionServices` resolves only from the retained record.
- `src/mcp/handlers/gate.ts` returns the new classified `GATE_SUPERSEDED` result after a durable supersession lands. Its parameters bind `gate_id`, `old_subject_digest`, and `new_subject_digest`; its next action is `retry-with-superseding-subject`.
- `src/local/main.ts` and `src/local/commands.ts` implement the offline command surface without a `package.json` `bin` entry. Commands that require structured input read stdin; `status` is input-free and never waits for stdin.
- The tracked release is one deterministic payload with two executable entries: `dist/archflow-mcp.mjs` and `dist/archflow-local.mjs`. `scripts/release-support.mjs` derives per-entry imports/provenance and the exact installed legal closure rather than maintaining fixed allowlists or component counts.
- The user approved the live-handler `fast-uri@3.1.0` risk for local-only user-owned agents on 2026-07-31. `release/evidence/user-risk-acceptance.json` records the exact approval text and `mcp-tool-handler` scope. The distinct installed `fast-uri@3.1.4` copy is at the advisory safe floor and needs no risk decision.

### Deviations from Plan

- Upgrade staging is absent from Phase 15. Phase 19 owns the upgrade orchestrator, and no placeholder command or compatibility layer was added.
- The release loader-policy assertion was removed. Live Ajv reachability legitimately emits esbuild CommonJS helpers; license, import, provenance, hostile-startup, mutation, and reproducibility checks remain the enforceable release boundaries.
- The HEAD byte-immutability legal baseline was relaxed so a newly human-authorized decision can bind a changed bundle atomically. Current decision digests, evidence digests, entry bindings, dependency inventory, and bundle digests remain mandatory.
- `src/state/transaction.ts` now creates the validated result hierarchy and payload parent directories immediately before immutable snapshot installation. The original assembly reached the real kernel with missing parents and returned `SNAPSHOT_INVALID`; directory scaffolding is necessary for the designed live transaction path and does not alter commit order.
- Six caller/disk disagreements in `src/mcp/handlers/state-results.ts` return stable `CONTRACT_INVALID` project results instead of throwing into `INTERNAL_ERROR`. Throws remain reserved for internal invariants.
- Counter-review expanded the planned tests with a real supplemental record/projection round trip, both coordinator producer directions, child-stage cancellation, a nonblocking bundled `status`, classified durable supersession, all six state-result mismatches, and the constitution-edit pre-dispatch gate.

### Patterns Established

- Assemble persisted authority from validated durable roots; disposable Markdown and `gate.json` projections may wake a workflow but never authenticate it.
- For a retained record plus human-facing projection, install the immutable record first and publish the reconstructible projection last. A retry must accept an identical retained record and reproduce identical projection bytes.
- Handler boundary disagreements caused by caller data or authenticated disk data return a classified `ProjectResult`; unexpected implementation failures alone map to `INTERNAL_ERROR`.
- A command with no input payload must not read stdin. This matters for launchers whose parent intentionally keeps stdin open.
- Release provenance is per executable entry. Legal closure and allowed imports are derived from the staged metafile across all outputs, while the top-level bundle digest remains the MCP entry digest.

### Gotchas

- `runDurableGate` can durably archive a supersession before returning to the handler. The archived `GateSupersessionRef` intentionally omits `new_subject_digest`; the handler obtains it from the already-authenticated caller `supplemental_outcome` and verifies its gate/old-subject binding before returning `GATE_SUPERSEDED`.
- `Object.getOwnPropertyDescriptor` shell checks must require an enumerable data property. Stable non-enumerable values are otherwise invisible to canonical JSON and any digest derived from it.
- A production object used across validation and hashing must be materialized once after `assertPlainJson`; repeated reads of caller-owned accessors can disagree.
- Adding a project error changes the temporary-bundle smoke registry count as well as the TypeScript registry, normative JSON Schema, exhaustive contract corpus, and unit count.
- Release evidence uses canonical JSON bytes: recursively ordinal-sorted keys, two-space indentation, and one trailing newline. Raw compact/stable JSON hashing produces the wrong binding.
- The embedded `fast-uri@3.1.0` and installed `fast-uri@3.1.4` are separate inventoried components. Only the embedded version is affected by the retained four-advisory decision.

### Key Interfaces

- `src/mcp/handlers/index.ts`: `createToolHandlers(): ToolHandlerRegistry`.
- `src/state/production.ts`: `createProductionServices(input): Promise<ProjectResult<ProductionServices>>`; `ProductionServices` carries `runner`, `environment`, `authority`, optional current `state`, and complete `GateLifecycleDependencies`.
- `src/dispatch/coordinator.ts`: `createDispatchCoordinator(input): DispatchCoordinator`; the coordinator is used by both counter-review and adjudication handlers.
- `src/contracts/supplemental-record.ts`: `parseSupplementalReviewRecord(value)` and `SupplementalReviewRecordV1`; schema `src/contracts/schemas/v1/supplemental-review-record.schema.json` is registered in the public contract registry.
- `src/mcp/handlers/state-results.ts`: `prepareDocumentResult(input)` and `prepareImplementationResult(input)` return `Promise<ProjectResult<PreparedStateResult>>` and never throw for the six classified input/disk mismatch branches.
- `src/state/manual-checkpoints.ts`: checkpoint writing/enumeration used by `archflow-local checkpoint` and adoption recovery.
- `src/state/status.ts`: degraded offline status computation; `src/state/maintenance-roots.ts`: exact maintenance root/candidate enumeration.
- `src/local/commands.ts`: `runLocalCommand(input)` dispatches the named helper surface, including `gate-counter`, checkpoint, snapshot/restore, maintenance, decision, reconcile/import, status, validate/hash/render.
- `src/contracts/errors.ts`: `GATE_SUPERSEDED` is a non-retryable gate-owned error with next action `retry-with-superseding-subject`.
- `dist/manifest.json`: `build_entries` and `entry_provenance` describe `mcp-stdio` / `archflow-mcp.mjs` and `local-cli` / `archflow-local.mjs`; each provenance row owns its contributing inputs, output digest, and derived imports.

### Verification

- `npm run check` passed on Node `24.18.0`.
- Full Vitest suite: 121 files, 1,528 tests passed.
- Contract suite: 17 files, 457 tests passed.
- MCP runtime suite: 13 files, 117 tests passed.
- Typecheck, temporary bundle smoke, dependency policy, notices and notice mutations, MCP boundary and boundary mutations all passed.
- Release check, guarded/offline smoke for both bundles, 17 integrity mutations, and byte-identical reproduction all passed. Final MCP bundle digest is `4455e40a945629dd6f8b9abcd70581eb4948b6234c24531fcc7c3e948eebd94a`; local bundle digest is `356b8f4f6de6ccf3b598ca6624a209ac963640c95c378f51f767714aca51b46f`.

## Implementation Log: Phase 9 - Transaction Substrate and Exact Replay

**Implemented**: 2026-07-29
**Status**: COMPLETE pending commit
**Requirements advanced**: REQ-04, REQ-08, REQ-13, REQ-14, REQ-21, REQ-22, REQ-23, REQ-24, REQ-26 (none completed — initialization/reconciliation, payload projections, MCP wiring, and status remain assigned to later phases)

### Decisions Made

- Added one normative, schema-only `IntentReceiptV1` durable root. A receipt stores the exact successful tool outcome and complete prepared successor state; the final state adds only the kernel-derived `committed_intent`. State remains the sole commit authority.
- Replaced `TaskStateV1.prepared_intent` with `CommittedIntentRef`, binding the immutable receipt digest, outcome digest and result ID, request digest, and predecessor/successor revisions.
- Extended the consolidated durable semantic authority in place. Receipt-local checks occupy ranks 3/4b, prepared predecessor agreement rank 8a, and committed state/reference agreement rank 8b. Prepared relations require exact predecessor revision equality.
- Replaced the open request-digest object with exhaustive per-tool selectors and reused the existing authentic-call WeakMap binding. Parsed tool inputs are materialized once and recursively frozen before branding, so selectors, preparation, and result correlation observe one immutable graph.
- Minted `TransactionAuthority` from live Git/repository discovery and constructor-proven task paths. The mature-state kernel accepts no caller path, recorded repository identity, fingerprint subject, or fingerprint digest as authority.
- Used `write-file-atomic@8.0.0` only for overwrite-style `state.json` replacement. Immutable receipts use same-directory temp write/fsync/close plus `link` no-clobber installation. A fixed direct-child `mkdir` lock never performs stale takeover.
- Kept long-running work outside the kernel. `prepare` runs under the task lock and is constrained to bounded, non-blocking, repository-pure planning; later MCP wiring must dispatch before entering this seam.
- Classified post-write and release ambiguity only from durable rereads. An authenticated committed state returns success; an unchanged predecessor preserves the original operation failure; another state requires reconciliation.

### Deviations from Plan

- **No production crash hook was added.** The pinned real `SIGKILL` cut points are implemented by a test-only atomic writer in `test/fixtures/state-transaction-child.mjs`. It reproduces the production write protocol and kills the child at receipt-temp, receipt-link, state-replace-before, and state-replace-after. Tests assert that neither production source nor the temporary bundle contains a cut marker or hook.
- **Revision-space exhaustion remains a programmer-boundary `TypeError`.** The check is performed once before preparation or writes. Phase 9 has no approved durable issue code for a state already at `Number.MAX_SAFE_INTEGER`, and inventing one during implementation would widen the pinned contract.
- **The `intents/` directory uses one documented narrow path-brand cast.** It joins only the fixed literal child to a constructor-authenticated task root, then verifies the opened target with `O_NOFOLLOW`, `O_DIRECTORY`, and `stat`; no caller segment participates.
- **Counter-review expanded verification substantially.** The final suite behaviorally pins all 23 new durable issue codes, all five request selectors with golden digests, the receipt cap and overflow boundary, double faults, omitted truth-table rows, and four real child crash cuts.
- **The aggregate release suite remains blocked by the inherited Phase 5/6 contradiction.** Full verification passed 1,163 of 1,166 tests; the same three `release-offline` assertions fail on stale `src/contracts/adjudication.ts` bundle input and the stale `fast-uri-3-1-0-local-risk` binding. Phase 9 did not regenerate or weaken tracked release authority.

### Patterns Established

- A write-ahead receipt is resumable preparation, never authority. Only a validating state reference commits it.
- Immutable installation and mutable replacement use separate filesystem primitives: temp+link for no-clobber retained objects, atomic rename replacement for the one mutable authority file.
- Transaction precedence is observable behavior: canonical state semantics, live repository identity, and CAS run before intent layout or receipt handling; committed replay validates state/receipt agreement before caller request comparison.
- Cleanup ambiguity does not rewrite established truth. Preserve an earlier failure when authority remains unchanged, but prefer authenticated committed state over release diagnostics.
- Test-only crash controls belong in child fixtures. Production modules and bundles remain free of fault environment variables and cut-point branches.

### Gotchas

- Exact replay requires refreshed CAS. Reusing the original expected revision after a successful N→N+1 commit returns `STATE_CONFLICT`; using N+1 can authenticate and replay the same logical request because CAS is excluded from the request digest.
- An exact receipt-only crash resumes without rerunning preparation, but `state.json` alone cannot expose that orphan. Phase 10 owns bounded current-intent reconciliation and Phase 17 owns truthful status projection.
- `write-file-atomic` v8 has no current matching DefinitelyTyped package and is CommonJS. The project uses a narrow reviewed local declaration and admits Node `^24.15.0`, not Node 25.
- A `SIGKILL`-abandoned `.transaction-lock` deliberately blocks. Repair must remove the exact verified lock out of band; the runtime never infers staleness from age or owner metadata.
- `IntentReceiptV1` is server-internal and intentionally has no Zod mirror. Agreement guards must continue to distinguish normative durable schemas from MCP-reachable mirrored shapes.

### Key Interfaces

- `src/contracts/durable-intent.ts`: `IntentReceiptV1`; `parseIntentReceipt(value) -> IntentReceiptV1`; `intentReceiptDigest(receipt) -> Sha256Digest`; `intentOutcomeDigest(outcome) -> Sha256Digest`.
- `src/contracts/durable-state.ts`: `CommittedIntentRef`; optional `TaskStateV1.committed_intent`.
- `src/contracts/durable.ts`: `DurableIntentRelation`; `createPreparedIntentSubject(predecessor, receipt)`; `createCommittedIntentSubject(state, receipt)`; ranks 3, 4b, 8a, and 8b in `validateDurableSemantics`.
- `src/state/authority.ts`: `TransactionAuthority`; `createInternalTransactionAuthority({runner, environment, task_id, context}) -> Promise<ProjectResult<TransactionAuthority>>`.
- `src/state/fingerprint.ts`: `createInternalInputFingerprintResolver(readers) -> InputFingerprintResolver`.
- `src/state/request.ts`: internal `identifyTransactionRequest(call, authority, recomputedInputFingerprint)` using the existing request binder.
- `src/state/atomic.ts`: `AtomicWriter`; `createAtomicWriter() -> AtomicWriter`; `AtomicReplaceError`.
- `src/state/lock.ts`: `TaskLock`; `createTaskLock() -> TaskLock`; `TaskLockError`.
- `src/state/layout.ts`: `ensureIntentDirectory(authority) -> Promise<void>`; `IntentLayoutError`.
- `src/state/read.ts`: `readTaskState`; `readTaskConfig`; `readIntentReceipt`; their closed read-result unions.
- `src/state/transaction.ts`: `runStateTransaction<K>(dependencies, request, prepare) -> Promise<ProjectResult<TransactionOutcome<K>>>`; `TransactionDependencies`; `TransactionRequest`; `PreparedTransaction`; `NextStateDraft`.

### Verification

- Node `24.18.0`: typecheck passed; unit suite 686/686; contract suite 446/446; MCP runtime 100/100; temporary contract/runtime bundle built and exercised.
- Post-counter-review affected matrix passed 220/220, including all 23 receipt semantic codes, five selector goldens, kernel truth-table/limit/double-fault cases, real multi-process races, and real child-side crash cuts.
- Dependency policy passed for 126 locked entries; notices passed for 126 SPDX entries and 21 reviewed NOTICE mappings; notice mutation and MCP boundary policies passed.
- Full suite passed 1,163/1,166. The only failures are the three inherited `release-offline` assertions recorded above.
- The implementation counter-review is fully triaged in `reviews/phase-9-impl-counter-review.md`; no blockers remain.

### Follow-ups Not Done Here

- Phase 10 owns initialization, transition planning, checkpoint adoption, bounded reconciliation, explicit repair, and the normal-state checkpoint bootstrap amendment.
- Phase 11 owns result manifests, payload snapshots, mutable projection replacement, restoration, and broader retained-byte accounting.
- Phase 15 owns long-running dispatch and MCP handler wiring around the transport-neutral kernel.
- Phase 17 owns truthful status for receipt-only crashes.
- Resolve the inherited release-integrity contradiction before regenerating the tracked release payload.

### Durable Convention Proposal

No new project-wide convention is proposed. This phase exercised the existing validate/materialize-once, persisted-type-alias, and enumerable-data-descriptor rules already recorded in `CLAUDE.md`; its receipt, lock, and transaction precedence rules are specific to this state substrate and remain in this log and the parent architecture.

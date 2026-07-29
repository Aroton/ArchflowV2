## Implementation Log: Phase 10 - Adoption, Reconciliation, and Recovery

**Implemented**: 2026-07-29
**Status**: COMPLETE pending commit
**Requirements advanced**: REQ-04, REQ-08, REQ-13, REQ-14, REQ-21, REQ-22, REQ-23, REQ-24, REQ-26, REQ-39, REQ-50 (handler/CLI integration and final status UX remain assigned to Phases 15 and 17)

### Decisions Made

- `archflow_state` now carries the existing five-member `DurableArtifact` union optionally. Request identity selects `record-state-boundary` without an artifact and one exhaustive artifact-specific operation otherwise; artifact requests bind the canonical artifact digest after the parsed call has been materialized once.
- Added a third manual-checkpoint anchor branch, `StateAnchor { anchor_kind: "state"; state_revision; state_digest }`. Only the first checkpoint after ordinary state uses it; later checkpoints retain `PredecessorLink`, and continuation imports authenticate current state independently from the adopted checkpoint predecessor.
- Added `runStateInitialization(dependencies, request)` as the only revision-0 transaction. It validates authenticated canonical paths, repository/task identity, config/workflow/constitution pins, and claimed Git commit objects before installing one immutable receipt and replacing `state.json` last.
- Checkpoint adoption is authorized twice: retained receipts carry operation `adopt-manual-checkpoint-import`, while live preparation must carry a WeakMap-authenticated plan minted by `planCheckpointAdoption`. Retained-receipt resume independently derives and verifies the exact artifact chain head before state installation.
- Reconciliation receives only caller-supplied current projections, exact intent/receipt, and independently optional gate/checkpoint heads. A state-bound committed receipt validates as committed; only an unreferenced valid prepared receipt is classified `receipt-only`.
- Abandoned-lock repair uses a human-confirmed capability, atomically quarantines the exact fixed lock directory, verifies its held descriptor identity after rename, and removes only that verified quarantine. Git divergence repair similarly uses an authenticated observation plus exact closed checkpoint-chain evidence before a clean handoff record can be installed.

### Deviations from Plan

- `src/mcp/tools.ts` and its advertised-schema tests changed because exposing durable artifacts through `mcp-tools.schema.json` requires the catalogue to carry the complete referenced schema closure. A runtime corpus case now proves stripped `x-archflow-sorted-unique-by` behavior remains enforced by the parsed-call boundary.
- Added `test/fixtures/state-phase10-child.mjs` as the smallest real-process harness for revision-0 and checkpoint-adoption kill cuts; production code contains no fault hook.
- The server-authored handoff record has one normative JSON Schema and no Zod mirror, following the existing untrusted-boundary rule for `TaskStateV1` and `IntentReceiptV1`.
- Legacy `source_identity_digest` and staged-payload existence are not resolved during revision-0 adoption because no source runner or retained-import enumeration exists in this phase. Phase 19 owns that upgrade/staging boundary; Phase 10 still validates the destination task, canonical paths, import/code/policy commit objects, and all pinned live digests available through authenticated dependencies.
- The aggregate release suite remains blocked by the inherited Phase 5/6 contradiction. Full verification passed 1,229 of 1,232 tests; the same three `release-offline` assertions fail on stale `src/contracts/adjudication.ts` bundle input and the residual `__require` loader.

### Patterns Established

- A durable operation discriminant may relax a retained semantic relation only when the live path has a separate unforgeable capability and the resume path re-derives the permitted value from request-digest-bound input.
- Reconciliation selects prepared versus committed receipt semantics from the current state's exact receipt binding; it never validates every retained receipt against one relation.
- Recovery capabilities bind observations, not caller claims. Filesystem deletion and Git handoff finalization require an authenticated observation that is revalidated immediately before the irreversible or durable step.
- Initial, state-anchored, and continuation checkpoint imports all apply the same fixed-workflow transition planner across every adopted link.

### Gotchas

- State revision and checkpoint revision are intentionally independent. One multi-checkpoint adoption increments state once while `adopted_checkpoint.revision` records the selected chain head.
- A committed receipt has `prior_revision === state.revision - 1`; applying prepared-receipt rank 8a to it creates a false reconciliation failure. Use `createCommittedIntentSubject` when state binds the exact receipt digest.
- A retained adoption receipt cannot be trusted from operation alone. `validateAdoptionPreparedState` must compare its prepared `adopted_checkpoint` to the current call artifact's exact head revision and self-digest before installation.
- The lock repair rename may conservatively leave a quarantined directory when post-rename identity verification fails. It must never delete or replace a newly created `.transaction-lock`.
- `HandoffRecordV1` is server-authored and unmirrored; `handoffRecordV1Validator` is its sole shape parser.

### Key Interfaces

- `src/contracts/durable-checkpoint.ts`: `StateAnchor`; `StateAnchoredManualCheckpointV1`; `StateAnchoredImportV1`; `ChainAnchor`; `chainAnchor(wrapper)`; `selectGreatestValidChain(anchor, candidates)`.
- `src/contracts/durable-handoff.ts`: `HandoffRecordV1`; `parseHandoffRecord(value) -> HandoffRecordV1` through the normative JSON Schema validator.
- `src/state/transitions.ts`: `planStateTransition(input: TransitionPlanInput) -> ProjectResult<NextStateDraft>`.
- `src/state/initialization.ts`: `runStateInitialization(dependencies, request) -> Promise<ProjectResult<TransactionOutcome<"archflow_state">>>`.
- `src/state/checkpoints.ts`: `planCheckpointAdoption(input) -> ProjectResult<PreparedTransaction<"archflow_state">>`; `assertInternalCheckpointAdoptionPlan(value)`.
- `src/state/reconciliation.ts`: `reconcileCurrentAuthority(input: ReconciliationInput) -> ReconciliationResult`; `ActiveAuthorityHeads` carries gate and checkpoint independently.
- `src/state/repair.ts`: `classifySuppliedRepairHistory(entries)`; `planAbandonedLockRepair(authority)`; `repairAbandonedLock(plan, humanConfirmed)`.
- `src/state/lock.ts`: `inspectAbandonedTaskLock(authority)`; `removeConfirmedAbandonedTaskLock(plan, humanConfirmed)`.
- `src/repository/handoff.ts`: `observeDivergentHeads(dependencies, authority, evidence)`; `planCleanHandoff(dependencies, authority, preservation, clean)`; `installHandoffRecord(atomic, target, record)`.
- `src/state/transaction.ts`: artifact-aware `runStateTransaction`; adoption resume calls `validateAdoptionPreparedState` before installing a retained receipt.

### Verification

- `npm run typecheck` passed.
- Combined Phase 10-focused verification passed 397/397 before counter-review; post-counter-review affected verification passed 85/85.
- `npm run test:contracts` passed 446/446, and `npm run build:temp` built and exercised the temporary bundles under Node 24.18.0.
- Full `npm test` passed 1,229/1,232. Only the three inherited `test/integration/release-offline.test.ts` failures remain.
- Dependency policy, notices, notice mutation, and Phase 4 MCP boundary checks passed; Phase 10 adds no dependency.
- The implementation counter-review is fully triaged in `reviews/phase-10-impl-counter-review.md`; all two blockers and four majors were accepted, fixed, and reverified.

### Follow-ups Not Done Here

- Phase 11 owns payload snapshots, implementation manifests, collision-safe projection restore, byte accounting, and maintenance reachability.
- Phase 15 owns MCP handlers, directory enumeration, and local CLI integration for these transport-neutral seams.
- Phase 17 owns reconciliation-aware user-facing status.
- Phase 19 owns legacy source/staged-payload enumeration during upgrade.
- Resolve the inherited release-integrity contradiction before regenerating tracked release authority.

### Durable Convention Proposal

No new project-wide convention is proposed. The validate/materialize-once, persisted-type-alias, enumerable-data-descriptor, and exact human trust-boundary rules already recorded in `CLAUDE.md` cover the reusable lessons; Phase 10's receipt, checkpoint, recovery-capability, and reconciliation rules are subsystem-specific and remain in this log and the parent architecture.
